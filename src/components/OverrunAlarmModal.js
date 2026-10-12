import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  Modal,
  TextInput,
  TouchableOpacity,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  ScrollView,
  Platform,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { colors, radii, spacing, fontFamily } from '../theme/theme';
import { subscribeOvertime, answerOvertime, silenceAlert, overMinutes } from '../services/overtimeReminder';

// The in-app half of the overtime reminder (services/overtimeReminder.js): a red,
// attention-getting card when a running Deckle has gone past its expected time,
// asking -- optionally -- why. Loud to look at, but easy to wave away: "Not now",
// tapping the dimmed area, or Back all just close it, and once answered either
// way it is not shown again for that run of that Deckle. The remark, if any,
// appears on the office's WIP page.
export default function OverrunAlarmModal() {
  const [alerts, setAlerts] = useState([]);
  const [remark, setRemark] = useState('');

  useEffect(() => subscribeOvertime(setAlerts), []);

  const alert = alerts[0] || null;
  const alertKey = alert ? alert.key : '';

  // A fresh, empty box for each reminder.
  useEffect(() => {
    setRemark('');
  }, [alertKey]);

  if (!alert) {
    return null;
  }

  if (alert.kind === 'break') {
    return <BreakOverCard alert={alert} more={alerts.length - 1} />;
  }

  const dismiss = () => answerOvertime(alert, '');
  const send = () => answerOvertime(alert, remark);
  const deckle = alert.deckleId
    ? `Deckle ${alert.deckleIndex} (${alert.deckleId})`
    : alert.deckleIndex
    ? `Deckle ${alert.deckleIndex}`
    : 'This Deckle';

  return (
    <Modal visible transparent animationType="fade" onRequestClose={dismiss}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.backdrop}>
          {/* The dimmed area behind the card: tapping it is the same as "Not now".
              A sibling UNDER the card, so taps inside the card never reach it. */}
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={dismiss}
            accessibilityLabel="Not now"
          />
          <View style={styles.card}>
            <View style={styles.iconWrap}>
              <Icon name="alarm-light" size={40} color="#FFFFFF" />
            </View>
            <Text style={styles.title}>Taking longer than expected</Text>
            <Text style={styles.subtitle}>
              This Deckle has run past its expected time.
            </Text>

            <ScrollView
              style={styles.scroll}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
              bounces={false}
            >
              <View style={styles.item}>
                <Text style={styles.machine}>
                  {alert.machineName || 'Machine'}
                </Text>
                <Text style={styles.job}>
                  {alert.jobLabel} · {deckle}
                </Text>
                <Text style={styles.over}>{overMinutes(alert)} min over</Text>
              </View>

              <Text style={styles.label}>Why was it late? (optional)</Text>
              <TextInput
                style={styles.input}
                value={remark}
                onChangeText={setRemark}
                onFocus={() => silenceAlert(alert)}
                multiline
                maxLength={300}
                placeholder="e.g. reel changed, machine stopped, waiting for material…"
                placeholderTextColor={colors.textMuted}
                textAlignVertical="top"
              />
            </ScrollView>

            <TouchableOpacity
              style={styles.silenceBtn}
              activeOpacity={0.85}
              onPress={() => silenceAlert(alert)}
              accessibilityLabel="Silence the alarm"
            >
              <Icon name="volume-off" size={20} color="#FFFFFF" />
              <Text style={styles.silenceText}>Silence alarm</Text>
            </TouchableOpacity>

            <View style={styles.row}>
              <TouchableOpacity
                style={[styles.btn, styles.btnGhost]}
                activeOpacity={0.85}
                onPress={dismiss}
              >
                <Text style={styles.btnGhostText}>Not now</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.btn,
                  styles.btnPrimary,
                  !remark.trim() && styles.btnDisabled,
                ]}
                activeOpacity={0.85}
                disabled={!remark.trim()}
                onPress={send}
              >
                <Text style={styles.btnPrimaryText}>Send remark</Text>
              </TouchableOpacity>
            </View>
            {alerts.length > 1 ? (
              <Text style={styles.more}>
                {alerts.length - 1} more after this
              </Text>
            ) : null}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// "Break is over": no question to answer, just the alarm and one button.
