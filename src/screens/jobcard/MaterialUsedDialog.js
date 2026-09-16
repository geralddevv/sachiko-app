import React, { useMemo, useState } from 'react';
import { View, Text, TextInput, Modal, ScrollView, StyleSheet } from 'react-native';
import { colors, radii, spacing, fontFamily } from '../../theme/theme';
import Button from '../../theme/Button';
import Toast, { useToast } from '../../theme/Toast';
import { validateRemainingKg } from '../../utils/meters';

const POOL_LABEL = { facestock: 'Facestock', adhesive: 'Adhesive', release: 'Release Liner' };

const round2 = n => Math.round(n * 100) / 100;

// Shown on Save: how much of each allotted-but-not-yet-swapped-off reel this
// job actually used, one row per reel per pool -- mirrors jobCardForm.ejs's
// end-of-job "Material Used" dialog. Built off prefill.layerAllotments
// (buildQueueRows' own per-layer reel list) rather than a dedicated
// eligible-stock endpoint, since that's the shape already confirmed on this
// screen's own load.
//
// ONE field per reel: how much is LEFT on it. `used` is derived from that
// (available - remaining), exactly as the web dialog does -- it is never asked
// for separately. Asking for both was misleading: consumePoolUsage in
// routes/system/machine.js prefers remainingKg whenever it is present and
// recomputes `used` from it, so a typed "used" figure was silently discarded,
// and a row with only the remaining filled in was dropped from the payload
// entirely.
//
// Every row is optional -- a reel with nothing entered is simply left out of
// the save payload; this reconciliation is a best-effort figure the schema
// doesn't require to produce a Deckle.
export default function MaterialUsedDialog({ visible, layerAllotments, materialSwapLog, onCancel, onSubmit }) {
  const [remaining, setRemaining] = useState({}); // stockId -> remaining string
  // Its own toast: this is a Modal, so one rendered by the screen behind it
  // would come up underneath the backdrop.
  const { toast, showToast, hideToast } = useToast();

  const rows = useMemo(() => {
    const swapped = new Set((materialSwapLog || []).map(s => String(s.stockId)));
    const out = [];
    (layerAllotments || []).forEach(layer => {
      (layer.reels || []).forEach(reel => {
        if (swapped.has(String(reel._id))) {
          return;
        }
        out.push({ pool: layer.pool, ...reel });
      });
    });
    return out;
  }, [layerAllotments, materialSwapLog]);

  const handleSubmit = () => {
    const byPool = { facestock: [], adhesive: [], release: [] };
    // A figure that doesn't add up used to be dropped from the payload in
    // silence, so a mis-keyed reel simply went unreported and the operator was
    // never told. Nothing is sent until every filled-in row is sound; blank
    // rows stay blank, since the whole dialog is optional.
    const bad = rows
      .map(row => ({ row, error: validateRemainingKg(row.reelMtrs, remaining[row._id]) }))
      .find(entry => entry.error);
    if (bad) {
      showToast(`${POOL_LABEL[bad.row.pool]} · ${bad.row.rollId}: ${bad.error}`);
      return;
    }
    rows.forEach(row => {
      const left = remaining[row._id];
      if (left === undefined || !String(left).trim()) {
        return;
      }
      const remainingKg = Number(left);
      // Same derivation the web form makes (submitMaterialUsage in
      // jobCardForm.ejs): what came off the reel is what it held less what is
      // left on it. Sent alongside remainingKg so the server has both, but
      // remainingKg is the figure it actually acts on.
      const available = Number(row.reelMtrs) || 0;
      byPool[row.pool].push({
        stockId: row._id,
        rollId: row.rollId,
        used: Math.max(0, round2(available - remainingKg)),
        remainingKg,
      });
    });
    onSubmit(byPool);
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Material Used</Text>
          <Text style={styles.subtitle}>Optional -- how much is left on each reserved reel.</Text>
          <ScrollView style={styles.list}>
            {rows.length === 0 ? (
              <Text style={styles.emptyText}>Nothing left to report -- every reserved reel was already accounted for.</Text>
            ) : (
              rows.map(row => (
                <View key={row._id} style={styles.row}>
                  <Text style={styles.rowTitle}>
                    {POOL_LABEL[row.pool]} · {row.rollId}
                  </Text>
                  <Text style={styles.rowSub}>{row.reelMtrs} available · {row.location}</Text>
                  <View style={styles.fieldsRow}>
                    <TextInput
                      style={styles.input}
                      value={remaining[row._id] || ''}
                      onChangeText={v => setRemaining(r => ({ ...r, [row._id]: v }))}
                      keyboardType="numeric"
                      placeholder="Remaining kg"
                      // Set explicitly, as everywhere else in the app: the
                      // platform default hint colour renders near-white on
                      // this theme, and with one field left the placeholder is
                      // the only thing naming it.
                      placeholderTextColor={colors.textMuted}
                    />
                  </View>
                </View>
              ))
            )}
          </ScrollView>
          <View style={styles.buttons}>
            <Button title="Skip" variant="danger" onPress={() => onSubmit({ facestock: [], adhesive: [], release: [] })} style={styles.buttonHalf} />
            <Button title="Continue" onPress={handleSubmit} style={styles.buttonHalf} />
          </View>
        </View>

        <Toast toast={toast} onHide={hideToast} />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  card: { width: '100%', maxWidth: 420, maxHeight: '80%', backgroundColor: '#FFFFFF', borderRadius: radii.lg, padding: spacing.lg },
  title: { fontSize: 16, fontWeight: '700', color: colors.textDark, fontFamily },
  subtitle: { fontSize: 12, color: colors.textMuted, marginTop: 2, marginBottom: spacing.sm, fontFamily },
  list: { flexGrow: 0 },
  emptyText: { color: colors.textMuted, fontSize: 13, textAlign: 'center', paddingVertical: spacing.lg, fontFamily },
  row: { borderBottomWidth: 1, borderBottomColor: colors.borderLight, paddingVertical: spacing.sm },
  rowTitle: { fontWeight: '700', color: colors.textDark, fontSize: 13, fontFamily },
  rowSub: { fontSize: 11.5, color: colors.textMuted, fontFamily },
  fieldsRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    fontSize: 13,
    color: colors.textDark,
    fontFamily,
  },
  buttons: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  buttonHalf: { flex: 1 },
});
