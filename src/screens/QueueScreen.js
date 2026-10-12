import React, { useState, useCallback, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, FlatList, RefreshControl, TouchableOpacity } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { colors, radii, spacing, fontFamily } from '../theme/theme';
import HeaderBar, { CountPill } from '../theme/HeaderBar';
import { subscribeQueueChanges } from '../services/queueEvents';
import { getQueue, logout, ApiError, isOfflineError } from '../services/api';
import { useOffline, useOnReconnect } from '../services/connectivity';
import { getDraftStates } from '../storage/draftStorage';
import { normalizeRollId } from '../utils/rollId';
import { LaminationViewDialog, SlittingViewDialog } from './queue/JobViewDialogs';
import DeckleSelectDialog from './queue/DeckleSelectDialog';

// "1:05 PM"
const clockOf = ms => {
  const d = new Date(ms);
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};

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

// `hold` is { at, reason } when the job is on hold (Pause), `started` that it
// has been punched on this tablet and not ended.
function JobCard({ job, hold, started, onStart, onView }) {
  return (
    <View
      style={[
        styles.jobCard,
        { backgroundColor: ROW_TINT[job.materialStatus] || '#FFFFFF' },
        job.advance ? styles.jobCardAdvance : null,
      ]}>
      <View style={styles.jobHeaderRow}>
        {/* The lot number alone -- it already reads as "SP | LOT | 0001", so a
            "Lot" prefix in front of it just says the same word twice. */}
        <View style={styles.jobHeaderLeft}>
          <Text style={styles.jobLot}>{job.lotNo}</Text>
          {/* Paused: the operator put this job on hold with the job card's
              Pause. Slate, with the same pause glyph the job card's own
              button uses, so it reads as a state and not as another material
              chip -- and the same colour the office's WIP tab shows it in. */}
          {hold ? (
            <View style={styles.pausedBadge}>
              <Icon name="pause-circle" size={13} color={colors.holdText} />
              <Text style={styles.pausedBadgeText}>Paused</Text>
            </View>
          ) : null}
          {/* Advance: rolls set before their sales order was placed. The
              server flags it (buildQueueRows' `advance`) until the order
              comes in; the card keeps its material tint, the edge and this
              badge carry the flag. */}
          {job.advance ? (
            <View style={styles.advanceBadge}>
              <Icon name="calendar-clock" size={13} color="#FFFFFF" />
              <Text style={styles.advanceBadgeText}>Advance</Text>
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

      {hold ? (
        <Text style={styles.holdLine}>
          On hold since {clockOf(hold.at)}
          {hold.reason ? ` · ${hold.reason}` : ''}
        </Text>
      ) : null}

      {/* runningElsewhere comes from the server's job-running claim: the same
          operator signed in on another device already has this job open, so it
          reads as taken here rather than letting both punch the same job.
          Resume is the tap that takes the job off hold -- the job card does it
          as it opens (route param `resume`). View opens the layout read-only,
          and stays available whatever the job's state. */}
      <View style={styles.actionRow}>
        <ViewButton onPress={() => onView(job)} label={job.lotNo} />
        <TouchableOpacity
          onPress={() => job.canStart && !job.runningElsewhere && onStart(job, !!hold)}
          disabled={!job.canStart || job.runningElsewhere}
          style={[
            styles.startButton,
            styles.actionGrow,
            (!job.canStart || job.runningElsewhere) && styles.startButtonDisabled,
          ]}>
          <Text style={styles.startButtonText}>
            {job.runningElsewhere
              ? `In progress · ${job.runningOnLabel}`
              : job.canStart
              ? hold
                ? '▶ Resume'
                : started
                ? '▶ Continue'
                : '▶ Start'
              : 'Awaiting material'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// The read-only View button beside a card's Start. Outlined rather than filled
// so the green Start stays the one action a card leads with.
function ViewButton({ onPress, label }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`View job ${label}`}
      style={styles.viewButton}>
      <Icon name="eye-outline" size={15} color={colors.primary} />
      <Text style={styles.viewButtonText}>View</Text>
    </TouchableOpacity>
  );
}

// Slitting cards cut to the same knife layout are bundled under one wrapper in
// the queue. The server's `layoutSummary` already spells each card's layout as
// "150 + 200 + 150" (with " × n" when several Deckles run it, and " | " between
// distinct patterns), so that is the key -- minus the Deckle count, which says
// how much of it a card has, not what it is. A card with no layout never
// bundles. Groups keep the order of their first card.
const layoutKeyOf = card => String(card.layoutSummary || '').replace(/\s*×\s*\d+/g, '').trim();

const groupSlittingByLayout = cards => {
  const groups = [];
  const byKey = new Map();
  cards.forEach(card => {
    const key = layoutKeyOf(card) || `none-${card._id}`;
    let group = byKey.get(key);
    if (!group) {
      group = { key, layout: layoutKeyOf(card), cards: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.cards.push(card);
  });
  return groups;
};

// Which card of a group a scanned Deckle belongs to. A printed label's QR ends
// with the Roll ID (the older format starts with it) and a typed entry is the
// id itself, so matching against the group's own Deckle ids covers both; the
// longest match wins. Same rule as the job card's own matchDeckle.
const findScannedDeckle = (cards, raw) => {
  const compact = normalizeRollId(raw);
  if (!compact) {
    return null;
  }
  let best = null;
  cards.forEach(card =>
    (card.deckles || []).forEach(d => {
      const id = normalizeRollId(d.id);
      if (id && (compact === id || compact.endsWith(id) || compact.startsWith(id))) {
        if (!best || id.length > best.idLength) {
          best = { card, done: d.done, idLength: id.length };
        }
      }
    }),
  );
  return best;
};

// Several slitting cards cut to the same layout, as ONE tile -- the same shape
// as a single SlittingCard, headed by the widths and how many jobs it holds.
// Start opens a picker listing the group's jobs and the Deckles still to slit in
// each (DeckleSelectDialog); the chosen Deckle opens its job with that Deckle
// already confirmed. "Scan Deckle instead" keeps the original route -- scan the
// reel in front of them and the scan says which job it is.
function SlittingGroupCard({ group, onStart, note }) {
  const cards = group.cards;
  const sum = fn => cards.reduce((n, c) => n + (fn(c) || 0), 0);
  const deckles = sum(c => c.deckleCount);
  const done = sum(c => c.deckleDone);
  const rollsToMake = sum(c => c.plannedRolls - c.producedRolls);
  const curing = cards.filter(c => c.curing).length;
  const running = cards.some(c => c.running);
  return (
    <View style={[styles.jobCard, curing === cards.length ? styles.slittingCardCuring : styles.slittingCard]}>
      <View style={styles.jobHeaderRow}>
        <Text style={styles.groupLayout} numberOfLines={2}>
          {group.layout.split(/\s*\|\s*/).map(l => l.split(/\s*\+\s*/).join(' - ')).join('   |   ')}
        </Text>
        <View style={styles.jobProductPill}>
          <Text style={styles.jobProduct}>{cards.length} jobs</Text>
        </View>
      </View>
      <Text style={styles.jobLine}>
        Deckles: <Text style={styles.jobLineValue}>{deckles}</Text>, done:{' '}
        <Text style={styles.jobLineValue}>{done}</Text>, rolls to make:{' '}
        <Text style={styles.jobLineValue}>{rollsToMake}</Text>
      </Text>
      {curing > 0 ? (
        <View style={styles.chipRow}>
          <View style={[styles.chip, { backgroundColor: colors.noticeBg, borderColor: colors.noticeBorder }]}>
            <Text style={[styles.chipText, { color: colors.noticeText }]}>
              {curing === cards.length ? 'Curing' : `${curing} of ${cards.length} jobs curing`}
            </Text>
          </View>
        </View>
      ) : null}
      {note ? <Text style={styles.groupNote}>{note}</Text> : null}
      <TouchableOpacity onPress={() => onStart(group)} style={styles.startButton}>
        <Text style={styles.startButtonText}>{running ? '▶ Resume' : '▶ Start · Select Job'}</Text>
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
function SlittingCard({ card, onOpen, onView }) {
  const left = card.deckleLeft;
  const rollsToMake = card.plannedRolls - card.producedRolls;
  return (
    <View
      style={[
        styles.jobCard,
        card.curing ? styles.slittingCardCuring : styles.slittingCard,
      ]}>
      <View style={styles.jobHeaderRow}>
        {/* Lot leads, with the card's own slitting-job id as a quiet caption
            beneath it -- the same primary/secondary identity block a lamination
            tile leads with, rather than the id dangling on its own line under
            the header. */}
        <View style={styles.jobHeaderLeft}>
          <View style={styles.slittingIdentity}>
            <Text style={styles.jobLot} numberOfLines={1}>
              {card.lotNo}
            </Text>
            <Text style={styles.slittingCardId} numberOfLines={1}>
              {card.slittingJobCardId}
            </Text>
          </View>
        </View>
        <View style={styles.jobProductPill}>
          <Text style={styles.jobProduct}>{card.productCode}</Text>
        </View>
      </View>
      <Text style={styles.jobLine}>
        Deckles: <Text style={styles.jobLineValue}>{card.deckleCount}</Text>, done:{' '}
        <Text style={styles.jobLineValue}>{card.deckleDone}</Text>, rolls to make:{' '}
        <Text style={styles.jobLineValue}>{rollsToMake}</Text>
      </Text>

      {/* Curing is the one gate on running this card, so it is the one thing
          that gets a chip: notice amber while a Deckle is still curing. Once
          every pending Deckle has cured the card is ready to run, which the
          green card background says on its own -- no chip. */}
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
      <View style={styles.actionRow}>
        <ViewButton onPress={() => onView(card)} label={card.lotNo} />
        <TouchableOpacity onPress={() => onOpen(card)} style={[styles.startButton, styles.actionGrow]}>
          <Text style={styles.startButtonText}>
            {card.running ? '▶ Resume' : card.deckleDone > 0 ? `▶ Continue · ${left} left` : '▶ Start'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default function QueueScreen({ navigation, onLoggedOut, scannedCode, onScanHandled }) {
  const [queue, setQueue] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  // What this tablet's drafts say about each listed job -- on hold, or started
  // here (storage/draftStorage.js's getDraftStates). Recomputed on every load,
  // so coming back from a job that was just paused shows it, and ending a job
  // (which clears its draft) drops the badge again.
  const [draftStates, setDraftStates] = useState({});
  // The row whose View dialog is open, tagged with its kind so the matching
  // dialog shows it. null while no dialog is open.
  const [viewing, setViewing] = useState(null);
  const offline = useOffline();
  // The group whose Start opened the scanner, and what to tell the operator
  // when the scan was not a Deckle of it.
  const scanGroupRef = useRef(null);
  const [groupNote, setGroupNote] = useState(null);

  // The group whose Deckle picker is open, or null.
  const [pickGroup, setPickGroup] = useState(null);

  const startGroup = group => {
    const live = group.cards.find(c => c.running);
    if (live) {
      navigation.navigate('SlittingJobCard', { cardId: live._id });
      return;
    }
    setGroupNote(null);
    setPickGroup(group);
  };

  // A Deckle picked in the dialog opens its job with that Deckle handed over to
  // be confirmed -- the same hand-off a scan makes below.
  const selectDeckle = ({ card, deckleId }) => {
    setPickGroup(null);
    navigation.navigate('SlittingJobCard', { cardId: card._id, armDeckle: deckleId });
  };

  const scanForGroup = () => {
    const group = pickGroup;
    setPickGroup(null);
    if (!group) {
      return;
    }
    scanGroupRef.current = group;
    navigation.navigate('Scan', { returnTo: 'Home' });
  };

  // The scan comes back to Home as a param. Find its job inside the group that
  // asked and open it with that Deckle handed over to be confirmed.
  useEffect(() => {
    const group = scanGroupRef.current;
    if (!scannedCode || !group) {
      return;
    }
    scanGroupRef.current = null;
    onScanHandled && onScanHandled();
    const hit = findScannedDeckle(group.cards, scannedCode);
    if (!hit) {
      setGroupNote({ key: group.key, message: "That Deckle isn't in this group — scan one of its Deckles." });
    } else if (hit.done) {
      setGroupNote({ key: group.key, message: 'That Deckle has already been slit.' });
    } else {
      navigation.navigate('SlittingJobCard', { cardId: hit.card._id, armDeckle: scannedCode });
    }
  }, [scannedCode, onScanHandled, navigation]);

  const load = useCallback(async () => {
    try {
      const data = await getQueue();
      setQueue(data);
      // Read against the jobs actually listed, so a draft left behind by a job
      // that has since left the queue is never looked up.
      const listedIds = (data?.groups || []).flatMap(group =>
        (group.jobs || []).map(job => job._id),
      );
      setDraftStates(await getDraftStates(listedIds));
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
      // The server tells this tablet the moment a job is allocated to (or taken
      // off) this operator, so the list updates itself -- nothing polls.
      return subscribeQueueChanges(load);
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
                  {groupSlittingByLayout(cards).map(group => {
                    if (group.cards.length > 1) {
                      // Same layout on several cards: one tile for the lot.
                      return (
                        <SlittingGroupCard
                          key={group.key}
                          group={group}
                          onStart={startGroup}
                          note={groupNote?.key === group.key ? groupNote.message : null}
                        />
                      );
                    }
                    const sCard = group.cards[0];
                    return (
                      <SlittingCard
                        key={sCard._id}
                        card={sCard}
                        onOpen={selected => navigation.navigate('SlittingJobCard', { cardId: selected._id })}
                        onView={selected => setViewing({ kind: 'slitting', row: selected })}
                      />
                    );
                  })}
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
            {group.jobs.map(job => {
              const local = draftStates?.[String(job._id)];
              // On hold by this tablet's own Pause (which may not have reached
              // the server yet) or by the server's (paused on another device).
              const hold =
                local?.paused ||
                (job.paused?.since ? { at: new Date(job.paused.since).getTime(), reason: job.paused.reason } : null);
              return (
                <JobCard
                  key={job._id}
                  job={job}
                  hold={hold}
                  started={!!local?.started}
                  onStart={(selected, resume) =>
                    navigation.navigate('JobCard', { pendingId: selected._id, resume: resume || undefined })
                  }
                  onView={selected => setViewing({ kind: 'lamination', row: selected })}
                />
              );
            })}
          </View>
        )}
      />

      <LaminationViewDialog
        job={viewing?.kind === 'lamination' ? viewing.row : null}
        onClose={() => setViewing(null)}
      />
      <SlittingViewDialog
        row={viewing?.kind === 'slitting' ? viewing.row : null}
        onClose={() => setViewing(null)}
      />
      <DeckleSelectDialog
        visible={!!pickGroup}
        group={pickGroup}
        onSelect={selectDeckle}
        onScan={scanForGroup}
        onCancel={() => setPickGroup(null)}
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
    backgroundColor: colors.holdBg,
    borderWidth: 1,
    borderColor: colors.holdBorder,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  holdLine: { fontSize: 12, fontWeight: '600', color: colors.holdText, marginBottom: spacing.sm, fontFamily },
  jobCardAdvance: { borderLeftWidth: 5, borderLeftColor: colors.advance },
  advanceBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.advance,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  advanceBadgeText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#FFFFFF',
    fontFamily,
  },
  pausedBadgeText: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.holdText,
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
  // short of -- the material IS the allocated Deckle). Curing is their one
  // gate: notice amber while a Deckle is still curing, and the same match
  // green a fully-allotted lamination tile takes once it has cured and is
  // ready to run.
  groupLayout: { flex: 1, fontSize: 18, fontWeight: '800', color: colors.primary, fontFamily },
  groupNote: { fontSize: 12.5, fontWeight: '600', color: colors.dangerStrong, marginBottom: spacing.sm, fontFamily },
  slittingCard: { backgroundColor: colors.rowMatchBg },
  slittingCardCuring: { backgroundColor: colors.noticeBg, borderColor: colors.noticeBorder },
  // The lot + id identity block in the header-left. Stacked (column) so the id
  // sits as a caption directly under the lot; flexShrink lets a long lot
  // ellipsise rather than shoving the product pill off the card.
  slittingIdentity: { flexShrink: 1 },
  slittingCardId: { fontSize: 11, fontWeight: '600', color: colors.textMuted, marginTop: 1, fontFamily },
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
  // Card footer: View beside Start, Start taking the rest of the row.
  actionRow: { flexDirection: 'row', alignItems: 'stretch', gap: spacing.sm },
  actionGrow: { flex: 1 },
  viewButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    borderWidth: 1.5,
    borderColor: colors.primary,
    borderRadius: radii.sm,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
  },
  viewButtonText: { color: colors.primary, fontWeight: '700', fontSize: 12.5, fontFamily },
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
