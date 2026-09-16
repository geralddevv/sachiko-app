import React from 'react';
import { View, Text, Modal, StyleSheet, TouchableOpacity } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { colors, radii, spacing, fontFamily } from '../../theme/theme';

// The "add a photo or video" chooser for a maintenance ticket. A custom card
// rather than the OS action sheet, so it sits on the same navy-on-white
// backdrop and card as theme/AppDialog and reads as part of this app.
//
// Three ways to attach media, each its own row:
//   Take a photo   -> the in-app camera (MaintenancePhoto screen)
//   Record a video -> the system camera in video mode (launchCamera)
//   Upload         -> the device gallery (launchImageLibrary)
//
// `showPhoto` / `showRecord` drop the capture rows whose slot is already
// filled -- a ticket carries at most one photo and one video, matching the web
// form and the server's `photo` / `video` fields. Upload stays offered while
// the dialog is open; the caller narrows what the gallery shows to the free
// slot.
export default function MediaChoiceDialog({
  visible,
  onClose,
  onTakePhoto,
  onRecordVideo,
  onUpload,
  showPhoto = true,
  showRecord = true,
}) {
  const options = [];
  if (showPhoto) {
    options.push({
      key: 'photo',
      icon: 'camera',
      title: 'Take a photo',
      subtitle: 'Use the camera now',
      onPress: onTakePhoto,
    });
  }
  if (showRecord) {
    options.push({
      key: 'record',
      icon: 'video',
      title: 'Record a video',
      subtitle: 'Up to 60 seconds',
      onPress: onRecordVideo,
    });
  }
  options.push({
    key: 'upload',
    icon: 'image-multiple',
    title: 'Upload from gallery',
    subtitle: 'Choose a photo or video already on this device',
    onPress: onUpload,
  });

  return (
    <Modal visible={!!visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Add a photo or video</Text>

          <View style={styles.optionList}>
            {options.map(opt => (
              <TouchableOpacity
                key={opt.key}
                activeOpacity={0.85}
                style={styles.option}
                onPress={opt.onPress}>
                <View style={styles.optionIcon}>
                  <Icon name={opt.icon} size={22} color={colors.primary} />
                </View>
                <View style={styles.optionText}>
                  <Text style={styles.optionTitle}>{opt.title}</Text>
                  <Text style={styles.optionSubtitle}>{opt.subtitle}</Text>
                </View>
                <Icon name="chevron-right" size={20} color={colors.textMuted} />
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity activeOpacity={0.85} style={styles.cancel} onPress={onClose}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
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
    shadowColor: '#0B1F33',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 20,
    elevation: 6,
  },
  title: {
    fontSize: 16.5,
    fontWeight: '700',
    color: colors.textDark,
    fontFamily,
  },
  optionList: { marginTop: spacing.md, gap: spacing.sm },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.headerRowBg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  optionIcon: {
    width: 40,
    height: 40,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.cardBg,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  optionText: { flex: 1 },
  optionTitle: { fontSize: 14, fontWeight: '700', color: colors.textDark, fontFamily },
  optionSubtitle: { fontSize: 11.5, color: colors.textMuted, marginTop: 2, fontFamily },
  cancel: {
    marginTop: spacing.md,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#FFFFFF',
    paddingVertical: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: { color: colors.textDark, fontWeight: '600', fontSize: 15, fontFamily },
});
