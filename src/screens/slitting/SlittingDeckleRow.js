import React from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { colors, radii, spacing, fontFamily } from '../../theme/theme';
import { fmtMtrs } from '../../utils/meters';

// The two defect kinds a Deckle web can carry, same pair the web slitting card
// offers (slittingJobCardForm.ejs's jointOptionHtml) -- one list, not the
// lamination card's two, because a Deckle IS a single web rather than a
// facestock + release laminate.
const JOINT_KINDS = [
  { key: '', label: 'None' },
  { key: 'Joint', label: 'Joint' },
  { key: 'Wrinkle', label: 'Wrinkle' },
];

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

  if (state === 'done') {
    const producedIds = (row.cuts || []).map(c => c.rollId).filter(Boolean);
    return (
      <View style={[styles.row, styles.rowDone]}>
        <View style={styles.headRow}>
          <Text style={styles.rowTitle}>Deckle #{index}</Text>
          <Text style={styles.doneMeters}>{fmtMtrs(row.meter)} m</Text>
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
        {editing ? (
          <View style={styles.jointEditor}>
            <Text style={styles.fieldLabel}>Joint</Text>
            <View style={styles.chipRow}>
              {JOINT_KINDS.map(kind => {
                const active = (draft.joint || '') === kind.key;
                return (
                  <TouchableOpacity
                    key={kind.key || 'none'}
                    style={[styles.chip, active && styles.chipActive]}
                    onPress={() => onDraftChange('joint', kind.key)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: active }}>
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{kind.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {draft.joint ? (
              <TextInput
                style={[styles.input, styles.jointMtrInput]}
                value={String(draft.jointMtr ?? '')}
                onChangeText={v => onDraftChange('jointMtr', v)}
                keyboardType="numeric"
                placeholder="Counter reading the joint ran at"
                placeholderTextColor={colors.textMuted}
              />
            ) : null}
          </View>
        ) : row.joint ? (
          <Text style={styles.doneJoint}>
            {row.joint}
            {row.jointMtr != null && row.jointMtr !== '' ? ` · ${fmtMtrs(row.jointMtr)} m` : ''}
          </Text>
        ) : null}
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
    pending: { icon: 'barcode-scan', text: 'Scan this Deckle to unlock Start', style: styles.badgePending },
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
        <Text style={styles.plannedMeters}>{fmtMtrs(row.plannedMeter)} m planned</Text>
      </View>
      <Text style={styles.liveDeckleId} numberOfLines={1}>
        {row.deckleId}
      </Text>

      <View style={[styles.badge, BADGE.style]}>
        <Icon name={BADGE.icon} size={13} color={BADGE.style.color} />
        <Text style={[styles.badgeText, { color: BADGE.style.color }]}>{BADGE.text}</Text>
      </View>

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

      <Text style={styles.fieldLabel}>Joint</Text>
      <View style={styles.chipRow}>
        {JOINT_KINDS.map(kind => {
          const active = (draft.joint || '') === kind.key;
          return (
            <TouchableOpacity
              key={kind.key || 'none'}
              style={[styles.chip, active && styles.chipActive]}
              onPress={() => onDraftChange('joint', kind.key)}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}>
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{kind.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      {draft.joint ? (
        <TextInput
          style={[styles.input, styles.jointMtrInput]}
          value={String(draft.jointMtr ?? '')}
          onChangeText={v => onDraftChange('jointMtr', v)}
          keyboardType="numeric"
          placeholder="Counter reading the joint ran at"
          placeholderTextColor={colors.textMuted}
        />
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
  jointEditor: { marginTop: spacing.sm },
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
  jointMtrInput: { marginTop: spacing.xs },
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
  chipRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    backgroundColor: '#FFFFFF',
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { fontSize: 12, fontWeight: '600', color: colors.primary, fontFamily },
  chipTextActive: { color: '#FFFFFF' },
});
