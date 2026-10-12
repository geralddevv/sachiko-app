import { PrinterService } from './PrinterService';
import { getDefaultPrinter } from '../storage/printersStorage';
import { getDecklePrn, getFinishedRollPrn, isOfflineError } from './api';
import {
  getPrintQueue,
  addPrintJob,
  removePrintJob,
  updatePrintJob,
  clearPrintQueue,
} from '../storage/printQueueStorage';

// Drains storage/printQueueStorage. One shared instance, subscribed to by the
// job card (for its "waiting to print" line) and Printer Settings (for the
// list), so both see the same queue without either owning it.
//
// Why a queue at all: a Deckle's label is printed the instant the server
// produces it, and at that moment the printer may be off, asleep, on another
// subnet, or simply not yet configured on a fresh phone. The reel still exists
// and still needs its sticker, so the print is kept and retried rather than
// thrown away with an alert the operator has to acknowledge mid-run.
//
// Draining is deliberately SEQUENTIAL and stops at the first failure: the
// labels come off the printer in the order the Deckles were made, and a
// printer that just refused one job is not going to accept the next five --
// hammering it would only bury the real error under four more.

// A dead flush leaves the labels queued; without this the queue would just sit
// there until the operator happened to open a screen that retries it. Instead
// the service retries itself on a widening interval -- brisk at first (a
// printer waking from power-save is usually back within a minute), then every
// couple of minutes for as long as it takes. A queued label is real stock and
// its sticker is still owed, so the retries never stop, they only slow down.
const RETRY_BACKOFF_MS = [15000, 30000, 60000, 120000];

// Thermal printers in power-save routinely refuse the first TCP connection and
// accept the second a moment later. One quick re-try inside a single flush
// turns that from a visible "printer offline" into nothing the operator sees.
const CONNECT_ATTEMPTS = 2;
const CONNECT_RETRY_DELAY_MS = 2000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Screens render lastError straight into a banner subtitle, so it has to read
// like something an operator can act on -- never a raw socket or fetch string.
function friendlyError(err) {
  if (err?.message === 'No printer configured') {
    return 'No printer configured';
  }
  if (isOfflineError(err)) {
    return 'Waiting for the server to build the label';
  }
  const raw = (err?.message || String(err || '')).toLowerCase();
  if (
    raw.includes('did not acknowledge') ||
    raw.includes('not connected') ||
    raw.includes('epipe') ||
    raw.includes('econnreset')
  ) {
    return 'Printer stopped responding — will retry';
  }
  if (
    raw.includes('timed out') ||
    raw.includes('timeout') ||
    raw.includes('econnrefused') ||
    raw.includes('ehostunreach') ||
    raw.includes('enetunreach') ||
    raw.includes('ehostdown') ||
    raw.includes('network is unreachable')
  ) {
    return 'Printer offline or unreachable — will retry';
  }
  return 'Could not reach the printer — will retry';
}

