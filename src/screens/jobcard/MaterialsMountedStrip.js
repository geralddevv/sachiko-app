import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Modal, ActivityIndicator } from 'react-native';
import { colors, radii, spacing, fontFamily } from '../../theme/theme';
import Button from '../../theme/Button';
import AppDialog from '../../theme/AppDialog';
import { checkMaterial, setRemaining, ApiError } from '../../services/api';
import { extractScannedRollId } from '../../utils/rollId';

const POOLS = [
  { key: 'facestock', label: 'Facestock' },
  { key: 'adhesive', label: 'Adhesive' },
  { key: 'release', label: 'Release Liner' },
];

// Same names, keyed by pool, for prose that has to name a slot.
const POOL_LABELS = Object.fromEntries(POOLS.map(p => [p.key, p.label]));

// Scan each raw-material reel ONCE here; it carries into every Job Setting
// row and every Production Log deckle rather than being re-scanned per row
// (unlike Fairtech's single-pool, per-row model) -- ported from
// jobCardForm.ejs's "Materials Mounted" strip (setCurrentMaterial/
// lockMaterialSlot/unlockMaterialSlot). Validated against the order's recipe
// via POST /jobcard/material/check before it's accepted; actually marking a
// reel "in use" on the server (POST /jobcard/mark-in-use) happens later, the
// moment a row's Start is punched -- see JobCardScreen's markMountedInUse,
// not here.
//
// A scan does NOT arrive as a Roll ID. The sticker a reel gets when its stock
// is created carries the whole label in its QR -- vendor, product code, dates,
// invoice, weight, size and the Roll ID LAST, all run together with no
// separator (SACHIKO2's utils/materialRollLabel.js) -- so the payload has to
// be read from the end. utils/rollId.js does that; `eligibleRawStock` is
// handed to it so a reel the server has already named for this pool is
// matched exactly instead of parsed. The server's own extractScannedRollId is
// still first-token-only, which is why the Roll ID is resolved here rather
// than posted raw and left to it.
export default function MaterialsMountedStrip({
  pendingId,
  mounted,
  eligibleRawStock,
  onMountedChange,
  onScanRequest,
}) {
  const [checking, setChecking] = useState(null); // pool currently being validated
  const [swapPool, setSwapPool] = useState(null); // pool the Change dialog is open for
  const [swapRemaining, setSwapRemaining] = useState('');
  const [swapReason, setSwapReason] = useState('');
  const [swapError, setSwapError] = useState(null);
  const [swapping, setSwapping] = useState(false);
  const [manualInput, setManualInput] = useState({ facestock: '', adhesive: '', release: '' });
  const [note, setNote] = useState({ facestock: null, adhesive: null, release: null }); // { tone, title, detail }
  // Owned here rather than raised through JobCardScreen: this dialog belongs
  // to the mount attempt that triggered it, and keeping it local means the
  // strip needs nothing from its parent to explain a refused reel.
  const [dialog, setDialog] = useState(null);
  // Which Label Stock the mounted combination resolves to, when that is NOT
  // the order's own code -- see the note by the render below.
  const [variant, setVariant] = useState(null);

  const mountReel = async (pool, rawValue) => {
    const raw = String(rawValue ?? '').trim();
    if (!raw) {
      return;
    }
    const rollId = extractScannedRollId(raw, (eligibleRawStock?.[pool] || []).map(r => r.rollId));
    if (!rollId) {
      return;
    }
    // Shown only if the server can't identify the reel. This is the Roll ID
    // we resolved, not the raw scan -- an unreadable label is much easier to
    // chase from "the id we read off it" than from 70 characters of sticker.
    const shown = rollId.length > 24 ? `${rollId.slice(0, 24)}…` : rollId;
    setChecking(pool);
    setNote(n => ({ ...n, [pool]: null }));
    try {
      // The reels already on the other pools, under the codes the server's
      // resolveScannedCombinationVariant reads them by. Without these it only
      // ever sees the one reel being scanned, can never tell the combination
      // is complete, and answers "pending" forever -- so the variant below
      // would never resolve. The pool being scanned is deliberately absent:
      // its reel isn't mounted yet, and the server takes it from `rollId`.
      const res = await checkMaterial({
        pendingId,
        pool,
        rollId,
        mounted: {
          fs: mounted.facestock?.rollId || '',
          ad: mounted.adhesive?.rollId || '',
          rl: mounted.release?.rollId || '',
        },
      });
      if (!res.ok) {
        // "wip" is not a failure and shouldn't read like one: the label
        // scanned fine, the reel exists, and it is allowed on this order --
        // it just happens to be on another machine right now. So it gets a
        // calm informational panel naming where it is, not the amber warning
        // the genuine problems below use. The operator's next move is to go
        // and fetch a different reel, and the thing they need for that is the
        // lot and machine, not an error message.
        if (res.code === 'wip') {
          const rid = res.rollId || shown;
          const where = `${res.lotNo || 'another job'}${res.machineName ? ` at ${res.machineName}` : ''}`;
          // A dialog rather than an inline note: a reel that is already running
          // is the one outcome the operator must not walk past, and on a
          // machine the strip can sit off-screen while they are looking at the
          // reel in their hands. Mirrors the web form's own openWipBlockDialog.
          // `info`, not `error` -- nothing has gone wrong, this reel is simply
          // spoken for.
          //
          // `pool` rides along so OK knows which slot to reset -- see the
          // AppDialog below.
          setDialog({
            pool,
            tone: 'info',
            title: 'Reel already in use',
            message: `${rid} is already running on ${where}. Mount a different reel for ${POOL_LABELS[pool] || pool}.`,
          });
          return;
        }
        // A reel inwarded with no purchase invoice can never be run, on this
        // order or any other, so it gets the same blocking dialog as a reel
        // that is already in use rather than a note the operator can scroll
        // past -- and OK clears the slot the same way. Only the office can
        // clear this one, so the message says who has to act.
        if (res.code === 'no-invoice') {
          const rid = res.rollId || shown;
          setDialog({
            pool,
            tone: 'warning',
            title: 'Reel has no invoice',
            message: `${rid} was inwarded without a purchase invoice, so it can't be used. Ask the office to add the invoice, and mount a different reel for ${POOL_LABELS[pool] || pool}.`,
          });
          return;
        }
        // These two ARE problems with what was scanned -- a reel that isn't
        // in stock at all, or one whose spec doesn't match the recipe.
        const msg =
          res.code === 'mismatch'
            ? `${res.rollId || shown} doesn't match this order's recipe.`
            : `${shown} — unknown reel.`;
        setNote(n => ({ ...n, [pool]: { tone: 'warn', title: msg } }));
        return;
      }
      // res.reel is the server's canonical record: { _id, rollId, reelMtrs,
      // location, allotted }. Stored as-is, so `_id` is what every later
      // stockId-taking call (set-remaining, the .prn endpoints, the deckle's
      // materialsUsed trace) reads.
      onMountedChange(pool, res.reel);
      setManualInput(m => ({ ...m, [pool]: '' }));
      // Resolved only once every pool the recipe needs has a reel; `pending`
      // is a half-mounted combination and says nothing. A combination that
      // resolves to the order's own code says nothing either -- the only
      // thing worth the operator's attention is that these particular reels
      // will produce a DIFFERENT product code from the one on the job.
      const v = res.variant;
      setVariant(v && !v.pending && v.isVariant ? v : null);
    } catch (err) {
      setNote(n => ({
        ...n,
        [pool]: { tone: 'warn', title: err instanceof ApiError ? err.message : 'Could not validate this reel.' },
      }));
    } finally {
      setChecking(null);
    }
  };

  // Both ways out of the dialog (OK, and Android back) land here, so the slot
  // is reset either way rather than only on the button.
  const clearSlotAndCloseDialog = () => {
    const pool = dialog?.pool;
    if (pool) {
      setManualInput(m => ({ ...m, [pool]: '' }));
      setNote(n => ({ ...n, [pool]: null }));
    }
    setDialog(null);
  };

  const openChange = pool => {
    setSwapPool(pool);
    setSwapRemaining('');
    setSwapReason('');
    setSwapError(null);
  };

  const confirmChange = async () => {
    const reel = mounted[swapPool];
    if (!reel) {
      return;
    }
    const remaining = Number(swapRemaining);
    if (!Number.isFinite(remaining) || remaining < 0) {
      setSwapError('Enter a valid non-negative kg amount.');
      return;
    }
    if (swapReason.trim().length < 3) {
      setSwapError('Give a reason for taking this reel off the job.');
      return;
    }
    setSwapping(true);
    try {
      await setRemaining({ pendingId, pool: swapPool, stockId: reel._id, remainingKg: remaining, reason: swapReason.trim() });
      onMountedChange(swapPool, null);
      setNote(n => ({ ...n, [swapPool]: null }));
      setVariant(null);
      setSwapPool(null);
    } catch (err) {
      setSwapError(err instanceof ApiError ? err.message : 'Could not update stock.');
    } finally {
      setSwapping(false);
    }
  };

  return (
    <View style={styles.grid}>
      {POOLS.map(({ key, label }, i) => {
        const reel = mounted[key];
        // What the operator has typed into this slot, if anything. The action
        // button doubles as "Add" for a typed Roll ID and "Scan" for the
        // camera, so a reel can always be mounted by hand when the label
        // won't scan -- both paths run the same mountReel/checkMaterial
        // validation, so typing is never a way around the recipe check.
        const typed = (manualInput[key] || '').trim();
        return (
          <View key={key} style={[styles.slot, i < POOLS.length - 1 && styles.slotDivider]}>
            <Text style={styles.slotLabel}>{label}</Text>
            {reel ? (
              <View style={styles.mountedRow}>
                <View style={styles.mountedText}>
                  <Text style={styles.mountedRollId}>{reel.rollId}</Text>
                  <Text style={styles.mountedSub}>
                    {reel.reelMtrs ? `${reel.reelMtrs} ` : ''}
                    {reel.location}
                    {reel.allotted ? '' : ' · not allotted'}
                  </Text>
                </View>
                <TouchableOpacity style={styles.changeButton} onPress={() => openChange(key)}>
                  <Text style={styles.changeButtonText}>Change</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.scanRow}>
                <TextInput
                  style={styles.input}
                  value={manualInput[key]}
                  onChangeText={v => setManualInput(m => ({ ...m, [key]: v }))}
                  onSubmitEditing={() => mountReel(key, manualInput[key])}
                  placeholder="Type Roll ID"
                  placeholderTextColor={colors.textMuted}
                  returnKeyType="done"
                  autoCapitalize="characters"
                  autoCorrect={false}
                />
                <TouchableOpacity
                  style={styles.scanButton}
                  disabled={checking === key}
                  onPress={() =>
                    typed ? mountReel(key, typed) : onScanRequest(key, value => mountReel(key, value))
                  }>
                  {checking === key ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : (
                    <Text style={styles.scanButtonText}>{typed ? 'Add' : 'Scan'}</Text>
                  )}
                </TouchableOpacity>
              </View>
            )}
            {note[key] ? <Text style={styles.noteWarn}>{note[key].title}</Text> : null}
          </View>
        );
      })}

      {/* Which Product Code these three reels actually make. Sits under the
          whole strip rather than one slot because it is a property of the
          combination -- mirrors the web form's own variant toast
          (jobCardForm.ejs renderMountedVariant), but as a line that stays put
          while the reels do, since a toast on the shop floor is missable. */}
      {variant ? (
        <Text style={styles.variantNote}>
          Reel combination produces {variant.productCode}
          {variant.baseProductCode ? ` — variant of ${variant.baseProductCode}` : ''}.
        </Text>
      ) : null}

      {/* Acknowledged with OK, then the operator carries on -- nothing is
          mounted, because the server refused the reel and sent back no reel
          record to mount. OK also empties the slot it came from: a refused id
          left sitting in the field, or a note left under it, reads as though
          the reel might have been taken. The slot goes back to exactly how it
          looked before the attempt, waiting for a different reel. */}
      <AppDialog
        visible={!!dialog}
        tone={dialog?.tone}
        title={dialog?.title}
        message={dialog?.message}
        buttons={[{ label: 'OK', onPress: () => clearSlotAndCloseDialog() }]}
        onRequestClose={clearSlotAndCloseDialog}
      />

      <Modal visible={!!swapPool} transparent animationType="fade" onRequestClose={() => setSwapPool(null)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Take {mounted[swapPool]?.rollId} off the job</Text>
            <Text style={styles.modalLabel}>Kg physically remaining on the reel</Text>
            <TextInput
              style={styles.modalInput}
              value={swapRemaining}
              onChangeText={setSwapRemaining}
              keyboardType="numeric"
              placeholder="0"
            />
            <Text style={styles.modalLabel}>Reason</Text>
            <TextInput
              style={styles.modalInput}
              value={swapReason}
              onChangeText={setSwapReason}
              placeholder="e.g. reel ran out, wrong reel scanned"
            />
            {swapError ? <Text style={styles.modalError}>{swapError}</Text> : null}
            <View style={styles.modalButtons}>
              <Button title="Cancel" variant="danger" onPress={() => setSwapPool(null)} style={styles.modalButtonHalf} />
              <Button title="Confirm" onPress={confirmChange} loading={swapping} style={styles.modalButtonHalf} />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {},
  // Each pool used to be its own white bordered card inside the (already
  // white) "Materials Mounted" card -- a box in a box with no contrast
  // between them, paying a border plus 8px of padding top and bottom three
  // times over. Flat rows with a hairline between them read the same and
  // give that height back to the screen.
  slot: { paddingVertical: spacing.sm },
  slotDivider: { borderBottomWidth: 1, borderBottomColor: colors.borderLight },
  slotLabel: { fontSize: 11, fontWeight: '700', color: colors.textMuted, marginBottom: 4, fontFamily },
  scanRow: { flexDirection: 'row', gap: spacing.sm },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 8,
    fontSize: 14,
    color: colors.textDark,
    fontFamily,
  },
  scanButton: {
    backgroundColor: colors.primary,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    minWidth: 64,
    alignItems: 'center',
  },
  scanButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '600', fontFamily },
  mountedRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  mountedText: { flex: 1 },
  mountedRollId: { fontWeight: '700', color: colors.textDark, fontFamily },
  mountedSub: { fontSize: 11.5, color: colors.textMuted, fontFamily },
  changeButton: {
    borderWidth: 1,
    borderColor: colors.dangerStrong,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  changeButtonText: { color: colors.dangerStrong, fontSize: 11.5, fontWeight: '700', fontFamily },
  noteWarn: { color: colors.warningText, fontSize: 11, marginTop: 4, fontFamily },
  // Not a warning -- producing a variant is a normal outcome, so this reads as
  // information rather than something the operator has done wrong.
  variantNote: {
    color: colors.success,
    fontSize: 11.5,
    fontWeight: '600',
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.borderLight,
    fontFamily,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  modalCard: { width: '100%', maxWidth: 360, backgroundColor: '#FFFFFF', borderRadius: radii.lg, padding: spacing.lg },
  modalTitle: { fontSize: 15, fontWeight: '700', color: colors.textDark, marginBottom: spacing.sm, fontFamily },
  modalLabel: { fontSize: 12, fontWeight: '600', color: colors.textMuted, marginTop: spacing.sm, marginBottom: 4, fontFamily },
  modalInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 8,
    fontSize: 14,
    color: colors.textDark,
    fontFamily,
  },
  modalError: { color: colors.dangerStrong, fontSize: 12, marginTop: spacing.sm, fontFamily },
  modalButtons: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  modalButtonHalf: { flex: 1 },
});