function BreakOverCard({ alert, more }) {
  const ok = () => answerOvertime(alert, '');
  const job = [alert.machineName, alert.jobLabel].filter(Boolean).join(' · ');
  return (
    <Modal visible transparent animationType="fade" onRequestClose={ok}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.iconWrap}>
            <Icon name="alarm" size={40} color="#FFFFFF" />
          </View>
          <Text style={styles.title}>Break is over</Text>
          <Text style={styles.subtitle}>
            Your {alert.reason || 'break'} ({alert.minutes} min) has ended.
          </Text>
          <View style={[styles.item, styles.breakItem]}>
            {job ? <Text style={styles.job}>{job}</Text> : null}
            <Text style={styles.over}>{overMinutes(alert)} min ago</Text>
            <Text style={styles.job}>Please resume work — open this job and tap Resume.</Text>
          </View>
          <TouchableOpacity
            style={[styles.btn, styles.btnPrimary, styles.breakBtn]}
            activeOpacity={0.85}
            onPress={ok}
            accessibilityLabel="OK, silence the alarm"
          >
            <Text style={styles.btnPrimaryText}>OK</Text>
          </TouchableOpacity>
          {more > 0 ? <Text style={styles.more}>{more} more after this</Text> : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  silenceBtn: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
    paddingVertical: 14,
    borderRadius: radii.md,
    backgroundColor: '#7F1D1D',
  },
  silenceText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800', fontFamily },
  breakItem: { alignSelf: 'stretch', marginTop: spacing.md },
  breakBtn: { alignSelf: 'stretch', flex: 0, marginTop: spacing.md },
  flex: { flex: 1 },
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    backgroundColor: 'rgba(127,29,29,0.72)',
  },
  card: {
    width: '100%',
    maxWidth: 400,
    maxHeight: '92%',
    backgroundColor: colors.cardBg,
    borderRadius: radii.lg,
    padding: spacing.lg,
    alignItems: 'center',
    borderWidth: 3,
    borderColor: '#DC2626',
    marginTop: 36,
  },
  iconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#DC2626',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -50,
  },
  title: {
    fontSize: 19,
    fontWeight: '800',
    color: '#991B1B',
    textAlign: 'center',
    marginTop: spacing.md,
    fontFamily,
  },
  subtitle: {
    fontSize: 13,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: 4,
    fontFamily,
  },
  scroll: { alignSelf: 'stretch', flexGrow: 0, marginTop: spacing.md },
  scrollContent: { paddingBottom: 4 },
  item: {
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FECACA',
  },
  machine: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.textDark,
    fontFamily,
  },
  job: { fontSize: 12.5, color: colors.textDark, marginTop: 2, fontFamily },
  over: {
    fontSize: 14,
    fontWeight: '800',
    color: '#B91C1C',
    marginTop: 4,
    fontFamily,
  },
  label: {
    fontSize: 12.5,
    fontWeight: '700',
    color: '#991B1B',
    marginTop: spacing.lg,
    marginBottom: 6,
    fontFamily,
  },
  input: {
    minHeight: 50,
    maxHeight: 96,
    borderWidth: 1,
    borderColor: '#FECACA',
    borderRadius: radii.sm,
    padding: spacing.md,
    fontSize: 14,
    color: colors.textDark,
    backgroundColor: colors.cardBg,
    fontFamily,
  },
  row: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  btn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    paddingVertical: 14,
  },
  btnGhost: { borderWidth: 1.5, borderColor: '#DC2626' },
  btnGhostText: {
    color: '#B91C1C',
    fontSize: 15,
    fontWeight: '700',
    fontFamily,
  },
  btnPrimary: { backgroundColor: '#DC2626' },
  btnPrimaryText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
    fontFamily,
  },
  btnDisabled: { backgroundColor: '#FCA5A5' },
  more: {
    textAlign: 'center',
    color: colors.textMuted,
    fontSize: 11.5,
    marginTop: spacing.sm,
    fontFamily,
  },
});
