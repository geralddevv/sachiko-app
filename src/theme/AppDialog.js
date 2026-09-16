import React from 'react';
import { View, Text, Modal, StyleSheet, TouchableOpacity } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { colors, radii, spacing, fontFamily } from './theme';

// The app's own dialog, in place of RN's Alert.alert -- that renders the
// platform's Material dialog (grey card, teal text, system font), which reads
// as a different product next to this app's navy-on-white cards. Same shape as
// the Materials Mounted "Change" modal so every dialog in the app matches.
//
// `tone` picks the accent + icon: 'success' | 'error' | 'warning' | 'info'.
// `buttons` is [{ label, variant, onPress }] -- variant matches theme/Button
// ('primary' | 'success' | 'danger'), and a button with no onPress just closes.
const TONE = {
  success: { icon: 'check-circle', color: '#059669', bg: colors.rowMatchBg, border: '#86EFAC' },
  error: { icon: 'alert-circle', color: colors.dangerStrong, bg: colors.rowShortBg, border: '#FCA5A5' },
  warning: { icon: 'alert', color: colors.noticeText, bg: colors.noticeBg, border: colors.noticeBorder },
  info: { icon: 'information', color: colors.primary, bg: colors.infoPanelBg, border: colors.border },
};

export default function AppDialog({
  visible,
  tone = 'info',
  title,
  message,
  buttons = [{ label: 'OK' }],
  onRequestClose,
}) {
  const t = TONE[tone] || TONE.info;

  return (
    <Modal visible={!!visible} transparent animationType="fade" onRequestClose={onRequestClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          {/* Icon beside the text rather than stacked above it: a centred
              column costs a whole row of height for the icon plus its margin,
              which on a 320dp phone pushes the buttons toward the fold. */}
          <View style={styles.headRow}>
            <View style={[styles.iconWrap, { backgroundColor: t.bg, borderColor: t.border }]}>
              <Icon name={t.icon} size={22} color={t.color} />
            </View>
            <View style={styles.headText}>
              {title ? <Text style={styles.title}>{title}</Text> : null}
              {message ? <Text style={styles.message}>{message}</Text> : null}
            </View>
          </View>

          <View style={styles.buttonRow}>
            {buttons.map((b, i) => {
              const isPrimary = (b.variant || 'primary') === 'primary';
              const isDanger = b.variant === 'danger';
              return (
                <TouchableOpacity
                  key={b.label || i}
                  activeOpacity={0.85}
                  onPress={() => {
                    if (b.onPress) {
                      b.onPress();
                    } else if (onRequestClose) {
                      onRequestClose();
                    }
                  }}
                  style={[
                    styles.button,
                    buttons.length > 1 && styles.buttonFlex,
                    isPrimary && styles.buttonPrimary,
                    isDanger && styles.buttonDanger,
                    !isPrimary && !isDanger && styles.buttonGhost,
                  ]}>
                  <Text
                    style={[
                      styles.buttonText,
                      !isPrimary && !isDanger && styles.buttonGhostText,
                    ]}>
                    {b.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
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
    padding: spacing.xl,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: colors.cardBg,
    borderRadius: radii.lg,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg,
    alignItems: 'stretch',
    // Same soft lift as the login card.
    shadowColor: '#0B1F33',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 20,
    elevation: 6,
  },
  headRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  headText: { flex: 1 },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: radii.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  title: {
    fontSize: 16.5,
    fontWeight: '700',
    color: colors.textDark,
    textAlign: 'left',
    fontFamily,
  },
  message: {
    fontSize: 13.5,
    color: colors.textMuted,
    textAlign: 'left',
    marginTop: spacing.xs,
    lineHeight: 19,
    fontFamily,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.lg,
    alignSelf: 'stretch',
  },
  button: {
    borderRadius: radii.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
  },
  buttonFlex: { flex: 1 },
  buttonPrimary: { backgroundColor: colors.primary },
  buttonDanger: { backgroundColor: colors.danger },
  buttonGhost: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: colors.border,
  },
  buttonText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 15,
    fontFamily,
  },
  buttonGhostText: { color: colors.textDark },
});
