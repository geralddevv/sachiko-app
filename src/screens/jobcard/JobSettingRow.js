import React from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { colors, radii, spacing, fontFamily } from '../../theme/theme';

const formatPunchTime = date => {
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${hours}:${minutes} ${ampm}`;
};

// One Job Setting (setup wastage) row -- ported from jobCardForm.ejs's
// createJsRow(). The roll ids are still snapshotted onto the row the moment
// Start is punched (JobCardScreen's applyMounted, which the saved job card
// reads) -- they're just no longer PRINTED here: reels are mounted once for
// the whole job, so naming them on every row said nothing the Materials strip
// hadn't. Once Start and Stop are both punched the row collapses to a
// read-only summary with an Edit button, the same shape as a done Production
// Log row. Mtrs (start) is always editable; Start
// unlocks on it having a value AND every raw-material reel this order's
// recipe calls for being mounted (`materialsReady`). The server schema still
// leaves fs/ad/rl optional, but punching Start here freezes whatever is
// mounted into those fields, so starting with nothing mounted would record a
// blank material trace for the row.
export default function JobSettingRow({
  row,
  index,
  materialsReady = false,
  editing,
  onToggleEdit,
  onChange,
  onRemove,
  onStart,
  onStop,
}) {
  const done = !!(row.startTime && row.stopTime);
  const canPunchStart = !!String(row.mtrs1 ?? '').trim() && !row.startTime && materialsReady;
  const canEditMtrs2 = !!row.startTime;
  const canPunchStop = !!String(row.mtrs2 ?? '').trim() && !row.stopTime;

  // Finished: both punches in. Collapses to the same read-only summary a done
  // Production Log row uses -- metre reading paired with the time it was taken
  // at -- reopened with Edit, which sits bottom-right the way the log row's
  // own Edit does.
  if (done && !editing) {
    return (
      <View style={[styles.row, styles.rowDone]}>
        <Text style={styles.rowTitle}>Setting #{index}</Text>
        <View style={styles.donePunchRow}>
          <Text style={styles.donePunchLabel}>Start</Text>
          <Text style={styles.donePunchValue}>
            {String(row.mtrs1 ?? '').trim() ? `${row.mtrs1} m · ` : ''}
            {row.startTime}
          </Text>
        </View>
        <View style={[styles.donePunchRow, styles.donePunchRowAction]}>
          <Text style={styles.donePunchLabel}>Stop</Text>
          <Text style={styles.donePunchValue}>
            {String(row.mtrs2 ?? '').trim() ? `${row.mtrs2} m · ` : ''}
            {row.stopTime}
          </Text>
          {onToggleEdit ? (
            <TouchableOpacity style={styles.editButton} onPress={onToggleEdit}>
              <Text style={styles.editButtonText}>Edit</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.row}>
      <View style={styles.headRow}>
        <Text style={styles.rowTitle}>Setting #{index}</Text>
        {onRemove ? (
          <TouchableOpacity style={styles.removeButton} onPress={onRemove}>
            <Text style={styles.removeButtonText}>✕</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <View style={styles.fieldsRow}>
        <View style={styles.fieldCol}>
          <Text style={styles.fieldLabel}>Mtrs (start)</Text>
          <TextInput
            style={styles.input}
            value={String(row.mtrs1 ?? '')}
            onChangeText={v => onChange('mtrs1', v)}
            keyboardType="numeric"
            placeholder="0"
          />
        </View>
        <View style={styles.fieldCol}>
          <Text style={styles.fieldLabel}>Start</Text>
          {row.startTime ? (
            <View style={styles.punchedBox}>
              <Text style={styles.punchedText}>{row.startTime}</Text>
            </View>
          ) : (
            <TouchableOpacity
              style={[styles.punchButton, !canPunchStart && styles.punchButtonDisabled]}
              disabled={!canPunchStart}
              onPress={() => onStart(formatPunchTime(new Date()))}>
              <Text style={styles.punchButtonText}>▶ Start</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      <View style={styles.fieldsRow}>
        <View style={styles.fieldCol}>
          <Text style={styles.fieldLabel}>Mtrs (stop)</Text>
          <TextInput
            style={[styles.input, !canEditMtrs2 && styles.inputDisabled]}
            value={String(row.mtrs2 ?? '')}
            onChangeText={v => onChange('mtrs2', v)}
            editable={canEditMtrs2}
            keyboardType="numeric"
            placeholder="0"
          />
        </View>
        <View style={styles.fieldCol}>
          <Text style={styles.fieldLabel}>Stop</Text>
          {row.stopTime ? (
            <View style={styles.punchedBox}>
              <Text style={styles.punchedText}>{row.stopTime}</Text>
            </View>
          ) : (
            <TouchableOpacity
              style={[styles.punchButton, styles.punchButtonStop, !canPunchStop && styles.punchButtonDisabled]}
              disabled={!canPunchStop}
              onPress={() => onStop(formatPunchTime(new Date()))}>
              <Text style={styles.punchButtonText}>■ Stop</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {editing ? (
        <TouchableOpacity style={styles.doneEditButton} onPress={onToggleEdit}>
          <Text style={styles.doneEditButtonText}>Done editing</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radii.sm,
    padding: spacing.sm,
    marginBottom: spacing.sm,
    backgroundColor: '#FFFFFF',
  },
  rowDone: { backgroundColor: colors.headerRowBg },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowTitle: { fontSize: 12.5, fontWeight: '700', color: colors.primary, fontFamily },
  donePunchRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, marginTop: 3 },
  donePunchLabel: {
    fontSize: 9.5,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: colors.textMuted,
    width: 32,
    fontFamily,
  },
  donePunchValue: { flex: 1, fontSize: 12.5, fontWeight: '600', color: colors.textDark, fontFamily },
  // The row that carries Edit centres instead of sitting on the text baseline
  // -- a bordered button has no useful baseline to align to.
  donePunchRowAction: { alignItems: 'center' },
  editButton: {
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  editButtonText: { color: colors.primary, fontSize: 11.5, fontWeight: '700', fontFamily },
  doneEditButton: {
    alignSelf: 'flex-start',
    marginTop: spacing.md,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  doneEditButtonText: { color: colors.primary, fontSize: 12, fontWeight: '700', fontFamily },
  removeButton: { padding: 6 },
  removeButtonText: { color: colors.dangerStrong, fontSize: 16, fontFamily },
  fieldsRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  fieldCol: { flex: 1 },
  fieldLabel: { fontSize: 10.5, color: colors.textMuted, marginBottom: 2, fontFamily },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    fontSize: 14,
    color: colors.textDark,
    fontFamily,
  },
  inputDisabled: { backgroundColor: '#F3F4F6', color: colors.textMuted },
  punchButton: {
    backgroundColor: colors.success,
    borderRadius: radii.sm,
    paddingVertical: 8,
    alignItems: 'center',
  },
  punchButtonStop: { backgroundColor: colors.danger },
  punchButtonDisabled: { backgroundColor: '#9CA3AF' },
  punchButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700', fontFamily },
  punchedBox: {
    backgroundColor: '#F3F4F6',
    borderRadius: radii.sm,
    paddingVertical: 8,
    alignItems: 'center',
  },
  punchedText: { color: colors.textDark, fontSize: 12, fontWeight: '600', fontFamily },
});
