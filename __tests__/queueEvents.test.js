// The queue's live feed (services/queueEvents.js): an XHR held open to the
// server, a reload on every "queue" event, and a careful reconnect.

class FakeXHR {
  constructor() {
    this.headers = {};
    this.readyState = 0;
    this.status = 0;
    this.responseText = '';
    FakeXHR.all.push(this);
  }
  open(method, url) {
    this.url = url;
  }
  setRequestHeader(k, v) {
    this.headers[k] = v;
  }
  send() {
    this.sent = true;
  }
  abort() {
    this.aborted = true;
  }
  // test helpers
  respond(status = 200) {
    this.readyState = 2;
    this.status = status;
    this.onreadystatechange && this.onreadystatechange();
  }
  push(text) {
    this.responseText += text;
    this.onprogress && this.onprogress();
  }
}
FakeXHR.all = [];

const flush = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

function load({ session = { token: 'tok' }, server = 'http://srv/' } = {}) {
  jest.resetModules();
  FakeXHR.all = [];
  global.XMLHttpRequest = FakeXHR;
  jest.doMock('../src/storage/authStorage', () => ({
    getServerUrl: async () => server,
    getSession: async () => session,
  }));
  const RN = require('react-native');
  const sub = { remove: jest.fn() };
  const appState = jest.fn(() => sub);
  RN.AppState.addEventListener = appState;
  const svc = require('../src/services/queueEvents');
  return { svc, appState, sub };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('parseSse returns whole events and keeps a half-received one', () => {
  const { svc } = load();
  const a = svc.parseSse(': connected\n\nevent: queue\ndata: {}\n\nevent: que');
  expect(a.events).toEqual([
    { event: 'message', data: '' },
    { event: 'queue', data: '{}' },
  ]);
  expect(a.rest).toBe('event: que');
  expect(svc.parseSse('event: queue\r\ndata: x\r\n\r\n').events).toEqual([
    { event: 'queue', data: 'x' },
  ]);
});

test('opens an authenticated stream and reloads on a queue event, once per burst', async () => {
  const { svc } = load();
  const listener = jest.fn();
  svc.subscribeQueueChanges(listener);
  await flush();
  const x = FakeXHR.all[0];
  expect(x.url).toBe('http://srv/sachiko/api/operator/events');
  expect(x.headers.Authorization).toBe('Bearer tok');
  expect(x.headers.Accept).toBe('text/event-stream');
  x.respond(200);
  x.push(': connected\n\n');
  await jest.advanceTimersByTimeAsync(1000);
  expect(listener).not.toHaveBeenCalled(); // first connect: the screen loaded already

  x.push('event: queue\ndata: {}\n\nevent: queue\ndata: {}\n\n');
  x.push('event: queue\ndata: {}\n\n');
  await jest.advanceTimersByTimeAsync(300);
  expect(listener).toHaveBeenCalledTimes(1);
});

test('an event split across two chunks is still read', async () => {
  const { svc } = load();
  const listener = jest.fn();
  svc.subscribeQueueChanges(listener);
  await flush();
  const x = FakeXHR.all[0];
  x.respond(200);
  x.push('event: qu');
  x.push('eue\ndata: {}\n\n');
  await jest.advanceTimersByTimeAsync(300);
  expect(listener).toHaveBeenCalledTimes(1);
});

test('a dropped stream reconnects on a widening delay and reloads once it is back', async () => {
  const { svc } = load();
  const listener = jest.fn();
  svc.subscribeQueueChanges(listener);
  await flush();
  FakeXHR.all[0].respond(200);
  FakeXHR.all[0].onerror();
  expect(FakeXHR.all).toHaveLength(1);
  await jest.advanceTimersByTimeAsync(1000);
  expect(FakeXHR.all).toHaveLength(2);
  FakeXHR.all[1].respond(500); // server up but unwell
  await jest.advanceTimersByTimeAsync(2999);
  expect(FakeXHR.all).toHaveLength(2);
  await jest.advanceTimersByTimeAsync(1);
  expect(FakeXHR.all).toHaveLength(3);
  FakeXHR.all[2].respond(200);
  await jest.advanceTimersByTimeAsync(300);
  expect(listener).toHaveBeenCalledTimes(1); // events sent while it was down are gone
});

test('a silent connection is replaced after 70 s', async () => {
  const { svc } = load();
  svc.subscribeQueueChanges(jest.fn());
  await flush();
  FakeXHR.all[0].respond(200);
  await jest.advanceTimersByTimeAsync(69 * 1000);
  FakeXHR.all[0].push(': ping\n\n'); // a heartbeat resets the clock
  await jest.advanceTimersByTimeAsync(69 * 1000);
  expect(FakeXHR.all).toHaveLength(1);
  await jest.advanceTimersByTimeAsync(2 * 1000 + 1000);
  expect(FakeXHR.all[0].aborted).toBe(true);
  expect(FakeXHR.all).toHaveLength(2);
});

test('a 401 ends the feed for good', async () => {
  const { svc } = load();
  svc.subscribeQueueChanges(jest.fn());
  await flush();
  FakeXHR.all[0].respond(401);
  await jest.advanceTimersByTimeAsync(60 * 1000);
  expect(FakeXHR.all).toHaveLength(1);
});

test('no session or no server: nothing is opened', async () => {
  const { svc } = load({ session: null });
  svc.subscribeQueueChanges(jest.fn());
  await flush();
  expect(FakeXHR.all).toHaveLength(0);
});

test('the stream closes with the last subscriber and is shared before that', async () => {
  const { svc, sub } = load();
  const off1 = svc.subscribeQueueChanges(jest.fn());
  const off2 = svc.subscribeQueueChanges(jest.fn());
  await flush();
  expect(FakeXHR.all).toHaveLength(1);
  off1();
  expect(FakeXHR.all[0].aborted).toBeFalsy();
  off2();
  expect(FakeXHR.all[0].aborted).toBe(true);
  expect(sub.remove).toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(60 * 1000);
  expect(FakeXHR.all).toHaveLength(1); // no reconnect after unsubscribing
});

test('going to the background closes it; coming back re-opens it and reloads', async () => {
  const { svc, appState } = load();
  const listener = jest.fn();
  svc.subscribeQueueChanges(listener);
  await flush();
  FakeXHR.all[0].respond(200);
  const onChange = appState.mock.calls[0][1];
  onChange('background');
  expect(FakeXHR.all[0].aborted).toBe(true);
  onChange('active');
  await flush();
  expect(FakeXHR.all).toHaveLength(2);
  FakeXHR.all[1].respond(200);
  await jest.advanceTimersByTimeAsync(300);
  expect(listener).toHaveBeenCalledTimes(1);
});

test('a listener that throws does not silence the others', async () => {
  const { svc } = load();
  const good = jest.fn();
  svc.subscribeQueueChanges(() => {
    throw new Error('x');
  });
  svc.subscribeQueueChanges(good);
  await flush();
  FakeXHR.all[0].respond(200);
  FakeXHR.all[0].push('event: queue\ndata: {}\n\n');
  await jest.advanceTimersByTimeAsync(300);
  expect(good).toHaveBeenCalledTimes(1);
});
