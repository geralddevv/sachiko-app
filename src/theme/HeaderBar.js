import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { colors, radii, spacing, fontFamily } from './theme';

// Mirrors the web app's `.indi-head` navy pill header bar (tableDisp.css) --
// used everywhere there (queue title, job card title, etc.), reused here for
// visual consistency across screens.
export default function HeaderBar({ title, subtitle, right }) {
  return (
    <View style={styles.bar}>
      <View style={styles.textGroup}>
        <Text style={styles.title}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
      {right ? <View style={styles.right}>{right}</View> : null}
    </View>
  );
}

export function CountPill({ count }) {
  return (
    <View style={styles.pill}>
      <Text style={styles.pillText}>{count}</Text>
    </View>
  );
}

// Icon button for the header bar (settings/logout etc.), styled as a
// circular touch target matching CountPill's translucent-white treatment.
export function HeaderIconButton({ icon, onPress, accessibilityLabel }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      style={styles.iconButton}>
      <Icon name={icon} size={18} color="#FFFFFF" />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  bar: {
    width: '100%',
    borderRadius: radii.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.primary,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  textGroup: {
    flexShrink: 1,
  },
  title: {
    margin: 0,
    fontSize: 18,
    fontWeight: '600',
    color: '#FFFFFF',
    fontFamily,
  },
  subtitle: {
    marginTop: 2,
    fontSize: 12,
    color: 'rgba(255,255,255,0.85)',
    fontFamily,
  },
  right: {
    marginLeft: spacing.sm,
  },
  pill: {
    borderRadius: radii.pill,
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  pillText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '600',
    fontFamily,
  },
  iconButton: {
    width: 30,
    height: 30,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
