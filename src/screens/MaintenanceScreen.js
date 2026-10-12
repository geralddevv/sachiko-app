import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  TouchableOpacity,
  Image,
  Modal,
  ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import Video from 'react-native-video';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { colors, radii, spacing, fontFamily } from '../theme/theme';
import Button from '../theme/Button';
import { getMaintenance, getMediaAuth, maintenanceMediaSource, ApiError, isOfflineError } from '../services/api';
import { useOffline, useOnReconnect } from '../services/connectivity';
import { formatDateTime } from '../utils/datetime';
import VoicePlayer from './maintenance/VoicePlayer';

// Rendered as the "Maintenance" panel inside HomeScreen's segmented toggle
// (reached via the toggle, not a nav push), so it carries no nav-bar header of
// its own -- just the report button and the operator's ticket list.

// Status pill colours, matching operatorMaintenance.ejs's .status-* classes.
const STATUS_STYLE = {
  OPEN: { bg: colors.noticeBg, border: colors.noticeBorder, text: colors.noticeText },
  'IN PROGRESS': { bg: '#E0F2FE', border: '#7DD3FC', text: '#075985' },
  RESOLVED: { bg: '#DCFCE7', border: '#86EFAC', text: '#166534' },
  REJECTED: { bg: '#FEE2E2', border: '#FCA5A5', text: '#991B1B' },
};

function StatusPill({ status }) {
  const s = STATUS_STYLE[status] || STATUS_STYLE.OPEN;
  return (
    <View style={[styles.pill, { backgroundColor: s.bg, borderColor: s.border }]}>
      <Text style={[styles.pillText, { color: s.text }]}>{status}</Text>
    </View>
  );
}

// "0:07" -> 7. The ticket row carries the length as a label only.
function parseClock(label) {
  const [m, s] = String(label || '').split(':').map(Number);
  return Number.isFinite(m) && Number.isFinite(s) ? m * 60 + s : 0;
}

