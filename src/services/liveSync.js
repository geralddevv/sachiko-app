import { outbox } from './outbox';
import { printQueue } from './printQueue';
import { patchDraft } from '../storage/draftStorage';

// What becomes of a deckle's Stop once the outbox has sent it. The Stop is
// the one live punch whose answer matters: it carries the Deckle ID the server
// minted, and the Deckle now physically exists, so its label is due.
//
// That answer may come long after the job card that punched it has closed --
// the tablet was offline, the operator paused and went to lunch -- so it can't
// be left to the screen. It is handled here, once, for the whole app:
//   - the label goes to the print queue (services/printQueue.js), which prints
//     it or keeps it until a printer takes it;
//   - the Deckle ID is written into that row of the job's saved draft, so the
//     card shows it and End Job's save files the row as already made;
//   - an open job card for that job is told too (subscribeProduced), so its
//     own copy of the row -- which its autosave writes back -- has it as well.
// A Stop the server refused is marked on the row instead (`produceError`):
// that row's Deckle is then made by End Job's save, as before.

const producedListeners = new Set();

// The job card listens while it is open: ({ pendingId, rowToken, patch }).
export function subscribeProduced(listener) {
  producedListeners.add(listener);
  return () => producedListeners.delete(listener);
}

const refusalMessage = error => {
  const message = error?.body?.message || error?.message || '';
  return message || 'The server could not move this Deckle to stock.';
};

async function onProduceSettled({ op, ok, data, error }) {
  const rowToken = op.body?.rowToken;
  if (!rowToken) {
    return;
  }
  let patch;
  if (ok) {
    if (data?.deckleStockId) {
      printQueue.enqueue({ stockId: data.deckleStockId, rollId: data.deckleId, productCode: data.productCode });
    }
    patch = {
      producing: false,
      produceError: '',
      deckleId: data?.deckleId || '',
      deckleStockId: data?.deckleStockId || '',
      productCode: data?.productCode || '',
    };
  } else {
    patch = { producing: false, produceError: refusalMessage(error) };
  }
  try {
    await patchDraft(op.pendingId, draft => ({
      ...draft,
      productionDone: (draft.productionDone || []).map(r => (r.rowToken === rowToken ? { ...r, ...patch } : r)),
    }));
  } catch (err) {
    // The open screen below still gets it; End Job's save files the row.
  }
  producedListeners.forEach(listener => {
    try {
      listener({ pendingId: op.pendingId, rowToken, patch });
    } catch (err) {
      // A listener's mistake must not stop the others.
    }
  });
}

// Wired once, from App.js: start handling answers, then start the outbox
// sending whatever a previous run left in it.
export function startLiveSync() {
  const unsubscribe = outbox.onSettled(result => {
    if (result.op?.kind === 'produce') {
      onProduceSettled(result);
    }
  });
  outbox.start();
  return unsubscribe;
}
