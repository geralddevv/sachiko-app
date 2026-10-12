// The outbox holds the job card's live punches until the server has them
// (services/outbox.js). The API and storage are in memory here, so these run the
// real queue: ordering, retry, refusal, persistence and the settle callbacks.

class ApiError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}
const offline = () =>
  Object.assign(new Error('Network request failed'), { offline: true });

const loaded = [];

function load(stored = []) {
  jest.resetModules();
  const store = { outbox: JSON.stringify(stored) };
  const senders = {};
  [
    'settingStart',
    'settingStop',
    'logStart',
    'logProduce',
    'markInUse',
    'pauseJob',
    'resumeJob',
    'postOvertimeRemark',
  ].forEach(n => (senders[n] = jest.fn(() => Promise.resolve({ ok: true }))));
  let n = 0;
  jest.doMock('../src/services/api', () => ({
    ...senders,
    ApiError,
    isOfflineError: e => !!e && e.offline === true,
  }));
  jest.doMock('../src/storage/jsonStorage', () => ({
    getJson: async (k, fb) => (k in store ? JSON.parse(store[k]) : fb),
    setJson: async (k, v) => {
      store[k] = JSON.stringify(v);
    },
    removeJson: async k => {
      delete store[k];
    },
    generateId: p => `${p}_${++n}`,
  }));
  jest.doMock('../src/constants/storageKeys', () => ({
    STORAGE_KEYS: { OUTBOX: 'outbox' },
  }));
  const { outbox } = require('../src/services/outbox');
  loaded.push(outbox);
  const saved = () => JSON.parse(store.outbox);
  return { outbox, senders, saved };
}

afterEach(() => {
  jest.useRealTimers();
  jest.dontMock('../src/storage/outboxStorage');
  loaded.splice(0).forEach(o => o._clearRetryTimer());
});

test('a punch is stored, sent with its own time and the sending time, then removed', async () => {
  const { outbox, senders, saved } = load();
  const op = await outbox.enqueue('log-start', 7, { deckle: 2 });
  await outbox.flush();
  expect(op).toMatchObject({ kind: 'log-start', pendingId: '7', attempts: 0 });
  expect(senders.logStart).toHaveBeenCalledTimes(1);
  expect(senders.logStart.mock.calls[0][0]).toMatchObject({
    deckle: 2,
    at: op.at,
  });
  expect(senders.logStart.mock.calls[0][0].sentAt).toBeGreaterThanOrEqual(
    op.at,
  );
  expect(outbox.getState().ops).toEqual([]);
  expect(saved()).toEqual([]);
});

test('an unknown punch kind is rejected and nothing is queued', async () => {
  const { outbox } = load();
  await expect(outbox.enqueue('nope', 1, {})).rejects.toThrow(
    'Unknown outbox punch: nope',
  );
  expect(outbox.getState().ops).toEqual([]);
});

test('punches go strictly in order; one that cannot go holds back the ones behind it', async () => {
  const { outbox, senders } = load();
  senders.logStart.mockRejectedValue(offline());
  await outbox.enqueue('log-start', 1, {});
  await outbox.enqueue('produce', 1, {});
  await outbox.flush();
  expect(senders.logProduce).not.toHaveBeenCalled();
  expect(outbox.getState().ops.map(o => o.kind)).toEqual([
    'log-start',
    'produce',
  ]);
  expect(outbox.getState().ops[0].attempts).toBe(0); // being offline is not the punch's fault

  senders.logStart.mockResolvedValue({});
  await outbox.flush();
  expect(senders.logProduce).toHaveBeenCalledTimes(1);
  const lastStart = senders.logStart.mock.invocationCallOrder.at(-1);
  expect(lastStart).toBeLessThan(
    senders.logProduce.mock.invocationCallOrder[0],
  );
  expect(outbox.getState().ops).toEqual([]);
});

test('401 and 429 wait without counting against the punch', async () => {
  const { outbox, senders } = load();
  senders.pauseJob
    .mockRejectedValueOnce(new ApiError(401, {}))
    .mockRejectedValueOnce(new ApiError(429, 'slow down'));
  await outbox.enqueue('pause', 1, {});
  await outbox.flush();
  await outbox.flush();
  expect(outbox.getState().ops).toHaveLength(1);
  expect(outbox.getState().ops[0].attempts).toBe(0);
  await outbox.flush();
  expect(outbox.getState().ops).toEqual([]);
});

test('a refusal (4xx, or a non-JSON page) is dropped, reported, and the queue carries on', async () => {
  const { outbox, senders } = load();
  const settled = [];
  outbox.onSettled(s => settled.push(s));
  senders.settingStart.mockRejectedValueOnce(new ApiError(409, {}));
  senders.settingStop.mockRejectedValueOnce(
    new ApiError(200, { nonJson: true }),
  );
  await outbox.enqueue('setting-start', 1, {});
  await outbox.enqueue('setting-stop', 1, {});
  await outbox.enqueue('resume', 1, {});
  await outbox.flush();
  expect(outbox.getState().ops).toEqual([]);
  expect(senders.resumeJob).toHaveBeenCalledTimes(1);
  expect(settled.map(s => [s.op.kind, s.ok])).toEqual([
    ['setting-start', false],
    ['setting-stop', false],
    ['resume', true],
  ]);
  expect(settled[0].error.status).toBe(409);
});

