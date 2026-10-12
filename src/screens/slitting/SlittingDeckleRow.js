import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { colors, radii, spacing, fontFamily } from '../../theme/theme';
import { fmtMtrs } from '../../utils/meters';
import SlittingJointDialog from './SlittingJointDialog';

// The joint / wrinkle a Deckle web can carry is recorded behind a single "Joint"
// button that opens SlittingJointDialog, and what's entered shows as a log line
// underneath -- the slitting counterpart of the lamination card's own "Joint"
// button + log (jobcard/ProductionLogRow.js + JointDialog.js). A Deckle IS one
// web, so there is one defect to record, not the face + release pair.

const formatPunchTime = date => {
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${hours}:${minutes} ${ampm}`;
};

const round2 = n => Math.round(n * 100) / 100;

// The metres this row will book. Deliberately DERIVED from the two counter
// readings and never typed: unlike the lamination card -- where the Deckle's
// length is the operator's own confirmed figure because waste is trimmed off
// each end -- a slit run takes the whole span between the readings, so there
// is nothing left to ask. Same rule as the web card's own sl-row-meter-display.
export const rowMeter = (startMtrs, stopMtrs) => {
  const start = Number(String(startMtrs ?? '').trim());
  const stop = Number(String(stopMtrs ?? '').trim());
  return Number.isFinite(start) && Number.isFinite(stop) && stop > start ? round2(stop - start) : null;
};

// Has this Deckle's adhesive cured? The server sends `cured` as it stood when
// the card loaded; the clock is re-read here too, so a card left open on the
// machine unlocks by itself when the six hours pass rather than needing a
// reload. Hot-melt builds carry no curedAt and are never gated.
export const curedNow = row => {
  const c = row?.curing;
  if (!c || c.hotMelt || c.cured) {
    return true;
  }
  return c.curedAt ? Date.now() >= Date.parse(c.curedAt) : false;
};

// Which of the four states a pending row is in. Drives the tint, the badge and
// which punch is live -- there is no status column spelling it out.
export const rowState = (row, armed) => {
  if (row.status === 'done') {
    return 'done';
  }
  if (row.startTime) {
    return 'running';
  }
  if (!curedNow(row)) {
    return 'curing';
  }
  return armed ? 'armed' : 'pending';
};

// `armed` is the row the scan has confirmed -- and the whole reason this
// screen has a scan strip at all. Until the reel in the operator's hands has
// been read and matched, Start stays locked: a slit run names its finished
// rolls after the physical Deckle it came off, so running the wrong web
// mis-names real stock rather than merely mis-recording a number.
export default function SlittingDeckleRow({
  row,
  index,
  armed,
  draft,
  busy,
  editing,
  onToggleEdit,
  onDraftChange,
  onStart,
  onStop,
}) {
  const state = rowState(row, armed);
  const [jointOpen, setJointOpen] = useState(false);

  // The joint / wrinkle thing, exactly as the coating card does it
  // (jobcard/ProductionLogRow.js): a small "Joint" button in the header opens
  // the dialog, and whatever has been entered SURVIVES as a log line underneath
  // -- a dot, the kind and the metre, with a × to clear it. A Deckle is one web,
  // so there is one entry, not the lamination card's face + release pair. The
  // entry lives on the draft (joint / jointMtr), the same fields Start / Stop /
  // Save already carry, so nothing downstream changes.
  const jointButton = (
    <TouchableOpacity
      style={styles.jointButton}
      onPress={() => setJointOpen(true)}
      accessibilityRole="button"
      accessibilityLabel="Record a joint or wrinkle">
      <Text style={styles.jointButtonText}>Joint</Text>
    </TouchableOpacity>
  );
  const clearJoint = () => {
    onDraftChange('joint', '');
    onDraftChange('jointMtr', '');
  };
  // The one entry, if any, in the shape the log renders -- read from the draft
  // (live / editing) or the saved row (a finished row at rest).
  const jointEntries = (joint, mtr) =>
    (joint || (mtr != null && String(mtr).trim() !== '')
      ? [{ joint, mtr: mtr != null && String(mtr).trim() !== '' ? fmtMtrs(mtr) : '' }]
      : []);
  const jointLog = (entries, removable) =>
    (entries.length ? (
      <View style={styles.jointLog}>
        {entries.map((e, i) => (
          <View key={i} style={styles.jointLogRow}>
            <View style={styles.jointLogDot} />
            <View style={styles.jointLogBody}>
              <Text style={styles.jointLogText} numberOfLines={1}>
                <Text style={styles.jointLogWeb}>{e.joint || '—'}</Text>
                {e.mtr ? ` · ${e.mtr} m` : ''}
              </Text>
            </View>
            {removable ? (
              <TouchableOpacity
                onPress={clearJoint}
                accessibilityRole="button"
                accessibilityLabel="Remove joint"
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                style={styles.jointLogRemove}>
                <Text style={styles.jointLogRemoveText}>×</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ))}
      </View>
    ) : null);
  const renderJointDialog = (bStart, bStop) => (
    <SlittingJointDialog
      visible={jointOpen}
      joint={draft?.joint}
      jointMtr={draft?.jointMtr}
      startMtrs={bStart}
      stopMtrs={bStop}
      onCancel={() => setJointOpen(false)}
      onSubmit={({ joint, jointMtr }) => {
        onDraftChange('joint', joint);
        onDraftChange('jointMtr', jointMtr);
        setJointOpen(false);
      }}
    />
  );

  if (state === 'done') {
    const producedIds = (row.cuts || []).map(c => c.rollId).filter(Boolean);
    return (
      <View style={[styles.row, styles.rowDone]}>
        <View style={styles.headRow}>
          <Text style={styles.rowTitle}>Deckle #{index}</Text>
          <View style={styles.headRight}>
            <Text style={styles.doneMeters}>{fmtMtrs(row.meter)} m</Text>
            {editing ? jointButton : null}
          </View>
        </View>
        <Text style={styles.doneDeckleId} numberOfLines={1}>
          {row.deckleId}
        </Text>
        <View style={styles.donePunchRow}>
          <Text style={styles.donePunchLabel}>Start</Text>
          <Text style={styles.donePunchValue}>
            {row.startMtrs != null ? `${fmtMtrs(row.startMtrs)} m · ` : ''}
            {row.startTime || '—'}
          </Text>
        </View>
        <View style={styles.donePunchRow}>
          <Text style={styles.donePunchLabel}>Stop</Text>
          <Text style={styles.donePunchValue}>
            {row.stopMtrs != null ? `${fmtMtrs(row.stopMtrs)} m · ` : ''}
            {row.endTime || '—'}
          </Text>
        </View>
        {/* The Joint note is the ONLY part of a finished row still open to
            correction -- its metres and its produced roll ids moved stock at
            Stop and are never reopened, here or anywhere else. Same rule as
            the web card's own pencil, and as the lamination card's. */}
        {editing
          ? jointLog(jointEntries(draft?.joint, draft?.jointMtr), true)
          : jointLog(jointEntries(row.joint, row.jointMtr), false)}
        <View style={styles.doneFooter}>
          {/* The same confirmation the lamination card gives a produced
              Deckle, except this one names every finished roll the Stop
              actually made -- which is what the operator sticks a label on. */}
          <Text style={producedIds.length ? styles.noteOk : styles.notePending}>
            {producedIds.length
              ? `✓ ${producedIds.join(', ')} — in Finished Stock`
              : `${(row.cuts || []).length} roll(s) recorded`}
          </Text>
          {onToggleEdit ? (
            <TouchableOpacity onPress={onToggleEdit} style={styles.editButton} disabled={busy}>
              <Text style={styles.editButtonText}>{editing ? 'Save' : 'Edit'}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        {renderJointDialog(row.startMtrs, row.stopMtrs)}
      </View>
    );
  }

  // ---- The row being worked -------------------------------------------
  const running = state === 'running';
  const curing = state === 'curing';
  const startMtrs = running ? String(row.startMtrs ?? draft.startMtrs ?? '') : draft.startMtrs ?? '';
  const meter = rowMeter(running ? row.startMtrs ?? draft.startMtrs : draft.startMtrs, draft.stopMtrs);
  const canPunchStart = state === 'armed' && !!String(startMtrs).trim() && !busy;
  const canPunchStop = running && !!String(draft.stopMtrs ?? '').trim() && meter !== null && !busy;
  // Live reel metres vs. what the plan wants off it. Advisory: the operator
  // can still run it (and the Stop's own check refuses only a reading that
  // asks for more than is physically there).
  const short = row.reelMtrs != null && Number(row.plannedMeter) > Number(row.reelMtrs);

  const BADGE = {
    // No 'pending' badge: a row waiting to be scanned shows no badge at all --
    // the Scan Deckle card above already says what to do, so "Scan this Deckle
    // to unlock Start" on every pending row was just noise.
    curing: {
      icon: 'timer-sand',
      text: `Still curing${row.curing?.curedAtLabel ? ` — ready at ${row.curing.curedAtLabel}` : ''}`,
      style: styles.badgeCuring,
    },
    armed: { icon: 'check-circle', text: 'Confirmed — punch Start when the machine runs', style: styles.badgeArmed },
    running: { icon: 'play-circle', text: `Running since ${row.startTime}`, style: styles.badgeRunning },
  }[state];

  return (
    <View
      style={[
        styles.row,
        state === 'armed' && styles.rowArmed,
        running && styles.rowRunning,
        curing && styles.rowCuring,
      ]}>
      <View style={styles.headRow}>
        <Text style={[styles.rowTitle, !armed && !running && styles.rowTitleMuted]}>Deckle #{index}</Text>
        <View style={styles.headRight}>
          <Text style={styles.plannedMeters}>{fmtMtrs(row.plannedMeter)} m planned</Text>
          {jointButton}
        </View>
      </View>
      <Text style={styles.liveDeckleId} numberOfLines={1}>
        {row.deckleId}
      </Text>

      {BADGE ? (
        <View style={[styles.badge, BADGE.style]}>
          <Icon name={BADGE.icon} size={13} color={BADGE.style.color} />
          <Text style={[styles.badgeText, { color: BADGE.style.color }]}>{BADGE.text}</Text>
        </View>
      ) : null}

      {short ? (
        <Text style={styles.shortNote}>
          {fmtMtrs(row.reelMtrs)} m left on the reel — short of the {fmtMtrs(row.plannedMeter)} m planned.
        </Text>
      ) : null}

      <View style={styles.fieldsRow}>
        <View style={styles.fieldCol}>
          <Text style={styles.fieldLabel}>Mtrs (start)</Text>
          <TextInput
            style={[styles.input, running && row.startMtrs != null && styles.inputDisabled]}
            value={String(startMtrs)}
            onChangeText={v => onDraftChange('startMtrs', v)}
            editable={!(running && row.startMtrs != null)}
            keyboardType="numeric"
            placeholder="0"
            placeholderTextColor={colors.textMuted}
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
            style={[styles.input, !running && styles.inputDisabled]}
            value={String(draft.stopMtrs ?? '')}
            onChangeText={v => onDraftChange('stopMtrs', v)}
            editable={running}
            keyboardType="numeric"
            placeholder="0"
            placeholderTextColor={colors.textMuted}
          />
        </View>
        <View style={styles.fieldCol}>
          <Text style={styles.fieldLabel}>Stop</Text>
          <TouchableOpacity
            style={[styles.punchButton, styles.punchButtonStop, !canPunchStop && styles.punchButtonDisabled]}
            disabled={!canPunchStop}
            onPress={() => onStop(formatPunchTime(new Date()))}>
            <Text style={styles.punchButtonText}>■ Stop</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Read-only on purpose -- see rowMeter above. Shown all the same,
          because it is the figure that comes off the Deckle and goes onto
          every roll this Stop inwards. */}
      <View style={styles.meterRow}>
        <Text style={styles.meterLabel}>METRES RUN</Text>
        <Text style={styles.meterValue}>{meter === null ? '—' : `${fmtMtrs(meter)} m`}</Text>
      </View>

      {jointLog(jointEntries(draft.joint, draft.jointMtr), true)}
      {renderJointDialog(running ? row.startMtrs ?? draft.startMtrs : draft.startMtrs, draft.stopMtrs)}
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
  // Confirmed by the scan: green, the app's own "this matches" tint (the same
  // rowMatchBg the Work Queue uses for a fully-allotted job), and a green
  // border so it reads at arm's length on a machine.
  rowArmed: { backgroundColor: colors.rowMatchBg, borderColor: '#86EFAC' },
  rowRunning: { backgroundColor: colors.noticeBg, borderColor: colors.noticeBorder },
  rowCuring: { backgroundColor: '#FFFBF3' },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  rowTitle: { fontSize: 12.5, fontWeight: '700', color: colors.primary, fontFamily },
  rowTitleMuted: { color: colors.textMuted },
  plannedMeters: { fontSize: 11.5, fontWeight: '600', color: colors.textMuted, fontFamily },
  doneMeters: { fontWeight: '700', color: colors.textDark, fontFamily },
  liveDeckleId: { fontSize: 13.5, fontWeight: '800', color: colors.textDark, marginTop: 2, fontFamily },
  doneDeckleId: { fontSize: 12, fontWeight: '600', color: colors.textMuted, marginTop: 1, fontFamily },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    borderRadius: radii.pill,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    marginTop: spacing.sm,
  },
  badgePending: { backgroundColor: '#FFFFFF', borderColor: colors.border, color: colors.textMuted },
  badgeCuring: { backgroundColor: colors.noticeBg, borderColor: colors.noticeBorder, color: colors.noticeText },
  badgeArmed: { backgroundColor: '#FFFFFF', borderColor: '#86EFAC', color: '#15803D' },
  badgeRunning: { backgroundColor: '#FFFFFF', borderColor: colors.noticeBorder, color: colors.warningText },
  badgeText: { fontSize: 11, fontWeight: '700', fontFamily },
  shortNote: { fontSize: 11, color: colors.dangerStrong, marginTop: 4, fontFamily },
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
  doneFooter: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xs },
  noteOk: { color: '#059669', fontSize: 11.5, fontWeight: '600', flex: 1, fontFamily },
  notePending: { color: '#B45309', fontSize: 11.5, fontWeight: '600', flex: 1, fontFamily },
  editButton: {
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  editButtonText: { color: colors.primary, fontSize: 11.5, fontWeight: '700', fontFamily },
  // The Joint button + log, copied from the coating card (jobcard/
  // ProductionLogRow.js) so the two read identically.
  headRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  jointButton: {
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
  },
  jointButtonText: { color: colors.warningText, fontSize: 12, fontWeight: '700', fontFamily },
  jointLog: { marginTop: spacing.sm, borderLeftWidth: 2, borderLeftColor: colors.noticeBorder, paddingLeft: spacing.sm },
  jointLogRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 3 },
  jointLogDot: { width: 6, height: 6, borderRadius: radii.pill, backgroundColor: colors.warning, flexShrink: 0 },
  jointLogBody: { flex: 1 },
  jointLogText: { fontSize: 12, color: colors.textDark, fontFamily },
  jointLogWeb: { fontWeight: '700', color: colors.warningText },
  jointLogRemove: { width: 28, height: 28, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.headerRowBg },
  jointLogRemoveText: { fontSize: 17, lineHeight: 20, color: colors.textMuted, fontFamily },
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
    backgroundColor: '#FFFFFF',
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
  meterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.borderLight,
  },
  meterLabel: { fontSize: 9.5, fontWeight: '700', letterSpacing: 0.5, color: colors.textMuted, fontFamily },
  meterValue: { fontSize: 16, fontWeight: '800', color: colors.primary, fontFamily },
});
