import AsyncStorage from '@react-native-async-storage/async-storage';
import { STORAGE_KEYS } from '../constants/storageKeys';
import { getJson, setJson, removeJson } from './jsonStorage';

// In-progress job-card entries are real-time meter readings an operator
// can't re-key from memory if the app is backgrounded or the network drops
// mid-entry -- mirrors the web form's localStorage autosave/restore/clear-on-
// save pattern (jobCardForm.ejs), just keyed by pendingId instead of a
// per-tab draft key.
const keyFor = pendingId => `${STORAGE_KEYS.JOB_CARD_DRAFT_PREFIX}${pendingId}`;

// Every read and write of one job's draft runs one at a time, in the order it
// was asked for. The job card's autosave is no longer the only writer: a
// Deckle the outbox produces in the background is written into the draft too
// (patchDraft, from services/liveSync.js), and a read-modify-write racing the
// autosave could otherwise put back an older copy of the card over the
// readings the operator just typed.
const chains = new Map();
function serialized(pendingId, task) {
  const key = String(pendingId);
  const run = (chains.get(key) || Promise.resolve()).catch(() => {}).then(task);
  chains.set(key, run);
  run
    .catch(() => {})
    .then(() => {
      if (chains.get(key) === run) {
        chains.delete(key);
      }
    });
  return run;
}

export function getDraft(pendingId) {
  return serialized(pendingId, () => getJson(keyFor(pendingId), null));
}

export function saveDraft(pendingId, draft) {
  return serialized(pendingId, () => setJson(keyFor(pendingId), draft));
}

export function clearDraft(pendingId) {
  return serialized(pendingId, () => removeJson(keyFor(pendingId)));
}

// Change a saved draft in place: `update(draft)` returns the new draft. A job
// with no draft (already ended, or never opened here) is left without one --
// a late answer for a finished job must not bring its card back.
export function patchDraft(pendingId, update) {
  return serialized(pendingId, async () => {
    const draft = await getJson(keyFor(pendingId), null);
    if (!draft) {
      return null;
    }
    const next = update(draft);
    if (next) {
      await setJson(keyFor(pendingId), next);
    }
    return next;
  });
}

// What this device knows about each of these jobs from its own drafts, as a
// plain object of pendingId -> { paused, started } (an object rather than a
// Map: the queue reads it with a bare lookup, which can't throw whatever the
// state holds):
//   paused  -- { at, reason } when the operator put the job on hold here with
//              Pause and hasn't resumed it (see JobCardScreen's handlePause);
//   started -- the job has been punched here at all (a Job Setting Start,
//              Start Production, a deckle), paused or not.
// A job with no draft is absent. The queue reads it to say Paused / Resume or
// Continue; the server's own hold (job.paused on /queue) is read beside it,
// since the Pause may still be waiting in this tablet's outbox.
//
// One batched read rather than a read per job: the queue can hold a screenful
// of them and this re-runs on every focus and every pull-to-refresh.
//
// getMany, NOT the old multiGet: @react-native-async-storage/async-storage v3
// (the version this app is on) dropped multiGet/multiSet/multiRemove for
// getMany/setMany/removeMany, and getMany returns a { key: value } record
// rather than an array of pairs.
export async function getDraftStates(pendingIds) {
  const ids = [...new Set((pendingIds || []).map(String).filter(Boolean))];
  const states = {};
  if (!ids.length) {
    return states;
  }
  const rawByKey = await AsyncStorage.getMany(ids.map(keyFor));
  ids.forEach(id => {
    const raw = rawByKey?.[keyFor(id)];
    if (!raw) {
      return;
    }
    let draft = null;
    try {
      draft = JSON.parse(raw);
    } catch (error) {
      // A draft too corrupt to parse is no draft -- getDraft treats it as
      // absent too.
      draft = null;
    }
    if (!draft) {
      return;
    }
    const started = draftStartedHere(draft);
    const paused = draft.paused?.at ? draft.paused : null;
    if (started || paused) {
      states[id] = { started, paused };
    }
  });
  return states;
}

// Whether a draft shows the job already under way on this device -- a Start
// punched on any row, or production begun.
export const draftStartedHere = draft =>
  !!draft.productionStarted ||
  (draft.jobSetting || []).some(r => r?.startTime) ||
  (draft.productionDone || []).length > 0 ||
  !!draft.productionLive?.startTime;