test('408 is "try again", not a refusal', async () => {
  const { outbox, senders } = load();
  senders.markInUse.mockRejectedValueOnce(new ApiError(408, {}));
  await outbox.enqueue('mark-in-use', 1, {});
  await outbox.flush();
  expect(outbox.getState().ops).toHaveLength(1);
  expect(outbox.getState().ops[0].attempts).toBe(1);
});

test('a server that keeps failing (5xx) is retried six times, then the punch is dropped', async () => {
  const { outbox, senders, saved } = load();
  const settled = [];
  outbox.onSettled(s => settled.push(s));
  senders.logProduce.mockRejectedValue(new ApiError(500, {}));
  await outbox.enqueue('produce', 1, {});
  await outbox.enqueue('resume', 1, {});
  await outbox.flushPromise;
  for (let i = 0; i < 10 && outbox.pendingFor(1, 'produce').length; i++) {
    await outbox.flush();
    const tries = senders.logProduce.mock.calls.length;
    if (tries < 6) {
      expect(outbox.getState().ops[0].attempts).toBe(tries);
      expect(saved()[0].attempts).toBe(tries); // the count survives a restart
      expect(senders.resumeJob).not.toHaveBeenCalled(); // still blocking the one behind
    }
  }
  expect(senders.logProduce).toHaveBeenCalledTimes(6);
  expect(settled[0]).toMatchObject({ ok: false });
  expect(senders.resumeJob).toHaveBeenCalledTimes(1); // unblocked
  expect(outbox.getState().ops).toEqual([]);
});

test('what a previous run left behind is loaded, sent first, and bad rows are ignored', async () => {
  const left = [
    { id: 'old1', kind: 'pause', pendingId: '5', body: {}, at: 1, attempts: 0 },
    {
      id: 'old2',
      kind: 'resume',
      pendingId: '5',
      body: {},
      at: 2,
      attempts: 0,
    },
    { kind: 'pause' },
    null,
  ];
  const { outbox, senders } = load(left);
  await outbox.enqueue('produce', 5, {});
  await outbox.start();
  expect(senders.pauseJob.mock.invocationCallOrder[0]).toBeLessThan(
    senders.resumeJob.mock.invocationCallOrder[0],
  );
  expect(senders.resumeJob.mock.invocationCallOrder[0]).toBeLessThan(
    senders.logProduce.mock.invocationCallOrder[0],
  );
  expect(senders.pauseJob.mock.calls[0][0].at).toBe(1); // dated when it happened, not when sent
  expect(outbox.getState().ops).toEqual([]);
});

test('a stored punch of a kind this build no longer knows is discarded, not stuck', async () => {
  const { outbox, senders } = load([
    { id: 'x', kind: 'retired', pendingId: '1', body: {}, at: 1 },
    { id: 'y', kind: 'pause', pendingId: '1', body: {}, at: 2 },
  ]);
  await outbox.start();
  expect(senders.pauseJob).toHaveBeenCalledTimes(1);
  expect(outbox.getState().ops).toEqual([]);
});

test('a corrupt stored value loads as an empty queue', async () => {
  const { outbox } = load();
  await outbox.start();
  expect(outbox.getState().ops).toEqual([]);
  const bad = load();
  jest.resetModules();
  jest.doMock('../src/storage/outboxStorage', () => ({
    getOutbox: () => Promise.reject(new Error('disk')),
    setOutbox: async () => {},
  }));
  jest.doMock('../src/services/api', () => ({
    ApiError,
    isOfflineError: () => false,
  }));
  jest.doMock('../src/storage/jsonStorage', () => ({ generateId: () => 'i' }));
  const { outbox: o2 } = require('../src/services/outbox');
  await expect(o2.start()).resolves.toBeDefined();
  expect(bad.outbox.getState().ops).toEqual([]);
});

test('a second flush while one is running shares it instead of sending twice', async () => {
  const { outbox, senders } = load();
  let release;
  senders.settingStart.mockImplementationOnce(
    () => new Promise(r => (release = () => r({}))),
  );
  await outbox.enqueue('setting-start', 1, {});
  await Promise.resolve();
  const a = outbox.flush();
  const b = outbox.flush();
  expect(a).toBe(b);
  expect(outbox.getState().flushing).toBe(true);
  await new Promise(r => setTimeout(r, 0));
  release();
  await a;
  expect(senders.settingStart).toHaveBeenCalledTimes(1);
  expect(outbox.getState().flushing).toBe(false);
});

test('a listener that throws does not stop the queue', async () => {
  const { outbox, senders } = load();
  outbox.onSettled(() => {
    throw new Error('boom');
  });
  await outbox.enqueue('pause', 1, {});
  await outbox.enqueue('resume', 1, {});
  await outbox.flush();
  expect(senders.resumeJob).toHaveBeenCalledTimes(1);
});

