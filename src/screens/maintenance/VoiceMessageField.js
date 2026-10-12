import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { colors, radii, spacing, fontFamily } from '../../theme/theme';
import VoicePlayer from './VoicePlayer';
import {
  MAX_VOICE_SECONDS,
  MIN_VOICE_MS,
  ensureMicPermission,
  startVoiceRecording,
  stopVoiceRecording,
  cancelVoiceRecording,
  onVoiceAutoStopped,
  formatClock,
} from '../../utils/voiceRecorder';

// "Record a voice message" for people who can't (or would rather not) type.
// Three states: idle (a big record button), recording (live timer counting up
// to the 30s cap, stop button), recorded (play it back, delete / re-record).
//
// `value` is the recorded message { uri, name, type, durationMs } or null;
// `onChange` receives a new one or null; `onError(title, message)` surfaces a
// problem through the parent's dialog.
export default function VoiceMessageField({ value, onChange, onError, disabled }) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0); // seconds, for the live timer
  const startedAtRef = useRef(0);
  const busyRef = useRef(false); // guards double taps while start/stop are in flight
  const recordingRef = useRef(false);

  const finish = useCallback(async () => {
    if (!recordingRef.current || busyRef.current) {
      return;
    }
    busyRef.current = true;
    recordingRef.current = false;
    setRecording(false);
    try {
      const res = await stopVoiceRecording();
      if (res.durationMs < MIN_VOICE_MS) {
        onError('Too short', 'The message was too short. Hold on a little longer and speak, then tap stop.');
        return;
      }
      onChange({
        uri: res.uri,
        name: res.name,
        type: res.type,
        durationMs: Math.min(res.durationMs, MAX_VOICE_SECONDS * 1000),
      });
    } catch (err) {
      onError('Could not save recording', err.message || 'Please try again.');
    } finally {
      busyRef.current = false;
    }
  }, [onChange, onError]);

  const begin = useCallback(async () => {
    if (busyRef.current || recordingRef.current) {
      return;
    }
    busyRef.current = true;
    try {
      if (!(await ensureMicPermission())) {
        onError('Microphone needed', 'Microphone permission is required to record a voice message.');
        return;
      }
      await startVoiceRecording();
      startedAtRef.current = Date.now();
      recordingRef.current = true;
      setElapsed(0);
      setRecording(true);
    } catch (err) {
      onError('Could not record', err.message || 'Please try again.');
    } finally {
      busyRef.current = false;
    }
  }, [onError]);

  // Live timer while recording.
  useEffect(() => {
    if (!recording) {
      return undefined;
    }
    const id = setInterval(() => {
      setElapsed(Math.min(MAX_VOICE_SECONDS, (Date.now() - startedAtRef.current) / 1000));
    }, 200);
    return () => clearInterval(id);
  }, [recording]);

  // The native recorder stops itself at the 30s cap; finish up when it says so.
  useEffect(() => onVoiceAutoStopped(finish), [finish]);

  // Leaving the screen mid-recording must not leave the mic open.
  useEffect(
    () => () => {
      if (recordingRef.current) {
        recordingRef.current = false;
        cancelVoiceRecording();
      }
    },
    [],
  );

  const remove = useCallback(() => {
    cancelVoiceRecording();
    onChange(null);
  }, [onChange]);

  if (recording) {
    return (
      <View style={[styles.box, styles.boxRecording]}>
        <View style={styles.recRow}>
          <View style={styles.dot} />
          <Text style={styles.recTime}>
            {formatClock(elapsed)} / {formatClock(MAX_VOICE_SECONDS)}
          </Text>
        </View>
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${(elapsed / MAX_VOICE_SECONDS) * 100}%` }]} />
        </View>
        <TouchableOpacity style={styles.stopBtn} onPress={finish} accessibilityLabel="Stop recording">
          <Icon name="stop" size={22} color="#FFFFFF" />
          <Text style={styles.stopText}>Stop</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (value) {
    return (
      <View>
        <VoicePlayer source={{ uri: value.uri }} durationSec={value.durationMs / 1000} />
        <View style={styles.actions}>
          <TouchableOpacity style={styles.linkBtn} onPress={remove} disabled={disabled}>
            <Icon name="delete-outline" size={18} color={colors.textMuted} />
            <Text style={styles.linkText}>Delete</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.linkBtn}
            onPress={() => {
              remove();
              begin();
            }}
            disabled={disabled}>
            <Icon name="microphone" size={18} color={colors.primary} />
            <Text style={[styles.linkText, { color: colors.primary }]}>Record again</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <>
      <TouchableOpacity style={styles.drop} activeOpacity={0.8} onPress={begin} disabled={disabled}>
        <Icon name="microphone" size={24} color={colors.primary} />
        <Text style={styles.dropText}>Record a voice message</Text>
      </TouchableOpacity>
      <Text style={styles.hint}>Can't type? Tap and speak — up to {MAX_VOICE_SECONDS} seconds</Text>
    </>
  );
}

const styles = StyleSheet.create({
  drop: {
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
  dropText: { color: colors.primary, fontWeight: '700', fontSize: 13, fontFamily },
  hint: { color: colors.textMuted, fontSize: 11.5, marginTop: spacing.sm, fontFamily },
  box: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.headerRowBg,
    padding: spacing.md,
    gap: spacing.md,
  },
  boxRecording: { borderColor: '#FCA5A5', backgroundColor: '#FEF2F2' },
  recRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dot: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#DC2626' },
  recTime: { fontSize: 20, fontWeight: '700', color: colors.textDark, fontFamily },
  track: { height: 6, borderRadius: 3, backgroundColor: '#FECACA', overflow: 'hidden' },
  fill: { height: 6, backgroundColor: '#DC2626' },
  stopBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: '#DC2626',
    borderRadius: radii.md,
    paddingVertical: spacing.md,
  },
  stopText: { color: '#FFFFFF', fontWeight: '700', fontSize: 14, fontFamily },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.lg, marginTop: spacing.sm },
  linkBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4 },
  linkText: { color: colors.textMuted, fontSize: 12.5, fontWeight: '600', fontFamily },
});
