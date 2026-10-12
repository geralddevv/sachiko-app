import { NativeModules, Platform, AppState, PermissionsAndroid } from 'react-native';
import { setSessionHooks } from './api';
import { outbox } from './outbox';
import { getJson, setJson, removeJson } from '../storage/jsonStorage';
import { STORAGE_KEYS } from '../constants/storageKeys';

const { OverrunAlarm } = NativeModules;

// The overtime reminder -- a nudge, on the operator's own tablet, to note why a
// Deckle is taking longer than expected. It runs ENTIRELY on the tablet, with no
// connection and no polling:
//
//   - when the operator punches a Deckle's Start, a timer starts for it: the
//     Deckle's length divided by the machine's speed (Machine Master -> Machine
//     Speed, handed to the app with the job), plus one minute -- the same moment
//     the office's WIP page turns that job's Live cell red;
//   - time the job spends on hold (Pause ... Resume) is added on, as on the WIP
//     page; a Stop ends the timer;
//   - the timers are kept on the device, so they survive the app being closed or
//     the tablet restarting, and Android is handed a timed notification for each,
//     so the reminder shows with the app closed or the screen off;
//   - when one comes due the operator gets ONE small card (components/
//     OverrunAlarmModal.js) asking, optionally, why. Answering -- or "Not now" --
//     is final for that run: it is never asked again.
//
// The answer goes to the server through the outbox, so it is kept and sent when
// the connection is back; it then shows on the WIP pages' Live cell and Delay
// Remarks table. The clock used is the tablet's own.

const GRACE_MS = 60 * 1000;
// A timer whose Stop was never seen (the Deckle was ended elsewhere, say) must not
// fire for ever: this long past its due time it is dropped without a word.
const STALE_MS = 12 * 60 * 60 * 1000;

// Breaks the operator can pause for, and how long each is allowed (minutes). When
// one runs out, a loud "break is over" alarm sounds -- on the tablet, with no
// connection, even with the app closed. Any other pause reason has no timer.
export const BREAK_MINUTES = { 'Tea Break': 15, 'Lunch Break': 45 };

const supported = Platform.OS === 'android' && !!OverrunAlarm;

let timers = {}; // key -> timer
let loaded = null; // Promise, once the stored timers have been read
let ringing = []; // alert views waiting for an answer
const listeners = new Set();
const scheduled = new Map(); // key -> dueAt already handed to Android
let wakeTimer = null;
let started = false;
let askedPermission = false;

const keyOf = (kind, jobId, runKey) => `${kind}:${jobId}:${runKey}`;
const dueAtOf = t => t.startedAt + t.heldMs + t.expectMs + (t.graceMs ?? GRACE_MS);

const emit = () => listeners.forEach(l => l(ringing));
export function subscribeOvertime(listener) {
  listeners.add(listener);
  listener(ringing);
  return () => listeners.delete(listener);
}

const persist = () => (Object.keys(timers).length ? setJson(STORAGE_KEYS.OVERTIME_TIMERS, timers) : removeJson(STORAGE_KEYS.OVERTIME_TIMERS)).catch(() => {});

function ensureLoaded() {
  if (!loaded) {
    loaded = getJson(STORAGE_KEYS.OVERTIME_TIMERS, {})
      .then(stored => {
        // Anything started while this was loading wins over what was stored.
        timers = { ...(stored || {}), ...timers };
      })
      .catch(() => {});
  }
  return loaded;
}

// How the card and the notification describe a timer.
const viewOf = t => ({
  key: t.key,
  kind: t.kind,
  id: t.jobId,
  jobLabel: t.label,
  machineName: t.machineName,
  deckleIndex: t.deckleNo,
  deckleId: t.deckleId,
  dueAt: dueAtOf(t),
  etaAt: t.startedAt + t.heldMs + t.expectMs,
  reason: t.reason || '',
  minutes: t.minutes || 0,
});

export const overMinutes = alert => Math.max(0, Math.floor((Date.now() - alert.etaAt) / 60000));

function describe(alert) {
  if (alert.kind === 'break') {
    const job = [alert.machineName, alert.jobLabel].filter(Boolean).join(' · ');
    return {
      title: 'Break is over',
      text: `Your ${alert.reason || 'break'} (${alert.minutes} min) has ended. Please resume work${job ? ` on ${job}` : ''}.`,
    };
  }
  const where = alert.machineName ? `${alert.machineName} · ` : '';
  const deckle = alert.deckleId
    ? `Deckle ${alert.deckleIndex} (${alert.deckleId})`
    : alert.deckleIndex
    ? `Deckle ${alert.deckleIndex}`
    : 'This Deckle';
  return {
    title: 'Taking longer than expected',
    text: `${where}${alert.jobLabel} · ${deckle} has run past its expected time. Tap to open and add a quick remark — optional.`,
  };
}

