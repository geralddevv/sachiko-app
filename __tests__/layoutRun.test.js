// Slitting Deckles counted by the knife layout (src/screens/queue/layoutRun.js):
// the queue tile, the Select Job picker and the job card all read a Deckle's
// place in its layout's RUN, as the server counted it -- every Deckle at that
// setting on that machine, across cards and Product Codes, the ones already
// slit still counted.
import {
  deckleNoOf,
  formatLayout,
  groupSlittingByLayout,
  layoutKeyOf,
  runLabel,
  runOf,
  runSpan,
} from '../src/screens/queue/layoutRun';

const LAYOUT = '210 + 210 + 210';

// One card is one Deckle, as the allocation POST creates them.
const card = ({ id, pos, product = 'C001WB', total = 10, done = 2, layout = LAYOUT, deckleDone = false }) => ({
  _id: id,
  productCode: product,
  layoutKey: layout,
  layoutSummary: layout,
  deckleCount: 1,
  deckleDone: deckleDone ? 1 : 0,
  layoutRunTotal: total,
  layoutRunDone: done,
  deckles: [{ id: `DECK/${pos}`, done: deckleDone, running: false, pos }],
});

describe('layoutKeyOf', () => {
  it('reads the layout the server sent', () => {
    expect(layoutKeyOf({ layoutKey: LAYOUT })).toBe(LAYOUT);
  });

  it('falls back to layoutSummary, dropping its "× n" Deckle counts', () => {
    expect(layoutKeyOf({ layoutSummary: '150 + 200 + 150 × 8' })).toBe('150 + 200 + 150');
  });

  it('is empty for a card with no layout, so it never bundles', () => {
    expect(layoutKeyOf({})).toBe('');
    expect(layoutKeyOf(null)).toBe('');
  });
});

describe('runOf', () => {
  it('reads the Deckle position and the run totals', () => {
    expect(runOf(card({ id: 'a', pos: 6 }))).toEqual({ from: 6, to: 6, total: 10, done: 2 });
  });

  it('spans an older card that holds several Deckles', () => {
    const multi = {
      layoutRunTotal: 10,
      layoutRunDone: 0,
      deckles: [{ pos: 6 }, { pos: 7 }, { pos: 8 }],
    };
    expect(runOf(multi)).toMatchObject({ from: 6, to: 8, total: 10 });
  });

  it('is null when the server sent no numbering', () => {
    expect(runOf({ deckles: [{ id: 'x' }], layoutRunTotal: 0 })).toBeNull();
    expect(runOf({ deckles: [], layoutRunTotal: 10 })).toBeNull();
    expect(runOf(undefined)).toBeNull();
  });
});

describe('runLabel', () => {
  it('reads "6/10" for one Deckle', () => {
    expect(runLabel({ from: 6, to: 6, total: 10 })).toBe('6/10');
  });

  it('reads a range when it spans several', () => {
    expect(runLabel({ from: 6, to: 8, total: 10 })).toBe('6–8/10');
  });
});

describe('formatLayout', () => {
  it('joins one layout\'s widths with " - ", same whether it came off a group or a lone card', () => {
    expect(formatLayout(LAYOUT)).toBe('210 - 210 - 210');
    expect(formatLayout('150 + 200 + 150')).toBe('150 - 200 - 150');
  });

  it('joins distinct patterns with a wide bar', () => {
    expect(formatLayout('150 + 200 | 180 + 180')).toBe('150 - 200   |   180 - 180');
  });

  it('is empty for no layout', () => {
    expect(formatLayout('')).toBe('');
    expect(formatLayout(null)).toBe('');
  });
});

describe('deckleNoOf', () => {
  it('sorts an unnumbered card last, not first', () => {
    expect(deckleNoOf(card({ id: 'a', pos: 3 }))).toBe(3);
    expect(deckleNoOf({})).toBe(Number.MAX_SAFE_INTEGER);
  });
});

// The scenario this was built for: 5 Deckles cut 210+210+210, two of them slit
// (their cards auto-completed and left the queue), then 5 MORE of the same
// layout under a different Product Code.
describe('a second job on a layout already up on the machine', () => {
  const cards = [
    // Deckles 1 and 2 are slit and gone. The first job's remaining three:
    card({ id: 'c3', pos: 3 }),
    card({ id: 'c4', pos: 4 }),
    card({ id: 'c5', pos: 5 }),
    // The second job -- same knife layout, different Product Code.
    card({ id: 'c6', pos: 6, product: 'C014AC' }),
    card({ id: 'c7', pos: 7, product: 'C014AC' }),
    card({ id: 'c8', pos: 8, product: 'C014AC' }),
    card({ id: 'c9', pos: 9, product: 'C014AC' }),
    card({ id: 'c10', pos: 10, product: 'C014AC' }),
  ];

  it('bundles both Product Codes into one tile', () => {
    const groups = groupSlittingByLayout(cards);
    expect(groups).toHaveLength(1);
    expect(groups[0].layout).toBe(LAYOUT);
    expect(groups[0].cards).toHaveLength(8);
  });

  it('numbers the Deckles still to run 3/10 .. 10/10', () => {
    const [group] = groupSlittingByLayout(cards);
    expect(group.cards.map(c => runLabel(runOf(c)))).toEqual([
      '3/10', '4/10', '5/10', '6/10',
      '7/10', '8/10', '9/10', '10/10',
    ]);
  });

  it('counts the run, not the cards on the queue: 10 Deckles, 2 slit', () => {
    const [group] = groupSlittingByLayout(cards);
    const run = runOf(group.cards[0]);
    expect(run.total).toBe(10);
    expect(run.done).toBe(2);
    // The cards listed are only what is left of it.
    expect(group.cards.length).toBe(run.total - run.done);
  });

  it('reports the span still on the queue as 3–10/10', () => {
    const [group] = groupSlittingByLayout(cards);
    expect(runLabel(runSpan(group.cards))).toBe('3–10/10');
  });

  it('lists the Deckles in run order however the cards arrived', () => {
    const shuffled = [cards[4], cards[0], cards[7], cards[2], cards[1], cards[3], cards[6], cards[5]];
    const [group] = groupSlittingByLayout(shuffled);
    expect(group.cards.map(c => runOf(c).from)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('keeps a different layout in its own tile', () => {
    const groups = groupSlittingByLayout([
      ...cards,
      card({ id: 'x1', pos: 1, layout: '210 + 214 + 225', total: 2, done: 0 }),
    ]);
    expect(groups.map(g => g.layout)).toEqual([LAYOUT, '210 + 214 + 225']);
    expect(groups[1].cards).toHaveLength(1);
  });

  it('never bundles cards that have no layout at all', () => {
    const groups = groupSlittingByLayout([
      { _id: 'n1', deckles: [], layoutKey: '' },
      { _id: 'n2', deckles: [], layoutKey: '' },
    ]);
    expect(groups).toHaveLength(2);
  });
});
