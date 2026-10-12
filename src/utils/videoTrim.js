import { NativeModules, Platform } from 'react-native';

const { VideoTrim } = NativeModules;

export const MAX_MAINTENANCE_VIDEO_SECONDS = 30;

// Android-only (see android/.../VideoTrimModule.kt) -- no re-encode, just a
// stream copy of the first N ms of each track, so it's fast enough to run
// synchronously after a gallery pick. iOS has no equivalent native module
// yet, so a long clip is left untrimmed there rather than silently failing.
export async function trimVideoIfNeeded(uri, durationSeconds) {
  if (Platform.OS !== 'android' || !VideoTrim) {
    return uri;
  }
  if (typeof durationSeconds !== 'number' || durationSeconds <= MAX_MAINTENANCE_VIDEO_SECONDS) {
    return uri;
  }
  return VideoTrim.trimToMaxDuration(uri, MAX_MAINTENANCE_VIDEO_SECONDS * 1000);
}
