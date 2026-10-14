// Counting slitting Deckles by the KNIFE LAYOUT rather than by the card.
//
// One Slitting Job Card is ONE Deckle, so "5 Deckles cut 210 + 210 + 210" is
// five cards allocated in one submit -- and every Deckle slit takes its card
// off the queue. Counting per card therefore said nothing useful ("Deckles: 1,
// done: 0"), and counting per batch of cards restarted at 1 whenever fresh work
// landed on a setting already up on the machine.
//
// The server counts a LAYOUT RUN instead: every Deckle -- slit or still to run
// -- at one knife layout on one machine, across cards and Product Codes, with
// the ones already slit still counted (buildLayoutRuns in
// routes/system/slitting.js). It sends each Deckle its place in that run as
// `deckles[].pos`, with `layoutRunTotal` / `layoutRunDone` beside them, so a
// Deckle reads "6 of 10" here and carries the very same number on the office's
// machine queue. Nothing in this file decides the numbering; it only reads it.
//
// Pure functions, no React and no React Native, so __tests__/layoutRun.test.js
// can exercise them directly.

// The cards bundled under one tile: same knife layout, whatever Product Code
// each is cutting -- the setting on the machine is what they share. The server
// sends `layoutKey` (the roll widths alone, no Deckle counts) for exactly this,
// and the web machine queue groups on the same value, so the two can't
// disagree. Older servers send only `layoutSummary` ("150 + 200 + 150 × 8",
// " | " between distinct patterns), which yields the same key once the " × n"
// counts are stripped -- they say how much of a layout a card has, not what it
// is. A card with no layout never bundles.
export const layoutKeyOf = card =>
  String((card && (card.layoutKey || card.layoutSummary)) || '')
    .replace(/\s*×\s*\d+/g, '')
    .trim();

// Where a card's Deckles sit in their layout's run. One card is ONE Deckle, so
// `from` is normally the whole story; `to` differs only for an older card that
// holds several. Null when the server sent no numbering (nothing to show).
export const runOf = card => {
  const nums = ((card && card.deckles) || []).map(d => Number(d && d.pos)).filter(n => n > 0);
  const total = Number(card && card.layoutRunTotal) || 0;
  if (!nums.length || !total) {
    return null;
  }
  return {
    from: Math.min(...nums),
    to: Math.max(...nums),
    total,
    done: Number(card && card.layoutRunDone) || 0,
  };
};

// For sorting: a card with no run number sinks to the bottom, not to the top.
export const deckleNoOf = card => {
  const run = runOf(card);
  return run ? run.from : Number.MAX_SAFE_INTEGER;
};

// The span of a run that several cards cover -- every card of a group shares
// one run, so the totals are taken from the first that has them.
export const runSpan = cards => {
  const runs = (cards || []).map(runOf).filter(Boolean);
  if (!runs.length) {
    return null;
  }
  return {
    from: Math.min(...runs.map(r => r.from)),
    to: Math.max(...runs.map(r => r.to)),
    total: runs[0].total,
    done: runs[0].done,
  };
};

// "6/10" -- or "6–8/10" when it spans more than one Deckle.
export const runLabel = run =>
  `${run.from === run.to ? run.from : `${run.from}–${run.to}`}/${run.total}`;

// "150 + 200 + 150" (one knife layout) or "150 + 200 | 180 + 180" (several
// distinct patterns bundled under one card) rendered the way the floor reads
// a layout: widths joined with " - ", patterns with a wide bar between them.
// Shared by every tile that heads itself with a layout -- the group tile, a
// lone card showing the same layout it would have grouped under had there
// been a second Deckle to bundle with, and the Select Job picker -- so the
// format can't drift between them.
export const formatLayout = layout =>
  String(layout || '')
    .split(/\s*\|\s*/)
    .map(l => l.split(/\s*\+\s*/).join(' - '))
    .join('   |   ');

// Slitting cards grouped into one tile per knife layout, groups keeping the
// order of their first card and each group's cards in run order, so a picker
// lists them 3, 4, 5 ... down the page rather than in arrival order.
export const groupSlittingByLayout = cards => {
  const groups = [];
  const byKey = new Map();
  (cards || []).forEach(card => {
    const key = layoutKeyOf(card) || `none-${card._id}`;
    let group = byKey.get(key);
    if (!group) {
      group = { key, layout: layoutKeyOf(card), cards: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.cards.push(card);
  });
  groups.forEach(group => group.cards.sort((a, b) => deckleNoOf(a) - deckleNoOf(b)));
  return groups;
};