test('subscribers hear the count change and can unsubscribe', async () => {
  const { outbox, senders } = load();
  senders.pauseJob.mockRejectedValue(offline());
  const seen = [];
  const off = outbox.subscribe(s => seen.push(s.ops.length));
  await outbox.enqueue('pause', 1, {});
  await outbox.flush();
  expect(seen[0]).toBe(0);
  expect(seen).toContain(1);
  off();
  const n = seen.length;
  await outbox.enqueue('resume', 1, {});
  expect(seen).toHaveLength(n);
});

test("pendingFor finds a job's punches, optionally by kind", async () => {
  const { outbox, senders } = load();
  senders.pauseJob.mockRejectedValue(offline());
  await outbox.enqueue('pause', 1, {});
  await outbox.enqueue('resume', 1, {});
  await outbox.enqueue('pause', 2, {});
  expect(outbox.pendingFor(1)).toHaveLength(2);
  expect(outbox.pendingFor('1', 'resume')).toHaveLength(1);
  expect(outbox.pendingFor(3)).toHaveLength(0);
});

test("dropForJob forgets a finished job's punches except the kinds to keep", async () => {
  const { outbox, senders, saved } = load();
  senders.pauseJob.mockRejectedValue(offline());
  senders.logStart.mockRejectedValue(offline());
  await outbox.enqueue('pause', 1, {});
  await outbox.enqueue('log-start', 1, {});
  await outbox.enqueue('pause', 2, {});
  await outbox.flushPromise;
  await outbox.writeChain;
  await outbox.dropForJob(1, { keepKinds: ['log-start'] });
  expect(outbox.getState().ops.map(o => [o.pendingId, o.kind])).toEqual([
    ['1', 'log-start'],
    ['2', 'pause'],
  ]);
  expect(saved()).toHaveLength(2);
  await outbox.dropForJob(99); // nothing to drop: no error
  expect(outbox.getState().ops).toHaveLength(2);
});

test("flushFor resolves true once the job's punches are all sent", async () => {
  const { outbox, senders } = load();
  await outbox.enqueue('pause', 1, {});
  await outbox.enqueue('resume', 1, {});
  await expect(outbox.flushFor(1)).resolves.toBe(true);
  expect(senders.resumeJob).toHaveBeenCalled();
  await expect(outbox.flushFor(404)).resolves.toBe(true); // nothing waiting
});

test('flushFor gives up with false when the server is not taking them', async () => {
  const { outbox, senders } = load();
  senders.pauseJob.mockRejectedValue(offline());
  await outbox.enqueue('pause', 1, {});
  await expect(outbox.flushFor(1, 50)).resolves.toBe(false);
  expect(outbox.pendingFor(1)).toHaveLength(1); // still safe in the queue
});

test('flushFor stops waiting at its deadline when a send hangs', async () => {
  const { outbox, senders } = load();
  senders.pauseJob.mockImplementation(() => new Promise(() => {}));
  await outbox.enqueue('pause', 1, {});
  const started = Date.now();
  await expect(outbox.flushFor(1, 50)).resolves.toBe(false);
  expect(Date.now() - started).toBeLessThan(1000);
});

test('while offline it retries on a widening timer, and a new punch starts the backoff over', async () => {
  const { outbox, senders } = load();
  jest.useFakeTimers();
  senders.pauseJob.mockRejectedValue(offline());
  await outbox.enqueue('pause', 1, {});
  await jest.advanceTimersByTimeAsync(0);
  const calls = () => senders.pauseJob.mock.calls.length;
  expect(calls()).toBe(1);

  for (const [wait, expected] of [
    [3000, 2],
    [10000, 3],
    [30000, 4],
    [60000, 5],
    [60000, 6], // stays at a minute
  ]) {
    await jest.advanceTimersByTimeAsync(wait - 1);
    expect(calls()).toBe(expected - 1);
    await jest.advanceTimersByTimeAsync(1);
    expect(calls()).toBe(expected);
  }

  await outbox.enqueue('resume', 1, {}); // fresh punch: prompt attempt, backoff reset
  await jest.advanceTimersByTimeAsync(0);
  expect(calls()).toBe(7);
  await jest.advanceTimersByTimeAsync(3000);
  expect(calls()).toBe(8);
});

test('when the queue empties the retry timer is cancelled', async () => {
  const { outbox, senders } = load();
  jest.useFakeTimers();
  senders.pauseJob.mockRejectedValueOnce(offline());
  await outbox.enqueue('pause', 1, {});
  await jest.advanceTimersByTimeAsync(3000);
  expect(senders.pauseJob).toHaveBeenCalledTimes(2);
  expect(outbox.getState().ops).toEqual([]);
  expect(jest.getTimerCount()).toBe(0);
});

test('writes to storage land in order, so the last one is the current list', async () => {
  const { outbox, senders, saved } = load();
  senders.pauseJob.mockRejectedValue(offline());
  await Promise.all([
    outbox.enqueue('pause', 1, {}),
    outbox.enqueue('pause', 2, {}),
    outbox.enqueue('pause', 3, {}),
  ]);
  await outbox.flushPromise;
  await outbox.writeChain;
  expect(saved().map(o => o.pendingId)).toEqual(['1', '2', '3']);
});
