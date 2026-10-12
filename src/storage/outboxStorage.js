import { STORAGE_KEYS } from '../constants/storageKeys';
import { getJson, setJson } from './jsonStorage';

// The live punches waiting to reach the server -- see services/outbox.js.
// Persisted for the same reason the print queue is: a Start punched in a
// Wi-Fi dead spot, just before the battery dies or the app is swiped away,
// still happened on the machine, and the office's WIP tab still needs to hear
// about it.

export async function getOutbox() {
  const ops = await getJson(STORAGE_KEYS.OUTBOX, []);
  return Array.isArray(ops) ? ops.filter(op => op && op.id && op.kind) : [];
}

export async function setOutbox(ops) {
  await setJson(STORAGE_KEYS.OUTBOX, ops);
}
