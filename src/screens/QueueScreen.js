import React, { useState, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, RefreshControl, TouchableOpacity } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { colors, radii, spacing, fontFamily } from '../theme/theme';
import HeaderBar, { CountPill } from '../theme/HeaderBar';
import { getQueue, logout, ApiError, isOfflineError } from '../services/api';
import { useOffline, useOnReconnect } from '../services/connectivity';
import { getPausedPendingIds } from '../storage/draftStorage';

// Rendered as the "Work Queue" panel inside HomeScreen's segmented toggle, so it
// owns neither the nav-bar header nor logout (HomeScreen does) -- just its own
// data load and list. Ported from FairtechOperatorApp's own QueueScreen.js:
// the outer group/list/refresh/error mechanics are identical (buildOperatorQueue's
// groups[].jobs[] shape carries the same machineId/machineName/machineType/
// locationName/jobs field names on both servers), but the per-job tile is
// rewritten for Sachiko's actual row shape -- there is no productId/dieNo/
// paperType/paperCode here, and canStart/rollsStatus/*Status come straight off
// buildQueueRows rather than being re-derived client-side.

// Row background tint by materialStatus (is every raw-material layer this
// item's recipe calls for allotted?), the same field the web app's queue
// table tints on -- see views/inventory/masters/operatorQueue.ejs's
// `row.materialStatus === 'match' ? 'mq-row-match' : ...`. Fully-allotted
// reads green, short reads red. Deliberately NOT rollsStatus: that tracks
// deckle reels produced vs. ordered, so a multi-roll order still reads
// "short" after its first run even when every layer feeding it is
// allocated (routes/system/machine.js spells this out at buildQueueRows).
const ROW_TINT = {
  match: colors.rowMatchBg,
  short: colors.rowShortBg,
};

// Facestock/Adhesive/Release readiness chip -- "none"/"partial"/"full", per
// buildQueueRows' own facestockStatus/adhesiveStatus/releaseStatus. A pool the
// item's recipe doesn't even call for (e.g. no second release layer) is
// omitted entirely rather than shown as "none".
const POOL_CHIP_STYLE = {
  none: { bg: colors.rowShortBg, border: '#FCA5A5', text: colors.dangerStrong },
  partial: { bg: colors.noticeBg, border: colors.noticeBorder, text: colors.noticeText },
  full: { bg: colors.rowMatchBg, border: '#86EFAC', text: '#166534' },
};

function PoolChip({ label, status }) {
  if (!status) {
    return null;
  }
  const s = POOL_CHIP_STYLE[status] || POOL_CHIP_STYLE.none;
  return (
    <View style={[styles.chip, { backgroundColor: s.bg, borderColor: s.border }]}>
      <Text style={[styles.chipText, { color: s.text }]}>{label}</Text>
    </View>
  );
}

