import { NativeModules } from 'react-native';

// Android-only native module (see android/.../ScanFeedbackModule.kt) --
// undefined on iOS, so every call is optional-chained rather than gated on
// Platform.OS.
const { ScanFeedback } = NativeModules;

export function playScanSuccess() {
  ScanFeedback?.playSuccess?.();
}

export function playScanError() {
  ScanFeedback?.playError?.();
}
