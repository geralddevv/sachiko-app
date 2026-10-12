import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, AppState } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { colors, radii, spacing, fontFamily } from '../theme/theme';
import Card from '../theme/Card';
import Button from '../theme/Button';
import AppDialog from '../theme/AppDialog';
import Toast, { useToast } from '../theme/Toast';
import JobSettingRow from './jobcard/JobSettingRow';
import PauseDialog from './jobcard/PauseDialog';
import DeckleWebStrip from './slitting/DeckleWebStrip';
import ScanDeckleStrip from './slitting/ScanDeckleStrip';
import SlittingDeckleRow, { rowMeter, curedNow } from './slitting/SlittingDeckleRow';
import SlittingLayoutDialog from './slitting/SlittingLayoutDialog';
import {
  getSlittingCard,
  saveSlittingSetting,
  swapSlittingDeckle,
  reorderSlittingCuts,
  startSlittingRow,
  produceSlittingRow,
  editSlittingJoint,
  claimSlitting,
  heartbeatSlitting,
  settingStartSlitting,
  settingStopSlitting,
  pauseSlitting,
  resumeSlitting,
  ApiError,
} from '../services/api';
import { normalizeRollId } from '../utils/rollId';
import { validateStartMtrs, validateStopMtrs, fmtMtrs } from '../utils/meters';
import { playScanSuccess, playScanError } from '../utils/scanFeedback';
import { getJson, setJson, removeJson } from '../storage/jsonStorage';
import { STORAGE_KEYS } from '../constants/storageKeys';
import { printQueue } from '../services/printQueue';
import {
  startDeckle as startOvertimeTimer,
  stopRun as stopOvertimeTimer,
  pauseJob as pauseOvertimeTimers,
  resumeJob as resumeOvertimeTimers,
  startBreak as startBreakTimer,
} from '../services/overtimeReminder';

// The SLITTING job card -- the step AFTER lamination. JobCardScreen turns raw
// reels into Deckles (Semi Finished Goods); this one cuts one of those webs
// into the finished roll widths a client order asked for, which land in
// Finished Goods.
//
// Everything on this screen was fixed by the planner on the web's Slitting
// Allocation page (/sachiko/slitting/allocate/:pendingId?deckle=…&layout=…):
// which machine, which operator, and per Deckle its web width, the metres to
// run, the length per finished roll and the A..L knife layout. NOTHING here is
// a picker. The operator confirms the reel in their hands, punches the clock,
// and each Stop inwards that row's rolls.
//
// Ported from the web operator card it mirrors (views/inventory/masters/
// slittingJobCardForm.ejs) and shaped like this app's own lamination card, so
// the two read as one product: a summary strip, Job Setting behind a Start
// Production gate, then the punch rows.
//
// The one structural difference from JobCardScreen, and it matters: every
// punch here goes STRAIGHT to the server (row/start, row/produce) rather than
// being drafted locally and saved at the end. A slitting card is per-Deckle
// and its Stop is the stock movement itself, so there is no end-of-job save to
// batch into -- and therefore no local draft to lose.

const emptyJsRow = () => ({ mtrs1: '', startTime: '', mtrs2: '', stopTime: '' });
const emptyDraft = () => ({ startMtrs: '', stopMtrs: '', joint: '', jointMtr: '' });

const round2 = n => Math.round(Number(n) * 100) / 100;

// Which row a scanned/typed id identifies. A printed label's QR payload ENDS
// with the Roll ID (the older format STARTS with it) and a typed entry is the
// id itself, so matching against this card's own allocated ids covers every
// case without re-running the full Roll ID grammar. Longest match wins, so an
// id that is a suffix of another can't shadow it. Same rule as the web card's
// matchDeckle.
const matchDeckle = (rows, raw) => {
  const compact = normalizeRollId(raw);
  if (!compact) {
    return null;
  }
  const hits = rows
    .map((r, i) => ({ i, id: normalizeRollId(r.deckleId) }))
    .filter(x => x.id && (compact === x.id || compact.endsWith(x.id) || compact.startsWith(x.id)))
    .sort((a, b) => b.id.length - a.id.length);
  return hits.length ? hits[0].i : null;
};

// Decks that share the SAME knife layout -- the same roll widths in the same
// order -- are drawn once, bundled under one wrapper, rather than repeating an
// identical strip per Deckle. The web/reel width is deliberately NOT part of the
// key: each reel carries its own size, so two decks can run the very same knife
// layout on webs that differ by a few mm. Groups keep the order of their first
// member; a lone Deckle is a group of one (drawn as before).
const layoutKey = row =>
  (row.cuts || [])
    .filter(c => Number(c.width) > 0)
    .map(c => round2(c.width))
    .join('+');

