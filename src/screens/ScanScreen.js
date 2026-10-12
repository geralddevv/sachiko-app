import React, { useEffect, useState, useRef } from 'react';
import { View, Text, StyleSheet, PermissionsAndroid } from 'react-native';
import { Camera } from 'react-native-camera-kit';
import { colors, spacing, fontFamily } from '../theme/theme';
import Button from '../theme/Button';

// Square, not the library's wide-barcode default -- every code this app
// scans is a QR (see rollId.js), so the crop region should read as one.
const FRAME_SIZE = 260;

// Accent blue for the viewfinder corners -- bright enough to read on the black
// camera view (the brand navy disappears against it). Drawn here, not by the
// camera: its native frame ignores any opaque frameColor under the new
// architecture and falls back to green, so the native frame is kept (it is also
// what limits decoding to the square) but made transparent, and these corners
// sit exactly where it would have drawn them.
const FRAME_COLOR = '#2F9BFF';
const CORNER_LENGTH = 30;
const CORNER_THICKNESS = 3;

// Mirrors the web form's camera-scan modal (jobCardForm.ejs): a viewfinder
// frame, decode the QR, hand the payload back.
//
// The decoded string is returned RAW and unparsed. A stock label's QR carries
// the whole sticker -- vendor, dates, invoice, size and the Roll ID last, run
// together with no separators (see utils/rollId.js) -- and pulling the Roll ID
// out of that needs the pool's own eligible reels to check against, which this
// screen has no idea about. MaterialsMountedStrip, which opened the scanner
// and does know its pool, runs extractScannedRollId() on the way in.
export default function ScanScreen({ route, navigation }) {
  // Which screen opened the scanner. Both job cards use it -- the lamination
  // one (Materials Mounted) and the slitting one (Scan Deckle) -- and popTo
  // below has to name the right one, so the caller says which rather than
  // this screen assuming.
  const returnTo = route?.params?.returnTo || 'JobCard';
  const [permissionGranted, setPermissionGranted] = useState(null);
  // Measured rather than derived from flex so the four mask pieces are
  // pixel-exact regardless of this screen's actual on-device size (modal
  // presentation, notches, etc.) -- see the spotlight overlay below.
  const [maskLayout, setMaskLayout] = useState(null);
  const handledRef = useRef(false);

  useEffect(() => {
    (async () => {
      try {
        const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA, {
          title: 'Camera Permission',
          message: 'Sachiko needs camera access to scan roll ID labels.',
          buttonPositive: 'Allow',
        });
        setPermissionGranted(granted === PermissionsAndroid.RESULTS.GRANTED);
      } catch (err) {
        setPermissionGranted(false);
      }
    })();
  }, []);

  const handleReadCode = event => {
    if (handledRef.current) {
      return;
    }
    const raw = String(event?.nativeEvent?.codeStringValue ?? '').trim();
    if (!raw) {
      return;
    }
    handledRef.current = true;
    // popTo, NOT navigate. In React Navigation 7 a NAVIGATE only reuses an
    // existing route when it is the CURRENTLY FOCUSED one (or when `pop` is
    // passed) -- see StackRouter's `if (action.payload.name ===
    // currentRoute.name) { route = currentRoute } else if (action.payload.pop)
    // {...}`; with neither, it PUSHES a new route. From this screen the
    // focused route is Scan, so `navigate('JobCard', { scannedCode })` stacked
    // a SECOND JobCard carrying only that one param. The new instance had no
    // `pendingId` (JobCardScreen reads it straight off route.params), so it
    // loaded GET /jobcard/undefined and died with the server's "Invalid
    // pendingId" instead of mounting the reel. `merge` alone does not help:
    // the router only merges when it actually found a route to reuse.
    //
    // popTo pops back to the job card already under this modal (`returnTo`)
    // and merges the scan into the params it was opened with.
    navigation.popTo(returnTo, { scannedCode: raw }, { merge: true });
  };

  if (permissionGranted === false) {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>Camera permission was denied. Enable it in system settings to scan.</Text>
        <Button title="Go Back" variant="danger" onPress={() => navigation.goBack()} style={styles.backButton} />
      </View>
    );
  }

  if (permissionGranted !== true) {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>Requesting camera access…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Camera
        style={StyleSheet.absoluteFill}
        scanBarcode
        onReadCode={handleReadCode}
        showFrame
        // No scanning laser -- the moving red line reads as an error cue and
        // the web modal doesn't have one. 'transparent' hides it while keeping
        // the frame.
        laserColor="transparent"
        frameColor="transparent"
        barcodeFrameSize={{ width: FRAME_SIZE, height: FRAME_SIZE }}
      />

      {/* Dims everything outside the scan square (matches the web modal's
          spotlight overlay) as four independently-positioned pieces sized
          off this View's own measured layout, so the hole lines up with the
          camera's themed frame exactly regardless of screen size. */}
      <View
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
        onLayout={e => setMaskLayout(e.nativeEvent.layout)}>
        {maskLayout ? (
          <>
            <View
              style={[
                styles.dim,
                { top: 0, left: 0, right: 0, height: (maskLayout.height - FRAME_SIZE) / 2 },
              ]}
            />
            <View
              style={[
                styles.dim,
                { bottom: 0, left: 0, right: 0, height: (maskLayout.height - FRAME_SIZE) / 2 },
              ]}
            />
            <View
              style={[
                styles.dim,
                {
                  top: (maskLayout.height - FRAME_SIZE) / 2,
                  left: 0,
                  width: (maskLayout.width - FRAME_SIZE) / 2,
                  height: FRAME_SIZE,
                },
              ]}
            />
            <View
              style={[
                styles.dim,
                {
                  top: (maskLayout.height - FRAME_SIZE) / 2,
                  right: 0,
                  width: (maskLayout.width - FRAME_SIZE) / 2,
                  height: FRAME_SIZE,
                },
              ]}
            />
            {[
              { top: 0, left: 0, borderTopWidth: CORNER_THICKNESS, borderLeftWidth: CORNER_THICKNESS },
              { top: 0, right: 0, borderTopWidth: CORNER_THICKNESS, borderRightWidth: CORNER_THICKNESS },
              { bottom: 0, left: 0, borderBottomWidth: CORNER_THICKNESS, borderLeftWidth: CORNER_THICKNESS },
              { bottom: 0, right: 0, borderBottomWidth: CORNER_THICKNESS, borderRightWidth: CORNER_THICKNESS },
            ].map((corner, i) => (
              <View
                key={i}
                style={[
                  styles.corner,
                  {
                    top: (maskLayout.height - FRAME_SIZE) / 2,
                    left: (maskLayout.width - FRAME_SIZE) / 2,
                    width: FRAME_SIZE,
                    height: FRAME_SIZE,
                  },
                ]}>
                <View style={[styles.cornerMark, corner]} />
              </View>
            ))}
          </>
        ) : null}
      </View>

      <Text style={styles.instructions}>Align the roll's QR code within the square</Text>

      <Button title="Cancel" variant="danger" onPress={() => navigation.goBack()} style={styles.cancelButton} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000000' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  message: { color: colors.textDark, textAlign: 'center', marginBottom: spacing.md, fontFamily },
  backButton: { minWidth: 160 },
  dim: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.6)' },
  // One full-size box per corner so each mark can hug its own corner of the square.
  corner: { position: 'absolute' },
  cornerMark: {
    position: 'absolute',
    width: CORNER_LENGTH,
    height: CORNER_LENGTH,
    borderColor: FRAME_COLOR,
  },
  instructions: {
    position: 'absolute',
    top: spacing.xl,
    alignSelf: 'center',
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    paddingHorizontal: spacing.xl,
    fontFamily,
  },
  cancelButton: {
    position: 'absolute',
    bottom: spacing.xl,
    alignSelf: 'center',
    minWidth: 160,
  },
});
