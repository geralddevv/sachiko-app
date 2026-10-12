import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Animated, Easing, TouchableOpacity, ActivityIndicator } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radii, spacing, fontFamily } from '../theme/theme';
import { useOffline, isOffline, retryNow } from '../services/connectivity';
import { useOutboxPending } from '../services/outbox';

// The app-wide "the server isn't there" bar. Mounted once beside the navigator
// so it covers every screen, including the ones that have nowhere sensible of
// their own to put the message (the scan modal, the photo capture screen).
//
// It sits at the bottom rather than under the nav bar: at the top it would push
// or cover a screen's own header the moment it appeared, and the state it
// reports is ambient, not something to interrupt for.
export default function OfflineBanner() {
  const insets = useSafeAreaInsets();
  const offline = useOffline();
  // Punches waiting in the outbox (services/outbox.js). They are safe on the
  // tablet and go by themselves on reconnect -- which is what the operator
  // needs to hear, rather than that their work is being lost.
  const waiting = useOutboxPending();
  const [checking, setChecking] = useState(false);
  // Kept mounted through the slide-out so the bar animates away instead of
  // vanishing the instant the server answers again.
  const [visible, setVisible] = useState(isOffline());
  const slide = useRef(new Animated.Value(isOffline() ? 1 : 0)).current;

  useEffect(() => {
    if (offline) {
      setVisible(true);
    }
    const animation = Animated.timing(slide, {
      toValue: offline ? 1 : 0,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished && !offline) {
        setVisible(false);
      }
    });
    return () => animation.stop();
  }, [offline, slide]);

  const onRetry = useCallback(async () => {
    setChecking(true);
    try {
      await retryNow();
    } finally {
      setChecking(false);
    }
  }, []);

  if (!visible) {
    return null;
  }

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.wrap,
        { paddingBottom: insets.bottom + spacing.md },
        {
          opacity: slide,
          transform: [{ translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [90, 0] }) }],
        },
      ]}>
      <View style={styles.bar} accessibilityLiveRegion="polite">
        <Icon name="cloud-off-outline" size={20} color="#FFFFFF" style={styles.icon} />
        <View style={styles.text}>
          <Text style={styles.title}>No connection to the server</Text>
          <Text style={styles.subtitle}>
            {checking
              ? 'Checking…'
              : waiting
              ? `${waiting === 1 ? '1 punch' : `${waiting} punches`} kept on this tablet — sent when it's back`
              : 'Punches are kept on this tablet. Retrying…'}
          </Text>
        </View>
        <TouchableOpacity
          activeOpacity={0.8}
          onPress={onRetry}
          disabled={checking}
          accessibilityRole="button"
          accessibilityLabel="Retry connecting to the server"
          style={styles.retry}>
          {checking ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={styles.retryText}>Retry</Text>
          )}
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.lg,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.dangerStrong,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    // Same soft lift as the dialogs, so it reads as floating over the screen
    // rather than as part of whatever is behind it.
    shadowColor: '#0B1F33',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 14,
    elevation: 8,
  },
  icon: { flexShrink: 0 },
  text: { flex: 1 },
  title: { color: '#FFFFFF', fontSize: 14, fontWeight: '700', fontFamily },
  subtitle: { color: '#FFE4E6', fontSize: 12, marginTop: 2, fontFamily },
  retry: {
    minWidth: 64,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.7)',
  },
  retryText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600', fontFamily },
});
