import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import { colors, radii, spacing, fontFamily } from '../theme/theme';
import Card from '../theme/Card';
import Button from '../theme/Button';
import AppDialog from '../theme/AppDialog';
import Toast, { useToast } from '../theme/Toast';
import JobSettingRow from './jobcard/JobSettingRow';
import DeckleWebStrip from './slitting/DeckleWebStrip';
import ScanDeckleStrip from './slitting/ScanDeckleStrip';
import SlittingDeckleRow, { rowMeter, curedNow } from './slitting/SlittingDeckleRow';
import {
  getSlittingCard,
  saveSlittingSetting,
  swapSlittingDeckle,
  startSlittingRow,
  produceSlittingRow,
  editSlittingJoint,
  ApiError,
} from '../services/api';
import { normalizeRollId } from '../utils/rollId';
import { validateStartMtrs, validateStopMtrs, fmtMtrs } from '../utils/meters';
import { playScanSuccess, playScanError } from '../utils/scanFeedback';

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
  const [dialog, setDialog] = useState(null);
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

      // The machine counter is continuous: Job Setting's last Stop reading is
      // exactly where the first Deckle's Start begins, so don't make the
      // operator re-key it.
      const seed = jsAlreadyDone ? savedJs[savedJs.length - 1].mtrs2 : null;
      const firstPending = (loaded.rows || []).findIndex(r => r.status !== 'done' && !r.startTime);
      setDrafts(
        firstPending >= 0 && seed !== null && seed !== undefined && seed !== ''
          ? { [firstPending]: { ...emptyDraft(), startMtrs: String(seed) } }
          : {},
      );
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Could not load this slitting card.');
    } finally {
      setLoading(false);
    }
  }, [cardId]);

  useEffect(() => {
    load();
  }, [load]);

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

  // ── Scan ───────────────────────────────────────────────────────────────
  const armRow = (index, message) => {
    playScanSuccess();
    setArmedIndex(index);
    setScanStatus({ tone: 'ok', message });
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
        setArmedIndex(null);
        setScanStatus({ tone: 'bad', message: `${rows[i].deckleId} has already been run on this card.` });
        return;
      }
      if (!curedNow(rows[i])) {
        playScanError();
        setArmedIndex(null);
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
      setArmedIndex(null);
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
      setArmedIndex(null);
      setScanStatus({
        tone: 'bad',
        message: err instanceof ApiError ? err.message : 'That Deckle is not on this card.',
      });
    } finally {
      setScanBusy(false);
    }
  };

  const openScan = () => {
    scanTargetRef.current = value => armFrom(value);
    navigation.navigate('Scan', { returnTo: 'SlittingJobCard' });
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
    setJobSetting(list => list.map((r, i) => (i === index ? { ...r, startTime: time } : r)));
  };
  const stopJsRow = (index, time) => {
    const error = validateStopMtrs(jobSetting[index]?.mtrs1, jobSetting[index]?.mtrs2);
    if (error) {
      showToast(error);
      return;
    }
    touchJs();
    setJobSetting(list => list.map((r, i) => (i === index ? { ...r, stopTime: time } : r)));
  };

  const jobSettingComplete = jobSetting.length > 0 && jobSetting.every(r => r.startTime && r.stopTime);

  const handleStartProduction = async () => {
    setSavingSetting(true);
    try {
      await saveSlittingSetting({ cardId, rows: jsPayload() });
      jsDirtyRef.current = false;
      setProductionStarted(true);
      // Seed the first not-yet-started row's Start reading off Job Setting's
      // last Stop -- one continuous counter, so it is the same number.
      const last = jobSetting[jobSetting.length - 1]?.mtrs2;
      const firstPending = rows.findIndex(r => r.status !== 'done' && !r.startTime);
      if (firstPending >= 0 && String(last ?? '').trim() && !draftFor(firstPending).startMtrs) {
        setDraft(firstPending, 'startMtrs', String(last));
      }
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
    try {
      const res = await startSlittingRow({
        cardId,
        index,
        startTime: time,
        startMtrs: Number(draft.startMtrs),
      });
      patchRow(index, { startTime: res.startTime || time, startMtrs: res.startMtrs ?? Number(draft.startMtrs) });
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
      setArmedIndex(null);
      setScanStatus({ tone: '', message: 'Scan the next Deckle.' });

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
    const runningMeter = Number(row.plannedRunningMeter);
    if (!(runningMeter > 0)) {
      showToast('This Deckle has no R. Meter planned — ask the office to reopen its allocation.');
      return;
    }

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
          {rows.map((row, i) => (
            <View key={i} style={[styles.descRow, i > 0 && styles.descRowDivider]}>
              <View style={styles.descHead}>
                <Text style={styles.descDeckleId} numberOfLines={1}>
                  {dashed(row.deckleId)}
                </Text>
                <Text style={styles.descMeta}>
                  {fmtMtrs(row.width)} mm · {fmtMtrs(row.plannedMeter)} m
                </Text>
              </View>
              <DeckleWebStrip row={row} />
            </View>
          ))}
        </Card>

        <View style={styles.spacer} />

        {/* The gate on every Start below. A slit run names its finished rolls
            after the physical Deckle it came off, so the reel has to be read
            and matched before the clock can be punched. */}
        <Card title="Scan Deckle">
          <ScanDeckleStrip
            status={scanStatus}
            busy={scanBusy}
            onSubmit={armFrom}
            onScanRequest={openScan}
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
              index={index + 1}
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

            <View style={styles.spacer} />
            <Button
              title={pendingRows.length ? 'Back to Queue' : 'Done'}
              icon={pendingRows.length ? 'arrow-left' : 'check'}
              variant={pendingRows.length ? 'outline' : 'primary'}
              onPress={() => navigation.navigate('Home')}
            />
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

        <AppDialog
          visible={!!dialog}
          tone={dialog?.tone}
          title={dialog?.title}
          message={dialog?.message}
          buttons={dialog?.buttons}
          onRequestClose={() => setDialog(null)}
        />
      </KeyboardAwareScrollView>

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
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  descDeckleId: { flex: 1, fontSize: 13, fontWeight: '800', color: colors.textDark, fontFamily },
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
