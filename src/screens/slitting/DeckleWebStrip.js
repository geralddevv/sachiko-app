import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { fontFamily } from '../../theme/theme';

// The A..L knife layout drawn to scale across one Deckle web -- the same strip
// the planner fixed on Slitting Allocation (/sachiko/slitting/allocate/
// :pendingId), redrawn here read-only. It is the one picture on this card:
// everything else is a number, and what the operator has to recognise at a
// glance is whether the reel in front of them is the web this layout belongs
// on.
//
// Colours and proportions are taken verbatim from that page's own .sl-web CSS
// rather than from this app's navy palette, deliberately: the strip is a
// diagram with a fixed colour key, not a themed surface, and an operator who
// has just been handed a printed allocation has to see the same picture here.
//
//   green   the cut rolls -- the finished-roll widths actually being made,
//           alternating #16a34a / #15803d so neighbours stay distinct
//   orange  the fixed edge trim taken off each side of the raw web
//   red     the uncut slack left over inside the web (width - sum of cuts)
//
// Three different things, three different colours, so a glance at the strip
// alone says where every millimetre went.
//
// `width` is the NET cuttable width (after edge trim); `webWidth` is the raw
// web the reel was laminated to (its MaterialStock.size), so the two edge
// segments -- (webWidth - width) split evenly -- can be drawn as well.

const WEB = {
  cut: '#16a34a',
  cutAlt: '#15803d',
  edge: '#f97316',
  trim: '#dc2626',
  border: '#cbd5e1',
  borderOver: '#ef4444',
  ring: 'rgba(239, 68, 68, 0.15)',
  ok: '#15803d',
  bad: '#b91c1c',
  emptyBg: '#F1F5F9',
  emptyText: '#94a3b8',
};

const round2 = n => Math.round(Number(n) * 100) / 100;

// Trailing zeros off, the way the web strip prints its widths: "150", not
// "150.00", but "152.5" kept.
const fmt = value => {
  if (value === null || value === undefined || value === '') {
    return '—';
  }
  const num = Number(value);
  return Number.isFinite(num) ? String(round2(num)) : '—';
};

// One segment of the strip. `flexGrow` proportional to the millimetres it
// covers and `flexBasis: 0` is what makes the drawing to scale -- a 168 mm
// slot sits visibly wider than a 150 mm one, which is the whole point of
// showing it as a picture rather than a list.
//
// `last` drops the hairline separator, mirroring .sl-web-seg:last-child.
function Segment({ slot, width, background, last }) {
  return (
    <View style={[styles.seg, { backgroundColor: background, flexGrow: Number(width) || 1 }, last && styles.segLast]}>
      <Text style={styles.segSlot} numberOfLines={1}>
        {slot}
      </Text>
      <Text style={styles.segWidth} numberOfLines={1}>
        {fmt(width)}
      </Text>
    </View>
  );
}

