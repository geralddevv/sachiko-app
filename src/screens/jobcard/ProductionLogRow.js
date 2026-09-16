import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { colors, radii, spacing, fontFamily } from '../../theme/theme';
import JointDialog from './JointDialog';

const formatPunchTime = date => {
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${hours}:${minutes} ${ampm}`;
};

// The joints recorded against a row, as a list to render. The job card stores
// one per web (machineJobCard.js's face / release), so this is at most two
// entries -- but it reads as a log, which is how the operator thinks of it.
function jointEntries(row) {
  return [
    { web: 'face', label: 'Face', joint: row.faceJoint, mtr: row.faceMtr, reason: row.faceJointReason },
    { web: 'release', label: 'Release', joint: row.releaseJoint, mtr: row.releaseMtr, reason: row.releaseJointReason },
  ].filter(e => e.joint || e.mtr);
}

// One Production Log row -- every row is one Deckle. Ported from
// jobCardForm.ejs's createLogRow(): a single LIVE entry (this component with
// locked=false) that, once Stop is punched, freezes into a read-only "done"
// card (locked=true) while a fresh live row is minted -- JobCardScreen owns
// that live/done split and the instant-produce call itself (needs API
// access + row-array mutation), this component only renders and reports
// field edits/punches up. A done row can be reopened with Edit to correct
// its joint/mtr readings (jc-row-edit-btn in the EJS) -- everything except
// `meters`, which is already credited to Semi Finished Stock and is locked
// for good (the EJS's PRODUCTION_LOCKED_SELECTORS rule).
export default function ProductionLogRow({
  row,
  index,
  locked,
  editing,
  onToggleEdit,
  onChange,
  onStart,
  onStop,
}) {
  const [jointOpen, setJointOpen] = useState(false);

  // The dialog reports one web's entry; write it to that web's own pair of
  // fields. Two calls rather than one: onChange is (field, value), and both
  // update paths upstream are functional setState, so the second sees the
  // first.
  const saveJoint = ({ web, kind, mtr, reason }) => {
    onChange(web === 'face' ? 'faceJoint' : 'releaseJoint', kind);
    onChange(web === 'face' ? 'faceMtr' : 'releaseMtr', mtr);
    onChange(web === 'face' ? 'faceJointReason' : 'releaseJointReason', reason);
    setJointOpen(false);
  };

  const clearJoint = web => {
    onChange(web === 'face' ? 'faceJoint' : 'releaseJoint', '');
    onChange(web === 'face' ? 'faceMtr' : 'releaseMtr', '');
    onChange(web === 'face' ? 'faceJointReason' : 'releaseJointReason', '');
  };

  if (locked && !editing) {
    return (
      <View style={[styles.row, styles.rowDone]}>
        {/* Every Production Log row is one deckle, so it's numbered -- the
            same "#" column the web log table leads with (see the thead in
            views/inventory/masters/jobCardForm.ejs). It also gives the
            operator something to refer to ("deckle 2 wrinkled"). The mounted
            reels used to sit here, but they're mounted once for the whole job
            on the Materials Mounted strip and can't differ between rows, so
            repeating them was noise. */}
        <View style={styles.headRow}>
          <Text style={styles.rowTitle}>Deckle #{index}</Text>
          <Text style={styles.doneMeters}>{row.meters} m</Text>
        </View>
        {/* Each punch shows the metre reading it was taken at, the same
            pairing the web log table uses (Mtrs | Start | Mtrs | Stop -- see
            the thead in views/inventory/masters/jobCardForm.ejs). A bare time
            doesn't tell the operator where on the web the deckle started or
            stopped, which is the number they reconcile against. Stacked
            rather than side by side: "1,000 m · 11:26 AM" twice over does not
            fit two columns at 320dp. */}
        <View style={styles.donePunchRow}>
          <Text style={styles.donePunchLabel}>Start</Text>
          <Text style={styles.donePunchValue}>
            {row.startMtrs ? `${row.startMtrs} m · ` : ''}
            {row.startTime || '—'}
          </Text>
        </View>
        <View style={styles.donePunchRow}>
          <Text style={styles.donePunchLabel}>Stop</Text>
          <Text style={styles.donePunchValue}>
            {row.stopMtrs ? `${row.stopMtrs} m · ` : ''}
            {row.endTime || '—'}
          </Text>
        </View>
        {jointEntries(row).map(entry => (
          <Text key={entry.web} style={styles.doneJoint}>
            {entry.label}: {entry.joint || '—'}
            {entry.mtr ? ` · ${entry.mtr} m` : ''}
            {entry.reason ? ` — ${entry.reason}` : ''}
          </Text>
        ))}
        <View style={styles.doneFooter}>
          <Text style={row.producing ? styles.noteBusy : row.deckleId ? styles.noteOk : styles.notePending}>
            {row.producing
              ? 'Moving to Semi Finished Stock…'
              : row.deckleId
              ? `✓ ${row.deckleId}${row.productCode ? ` · ${row.productCode}` : ''}`
              : 'Not moved yet — will be created on Save.'}
          </Text>
          {onToggleEdit && !row.producing ? (
            <TouchableOpacity onPress={onToggleEdit} style={styles.editButton}>
              <Text style={styles.editButtonText}>Edit</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    );
  }

  const canPunchStart = !!String(row.startMtrs ?? '').trim() && !row.startTime;
  const canPunchStop = !!String(row.stopMtrs ?? '').trim() && !row.endTime;

  return (
    <View style={styles.row}>
      {/* Joint sits up here on the deckle's own line rather than as a pair of
          always-on controls further down: most deckles run clean, so the
          entry belongs behind a button and only what was actually recorded
          takes up room (the list under Deckle Meters). */}
      <View style={styles.headRow}>
        <Text style={[styles.rowTitle, styles.rowTitleLive]}>Deckle #{index} · in progress</Text>
        <TouchableOpacity
          style={styles.jointButton}
          onPress={() => setJointOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Record a joint">
          <Text style={styles.jointButtonText}>Joint</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.fieldsRow}>
        <View style={styles.fieldCol}>
          <Text style={styles.fieldLabel}>Mtrs (start)</Text>
          <TextInput
            style={styles.input}
            value={String(row.startMtrs ?? '')}
            onChangeText={v => onChange('startMtrs', v)}
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
            style={styles.input}
            value={String(row.stopMtrs ?? '')}
            onChangeText={v => onChange('stopMtrs', v)}
            keyboardType="numeric"
            placeholder="0"
          />
        </View>
        <View style={styles.fieldCol}>
          <Text style={styles.fieldLabel}>Stop</Text>
          {row.endTime ? (
            <View style={styles.punchedBox}>
              <Text style={styles.punchedText}>{row.endTime}</Text>
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

      <Text style={styles.fieldLabel}>Deckle Meters</Text>
      <TextInput
        style={[styles.input, locked && styles.inputDisabled]}
        value={String(row.meters ?? '')}
        onChangeText={v => onChange('meters', v)}
        editable={!locked}
        keyboardType="numeric"
        placeholder="Metres this Deckle made"
      />
      {locked ? (
        <Text style={styles.lockedNote}>
          Already credited to Semi Finished Stock — metres can't be changed.
        </Text>
      ) : null}

      {/* What's been recorded so far, directly under the metres it refers to.
          Tapping an entry reopens the dialog on that web to correct it. */}
      {jointEntries(row).length ? (
        <View style={styles.jointLog}>
          {jointEntries(row).map(entry => (
            <View key={entry.web} style={styles.jointLogRow}>
              <View style={styles.jointLogDot} />
              {/* Reason on its own line rather than appended: it is free text
                  and can be a sentence, and sharing the line would squeeze out
                  the web and defect kind, which are what identify the entry. */}
              <View style={styles.jointLogBody}>
                <Text style={styles.jointLogText} numberOfLines={1}>
                  <Text style={styles.jointLogWeb}>{entry.label}</Text>
                  {` · ${entry.joint || '—'}`}
                  {entry.mtr ? ` · ${entry.mtr} m` : ''}
                </Text>
                {entry.reason ? (
                  <Text style={styles.jointLogReason} numberOfLines={2}>
                    {entry.reason}
                  </Text>
                ) : null}
              </View>
              <TouchableOpacity
                onPress={() => clearJoint(entry.web)}
                accessibilityRole="button"
                accessibilityLabel={`Remove ${entry.label} joint`}
                // The glyph is small by design, but the target must not be:
                // padding plus hitSlop give it ~48dp square, which is what a
                // gloved thumb on the floor actually needs.
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                style={styles.jointLogRemove}>
                <Text style={styles.jointLogRemoveText}>×</Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      ) : null}

      <JointDialog visible={jointOpen} row={row} onCancel={() => setJointOpen(false)} onSubmit={saveJoint} />

      {locked && editing ? (
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
  rowTitleLive: { color: colors.textMuted, fontWeight: '600', marginBottom: spacing.xs },
  doneMeters: { fontWeight: '700', color: colors.textDark, fontFamily },
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
  donePunchValue: { fontSize: 12.5, fontWeight: '600', color: colors.textDark, fontFamily },
  doneJoint: { fontSize: 11.5, color: colors.textMuted, marginTop: 2, fontFamily },
  noteOk: { color: '#059669', fontSize: 11.5, fontWeight: '600', marginTop: spacing.xs, flex: 1, fontFamily },
  notePending: { color: '#B45309', fontSize: 11.5, fontWeight: '600', marginTop: spacing.xs, flex: 1, fontFamily },
  noteBusy: { color: colors.textMuted, fontSize: 11.5, fontWeight: '600', marginTop: spacing.xs, flex: 1, fontFamily },
  doneFooter: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  editButton: {
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  editButtonText: { color: colors.primary, fontSize: 11.5, fontWeight: '700', fontFamily },
  lockedNote: { color: colors.textMuted, fontSize: 10.5, marginTop: 3, fontFamily },
  inputDisabled: { backgroundColor: '#F3F4F6', color: colors.textMuted },
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
  fieldsRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  fieldCol: { flex: 1 },
  fieldLabel: { fontSize: 10.5, color: colors.textMuted, marginBottom: 2, marginTop: spacing.sm, fontFamily },
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
  jointButton: {
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
  },
  jointButtonText: { color: colors.warningText, fontSize: 12, fontWeight: '700', fontFamily },
  jointLog: {
    marginTop: spacing.sm,
    borderLeftWidth: 2,
    borderLeftColor: colors.noticeBorder,
    paddingLeft: spacing.sm,
  },
  jointLogRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 3 },
  jointLogDot: {
    width: 6,
    height: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.warning,
    flexShrink: 0,
  },
  jointLogBody: { flex: 1 },
  jointLogReason: { fontSize: 11, color: colors.textMuted, marginTop: 1, fontFamily },
  jointLogText: { fontSize: 12, color: colors.textDark, fontFamily },
  jointLogWeb: { fontWeight: '700', color: colors.warningText },
  jointLogRemove: {
    width: 28,
    height: 28,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.headerRowBg,
  },
  jointLogRemoveText: { fontSize: 17, lineHeight: 20, color: colors.textMuted, fontFamily },
});
