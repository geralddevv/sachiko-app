import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Animated,
  PanResponder,
  LayoutAnimation,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { colors, radii, spacing, fontFamily } from '../../theme/theme';
import Button from '../../theme/Button';
import DeckleWebStrip from './DeckleWebStrip';

const round2 = n => Math.round(Number(n) * 100) / 100;
const fmt = n => String(round2(n));

// Lets the operator re-order the finished-roll widths across one Deckle's web --
// 210 + 210 + 230 laid out as 210 + 230 + 210. Only the ORDER changes: the same
// widths, the same web. The slot letters (A, B, C...) are positions across the
// web, so they stay in place and each takes whichever width now sits there.
//
// Press and hold a width, drag it up or down to where it belongs, let go. The
// other widths slide out of the way as it passes, and the strip underneath
// redraws to scale, so what is saved is exactly what is on screen. Nothing is
// saved until Save layout.
//
// `onSave(order)` gets the new order as the ORIGINAL positions, e.g. [0, 2, 1].
// ROW_H is the pitch of one row (its height plus the gap under it): the drag maths
// moves a width by one slot for every ROW_H the finger travels.
const ITEM_H = 52;
const ROW_GAP = 4;
const ROW_H = ITEM_H + ROW_GAP;

export default function SlittingLayoutDialog({ visible, row, saving, onCancel, onSave }) {
  // [{ from, width, orderedWidth }] in the order currently on screen.
  const [items, setItems] = useState([]);
  // The real slot letters, in position order -- they do not move with the widths.
  const [slots, setSlots] = useState([]);
  // `from` of the width being dragged, or null.
  const [activeId, setActiveId] = useState(null);

  // The responders are built once per width but must read the CURRENT order,
  // which changes under them mid-drag -- so the live order sits in a ref.
  const itemsRef = useRef([]);
  // Every row owns a permanent translateY + scale, at rest 0 and 1. They are
  // always present in the row's style rather than added only while it is held:
  // React Native does not reliably undo a transform that is removed from a
  // native view, which left a dropped row stuck lifted.
  const anim = useRef({}).current;
  const animFor = id => {
    if (!anim[id]) {
      anim[id] = { y: new Animated.Value(0), scale: new Animated.Value(1) };
    }
    return anim[id];
  };
  const drag = useRef({ id: null, startPos: 0 });
  const responders = useRef({});

  const commit = next => {
    itemsRef.current = next;
    setItems(next);
  };

  useEffect(() => {
    if (!visible || !row) {
      return;
    }
    const cuts = row.cuts || [];
    setSlots(cuts.map(c => c.slot));
    setActiveId(null);
    responders.current = {};
    commit(cuts.map((c, from) => ({ from, width: c.width, orderedWidth: c.orderedWidth })));
  }, [visible, row]);

  const responderFor = id => {
    if (responders.current[id]) {
      return responders.current[id];
    }
    const posOf = () => itemsRef.current.findIndex(it => it.from === id);

    const finish = () => {
      drag.current = { id: null, startPos: 0 };
      const { y, scale } = animFor(id);
      Animated.parallel([
        Animated.timing(y, { toValue: 0, duration: 120, useNativeDriver: false }),
        Animated.timing(scale, { toValue: 1, duration: 120, useNativeDriver: false }),
      ]).start();
      setActiveId(null);
    };

    const responder = PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      // Keep the touch once it has been taken: the outer ScrollView must not
      // steal it halfway through a drag.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        drag.current = { id, startPos: posOf() };
        const { y, scale } = animFor(id);
        y.setValue(0);
        scale.setValue(1.03);
        setActiveId(id);
      },
      onPanResponderMove: (_, g) => {
        const list = itemsRef.current;
        const cur = posOf();
        const target = Math.max(0, Math.min(list.length - 1, Math.round(drag.current.startPos + g.dy / ROW_H)));
        let pos = cur;
        if (target !== cur) {
          const next = list.slice();
          const [moved] = next.splice(cur, 1);
          next.splice(target, 0, moved);
          LayoutAnimation.configureNext(LayoutAnimation.create(120, 'easeInEaseOut', 'opacity'));
          commit(next);
          pos = target;
        }
        // The dragged row keeps following the finger even as its slot in the
        // list changes underneath it.
        animFor(id).y.setValue(g.dy - (pos - drag.current.startPos) * ROW_H);
      },
      onPanResponderRelease: finish,
      onPanResponderTerminate: finish,
    });
    responders.current[id] = responder;
    return responder;
  };

  const changed = items.some((it, pos) => it.from !== pos);
  const summary = items.map(it => fmt(it.width)).join(' + ');
  const original = (row?.cuts || []).map(c => fmt(c.width)).join(' + ');

  // The strip is the same one the card shows, fed the new order.
  const previewRow = row
    ? { ...row, cuts: items.map((it, pos) => ({ slot: slots[pos], width: it.width, orderedWidth: it.orderedWidth })) }
    : null;

  return (
    <Modal visible={!!visible} transparent animationType="fade" onRequestClose={saving ? undefined : onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          {/* While a width is held the list is lifted above the buttons and no longer
              clips, so the dragged row floats over the whole dialog rather than being
              cut off at the edge of the scroll area. */}
          <ScrollView
            style={activeId !== null && styles.scrollLifted}
            scrollEnabled={activeId === null}
            bounces={false}
            showsVerticalScrollIndicator={false}>
            <View style={styles.header}>
              <View style={styles.headerIcon}>
                <Icon name="swap-vertical" size={20} color={colors.primary} />
              </View>
              <View style={styles.headerText}>
                <Text style={styles.title}>Reorder</Text>
                {row?.deckleId ? (
                  <Text style={styles.deckleId} numberOfLines={1}>
                    {row.deckleId}
                  </Text>
                ) : null}
              </View>
            </View>
            <Text style={styles.subtitle}>Hold a width and drag it to where you want it. Left to right is A, B, C…</Text>

            <View style={[styles.summaryBox, changed && styles.summaryBoxChanged]}>
              <Text style={styles.summary}>{summary}</Text>
              {changed ? (
                <Text style={styles.was} numberOfLines={1}>
                  was {original}
                </Text>
              ) : null}
            </View>

            {previewRow ? (
              <View style={styles.preview}>
                <DeckleWebStrip row={previewRow} />
              </View>
            ) : null}

            <View style={[styles.list, activeId !== null && styles.listLifted]}>
              {items.map((it, pos) => {
                const active = activeId === it.from;
                return (
                  <Animated.View
                    key={it.from}
                    {...(saving ? {} : responderFor(it.from).panHandlers)}
                    style={[
                      styles.item,
                      active && styles.itemActive,
                      { transform: [{ translateY: animFor(it.from).y }, { scale: animFor(it.from).scale }] },
                    ]}>
                    <View style={styles.slotBadge}>
                      <Text style={styles.slotText}>{slots[pos]}</Text>
                    </View>
                    <Text style={styles.width}>{fmt(it.width)} mm</Text>
                    <Icon name="drag-horizontal-variant" size={26} color={active ? colors.primary : colors.textMuted} />
                  </Animated.View>
                );
              })}
            </View>
          </ScrollView>

          <View style={styles.buttonRow}>
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={onCancel}
              disabled={saving}
              style={[styles.button, styles.cancelButton]}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
            {saving ? (
              <View style={[styles.button, styles.savingBox]}>
                <ActivityIndicator color="#FFFFFF" />
              </View>
            ) : (
              <Button
                title="Save layout"
                onPress={() => onSave(items.map(it => it.from))}
                disabled={!changed}
                style={styles.button}
              />
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(11,31,51,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  card: {
    width: '100%',
    maxWidth: 400,
    maxHeight: '92%',
    backgroundColor: colors.cardBg,
    borderRadius: radii.lg,
    padding: spacing.lg,
    shadowColor: '#0B1F33',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 20,
    elevation: 6,
  },
  scrollLifted: { overflow: 'visible', zIndex: 20, elevation: 20 },
  listLifted: { zIndex: 20, elevation: 20 },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  headerIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.headerRowBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerText: { flex: 1 },
  title: { fontSize: 17, fontWeight: '800', color: colors.textDark, fontFamily },
  deckleId: { fontSize: 12, fontWeight: '600', color: colors.textMuted, marginTop: 1, fontFamily },
  subtitle: { fontSize: 12.5, lineHeight: 18, color: colors.textMuted, marginTop: spacing.md, fontFamily },
  summaryBox: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
    backgroundColor: colors.headerRowBg,
    alignItems: 'center',
    // Fixed, with room for the "was" line: the box never grows when it appears, and
    // the sum sits in the middle until then.
    justifyContent: 'center',
    height: 72,
  },
  summaryBoxChanged: { borderColor: colors.primary },
  summary: { fontSize: 20, fontWeight: '800', color: colors.primary, textAlign: 'center', fontFamily },
  was: {
    fontSize: 11.5,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: 2,
    textDecorationLine: 'line-through',
    fontFamily,
  },
  preview: { marginTop: spacing.md },
  list: { marginTop: spacing.md },
  item: {
    height: ITEM_H,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    marginBottom: ROW_GAP,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.cardBg,
  },
  itemActive: {
    zIndex: 30,
    elevation: 24,
    borderColor: colors.primary,
    backgroundColor: colors.headerRowBg,
    shadowColor: '#0B1F33',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
  },
  slotBadge: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  slotText: { color: '#FFFFFF', fontWeight: '800', fontSize: 13, fontFamily },
  width: { flex: 1, fontSize: 17, fontWeight: '700', color: colors.textDark, fontFamily },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg, zIndex: 0 },
  button: { flex: 1 },
  savingBox: {
    backgroundColor: colors.primary,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  cancelButton: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelButtonText: { color: colors.textDark, fontSize: 13, fontWeight: '700', fontFamily },
});
