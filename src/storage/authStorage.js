import { STORAGE_KEYS } from '../constants/storageKeys';
import { getJson, setJson, removeJson } from './jsonStorage';

// The SACHIKO2 server address this deployment talks to -- fixed, not
// operator-configurable, matching FairtechOperatorApp's own convention
// (there is no Login-screen field or storage key for this; every device
// points at the same server).
//
// Chosen by build type rather than hand-edited before each build. `__DEV__` is
// true in a debug build and false in a release one, and Metro folds it away at
// bundle time -- so a shipped APK contains ONLY the production address, and
// the localhost branch is stripped out entirely rather than lying dormant in
// the binary.
//
//   release  -> the production server, reachable over any network
//   debug    -> this machine, through 'adb reverse tcp:3001 tcp:3001'
//
// The practical consequence: a release APK no longer talks to a laptop over
// the cable. To test a release build against a local server, flip this to the
// localhost literal for that build.
const SERVER_URL = __DEV__ ? 'http://localhost:3001' : 'http://43.230.44.198:3001';

export async function getServerUrl() {
  return SERVER_URL;
}

// Session: the bearer token + the profile fields returned alongside it at
// login (see routes/api/operatorApi.js's POST /login in SACHIKO2).
export async function getSession() {
  return getJson(STORAGE_KEYS.AUTH, null);
}

export async function setSession(session) {
  await setJson(STORAGE_KEYS.AUTH, session);
}

export async function clearSession() {
  await removeJson(STORAGE_KEYS.AUTH);
}
