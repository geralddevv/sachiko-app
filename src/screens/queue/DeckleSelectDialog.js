import React, { useEffect, useState } from 'react';
import { View, Text, Modal, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { colors, radii, spacing, fontFamily } from '../../theme/theme';
import Button from '../../theme/Button';

// "Select Job": opened by the Start button of a same-layout group tile on the Work Queue. The
// group's jobs are listed with the Deckles still to slit in each; the operator
// picks the one going on the machine and carries on. Choosing hands that Deckle
// to its job card exactly as a scan of it would (the card confirms it on load),
// so nothing changes on the job card itself -- and "Scan Deckle instead" keeps the
// original way in, reading the physical reel.
//
// `group.cards[]` are the queue's slitting cards; each has `deckles: [{ id, done }]`.
// A job is picked as a whole: its next Deckle still to slit is the one handed over,
// and the job card lists the rest. `onSelect({ card, deckleId })` / `onScan()` /
// `onCancel()`.
export default function DeckleSelectDialog({ visible, group, onSelect, onScan, onCancel }) {
  const [selectedId, setSelectedId] = useState(null); // a card's _id

  // A fresh choice each time the dialog opens.
  useEffect(() => {
    if (visible) {
      setSelectedId(null);
    }
  }, [visible, group]);

  const cards = group ? group.cards : [];
  // Only jobs that still have a Deckle to run.
  const open = cards
    .map(card => ({ card, pending: (card.deckles || []).filter(d => d && d.id && !d.done) }))
    .filter(entry => entry.pending.length > 0);

  const chosen = selectedId ? open.find(e => e.card._id === selectedId) : null;

  const submit = () => {
    if (!chosen) {
      return;
    }
    onSelect({ card: chosen.card, deckleId: chosen.pending[0].id });
  };

  return (
    <Modal visible={!!visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.header}>
            <View style={styles.headerIcon}>
              <Icon name="layers-triple-outline" size={20} color="#FFFFFF" />
            </View>
            <Text style={styles.title}>Select Job</Text>
            {group ? (
              <Text style={styles.layout} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.6}>
                {group.layout.split(/\s*\|\s*/).map(l => l.split(/\s*\+\s*/).join(' - ')).join('   |   ')}
              </Text>
            ) : null}
          </View>

          <View style={styles.body}>
          <ScrollView
            style={styles.scroll}
            bounces={false}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.scrollContent}>
            {open.length === 0 ? (
              <Text style={styles.empty}>Every Deckle in this group has already been slit.</Text>
            ) : null}
            {open.map(({ card, pending }) => {
              const active = selectedId === card._id;
              return (
                <TouchableOpacity
                  key={card._id}
                  activeOpacity={0.8}
                  onPress={() => setSelectedId(card._id)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={`Job ${card.lotNo}, ${pending.length} Deckle${pending.length === 1 ? '' : 's'} left`}
                  style={[styles.job, active && styles.jobActive]}>
                  <View style={styles.jobHead}>
                    <View style={styles.jobHeadText}>
                      <Text style={styles.jobLot} numberOfLines={1}>
                        {card.lotNo}
                      </Text>
                      <Text style={styles.jobId} numberOfLines={1}>
                        {card.slittingJobCardId}
                        {pending.length > 1 ? ` · ${pending.length} Deckles left` : ''}
                      </Text>
                    </View>
                    <View style={styles.pill}>
                      <Text style={styles.pillText} numberOfLines={1}>
                        {card.productCode}
                      </Text>
                    </View>
                  </View>
                  {card.curing ? (
                    <Text style={styles.curing}>
                      Curing{card.curingUntilLabel ? ` · ready ${card.curingUntilLabel}` : ''}
                    </Text>
                  ) : null}
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          <View style={styles.buttonRow}>
            <TouchableOpacity activeOpacity={0.85} onPress={onCancel} style={[styles.button, styles.cancelButton]}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
            <Button title="Continue" icon="play" variant="success" onPress={submit} disabled={!chosen} style={styles.button} />
          </View>
          <Button title="Scan Deckle instead" icon="qrcode-scan" variant="outline" onPress={onScan} style={styles.scanButton} />
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
    // Fixed, so the dialog is the same size however many jobs the bundle holds
    // or whichever Deckle is picked -- the list scrolls inside it.
    height: '82%',
    maxHeight: 640,
    backgroundColor: colors.cardBg,
    borderRadius: radii.lg,
    // The header band runs edge to edge, so the padding lives on the body.
    overflow: 'hidden',
    shadowColor: '#0B1F33',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 20,
    elevation: 6,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    backgroundColor: colors.primary,
  },
  body: { flex: 1, padding: spacing.lg },
  headerIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { fontSize: 17, fontWeight: '800', color: '#FFFFFF', fontFamily },
  // The knife layout, big, right beside the heading -- it is what tells the
  // operator which bundle this is.
  layout: {
    flex: 1,
    textAlign: 'right',
    fontSize: 22,
    fontWeight: '800',
    color: '#FFFFFF',
    fontFamily,
  },
  scroll: { flex: 1 },
  scrollContent: { gap: spacing.sm },
  empty: { fontSize: 13, color: colors.textMuted, textAlign: 'center', paddingVertical: spacing.lg, fontFamily },
  job: {
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radii.md,
    backgroundColor: colors.cardBg,
    padding: spacing.md,
    gap: spacing.xs,
  },
  jobActive: { borderColor: colors.primary, borderWidth: 2, backgroundColor: colors.infoPanelBg },
  jobHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.xs },
  jobHeadText: { flex: 1 },
  jobLot: { fontSize: 14, fontWeight: '800', color: colors.textDark, fontFamily },
  jobId: { fontSize: 11.5, fontWeight: '600', color: colors.textMuted, fontFamily },
  pill: {
    borderWidth: 1.5,
    borderColor: colors.primary,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    maxWidth: 140,
  },
  pillText: { fontSize: 11.5, fontWeight: '800', color: colors.primary, fontFamily },
  curing: { fontSize: 11.5, fontWeight: '700', color: colors.noticeText, paddingHorizontal: spacing.xs, fontFamily },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  button: { flex: 1 },
  cancelButton: {
    backgroundColor: colors.danger,
    borderRadius: radii.sm,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700', fontFamily },
  scanButton: { marginTop: spacing.sm },
});