const groupByLayout = rows => {
  const groups = [];
  const byKey = new Map();
  rows.forEach((row, index) => {
    // A deck with no roll widths has no layout to share.
    const key = layoutKey(row) || `none-${index}`;
    let group = byKey.get(key);
    if (!group) {
      group = { key, items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push({ row, index });
  });
  return groups;
};

const dashed = value =>
  value === null || value === undefined || String(value).trim() === '' ? '—' : String(value);

export default function SlittingJobCardScreen({ route, navigation }) {
  const { cardId } = route.params;
  const [card, setCard] = useState(null);
  const [rows, setRows] = useState([]);
  const [jobSetting, setJobSetting] = useState([emptyJsRow()]);
  const [productionStarted, setProductionStarted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [savingSetting, setSavingSetting] = useState(false);
  // The row the scan has confirmed -- and the only one whose Start is live.
  const [armedIndex, setArmedIndex] = useState(null);
  // Per-row counter readings and joint note, by row index. Not yet facts about
  // the row: they become those at the punch that commits them.
  const [drafts, setDrafts] = useState({});
  const [scanStatus, setScanStatus] = useState({ tone: '', message: 'Scan the Deckle you are about to run.' });
  const [scanBusy, setScanBusy] = useState(false);
  const [busyIndex, setBusyIndex] = useState(null);
  const [editingJsIndex, setEditingJsIndex] = useState(null);
  const [editingRowIndex, setEditingRowIndex] = useState(null);
  // Row whose knife layout is being re-arranged (index into `rows`), or null.
  const [layoutIndex, setLayoutIndex] = useState(null);
  const [layoutSaving, setLayoutSaving] = useState(false);
  const [dialog, setDialog] = useState(null);
  // On hold -- { reason } while this device has the card paused. The office's
  // Slitting WIP page shows it ON HOLD; any punch (or Resume) ends it.
  const [paused, setPaused] = useState(null);
  const [pauseDialogOpen, setPauseDialogOpen] = useState(false);
  const { toast, showToast, hideToast } = useToast();
  // Bumped once a minute while something is still curing, purely to re-run the
  // clock check in curedNow -- a card left open on the machine should unlock
  // itself when the six hours pass rather than needing a reload.
  const [, setCuringTick] = useState(0);
  const scanTargetRef = useRef(null);
  // Has the operator actually touched Job Setting since this card loaded?
  // Gates the quiet re-save below, so merely OPENING a card that is already
  // past the gate never posts a Job Setting it didn't have.
  const jsDirtyRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await getSlittingCard(cardId);
      const loaded = res.card;
      setCard(loaded);
      setRows(loaded.rows || []);

      const savedJs = Array.isArray(loaded.jobSetting) ? loaded.jobSetting : [];
      setJobSetting(savedJs.length ? savedJs.map(r => ({ ...emptyJsRow(), ...r })) : [emptyJsRow()]);

      // Skip the Job Setting gate entirely once it has already been cleared --
      // either the setting is saved with every row punched, or a Deckle has
      // already been worked. A card reopened mid-run must never get stuck
      // behind Job Setting again. Same two tests the web card makes on load.
      const jsAlreadyDone = savedJs.length > 0 && savedJs.every(r => r.startTime && r.stopTime);
      const alreadyRunning = (loaded.rows || []).some(r => r.startTime || r.status === 'done');
      setProductionStarted(jsAlreadyDone || alreadyRunning);

      // The first Deckle's Start reading is left blank for the operator to key
      // in -- Job Setting's last Stop reading is NOT carried over into the
      // Production Log automatically.
      setDrafts({});

      // Restore the Deckle this card had scanned/confirmed when it was last left
      // (kept per card in AsyncStorage), falling back to a row already running --
      // so the Scan Deckle field shows the confirmed Deckle again instead of
      // going blank every time the card is reopened.
      const rowsArr = loaded.rows || [];
      let armIdx = null;
      try {
        const saved = await getJson(STORAGE_KEYS.SLITTING_ARMED_PREFIX + cardId, null);
        if (saved && Number.isInteger(saved.index) && rowsArr[saved.index] && rowsArr[saved.index].status !== 'done') {
          armIdx = saved.index;
        }
      } catch (e) {
        // ignore a bad/corrupt stored value -- fall back below
      }
      if (armIdx === null) {
        const runningIdx = rowsArr.findIndex(r => r.status !== 'done' && r.startTime);
        if (runningIdx >= 0) armIdx = runningIdx;
      }
      if (armIdx !== null) {
        setArmedIndex(armIdx);
        setScanStatus({ tone: 'ok', message: `${rowsArr[armIdx].deckleId} confirmed — punch Start when the machine runs.` });
      }
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Could not load this slitting card.');
    } finally {
      setLoading(false);
    }
  }, [cardId]);

  useEffect(() => {
    load();
  }, [load]);

  // Claim this card for this device and keep the claim fresh while the screen is
  // open -- the office's Slitting WIP page reads it as "operator app online" and
  // lists the card as running. Best-effort: a lost claim never blocks the floor.
  // Android freezes JS timers while the screen is off, so a beat is also sent the
  // moment the app returns to the foreground.
  useEffect(() => {
    if (!card) {
      return undefined;
    }
    claimSlitting(cardId).catch(() => {});
    const beat = () => heartbeatSlitting(cardId).catch(() => {});
    const timer = setInterval(beat, 60000);
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') beat();
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
  }, [card, cardId]);

  // Pause / Resume -- the operator stepping away without ending the card. The
  // office's WIP page then shows it ON HOLD and freezes its clock. Any punch also
  // ends the hold server-side, so the local flag is cleared on every punch too.
  const handlePause = () => setPauseDialogOpen(true);
  const confirmPause = reason => {
    setPauseDialogOpen(false);
    setPaused({ reason });
    pauseSlitting({ cardId, reason }).catch(() => {});
    pauseOvertimeTimers(cardId);
    // Tea / Lunch Break: the "break is over" alarm is timed from this tap.
    startBreakTimer({ jobId: cardId, reason, label: card.slittingJobCardId, machineName: card.machineName });
  };
  const handleResume = () => {
    setPaused(null);
    resumeSlitting({ cardId }).catch(() => {});
    resumeOvertimeTimers(cardId);
  };
  const clearPaused = () => setPaused(p => (p ? null : p));
  // End Job just leaves the card: unlike the lamination card there is no
  // end-of-run save to make -- every Deckle is inwarded the moment its Stop is
  // punched -- so this only closes the card, which stays in the queue until its
  // last Deckle is slit. Named to match the coating card's own End Job button.
  const handleEndJob = () => navigation.navigate('Home');

  const anyCuring = rows.some(r => r.status !== 'done' && !curedNow(r));
  useEffect(() => {
    if (!anyCuring) {
      return undefined;
    }
    const timer = setInterval(() => setCuringTick(t => t + 1), 60000);
    return () => clearInterval(timer);
  }, [anyCuring]);

  // The QR payload scanned in the Scan modal comes back as a navigation param,
  // raw and unparsed -- the same handshake JobCardScreen uses, with `returnTo`
  // naming this screen so the modal pops back here rather than to the
  // lamination card.
  useEffect(() => {
    const scanned = route.params?.scannedCode;
    if (scanned && scanTargetRef.current) {
      const cb = scanTargetRef.current;
      scanTargetRef.current = null;
      navigation.setParams({ scannedCode: undefined });
      cb(scanned);
    }
  }, [route.params?.scannedCode, navigation]);

  const setDraft = (index, field, value) =>
    setDrafts(d => ({ ...d, [index]: { ...emptyDraft(), ...d[index], [field]: value } }));

  const draftFor = index => drafts[index] || emptyDraft();

  const patchRow = (index, patch) =>
    setRows(list => list.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  // ── Layout ─────────────────────────────────────────────────────────────
  // The operator may lay the same knife widths out in a different order across
  // the web (210+210+230 -> 210+230+210) until that Deckle is started. Saved
  // server-side, so the rolls minted at Stop (<deckle>-<slot>) follow it.
  const layoutEditable = row =>
    row.status !== 'done' && !row.startTime && (row.cuts || []).filter(c => Number(c.width) > 0).length > 1;

  const saveLayout = async order => {
    const index = layoutIndex;
    if (index === null) {
      return;
    }
    setLayoutSaving(true);
    try {
      const res = await reorderSlittingCuts({ cardId, index, order });
      patchRow(index, { cuts: res.cuts });
      setLayoutIndex(null);
      showToast('Layout updated.', 'success');
    } catch (err) {
      setLayoutIndex(null);
      setDialog({
        tone: 'error',
        title: "Couldn't change the layout",
        message: err instanceof ApiError ? err.message : 'Please try again.',
      });
    } finally {
      setLayoutSaving(false);
    }
  };

  // ── Scan ───────────────────────────────────────────────────────────────
  // The confirmed Deckle is remembered per card (AsyncStorage) so the Scan
  // Deckle field survives leaving and reopening the card -- arming is a
  // client-side state with no server punch behind it (a plain match) until
  // Start, so without this it was lost every time the screen unmounted.
  const armedKey = STORAGE_KEYS.SLITTING_ARMED_PREFIX + cardId;
  const armRow = (index, message) => {
    playScanSuccess();
    setArmedIndex(index);
    setScanStatus({ tone: 'ok', message });
    setJson(armedKey, { index }).catch(() => {});
  };
  // Clear the armed Deckle, in state and in storage, together -- used by every
  // path that sets it back to "nothing confirmed" (a bad scan, Rescan, produce).
  const disarm = () => {
    setArmedIndex(null);
    removeJson(armedKey).catch(() => {});
  };

  // A scan doesn't have to be the exact Deckle the planner allocated -- any
  // free web of this card's Product Code and raw size can be run in its place,
  // and the server re-points the row at whatever was actually scanned (which
  // is also what frees the old reel and locks the new one to this card). Only
  // reached once the id fails to match a row already on the card.
  const armFrom = async raw => {
    const i = matchDeckle(rows, raw);
    if (i !== null) {
      if (rows[i].status === 'done') {
        playScanError();
        disarm();
        setScanStatus({ tone: 'bad', message: `${rows[i].deckleId} has already been run on this card.` });
        return;
      }
      if (!curedNow(rows[i])) {
        playScanError();
        disarm();
        const when = rows[i].curing?.curedAtLabel ? ` — ready at ${rows[i].curing.curedAtLabel}` : '';
        setScanStatus({
          tone: 'bad',
          message: `${rows[i].deckleId} is still curing (6 h after lamination)${when}. It can't be run yet.`,
        });
        return;
      }
      armRow(i, `${rows[i].deckleId} confirmed — punch Start when the machine runs.`);
      return;
    }

    const target = rows.findIndex(r => r.status !== 'done');
    if (target === -1) {
      playScanError();
      disarm();
      setScanStatus({ tone: 'bad', message: 'Every Deckle on this card has already been run.' });
      return;
    }

    setScanBusy(true);
    setScanStatus({ tone: '', message: 'Checking that reel…' });
    try {
      // Sent RAW: the server resolves a scan against stock itself (its own
      // findScannedReel), which is the only thing that can say where a
      // run-together label's Roll ID actually starts.
      const res = await swapSlittingDeckle({ cardId, index: target, rollId: raw });
      if (!res.unchanged && res.row) {
        patchRow(target, res.row);
      }
      const label = res.row?.deckleId || rows[target].deckleId;
      armRow(target, `${label} confirmed — punch Start when the machine runs.`);
    } catch (err) {
      playScanError();
      disarm();
      setScanStatus({
        tone: 'bad',
        message: err instanceof ApiError ? err.message : 'That Deckle is not on this card.',
      });
    } finally {
      setScanBusy(false);
    }
  };

  // Opened from a same-layout group tile on the queue, which already scanned the
  // Deckle to find this card: confirm it here exactly as a scan on this screen
  // would, once the card's rows have loaded. Once only.
  const handoffRef = useRef(false);
  useEffect(() => {
    const raw = route.params?.armDeckle;
    if (!raw || loading || loadError || !rows.length || handoffRef.current) {
      return;
    }
    handoffRef.current = true;
    navigation.setParams({ armDeckle: undefined });
    armFrom(raw);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.params?.armDeckle, loading, loadError, rows]);

  const openScan = () => {
    scanTargetRef.current = value => armFrom(value);
    navigation.navigate('Scan', { returnTo: 'SlittingJobCard' });
  };

  // Un-confirm the armed Deckle so the scan input comes back -- the operator
  // grabbed the wrong reel, or wants to run a different web. This also drops
  // the armed row's live Start (its gate is `armed`), which is correct: nothing
  // should be punchable until a Deckle is confirmed again.
  const rescan = () => {
    disarm();
    setScanStatus({ tone: '', message: 'Scan the Deckle you are about to run.' });
  };

  // ── Job Setting ────────────────────────────────────────────────────────
  const jsPayload = useCallback(
    () =>
      jobSetting.map(r => ({
        mtrs1: r.mtrs1,
        startTime: r.startTime,
        mtrs2: r.mtrs2,
        stopTime: r.stopTime,
      })),
    [jobSetting],
  );

  const touchJs = () => {
    jsDirtyRef.current = true;
  };

  const updateJsRow = (index, field, value) => {
    touchJs();
    setJobSetting(list => list.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  };
  const removeJsRow = index => {
    touchJs();
    setJobSetting(list => list.filter((_, i) => i !== index));
  };

  const startJsRow = (index, time) => {
    const error = validateStartMtrs(jobSetting[index]?.mtrs1);
    if (error) {
      showToast(error);
      return;
    }
    touchJs();
    clearPaused();
    setJobSetting(list => list.map((r, i) => (i === index ? { ...r, startTime: time } : r)));
    // Live JOB SETTING phase for the office's WIP page (bulk save still records
    // the readings). Fire-and-forget: a missed punch is re-stamped by the next.
    settingStartSlitting({ cardId, index, startTime: time, startMtrs: jobSetting[index]?.mtrs1 }).catch(() => {});
  };
  const stopJsRow = (index, time) => {
    const error = validateStopMtrs(jobSetting[index]?.mtrs1, jobSetting[index]?.mtrs2);
    if (error) {
      showToast(error);
      return;
    }
    touchJs();
    clearPaused();
    setJobSetting(list => list.map((r, i) => (i === index ? { ...r, stopTime: time } : r)));
    settingStopSlitting({ cardId, index }).catch(() => {});
  };

  const jobSettingComplete = jobSetting.length > 0 && jobSetting.every(r => r.startTime && r.stopTime);

  const handleStartProduction = async () => {
    setSavingSetting(true);
    try {
      await saveSlittingSetting({ cardId, rows: jsPayload() });
      jsDirtyRef.current = false;
      setProductionStarted(true);
      // The first Deckle's Start reading is left for the operator to key in --
      // Job Setting's last Stop reading is NOT carried into the Production Log.
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Couldn't save Job Setting.");
    } finally {
      setSavingSetting(false);
    }
  };

  // Once Production is open there is no Start Production button left to
  // re-submit Job Setting with, so a reading corrected up there saves itself.
  // The route overwrites jobSetting wholesale, so this is the same save,
  // quietly -- and a correction that doesn't reach the server is retried by
  // the next edit.
  useEffect(() => {
    if (!productionStarted || !card) {
      return undefined;
    }
    if (!jsDirtyRef.current) {
      return undefined;
    }
    const timer = setTimeout(() => {
      saveSlittingSetting({ cardId, rows: jsPayload() }).catch(() => {});
    }, 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobSetting, productionStarted, card, cardId]);

  // ── Punches ────────────────────────────────────────────────────────────
  const punchStart = async (index, time) => {
    const row = rows[index];
    const draft = draftFor(index);
    if (!curedNow(row)) {
      showToast("That Deckle is still curing — it can't be run yet.");
      return;
    }
    const error = validateStartMtrs(draft.startMtrs);
    if (error) {
      showToast(error);
      return;
    }
    setBusyIndex(index);
    clearPaused();
    try {
      const res = await startSlittingRow({
        cardId,
        index,
        startTime: time,
        startMtrs: Number(draft.startMtrs),
      });
      patchRow(index, { startTime: res.startTime || time, startMtrs: res.startMtrs ?? Number(draft.startMtrs) });
      // The overtime reminder times this Deckle from this punch, on the tablet:
      // its planned metres over the machine's speed (Machine Master).
      startOvertimeTimer({
        kind: 'slitting',
        jobId: cardId,
        runKey: index,
        deckleNo: index + 1,
        deckleId: row.deckleId,
        label: card.slittingJobCardId,
        machineName: card.machineName,
        mtrs: Number(row.plannedMeter) > 0 ? row.plannedMeter : row.meter,
        speedMpm: card.timing?.speedMpm,
        at: Date.now(),
      });
      showToast(`Started ${row.deckleId} at ${res.startTime || time}`, 'success');
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Couldn't record the start.");
    } finally {
      setBusyIndex(null);
    }
  };

  const commitStop = async (index, time, meter, runningMeter) => {
    const row = rows[index];
    const draft = draftFor(index);
    setBusyIndex(index);
    try {
      const res = await produceSlittingRow({
        cardId,
        index,
        meter,
        runningMeter,
        stopMtrs: Number(draft.stopMtrs),
        // Only used to fill in a row started before its reading was captured;
        // the server ignores it once the row has one.
        startMtrs: row.startMtrs ?? Number(draft.startMtrs),
        joint: draft.joint,
        jointMtr: draft.jointMtr,
        endTime: time,
      });

      stopOvertimeTimer('slitting', cardId, index);
      const producedIds = res.rollIds || [];
      setRows(list =>
        list.map((r, i) =>
          i === index
            ? {
                ...r,
                status: 'done',
                meter: res.meter,
                runningMeter: res.runningMeter,
                stopMtrs: res.stopMtrs ?? Number(draft.stopMtrs),
                endTime: res.endTime || time,
                joint: draft.joint || '',
                jointMtr: draft.jointMtr === '' ? null : Number(draft.jointMtr),
                reelMtrs: r.reelMtrs != null ? round2(Number(r.reelMtrs) - Number(res.meter || 0)) : r.reelMtrs,
                cuts: (r.cuts || []).map((c, n) => (producedIds[n] ? { ...c, rollId: producedIds[n] } : c)),
              }
            : r,
        ),
      );
      disarm();
      setScanStatus({ tone: '', message: 'Scan the next Deckle.' });

      // Auto-print each finished roll's label (A, B, C...), the same way the
      // lamination card auto-prints a produced Deckle: the print queue fetches
      // each label from the server and sends it to the connected printer.
      // Punching Stop never waits on the printer.
      (res.rolls || []).forEach(roll => {
        if (roll?.stockId) {
          printQueue.enqueue({ stockId: roll.stockId, rollId: roll.rollId, productCode: roll.productCode, kind: 'finished' });
        }
      });

      if (res.cardCompleted) {
        setDialog({
          tone: 'success',
          title: 'Card finished',
          message: `${producedIds.length} roll(s) are in Finished Stock. ${card.slittingJobCardId} is complete.`,
          buttons: [
            {
              label: 'Back to Queue',
              onPress: () => {
                setDialog(null);
                navigation.navigate('Home');
              },
            },
          ],
        });
      } else {
        showToast(`${producedIds.length} roll(s) inwarded from ${row.deckleId}.`, 'success');
      }
    } catch (err) {
      setDialog({
        tone: 'error',
        title: 'Not moved',
        message: err instanceof ApiError ? err.message : 'Failed to move these rolls to Finished Stock.',
        buttons: [{ label: 'OK', onPress: () => setDialog(null) }],
      });
    } finally {
      setBusyIndex(null);
    }
  };

  const punchStop = (index, time) => {
    const row = rows[index];
    const draft = draftFor(index);
    if (!curedNow(row)) {
      showToast("That Deckle is still curing — it can't be run yet.");
      return;
    }
    const startMtrs = row.startMtrs ?? draft.startMtrs;
    const mtrsError = validateStopMtrs(startMtrs, draft.stopMtrs);
    if (mtrsError) {
      showToast(mtrsError);
      return;
    }
    // The metres run IS the counter difference -- both ends are in hand, so
    // nothing is typed or confirmed separately (see rowMeter). A stop reading
    // level with the start one means nothing ran.
    const meter = rowMeter(startMtrs, draft.stopMtrs);
    if (meter === null || !(meter > 0)) {
      showToast(`Stop reading must be past the Start reading (${fmtMtrs(startMtrs)} m).`);
      return;
    }
    if (row.reelMtrs != null && meter > Number(row.reelMtrs)) {
      showToast(
        `Only ${fmtMtrs(row.reelMtrs)} m are left on this reel — that reading implies ${fmtMtrs(meter)} m.`,
      );
      return;
    }
    // The length wound on each finished roll is the plan's own fixed figure,
    // not the operator's to key in -- a row without one was never allocated
    // properly and has to go back to Slitting Allocation.
    const plannedRunningMeter = Number(row.plannedRunningMeter);
    if (!(plannedRunningMeter > 0)) {
      showToast('This Deckle has no R. Meter planned — ask the office to reopen its allocation.');
      return;
    }
    // A Deckle that ran short (damage, a break) winds shorter rolls: scale the
    // planned length by what actually came off, so the label and stock carry the
    // real metres instead of the planned figure. Never scaled up past the plan.
    const plannedMeter = Number(row.plannedMeter);
    const runningMeter =
      plannedMeter > 0 && meter < plannedMeter
        ? round2((plannedRunningMeter * meter) / plannedMeter)
        : plannedRunningMeter;

    const rollCount = (row.cuts || []).filter(c => Number(c.width) > 0).length;
    setDialog({
      tone: 'info',
      title: 'Move roll(s) to Finished Stock?',
      message:
        `${row.deckleId} — ${fmtMtrs(meter)} m off the Deckle, ` +
        `${rollCount} roll${rollCount === 1 ? '' : 's'} of ${fmtMtrs(runningMeter)} m in.`,
      buttons: [
        { label: 'Cancel', variant: 'ghost', onPress: () => setDialog(null) },
        {
          label: 'Confirm',
          onPress: () => {
            setDialog(null);
            commitStop(index, time, meter, runningMeter);
          },
        },
      ],
    });
  };

  // Corrects the Joint note on an already-run row -- the one part of a
  // finished row's record that isn't tied to a stock movement. The metres and
  // the produced roll ids moved stock at Stop and are never reopened.
  const saveJointEdit = async index => {
    const draft = draftFor(index);
    try {
      const res = await editSlittingJoint({
        cardId,
        index,
        joint: draft.joint,
        jointMtr: draft.jointMtr,
      });
      patchRow(index, { joint: res.joint ?? draft.joint, jointMtr: res.jointMtr ?? null });
      setEditingRowIndex(null);
      showToast('Joint note updated.', 'success');
    } catch (err) {
      showToast(err instanceof ApiError ? err.message : "Couldn't save the joint note.");
    }
  };

  const layoutGroups = useMemo(() => groupByLayout(rows), [rows]);
  const pendingRows = useMemo(() => rows.filter(r => r.status !== 'done'), [rows]);
  const totalPlannedRolls = useMemo(
    () => rows.reduce((n, r) => n + (r.cuts || []).filter(c => Number(c.width) > 0).length, 0),
    [rows],
  );

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  if (loadError) {
    return (
      <View style={styles.centered}>
        <Text style={styles.loadErrorText}>{loadError}</Text>
        <Button title="Back to Queue" onPress={() => navigation.navigate('Home')} style={styles.backButton} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <KeyboardAwareScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        enableOnAndroid
        extraScrollHeight={24}
        keyboardShouldPersistTaps="handled">
        {/* The figures the operator runs the card against, in the lamination
            card's own summary shape: small uppercase label over a big bold
            value. R. Meter is the length wound on EACH finished roll, which is
            what the machine is set to -- not the metres coming off the web. */}
        <Card title={card.slittingJobCardId}>
          <View style={styles.midRow}>
            <MidItem label="LS Stock" value={card.productCode} />
            <MidItem label="Machine" value={card.machineName} />
            <MidItem label="R. Meter" value={rows[0]?.plannedRunningMeter} />
            <MidItem label="Rolls" value={totalPlannedRolls} />
          </View>
        </Card>

        <View style={styles.spacer} />

        {/* What the planner fixed on Slitting Allocation, read straight off
            the card's own rows. Purely descriptive -- nothing here is this
            screen's to change. */}
        <Card title="Deckle Description">
          {layoutGroups.map((group, g) => {
            const renderHead = ({ row, index }) => (
              <View style={styles.descHead}>
                <Text style={[styles.descDeckleId, row.status === 'done' && styles.descDone]} numberOfLines={1}>
                  {dashed(row.deckleId)}
                  {row.status === 'done' ? ' · done' : ''}
                </Text>
                <Text style={styles.descMeta}>
                  {fmtMtrs(row.width)} mm · {fmtMtrs(row.plannedMeter)} m
                </Text>
                {layoutEditable(row) ? (
                  <TouchableOpacity
                    style={styles.rearrangeBtn}
                    activeOpacity={0.7}
                    onPress={() => setLayoutIndex(index)}
                    accessibilityLabel={`Reorder the layout of ${row.deckleId}`}>
                    <Icon name="swap-horizontal" size={14} color={colors.primary} />
                    <Text style={styles.rearrangeText}>Reorder</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            );

            if (group.items.length === 1) {
              const item = group.items[0];
              return (
                <View key={group.key} style={[styles.descRow, g > 0 && styles.descRowDivider]}>
                  {renderHead(item)}
                  <DeckleWebStrip row={item.row} />
                </View>
              );
            }

            // Same layout on several Deckles: one grouped card. Header names the
            // layout and how many Deckles run it, the strip is drawn once, and
            // every Deckle that runs it is a numbered row underneath.
            const doneCount = group.items.filter(({ row }) => row.status === 'done').length;
            const totalMeter = group.items.reduce((n, { row }) => n + (Number(row.plannedMeter) || 0), 0);
            return (
              <View key={group.key} style={[styles.descRow, g > 0 && styles.descRowDivider]}>
                <View style={styles.bundle}>
                  <View style={styles.bundleAccent} />
                  <View style={styles.bundleBody}>
                    <View style={styles.bundleHeader}>
                      <View style={styles.bundleIcon}>
                        <Icon name="layers-triple-outline" size={18} color={colors.primary} />
                      </View>
                      <View style={styles.bundleHeadText}>
                        <Text style={styles.bundleEyebrow}>SHARED LAYOUT</Text>
                        <Text style={styles.bundleTitle} numberOfLines={2}>
                          {group.key.split('+').join('  ·  ')} mm
                        </Text>
                      </View>
                      <View style={styles.bundleCount}>
                        <Text style={styles.bundleCountNum}>{group.items.length}</Text>
                        <Text style={styles.bundleCountText}>Deckles</Text>
                      </View>
                    </View>

                    <View style={styles.bundleStrip}>
                      <DeckleWebStrip row={group.items[0].row} />
                    </View>

                    <Text style={styles.bundleListLabel}>RUNS ON</Text>
                    <View style={styles.bundleList}>
                      {group.items.map(({ row, index }, i) => {
                        const done = row.status === 'done';
                        return (
                          <View key={index} style={[styles.bundleItem, i > 0 && styles.bundleItemDivider]}>
                            <View style={[styles.bundleNum, done && styles.bundleNumDone]}>
                              {done ? (
                                <Icon name="check" size={13} color="#FFFFFF" />
                              ) : (
                                <Text style={styles.bundleNumText}>{i + 1}</Text>
                              )}
                            </View>
                            <View style={styles.bundleItemMain}>
                              <Text style={[styles.bundleItemId, done && styles.descDone]} numberOfLines={1}>
                                {dashed(row.deckleId)}
                              </Text>
                              <Text style={styles.descMeta} numberOfLines={1}>
                                {fmtMtrs(row.width)} mm web · {fmtMtrs(row.plannedMeter)} m
                              </Text>
                            </View>
                            <View style={[styles.statusChip, done ? styles.statusChipDone : styles.statusChipPending]}>
                              <Text style={[styles.statusChipText, done ? styles.statusTextDone : styles.statusTextPending]}>
                                {done ? 'Done' : 'Pending'}
                              </Text>
                            </View>
                            {layoutEditable(row) ? (
                              <TouchableOpacity
                                style={styles.reorderIconBtn}
                                activeOpacity={0.7}
                                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                                onPress={() => setLayoutIndex(index)}
                                accessibilityLabel={`Reorder the layout of ${row.deckleId}`}>
                                <Icon name="swap-horizontal" size={18} color={colors.primary} />
                              </TouchableOpacity>
                            ) : null}
                          </View>
                        );
                      })}
                    </View>

                    <View style={styles.bundleFooter}>
                      <Text style={styles.bundleFooterText}>
                        {doneCount} of {group.items.length} done
                      </Text>
                      <Text style={styles.bundleFooterTotal}>Total {fmtMtrs(totalMeter)} m</Text>
                    </View>
                  </View>
                </View>
              </View>
            );
          })}
        </Card>

        <View style={styles.spacer} />

        {/* The gate on every Start below. A slit run names its finished rolls
            after the physical Deckle it came off, so the reel has to be read
            and matched before the clock can be punched. */}
        <Card title="Scan Deckle">
          <ScanDeckleStrip
            status={scanStatus}
            busy={scanBusy}
            confirmed={armedIndex !== null}
            confirmedId={armedIndex !== null ? dashed(rows[armedIndex]?.deckleId) : ''}
            onSubmit={armFrom}
            onScanRequest={openScan}
            onRescan={rescan}
          />
        </Card>

        <View style={styles.spacer} />

        {/* Setup wastage before the first Deckle is cut, measured off the
            machine's own counter. Same shape, name and gate as the lamination
            card's Job Setting -- and the same component. */}
        <Card title="Job Setting">
          {jobSetting.map((row, index) => (
            <JobSettingRow
              key={index}
              row={row}
              index={index}
              // No material gate here: slitting's material IS the allocated
              // Deckle, confirmed in its own step above, so there is nothing
              // to mount before a setup punch.
              materialsReady
              editing={editingJsIndex === index}
              onToggleEdit={() => setEditingJsIndex(i => (i === index ? null : index))}
              onChange={(field, value) => updateJsRow(index, field, value)}
              onRemove={jobSetting.length > 1 ? () => removeJsRow(index) : null}
              onStart={time => startJsRow(index, time)}
              onStop={time => stopJsRow(index, time)}
            />
          ))}
          <TouchableOpacity
            style={styles.addRowButton}
            onPress={() => {
              touchJs();
              setJobSetting(list => [...list, emptyJsRow()]);
            }}>
            <Text style={styles.addRowText}>+ Add Row</Text>
          </TouchableOpacity>
        </Card>

        {productionStarted ? (
          <>
            <View style={styles.spacer} />
            <Card title="Production Log">
              {rows.map((row, index) => (
                <SlittingDeckleRow
                  key={index}
                  row={row}
                  index={index + 1}
                  armed={armedIndex === index}
                  draft={draftFor(index)}
                  busy={busyIndex === index}
                  editing={editingRowIndex === index}
                  // Only a finished row is editable, and only its joint note --
                  // a second tap saves it. A row still to run has no pencil.
                  onToggleEdit={
                    row.status === 'done'
                      ? () => {
                          if (editingRowIndex === index) {
                            saveJointEdit(index);
                            return;
                          }
                          setDrafts(d => ({
                            ...d,
                            [index]: {
                              ...emptyDraft(),
                              ...d[index],
                              joint: row.joint || '',
                              jointMtr: row.jointMtr == null ? '' : String(row.jointMtr),
                            },
                          }));
                          setEditingRowIndex(index);
                        }
                      : null
                  }
                  onDraftChange={(field, value) => setDraft(index, field, value)}
                  onStart={time => punchStart(index, time)}
                  onStop={time => punchStop(index, time)}
                />
              ))}
              {!pendingRows.length ? (
                <Text style={styles.allDoneText}>
                  Every Deckle on this card has been slit — its rolls are in Finished Stock.
                </Text>
              ) : null}
            </Card>

            <Text style={styles.hintText}>
              {pendingRows.length
                ? 'Every punch is already saved — this card stays in your queue until its last Deckle is slit.'
                : 'Nothing left to run on this card.'}
            </Text>
          </>
        ) : jobSettingComplete ? (
          <>
            <View style={styles.spacer} />
            <Button
              title="Start Production"
              icon="play"
              variant="success"
              loading={savingSetting}
              onPress={handleStartProduction}
            />
          </>
        ) : (
          <Text style={styles.hintText}>
            Punch Start and Stop on every Job Setting row to unlock Production.
          </Text>
        )}

        <View style={styles.spacer} />

        {/* Pause + End Job at the bottom -- the two ways out of a running card,
            the same pair the coating card shows (JobCardScreen's jobActionsRow).
            Pause keeps it in the queue and freezes its clock on the office's WIP
            page; every Deckle is already saved as it's slit, so End Job just
            closes the card. */}
        <View style={styles.jobActionsRow}>
          <Button
            title={paused ? 'Resume' : 'Pause'}
            icon={paused ? 'play' : 'pause'}
            variant={paused ? 'hold' : 'outline'}
            size="sm"
            onPress={paused ? handleResume : handlePause}
            style={styles.jobActionButton}
          />
          <Button
            title="End Job"
            icon="check"
            size="sm"
            onPress={handleEndJob}
            style={styles.jobActionButton}
          />
        </View>
        <Text style={styles.jobActionsHint}>
          {paused ? 'On hold — Resume to carry on. ' : ''}Pause keeps this card in your queue. Every Deckle is saved as it's slit — End Job just closes the card.
        </Text>

        <View style={styles.spacer} />

        <SlittingLayoutDialog
          visible={layoutIndex !== null}
          row={layoutIndex !== null ? rows[layoutIndex] : null}
          saving={layoutSaving}
          onCancel={() => setLayoutIndex(null)}
          onSave={saveLayout}
        />

        <AppDialog
          visible={!!dialog}
          tone={dialog?.tone}
          title={dialog?.title}
          message={dialog?.message}
          buttons={dialog?.buttons}
          onRequestClose={() => setDialog(null)}
        />
      </KeyboardAwareScrollView>

      <PauseDialog visible={pauseDialogOpen} onPause={confirmPause} onCancel={() => setPauseDialogOpen(false)} />

      <Toast toast={toast} onHide={hideToast} />
    </View>
  );
}

// One cell of the summary row -- the same small-label-over-big-value pair the
// lamination card's own summary uses, so the two cards read alike.
function MidItem({ label, value }) {
  return (
    <View style={styles.midItem}>
      <Text style={styles.midLabel} numberOfLines={2}>
        {label}
      </Text>
      <Text style={styles.midValue} numberOfLines={2}>
        {dashed(value)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  loadErrorText: { color: colors.dangerStrong, textAlign: 'center', marginBottom: spacing.md, fontFamily },
  backButton: { minWidth: 160 },
  spacer: { height: spacing.md },
  // Pause + End Job bottom bar, matching the coating card (JobCardScreen).
  jobActionsRow: { flexDirection: 'row', gap: spacing.md },
  jobActionButton: { flex: 1 },
  jobActionsHint: { marginTop: spacing.sm, fontSize: 11.5, color: colors.textMuted, textAlign: 'center', fontFamily },
  midRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: colors.headerRowBg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    gap: spacing.md,
  },
  midItem: { flex: 1 },
  midLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: colors.textMuted,
    marginBottom: 3,
    lineHeight: 12,
    minHeight: 24,
    fontFamily,
  },
  midValue: { fontSize: 17, fontWeight: '800', color: colors.textDark, fontFamily },
  descRow: { paddingVertical: spacing.sm },
  descRowDivider: { borderTopWidth: 1, borderTopColor: colors.borderLight },
  descHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  descDeckleId: { flex: 1, fontSize: 13, fontWeight: '800', color: colors.textDark, fontFamily },
  rearrangeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 3,
    paddingHorizontal: spacing.sm,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radii.pill,
  },
  rearrangeText: { color: colors.primary, fontSize: 12, fontWeight: '700', fontFamily },
  descDone: { color: colors.textMuted },
  bundle: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.cardBg,
    overflow: 'hidden',
  },
  bundleAccent: { width: 4, backgroundColor: colors.primary },
  bundleBody: { flex: 1, padding: spacing.md },
  bundleHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  bundleIcon: {
    width: 34,
    height: 34,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.infoPanelBg,
  },
  bundleHeadText: { flex: 1 },
  bundleEyebrow: {
    fontSize: 9.5,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: colors.textMuted,
    fontFamily,
  },
  bundleTitle: { fontSize: 15, fontWeight: '800', color: colors.textDark, fontFamily },
  bundleCount: {
    alignItems: 'center',
    paddingVertical: 3,
    paddingHorizontal: spacing.sm + 2,
    borderRadius: radii.sm,
    backgroundColor: colors.primary,
  },
  bundleCountNum: { color: '#FFFFFF', fontSize: 15, fontWeight: '800', lineHeight: 17, fontFamily },
  bundleCountText: { color: '#FFFFFF', fontSize: 9, fontWeight: '600', opacity: 0.85, fontFamily },
  bundleStrip: { marginTop: spacing.md },
  bundleListLabel: {
    marginTop: spacing.md,
    marginBottom: spacing.xs,
    fontSize: 9.5,
    fontWeight: '700',
    letterSpacing: 0.8,
    color: colors.textMuted,
    fontFamily,
  },
  bundleList: {
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radii.sm,
    backgroundColor: colors.headerRowBg,
    paddingHorizontal: spacing.sm,
  },
  bundleItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  bundleItemDivider: { borderTopWidth: 1, borderTopColor: colors.borderLight },
  bundleNum: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.infoPanelBg,
    borderWidth: 1,
    borderColor: colors.primary,
  },
  bundleNumDone: { backgroundColor: '#059669', borderColor: '#059669' },
  bundleNumText: { fontSize: 11, fontWeight: '800', color: colors.primary, fontFamily },
  bundleItemMain: { flex: 1 },
  bundleItemId: { fontSize: 13.5, fontWeight: '800', color: colors.textDark, fontFamily },
  statusChip: { paddingVertical: 2, paddingHorizontal: spacing.sm, borderRadius: radii.pill },
  statusChipPending: { backgroundColor: colors.advanceBg },
  statusChipDone: { backgroundColor: colors.rowMatchBg },
  statusChipText: { fontSize: 10.5, fontWeight: '700', fontFamily },
  statusTextPending: { color: colors.advanceText },
  statusTextDone: { color: '#166534' },
  reorderIconBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.primary,
  },
  bundleFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  bundleFooterText: { fontSize: 11.5, fontWeight: '600', color: colors.textMuted, fontFamily },
  bundleFooterTotal: { fontSize: 12.5, fontWeight: '800', color: colors.primary, fontFamily },
  descMeta: { fontSize: 11.5, fontWeight: '600', color: colors.textMuted, fontFamily },
  addRowButton: { alignSelf: 'flex-start', marginTop: spacing.xs },
  addRowText: { color: colors.primary, fontWeight: '600', fontSize: 13, fontFamily },
  allDoneText: { fontSize: 12.5, color: '#059669', fontWeight: '600', fontFamily },
  hintText: {
    marginTop: spacing.md,
    fontSize: 12.5,
    color: colors.textMuted,
    textAlign: 'center',
    fontFamily,
  },
});