async function askNotificationPermission() {
  if (askedPermission || Platform.OS !== 'android' || Platform.Version < 33) {
    return;
  }
  askedPermission = true;
  try {
    await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS');
  } catch (err) {
    // The in-app card still works without it.
  }
}

function cancelNative(key) {
  if (supported) {
    OverrunAlarm.cancel(key).catch(() => {});
  }
  scheduled.delete(key);
}

// A break's notification may already be on the lock screen without the app having
// rung it itself (Android posted it); clear that too, so it stops sounding.
function silenceNative(key) {
  if (supported) {
    OverrunAlarm.silence(key).catch(() => {});
  }
}

// Stop the sound and vibration of an alert that is still on screen -- the operator
// has seen it and wants quiet to read it or type a remark. The alert itself stays
// until it is answered. Native remembers the silence, so the alarm does not start
// up again when the app is reopened.
export function silenceAlert(alert) {
  if (supported) {
    OverrunAlarm.silence(alert.key).catch(() => {});
  }
}

function dropRinging(key) {
  if (ringing.some(r => r.key === key)) {
    ringing = ringing.filter(r => r.key !== key);
    if (supported) {
      OverrunAlarm.silence(key).catch(() => {});
    }
    emit();
  }
}

function ring(t) {
  if (ringing.some(r => r.key === t.key)) {
    return;
  }
  const alert = viewOf(t);
  ringing = [...ringing, alert];
  if (supported) {
    const { title, text } = describe(alert);
    OverrunAlarm.ring(alert.key, title, text, alert.dueAt).catch(() => {});
  }
  emit();
}

// Bring Android's timed notifications and our own wake-up in line with the timers.
// Cheap and idempotent -- called after every change and whenever the app wakes.
async function reconcile() {
  await ensureLoaded();
  const now = Date.now();
  let nextDue = null;
  let changed = false;

  Object.values(timers).forEach(t => {
    const due = dueAtOf(t);
    if (now > due + STALE_MS) {
      delete timers[t.key];
      cancelNative(t.key);
      dropRinging(t.key);
      changed = true;
      return;
    }
    // On hold, or already answered: nothing to wait for.
    if (t.pausedAt != null || t.answered) {
      cancelNative(t.key);
      return;
    }
    if (due <= now) {
      cancelNative(t.key);
      ring(t);
      return;
    }
    if (supported && scheduled.get(t.key) !== due) {
      const { title, text } = describe(viewOf(t));
      OverrunAlarm.schedule(t.key, due, title, text).catch(() => {});
      scheduled.set(t.key, due);
    }
    nextDue = nextDue === null ? due : Math.min(nextDue, due);
  });

  if (changed) {
    persist();
  }
  if (wakeTimer) {
    clearTimeout(wakeTimer);
    wakeTimer = null;
  }
  if (nextDue !== null) {
    // setTimeout can't be trusted for hours; a long wait is re-checked on the hour,
    // and Android's own alarm covers the moment itself.
    wakeTimer = setTimeout(reconcile, Math.min(Math.max(nextDue - now, 0) + 500, 60 * 60 * 1000));
  }
}

// ── What the job cards call ──────────────────────────────────────────────

// A Deckle's Start was punched. `mtrs` is its length, `speedMpm` the machine's
// speed; with either missing there is no expected time, so no reminder (the same
// way the WIP page shows no ETA). `runKey` names the run: the Start punch's row
// token on a lamination card, the row number on a slitting card.
export async function startDeckle({ kind, jobId, runKey, deckleNo, deckleId, label, machineName, mtrs, speedMpm, at }) {
  await ensureLoaded();
  const key = keyOf(kind, jobId, runKey);
  // A Start means the machine is running again: the job comes off hold first.
  await resumeJob(jobId, at);
  if (!(Number(mtrs) > 0) || !(Number(speedMpm) > 0) || timers[key]) {
    return;
  }
  timers[key] = {
    key,
    kind,
    jobId: String(jobId),
    runKey: String(runKey),
    deckleNo: deckleNo || null,
    deckleId: deckleId || '',
    label: label || '',
    machineName: machineName || '',
    startedAt: at || Date.now(),
    expectMs: Math.round((Number(mtrs) / Number(speedMpm)) * 60000),
    heldMs: 0,
    pausedAt: null,
    answered: false,
  };
  askNotificationPermission();
  persist();
  reconcile();
}

