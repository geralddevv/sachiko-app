import { NativeModules, DeviceEventEmitter, PermissionsAndroid, Platform } from 'react-native';

const { VoiceRecorder } = NativeModules;

// A maintenance voice message is capped at 30 seconds. The native recorder
// enforces it itself (MediaRecorder.setMaxDuration), the server trims to it
// again, and the UI counts down to it.
export const MAX_VOICE_SECONDS = 30;
export const MIN_VOICE_MS = 1000;

export const voiceRecordingSupported = Platform.OS === 'android' && !!VoiceRecorder;

export async function ensureMicPermission() {
  if (Platform.OS !== 'android') {
    return true;
  }
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO, {
    title: 'Microphone Permission',
    message: 'Sachiko needs the microphone to record a voice message about the problem.',
    buttonPositive: 'Allow',
  });
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

export function startVoiceRecording() {
  return VoiceRecorder.start(MAX_VOICE_SECONDS * 1000);
}

// Resolves { uri, name, type, durationMs, size }.
export function stopVoiceRecording() {
  return VoiceRecorder.stop();
}

export function cancelVoiceRecording() {
  return VoiceRecorder ? VoiceRecorder.cancel().catch(() => {}) : Promise.resolve();
}

// Fires when the recorder hit the 30s cap and stopped itself.
export function onVoiceAutoStopped(handler) {
  const sub = DeviceEventEmitter.addListener('VoiceRecorderAutoStopped', handler);
  return () => sub.remove();
}

export function formatClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
