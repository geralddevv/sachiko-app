// Ported from SACHIKO2's utils/rollId.js -- keep normalizeRollId and the Roll
// ID grammar below in lockstep with that file and its client-side copy in
// views/inventory/masters/jobCardForm.ejs. Only the read/normalise half is
// ported: the id *generation* functions there (generateRollId,
// generateDeckleId) are server-side only and this app never needs them.
//
// WHAT A SCAN ACTUALLY CONTAINS
// -----------------------------
// There are two QR payload formats in play, and the Roll ID sits in a
// different place in each:
//
//  1. utils/rollLabel.js -- "rollId vendorRollId paperSize reelMtrs", space
//     separated, Roll ID FIRST. The on-screen preview label.
//
//  2. utils/materialRollLabel.js (buildQrPayloadFromFields) -- the payload on
//     the *printed* sticker a reel gets when its stock is created at inward,
//     and the one this app actually meets on the shop floor. It runs twelve
//     fields together with NO separator at all, in the sample label's own
//     order, and the Roll ID is the LAST of them:
//
//       clientName prodCode mfgDate face joints lotNo
//       adhesive release length weight width rollId
//
//     A facestock reel therefore scans as
//       "AVERY DENNISONAD-710013-8-2026--INV/2026/1123---250KG1000FACESTOCK/26-27/007"
//     and a produced Deckle as
//       "-C00113-8-2026--LOT-0004--1200MTR-1000C001/26-27/G0004/00001"
//
// So "take the first whitespace-separated token" -- which is all the server's
// own extractScannedRollId does, and all this file used to do -- reads
// "AVERY" off that first label. Format 2 has to be read from the END.
//
// Reading it from the end is exact down to one point: the field before the
// Roll ID (`width`, e.g. "1000") is glued straight onto the Roll ID's own
// item code with nothing between them, and every character of both is legal
// in an item code. extractScannedRollId() settles that with evidence rather
// than a guess -- see below -- and where it has none it hands the whole run
// to the server rather than shortening an id into one that could match a
// DIFFERENT reel.

export const normalizeRollId = value => String(value ?? '').trim().replace(/\s+/g, '').toUpperCase();

const FY = '\\d{2}-\\d{2}';
// The two Roll ID shapes SACHIKO2 mints, as their trailing halves so they can
// also be matched at the end of a run-together payload:
//   ".../26-27/007"          raw-material reels + finished rolls
//   ".../26-27/G0004/00001"  Deckle ids
// Together these are its ROLL_ID_RE.
const SEQ_TAIL = `\\/${FY}\\/\\d{3,}`;
const DECKLE_TAIL = `\\/${FY}\\/[A-Z]+\\d{4,}\\/\\d{5,}`;
// An item code may carry hyphens inside it but never leads or ends with one.
const ITEM_CODE = '[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?';

export const ROLL_ID_RE = new RegExp(`^(?:${ITEM_CODE}${SEQ_TAIL}|${ITEM_CODE}${DECKLE_TAIL})$`);

// A Roll ID's tail where format 2 puts it: at the very end of the payload.
const TRAILING_TAIL_RE = new RegExp(`(?:${DECKLE_TAIL}|${SEQ_TAIL})$`);
// Everything item-code-legal immediately before that tail. This deliberately
// over-reaches (it runs back through `width` and, on a Deckle label, through
// most of the payload) -- narrowing it down is the job of the two rules below.
const CODE_RUN_RE = /[A-Z0-9-]+$/;
// The fixed item codes utils/materialRollId.js mints for the raw-material
// pools (each of routes/stock/{facestock,adhesive,releaseLiner,core}Stock.js's
// own ROLL_ID_PREFIX). These are the labels this app scans -- the Materials
// Mounted strip mounts facestock/adhesive/release reels -- so for its own
// traffic the item code is a known constant and nothing has to be inferred.
const POOL_PREFIX_RE = /(FACESTOCK|ADHESIVE|RELEASE|CORE)$/;
// Where a Deckle label's PROD CODE box lands in the compacted payload. It is
// field 2, and field 1 (CLIENT NAME) is hardcoded "-" on that label -- see
// utils/materialStockRollLabel.js's buildLabelFields -- so a corroborating
// product code always starts at index 1. Bounding it there is what stops a
// stray one-character coincidence deeper in the payload from passing as
// evidence.
const PROD_CODE_START = 1;

