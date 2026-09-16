// Shared meter-reading arithmetic for the Job Card screen and its roll rows
// -- kept in one place so the two never drift on how a Start/Stop pair turns
// into running metres, ported from jobCardForm.ejs's client-side recalc.

// A reversed or incomplete Start/Stop pair counts as zero consumption rather
// than an error -- matches the web form's own recalc (and the server's).
export const consumedMeters = row => {
  const from = Number(row.mtrs1);
  const to = Number(row.mtrs2);
  return Number.isFinite(from) && Number.isFinite(to) && to > from ? to - from : 0;
};

// en-IN digit grouping (3 then 2s, e.g. 12,34,567) without relying on
// Intl/toLocaleString support in the Hermes build -- avoids a silent
// formatting failure on-device. Matches jobCardForm.ejs's fmtMtrs.
export const fmtMtrs = value => {
  const num = Number(value) || 0;
  const fixed = Math.abs(num).toFixed(2);
  const [whole, frac] = fixed.split('.');
  const last3 = whole.length > 3 ? whole.slice(-3) : whole;
  const rest = whole.length > 3 ? whole.slice(0, -3) : '';
  const groupedRest = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const grouped = groupedRest ? `${groupedRest},${last3}` : last3;
  const sign = num < 0 ? '-' : '';
  return frac === '00' ? `${sign}${grouped}` : `${sign}${grouped}.${frac}`;
};

// ── Entry validation ────────────────────────────────────────────────────────
// Every figure on the job card is keyed free-hand off the machine's own
// counter, so a slip is a digit, not a word: 100 typed for 1000, the stop
// reading keyed into the start box, a joint marked past the end of the run.
// These catch the ones that are physically impossible, and each returns the
// message to show, or null when the entry is fine.
//
// Deliberately run at the COMMIT points -- a punch, a dialog's Save -- and
// never on keystroke. A half-typed "1" is below a start reading of 1,000 right
// up until the operator finishes typing "1,200", so checking per character
// would reject almost every correct entry mid-word.
//
// The rule throughout is: block only what CANNOT be true. A reading that is
// merely surprising gets checkStartContinuity's warning instead, which lets
// the punch through -- an operator who cannot record what actually happened
// will write it down wrong somewhere else.

// '' / null / undefined -> null (nothing entered), unparseable -> NaN, so a
// caller can tell "blank" apart from "not a number".
const toNum = value => {
  const text = String(value ?? '').trim();
  if (!text) {
    return null;
  }
  const num = Number(text);
  return Number.isFinite(num) ? num : NaN;
};

const round2 = n => Math.round(n * 100) / 100;

// The checks every typed figure shares: it has to be there (unless optional),
// it has to parse, and none of these quantities is ever negative -- a counter
// doesn't run backwards and a reel can't hold less than nothing. `label` names
// the field in the message, so it reads as the operator's own words for it.
const validateNumeric = (label, value, { required = true } = {}) => {
  const num = toNum(value);
  if (num === null) {
    return required ? `Enter the ${label.toLowerCase()}.` : null;
  }
  if (Number.isNaN(num)) {
    return `${label} must be a number.`;
  }
  if (num < 0) {
    return `${label} can't be negative.`;
  }
  return null;
};

// Punching Start freezes this reading into the row, so it has to be a real one.
export function validateStartMtrs(startMtrs) {
  return validateNumeric('Start reading', startMtrs);
}

// The counter only runs forwards, so a stop reading below the start one is a
// mis-key. Equal passes here -- it means nothing ran, which is
// validateDeckleMeters' business, with the message that actually fits.
export function validateStopMtrs(startMtrs, stopMtrs) {
  const bad = validateNumeric('Stop reading', stopMtrs);
  if (bad) {
    return bad;
  }
  const start = toNum(startMtrs);
  // No usable start reading to compare against -- not this check's business.
  if (start === null || Number.isNaN(start)) {
    return null;
  }
  const stop = toNum(stopMtrs);
  if (stop < start) {
    return `Stop reading (${fmtMtrs(stop)} m) can't be less than the start reading (${fmtMtrs(start)} m).`;
  }
  return null;
}