export default function DeckleWebStrip({ row }) {
  const cuts = (row?.cuts || []).filter(c => Number(c.width) > 0);
  const width = row?.width === null || row?.width === undefined ? null : Number(row.width);
  const webWidth = row?.webWidth === null || row?.webWidth === undefined ? null : Number(row.webWidth);
  // Half the raw web's overhang -- the fixed trim taken off each side. Null
  // when the reel carries no size, in which case the edges aren't drawn at all.
  const edgeMM = width !== null && webWidth !== null && webWidth > width ? round2((webWidth - width) / 2) : null;

  if (!cuts.length) {
    return (
      <View style={styles.web}>
        {edgeMM !== null ? <Segment slot="EDGE" width={edgeMM} background={WEB.edge} /> : null}
        <View style={[styles.empty, { flexGrow: width || 1 }]}>
          <Text style={styles.emptyText} numberOfLines={1}>
            {width !== null ? `${fmt(width)} mm web — no roll widths` : 'No web width recorded'}
          </Text>
        </View>
        {edgeMM !== null ? <Segment slot="EDGE" width={edgeMM} background={WEB.edge} last /> : null}
      </View>
    );
  }

  const widthTotal = round2(cuts.reduce((sum, c) => sum + Number(c.width), 0));
  const trimW = width !== null ? round2(width - widthTotal) : 0;
  // The knives are set wider than the web -- the layout does not physically
  // fit. Shown rather than hidden: it is the planner's to fix, and the
  // operator needs to know before they run it.
  const over = width !== null && trimW < 0;

  // Built as one list so the alternating fill can be keyed on a segment's
  // position across the WHOLE strip, edges included -- exactly what
  // .sl-web-seg:nth-child(even) does. Edge and trim keep their own colour:
  // in the stylesheet those rules come after the nth-child one and win at
  // equal specificity.
  const segments = [];
  if (edgeMM !== null) {
    segments.push({ key: 'edge-l', slot: 'EDGE', width: edgeMM, fixed: WEB.edge });
  }
  cuts.forEach(c => segments.push({ key: `cut-${c.slot}`, slot: c.slot, width: c.width }));
  if (!over && trimW > 0) {
    segments.push({ key: 'trim', slot: 'TRIM', width: trimW, fixed: WEB.trim });
  }
  if (edgeMM !== null) {
    segments.push({ key: 'edge-r', slot: 'EDGE', width: edgeMM, fixed: WEB.edge });
  }

  const caption = over
    ? `Over the web by ${fmt(widthTotal - width)} mm`
    : `${cuts.length} roll${cuts.length === 1 ? '' : 's'} · ${fmt(widthTotal)} of ${fmt(width)} mm` +
      (edgeMM !== null
        ? ` · ${fmt(trimW)} mm trim + ${fmt(edgeMM * 2)} mm edge`
        : trimW > 0
        ? ` · ${fmt(trimW)} mm trim`
        : '');

  const strip = (
    <View style={[styles.web, over && styles.webOver]}>
      {segments.map((seg, i) => (
        <Segment
          key={seg.key}
          slot={seg.slot}
          width={seg.width}
          // nth-child(even) is 1-based, so index 1 is the second segment.
          background={seg.fixed || ((i + 1) % 2 === 0 ? WEB.cutAlt : WEB.cut)}
          last={i === segments.length - 1}
        />
      ))}
    </View>
  );

  return (
    <View>
      <Text style={[styles.caption, over ? styles.captionBad : styles.captionOk]} numberOfLines={2}>
        {caption}
      </Text>
      {/* The over-the-web ring. RN has no box-shadow that renders the same on
          both platforms, so the halo is a padded parent rather than a shadow. */}
      {over ? <View style={styles.ring}>{strip}</View> : strip}
    </View>
  );
}

const styles = StyleSheet.create({
  caption: {
    textAlign: 'center',
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 5,
    fontFamily,
  },
  captionOk: { color: WEB.ok },
  captionBad: { color: WEB.bad },
  ring: {
    padding: 2,
    borderRadius: 9,
    backgroundColor: WEB.ring,
  },
  web: {
    flexDirection: 'row',
    alignItems: 'stretch',
    height: 32,
    width: '100%',
    borderWidth: 1,
    borderColor: WEB.border,
    borderRadius: 7,
    overflow: 'hidden',
    backgroundColor: '#FFFFFF',
  },
  webOver: { borderColor: WEB.borderOver },
  seg: {
    // flexBasis 0 so every segment's share of the row is decided purely by
    // its own flexGrow -- i.e. by the millimetres it covers.
    flexBasis: 0,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
    overflow: 'hidden',
    // The hairline between segments is white, not a border colour: the strip
    // reads as one web divided by knives, not as a row of separate boxes.
    borderRightWidth: 1,
    borderRightColor: '#FFFFFF',
  },
  segLast: { borderRightWidth: 0 },
  segSlot: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.54,
    color: '#FFFFFF',
    opacity: 0.8,
    fontFamily,
  },
  segWidth: {
    fontSize: 11.5,
    fontWeight: '800',
    color: '#FFFFFF',
    fontVariant: ['tabular-nums'],
    fontFamily,
  },
  empty: {
    flexBasis: 0,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: WEB.emptyBg,
  },
  emptyText: {
    fontSize: 11.5,
    fontWeight: '600',
    color: WEB.emptyText,
    fontFamily,
  },
});
