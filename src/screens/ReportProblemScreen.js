import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Image,
  Modal,
  FlatList,
  PermissionsAndroid,
  Platform,
} from 'react-native';
import { launchCamera, launchImageLibrary } from 'react-native-image-picker';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { colors, radii, spacing, fontFamily } from '../theme/theme';
import HeaderBar from '../theme/HeaderBar';
import Button from '../theme/Button';
import AppDialog from '../theme/AppDialog';
import MediaChoiceDialog from './maintenance/MediaChoiceDialog';
import VoiceMessageField from './maintenance/VoiceMessageField';
import { voiceRecordingSupported } from '../utils/voiceRecorder';
import { getMaintenance, postMaintenance } from '../services/api';
import { MAX_MAINTENANCE_VIDEO_SECONDS, trimVideoIfNeeded } from '../utils/videoTrim';

const NOT_SURE = { _id: '', machineName: 'Not sure / not listed' };

// The report-a-problem form: an optional photo and/or video, which machine, and
// a description. Mirrors operatorMaintenance.ejs's "Report a Problem" dialog --
// a description alone is a valid ticket (both attachments optional).
//
// "Add a photo or video" opens MediaChoiceDialog, which offers three ways in:
//   - Take a photo   -> the in-app camera (MaintenancePhoto screen)
//   - Record a video -> the system camera in video mode (launchCamera)
//   - Upload         -> the device gallery (launchImageLibrary)
// The gallery is narrowed to whichever slot is still free (a ticket carries at
// most one photo and one video, matching the server's `photo` / `video`
// fields), and a picked clip is routed to the video slot by its mime type.
export default function ReportProblemScreen({ navigation, route }) {
  const [machines, setMachines] = useState(route.params?.machines || []);
  const [machineId, setMachineId] = useState(route.params?.defaultMachineId || '');
  const [description, setDescription] = useState('');
  const [photo, setPhoto] = useState(null); // { uri, name, type }
  const [video, setVideo] = useState(null); // { uri, name, type }
  const [voice, setVoice] = useState(null); // { uri, name, type, durationMs } -- a recorded voice message
  const [pickerOpen, setPickerOpen] = useState(false);
  const [mediaChoiceOpen, setMediaChoiceOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // In-app themed dialog in place of RN's Alert.alert -- see theme/AppDialog.js
  // for why. { tone, title, message, buttons }
  const [dialog, setDialog] = useState(null);

  // If opened without a machine list (not passed through, or tapped before the
  // list screen had loaded), fetch it. An operator with genuinely no machines
  // at their location just gets an empty list here and the "Not sure" fallback.
  useEffect(() => {
    if (route.params?.machines?.length) {
      return;
    }
    let alive = true;
    (async () => {
      try {
        const data = await getMaintenance();
        if (!alive) {
          return;
        }
        setMachines(data.machines || []);
        setMachineId(prev => prev || data.defaultMachineId || '');
      } catch {
        // Non-fatal: the picker just falls back to "Not sure / not listed".
      }
    })();
    return () => {
      alive = false;
    };
  }, [route.params?.machines]);

  // The photo capture screen hands its result back as a route param.
  useEffect(() => {
    const captured = route.params?.capturedPhoto;
    if (captured?.uri) {
      setPhoto(captured);
      navigation.setParams({ capturedPhoto: undefined });
    }
  }, [route.params?.capturedPhoto, navigation]);

  const options = [NOT_SURE, ...machines];
  const selectedName = options.find(m => m._id === machineId)?.machineName || NOT_SURE.machineName;

  // Record a clip by handing off to the phone's system camera app. Our manifest
  // declares CAMERA, so on Android that permission must be granted at runtime
  // before launchCamera or it fails silently; the OS camera app owns the actual
  // recording (and its own mic access), so no RECORD_AUDIO is needed here.
  const recordVideo = useCallback(async () => {
    try {
      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA, {
          title: 'Camera Permission',
          message: 'Sachiko needs camera access to record a video of the problem.',
          buttonPositive: 'Allow',
        });
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          setDialog({
            tone: 'warning',
            title: 'Camera needed',
            message: 'Camera permission is required to record a video.',
          });
          return;
        }
      }
      const result = await launchCamera({
        mediaType: 'video',
        videoQuality: 'high',
        durationLimit: MAX_MAINTENANCE_VIDEO_SECONDS,
        saveToPhotos: false,
      });
      if (result.didCancel) {
        return;
      }
      if (result.errorCode) {
        setDialog({
          tone: 'error',
          title: 'Could not record',
          message: result.errorMessage || 'Please try again.',
        });
        return;
      }
      const asset = result.assets?.[0];
      if (asset?.uri) {
        setVideo({ uri: asset.uri, name: asset.fileName || 'video.mp4', type: asset.type || 'video/mp4' });
      }
    } catch (err) {
      setDialog({ tone: 'error', title: 'Could not record', message: err.message || 'Please try again.' });
    }
  }, []);

  // Pick an existing photo or video from the device gallery. launchImageLibrary
  // uses the Android photo picker / iOS PHPicker, so it needs no storage
  // permission and no manifest change. The gallery is narrowed to whichever
  // slot is still free, and a picked file is sorted into photo vs video by its
  // reported mime type (with a filename-extension fallback for the platforms
  // that leave `type` blank on videos).
  const pickFromGallery = useCallback(async () => {
    const wantPhoto = !photo;
    const wantVideo = !video;
    const mediaType = wantPhoto && wantVideo ? 'mixed' : wantVideo ? 'video' : 'photo';
    try {
      const result = await launchImageLibrary({
        mediaType,
        selectionLimit: 1,
        videoQuality: 'high',
      });
      if (result.didCancel) {
        return;
      }
      if (result.errorCode) {
        setDialog({
          tone: 'error',
          title: 'Could not open gallery',
          message: result.errorMessage || 'Please try again.',
        });
        return;
      }
      const asset = result.assets?.[0];
      if (!asset?.uri) {
        return;
      }
      const isVideo =
        (asset.type || '').startsWith('video') ||
        /\.(mp4|mov|m4v|3gp|mkv|avi|webm)$/i.test(asset.fileName || asset.uri || '');
      if (isVideo) {
        // Unlike launchCamera's durationLimit, the gallery picker doesn't cap
        // clip length -- an already-recorded video can be any length, so it's
        // trimmed down to the same limit after picking instead. A trim
        // failure shouldn't lose the pick entirely, so it falls back to the
        // untrimmed file with a warning rather than the "could not open
        // gallery" error below.
        let uri = asset.uri;
        try {
          uri = await trimVideoIfNeeded(asset.uri, asset.duration);
        } catch (trimErr) {
          setDialog({
            tone: 'warning',
            title: 'Could not trim video',
            message: `This clip is longer than ${MAX_MAINTENANCE_VIDEO_SECONDS}s and couldn't be trimmed automatically. It will be attached at its full length.`,
          });
        }
        setVideo({ uri, name: asset.fileName || 'video.mp4', type: asset.type || 'video/mp4' });
      } else {
        setPhoto({ uri: asset.uri, name: asset.fileName || 'photo.jpg', type: asset.type || 'image/jpeg' });
      }
    } catch (err) {
      setDialog({ tone: 'error', title: 'Could not open gallery', message: err.message || 'Please try again.' });
    }
  }, [photo, video]);

  // The chooser closes first, then the camera / gallery / photo screen opens a
  // beat later -- launching straight into another native surface while this
  // Modal is still dismissing can leave the picker stranded behind it.
  const handleMediaChoice = useCallback(action => {
    setMediaChoiceOpen(false);
    setTimeout(action, 250);
  }, []);

  const onSubmit = useCallback(async () => {
    const desc = description.trim();
    // A voice message can stand in for the typed description.
    if (!desc && !voice) {
      setDialog({
        tone: 'warning',
        title: 'Describe the problem',
        message: 'Please describe the problem or record a voice message before submitting.',
      });
      return;
    }
    setSubmitting(true);
    try {
      const res = await postMaintenance({
        description: desc,
        machineId: machineId || undefined,
        photo,
        video,
        audio: voice,
      });
      setDialog({
        tone: 'success',
        title: 'Issue reported',
        message: `Ticket ${res.ticketNo} has been sent to the office.`,
        buttons: [{ label: 'OK', onPress: () => { setDialog(null); navigation.goBack(); } }],
      });
    } catch (err) {
      setDialog({ tone: 'error', title: 'Could not report', message: err.message || 'Please try again.' });
      setSubmitting(false);
    }
  }, [description, machineId, photo, video, voice, navigation]);

  return (
    <View style={styles.container}>
      <KeyboardAwareScrollView
        contentContainerStyle={styles.content}
        enableOnAndroid
        keyboardShouldPersistTaps="handled"
        extraScrollHeight={spacing.xl}>
        <HeaderBar title="Report a Problem" />

        <Text style={styles.label}>Show the problem</Text>

        {photo ? (
          <View style={styles.previewWrap}>
            <Image source={{ uri: photo.uri }} style={styles.preview} resizeMode="cover" />
            <TouchableOpacity
              style={styles.clearBtn}
              onPress={() => setPhoto(null)}
              accessibilityLabel="Remove photo">
              <Icon name="close" size={18} color="#FFFFFF" />
            </TouchableOpacity>
          </View>
        ) : null}

        {video ? (
          <View style={styles.previewWrap}>
            <View style={styles.videoPreview}>
              <Icon name="video" size={30} color={colors.primary} />
              <Text style={styles.videoPreviewText}>Video added</Text>
            </View>
            <TouchableOpacity
              style={styles.clearBtn}
              onPress={() => setVideo(null)}
              accessibilityLabel="Remove video">
              <Icon name="close" size={18} color="#FFFFFF" />
            </TouchableOpacity>
          </View>
        ) : null}

        {!photo || !video ? (
          <>
            <TouchableOpacity
              style={styles.captureDrop}
              activeOpacity={0.8}
              onPress={() => setMediaChoiceOpen(true)}>
              <Icon name="camera-plus-outline" size={24} color={colors.primary} />
              <Text style={styles.captureText}>Add a photo or video</Text>
            </TouchableOpacity>
            <Text style={styles.captureHint}>
              Optional — take a photo, record a video, or upload from your gallery
            </Text>
          </>
        ) : null}

        <Text style={[styles.label, styles.labelSpaced]}>Machine</Text>
        <TouchableOpacity style={styles.select} activeOpacity={0.8} onPress={() => setPickerOpen(true)}>
          <Text style={styles.selectText}>{selectedName}</Text>
          <Icon name="chevron-down" size={20} color={colors.textMuted} />
        </TouchableOpacity>

        {voiceRecordingSupported ? (
          <>
            <Text style={[styles.label, styles.labelSpaced]}>Voice message</Text>
            <VoiceMessageField
              value={voice}
              onChange={setVoice}
              disabled={submitting}
              onError={(title, message) => setDialog({ tone: 'error', title, message })}
            />
          </>
        ) : null}

        <Text style={[styles.label, styles.labelSpaced]}>What is the problem?</Text>
        <TextInput
          style={styles.textArea}
          value={description}
          onChangeText={setDescription}
          multiline
          maxLength={1000}
          numberOfLines={4}
          placeholder={
            voice
              ? 'Optional — your voice message is attached'
              : 'Describe the problem — what happened, what part, when it started...'
          }
          placeholderTextColor={colors.textMuted}
          textAlignVertical="top"
        />
        <Text style={styles.counter}>{description.length}/1000</Text>

        <Button
          title={submitting ? 'Sending…' : 'Submit'}
          onPress={onSubmit}
          disabled={submitting || (!description.trim() && !voice)}
          loading={submitting}
          style={styles.submit}
        />
      </KeyboardAwareScrollView>

      <Modal visible={pickerOpen} transparent animationType="fade" onRequestClose={() => setPickerOpen(false)}>
        <TouchableOpacity style={styles.pickerBackdrop} activeOpacity={1} onPress={() => setPickerOpen(false)}>
          <View style={styles.pickerSheet}>
            <Text style={styles.pickerTitle}>Machine</Text>
            <FlatList
              data={options}
              keyExtractor={item => item._id || 'none'}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.pickerRow}
                  onPress={() => {
                    setMachineId(item._id);
                    setPickerOpen(false);
                  }}>
                  <Text style={[styles.pickerRowText, item._id === machineId && styles.pickerRowActive]}>
                    {item.machineName}
                  </Text>
                  {item._id === machineId ? <Icon name="check" size={18} color={colors.primary} /> : null}
                </TouchableOpacity>
              )}
            />
          </View>
        </TouchableOpacity>
      </Modal>

      <MediaChoiceDialog
        visible={mediaChoiceOpen}
        onClose={() => setMediaChoiceOpen(false)}
        showPhoto={!photo}
        showRecord={!video}
        onTakePhoto={() => handleMediaChoice(() => navigation.navigate('MaintenancePhoto'))}
        onRecordVideo={() => handleMediaChoice(recordVideo)}
        onUpload={() => handleMediaChoice(pickFromGallery)}
      />

      <AppDialog
        visible={!!dialog}
        tone={dialog?.tone}
        title={dialog?.title}
        message={dialog?.message}
        buttons={dialog?.buttons}
        onRequestClose={() => setDialog(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingBottom: spacing.xl },
  label: { fontSize: 12.5, fontWeight: '700', color: colors.primary, marginBottom: spacing.sm, marginTop: spacing.md, fontFamily },
  labelSpaced: { marginTop: spacing.lg },
  captureDrop: {
    flexDirection: 'row',
    borderWidth: 2,
    borderColor: colors.border,
    borderStyle: 'dashed',
    borderRadius: radii.md,
    backgroundColor: colors.headerRowBg,
    paddingVertical: spacing.lg,
    gap: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  captureText: { color: colors.primary, fontWeight: '700', fontSize: 13, fontFamily },
  captureHint: { color: colors.textMuted, fontSize: 11.5, marginTop: spacing.sm, fontFamily },
  previewWrap: { position: 'relative', marginBottom: spacing.md },
  preview: { width: '100%', height: 220, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border },
  videoPreview: {
    width: '100%',
    height: 96,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.headerRowBg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  videoPreviewText: { color: colors.primary, fontWeight: '700', fontSize: 13.5, fontFamily },
  clearBtn: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    width: 30,
    height: 30,
    borderRadius: radii.pill,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  select: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.cardBg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  selectText: { color: colors.textDark, fontSize: 14, fontFamily },
  textArea: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    padding: spacing.md,
    minHeight: 110,
    backgroundColor: colors.cardBg,
    color: colors.textDark,
    fontSize: 14,
    fontFamily,
  },
  counter: { alignSelf: 'flex-end', color: colors.textMuted, fontSize: 11.5, marginTop: 4, fontFamily },
  submit: { marginTop: spacing.lg },
  pickerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  pickerSheet: {
    backgroundColor: colors.cardBg,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    maxHeight: '60%',
  },
  pickerTitle: { fontSize: 13, fontWeight: '700', color: colors.primary, marginBottom: spacing.sm, fontFamily },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  pickerRowText: { color: colors.textDark, fontSize: 14, fontFamily },
  pickerRowActive: { color: colors.primary, fontWeight: '700' },
});
