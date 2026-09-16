import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { colors, radii, spacing, fontFamily } from './theme';

// A two-plus-option segmented control, styled to the FAIRTECH navy palette --
// the selected segment fills navy, the rest read as quiet pills. Sits under the
// nav bar to switch the screen's content (Work Queue / Maintenance) without a
// navigation push. `options` is [{ key, label, badge? }]; `badge` shows a count.
//
// `showCheck` puts a tick on the selected segment. Off by default -- the tab
// toggle reads clearly from the fill alone, and the tick is only worth its
// width where the choice is being *recorded* rather than navigated, and where
// getting it wrong is expensive (see JointDialog).
export default function SegmentedToggle({ options, value, onChange, showCheck = false }) {
  return (
    <View style={styles.track}>
      {options.map(opt => {
        const active = opt.key === value;
        return (
          <TouchableOpacity
            key={opt.key}
            activeOpacity={0.85}
            style={[styles.segment, active && styles.segmentActive]}
            onPress={() => onChange(opt.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}>
            {showCheck && active ? <Icon name="check-bold" size={15} color="#FFFFFF" /> : null}
            <Text style={[styles.label, active && styles.labelActive]}>{opt.label}</Text>
            {opt.badge ? (
              <View style={[styles.badge, active && styles.badgeActive]}>
                <Text style={[styles.badgeText, active && styles.badgeTextActive]}>{opt.badge}</Text>
              </View>
            ) : null}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    padding: 3,
    gap: 3,
  },
  segment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: spacing.sm,
    borderRadius: radii.sm - 2,
  },
  segmentActive: { backgroundColor: colors.primary },
  label: { fontSize: 13.5, fontWeight: '600', color: colors.primary, fontFamily },
  labelActive: { color: '#FFFFFF' },
  badge: {
    minWidth: 18,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: radii.pill,
    backgroundColor: colors.noticeBg,
    borderWidth: 1,
    borderColor: colors.noticeBorder,
    alignItems: 'center',
  },
  badgeActive: { backgroundColor: 'rgba(255,255,255,0.18)', borderColor: 'rgba(255,255,255,0.4)' },
  badgeText: { fontSize: 11, fontWeight: '700', color: colors.noticeText, fontFamily },
  badgeTextActive: { color: '#FFFFFF' },
});
