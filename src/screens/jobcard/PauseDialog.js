import React from 'react';
import { View, Text, Modal, StyleSheet, TouchableOpacity, Pressable, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { colors, radii, spacing, fontFamily } from '../../theme/theme';
import { BREAK_MINUTES } from '../../services/overtimeReminder';

// Why the job is going on hold. The reason is what the office reads beside
// "Paused" on its WIP tab, so it is a short fixed list -- one tap, no typing
// with gloves on -- and picking one IS the confirmation: there is no second
// "Pause" button to press after it.
export const PAUSE_REASONS = [
  { label: 'Tea Break', icon: 'coffee' },
  { label: 'Lunch Break', icon: 'silverware-fork-knife' },
  { label: 'Leaving Early', icon: 'exit-run' },
  { label: 'End of Shift', icon: 'clock-check-outline' },
  { label: 'Awaiting Material', icon: 'package-variant' },
  { label: 'Machine Issue', icon: 'wrench' },
  { label: 'Other', icon: 'dots-horizontal' },
];

// A sheet that rises from the bottom of the screen. Tapping outside it, or
// Android's back, closes it without pausing.
export default function PauseDialog({ visible, onPause, onCancel }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={!!visible} transparent animationType="slide" onRequestClose={onCancel} statusBarTranslucent>
      <View style={styles.backdrop}>
        <Pressable style={styles.dismiss} onPress={onCancel} accessibilityLabel="Close without pausing" />
        <View style={[styles.sheet, { paddingBottom: spacing.lg + insets.bottom }]}>
          <View style={styles.grabber} />
          <View style={styles.headRow}>
            <View style={styles.iconWrap}>
              <Icon name="pause" size={22} color={colors.primary} />
            </View>
            <View style={styles.headText}>
              <Text style={styles.title}>Pause this job</Text>
              <Text style={styles.message}>
                Select a reason. All entries so far are saved, and the office will see the job on hold until you
                resume. Tea and lunch breaks sound an alarm when the time is up.
              </Text>
            </View>
          </View>

          <ScrollView style={styles.reasonsScroll} showsVerticalScrollIndicator={false}>
            <View style={styles.reasons}>
              {PAUSE_REASONS.map(reason => (
                <TouchableOpacity
                  key={reason.label}
                  activeOpacity={0.85}
                  onPress={() => onPause(reason.label)}
                  accessibilityRole="button"
                  accessibilityLabel={`Pause: ${reason.label}`}
                  style={styles.reason}>
                  <View style={styles.reasonIcon}>
                    <Icon name={reason.icon} size={19} color={colors.primary} />
                  </View>
                  <Text style={styles.reasonText}>{reason.label}</Text>
                  {BREAK_MINUTES[reason.label] ? (
                    <View style={styles.minutes}>
                      <Icon name="alarm" size={13} color={colors.primary} />
                      <Text style={styles.minutesText}>{BREAK_MINUTES[reason.label]} min</Text>
                    </View>
                  ) : null}
                  <Icon name="chevron-right" size={20} color={colors.textMuted} />
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>

          <TouchableOpacity activeOpacity={0.85} onPress={onCancel} style={styles.cancel}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(11,31,51,0.55)', justifyContent: 'flex-end', alignItems: 'center' },
  dismiss: { ...StyleSheet.absoluteFillObject },
  sheet: {
    width: '100%',
    maxWidth: 480,
    maxHeight: '88%',
    backgroundColor: colors.cardBg,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    shadowColor: '#0B1F33',
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.18,
    shadowRadius: 16,
    elevation: 12,
  },
  grabber: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginBottom: spacing.md,
  },
  headRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  headText: { flex: 1 },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.infoPanelBg,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  title: { fontSize: 16.5, fontWeight: '700', color: colors.textDark, fontFamily },
  message: { fontSize: 13.5, color: colors.textMuted, marginTop: spacing.xs, lineHeight: 19, fontFamily },
  reasonsScroll: { flexGrow: 0, marginTop: spacing.lg },
  reasons: { gap: spacing.sm },
  reason: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    backgroundColor: '#FFFFFF',
  },
  reasonIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.headerRowBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  minutes: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 3,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.pill,
    backgroundColor: colors.infoPanelBg,
  },
  minutesText: { fontSize: 12, fontWeight: '700', color: colors.primary, fontFamily },
  reasonText: { flex: 1, fontSize: 15, fontWeight: '600', color: colors.textDark, fontFamily },
  cancel: { marginTop: spacing.md, alignItems: 'center', paddingVertical: spacing.md },
  cancelText: { fontSize: 15, fontWeight: '600', color: colors.textMuted, fontFamily },
});