// What this Deckle actually made. Less than the counter span is normal -- waste
// gets trimmed off the ends -- but more than ran between the two punches is
// impossible, and that is the slip that would inward a Deckle longer than the
// web it came from.
export function validateDeckleMeters(startMtrs, stopMtrs, meters) {
  const bad = validateNumeric('Deckle metres', meters);
  if (bad) {
    return bad;
  }
  const made = toNum(meters);
  // Matches the server's own guard on POST /jobcard/log/produce.
  if (!(made > 0)) {
    return 'This Deckle needs its produced metres before Stop can move it to Semi Finished Stock.';
  }
  const start = toNum(startMtrs);
  const stop = toNum(stopMtrs);
  if (start === null || Number.isNaN(start) || stop === null || Number.isNaN(stop)) {
    return null;
  }
  // Tolerance of a centimetre, against deckle lengths in the hundreds of
  // metres: the auto-filled value rounds to 2dp and can sit a fraction above
  // the raw span, and a hand-typed figure shouldn't be refused over a
  // rounding-scale difference either. A real mis-key overshoots by metres.
  // The difference is itself rounded before the comparison -- 100.01 - 100
  // lands on 0.010000000000005 in floating point, which would otherwise clear
  // the tolerance it is exactly equal to.
  const span = stop - start;
  if (round2(made - span) > 0.01) {
    return `Deckle metres (${fmtMtrs(made)} m) can't be more than the ${fmtMtrs(round2(span))} m that ran between the two readings.`;
  }
  return null;
}

// A joint is a mark on web that has already run through the machine, so it
// sits after this row's start reading and no later than where it stopped. The
// mark itself stays optional: an operator can record that a web jointed
// without pinning it to a reading.
export function validateJointMtr(startMtrs, stopMtrs, jointMtr) {
  const bad = validateNumeric('Joint reading', jointMtr, { required: false });
  if (bad) {
    return bad;
  }
  const joint = toNum(jointMtr);
  if (joint === null) {
    return null;
  }
  const start = toNum(startMtrs);
  if (start !== null && !Number.isNaN(start) && joint <= start) {
    return `Joint reading (${fmtMtrs(joint)} m) must be greater than the start reading (${fmtMtrs(start)} m).`;
  }
  const stop = toNum(stopMtrs);
  if (stop !== null && !Number.isNaN(stop) && joint > stop) {
    return `Joint reading (${fmtMtrs(joint)} m) can't be past the stop reading (${fmtMtrs(stop)} m).`;
  }
  return null;
}

// How much is physically left on a reel at the end of the job. Optional (the
// whole Material Used dialog is), but once a figure is given it can't be more
// than the reel held to begin with -- that would credit back stock that never
// existed. `available` is the reel's own quantity; a missing or zero one just
// skips the ceiling.
export function validateRemainingKg(available, remaining) {
  const bad = validateNumeric('Remaining', remaining, { required: false });
  if (bad) {
    return bad;
  }
  const left = toNum(remaining);
  if (left === null) {
    return null;
  }
  const had = toNum(available);
  if (had === null || Number.isNaN(had) || had <= 0) {
    return null;
  }
  if (left > had) {
    return `Remaining (${fmtMtrs(left)}) is more than the ${fmtMtrs(had)} this reel held.`;
  }
  return null;
}

// Advisory, NOT a block: deckles run one after another off the same counter,
// so a new row starting behind where the last one stopped is usually a
// mis-key. Usually -- not always, since the counter can be reset between
// deckles, and refusing the punch would leave an operator whose machine did
// exactly that unable to record the run at all. Returns a warning to show
// while letting the punch through.
export function checkStartContinuity(previousStopMtrs, startMtrs) {
  const start = toNum(startMtrs);
  const previous = toNum(previousStopMtrs);
  if (start === null || Number.isNaN(start) || previous === null || Number.isNaN(previous)) {
    return null;
  }
  if (start < previous) {
    return `Check the reading — the last Deckle stopped at ${fmtMtrs(previous)} m, ahead of this ${fmtMtrs(start)} m start.`;
  }
  return null;
}