// The job was paused for a Tea / Lunch Break: start that break's clock. Unlike a
// Deckle's timer it keeps running while the job is on hold -- that is the point --
// and it ends with the hold (resumeJob) or the job (clearJob). Any other reason
// starts nothing (and drops a break clock left from an earlier pause).
export async function startBreak({ jobId, reason, label, machineName, at }) {
  await ensureLoaded();
  const key = keyOf('break', jobId, 'hold');
  if (timers[key]) {
    delete timers[key];
    cancelNative(key);
    silenceNative(key);
    dropRinging(key);
  }
  const minutes = BREAK_MINUTES[reason];
  if (minutes) {
    timers[key] = {
      key,
      kind: 'break',
      jobId: String(jobId),
      runKey: 'hold',
      deckleNo: null,
      deckleId: '',
      label: label || '',
      machineName: machineName || '',
      reason,
      minutes,
      startedAt: at || Date.now(),
      expectMs: minutes * 60000,
      graceMs: 0,
      heldMs: 0,
      pausedAt: null,
      answered: false,
    };
    askNotificationPermission();
  }
  persist();
  reconcile();
}

// The Deckle was stopped: nothing left to be late.
export async function stopRun(kind, jobId, runKey) {
  await ensureLoaded();
  const key = keyOf(kind, jobId, runKey);
  if (timers[key]) {
    delete timers[key];
    persist();
  }
  cancelNative(key);
  dropRinging(key);
  reconcile();
}

// Pause / Resume: time on hold is not time the machine ran slow, so the due time
// moves on by as much (what the WIP page does with the same hold).
export async function pauseJob(jobId, at = Date.now()) {
  await ensureLoaded();
  let changed = false;
  Object.values(timers).forEach(t => {
    if (t.kind !== 'break' && t.jobId === String(jobId) && t.pausedAt == null) {
      t.pausedAt = at;
      cancelNative(t.key);
      changed = true;
    }
  });
  if (changed) {
    persist();
  }
  reconcile();
}

export async function resumeJob(jobId, at = Date.now()) {
  await ensureLoaded();
  let changed = false;
  Object.values(timers).forEach(t => {
    // Resuming ends the break, however much of it was left.
    if (t.kind === 'break' && t.jobId === String(jobId)) {
      delete timers[t.key];
      cancelNative(t.key);
      silenceNative(t.key);
      dropRinging(t.key);
      changed = true;
    } else if (t.jobId === String(jobId) && t.pausedAt != null) {
      t.heldMs += Math.max(0, at - t.pausedAt);
      t.pausedAt = null;
      changed = true;
    }
  });
  if (changed) {
    persist();
    reconcile();
  }
}

// The job is over (End Job) -- every timer it had goes with it.
export async function clearJob(jobId) {
  await ensureLoaded();
  let changed = false;
  Object.values(timers).forEach(t => {
    if (t.jobId === String(jobId)) {
      delete timers[t.key];
      cancelNative(t.key);
      dropRinging(t.key);
      changed = true;
    }
  });
  if (changed) {
    persist();
  }
  reconcile();
}

// ── The card's answer ────────────────────────────────────────────────────

// The operator answered: `remark` is what they typed, or '' for "Not now". Either
// way it is final for this run. The card closes at once; the answer is queued for
// the server and sent whenever it can be.
export async function answerOvertime(alert, remark = '') {
  await ensureLoaded();
  const t = timers[alert.key];
  if (t && t.kind === 'break') {
    // "Break is over" is just acknowledged: nothing is sent anywhere, and the
    // job stays on hold until the operator resumes it.
    delete timers[alert.key];
    persist();
    dropRinging(alert.key);
    cancelNative(alert.key);
    silenceNative(alert.key);
    return;
  }
  if (t) {
    t.answered = true;
    persist();
  }
  dropRinging(alert.key);
  cancelNative(alert.key);
  if (t) {
    outbox
      .enqueue('overtime-remark', t.jobId, {
        kind: t.kind,
        id: t.jobId,
        rowToken: t.kind === 'lamination' ? t.runKey : undefined,
        deckleIndex: t.deckleNo,
        remark: String(remark || '').trim(),
      })
      .catch(() => {});
  }
}

function clearAll() {
  timers = {};
  persist();
  if (supported) {
    OverrunAlarm.cancelAll().catch(() => {});
  }
  scheduled.clear();
  [...ringing].forEach(r => dropRinging(r.key));
  if (wakeTimer) {
    clearTimeout(wakeTimer);
    wakeTimer = null;
  }
}

// Wired once from App.js. Returns the cleanup.
export function startOvertimeReminder() {
  if (started) {
    return () => {};
  }
  started = true;
  (async () => {
    await ensureLoaded();
    // Notifications scheduled by an earlier run are rebuilt from the stored timers.
    if (supported) {
      await OverrunAlarm.cancelAll().catch(() => {});
    }
    scheduled.clear();
    reconcile();
  })();
  // Coming back to the app: a timer may have come due while it was away.
  const sub = AppState.addEventListener('change', state => {
    if (state === 'active') {
      reconcile();
    }
  });
  // Signing out ends this operator's reminders.
  setSessionHooks({ onLogout: clearAll });
  return () => {
    started = false;
    sub.remove();
    if (wakeTimer) {
      clearTimeout(wakeTimer);
    }
  };
}