function MediaTile({ media, ticketId, mediaAuth, onView }) {
  const source = maintenanceMediaSource(mediaAuth, ticketId, media.index, { thumb: true });
  if (media.kind === 'audio') {
    // No picture for a voice message -- a mic tile that opens the player.
    return (
      <TouchableOpacity
        activeOpacity={0.85}
        style={[styles.tile, styles.tileAudio]}
        onPress={() => onView(media)}
        accessibilityLabel="Play voice message">
        <Icon name="microphone" size={28} color="#FFFFFF" />
        {media.durationLabel ? <Text style={styles.tileLen}>{media.durationLabel}</Text> : null}
      </TouchableOpacity>
    );
  }
  return (
    <TouchableOpacity activeOpacity={0.85} style={styles.tile} onPress={() => onView(media)}>
      <Image source={source} style={styles.tileImage} resizeMode="cover" />
      {media.kind === 'video' ? (
        <View style={styles.tilePlay}>
          <Icon name="play-circle" size={26} color="#FFFFFF" />
          {media.durationLabel ? <Text style={styles.tileLen}>{media.durationLabel}</Text> : null}
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

function TicketCard({ ticket, mediaAuth, onViewMedia }) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.cardHeadText}># {ticket.ticketNo}</Text>
        <StatusPill status={ticket.status} />
      </View>
      <View style={styles.cardBody}>
        {ticket.media?.length ? (
          <View style={styles.mediaRow}>
            {ticket.media.map(m => (
              <MediaTile
                key={m.index}
                media={m}
                ticketId={ticket._id}
                mediaAuth={mediaAuth}
                onView={media => onViewMedia(ticket, media)}
              />
            ))}
          </View>
        ) : null}

        <Text style={styles.desc}>{ticket.description}</Text>

        <View style={styles.metaRow}>
          <Text style={styles.meta}>{formatDateTime(ticket.createdAt)}</Text>
          {ticket.machineName && ticket.machineName !== '—' ? (
            <Text style={styles.meta}>· {ticket.machineName}</Text>
          ) : null}
          {ticket.locationName && ticket.locationName !== '—' ? (
            <Text style={styles.meta}>· {ticket.locationName}</Text>
          ) : null}
        </View>

        {ticket.latestAction ? (
          <View style={styles.remark}>
            <Text style={styles.remarkText}>
              {ticket.latestAction.remark || `Marked ${ticket.latestAction.status}`}
            </Text>
            <Text style={styles.remarkBy}>
              — {ticket.latestAction.byName || 'Office'}, {formatDateTime(ticket.latestAction.at)}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

export default function MaintenanceScreen({ navigation }) {
  const [data, setData] = useState(null);
  const [mediaAuth, setMediaAuth] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [viewer, setViewer] = useState(null); // { ticket, media } for the full image viewer
  const offline = useOffline();

  const load = useCallback(async () => {
    try {
      const [result, auth] = await Promise.all([getMaintenance(), getMediaAuth()]);
      setData(result);
      setMediaAuth(auth);
      setError(null);
    } catch (err) {
      // A 401 here is NOT treated as a session expiry -- the Work Queue uses the
      // same token and keeps working, so a 401 *specifically* from /maintenance
      // means the server doesn't have the maintenance endpoint (its session auth
      // rejects the call as it falls through). Surface that instead of logging
      // the operator out of the whole app. Genuine token expiry is still caught
      // on the Queue, which owns the session check.
      if (isOfflineError(err)) {
        // OfflineBanner already says this, app-wide.
        setError(null);
        return;
      }
      const msg =
        err instanceof ApiError && err.status === 401
          ? 'Maintenance is unavailable on this server — it may be running an older build without the maintenance feature. Ask your admin to update the SACHIKO2 server.'
          : err.message || 'Could not load your maintenance tickets.';
      setError(msg);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // The focus effect above cannot cover this: the screen is already focused
  // when the server comes back, so nothing would re-run without it.
  useOnReconnect(load);

  // Both photos and videos open in the full-screen viewer. The media endpoint
  // streams video with HTTP Range support, so react-native-video seeks/plays it
  // straight from the ?token=-authed URL.
  const handleViewMedia = useCallback((ticket, media) => {
    setViewer({ ticket, media });
  }, []);

  const requests = data?.requests || [];

  return (
    <View style={styles.container}>
      {data && (data.machineName || data.locationName) ? (
        <Text style={styles.contextLine}>
          {[data.machineName, data.locationName].filter(Boolean).join(' · ')}
        </Text>
      ) : null}

      <View style={styles.reportRow}>
        <Button
          title="⚠  Report a Problem"
          variant="danger"
          onPress={() =>
            navigation.navigate('ReportProblem', {
              machines: data?.machines || [],
              defaultMachineId: data?.defaultMachineId || '',
            })
          }
        />
      </View>

      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <FlatList
        contentContainerStyle={styles.listContent}
        data={requests}
        keyExtractor={item => item._id}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
          />
        }
        ListEmptyComponent={
          data ? (
            <View style={styles.notice}>
              <Text style={styles.noticeText}>
                You haven't reported any problems yet. Tap "Report a Problem" to send a description (and a photo, if
                you have one) to the office.
              </Text>
            </View>
          ) : offline ? (
            // Never a spinner while offline: the load that would end it cannot
            // finish, so it would turn forever under the banner.
            <Text style={styles.waitingText}>Waiting for the server…</Text>
          ) : (
            <ActivityIndicator style={{ marginTop: spacing.xl }} color={colors.primary} />
          )
        }
        renderItem={({ item }) => (
          <TicketCard ticket={item} mediaAuth={mediaAuth} onViewMedia={handleViewMedia} />
        )}
      />

      <Modal visible={!!viewer} transparent animationType="fade" onRequestClose={() => setViewer(null)}>
        <View style={styles.viewerBackdrop}>
          <TouchableOpacity
            style={styles.viewerClose}
            onPress={() => setViewer(null)}
            accessibilityLabel="Close">
            <Icon name="close" size={26} color="#FFFFFF" />
          </TouchableOpacity>

          {viewer && mediaAuth ? (
            viewer.media.kind === 'audio' ? (
              <View style={styles.viewerAudio}>
                <VoicePlayer
                  onDark
                  autoPlay
                  source={maintenanceMediaSource(mediaAuth, viewer.ticket._id, viewer.media.index)}
                  durationSec={parseClock(viewer.media.durationLabel)}
                />
              </View>
            ) : viewer.media.kind === 'video' ? (
              <Video
                source={maintenanceMediaSource(mediaAuth, viewer.ticket._id, viewer.media.index)}
                style={styles.viewerImage}
                controls
                resizeMode="contain"
                paused={false}
                onError={() => {}}
              />
            ) : (
              <TouchableOpacity activeOpacity={1} style={styles.viewerImageWrap} onPress={() => setViewer(null)}>
                <Image
                  source={maintenanceMediaSource(mediaAuth, viewer.ticket._id, viewer.media.index)}
                  style={styles.viewerImage}
                  resizeMode="contain"
                />
              </TouchableOpacity>
            )
          ) : null}

          <Text style={styles.viewerHint}>
            {viewer?.media?.kind === 'video' || viewer?.media?.kind === 'audio'
              ? 'Tap ✕ to close'
              : 'Tap the image or ✕ to close'}
          </Text>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  waitingText: {
    textAlign: 'center',
    marginTop: spacing.xl,
    color: colors.textMuted,
    fontSize: 14,
    fontFamily,
  },
  container: { flex: 1, backgroundColor: colors.background, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  contextLine: { fontSize: 12.5, color: colors.textMuted, marginBottom: spacing.sm, fontFamily },
  reportRow: { marginTop: spacing.xs },
  listContent: { paddingTop: spacing.md, paddingBottom: spacing.lg },
  card: {
    backgroundColor: colors.cardBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    overflow: 'hidden',
    marginBottom: spacing.md,
  },
  cardHead: {
    backgroundColor: colors.primary,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cardHeadText: { color: '#FFFFFF', fontWeight: '600', fontSize: 13, fontFamily },
  cardBody: { padding: spacing.md },
  mediaRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm },
  tile: {
    width: 84,
    height: 84,
    borderRadius: radii.sm,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.headerRowBg,
  },
  tileImage: { width: '100%', height: '100%' },
  tileAudio: { backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  viewerAudio: { width: '86%' },
  tilePlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.32)',
  },
  tileLen: {
    position: 'absolute',
    right: 4,
    bottom: 4,
    backgroundColor: 'rgba(0,0,0,0.7)',
    color: '#FFFFFF',
    borderRadius: 4,
    paddingHorizontal: 4,
    fontSize: 10,
    fontWeight: '700',
    fontFamily,
  },
  desc: { color: colors.textDark, fontSize: 13.5, fontWeight: '600', fontFamily },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: spacing.sm, gap: 6 },
  meta: { color: colors.textMuted, fontSize: 12, fontFamily },
  remark: {
    marginTop: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.headerRowBg,
    borderLeftWidth: 3,
    borderLeftColor: colors.primary,
    borderRadius: radii.sm,
  },
  remarkText: { color: colors.textDark, fontSize: 12.5, fontFamily },
  remarkBy: { color: colors.textMuted, fontSize: 11.5, marginTop: 3, fontFamily },
  pill: {
    borderRadius: radii.pill,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  pillText: { fontSize: 11, fontWeight: '700', fontFamily },
  notice: {
    backgroundColor: colors.noticeBg,
    borderWidth: 1,
    borderColor: colors.noticeBorder,
    borderRadius: radii.sm,
    padding: spacing.md,
    marginTop: spacing.sm,
  },
  noticeText: { color: colors.noticeText, fontSize: 13, fontFamily },
  errorBanner: {
    backgroundColor: 'rgba(255,229,229,0.8)',
    borderRadius: radii.sm,
    padding: spacing.sm,
    marginTop: spacing.md,
  },
  errorText: { color: '#842029', fontSize: 13, fontFamily },
  viewerBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  viewerImageWrap: { width: '100%', height: '80%', alignItems: 'center', justifyContent: 'center' },
  viewerImage: { width: '100%', height: '80%' },
  viewerClose: {
    position: 'absolute',
    top: spacing.lg,
    right: spacing.lg,
    zIndex: 2,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerHint: {
    position: 'absolute',
    bottom: spacing.xl,
    color: 'rgba(255,255,255,0.75)',
    fontSize: 12,
    fontFamily,
  },
});