// Roll IDs the server has already named for this pool (the job card's
// `eligibleRawStock`). A format-2 payload ENDS with the reel's Roll ID, a
// format-1 payload STARTS with it, and a typed one is it -- so a known id
// that fits any of those three is a certainty rather than a parse, and is
// preferred over one. Longest wins, so a Deckle id is never mistaken for the
// shorter reel id its own first segments spell.
const matchKnown = (compact, knownRollIds) => {
  if (!Array.isArray(knownRollIds) || !knownRollIds.length) {
    return '';
  }
  return knownRollIds
    .map(normalizeRollId)
    .filter(id => id && (compact === id || compact.endsWith(id) || compact.startsWith(id)))
    .sort((a, b) => b.length - a.length)[0] || '';
};

// The Roll ID at the end of a format-2 payload.
const extractTrailingRollId = compact => {
  const tail = TRAILING_TAIL_RE.exec(compact);
  if (!tail) {
    return '';
  }
  const before = compact.slice(0, tail.index);
  const run = CODE_RUN_RE.exec(before);
  if (!run) {
    return '';
  }

  // A raw-material reel: the run ends in one of the four minted prefixes, and
  // that prefix IS the item code. Exact.
  const pool = POOL_PREFIX_RE.exec(run[0]);
  if (pool) {
    return pool[1] + tail[0];
  }

  // Anything else -- a Deckle -- is settled by the label naming its own item
  // code twice: the PROD CODE box holds exactly the code the Roll ID is built
  // from. So take the longest suffix of the run that also opens the payload
  // at PROD_CODE_START. "C001" is corroborated there; "1000C001", "000C001",
  // ... -- the same run with more of `width` still stuck to it -- are not.
  // The occurrence must be strictly before the candidate's own position, so
  // the run can never corroborate itself.
  for (let i = 0; i < run[0].length; i++) {
    const candidate = run[0].slice(i);
    const at = compact.indexOf(candidate);
    if (candidate[0] !== '-' && at === PROD_CODE_START && at < run.index + i) {
      return candidate + tail[0];
    }
  }

  // No corroboration. Hand back the whole run rather than a shortened id --
  // the server answers "unknown reel", which is recoverable; silently
  // deducting metres off the wrong reel is not.
  return run[0].replace(/^-+/, '') + tail[0];
};

// Pulls the Roll ID out of whatever a scan (or a typed entry) produced.
//
// `knownRollIds` is optional: pass the pool's eligible reels' ids when the
// caller has them (MaterialsMountedStrip does) and an exact match against
// those is used in preference to any parsing.
export function extractScannedRollId(value, knownRollIds) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return '';
  }

  const first = normalizeRollId(raw.split(/\s+/)[0]);
  const compact = normalizeRollId(raw);

  // Format 1: Roll ID first, then vendorRollId/paperSize/reelMtrs. Taken
  // before whitespace is squeezed out, because collapsing
  // "C011/26-27/048 12345" first would run the trailing vendor roll number
  // into the sequence and read it back as ".../04812345".
  //
  // Only when the entry really is several tokens, though. A format-2 payload
  // has no separators at all, and its own run-together text can itself
  // satisfy the (deliberately permissive) Roll ID grammar -- an item code may
  // hold digits and hyphens, so "UPM-13-8-2026------90KG-FACESTOCK/26-27/113"
  // parses as one -- which would hand back the whole sticker as an id. A
  // single token goes to the structural read below, which returns the same
  // answer for a genuinely bare id and the right one for a payload.
  if (compact !== first && ROLL_ID_RE.test(first)) {
    return first;
  }
  // Format 2's clientName box can hold a space ("AVERY DENNISON"), so the
  // payload is not necessarily one token -- work off the compacted string.
  return matchKnown(compact, knownRollIds)
    || extractTrailingRollId(compact)
    // Nothing roll-ID-shaped at the end. Fall back to the old first-token
    // rule so an id in some format this file doesn't know still reaches the
    // server to be judged there rather than being swallowed here.
    || first;
}
