import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { colors, radii, spacing, fontFamily } from '../../theme/theme';

// Scan (or type) the Deckle actually on the machine. This is the slitting
// card's equivalent of the lamination card's Materials Mounted strip, and it
// exists for the same reason: a run names real stock after the reel it came
// off, so the reel has to be identified before the clock can be punched.
//
// The payload is handed UP raw. A printed Deckle label's QR is the whole
// sticker run together with the Roll ID last (see utils/rollId.js), and only
// the card -- which knows its own allocated ids, and can fall back to the
// server's own reel lookup for a swapped-in web -- can say where the id
// starts. So the strip collects, the screen resolves.
export default function ScanDeckleStrip({ status, busy, confirmed, confirmedId, onSubmit, onScanRequest, onRescan }) {
  const [typed, setTyped] = useState('');

  const submit = () => {
    const value = typed.trim();
    if (!value) {
      return;
    }
    setTyped('');
    onSubmit(value);
  };

  // Once a Deckle is confirmed the scan is DONE until it has been run -- so the
  // input and Scan button give way to the confirmed id sitting in the field
  // with a Change button on its right, exactly the way the lamination card's
  // Materials Mounted strip shows a mounted reel (mountedRow/changeButton).
  // Leaving the live scan box up beside the confirmation read as "it didn't
  // take, scan again", which is the confusion this removes. Change hands back
  // to the scan input (onRescan) so a different web can be run.
  if (confirmed) {
    return (
      <View style={styles.mountedRow}>
        <View style={styles.mountedText}>
          <Text style={styles.mountedRollId}>{confirmedId}</Text>
          <Text style={styles.mountedSub}>Confirmed — punch Start when the machine runs</Text>
        </View>
        <TouchableOpacity style={styles.changeButton} disabled={busy} onPress={onRescan}>
          <Text style={styles.changeButtonText}>Change</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View>
      <View style={styles.scanRow}>
        <TextInput
          style={styles.input}
          value={typed}
          onChangeText={setTyped}
          onSubmitEditing={submit}
          placeholder="Scan or type the Deckle ID"
          placeholderTextColor={colors.textMuted}
          returnKeyType="done"
          autoCapitalize="characters"
          autoCorrect={false}
          editable={!busy}
        />
        <TouchableOpacity
          style={styles.scanButton}
          disabled={busy}
          onPress={() => (typed.trim() ? submit() : onScanRequest())}>
          {busy ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={styles.scanButtonText}>{typed.trim() ? 'Add' : 'Scan'}</Text>
          )}
        </TouchableOpacity>
      </View>
      {status ? (
        <Text
          style={[
            styles.status,
            status.tone === 'ok' && styles.statusOk,
            status.tone === 'bad' && styles.statusBad,
          ]}>
          {status.message}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
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
  status: { fontSize: 12, fontWeight: '600', color: colors.textMuted, marginTop: spacing.sm, fontFamily },
  statusOk: { color: '#15803D' },
  statusBad: { color: colors.dangerStrong },
  // The confirmed state -- the id in the field with a Change button on the
  // right. Same layout and the same styles as the lamination card's Materials
  // Mounted strip (mountedRow/changeButton), so the two cards read alike.
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
});
