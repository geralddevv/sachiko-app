import React, { useEffect, useState, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, PermissionsAndroid, ActivityIndicator } from 'react-native';
import { Camera, CameraType } from 'react-native-camera-kit';
import { colors, spacing, fontFamily } from '../theme/theme';
import Button from '../theme/Button';

// Capture a still photo of the problem for a maintenance ticket. Uses the same
// react-native-camera-kit camera the roll-scanner uses (ScanScreen), minus the
// barcode reader, plus a shutter button. Hands the captured file back to the
// Report a Problem form as a route param.
export default function MaintenancePhotoScreen({ navigation }) {
  const [permissionGranted, setPermissionGranted] = useState(null);
  const [capturing, setCapturing] = useState(false);
  const cameraRef = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA, {
          title: 'Camera Permission',
          message: 'Sachiko needs camera access to photograph the problem.',
          buttonPositive: 'Allow',
        });
        setPermissionGranted(granted === PermissionsAndroid.RESULTS.GRANTED);
      } catch {
        setPermissionGranted(false);
      }
    })();
  }, []);

  const handleCapture = useCallback(async () => {
    if (capturing || !cameraRef.current) {
      return;
    }
    setCapturing(true);
    try {
      const image = await cameraRef.current.capture();
      if (image?.uri) {
        // popTo for the same reason ScanScreen needs it: navigate() from a
        // modal PUSHES a second copy of the target screen rather than going
        // back to it (React Navigation 7 only reuses the focused route), so
        // this used to stack a fresh ReportProblem holding only the photo --
        // losing the `machines`/`defaultMachineId` it was opened with and
        // leaving the original stranded underneath.
        navigation.popTo(
          'ReportProblem',
          { capturedPhoto: { uri: image.uri, name: image.name || 'photo.jpg', type: 'image/jpeg' } },
          { merge: true },
        );
        return;
      }
      setCapturing(false);
    } catch {
      setCapturing(false);
    }
  }, [capturing, navigation]);

  if (permissionGranted === false) {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>Camera permission was denied. Enable it in system settings to take a photo.</Text>
        <Button title="Go Back" variant="danger" onPress={() => navigation.goBack()} style={styles.backButton} />
      </View>
    );
  }

  if (permissionGranted !== true) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.primary} />
        <Text style={styles.message}>Requesting camera access…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Camera ref={cameraRef} style={StyleSheet.absoluteFill} cameraType={CameraType.Back} />

      <Text style={styles.instructions}>Frame the problem, then tap the shutter</Text>

      <View style={styles.controls}>
        <TouchableOpacity style={styles.cancel} onPress={() => navigation.goBack()}>
          <Text style={styles.cancelText}>Cancel</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.shutter}
          onPress={handleCapture}
          disabled={capturing}
          accessibilityLabel="Take photo">
          {capturing ? <ActivityIndicator color={colors.primary} /> : <View style={styles.shutterInner} />}
        </TouchableOpacity>

        <View style={styles.controlSpacer} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000000' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg, backgroundColor: colors.background },
  message: { color: colors.textDark, textAlign: 'center', marginTop: spacing.md, marginBottom: spacing.md, fontFamily },
  backButton: { minWidth: 160 },
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
  controls: {
    position: 'absolute',
    bottom: spacing.xl,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
  },
  cancel: { width: 72 },
  cancelText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600', fontFamily },
  controlSpacer: { width: 72 },
  shutter: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 4,
    borderColor: 'rgba(255,255,255,0.85)',
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: { width: 54, height: 54, borderRadius: 27, backgroundColor: '#FFFFFF' },
});
