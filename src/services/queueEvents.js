import { AppState } from 'react-native';
import { getServerUrl, getSession } from '../storage/authStorage';

// The work queue's live feed. The server holds one long-lived request open per
// signed-in tablet (GET /events, Server-Sent Events) and writes a line down it
// the moment something changes this operator's queue -- a job allocated, taken
// off, or moved to another machine. The queue screen then reloads itself. There
// is no timer asking "anything new?": nothing is sent until something happens.
//
// React Native has no EventSource, so the stream is read off an XMLHttpRequest's
// growing responseText -- the same trick EventSource polyfills use.
//
// What keeps it honest:
//   - the server sends a comment line every ~25 s; if nothing at all arrives for
//     STALE_MS the connection is treated as dead (a Wi-Fi drop leaves TCP half
//     open and no error ever fires) and is replaced;
//   - a dropped stream is re-opened on a widening delay, and every RE-connect
//     tells listeners to reload, because events sent while it was down are gone;
//   - the feed is closed while the app is in the background and re-opened (with
//     a reload) when it returns;
//   - a 401 ends it for good -- the ordinary requests notice the dead session and
//     sign the operator out, so there is nothing to retry here.

const STALE_MS = 70 * 1000;
const BACKOFF_MS = [1000, 3000, 10000, 30000];
// responseText only ever grows; start a fresh stream before it gets heavy.
const MAX_BYTES = 256 * 1024;
// Several events in a burst (a planner allocating five jobs) become one reload.
const COALESCE_MS = 300;

const listeners = new Set();
let xhr = null;
let started = false;
let appStateSub = null;
let retryTimer = null;
let staleTimer = null;
let coalesceTimer = null;
let streak = 0;
let hasConnected = false;
let gen = 0; // bumped on every (re)open, so a late callback of an old request is ignored

// Pulls the complete events out of what has arrived so far. `rest` is a
// half-received event, kept until the rest of it comes.
export function parseSse(buffer) {
  const events = [];
  const normalized = buffer.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n\n');
  const rest = parts.pop();
  parts.forEach(block => {
    let event = 'message';
    const data = [];
    block.split('\n').forEach(line => {
      if (!line || line.startsWith(':')) {
        return;
      }
      const i = line.indexOf(':');
      const field = i === -1 ? line : line.slice(0, i);
      const value = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'event') {
        event = value;
      } else if (field === 'data') {
        data.push(value);
      }
    });
    events.push({ event, data: data.join('\n') });
  });
  return { events, rest };
}

function notify() {
  clearTimeout(coalesceTimer);
  coalesceTimer = setTimeout(() => {
    coalesceTimer = null;
    listeners.forEach(l => {
      try {
        l();
      } catch (err) {
        // One listener's mistake must not silence the others.
      }
    });
  }, COALESCE_MS);
}

function closeStream() {
  gen += 1;
  clearTimeout(staleTimer);
  staleTimer = null;
  if (xhr) {
    const old = xhr;
    xhr = null;
    old.onreadystatechange = null;
    old.onprogress = null;
    old.onerror = null;
    old.onload = null;
    old.ontimeout = null;
    try {
      old.abort();
    } catch (err) {
      // Already finished.
    }
  }
}

function scheduleRetry() {
  closeStream();
  if (!started || retryTimer) {
    return;
  }
  const delay = BACKOFF_MS[Math.min(streak, BACKOFF_MS.length - 1)];
  streak += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    open();
  }, delay);
}

function armStale(myGen) {
  clearTimeout(staleTimer);
  staleTimer = setTimeout(() => {
    if (myGen === gen) {
      scheduleRetry();
    }
  }, STALE_MS);
}

async function open() {
  if (!started || xhr) {
    return;
  }
  let baseUrl;
  let session;
  try {
    [baseUrl, session] = await Promise.all([getServerUrl(), getSession()]);
  } catch (err) {
    scheduleRetry();
    return;
  }
  // Signed out, or no server set yet: nothing to listen to. It is re-tried when
  // a screen subscribes again (the queue screen does on every focus).
  if (!started || xhr || !baseUrl || !session?.token) {
    return;
  }

  closeStream();
  const myGen = gen;
  const req = new XMLHttpRequest();
  xhr = req;
  let seen = 0;
  let pending = '';
  let opened = false;

  req.open('GET', `${baseUrl.replace(/\/+$/, '')}/sachiko/api/operator/events`);
  req.setRequestHeader('Accept', 'text/event-stream');
  req.setRequestHeader('Cache-Control', 'no-cache');
  req.setRequestHeader('Authorization', `Bearer ${session.token}`);
  req.timeout = 0; // it is meant to stay open

  req.onreadystatechange = () => {
    if (myGen !== gen || req.readyState !== 2 || opened) {
      return;
    }
    if (req.status === 401 || req.status === 403) {
      stop();
      return;
    }
    if (req.status !== 200) {
      scheduleRetry();
      return;
    }
    opened = true;
    streak = 0;
    armStale(myGen);
    // Anything that changed while the stream was down is missed for good.
    if (hasConnected) {
      notify();
    }
    hasConnected = true;
  };
  req.onprogress = () => {
    if (myGen !== gen || !opened) {
      return;
    }
    armStale(myGen);
    const text = req.responseText || '';
    pending += text.slice(seen);
    seen = text.length;
    const { events, rest } = parseSse(pending);
    pending = rest;
    if (events.some(e => e.event === 'queue')) {
      notify();
    }
    if (seen > MAX_BYTES) {
      // A planned renewal, not a failure: no reload, no backoff.
      closeStream();
      open();
    }
  };
  req.onerror = () => myGen === gen && scheduleRetry();
  req.onload = () => myGen === gen && scheduleRetry(); // the server ended the stream
  req.ontimeout = () => myGen === gen && scheduleRetry();
  req.send();
}

function start() {
  if (started) {
    return;
  }
  started = true;
  streak = 0;
  hasConnected = false;
  appStateSub = AppState.addEventListener('change', state => {
    if (state === 'active') {
      if (started && !xhr && !retryTimer) {
        // Back from the background: re-open, and reload for what was missed.
        hasConnected = true;
        streak = 0;
        open();
      }
    } else {
      clearTimeout(retryTimer);
      retryTimer = null;
      closeStream();
    }
  });
  open();
}

function stop() {
  started = false;
  clearTimeout(retryTimer);
  retryTimer = null;
  clearTimeout(coalesceTimer);
  coalesceTimer = null;
  closeStream();
  appStateSub?.remove();
  appStateSub = null;
}

// `listener()` is called whenever the operator's queue changed on the server
// (and after the stream comes back from a break). The feed runs for as long as
// anyone is subscribed. Returns the unsubscribe.
export function subscribeQueueChanges(listener) {
  listeners.add(listener);
  if (!started) {
    start();
  } else if (!xhr && !retryTimer) {
    // Started, but it found no session to listen with -- try again now.
    open();
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      stop();
    }
  };
}