function JobCard({ job, paused, onStart }) {
  return (
    <View style={[styles.jobCard, { backgroundColor: ROW_TINT[job.materialStatus] || '#FFFFFF' }]}>
      <View style={styles.jobHeaderRow}>
        {/* The lot number alone -- it already reads as "SP | LOT | 0001", so a
            "Lot" prefix in front of it just says the same word twice. */}
        <View style={styles.jobHeaderLeft}>
          <Text style={styles.jobLot}>{job.lotNo}</Text>
          {/* Paused: this operator started this job on this device and walked
              away without ending it. Amber, with the same pause glyph the job
              card's own button uses, so it reads as a state and not as another
              material chip. */}
          {paused ? (
            <View style={styles.pausedBadge}>
              <Icon name="pause-circle" size={13} color={colors.noticeText} />
              <Text style={styles.pausedBadgeText}>Paused</Text>
            </View>
          ) : null}
        </View>
        {/* The product code is what the operator matches against the reel in
            hand, so it gets an outlined navy capsule -- larger and heavier than
            the status chips below it, and unfilled so the card's own
            match/short tint carries straight through it. */}
        <View style={styles.jobProductPill}>
          <Text style={styles.jobProduct}>{job.productCode}</Text>
        </View>
      </View>
      {/* Deckle size (the mother facestock web width this order laminates from)
          hangs directly under the product capsule in the same navy outline and
          the same type. Absolutely placed so it drops into the empty gutter
          beside the Deckles line rather than adding a row and shoving the card
          taller. */}
      {job.deckleSize != null && job.deckleSize !== '' ? (
        <View style={styles.jobWidthBadge} pointerEvents="none">
          <Text style={styles.jobWidthText}>{job.deckleSize} mm</Text>
        </View>
      ) : null}
      {/* No "allotted" here: allottedRolls counts finished Deckle reels
          laminated at Assign Production, which that flow no longer does on
          submit (routes/system/machine.js's hasStartableAllotment), so it
          reads 0 for every order assigned through the current flow. Material
          allotment is what the pool chips below already say. */}
      <Text style={styles.jobLine}>
        Deckles: <Text style={styles.jobLineValue}>{job.rolls}</Text>, produced:{' '}
        <Text style={styles.jobLineValue}>{job.producedRolls}</Text>, balance:{' '}
        <Text style={styles.jobLineValue}>{job.balanceRolls}</Text>
      </Text>

      <View style={styles.chipRow}>
        <PoolChip label="Facestock" status={job.facestockStatus} />
        <PoolChip label="Adhesive" status={job.adhesiveStatus} />
        <PoolChip label="Release" status={job.releaseStatus} />
      </View>

      {/* runningElsewhere comes from the server's job-running claim: the same
          operator signed in on another device already has this job open, so it
          reads as taken here rather than letting both punch the same job. */}
      <TouchableOpacity
        onPress={() => job.canStart && !job.runningElsewhere && onStart(job)}
        disabled={!job.canStart || job.runningElsewhere}
        style={[styles.startButton, (!job.canStart || job.runningElsewhere) && styles.startButtonDisabled]}>
        <Text style={styles.startButtonText}>
          {job.runningElsewhere
            ? `In progress · ${job.runningOnLabel}`
            : job.canStart
            ? paused
              ? '▶ Resume'
              : '▶ Start'
            : 'Awaiting material'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

// One allocated slitting card. The step AFTER lamination: a Deckle web the
// planner has already fixed a knife layout for (the web's Slitting Allocation
// page), waiting to be cut into finished rolls. Deliberately a different tile
// from JobCard above rather than a variant of it -- a slitting card is not a
// PendingProduction and shares none of a lamination row's fields (no material
// pools to be short of, no deckle count; what it has is Deckles left to run
// and the rolls they will make).
//
// The one gate worth showing here is curing: a Deckle can be opened but not
// run until its adhesive has cured, 6 h after lamination.
function SlittingCard({ card, onOpen }) {
  const left = card.deckleLeft;
  return (
    <View style={[styles.jobCard, card.curing ? styles.slittingCardCuring : styles.slittingCard]}>
      <View style={styles.jobHeaderRow}>
        <View style={styles.jobHeaderLeft}>
          <Text style={styles.jobLot} numberOfLines={1}>
            {card.lotNo}
          </Text>
        </View>
        <View style={styles.jobProductPill}>
          <Text style={styles.jobProduct}>{card.productCode}</Text>
        </View>
      </View>
      <Text style={styles.slittingCardId}>{card.slittingJobCardId}</Text>
      <Text style={styles.jobLine}>
        Deckles: <Text style={styles.jobLineValue}>{card.deckleCount}</Text>, done:{' '}
        <Text style={styles.jobLineValue}>{card.deckleDone}</Text>, rolls to make:{' '}
        <Text style={styles.jobLineValue}>{card.plannedRolls - card.producedRolls}</Text>
      </Text>

      {card.curing ? (
        <View style={styles.chipRow}>
          <View style={[styles.chip, { backgroundColor: colors.noticeBg, borderColor: colors.noticeBorder }]}>
            <Text style={[styles.chipText, { color: colors.noticeText }]}>
              Curing{card.curingUntilLabel ? ` · ready ${card.curingUntilLabel}` : ''}
            </Text>
          </View>
        </View>
      ) : null}

      {/* Open even while curing: the operator can read the layout and punch
          Job Setting: only the Deckle's own Start is gated, and the card
          itself says so. */}
      <TouchableOpacity onPress={() => onOpen(card)} style={styles.startButton}>
        <Text style={styles.startButtonText}>
          {card.running ? '▶ Resume' : card.deckleDone > 0 ? `▶ Continue · ${left} left` : '▶ Start'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

export default function QueueScreen({ navigation, onLoggedOut }) {
  const [queue, setQueue] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  // pendingIds of the jobs this device has a paused draft for. Recomputed on
  // every load, so coming back from a job that was just paused shows it, and
  // ending a job (which clears its draft) drops the badge again.
  const [pausedIds, setPausedIds] = useState(() => new Set());
  const offline = useOffline();

  const load = useCallback(async () => {
    try {
      const data = await getQueue();
      setQueue(data);
      // Read against the jobs actually listed, so a draft left behind by a job
      // that has since left the queue is never looked up.
      const listedIds = (data?.groups || []).flatMap(group =>
        (group.jobs || []).map(job => job._id),
      );
      setPausedIds(await getPausedPendingIds(listedIds));
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        await logout();
        onLoggedOut();
        navigation.reset({ index: 0, routes: [{ name: 'Login' }] });
        return;
      }
      // A dead server is reported once, app-wide, by OfflineBanner -- repeating
      // it in the list's own error row would say the same thing twice.
      setError(isOfflineError(err) ? null : err.message || 'Could not load your work queue.');
    } finally {
      setRefreshing(false);
    }
  }, [navigation, onLoggedOut]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // The focus effect above cannot cover this: the screen is already focused
  // when the server comes back, so nothing would re-run without it.
  useOnReconnect(load);

  const groups = queue?.groups || [];
  // Slitting cards allocated to this operator. They ride along on the same
  // /queue call (buildOperatorQueue folds them in as `slittingRows`), so there
  // is no second request and no second tab -- the floor works one queue.
  const slittingRows = queue?.slittingRows || [];
  // Grouped by slitter the same way the lamination jobs are grouped by
  // machine, so an operator signed in across two slitters can tell which
  // machine a card is waiting on.
  const slittingByMachine = slittingRows.reduce((acc, row) => {
    const name = row.machineName || '—';
    (acc[name] ||= []).push(row);
    return acc;
  }, {});

  return (
    <View style={styles.container}>
      {/* Greet the operator by the short name they're actually called on the
          floor (and sign in with). operatorNickName already falls back to the
          full name server-side when no nick name is set. */}
      <HeaderBar
        title={queue ? `${queue.operatorNickName || queue.operatorName}'s Work Queue` : 'Work Queue'}
        subtitle={queue?.operatorLocation}
        // totalJobs counts lamination jobs only (it is buildQueueRows' own
        // row count), so the slitting cards are added here rather than
        // server-side: the pill has to match what this list actually shows.
        right={<CountPill count={(queue?.totalJobs ?? 0) + slittingRows.length} />}
      />

      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <FlatList
        contentContainerStyle={styles.listContent}
        data={groups}
        keyExtractor={item => item.machineId}
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
          queue && !slittingRows.length ? (
            <Text style={styles.emptyText}>No jobs assigned right now.</Text>
          ) : !queue && offline ? (
            <Text style={styles.emptyText}>Waiting for the server…</Text>
          ) : null
        }
        // One element, not the bare array the machine groups map to:
        // VirtualizedList renders this slot as `isValidElement(x) ? x : <x/>`,
        // and an array is neither -- it gets called as a component type and
        // throws "expected a string or a class/function but got: array".
        ListFooterComponent={
          slittingRows.length ? (
            <>
              {Object.entries(slittingByMachine).map(([machineName, cards]) => (
                <View key={machineName} style={styles.machineGroup}>
                  <Text style={styles.machineTitle}>
                    {machineName} · SLITTING · {cards.length === 1 ? '1 card' : `${cards.length} cards`}
                  </Text>
                  {cards.map(sCard => (
                    <SlittingCard
                      key={sCard._id}
                      card={sCard}
                      onOpen={selected => navigation.navigate('SlittingJobCard', { cardId: selected._id })}
                    />
                  ))}
                </View>
              ))}
            </>
          ) : null
        }
        renderItem={({ item: group }) => (
          <View style={styles.machineGroup}>
            <Text style={styles.machineTitle}>
              {group.machineName} · {group.machineType} · {group.locationName}
            </Text>
            {group.jobs.map(job => (
              <JobCard
                key={job._id}
                job={job}
                paused={pausedIds.has(String(job._id))}
                onStart={selected => navigation.navigate('JobCard', { pendingId: selected._id })}
              />
            ))}
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  listContent: { paddingTop: spacing.sm, paddingBottom: spacing.lg },
  machineGroup: { marginBottom: spacing.lg },
  machineTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.primaryDark,
    marginBottom: spacing.sm,
    fontFamily,
  },
  jobCard: {
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  jobHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexShrink: 1,
  },
  pausedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.noticeBg,
    borderWidth: 1,
    borderColor: colors.noticeBorder,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  pausedBadgeText: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.noticeText,
    fontFamily,
  },
  jobHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  jobLot: { fontWeight: '700', color: colors.textDark, fontFamily },
  jobProductPill: {
    borderRadius: radii.pill,
    borderWidth: 2,
    borderColor: colors.primary,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
    marginLeft: spacing.sm,
  },
  jobProduct: {
    fontSize: 16,
    fontWeight: '900',
    color: colors.primary,
    letterSpacing: 0.4,
    fontFamily,
  },
  jobWidthBadge: {
    position: 'absolute',
    top: 52,
    right: spacing.md,
    borderRadius: radii.pill,
    borderWidth: 2,
    borderColor: colors.primary,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
  // Identical to the product code (jobProduct): same font, size, weight and
  // spacing, and jobWidthBadge matches jobProductPill's border and padding --
  // only its absolute placement in the gutter sets it apart.
  jobWidthText: { fontSize: 16, fontWeight: '900', color: colors.primary, letterSpacing: 0.4, fontFamily },
  // Slitting cards carry no material-allotment tint (there are no pools to be
  // short of -- the material IS the allocated Deckle), so they take the
  // info-panel blue that sets them apart from the lamination tiles above, and
  // the notice amber while a Deckle is still curing.
  slittingCard: { backgroundColor: colors.infoPanelBg },
  slittingCardCuring: { backgroundColor: colors.noticeBg, borderColor: colors.noticeBorder },
  slittingCardId: { fontSize: 11, fontWeight: '600', color: colors.textMuted, marginBottom: 3, fontFamily },
  jobLine: { fontSize: 12.5, color: colors.textDark, marginBottom: 2, fontFamily },
  jobLineValue: { fontWeight: '700' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4, marginBottom: spacing.sm },
  chip: {
    borderRadius: radii.pill,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  chipText: { fontSize: 10.5, fontWeight: '700', fontFamily },
  startButton: {
    backgroundColor: colors.success,
    borderRadius: radii.sm,
    paddingVertical: 8,
    alignItems: 'center',
  },
  startButtonDisabled: { backgroundColor: '#9CA3AF' },
  startButtonText: { color: '#FFFFFF', fontWeight: '700', fontSize: 12.5, fontFamily },
  errorBanner: {
    backgroundColor: 'rgba(255,229,229,0.8)',
    borderRadius: radii.sm,
    padding: spacing.sm,
  },
  errorText: { color: '#842029', fontSize: 13, fontFamily },
  emptyText: { textAlign: 'center', color: colors.textMuted, marginTop: spacing.xl, fontFamily },
});
