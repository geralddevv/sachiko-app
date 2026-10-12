// The overtime reminder runs on the tablet with no connection (services/
// overtimeReminder.js). Time is faked, the native alarm module, the outbox and
// storage are in-memory, so these exercise the real timer logic end to end.

const MIN = 60 * 1000;

function load(opts = {}) {
  let svc;
  const store = global.__store;
  const native = {
    schedule: jest.fn(() => Promise.resolve(true)),
    cancel: jest.fn(() => Promise.resolve()),
    cancelAll: jest.fn(() => Promise.resolve()),
    ring: jest.fn(() => Promise.resolve()),
    silence: jest.fn(() => Promise.resolve()),
  };
  const outbox = { enqueue: jest.fn(() => Promise.resolve({})) };
  const setSessionHooks = jest.fn();
  const sub = { remove: jest.fn() };
  let appState;
  let permission;
  {
    jest.resetModules();
    jest.doMock('../src/services/api', () => ({ setSessionHooks }));
    jest.doMock('../src/services/outbox', () => ({ outbox }));
    jest.doMock('../src/storage/jsonStorage', () => ({
      getJson: async (k, fb) => (k in store ? JSON.parse(store[k]) : fb),
      setJson: async (k, v) => {
        store[k] = JSON.stringify(v);
      },
      removeJson: async k => {
        delete store[k];
      },
    }));
    const RN = require('react-native');
    RN.Platform.OS = 'android';
    Object.defineProperty(RN.Platform, 'Version', {
      get: () => opts.version || 30,
      configurable: true,
    });
    RN.NativeModules.OverrunAlarm = native;
    permission = jest.fn(() => Promise.resolve('granted'));
    appState = jest.fn(() => sub);
    RN.PermissionsAndroid.request = permission;
    RN.AppState.addEventListener = appState;
    svc = require('../src/services/overtimeReminder');
  }
  return { svc, native, outbox, setSessionHooks, sub, appState, permission };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

const run = {
  kind: 'lamination',
  jobId: 'job1',
  runKey: 'tok1',
  deckleNo: 5,
  label: 'SP | LOT | 0016',
  machineName: 'C1',
  mtrs: 300, // 300 m at 15 m/min = 20 min expected
  speedMpm: 15,
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-09T08:00:00Z'));
  global.__store = {};
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test('fires once, 1 minute after length / machine speed, with no network', async () => {
  const { svc, native, outbox } = load();
  let shown = [];
  svc.subscribeOvertime(a => (shown = a));
  await svc.startDeckle({ ...run, at: Date.now() });
  await flush();

  // Android is given the notification for start + 20 min + 1 min grace.
  expect(native.schedule).toHaveBeenCalledTimes(1);
  expect(native.schedule.mock.calls[0][1]).toBe(Date.now() + 21 * MIN);
  expect(shown).toHaveLength(0);

  jest.setSystemTime(Date.now() + 20 * MIN + 30 * 1000); // 20.5 min: not yet
  await svc.startDeckle({ ...run, runKey: 'other', mtrs: 0, at: Date.now() }); // no-op, forces nothing
  expect(shown).toHaveLength(0);

  jest.advanceTimersByTime(21 * MIN); // wake-up timer fires
  jest.setSystemTime(Date.now() + 1);
  await flush();
  jest.runOnlyPendingTimers();
  await flush();
  expect(shown).toHaveLength(1);
  expect(shown[0]).toMatchObject({ machineName: 'C1', deckleIndex: 5 });
  expect(native.ring).toHaveBeenCalledTimes(1);

  // Answering is final: card closes, the remark is queued for the server.
  await svc.answerOvertime(shown[0], '  reel changed  ');
  await flush();
  expect(shown).toHaveLength(0);
  expect(outbox.enqueue).toHaveBeenCalledWith('overtime-remark', 'job1', {
    kind: 'lamination',
    id: 'job1',
    rowToken: 'tok1',
    deckleIndex: 5,
    remark: 'reel changed',
  });
  jest.advanceTimersByTime(60 * MIN);
  await flush();
  expect(native.ring).toHaveBeenCalledTimes(1); // never again for this run
});

test('"Not now" is recorded as an empty remark and not asked again', async () => {
  const { svc, outbox } = load();
  let shown = [];
  svc.subscribeOvertime(a => (shown = a));
  await svc.startDeckle({ ...run, at: Date.now() });
  jest.setSystemTime(Date.now() + 25 * MIN);
  jest.runOnlyPendingTimers();
  await flush();
  expect(shown).toHaveLength(1);
  await svc.answerOvertime(shown[0], '');
  await flush();
  expect(outbox.enqueue.mock.calls[0][2].remark).toBe('');
  jest.setSystemTime(Date.now() + 60 * MIN);
  jest.runOnlyPendingTimers();
  await flush();
  expect(shown).toHaveLength(0);
});

test('time on hold pushes the due time on; a job on hold never fires', async () => {
  const { svc, native } = load();
  let shown = [];
  svc.subscribeOvertime(a => (shown = a));
  const t0 = Date.now();
  await svc.startDeckle({ ...run, at: t0 });
  jest.setSystemTime(t0 + 10 * MIN);
  await svc.pauseJob('job1', t0 + 10 * MIN);
  jest.setSystemTime(t0 + 60 * MIN); // an hour on hold: nothing fires
  jest.runOnlyPendingTimers();
  await flush();
  expect(shown).toHaveLength(0);
  expect(native.cancel).toHaveBeenCalled();

  await svc.resumeJob('job1', t0 + 60 * MIN); // 50 min held
  await flush();
  const last = native.schedule.mock.calls.at(-1);
  expect(last[1]).toBe(t0 + 21 * MIN + 50 * MIN);
});

test('a Stop before the due time means no reminder', async () => {
  const { svc, native } = load();
  let shown = [];
  svc.subscribeOvertime(a => (shown = a));
  const t0 = Date.now();
  await svc.startDeckle({ ...run, at: t0 });
  jest.setSystemTime(t0 + 15 * MIN);
  await svc.stopRun('lamination', 'job1', 'tok1');
  jest.setSystemTime(t0 + 90 * MIN);
  jest.runOnlyPendingTimers();
  await flush();
  expect(shown).toHaveLength(0);
  expect(native.ring).not.toHaveBeenCalled();
});

test('survives an app restart: a timer that came due while closed is shown on reopen', async () => {
  const first = load();
  const t0 = Date.now();
  await first.svc.startDeckle({ ...run, at: t0 });
  await flush();

  jest.setSystemTime(t0 + 40 * MIN); // app was closed meanwhile
  const second = load(); // fresh module, same stored timers
  let shown = [];
  second.svc.subscribeOvertime(a => (shown = a));
  second.svc.startOvertimeReminder();
  await flush();
  jest.runOnlyPendingTimers();
  await flush();
  expect(shown).toHaveLength(1);
  expect(shown[0].jobLabel).toBe('SP | LOT | 0016');
});

test('no Deckle length or no machine speed -> no timer (same as the WIP page showing no ETA)', async () => {
  const { svc, native } = load();
  await svc.startDeckle({ ...run, mtrs: null, at: Date.now() });
  await svc.startDeckle({ ...run, runKey: 'b', speedMpm: 0, at: Date.now() });
  await flush();
  expect(native.schedule).not.toHaveBeenCalled();
});

test('a slower machine gets a proportionally later reminder', async () => {
  const { svc, native } = load();
  const t0 = Date.now();
  await svc.startDeckle({ ...run, speedMpm: 10, at: t0 }); // 300 m at 10 m/min = 30 min
  await flush();
  expect(native.schedule.mock.calls[0][1]).toBe(t0 + 31 * MIN);
});

test('a timer whose Stop was never seen is dropped 12 h past its due time, silently', async () => {
  const { svc, native } = load();
  let shown = [];
  svc.subscribeOvertime(a => (shown = a));
  const t0 = Date.now();
  await svc.startDeckle({ ...run, at: t0 });
  jest.setSystemTime(t0 + 21 * MIN + 12 * 60 * MIN + 1000);
  jest.runOnlyPendingTimers();
  await flush();
  expect(shown).toHaveLength(0);
  expect(native.ring).not.toHaveBeenCalled();
  expect(global.__store).toEqual({}); // removed from storage too
});

test('a stale timer that was already ringing is taken off the screen', async () => {
  const { svc, native, appState } = load();
  let shown = [];
  svc.subscribeOvertime(a => (shown = a));
  svc.startOvertimeReminder();
  const t0 = Date.now();
  await svc.startDeckle({ ...run, at: t0 });
  jest.setSystemTime(t0 + 30 * MIN);
  jest.runOnlyPendingTimers();
  await flush();
  expect(shown).toHaveLength(1);
  jest.setSystemTime(t0 + 13 * 60 * MIN);
  appState.mock.calls[0][1]('active'); // the app is reopened
  await flush();
  expect(shown).toHaveLength(0);
  expect(native.silence).toHaveBeenCalledWith(run.kind + ':job1:tok1');
});

test('End Job clears every timer of that job, and only that job', async () => {
  const { svc, native } = load();
  let shown = [];
  svc.subscribeOvertime(a => (shown = a));
  const t0 = Date.now();
  await svc.startDeckle({ ...run, at: t0 });
  await svc.startDeckle({ ...run, runKey: 'tok2', at: t0 });
  await svc.startDeckle({ ...run, jobId: 'job2', at: t0 });
  await svc.clearJob('job1');
  await flush();
  expect(native.cancel).toHaveBeenCalledWith('lamination:job1:tok1');
  expect(native.cancel).toHaveBeenCalledWith('lamination:job1:tok2');
  expect(
    Object.keys(JSON.parse(global.__store['@sachikoop/overtime_timers'])),
  ).toEqual(['lamination:job2:tok1']);
  jest.setSystemTime(t0 + 30 * MIN);
  jest.runOnlyPendingTimers();
  await flush();
  expect(shown.map(a => a.id)).toEqual(['job2']);
});

test('clearing a job with a ringing card closes the card', async () => {
  const { svc, native } = load();
  let shown = [];
  svc.subscribeOvertime(a => (shown = a));
  const t0 = Date.now();
  await svc.startDeckle({ ...run, at: t0 });
  jest.setSystemTime(t0 + 30 * MIN);
  jest.runOnlyPendingTimers();
  await flush();
  expect(shown).toHaveLength(1);
  await svc.clearJob('job1');
  expect(shown).toHaveLength(0);
  expect(native.silence).toHaveBeenCalled();
  expect(global.__store).toEqual({});
});

test('a Start takes the job off hold and counts the hold, and a repeat Start does not add a second timer', async () => {
  const { svc, native } = load();
  const t0 = Date.now();
  await svc.startDeckle({ ...run, at: t0 });
  await svc.pauseJob('job1', t0 + 5 * MIN);
  await svc.startDeckle({ ...run, runKey: 'tok2', at: t0 + 15 * MIN }); // 10 min held
  await flush();
  await svc.startDeckle({ ...run, runKey: 'tok2', at: t0 + 16 * MIN }); // duplicate
  await flush();
  const first = native.schedule.mock.calls
    .filter(c => c[0] === 'lamination:job1:tok1')
    .at(-1);
  expect(first[1]).toBe(t0 + 21 * MIN + 10 * MIN);
  expect(
    native.schedule.mock.calls.filter(c => c[0] === 'lamination:job1:tok2'),
  ).toHaveLength(1);
});

test('the notification text names the machine, job and Deckle', async () => {
  const { svc, native } = load();
  const t0 = Date.now();
  await svc.startDeckle({ ...run, deckleId: 'D-9', at: t0 });
  await svc.startDeckle({
    ...run,
    runKey: 'b',
    deckleNo: null,
    deckleId: '',
    machineName: '',
    label: 'J2',
    at: t0,
  });
  await svc.startDeckle({
    ...run,
    runKey: 'c',
    deckleId: '',
    machineName: '',
    label: 'J3',
    at: t0,
  });
  await svc.startDeckle({
    ...run,
    runKey: 'd',
    deckleNo: null,
    machineName: '',
    label: 'J4',
    at: t0,
  });
  await flush();
  const texts = Object.fromEntries(
    native.schedule.mock.calls.map(c => [c[0], [c[2], c[3]]]),
  );
  expect(texts['lamination:job1:tok1'][0]).toBe('Taking longer than expected');
  expect(texts['lamination:job1:tok1'][1]).toContain(
    'C1 · SP | LOT | 0016 · Deckle 5 (D-9) has run past',
  );
  expect(texts['lamination:job1:b'][1]).toContain('J2 · This Deckle has run');
  expect(texts['lamination:job1:c'][1]).toContain('J3 · Deckle 5 has run');
});

test('overMinutes counts whole minutes past the ETA and never goes negative', async () => {
  const { svc } = load();
  const now = Date.now();
  expect(svc.overMinutes({ etaAt: now - 5.9 * MIN })).toBe(5);
  expect(svc.overMinutes({ etaAt: now + 5 * MIN })).toBe(0);
});

test('a slitting answer carries no row token', async () => {
  const { svc, outbox } = load();
  let shown = [];
  svc.subscribeOvertime(a => (shown = a));
  const t0 = Date.now();
  await svc.startDeckle({ ...run, kind: 'slitting', runKey: 3, at: t0 });
  jest.setSystemTime(t0 + 30 * MIN);
  jest.runOnlyPendingTimers();
  await flush();
  await svc.answerOvertime(shown[0], null);
  expect(outbox.enqueue.mock.calls[0][2]).toMatchObject({
    kind: 'slitting',
    rowToken: undefined,
    remark: '',
  });
});

test('answering an alert whose run is already gone only closes the card', async () => {
  const { svc, outbox } = load();
  await svc.answerOvertime({ key: 'lamination:nope:x' }, 'late');
  expect(outbox.enqueue).not.toHaveBeenCalled();
});

test('a long wait is re-checked on the hour', async () => {
  const { svc, native } = load();
  const t0 = Date.now();
  await svc.startDeckle({ ...run, mtrs: 15 * 60 * 5, at: t0 }); // 300 min expected
  await flush();
  const before = native.schedule.mock.calls.length;
  jest.advanceTimersByTime(60 * MIN + 1000);
  await flush();
  expect(jest.getTimerCount()).toBeGreaterThan(0); // re-armed, not lost
  expect(native.schedule.mock.calls.length).toBe(before); // nothing re-sent: still the same due time
});

test('Android 13+ is asked for notification permission once; older versions are not', async () => {
  const modern = load({ version: 33 });
  await modern.svc.startDeckle({ ...run, at: Date.now() });
  await modern.svc.startDeckle({ ...run, runKey: 'b', at: Date.now() });
  await flush();
  expect(modern.permission).toHaveBeenCalledTimes(1);
  expect(modern.permission).toHaveBeenCalledWith(
    'android.permission.POST_NOTIFICATIONS',
  );

  const old = load({ version: 30 });
  await old.svc.startDeckle({ ...run, at: Date.now() });
  await flush();
  expect(old.permission).not.toHaveBeenCalled();
});

test('a refused permission request does not break the timer', async () => {
  const { svc, native, permission } = load({ version: 34 });
  permission.mockRejectedValue(new Error('no'));
  await svc.startDeckle({ ...run, at: Date.now() });
  await flush();
  expect(native.schedule).toHaveBeenCalledTimes(1);
});

test('startOvertimeReminder rebuilds notifications, rechecks when the app comes back, and cleans up', async () => {
  const { svc, native, appState, sub } = load();
  const stop = svc.startOvertimeReminder();
  const again = svc.startOvertimeReminder(); // second call is a no-op
  await flush();
  expect(native.cancelAll).toHaveBeenCalledTimes(1);
  expect(appState).toHaveBeenCalledTimes(1);
  again();
  expect(sub.remove).not.toHaveBeenCalled();

  let shown = [];
  svc.subscribeOvertime(a => (shown = a));
  const t0 = Date.now();
  await svc.startDeckle({ ...run, at: t0 });
  jest.setSystemTime(t0 + 30 * MIN); // came due while backgrounded (timers frozen)
  const onChange = appState.mock.calls[0][1];
  onChange('background');
  await flush();
  expect(shown).toHaveLength(0);
  onChange('active');
  await flush();
  expect(shown).toHaveLength(1);

  stop();
  expect(sub.remove).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

test('signing out wipes the timers, the notifications and any card on screen', async () => {
  const { svc, native, setSessionHooks } = load();
  let shown = [];
  svc.subscribeOvertime(a => (shown = a));
  svc.startOvertimeReminder();
  await flush();
  const t0 = Date.now();
  await svc.startDeckle({ ...run, at: t0 });
  await svc.startDeckle({ ...run, runKey: 'b', at: t0 });
  jest.setSystemTime(t0 + 30 * MIN);
  jest.runOnlyPendingTimers();
  await flush();
  expect(shown).toHaveLength(2);

  native.cancelAll.mockClear();
  setSessionHooks.mock.calls[0][0].onLogout();
  await flush();
  expect(shown).toHaveLength(0);
  expect(native.cancelAll).toHaveBeenCalledTimes(1);
  expect(global.__store).toEqual({});
  expect(jest.getTimerCount()).toBe(0);
});

describe('break timers', () => {
  const brk = { jobId: 'job1', label: 'SP | LOT | 0016', machineName: 'C1' };

  test('Tea Break rings 15 minutes after the pause, Lunch Break 45', async () => {
    const { svc, native } = load();
    const t0 = Date.now();
    await svc.startBreak({ ...brk, reason: 'Tea Break', at: t0 });
    await svc.startBreak({
      ...brk,
      jobId: 'job2',
      reason: 'Lunch Break',
      at: t0,
    });
    await flush();
    const due = Object.fromEntries(
      native.schedule.mock.calls.map(c => [c[0], c[1]]),
    );
    expect(due['break:job1:hold']).toBe(t0 + 15 * MIN); // no grace minute on a break
    expect(due['break:job2:hold']).toBe(t0 + 45 * MIN);
    expect(native.schedule.mock.calls[0][2]).toBe('Break is over');
    expect(native.schedule.mock.calls[0][3]).toContain('Tea Break (15 min)');
  });

  test('other pause reasons start no break timer', async () => {
    const { svc, native } = load();
    await svc.startBreak({ ...brk, reason: 'Machine Issue', at: Date.now() });
    await svc.startBreak({ ...brk, reason: 'Other', at: Date.now() });
    await flush();
    expect(native.schedule).not.toHaveBeenCalled();
  });

  test('it rings while the job is on hold, and acknowledging sends nothing to the server', async () => {
    const { svc, native, outbox } = load();
    let shown = [];
    svc.subscribeOvertime(a => (shown = a));
    const t0 = Date.now();
    await svc.pauseJob('job1', t0);
    await svc.startBreak({ ...brk, reason: 'Tea Break', at: t0 });
    await jest.advanceTimersByTimeAsync(14 * MIN); // still on its break
    expect(shown).toHaveLength(0);
    jest.setSystemTime(t0 + 15 * MIN + 1000);
    jest.runOnlyPendingTimers();
    await flush();
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      kind: 'break',
      reason: 'Tea Break',
      minutes: 15,
    });
    expect(native.ring.mock.calls[0][0]).toBe('break:job1:hold');

    await svc.answerOvertime(shown[0], '');
    await flush();
    expect(shown).toHaveLength(0);
    expect(outbox.enqueue).not.toHaveBeenCalled();
    expect(native.silence).toHaveBeenCalledWith('break:job1:hold');
    jest.setSystemTime(t0 + 120 * MIN);
    jest.runOnlyPendingTimers();
    await flush();
    expect(native.ring).toHaveBeenCalledTimes(1); // once only
  });

  test('resuming before the time is up cancels the alarm', async () => {
    const { svc, native } = load();
    let shown = [];
    svc.subscribeOvertime(a => (shown = a));
    const t0 = Date.now();
    await svc.startBreak({ ...brk, reason: 'Lunch Break', at: t0 });
    await svc.resumeJob('job1', t0 + 20 * MIN);
    jest.setSystemTime(t0 + 90 * MIN);
    jest.runOnlyPendingTimers();
    await flush();
    expect(shown).toHaveLength(0);
    expect(native.ring).not.toHaveBeenCalled();
    expect(native.cancel).toHaveBeenCalledWith('break:job1:hold');
  });

  test('a pause does not freeze the break clock, and a resume while it rings closes the card', async () => {
    const { svc } = load();
    let shown = [];
    svc.subscribeOvertime(a => (shown = a));
    const t0 = Date.now();
    await svc.pauseJob('job1', t0);
    await svc.startBreak({ ...brk, reason: 'Tea Break', at: t0 });
    await svc.pauseJob('job1', t0 + MIN); // a second pause call must not hold the break
    jest.setSystemTime(t0 + 16 * MIN);
    jest.runOnlyPendingTimers();
    await flush();
    expect(shown).toHaveLength(1);
    await svc.resumeJob('job1', t0 + 17 * MIN);
    expect(shown).toHaveLength(0);
  });

  test('it survives an app restart and rings on reopen if the time passed', async () => {
    const first = load();
    const t0 = Date.now();
    await first.svc.startBreak({ ...brk, reason: 'Lunch Break', at: t0 });
    await flush();
    jest.setSystemTime(t0 + 50 * MIN);
    const second = load();
    let shown = [];
    second.svc.subscribeOvertime(a => (shown = a));
    second.svc.startOvertimeReminder();
    await flush();
    jest.runOnlyPendingTimers();
    await flush();
    expect(shown).toHaveLength(1);
    expect(shown[0].kind).toBe('break');
  });

  test('a new pause replaces the previous break clock, and ending the job clears it', async () => {
    const { svc, native } = load();
    const t0 = Date.now();
    await svc.startBreak({ ...brk, reason: 'Tea Break', at: t0 });
    await svc.startBreak({ ...brk, reason: 'Lunch Break', at: t0 + 5 * MIN });
    await flush();
    expect(native.schedule.mock.calls.at(-1)[1]).toBe(t0 + 50 * MIN);
    await svc.clearJob('job1');
    await flush();
    expect(native.cancel).toHaveBeenLastCalledWith('break:job1:hold');
  });
});
