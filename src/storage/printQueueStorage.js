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

// Same Deckle twice is a no-op: Stop can be punched, fail to print, and be
// retried, and the operator should still end up with one sticker.
export async function addPrintJob({ stockId, rollId, productCode }) {
  const queue = await getPrintQueue();
  if (queue.some(job => job.stockId === stockId)) {
    return queue;
  }
  const next = [
    ...queue,
    {
      id: generateId('printjob'),
      stockId,
      rollId: rollId || '',
      productCode: productCode || '',
      createdAt: new Date().toISOString(),
      attempts: 0,
      lastError: null,
    },
  ];
  await setPrintQueue(next);
  return next;
}

export async function removePrintJob(id) {
  const next = (await getPrintQueue()).filter(job => job.id !== id);
  await setPrintQueue(next);
  return next;
}

export async function updatePrintJob(id, patch) {
  const next = (await getPrintQueue()).map(job => (job.id === id ? { ...job, ...patch } : job));
  await setPrintQueue(next);
  return next;
}

export async function clearPrintQueue() {
  await setPrintQueue([]);
  return [];
}
