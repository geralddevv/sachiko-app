import React, { useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated, Easing } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { colors, radii, spacing, fontFamily } from './theme';

// Mirrors the web app's `.ap-card` pattern: a white card with a navy title
// bar, used for the job card's read-only info panel and allotted-rolls list.
// `collapsible` turns the navy title bar into a tappable dropdown header --
// the caller owns the open/closed state so it survives re-renders and can be
// driven from elsewhere. `headerRight` is a short summary (e.g. "3 reels")
// shown next to the chevron, so a collapsed card still says what it holds.
// Non-collapsible cards render exactly as before.
export default function Card({ title, children, style, collapsible = false, open = true, onToggle, headerRight }) {
  // One chevron that rotates rather than two swapped glyphs -- the turn is
  // what tells the eye the section moved, and a static icon swap reads as a
  // flicker. Hooks run for every Card; they're inert unless `collapsible`.
  const spin = useRef(new Animated.Value(open ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(spin, {
      toValue: open ? 1 : 0,
      duration: 180,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [open, spin]);
  const chevronSpin = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] });

  const header = title ? (
    <>
      <Text style={styles.title}>{title}</Text>
      {collapsible ? (
        <View style={styles.titleRight}>
          {headerRight ? <Text style={styles.titleMeta}>{headerRight}</Text> : null}
          <Animated.View style={[styles.chevron, { transform: [{ rotate: chevronSpin }] }]}>
            <Icon name="chevron-down" size={20} color="#FFFFFF" />
          </Animated.View>
        </View>
      ) : null}
    </>
  ) : null;

  return (
    <View style={[styles.card, style]}>
      {header ? (
        collapsible ? (
          <TouchableOpacity
            style={styles.titleBar}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            onPress={onToggle}>
            {header}
          </TouchableOpacity>
        ) : (
          <View style={styles.titleBar}>{header}</View>
        )
      ) : null}
      {!collapsible || open ? <View style={styles.body}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.cardBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    overflow: 'hidden',
  },
  titleBar: {
    backgroundColor: colors.primary,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    // Row + space-between is a no-op for the single-child (non-collapsible)
    // case, so existing cards are untouched.
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  titleRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  titleMeta: { color: 'rgba(255,255,255,0.8)', fontSize: 11.5, fontWeight: '600', fontFamily },
  chevron: { alignItems: 'center', justifyContent: 'center' },
  title: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 13,
    fontFamily,
  },
  body: {
    padding: spacing.md,
  },
});
