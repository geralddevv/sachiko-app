import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Modal,
  RefreshControl,
  TouchableOpacity,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { colors, radii, spacing, fontFamily } from '../theme/theme';
import HeaderBar, { CountPill } from '../theme/HeaderBar';
import Button from '../theme/Button';
import { getLogs, logout, ApiError, isOfflineError } from '../services/api';
import { useOffline, useOnReconnect } from '../services/connectivity';
import { printQueue } from '../services/printQueue';
import Toast, { useToast } from '../theme/Toast';

// Rendered as the "Logs" panel inside HomeScreen's segmented toggle: what this
// operator actually produced, one row per Deckle punched out. Today by
// default -- the shift they're standing in is the only day they normally care
// about -- with a day stepper for the rest (see the /logs route for how the
// day window is built from the device's own timezone).

// Local YYYY-MM-DD. Deliberately NOT toISOString().slice(0,10), which is UTC
// and so names yesterday for anyone east of Greenwich late in the evening.
function isoDay(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function shiftDay(day, days) {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  return isoDay(date);
}

// "Today", "Yesterday", or "Mon, 12 Aug" -- a bare date reads as noise on the
// day the operator is almost always looking at.
function dayLabel(day, today) {
  if (day === today) {
    return 'Today';
  }
  if (day === shiftDay(today, -1)) {
    return 'Yesterday';
  }
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

function timeLabel(at) {
  if (!at) {
    return '';
  }
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// The row is a summary and a way in, nothing more: tapping it opens the
// details dialog below, which is where Reprint now lives. A printer button on
// every card sat one mis-tap away from a sticker nobody asked for, and made
// the list read as a column of buttons rather than a column of work done.
function LogRow({ row, onOpen }) {
  return (
    <TouchableOpacity
      style={styles.row}
      activeOpacity={0.75}
      onPress={() => onOpen(row)}
      accessibilityRole="button"
      accessibilityLabel={`Details for ${row.deckleId}`}>
      <View style={styles.rowHead}>
        <Text style={styles.deckleId}>{row.deckleId || '—'}</Text>
        <Text style={styles.time}>{timeLabel(row.at)}</Text>
      </View>
      <View style={styles.rowMeta}>
        <Text style={styles.metaText} numberOfLines={1}>
          {row.productCode || '—'}
          {row.lotNo ? ` · ${row.lotNo}` : ''}
        </Text>
        <Text style={styles.meters}>{row.meters} m</Text>
        <Icon name="chevron-right" size={18} color={colors.textMuted} />
      </View>
    </TouchableOpacity>
  );
}

function DetailField({ label, value }) {
  return (
    <View style={styles.detailField}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value || '—'}</Text>
    </View>
  );
}

// Everything the log holds about one Deckle, plus the one action that isn't
// just reading. Reprint is still hidden when the row predates the server field
// the label call needs (older logs) -- there is nothing to print against.
function LogDetailDialog({ row, dayText, busy, onReprint, onClose }) {
  return (
    <Modal visible={!!row} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.detailCard}>
          <Text style={styles.detailTitle}>{row?.deckleId || '—'}</Text>
          <Text style={styles.detailSubtitle}>Deckle produced</Text>

          <View style={styles.detailList}>
            <DetailField label="Product Code" value={row?.productCode} />
            <DetailField label="Lot No" value={row?.lotNo} />
            <DetailField label="Size" value={row?.size} />
            <DetailField label="Meters" value={row ? `${row.meters} m` : ''} />
            <DetailField
              label="Produced"
              value={[dayText, timeLabel(row?.at)].filter(Boolean).join(' · ')}
            />
          </View>

          <View style={styles.detailButtons}>
            <Button
              title="Close"
              variant="outline"
              size="sm"
              disabled={busy}
              onPress={onClose}
              style={styles.detailButton}
            />
            {row?.stockId ? (
              <Button
                title="Reprint"
                icon="printer"
                size="sm"
                loading={busy}
                onPress={() => onReprint(row)}
                style={styles.detailButton}
              />
            ) : null}
          </View>
        </View>
      </View>
    </Modal>
  );
}

export default function LogsScreen({ navigation, onLoggedOut }) {
  const today = isoDay(new Date());
  const [day, setDay] = useState(today);
  const [data, setData] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const offline = useOffline();
  const { toast, showToast, hideToast } = useToast();
  // deckleId of the row whose label is on its way to the printer. Draining is
  // global and sequential (services/printQueue.js), so only one at a time.
  const [reprintingId, setReprintingId] = useState(null);
  // The row whose details dialog is open, or null.
  const [detail, setDetail] = useState(null);

  const reprint = useCallback(
    async row => {
      if (!row.stockId || reprintingId) {
        return;
      }
      setReprintingId(row.deckleId);
      try {
        // Same path as a freshly produced Deckle: enqueue() persists the job
        // and kicks off a flush; flushToCompletion() waits for that flush so
        // the toast reflects what actually happened.
        await printQueue.enqueue({
          stockId: row.stockId,
          rollId: row.deckleId,
          productCode: row.productCode,
        });
        const { lastError } = await printQueue.flushToCompletion();
        // The details dialog is a Modal, so a toast rendered by this screen
        // would come up underneath its backdrop and PrinterSettings would open
        // behind it. It closes the moment the print resolves; the toast then
        // reports what happened over the list.
        setDetail(null);
        if (lastError === 'No printer configured') {
          showToast('Set a printer up first — the label is queued.', 'warning');
          navigation.navigate('PrinterSettings');
          return;
        }
        // Printed if the job is no longer waiting in the queue; otherwise it
        // stayed behind and the queue will keep retrying it (job card banner).
        const printed = !printQueue.getState().jobs.some(job => job.stockId === row.stockId);
        showToast(
          printed
            ? `Reprinted ${row.deckleId}.`
            : `Couldn't reach the printer — ${row.deckleId} is in the print queue.`,
          printed ? 'success' : 'warning',
        );
      } catch (err) {
        setDetail(null);
        showToast(err?.message || 'Could not reprint this label.', 'error');
      } finally {
        setReprintingId(null);
      }
    },
    [navigation, reprintingId, showToast],
  );

  const load = useCallback(
    async forDay => {
      try {
        const result = await getLogs(forDay);
        setData(result);
        setError(null);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          await logout();
          onLoggedOut();
          navigation.reset({ index: 0, routes: [{ name: 'Login' }] });
          return;
        }
        // OfflineBanner already says this, app-wide.
        setError(isOfflineError(err) ? null : err.message || 'Could not load your logs.');
      } finally {
        setRefreshing(false);
      }
    },
    [navigation, onLoggedOut],
  );

  useFocusEffect(
    useCallback(() => {
      load(day);
    }, [load, day]),
  );

  useOnReconnect(
    useCallback(() => {
      load(day);
    }, [load, day]),
  );

  // Stepping the day clears the old rows first: leaving them under the new
  // date would read as that day's work for however long the load takes.
  const goToDay = useCallback(next => {
    setData(null);
    setDetail(null);
    setDay(next);
  }, []);

  const rows = data?.rows || [];
  const totals = data?.totals;

  return (
    <View style={styles.container}>
      <HeaderBar
        title="Work Done"
        subtitle={totals ? `${totals.meters} m produced` : undefined}
        right={<CountPill count={totals?.deckles ?? 0} />}
      />

      {/* The day filter: step a day at a time, with a Today shortcut once
          you've wandered off it. Forward is capped at today -- there is no
          such thing as work done tomorrow. */}
      <View style={styles.dayBar}>
        <TouchableOpacity
          style={styles.dayArrow}
          onPress={() => goToDay(shiftDay(day, -1))}
          accessibilityRole="button"
          accessibilityLabel="Previous day">
          <Icon name="chevron-left" size={22} color={colors.primary} />
        </TouchableOpacity>

        <Text style={styles.dayLabel}>{dayLabel(day, today)}</Text>

        <TouchableOpacity
          style={[styles.dayArrow, day === today && styles.dayArrowDisabled]}
          disabled={day === today}
          onPress={() => goToDay(shiftDay(day, 1))}
          accessibilityRole="button"
          accessibilityLabel="Next day">
          <Icon name="chevron-right" size={22} color={day === today ? colors.border : colors.primary} />
        </TouchableOpacity>

        {day !== today ? (
          <TouchableOpacity style={styles.todayChip} onPress={() => goToDay(today)}>
            <Text style={styles.todayChipText}>Today</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <FlatList
        contentContainerStyle={styles.listContent}
        data={rows}
        keyExtractor={(item, i) => item.deckleId || String(i)}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load(day);
            }}
          />
        }
        ListEmptyComponent={
          data ? (
            <Text style={styles.emptyText}>
              {day === today ? 'Nothing produced yet today.' : 'Nothing produced on this day.'}
            </Text>
          ) : offline ? (
            <Text style={styles.emptyText}>Waiting for the server…</Text>
          ) : null
        }
        renderItem={({ item }) => <LogRow row={item} onOpen={setDetail} />}
      />

      <LogDetailDialog
        row={detail}
        dayText={dayLabel(day, today)}
        busy={!!detail && reprintingId === detail.deckleId}
        onReprint={reprint}
        onClose={() => setDetail(null)}
      />

      <Toast toast={toast} onHide={hideToast} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  dayBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  dayArrow: {
    width: 34,
    height: 34,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.cardBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayArrowDisabled: { opacity: 0.5 },
  dayLabel: {
    flex: 1,
    textAlign: 'center',
    fontSize: 14,
    fontWeight: '700',
    color: colors.textDark,
    fontFamily,
  },
  todayChip: {
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.primary,
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
  },
  todayChipText: { fontSize: 12, fontWeight: '700', color: colors.primary, fontFamily },
  listContent: { paddingTop: spacing.md, paddingBottom: spacing.lg },
  row: {
    backgroundColor: colors.cardBg,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  rowHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  deckleId: { fontSize: 14, fontWeight: '800', color: colors.primary, fontFamily },
  time: { fontSize: 12, color: colors.textMuted, fontFamily },
  rowMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 4,
    gap: spacing.sm,
  },
  metaText: { flex: 1, fontSize: 12.5, color: colors.textDark, fontFamily },
  meters: { fontSize: 13, fontWeight: '700', color: colors.textDark, fontFamily },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(11,31,51,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  detailCard: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: colors.cardBg,
    borderRadius: radii.lg,
    padding: spacing.lg,
    // Same soft lift as theme/AppDialog, so both dialogs sit at one depth.
    shadowColor: '#0B1F33',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 20,
    elevation: 6,
  },
  detailTitle: { fontSize: 17, fontWeight: '800', color: colors.primary, fontFamily },
  detailSubtitle: { fontSize: 12, color: colors.textMuted, marginTop: 2, fontFamily },
  detailList: { marginTop: spacing.md },
  // Label left, value right on one line -- five short fields read faster as a
  // list than as stacked label/value pairs, and it keeps the card short enough
  // that the buttons never leave the screen on a small phone.
  detailField: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  detailLabel: { fontSize: 12.5, color: colors.textMuted, fontFamily },
  detailValue: {
    flex: 1,
    textAlign: 'right',
    fontSize: 13.5,
    fontWeight: '700',
    color: colors.textDark,
    fontFamily,
  },
  detailButtons: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  detailButton: { flex: 1 },
  emptyText: { textAlign: 'center', marginTop: spacing.xl, color: colors.textMuted, fontSize: 14, fontFamily },
  errorBanner: {
    backgroundColor: colors.rowShortBg,
    borderRadius: radii.sm,
    padding: spacing.sm,
    marginTop: spacing.sm,
  },
  errorText: { color: '#842029', fontSize: 13, fontFamily },
});
