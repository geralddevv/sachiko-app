import { Platform } from 'react-native';
import { STORAGE_KEYS } from '../constants/storageKeys';
import { getJson, setJson, generateId } from './jsonStorage';

// This install's own identity, minted once and kept in AsyncStorage from then
// on. The server uses it to decide which device is RUNNING a job, so one
// operator signed in on two tablets can't punch the same job from both (see
// PendingProduction.runningOn and POST /jobcard/claim in SACHIKO2).
//
// Deliberately NOT a hardware id: nothing here needs to survive a reinstall or
// identify the physical unit, and reading a real device id would mean another
// native dependency plus a privacy question we don't need to answer. A wiped
// app looks like a new device, and the server's stale-claim timeout is what
// makes that safe -- the old claim simply ages out.
let cached = null;

// Something an operator would recognise on the other device's screen. Android
// exposes the model through Platform.constants; anything else falls back to a
// generic label rather than an empty string.
function deviceLabel() {
  const c = Platform.constants || {};
  const parts = [c.Manufacturer || c.Brand, c.Model].filter(Boolean).map(String);
  const label = parts.join(' ').trim();
  return label || (Platform.OS === 'android' ? 'Android device' : 'this device');
}

export async function getDevice() {
  if (cached) {
    return cached;
  }
  let device = await getJson(STORAGE_KEYS.DEVICE, null);
  if (!device?.id) {
    device = { id: generateId('dev'), label: deviceLabel() };
    await setJson(STORAGE_KEYS.DEVICE, device);
  } else if (!device.label) {
    device = { ...device, label: deviceLabel() };
    await setJson(STORAGE_KEYS.DEVICE, device);
  }
  cached = device;
  return device;
}
