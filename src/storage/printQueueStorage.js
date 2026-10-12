import { STORAGE_KEYS } from '../constants/storageKeys';
import { getJson, setJson, generateId } from './jsonStorage';

// Labels waiting to reach the printer, persisted so a shift's worth of Deckles
// isn't lost when the app is killed, the phone runs out of battery, or the
// operator walks out of Wi-Fi range mid-run. A Deckle is real stock the moment
// the server produces it -- the reel physically exists and needs its sticker --
// so a print that couldn't happen is a job still outstanding, not an error to
// dismiss. See services/printQueue.js for the draining side.
//
// Deliberately keyed on the Deckle's own stockId: the label is rebuilt from
// the server (GET /deckle/:stockId/prn) at print time rather than the TSPL
// being cached here, so a queued label picked up an hour later still prints
// today's data, and a queue entry stays a few dozen bytes.

export async function getPrintQueue() {
  const queue = await getJson(STORAGE_KEYS.PRINT_QUEUE, []);
  return Array.isArray(queue) ? queue : [];
}

export async function setPrintQueue(queue) {
  await setJson(STORAGE_KEYS.PRINT_QUEUE, queue);
}

// The queue is one stored array, and every change to it reads the array, edits
// it and writes it back. AsyncStorage is asynchronous, so two changes running
// at once both read the same array and whichever writes last wins: the other
// job is silently dropped. A Stop that inwards several finished rolls queues
// one label per roll with no await between them, so that is exactly how only
// the last roll's label came out. Every write therefore waits for the one
// before it to finish, so each reads what the previous one left.
let queueWrites = Promise.resolve();
function serializeQueueWrite(change) {
  const run = queueWrites.then(change);
  queueWrites = run.catch(() => {});
  return run;
}

// Same Deckle twice is a no-op: Stop can be punched, fail to print, and be
// retried, and the operator should still end up with one sticker.
export function addPrintJob({ stockId, rollId, productCode, kind }) {
  return serializeQueueWrite(async () => {
    const queue = await getPrintQueue();
    // `kind` ('deckle' | 'finished') picks which label the drain fetches. Dedupe
    // on stockId + kind: a Deckle and a finished roll are different stock, but
    // keying on both keeps it correct if ids ever overlap across collections.
    const jobKind = kind || 'deckle';
    if (queue.some(job => job.stockId === stockId && (job.kind || 'deckle') === jobKind)) {
      return queue;
    }
    const next = [
      ...queue,
      {
        id: generateId('printjob'),
        stockId,
        rollId: rollId || '',
        productCode: productCode || '',
        kind: jobKind,
        createdAt: new Date().toISOString(),
        attempts: 0,
        lastError: null,
      },
    ];
    await setPrintQueue(next);
    return next;
  });
}

export function removePrintJob(id) {
  return serializeQueueWrite(async () => {
    const next = (await getPrintQueue()).filter(job => job.id !== id);
    await setPrintQueue(next);
    return next;
  });
}

export function updatePrintJob(id, patch) {
  return serializeQueueWrite(async () => {
    const next = (await getPrintQueue()).map(job => (job.id === id ? { ...job, ...patch } : job));
    await setPrintQueue(next);
    return next;
  });
}

export function clearPrintQueue() {
  return serializeQueueWrite(async () => {
    await setPrintQueue([]);
    return [];
  });
}