class PrintQueueService {
  constructor() {
    this.jobs = [];
    this.flushing = false;
    this.lastError = null;
    this.listeners = new Set();
    this.loaded = false;
    // setTimeout handle for the self-retry, and how many times in a row a flush
    // has finished with labels still queued (indexes RETRY_BACKOFF_MS).
    this.retryTimer = null;
    this.retryStreak = 0;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.getState());
    // First subscriber pulls the persisted queue in; later ones get it from
    // memory. Fire-and-forget so subscribe() stays synchronous for useEffect.
    if (!this.loaded) {
      this.loaded = true;
      this.load();
    }
    return () => this.listeners.delete(listener);
  }

  getState() {
    return { jobs: this.jobs, flushing: this.flushing, lastError: this.lastError };
  }

  _notify() {
    const state = this.getState();
    this.listeners.forEach(listener => listener(state));
  }

  _clearRetryTimer() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  // Called at the end of every flush. Nothing queued -> stop retrying and reset
  // the backoff. Something still queued -> schedule the next attempt, each one
  // a little further out than the last.
  _rescheduleRetry() {
    this._clearRetryTimer();
    if (!this.jobs.length) {
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

  async load() {
    this.jobs = await getPrintQueue();
    this._notify();
    // A queue restored from a previous run (app killed mid-shift) should start
    // draining on its own, not wait for the operator to do something.
    if (this.jobs.length) {
      this.flush();
    }
    return this.jobs;
  }

  // Queue a Deckle's label and immediately try to send it. The caller does not
  // await the print -- punching Stop must not block on a printer.
  async enqueue({ stockId, rollId, productCode, kind }) {
    if (!stockId) {
      return this.jobs;
    }
    this.jobs = await addPrintJob({ stockId, rollId, productCode, kind });
    this._notify();
    // A brand-new label deserves a prompt attempt, not whatever long interval
    // the backoff had wound out to for the labels ahead of it.
    this.retryStreak = 0;
    this.flush();
    return this.jobs;
  }

  async remove(id) {
    this.jobs = await removePrintJob(id);
    this._notify();
    if (!this.jobs.length) {
      this._clearRetryTimer();
      this.retryStreak = 0;
    }
    return this.jobs;
  }

  async clear() {
    this.jobs = await clearPrintQueue();
    this._notify();
    this._clearRetryTimer();
    this.retryStreak = 0;
    return this.jobs;
  }

  // flush(), but never a no-op: if a flush is already in flight (the one
  // enqueue() starts, say) this waits for it to finish and returns its result
  // rather than returning immediately with flushing:true. For callers that have
  // to tell the operator what became of a label they just queued -- the Logs
  // reprint button -- where flush()'s "already running" early return would read
  // as a spurious success.
  async flushToCompletion() {
    if (!this.flushing) {
      return this.flush();
    }
    await new Promise(resolve => {
      const unsubscribe = this.subscribe(state => {
        if (!state.flushing) {
          unsubscribe();
          resolve();
        }
      });
    });
    return this.getState();
  }

  async _connectWithRetry(printer) {
    let lastErr = null;
    for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await sleep(CONNECT_RETRY_DELAY_MS);
      }
      try {
        await PrinterService.connectPrinter(printer.ip, printer.port, {
          timeoutMs: printer.timeoutMs,
        });
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('Could not reach the printer.');
  }

  // Try to print everything waiting, oldest first. Safe to call at any time:
  // it no-ops while a flush is already running, and on an empty queue.
  async flush() {
    if (this.flushing) {
      return this.getState();
    }
    // Claimed synchronously, before the first await: enqueue() calls flush()
    // without awaiting it and a caller (flushToCompletion) may check `flushing`
    // on the very next tick. Setting it after `await this.load()` left a window
    // where a second flush slipped past the guard and ran concurrently.
    this.flushing = true;
    this.lastError = null;
    // A retry is happening right now; whatever it doesn't clear will schedule
    // the next one from _rescheduleRetry() below.
    this._clearRetryTimer();
    this._notify();

    let connected = false;
    try {
      if (!this.loaded) {
        this.loaded = true;
        await this.load();
      }
      if (!this.jobs.length) {
        return this.getState();
      }

      const printer = await getDefaultPrinter();
      if (!printer?.ip) {
        // Not a failure of any one label -- there is simply nowhere to send
        // them yet. Left queued, and the count tells the operator to go and
        // set a printer up.
        this.lastError = 'No printer configured';
        return this.getState();
      }

      await this._connectWithRetry(printer);
      connected = true;

      // Oldest first, re-reading the head each pass rather than walking a
      // snapshot: a Stop can queue more labels while this drain is running
      // (its enqueue() returns early because a flush is already going), and a
      // snapshot would leave those for the 15 s retry timer.
      while (this.jobs.length) {
        const job = this.jobs[0];
        try {
          // Rebuilt server-side each attempt rather than cached at enqueue
          // time, so a label queued before an edit still prints current data.
          // `kind` picks the label: a produced Deckle, or a finished slit roll.
          const { tspl } = job.kind === 'finished'
            ? await getFinishedRollPrn(job.stockId)
            : await getDecklePrn(job.stockId);
          await PrinterService.printLabel(tspl);
          this.jobs = await removePrintJob(job.id);
          // A label came out -- the printer is alive, so if the run still
          // breaks on a later one the next retry should be prompt, not the
          // wound-out backoff interval.
          this.retryStreak = 0;
          this._notify();
        } catch (err) {
          this.jobs = await updatePrintJob(job.id, {
            attempts: (job.attempts || 0) + 1,
            lastError: friendlyError(err),
          });
          this.lastError = friendlyError(err);
          this._notify();
          // Stop at the first failure -- see the note at the top.
          break;
        }
      }
    } catch (err) {
      this.lastError = friendlyError(err);
    } finally {
      if (connected) {
        // Awaited so a flush never returns with the socket still shutting
        // down -- the next flush would then be refused by the printer.
        await PrinterService.disconnectPrinter();
      }
      this.flushing = false;
      this._notify();
      // Anything still queued gets another attempt on its own; a clean run
      // stops the timer and resets the backoff.
      this._rescheduleRetry();
    }
    return this.getState();
  }
}

export const printQueue = new PrintQueueService();
