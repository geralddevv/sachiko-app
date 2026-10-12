import { useEffect, useState } from 'react';
import {
  settingStart,
  settingStop,
  logStart,
  logProduce,
  markInUse,
  pauseJob,
  resumeJob,
  postOvertimeRemark,
  ApiError,
  isOfflineError,
} from './api';
import { getOutbox, setOutbox } from '../storage/outboxStorage';
import { generateId } from '../storage/jsonStorage';

// The job card's live punches -- a Job Setting Start / Stop, a deckle's Start
// and Stop, reels marked in use, Pause and Resume -- on their way to the
// server, oldest first.
//
// These used to be fire-and-forget: sent once, and a failure swallowed so the
// punch never waited on the network. That kept the floor moving, but a punch
// made in a Wi-Fi dead spot simply never reached the server -- the office's
// WIP tab went on showing the job idle while a deckle ran, and a deckle
// stopped offline had no stock record and no label until End Job. Now each one
// is written here first (persisted, so an app kill doesn't lose it) and sent
// from here, in order, the moment the server can take it: right away when
// it's up, or when it comes back (App.js flushes on reconnect and on return
// to the foreground) -- and on a widening timer in between.
//
// Order matters and is kept: the server has to hear a deckle's Start before
// its Stop, and a Pause before its Resume. So the queue drains strictly front
// to back and waits at the first punch that can't go yet rather than sending
// the ones behind it.
//
// Every punch carries `at` -- the tablet's clock when it was tapped -- and is
// sent with `sentAt`, the clock at sending. The server takes the difference
// off its own clock (eventTimeOf in SACHIKO2's routes/api/operatorApi.js), so
// a punch that waited ten minutes here is still dated when it happened, and
// the tablet's clock never has to be right. Every endpoint here is safe to
// send twice (a lost response is simply sent again).
const SENDERS = {
  'setting-start': settingStart,
  'setting-stop': settingStop,
  'log-start': logStart,
  'mark-in-use': markInUse,
  pause: pauseJob,
  resume: resumeJob,
  produce: logProduce,
  // The overtime reminder's answer (services/overtimeReminder.js). For a slitting
  // card the "job id" it is filed under is the card id.
  'overtime-remark': postOvertimeRemark,
};

// Brisk at first -- a server that dropped one request is usually back in
// seconds -- then once a minute for as long as it takes. A punch waiting here
// is something that really happened, so it is never given up on for want of
// a connection.
const RETRY_BACKOFF_MS = [3000, 10000, 30000, 60000];

// A server that answers but keeps failing (a 5xx) is a different matter: the
// punch is retried this many times and then dropped, so one bad request can't
// hold every punch behind it forever. Nothing is lost by it -- the job card
// itself still carries the punch, and End Job's save files it (a deckle not
// yet in stock included).
const MAX_SERVER_ATTEMPTS = 6;

// Refused outright -- this punch will never be accepted as sent (the job was
// taken off the machine or reassigned, a reel is in use elsewhere, or the
// server is an older build without this endpoint and answered with a page),
// so retrying is pointless. 408 and 429 are "try again later", not refusals --
// checked first, since a rate limiter's 429 can come back as plain text.
const isRefusal = err => {
  if (!(err instanceof ApiError) || err.status === 408 || err.status === 429 || err.status === 401) {
    return false;
  }
  return (err.status >= 400 && err.status < 500) || !!err.body?.nonJson;
};

class OutboxService {
  constructor() {
    this.ops = [];
    this.flushing = false;
    this.flushPromise = null;
    this.loadPromise = null;
    this.listeners = new Set();
    this.settledListeners = new Set();
    this.retryTimer = null;
    this.retryStreak = 0;
    this.writeChain = Promise.resolve();
  }

  ready() {
    if (!this.loadPromise) {
      this.loadPromise = getOutbox()
        .then(ops => {
          // Anything enqueued while the stored list was loading goes after it.
          this.ops = [...ops, ...this.ops];
        })
        .catch(() => {})
        .then(() => this._notify());
    }
    return this.loadPromise;
  }

  // Load what a previous run left behind and start sending it.
  start() {
    return this.ready().then(() => this.flush());
  }

