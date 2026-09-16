import { useEffect, useRef, useState } from 'react';
import { getServerUrl } from '../storage/authStorage';

// Whether the SACHIKO2 server is reachable right now, kept as one shared fact
// the whole app reads instead of every screen rediscovering it from its own
// failed request.
//
// Two jobs:
//  - Remember it. api.js flips this on the outcome of every call, so the first
//    failed request is what puts the app offline -- and once it is, every later
//    call fails instantly (see the isOffline() check in api.js) instead of
//    making the operator wait out a fresh timeout on each button press.
//  - Get back out of it. Nothing else could: while offline the app makes no
//    successful calls, so a probe on a timer is the only thing that can notice
//    the server has come back and clear the banner on its own.

// Unauthed and cheap -- reachability is the only question being asked, so any
// HTTP reply at all (even a 500) counts as "the server is there".
const PROBE_PATH = '/sachiko/api/operator/locations';
const PROBE_INTERVAL = 5000;
const PROBE_TIMEOUT = 4000;

// Optimistic at boot: the first real request decides. Assuming offline instead
// would fail-fast the very first call and show the banner before anything had
// actually gone wrong.
let online = true;
let probing = false;
let probeTimer = null;
const listeners = new Set();

export function isOffline() {
  return !online;
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit() {
  listeners.forEach(listener => listener(online));
}

function setOnline(next) {
  if (online === next) {
    return;
  }
  online = next;
  if (online) {
    stopProbing();
  } else {
    startProbing();
  }
  emit();
}

export function markOnline() {
  setOnline(true);
}

export function markOffline() {
  setOnline(false);
}

// Ask the server directly whether it is there. Returns true when it answered.
export async function probe() {
  const baseUrl = await getServerUrl();
  if (!baseUrl) {
    return false;
  }

  // RN's fetch has no timeout of its own -- without the abort a probe against a
  // silently dropped connection would outlive the interval that scheduled it.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
  try {
    await fetch(`${baseUrl.replace(/\/+$/, '')}${PROBE_PATH}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    markOnline();
    return true;
  } catch (err) {
    markOffline();
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// The banner's Retry: the same probe, but reported so the button can show it is
// working rather than looking like it did nothing.
export async function retryNow() {
  if (probing) {
    return !isOffline();
  }
  probing = true;
  try {
    return await probe();
  } finally {
    probing = false;
  }
}

function startProbing() {
  if (probeTimer) {
    return;
  }
  probeTimer = setInterval(() => {
    if (!probing) {
      probing = true;
      probe().finally(() => {
        probing = false;
      });
    }
  }, PROBE_INTERVAL);
}

function stopProbing() {
  if (probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
}

// Read the same fact from a component. Screens use it to render a settled
// "waiting for the server" state instead of a spinner that would otherwise
// turn forever, since while offline no load will ever complete.
export function useOffline() {
  const [offline, setOffline] = useState(isOffline());
  useEffect(() => subscribe(nowOnline => setOffline(!nowOnline)), []);
  return offline;
}

// Run something the moment the server comes back. Screens use it to reload the
// data their offline attempt could not fetch -- without it a screen that failed
// while offline sits empty after recovery until the operator thinks to pull to
// refresh. Only fires on an actual offline -> online transition, never on mount.
export function useOnReconnect(handler) {
  const saved = useRef(handler);
  saved.current = handler;
  useEffect(
    () =>
      subscribe(nowOnline => {
        if (nowOnline) {
          saved.current();
        }
      }),
    [],
  );
}
