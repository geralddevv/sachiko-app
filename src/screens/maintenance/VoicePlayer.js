import React, { useState, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import Video from 'react-native-video';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { colors, radii, spacing, fontFamily } from '../../theme/theme';
import { formatClock } from '../../utils/voiceRecorder';

// Play / pause for one voice message. react-native-video does the audio (it is
// already a dependency for ticket videos); the player view is 1x1 and hidden,
// since there is nothing to see. `source` is a { uri } -- a local file for a
// message that has just been recorded, the media URL for one on a ticket.
// `onDark` flips the colours for use on the dark full-screen viewer.
export default function VoicePlayer({ source, durationSec, onDark = false, autoPlay = false }) {
  const [playing, setPlaying] = useState(autoPlay);
  const [position, setPosition] = useState(0);
  const [failed, setFailed] = useState(false);
  const videoRef = useRef(null);

  const toggle = useCallback(() => {
    setFailed(false);
    setPlaying(p => !p);
  }, []);

  const fg = onDark ? '#FFFFFF' : colors.primary;
  const total = durationSec || 0;
  const progress = total > 0 ? Math.min(1, position / total) : 0;

  return (
    <View style={[styles.row, onDark && styles.rowDark]}>
      <TouchableOpacity
        style={[styles.playBtn, { backgroundColor: onDark ? '#FFFFFF' : colors.primary }]}
        onPress={toggle}
        accessibilityLabel={playing ? 'Pause voice message' : 'Play voice message'}>
        <Icon name={playing ? 'pause' : 'play'} size={24} color={onDark ? colors.primary : '#FFFFFF'} />
      </TouchableOpacity>
      <View style={styles.mid}>
        <View style={[styles.track, onDark && styles.trackDark]}>
          <View style={[styles.fill, { width: `${progress * 100}%`, backgroundColor: fg }]} />
        </View>
        <Text style={[styles.time, { color: onDark ? '#FFFFFF' : colors.textMuted }]}>
          {failed ? 'Could not play this message' : `${formatClock(position)} / ${formatClock(total)}`}
        </Text>
      </View>
      <Video
        ref={videoRef}
        source={source}
        style={styles.hidden}
        paused={!playing}
        playInBackground={false}
        progressUpdateInterval={250}
        onProgress={e => setPosition(e.currentTime || 0)}
        onEnd={() => {
          setPlaying(false);
          setPosition(0);
          videoRef.current?.seek(0);
        }}
        onError={() => {
          setPlaying(false);
          setFailed(true);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.headerRowBg,
    padding: spacing.md,
  },
  rowDark: { backgroundColor: 'rgba(255,255,255,0.12)', borderColor: 'rgba(255,255,255,0.3)' },
  playBtn: { width: 44, height: 44, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
  mid: { flex: 1 },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.border, overflow: 'hidden' },
  trackDark: { backgroundColor: 'rgba(255,255,255,0.3)' },
  fill: { height: 6, borderRadius: 3 },
  time: { marginTop: 6, fontSize: 12, fontFamily },
  hidden: { width: 1, height: 1, position: 'absolute', opacity: 0 },
});