  // Screens and the offline banner listen for how much is waiting.
  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.getState());
    this.ready();
    return () => this.listeners.delete(listener);
  }

  // Told of every punch the queue is done with: sent ({ ok: true, data }) or
  // given up on ({ ok: false, error }). services/liveSync.js turns a deckle's
  // Stop answer into its label and its row's Deckle ID here.
  onSettled(listener) {
    this.settledListeners.add(listener);
    return () => this.settledListeners.delete(listener);
  }

  getState() {
    return { ops: this.ops, flushing: this.flushing };
  }

  pendingFor(pendingId, kind) {
    const id = String(pendingId);
    return this.ops.filter(op => op.pendingId === id && (!kind || op.kind === kind));
  }

  _notify() {
    const state = this.getState();
    this.listeners.forEach(listener => listener(state));
  }

  // Writes land in the order they were made, each one the whole list as it
  // stood -- so the last write is always the current list.
  _persist() {
    const snapshot = this.ops;
    this.writeChain = this.writeChain.catch(() => {}).then(() => setOutbox(snapshot));
    return this.writeChain;
  }

  _settle(op, result) {
    this.settledListeners.forEach(listener => {
      try {
        listener({ op, ...result });
      } catch (err) {
        // One listener's mistake must not stop the queue.
      }
    });
  }

  async _remove(id) {
    this.ops = this.ops.filter(op => op.id !== id);
    this._notify();
    await this._persist();
  }

  // Queue a punch and try to send it straight away. Resolves once it is safely
  // stored -- never waits on the network.
  async enqueue(kind, pendingId, body) {
    if (!SENDERS[kind]) {
      throw new Error(`Unknown outbox punch: ${kind}`);
    }
    const op = {
      id: generateId('op'),
      kind,
      pendingId: String(pendingId),
      body: body || {},
      at: Date.now(),
      attempts: 0,
    };
    this.ops = [...this.ops, op];
    this._notify();
    await this.ready();
    await this._persist();
    // A fresh punch deserves a prompt attempt, not the wound-out backoff.
    this.retryStreak = 0;
    this.flush();
    return op;
  }

  // Forget this job's waiting punches -- after its card is saved, when they
  // would only put a finished job back on the WIP tab. `keepKinds` survive:
  // a deckle's Stop is kept, since its answer still prints the label.
  async dropForJob(pendingId, { keepKinds = [] } = {}) {
    await this.ready();
    const id = String(pendingId);
    const before = this.ops.length;
    this.ops = this.ops.filter(op => op.pendingId !== id || keepKinds.includes(op.kind));
    if (this.ops.length !== before) {
      this._notify();
      await this._persist();
    }
  }

  // Send this job's waiting punches before something that depends on them
  // (End Job). Resolves true once none are left, false if they couldn't all
  // go within `timeoutMs` -- the caller carries on either way.
  async flushFor(pendingId, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (this.pendingFor(pendingId).length && Date.now() < deadline) {
      const before = this.ops.length;
      await Promise.race([this.flush(), new Promise(resolve => setTimeout(resolve, Math.max(deadline - Date.now(), 0)))]);
      // Nothing went: the server isn't taking them right now.
      if (this.ops.length === before) {
        break;
      }
    }
    return !this.pendingFor(pendingId).length;
  }

  _clearRetryTimer() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  _rescheduleRetry() {
    this._clearRetryTimer();
    if (!this.ops.length) {
      this.retryStreak = 0;
      return;
    }
    const delay = RETRY_BACKOFF_MS[Math.min(this.retryStreak, RETRY_BACKOFF_MS.length - 1)];
    this.retryStreak += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.flush();
    }, delay);
  }

  // Send everything waiting, front to back. Safe to call at any time: a flush
  // already under way is returned rather than started twice.
  flush() {
    if (this.flushing) {
      return this.flushPromise;
    }
    this.flushing = true;
    this._clearRetryTimer();
    this._notify();
    this.flushPromise = (async () => {
      try {
        await this.ready();
        while (this.ops.length) {
          const op = this.ops[0];
          const send = SENDERS[op.kind];
          if (!send) {
            await this._remove(op.id);
            continue;
          }
          try {
            const data = await send({ ...op.body, at: op.at, sentAt: Date.now() });
            await this._remove(op.id);
            this.retryStreak = 0;
            this._settle(op, { ok: true, data });
          } catch (err) {
            if (isOfflineError(err) || (err instanceof ApiError && [0, 401, 429].includes(err.status))) {
              // No server, no session to send with, or told to slow down:
              // everything waits, and none of it counts against the punch.
              break;
            }
            if (isRefusal(err)) {
              await this._remove(op.id);
              this._settle(op, { ok: false, error: err });
              continue;
            }
            const attempts = (op.attempts || 0) + 1;
            if (attempts >= MAX_SERVER_ATTEMPTS) {
              await this._remove(op.id);
              this._settle(op, { ok: false, error: err });
              continue;
            }
            this.ops = this.ops.map(o => (o.id === op.id ? { ...o, attempts } : o));
            await this._persist();
            break;
          }
        }
      } finally {
        this.flushing = false;
        this._notify();
        this._rescheduleRetry();
      }
      return this.getState();
    })();
    return this.flushPromise;
  }
}

export const outbox = new OutboxService();

// How many punches are waiting -- for the whole app, or one job.
export function useOutboxPending(pendingId) {
  const count = state =>
    pendingId == null ? state.ops.length : state.ops.filter(op => op.pendingId === String(pendingId)).length;
  const [pending, setPending] = useState(() => count(outbox.getState()));
  useEffect(() => outbox.subscribe(state => setPending(count(state))), [pendingId]); // eslint-disable-line react-hooks/exhaustive-deps
  return pending;
}
