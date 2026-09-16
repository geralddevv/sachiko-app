import AsyncStorage from '@react-native-async-storage/async-storage';
import { STORAGE_KEYS } from '../constants/storageKeys';
import { getJson, setJson, removeJson } from './jsonStorage';

// In-progress job-card entries are real-time meter readings an operator
// can't re-key from memory if the app is backgrounded or the network drops
// mid-entry -- mirrors the web form's localStorage autosave/restore/clear-on-
// save pattern (jobCardForm.ejs), just keyed by pendingId instead of a
// per-tab draft key.
const keyFor = pendingId => `${STORAGE_KEYS.JOB_CARD_DRAFT_PREFIX}${pendingId}`;

export function getDraft(pendingId) {
  return getJson(keyFor(pendingId), null);
}

export function saveDraft(pendingId, draft) {
  return setJson(keyFor(pendingId), draft);
}

export function clearDraft(pendingId) {
  return removeJson(keyFor(pendingId));
}

// Which of these jobs the operator paused ON THIS DEVICE, as a Set of
// pendingIds -- a draft that got as far as Start Production and was never
// ended. `productionStarted` is the right test because Pause is only offered
// once production has started (see JobCardScreen): a draft without it is a
// job merely opened, with reels mounted perhaps, not one left mid-run.
//
// Necessarily device-local, and correctly so. Pause sends nothing to the
// server -- every punch and meter reading lives only in the draft here -- so
// this is the one device that can say "paused", and the only one that could
// resume the job with that work intact.
//
// One batched read rather than a read per job: the queue can hold a screenful
// of them and this re-runs on every focus and every pull-to-refresh.
//
// getMany, NOT the old multiGet: @react-native-async-storage/async-storage v3
// (the version this app is on) dropped multiGet/multiSet/multiRemove for
// getMany/setMany/removeMany, and getMany returns a { key: value } record
// rather than an array of pairs.
export async function getPausedPendingIds(pendingIds) {
  const ids = [...new Set((pendingIds || []).map(String).filter(Boolean))];
  if (!ids.length) {
    return new Set();
  }
  const rawByKey = await AsyncStorage.getMany(ids.map(keyFor));
  const paused = new Set();
  ids.forEach(id => {
    const raw = rawByKey?.[keyFor(id)];
    if (!raw) {
      return;
    }
    let draft = null;
    try {
      draft = JSON.parse(raw);
    } catch (error) {
      // A draft too corrupt to parse is not a paused job -- getDraft treats
      // it as absent too.
      draft = null;
    }
    if (draft?.productionStarted) {
      paused.add(id);
    }
  });
  return paused;
}
