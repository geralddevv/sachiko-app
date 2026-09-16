import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, View, Text, StyleSheet, TouchableWithoutFeedback } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { colors, radii, spacing, fontFamily } from './theme';

// The app's own toast, for the short "that reading can't be right" corrections
// an operator makes mid-run. Built here rather than pulled in as a dependency
// or taken from RN's ToastAndroid: ToastAndroid is Android-only (this app
// ships an ios/ target too) and renders the platform's own grey pill, which
// reads as a different product next to these navy-on-white cards -- the same
// reason theme/AppDialog.js exists instead of Alert.alert.
//
// A toast, not a dialog, on purpose: a rejected punch needs the operator to
// fix a number and punch again, not to acknowledge a modal with a spare hand
// while the machine runs. Anything the operator must ACT on still gets
// AppDialog.
const TONE = {
  error: { icon: 'alert-circle', color: '#FCA5A5' },
  warning: { icon: 'alert', color: colors.noticeBorder },
  success: { icon: 'check-circle', color: '#86EFAC' },
  info: { icon: 'information', color: '#93C5FD' },
};

// Toast state for one screen. `showToast(message, tone)` puts one up (a second
// call replaces whatever is showing and restarts its timer), and the component
// clears itself.
export function useToast() {
  const [toast, setToast] = useState(null);
  const showToast = useCallback(
    (message, tone = 'error') => setToast({ message, tone }),
    [],
  );
  const hideToast = useCallback(() => setToast(null), []);
  return { toast, showToast, hideToast };
}

export default function Toast({ toast, onHide, duration = 3600 }) {
  const anim = useRef(new Animated.Value(0)).current;
  // Held in a ref so an inline `onHide={() => ...}` from a caller can't
  // re-run the effect on every render and restart the dismiss timer forever.
  const onHideRef = useRef(onHide);
  onHideRef.current = onHide;

  useEffect(() => {
    if (!toast) {
      return undefined;
    }
    anim.setValue(0);
    Animated.timing(anim, { toValue: 1, duration: 160, useNativeDriver: true }).start();
    const timer = setTimeout(() => {
      Animated.timing(anim, { toValue: 0, duration: 180, useNativeDriver: true }).start(
        ({ finished }) => {
          if (finished && onHideRef.current) {
            onHideRef.current();
          }
        },
      );
    }, duration);
    return () => clearTimeout(timer);
  }, [toast, duration, anim]);

  if (!toast) {
    return null;
  }
  const t = TONE[toast.tone] || TONE.error;

  return (
    // box-none so the toast never swallows a tap meant for the row underneath
    // -- only the card itself is touchable, and only to dismiss early.
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.wrap,
        {
          opacity: anim,
          transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
        },
      ]}>
      <TouchableWithoutFeedback onPress={() => onHideRef.current && onHideRef.current()}>
        <View style={styles.card} accessibilityRole="alert" accessibilityLiveRegion="polite">
          <Icon name={t.icon} size={19} color={t.color} />
          <Text style={styles.text}>{toast.message}</Text>
        </View>
      </TouchableWithoutFeedback>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.xl,
    alignItems: 'center',
  },
  // Dark card rather than the page's own white: a toast has to read as
  // something laid OVER the form, not as another panel in it.
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    maxWidth: 480,
    backgroundColor: colors.textDark,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    shadowColor: '#0B1F33',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.28,
    shadowRadius: 16,
    elevation: 8,
  },
  text: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 18,
    fontFamily,
  },
});
