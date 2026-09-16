import { Platform, PermissionsAndroid } from 'react-native';
import Geolocation from '@react-native-community/geolocation';

// Where the operator physically was when they signed in, for SACHIKO2's audit
// log (models/system/auditLog.js's `geo`). Note this is the DEVICE's position,
// nothing to do with the Login screen's own "Location" field -- that one is the
// unit the operator picks from the dropdown, which the server already knows.
//
// Everything here is best-effort by design. A shopfloor tablet may have
// location switched off, sit deep inside a shed with no fix, or belong to an
// operator who declines the prompt, and none of that may stop them starting
// work: getLoginLocation() always resolves, never rejects, and a failure comes
// back as { error } which the server records verbatim in place of coordinates.

// Short on purpose. This runs between the operator hitting Sign In and the
// login request going out, so it is time they spend watching a spinner --
// better a logged "timeout" than a tablet that looks hung for a minute.
const LOCATION_TIMEOUT = 8000;

// A fix this old is still worth logging and costs nothing: the operator walked
// to the machine with the tablet, so the last fix is the same room.
const MAX_AGE = 60000;

Geolocation.setRNConfiguration({
  // The module's own prompt is skipped so both platforms ask through
  // ensurePermission() below, at the one moment we actually want to ask.
  skipPermissionRequests: true,
  authorizationLevel: 'whenInUse',
  // Defaults to true inside setRNConfiguration, which on iOS needs the
  // background-location entitlement this app has no reason to carry -- it only
  // ever reads a position while the operator is looking at the Sign In button.
  enableBackgroundLocationUpdates: false,
});

function requestIosAuthorization() {
  return new Promise(resolve => {
    Geolocation.requestAuthorization(
      () => resolve(true),
      () => resolve(false),
    );
  });
}

async function ensurePermission() {
  if (Platform.OS !== 'android') {
    // skipPermissionRequests above means getCurrentPosition will NOT raise the
    // system prompt by itself, so iOS has to ask here -- against the plist's
    // NSLocationWhenInUseUsageDescription. Already-answered permissions come
    // straight back without a second dialog.
    return requestIosAuthorization();
  }
  // COARSE alone is plenty -- the audit answers "which site were they at",
  // not "where on the floor", and asking for FINE only is refused outright on
  // Android 12+ anyway (both must be requested together).
  const granted = await PermissionsAndroid.requestMultiple([
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
  ]);
  return (
    granted[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] === PermissionsAndroid.RESULTS.GRANTED ||
    granted[PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION] === PermissionsAndroid.RESULTS.GRANTED
  );
}

function currentPosition() {
  return new Promise(resolve => {
    Geolocation.getCurrentPosition(
      position => {
        const { latitude, longitude, accuracy } = position.coords || {};
        if (typeof latitude !== 'number' || typeof longitude !== 'number') {
          resolve({ error: 'unavailable' });
          return;
        }
        resolve({
          latitude,
          longitude,
          // Metres of uncertainty, so an audit reader can tell a real GPS fix
          // from a 2 km wifi guess rather than trusting both equally.
          accuracy: typeof accuracy === 'number' ? accuracy : null,
        });
      },
      err => {
        // Codes are the W3C ones the module re-uses: 1 PERMISSION_DENIED,
        // 2 POSITION_UNAVAILABLE, 3 TIMEOUT.
        const byCode = { 1: 'denied', 2: 'unavailable', 3: 'timeout' };
        resolve({ error: byCode[err?.code] || 'unavailable' });
      },
      { enableHighAccuracy: false, timeout: LOCATION_TIMEOUT, maximumAge: MAX_AGE },
    );
  });
}

// TEMPORARILY DISABLED. The whole sign-in geolocation feature is switched off
// for now -- no permission prompt, no fix taken, nothing sent to the server.
// Flip this back to false to restore it; the rest of the module is untouched.
const LOCATION_DISABLED = true;

// Always resolves: { latitude, longitude, accuracy } or { error }.
export async function getLoginLocation() {
  if (LOCATION_DISABLED) {
    return { error: 'disabled' };
  }
  try {
    const allowed = await ensurePermission();
    if (!allowed) {
      return { error: 'denied' };
    }
    return await currentPosition();
  } catch (err) {
    return { error: 'unavailable' };
  }
}
