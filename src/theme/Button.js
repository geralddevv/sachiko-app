import React from 'react';
import { TouchableOpacity, View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { colors, radii, spacing, fontFamily } from './theme';

const VARIANT_COLORS = {
  primary: colors.primary,
  success: colors.success,
  danger: colors.danger,
  // A job on hold: the slate the office's WIP tab shows "Paused" in, so the
  // button that lifts the hold looks like the state it ends.
  hold: colors.hold,
};

// A single button component covering the three recurring action colors on
// the web app: navy primary actions, green "start"/go actions, red "stop"
// actions (see theme.js for where each hex comes from), plus an `outline`
// variant for the secondary half of a two-button row -- same navy, but hollow,
// so it can't compete with the filled action beside it.
//
// `icon` is a MaterialCommunityIcons name (the same set HeaderBar's own icon
// buttons draw from). Deliberately a real vector glyph and not a character
// typed into the title: emoji and geometric symbols render at whatever weight
// and baseline the platform font happens to give them, which is exactly what
// makes a button look improvised on one device and wrong on the next.
// `size="sm"` is the same button drawn a step smaller -- for a pair sharing
// one row, where two full-size halves read as chunkier than the single
// full-width action they replace. Everything scales together (height, padding,
// label, icon) so a small button is the same shape, not a squashed one.
export default function Button({
  title,
  icon,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled,
  loading,
  style,
}) {
  const outline = variant === 'outline';
  const small = size === 'sm';
  const tint = disabled ? colors.disabled : VARIANT_COLORS[variant] || colors.primary;
  const contentColor = outline ? tint : '#FFFFFF';
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: !!(disabled || loading), busy: !!loading }}
      style={[
        styles.button,
        small && styles.buttonSm,
        outline ? [styles.outline, { borderColor: tint }] : { backgroundColor: tint },
        style,
      ]}>
      {loading ? (
        <ActivityIndicator color={contentColor} size="small" />
      ) : (
        <View style={[styles.content, small && styles.contentSm]}>
          {icon ? <Icon name={icon} size={small ? 15 : 17} color={contentColor} /> : null}
          <Text
            style={[styles.label, small && styles.labelSm, { color: contentColor }]}
            numberOfLines={1}>
            {title}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: {
    borderRadius: radii.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    // A fixed floor rather than padding alone, so a filled button and a
    // hollow one (whose 1.5px border eats into its own box) sit at exactly
    // the same height when they share a row.
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Still a comfortable glove-sized target: 40dp clears Android's own 40dp
  // minimum for a touch target with a label, so this stays shopfloor-usable.
  buttonSm: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    minHeight: 40,
  },
  outline: {
    backgroundColor: colors.cardBg,
    borderWidth: 1.5,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  contentSm: { gap: spacing.xs + 2 },
  label: {
    fontWeight: '600',
    fontSize: 15,
    letterSpacing: 0.2,
    fontFamily,
  },
  labelSm: { fontSize: 13.5 },
});
