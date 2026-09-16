import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import { colors, radii, spacing, fontFamily } from '../theme/theme';
import Card from '../theme/Card';
import Button from '../theme/Button';
import AppDialog from '../theme/AppDialog';
import Toast, { useToast } from '../theme/Toast';
import MaterialsMountedStrip from './jobcard/MaterialsMountedStrip';
import JobSettingRow from './jobcard/JobSettingRow';
import ProductionLogRow from './jobcard/ProductionLogRow';
import MaterialUsedDialog from './jobcard/MaterialUsedDialog';
import {
  getJobCard,
  postJobCard,
  logProduce,
  markInUse,
  claimJob,
  heartbeatJob,
  ApiError,
} from '../services/api';
import { getDraft, saveDraft, clearDraft } from '../storage/draftStorage';
import { printQueue } from '../services/printQueue';
import { newRowToken } from '../utils/rowToken';
import {
  validateStartMtrs,
  validateStopMtrs,
  validateDeckleMeters,
  checkStartContinuity,
} from '../utils/meters';

const emptyJsRow = () => ({ mtrs1: '', startTime: '', mtrs2: '', stopTime: '', fsRollId: '', adRollId: '', rlRollId: '' });
const emptyLogRow = () => ({
  rowToken: newRowToken(),
  startMtrs: '',
  startTime: '',
  stopMtrs: '',
  endTime: '',
  meters: '',
  faceJoint: '',
  faceMtr: '',
  faceJointReason: '',
  releaseJoint: '',
  releaseMtr: '',
  releaseJointReason: '',
  fsRollId: '',
  adRollId: '',
  rlRollId: '',
  materialsUsed: [],
  deckleId: '',
  productCode: '',
});
const emptyMounted = () => ({ facestock: null, adhesive: null, release: null });

const todayIso = () => new Date().toISOString();

// Display names for the three raw-material pools, matching the Materials
// Mounted strip's own slot labels (and LAYER_META on the server).
const POOL_LABELS = { facestock: 'Facestock', adhesive: 'Adhesive', release: 'Release Liner' };

// Which mounted-material pool a recipe row belongs to. Recipe tags come from
// the server as "Facestock" / "Adhesive" / "Release" (+ " 2" for a second
// layer of the same pool -- DOUBLE FACESTOCK etc.), and the Materials Mounted
// strip has one slot per pool, so both "Facestock" and "Facestock 2" map to
// the single `facestock` reel.
const recipeTagPool = tag => {
  const t = String(tag || '').toLowerCase();
  if (t.startsWith('facestock')) return 'facestock';
  if (t.startsWith('adhesive')) return 'adhesive';
  if (t.startsWith('release')) return 'release';
  return null;
};

// Snapshot the reels currently mounted on the Materials Mounted strip into a
// row's own fs/ad/rl fields -- ported from jobCardForm.ejs's
// applyCurrentMaterialsToRow.
const applyMounted = mounted => ({
  fsRollId: mounted.facestock?.rollId || '',
  adRollId: mounted.adhesive?.rollId || '',
  rlRollId: mounted.release?.rollId || '',
});

// Deduped {pool, rollId, stockId} entries for every reel mounted while a
// Production Log row is live -- one Production Log row = one Deckle, so this
// is that deckle's full material trace (a facestock swap mid-run shows up
// here as two entries). Ported from jobCardForm.ejs's appendRowMaterialsUsed.
const withMountedTrace = (materialsUsed, mounted) => {
  const have = new Set(materialsUsed.map(m => `${m.pool}|${m.rollId}`));
  const next = [...materialsUsed];
  [
    ['facestock', mounted.facestock],
    ['adhesive', mounted.adhesive],
    ['release', mounted.release],
  ].forEach(([pool, reel]) => {
    if (!reel) return;
    const key = `${pool}|${reel.rollId}`;
    if (have.has(key)) return;
    have.add(key);
    // `_id` -- a mounted reel is the server's own reel record from
    // POST /jobcard/material/check, which names it `_id`, not `stockId`.
    next.push({ pool, rollId: reel.rollId, stockId: reel._id });
  });
  return next;
};

export default function JobCardScreen({ route, navigation }) {
  const { pendingId } = route.params;
  const [data, setData] = useState(null);
  const [submissionToken, setSubmissionToken] = useState(null);
  const [mounted, setMounted] = useState(emptyMounted());
  const [jobSetting, setJobSetting] = useState([emptyJsRow()]);
  const [productionLive, setProductionLive] = useState(emptyLogRow());
  const [productionDone, setProductionDone] = useState([]);
  // Sticky, one-way gate mirroring jobCardForm.ejs's "Start Production"
  // button: once every Job Setting row has Start+Stop, the operator must
  // explicitly tap Start Production to reveal the Production Log and Save
  // button. It stays revealed even if a later-added Job Setting row is
  // incomplete again.
  const [productionStarted, setProductionStarted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pausing, setPausing] = useState(false);
  // Allocated Materials is reference the operator reads once, so it collapses
  // out of the way -- the actionable list is Materials Mounted above it.
  const [allocOpen, setAllocOpen] = useState(false);
  // Recipe gets the same dropdown but always starts open: it's what the
  // operator checks the reels against as they mount them, so every job card
  // opens showing it. Closing it is a per-visit convenience, deliberately not
  // remembered -- the next card starts open again.
  const [recipeOpen, setRecipeOpen] = useState(true);
  // Job-running claim. `claimHeld` is true once this device has taken the job
  // (at the first Start punch); `runningOnOther` names the device holding it
  // when we couldn't. See PendingProduction.runningOn on the server.
  const [claimHeld, setClaimHeld] = useState(false);
  const [runningOnOther, setRunningOnOther] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [materialUsedVisible, setMaterialUsedVisible] = useState(false);
  // In-app themed dialog in place of RN's Alert.alert -- see theme/AppDialog.js
  // for why. { tone, title, message, buttons }
  const [dialog, setDialog] = useState(null);
  // Transient "that reading can't be right" corrections -- see theme/Toast.js.
  const { toast, showToast, hideToast } = useToast();
  // Which done Production Log row (by rowToken) has its Edit toggle open --
  // mirrors jobCardForm.ejs's .jc-row-edit-btn / setRowReadOnly.
  const [editingRowToken, setEditingRowToken] = useState(null);
  // Which finished Job Setting row is reopened for correction (by index --
  // these rows carry no rowToken of their own).
  const [editingJsIndex, setEditingJsIndex] = useState(null);
  const scanTargetRef = useRef(null);
  // Labels produced on this job (or an earlier one) that haven't reached the
  // printer yet -- see services/printQueue.js.
  const [pendingPrints, setPendingPrints] = useState([]);
  const [printQueueBusy, setPrintQueueBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await getJobCard(pendingId);
      setData(res);
      setRunningOnOther(res.runningElsewhere ? res.runningOnLabel || 'another device' : null);
      const draft = await getDraft(pendingId);
      if (draft) {
        setMounted(draft.mounted || emptyMounted());
        setJobSetting(draft.jobSetting?.length ? draft.jobSetting : [emptyJsRow()]);
        setProductionLive(draft.productionLive || emptyLogRow());
        // `producing` is in-flight UI state, not a fact about the row. If the
        // app was killed mid-instant-produce it would otherwise restore stuck
        // on "Moving to Semi Finished Stock…" forever (and keep Edit hidden).
        // A row that really did produce carries its deckleId; one that didn't
        // is picked up by the final save on its rowToken.
        setProductionDone((draft.productionDone || []).map(r => ({ ...r, producing: false })));
        setSubmissionToken(draft.submissionToken || res.submissionToken);
        setProductionStarted(!!draft.productionStarted);
      } else {
        setMounted(emptyMounted());
        setJobSetting([emptyJsRow()]);
        setProductionLive(emptyLogRow());
        setProductionDone([]);
        setSubmissionToken(res.submissionToken);
        setProductionStarted(false);
      }
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Could not load this job.');
    } finally {
      setLoading(false);
    }
  }, [pendingId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(
    () =>
      printQueue.subscribe(({ jobs, flushing }) => {
        setPendingPrints(jobs);
        setPrintQueueBusy(flushing);
      }),
    [],
  );

  // Autosave the draft on every change -- see storage/draftStorage.js for why.
  useEffect(() => {
    if (!submissionToken) {
      return;
    }
    const timer = setTimeout(() => {
      saveDraft(pendingId, { submissionToken, mounted, jobSetting, productionLive, productionDone, productionStarted });
    }, 400);
    return () => clearTimeout(timer);
  }, [pendingId, submissionToken, mounted, jobSetting, productionLive, productionDone, productionStarted]);

  // The Production Log's live row always tracks whatever is currently
  // mounted (there is only ever one live row, so this is unambiguous, unlike
  // Job Setting's several rows -- those snapshot mounted material at their
  // own Start punch instead, below).
  useEffect(() => {
    setProductionLive(row => ({
      ...row,
      ...applyMounted(mounted),
      materialsUsed: withMountedTrace(row.materialsUsed, mounted),
    }));
    // Keyed on each pool's reel `_id` (the field material/check actually
    // returns) so mounting, swapping, or clearing a reel re-runs this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted.facestock?._id, mounted.adhesive?._id, mounted.release?._id]);

  // The QR payload scanned in the Scan modal comes back as a navigation
  // param, raw and unparsed -- a label's QR is the whole sticker, not just a
  // Roll ID (see utils/rollId.js). scanTargetRef remembers which callback
  // triggered it (always a MaterialsMountedStrip pool-mount callback here --
  // Job Setting/Production Log rows don't scan individually, they inherit
  // whatever's mounted), and that callback is what pulls the Roll ID out.
  useEffect(() => {
    const scanned = route.params?.scannedCode;
    if (scanned && scanTargetRef.current) {
      const cb = scanTargetRef.current;
      scanTargetRef.current = null;
      navigation.setParams({ scannedCode: undefined });
      cb(scanned);
    }
  }, [route.params?.scannedCode, navigation]);

  const openScan = (pool, onScanned) => {
    scanTargetRef.current = onScanned;
    navigation.navigate('Scan');
  };

  const handleMountedChange = (pool, reel) => {
    setMounted(m => ({ ...m, [pool]: reel }));
  };

  // Fires the moment a row's Start is punched, for whichever pools are
  // currently mounted -- see routes/api/operatorApi.js's mark-in-use. Fire
  // and forget: a failure here never blocks the operator from continuing,
  // same as the EJS's own markRowMaterialsInUse.
  const markMountedInUse = useCallback(() => {
    ['facestock', 'adhesive', 'release'].forEach(pool => {
      const reel = mounted[pool];
      if (!reel) return;
      markInUse({ pendingId, pool, rollId: reel.rollId }).catch(() => {});
    });
  }, [mounted, pendingId]);

  // ── Running claim ──────────────────────────────────────────────────────
  // Taken lazily at the first Start punch rather than on open, so browsing a
  // job's recipe from a second device doesn't tie the job up.
  const ensureClaim = useCallback(async () => {
    if (claimHeld) {
      return true;
    }
    try {
      await claimJob(pendingId);
      setClaimHeld(true);
      setRunningOnOther(null);
      return true;
    } catch (err) {
      const label = err instanceof ApiError ? err.body?.runningOnLabel : null;
      setRunningOnOther(label || 'another device');
      Alert.alert(
        'Already running',
        `This job is running on ${label || 'another device'}. Finish and save it there, or wait for it to be released.`,
      );
      return false;
    }
  }, [claimHeld, pendingId]);

  // Keep the claim alive while this screen is open. Losing it (409) means the
  // claim went stale and another device took the job, so stop claiming to hold
  // it -- the Start punches disable themselves off runningOnOther.
  useEffect(() => {
    if (!claimHeld) {
      return undefined;
    }
    const everyMs = data?.heartbeatMs || 60000;
    const timer = setInterval(async () => {
      try {
        await heartbeatJob(pendingId);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setClaimHeld(false);
          setRunningOnOther(err.body?.runningOnLabel || 'another device');
        }
      }
    }, everyMs);
    return () => clearInterval(timer);
  }, [claimHeld, pendingId, data?.heartbeatMs]);

  // ── Material gate ──────────────────────────────────────────────────────
  // Every raw-material pool this order's recipe actually calls for, off
  // prefill.layerAllotments (the server builds it from
  // requiredLayersFor(rollType)), so a DOUBLE FACESTOCK order's two facestock
  // layers collapse to the single "facestock" slot the strip shows. Falls
  // back to all three if the prefill carries none, mirroring the server's own
  // `LAYER_ORDER[rollType] || LAYER_ORDER.NORMAL`.
  const requiredPools = useMemo(() => {
    const pools = [...new Set((data?.prefill?.layerAllotments || []).map(l => l.pool).filter(Boolean))];
    return pools.length ? pools : ['facestock', 'adhesive', 'release'];
  }, [data]);
  const missingPools = requiredPools.filter(pool => !mounted[pool]);
  const materialsMounted = missingPools.length === 0;
  // Everything a Start punch needs: the material gate AND this job not being
  // live on another device.
  const canPunch = materialsMounted && !runningOnOther;
  const missingPoolsLabel = missingPools.map(pool => POOL_LABELS[pool] || pool).join(', ');

  // ── Job Setting ────────────────────────────────────────────────────────
  const updateJsRow = (index, field, value) => {
    setJobSetting(rows => rows.map((r, i) => (i === index ? { ...r, [field]: value } : r)));
  };
  const removeJsRow = index => setJobSetting(rows => rows.filter((_, i) => i !== index));
  const startJsRow = async (index, time) => {
    // Belt-and-braces: the row's Start button is already disabled until every
    // required reel is mounted, but this row freezes the mounted reels into
    // fsRollId/adRollId/rlRollId, so never let it run with a blank snapshot.
    if (!canPunch) {
      return;
    }
    // The punch freezes this reading into the row, so check it before the
    // claim is taken -- a rejected punch shouldn't tie the job to this device.
    const error = validateStartMtrs(jobSetting[index]?.mtrs1);
    if (error) {
      showToast(error);
      return;
    }
    // Claim the job for this device before anything is recorded against it.
    if (!(await ensureClaim())) {
      return;
    }
    markMountedInUse();
    setJobSetting(rows =>
      rows.map((r, i) => (i === index ? { ...r, ...applyMounted(mounted), startTime: time } : r)),
    );
  };
  const stopJsRow = (index, time) => {
    // Same start/stop counter pair as a Production Log row, so the same rule:
    // the stop reading can't sit below the start reading.
    const error = validateStopMtrs(jobSetting[index]?.mtrs1, jobSetting[index]?.mtrs2);
    if (error) {
      showToast(error);
      return;
    }
    setJobSetting(rows => rows.map((r, i) => (i === index ? { ...r, stopTime: time } : r)));
  };

  const jobSettingComplete = jobSetting.length > 0 && jobSetting.every(r => r.startTime && r.stopTime);

  const handleStartProduction = () => {
    if (!canPunch) {
      return;
    }
    setProductionStarted(true);
  };

  // ── Production Log ────────────────────────────────────────────────────
  const updateLogRow = (field, value) => {
    setProductionLive(row => {
      const next = { ...row, [field]: value };
      // Meters auto-fills from Start/Stop until the operator types into it
      // directly -- ported from jobCardForm.ejs's autoFillMeters.
      if ((field === 'startMtrs' || field === 'stopMtrs') && !row.metersUserEdited) {
        const start = Number(field === 'startMtrs' ? value : row.startMtrs);
        const stop = Number(field === 'stopMtrs' ? value : row.stopMtrs);
        next.meters = Number.isFinite(start) && Number.isFinite(stop) && stop > start ? String(Math.round((stop - start) * 100) / 100) : '';
      }
      if (field === 'meters') {
        next.metersUserEdited = true;
      }
      return next;
    });
  };

  const startLogRow = time => {
    const error = validateStartMtrs(productionLive.startMtrs);
    if (error) {
      showToast(error);
      return;
    }
    // Advisory only -- the punch goes through either way. See
    // checkStartContinuity for why this one can't be a hard rule.
    const warning = checkStartContinuity(
      productionDone[productionDone.length - 1]?.stopMtrs,
      productionLive.startMtrs,
    );
    if (warning) {
      showToast(warning, 'warning');
    }
    markMountedInUse();
    setProductionLive(row => ({ ...row, startTime: time }));
  };

  // Correcting a done row after its Stop. `meters` is deliberately NOT
  // editable here -- that Deckle's length is already credited to Semi
  // Finished Stock, and changing it would desync real stock. Exactly
  // jobCardForm.ejs's PRODUCTION_LOCKED_SELECTORS rule.
  const updateDoneRow = (rowToken, field, value) => {
    if (field === 'meters') {
      return;
    }
    setProductionDone(rows => rows.map(r => (r.rowToken === rowToken ? { ...r, [field]: value } : r)));
  };

  // Punches Stop, freezes the live row into the done list, opens a fresh live
  // row, and fires the instant-produce -- ported from jobCardForm.ejs's
  // commitLogRowStop. Deliberately reads `productionLive` from the current
  // render rather than mutating inside a setState updater: an updater must be
  // a pure function of previous state, and queueing another component's
  // setState from inside one double-fires under React's dev double-invoke.
  const commitLogRowStop = time => {
    const stopped = { ...productionLive, endTime: time, producing: true };
    setProductionDone(rows => [...rows, stopped]);
    setProductionLive(emptyLogRow());

    // Fires in the background -- a lost/failed response falls back to the
    // final save, matched back by rowToken. See services/api.js's
    // logProduce and the server's own comment on this same flow.
    logProduce({
      pendingId,
      rowToken: stopped.rowToken,
      fsRollId: stopped.fsRollId,
      adRollId: stopped.adRollId,
      rlRollId: stopped.rlRollId,
      materialsUsed: stopped.materialsUsed,
      startMtrs: stopped.startMtrs,
      stopMtrs: stopped.stopMtrs,
      meters: stopped.meters,
      faceJoint: stopped.faceJoint,
      faceJointReason: stopped.faceJointReason,
      faceMtr: stopped.faceMtr,
      releaseJoint: stopped.releaseJoint,
      releaseJointReason: stopped.releaseJointReason,
      releaseMtr: stopped.releaseMtr,
      startTime: stopped.startTime,
      endTime: stopped.endTime,
    })
      .then(res => {
        // The Deckle now physically exists, so its sticker is due. Queued
        // rather than printed inline: enqueue() fires the print itself and a
        // dead printer must not block the punch or throw an alert into the
        // middle of a run -- the label waits in the queue instead. See
        // services/printQueue.js.
        printQueue.enqueue({
          stockId: res.deckleStockId,
          rollId: res.deckleId,
          productCode: res.productCode,
        });
        setProductionDone(rows =>
          rows.map(r =>
            r.rowToken === stopped.rowToken
              ? {
                  ...r,
                  producing: false,
                  deckleId: res.deckleId,
                  deckleStockId: res.deckleStockId,
                  productCode: res.productCode,
                }
              : r,
          ),
        );
      })
      .catch(() => {
        // Left with no deckleId -- the final save's produceDecklesFromLog
        // makes it then, matching the "will be created on Save" note.
        setProductionDone(rows =>
          rows.map(r => (r.rowToken === stopped.rowToken ? { ...r, producing: false } : r)),
        );
      });
  };

  const stopLogRow = time => {
    // The machine's counter only runs forwards, so a stop reading below the
    // start one is a mis-key -- caught here, at the punch, rather than after
    // it has been inwarded as a Deckle of impossible length.
    const mtrsError = validateStopMtrs(productionLive.startMtrs, productionLive.stopMtrs);
    if (mtrsError) {
      showToast(mtrsError);
      return;
    }
    // The metres this Deckle actually made -- refused here rather than
    // silently failing the instant-produce and falling through to the final
    // save, and capped at the span that ran between the two readings.
    const metersError = validateDeckleMeters(
      productionLive.startMtrs,
      productionLive.stopMtrs,
      productionLive.meters,
    );
    if (metersError) {
      showToast(metersError);
      return;
    }
    if (pendingId) {
      setDialog({
        tone: 'info',
        title: 'Move to Semi Finished Stock?',
        message: `${productionLive.meters} mtrs will be inwarded as a new Deckle.`,
        buttons: [
          { label: 'Cancel', variant: 'ghost', onPress: () => setDialog(null) },
          {
            label: 'Confirm',
            onPress: () => {
              setDialog(null);
              commitLogRowStop(time);
            },
          },
        ],
      });
    } else {
      commitLogRowStop(time);
    }
  };

  const totalMeter = useMemo(() => {
    const rows = [...productionDone, productionLive];
    return rows.reduce((sum, r) => sum + (Number(r.meters) > 0 ? Number(r.meters) : 0), 0);
  }, [productionDone, productionLive]);

  const paperSizeNum = useMemo(() => {
    const m = String(data?.prefill?.paperSize || '').match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : 0;
  }, [data]);
  const sqMtr = paperSizeNum > 0 ? paperSizeNum * (totalMeter / 100) : 0;

  // ── Save ───────────────────────────────────────────────────────────────
  const buildLogRowsForSave = () =>
    [...productionDone, productionLive].map(r => ({
      fsRollId: r.fsRollId,
      adRollId: r.adRollId,
      rlRollId: r.rlRollId,
      deckleId: r.deckleId || '',
      logInstantProduced: r.deckleId ? '1' : '',
      logRowToken: r.rowToken,
      logMaterialsUsed: JSON.stringify(r.materialsUsed || []),
      logStart: r.startTime,
      logStartMtrs: r.startMtrs,
      logEnd: r.endTime,
      logStopMtrs: r.stopMtrs,
      logMeters: r.meters,
      faceJoint: r.faceJoint,
      faceJointReason: r.faceJointReason,
      faceMtr: r.faceMtr,
      releaseJoint: r.releaseJoint,
      releaseJointReason: r.releaseJointReason,
      releaseMtr: r.releaseMtr,
    }));

  const submitJobCard = async materialUsage => {
    setSaving(true);
    try {
      const prefill = data.prefill;
      const logRows = buildLogRowsForSave();
      const payload = {
        pendingId,
        machineId: data.machine?._id,
        // saveMachineJobCard reads the machine's NAME off `machineNo`
        // (MachineJobCard.machineName) -- machineId alone leaves the saved
        // card's machine blank.
        machineNo: data.machine?.machineName,
        date: todayIso(),
        lotNo: prefill.lotNo,
        productCode: prefill.productCode,
        paperSize: prefill.paperSize,
        rolls: prefill.rolls,
        quantity: prefill.quantity,
        operatorName: prefill.operatorName,
        helperName: prefill.helperName,
        submissionToken,
        jsFsRollId: jobSetting.map(r => r.fsRollId),
        jsAdRollId: jobSetting.map(r => r.adRollId),
        jsRlRollId: jobSetting.map(r => r.rlRollId),
        jsMtrs1: jobSetting.map(r => r.mtrs1),
        jsStart: jobSetting.map(r => r.startTime),
        jsMtrs2: jobSetting.map(r => r.mtrs2),
        jsStop: jobSetting.map(r => r.stopTime),
        fsRollId: logRows.map(r => r.fsRollId),
        adRollId: logRows.map(r => r.adRollId),
        rlRollId: logRows.map(r => r.rlRollId),
        deckleId: logRows.map(r => r.deckleId),
        logInstantProduced: logRows.map(r => r.logInstantProduced),
        logRowToken: logRows.map(r => r.logRowToken),
        logMaterialsUsed: logRows.map(r => r.logMaterialsUsed),
        logStart: logRows.map(r => r.logStart),
        logStartMtrs: logRows.map(r => r.logStartMtrs),
        logEnd: logRows.map(r => r.logEnd),
        logStopMtrs: logRows.map(r => r.logStopMtrs),
        logMeters: logRows.map(r => r.logMeters),
        faceJoint: logRows.map(r => r.faceJoint),
        faceJointReason: logRows.map(r => r.faceJointReason),
        faceMtr: logRows.map(r => r.faceMtr),
        releaseJoint: logRows.map(r => r.releaseJoint),
        releaseJointReason: logRows.map(r => r.releaseJointReason),
        releaseMtr: logRows.map(r => r.releaseMtr),
        facestockStockId: materialUsage.facestock.map(u => u.stockId),
        facestockMtrsUsed: materialUsage.facestock.map(u => u.used),
        facestockRemainingKg: materialUsage.facestock.map(u => u.remainingKg ?? ''),
        adhesiveStockId: materialUsage.adhesive.map(u => u.stockId),
        adhesiveKgUsed: materialUsage.adhesive.map(u => u.used),
        adhesiveRemainingKg: materialUsage.adhesive.map(u => u.remainingKg ?? ''),
        releaseStockId: materialUsage.release.map(u => u.stockId),
        releaseMtrsUsed: materialUsage.release.map(u => u.used),
        releaseRemainingKg: materialUsage.release.map(u => u.remainingKg ?? ''),
        totalMeter: String(totalMeter),
        sqMtr: String(sqMtr),
      };

      const outcome = await postJobCard(payload);
      await clearDraft(pendingId);
      Alert.alert('Saved', outcome.message || 'Production entry saved successfully!', [
        { text: 'OK', onPress: () => navigation.navigate('Home') },
      ]);
    } catch (err) {
      if (err instanceof ApiError && (err.body?.status === 'gate-failed' || err.body?.status === 'wip-clash')) {
        Alert.alert('Cannot save', err.body.message);
      } else if (err instanceof ApiError && err.body?.status === 'duplicate') {
        await clearDraft(pendingId);
        navigation.navigate('Home');
      } else {
        Alert.alert('Save failed', err instanceof ApiError ? err.message : 'Something went wrong.');
      }
    } finally {
      setSaving(false);
    }
  };

  // "End Job" -- the job is finished, so go on to Material Used and the final
  // save. That dialog is the deliberate confirmation step here, so this
  // doesn't put another one in front of it.
  //
  // The one thing checked first: a live row with a Start punch and no Stop is
  // a Deckle still on the machine. It saves as a row with no end time and no
  // metres, and never becomes stock -- almost always a forgotten Stop rather
  // than a decision. A confirm, not a block: abandoning a started row IS
  // sometimes right (the web broke, nothing usable came off), and refusing
  // outright would leave the operator with no way to close the job.
  const handleEndJob = () => {
    if (productionLive.startTime && !productionLive.endTime) {
      setDialog({
        tone: 'warning',
        title: 'Deckle still running',
        message: `Deckle #${productionDone.length + 1} has a Start punch but no Stop, so it will be saved unfinished and won't reach Semi Finished Stock.`,
        buttons: [
          { label: 'Go back', variant: 'ghost', onPress: () => setDialog(null) },
          {
            label: 'End anyway',
            variant: 'danger',
            onPress: () => {
              setDialog(null);
              setMaterialUsedVisible(true);
            },
          },
        ],
      });
      return;
    }
    setMaterialUsedVisible(true);
  };

  // "Pause" -- the operator is stepping away (break, shift change, a reel to
  // fetch), not finishing. Nothing is sent to the server: the card is left
  // unsaved and the job stays in the Work Queue exactly as it is, with every
  // punch, meter reading and mounted reel kept in the draft. Reopening the job
  // restores it and carries on. Deckles already punched out are unaffected --
  // each one was inwarded to Semi Finished Stock at its own Stop.
  //
  // The draft is written here directly rather than relying on the 400ms
  // autosave debounce, so nothing can be lost between the tap and the screen
  // going away. The running claim is deliberately left alone: it expires by
  // itself once the heartbeat stops, which is what frees the job for another
  // device if this operator never comes back to it.
  const handlePause = () => {
    setDialog({
      tone: 'info',
      title: 'Pause this job?',
      message:
        'Everything punched so far is kept and the job stays in your Work Queue. Open it again to carry on from here.',
      buttons: [
        { label: 'Cancel', variant: 'ghost', onPress: () => setDialog(null) },
        {
          label: 'Pause',
          onPress: async () => {
            setDialog(null);
            setPausing(true);
            try {
              await saveDraft(pendingId, {
                submissionToken,
                mounted,
                jobSetting,
                productionLive,
                productionDone,
                productionStarted,
              });
            } finally {
              setPausing(false);
            }
            navigation.navigate('Home');
          },
        },
      ],
    });
  };

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

  const { prefill } = data;
  const allocReelCount = (prefill.layerAllotments || []).flatMap(layer => layer.reels || []).length;

  // Same three derivations the web form makes for its summary row: the run
  // spec prefers the free-text version, Qty is the deckle target falling back
  // to the order's own quantity, and a part-run order shows how much is left.
  // The length of ONE deckle web -- Deckle Set's "Per deckle" figure, which is
  // what the operator actually runs. Deliberately NOT runningMeters (the whole
  // job's finished length across every roll slit off that web) nor
  // runningMetersText, which concatenates the two into "... M/DECKLE ...
  // M TOTAL" (see routes/fairdesk_route.js's deckle-set handler).
  const runningMtrs = prefill.deckleRunningMeters;
  const deckleQty =
    prefill.deckleTarget !== null && prefill.deckleTarget !== undefined && prefill.deckleTarget !== ''
      ? prefill.deckleTarget
      : prefill.quantity;
  const producedNote =
    Number(prefill.producedRolls) > 0
      ? `${prefill.producedRolls} done, ${dashed(prefill.balanceRolls)} to run`
      : null;

  return (
    // The scroll view sits inside a plain flex box purely so the toast has
    // something fixed to anchor to -- pinned inside the scroll view it would
    // scroll away with the form.
    <View style={styles.root}>
      <KeyboardAwareScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        enableOnAndroid
        extraScrollHeight={24}
        keyboardShouldPersistTaps="handled">
        {/* The four figures an operator actually runs the job against, as the
            web form's own .material-id-row: a small uppercase label over a big
            bold value. Same fields, same order, same fallbacks (Qty is the
            DECKLE target -- deckleTarget, or the order's Qty when it isn't a
            deckle batch -- and Running Mtrs prefers the free-text run spec).
            Operator/Helper deliberately dropped: the operator is the person
            holding the phone, so naming them here is noise. */}
        {/* The lot number alone -- it already reads as "SP | LOT | 000001", so a
            "Lot" prefix repeats itself, and the job card id it used to sit beside
            is an office reference the operator never needs to quote. */}
        <Card title={prefill.lotNo}>
          <View style={styles.midRow}>
            <MidItem label="LS Stock" value={prefill.productCode} />
            <MidItem label="Deckle Size" value={prefill.deckleSize} />
            <MidItem label="RM/Deckle" value={runningMtrs} />
            <MidItem label="Deckle Qty" value={deckleQty} note={producedNote} />
          </View>
        </Card>

        <View style={styles.spacer} />

        {(prefill.recipe || []).length ? (
          <Card
            title="Recipe"
            collapsible
            open={recipeOpen}
            onToggle={() => setRecipeOpen(o => !o)}
            headerRight={prefill.recipe.length === 1 ? '1 layer' : `${prefill.recipe.length} layers`}>
            {/* The web form's .jc-recipe-table columns less its Size one (blank /
                Code / GSM), em-dash for a value the layer doesn't carry. The
                header row is tinted rather than navy only because Card already
                puts a navy bar directly above it. */}
            <View style={styles.table}>
              <View style={[styles.tableRow, styles.tableHead]}>
                <Text style={[styles.tableHeadCell, styles.colLayer]} />
                <Text style={[styles.tableHeadCell, styles.colValue]}>Code</Text>
                <Text style={[styles.tableHeadCell, styles.colNum]}>GSM</Text>
              </View>
              {prefill.recipe.map((r, i) => {
                // When the operator has mounted a reel whose own code differs
                // from the recipe's for that layer, the combination on the
                // machine isn't the one the order was written against -- show
                // the mounted reel's code in brackets beside the recipe's.
                const pool = recipeTagPool(r.tag);
                const mountedCode = pool ? String(mounted[pool]?.code || '').trim() : '';
                const recipeCode = String(r.code || '').trim();
                const altCode = mountedCode && mountedCode !== recipeCode ? mountedCode : null;
                return (
                  <View key={i} style={[styles.tableRow, i > 0 && styles.tableRowDivider]}>
                    <Text style={[styles.tableCell, styles.colLayer, styles.tableCellTag]} numberOfLines={1}>
                      {r.tag}
                    </Text>
                    <Text style={[styles.tableCell, styles.colValue]} numberOfLines={2}>
                      {recipeCode || '—'}
                      {altCode ? <Text style={styles.recipeAltCode}> ({altCode})</Text> : null}
                    </Text>
                    <Text style={[styles.tableCell, styles.colNum]}>
                      {r.gsm !== '' && r.gsm != null ? r.gsm : '—'}
                    </Text>
                  </View>
                );
              })}
            </View>
          </Card>
        ) : null}

        <View style={styles.spacer} />

        {/* Sits between the Recipe and Materials: what the office set aside for
            this order, read right before the operator mounts against it.
            Purely informational now that Print has gone -- reel labels are still
            printable from the Materials strip below, where the operator has the
            reel in hand. Collapsed by default so it stays a reference rather
            than pushing the mounting slots down the screen. */}
        <Card
          title="Allocated Materials"
          collapsible
          open={allocOpen}
          onToggle={() => setAllocOpen(o => !o)}
          headerRight={allocReelCount === 1 ? '1 reel' : `${allocReelCount} reels`}>
          {allocReelCount === 0 ? (
            <Text style={styles.infoLine}>No reels allotted to this order yet.</Text>
          ) : (
            (prefill.layerAllotments || []).map(layer =>
              (layer.reels || []).map(reel => (
                <View key={reel._id} style={styles.rollLine}>
                  <View style={styles.rollLineText}>
                    <Text style={styles.rollLineTitle}>
                      {layer.label}: {reel.rollId}
                    </Text>
                    <Text style={styles.rollLineSub}>
                      {reel.reelMtrs} · {reel.location}
                    </Text>
                  </View>
                </View>
              )),
            )
          )}
        </Card>

        <View style={styles.spacer} />

        <Card title="Materials">
          <MaterialsMountedStrip
            pendingId={pendingId}
            mounted={mounted}
            eligibleRawStock={data.eligibleRawStock}
            onMountedChange={handleMountedChange}
            onScanRequest={openScan}
          />
        </Card>

        <View style={styles.spacer} />

        <Card title="Job Setting">
          {jobSetting.map((row, index) => (
            <JobSettingRow
              key={index}
              row={row}
              index={index + 1}
              materialsReady={canPunch}
              editing={editingJsIndex === index}
              onToggleEdit={() => setEditingJsIndex(i => (i === index ? null : index))}
              onChange={(field, value) => updateJsRow(index, field, value)}
              onRemove={jobSetting.length > 1 ? () => removeJsRow(index) : null}
              onStart={time => startJsRow(index, time)}
              onStop={time => stopJsRow(index, time)}
            />
          ))}
          <TouchableOpacity style={styles.addRowButton} onPress={() => setJobSetting(rows => [...rows, emptyJsRow()])}>
            <Text style={styles.addRowText}>+ Add Row</Text>
          </TouchableOpacity>
        </Card>

        {/* Only ever shown when something is actually waiting. A Deckle's label
            prints by itself the moment it's produced; this line exists for the
            case the operator can't otherwise see -- printer off, not yet set up,
            or out of range -- so the stickers aren't silently missing at the end
            of the shift. */}
        {pendingPrints.length ? (
          <>
            <View style={styles.spacer} />
            <TouchableOpacity
              style={styles.printQueueBanner}
              disabled={printQueueBusy}
              onPress={() =>
                // No printer set up yet is the one case retrying can't fix, so
                // that tap goes where the operator can actually fix it.
                pendingPrints.some(j => j.lastError === 'No printer configured') || !pendingPrints[0]?.attempts
                  ? printQueue.flush().then(({ lastError }) => {
                      if (lastError === 'No printer configured') {
                        navigation.navigate('PrinterSettings');
                      }
                    })
                  : printQueue.flush()
              }>
              <View style={styles.printQueueText}>
                <Text style={styles.printQueueTitle}>
                  {pendingPrints.length === 1
                    ? '1 label waiting to print'
                    : `${pendingPrints.length} labels waiting to print`}
                </Text>
                <Text style={styles.printQueueSub}>
                  {printQueueBusy
                    ? 'Sending to the printer…'
                    : pendingPrints[0]?.lastError || 'Tap to retry'}
                </Text>
              </View>
              {printQueueBusy ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <Text style={styles.printQueueAction}>Retry</Text>
              )}
            </TouchableOpacity>
          </>
        ) : null}

        {productionStarted ? (
          <>
            <View style={styles.spacer} />
            <Card title="Production Log">
              {productionDone.map((row, i) => (
                <ProductionLogRow
                  key={row.rowToken}
                  row={row}
                  index={i + 1}
                  locked
                  editing={editingRowToken === row.rowToken}
                  onToggleEdit={() =>
                    setEditingRowToken(t => (t === row.rowToken ? null : row.rowToken))
                  }
                  onChange={(field, value) => updateDoneRow(row.rowToken, field, value)}
                />
              ))}
              <ProductionLogRow
                row={productionLive}
                index={productionDone.length + 1}
                locked={false}
                onChange={updateLogRow}
                onStart={startLogRow}
                onStop={stopLogRow}
              />
              {/* The running total the operator reconciles the job against.
                  Styled as a summary footer, not a filled block -- see the
                  totalsRow style for why. */}
              <View style={styles.totalsRow}>
                <View style={styles.totalsCell}>
                  <Text style={styles.totalsLabel}>TOTAL MTRS</Text>
                  <Text style={styles.totalsValue}>{totalMeter.toFixed(2)} m</Text>
                </View>
                <View style={styles.totalsDivider} />
                <View style={styles.totalsCell}>
                  <Text style={styles.totalsLabel}>SQ. MTRS</Text>
                  <Text style={styles.totalsValue}>{sqMtr.toFixed(2)}</Text>
                </View>
              </View>
            </Card>
            <View style={styles.spacer} />
            {/* The two ways out of a running job, side by side under the
                Production Log. Pause keeps the job open for later; End Job is
                the one that closes it and saves the card, so it's the filled
                navy half and Pause is the hollow one beside it. */}
            <View style={styles.jobActionsRow}>
              <Button
                title="Pause"
                icon="pause"
                variant="outline"
                size="sm"
                onPress={handlePause}
                loading={pausing}
                disabled={saving}
                style={styles.jobActionButton}
              />
              <Button
                title="End Job"
                icon="check"
                size="sm"
                onPress={handleEndJob}
                loading={saving}
                disabled={pausing}
                style={styles.jobActionButton}
              />
            </View>
            <Text style={styles.jobActionsHint}>
              Pause keeps this job in your queue. End Job saves the card and closes it.
            </Text>
          </>
        ) : jobSettingComplete && canPunch ? (
          <>
            <View style={styles.spacer} />
            <Button title="Start Production" icon="play" variant="success" onPress={handleStartProduction} />
          </>
        ) : (
          <Text style={styles.hintText}>
            {runningOnOther
              ? `This job is running on ${runningOnOther}. Finish and save it there before running it here.`
              : !materialsMounted
              ? `Scan or type every raw material before starting — still to mount: ${missingPoolsLabel}.`
              : 'Punch Start and Stop on every Job Setting row to unlock Production.'}
          </Text>
        )}

        <View style={styles.spacer} />

        <MaterialUsedDialog
          visible={materialUsedVisible}
          layerAllotments={prefill.layerAllotments}
          materialSwapLog={data.materialSwapLog}
          onCancel={() => setMaterialUsedVisible(false)}
          onSubmit={usage => {
            setMaterialUsedVisible(false);
            submitJobCard(usage);
          }}
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

      <Toast toast={toast} onHide={hideToast} />
    </View>
  );
}

// One cell of the job-summary row -- small uppercase label over a large bold
// value, matching the web form's .mid-label / .mid-value pair. Declared at
// module level (not inside JobCardScreen) so React keeps the same component
// type across renders.
const dashed = value =>
  value === null || value === undefined || String(value).trim() === '' ? '—' : String(value);

function MidItem({ label, value, note }) {
  return (
    <View style={styles.midItem}>
      <Text style={styles.midLabel} numberOfLines={2}>
        {label}
      </Text>
      <Text style={styles.midValue} numberOfLines={2}>
        {dashed(value)}
      </Text>
      {note ? <Text style={styles.midNote}>{note}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  printQueueBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.noticeBg,
    borderWidth: 1,
    borderColor: colors.noticeBorder,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  printQueueText: { flex: 1 },
  printQueueTitle: { fontSize: 13.5, fontWeight: '700', color: colors.noticeText, fontFamily },
  printQueueSub: { fontSize: 11.5, color: colors.textMuted, marginTop: 2, fontFamily },
  printQueueAction: { fontSize: 12.5, fontWeight: '700', color: colors.primary, fontFamily },
  root: { flex: 1, backgroundColor: colors.background },
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  loadErrorText: { color: colors.dangerStrong, textAlign: 'center', marginBottom: spacing.md, fontFamily },
  backButton: { minWidth: 160 },
  spacer: { height: spacing.md },
  infoLine: { fontSize: 13, color: colors.textDark, marginBottom: 3, fontFamily },
  // .material-id-row -- one row, four columns, tinted panel.
  midRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: colors.headerRowBg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    // Real separation between the four figures rather than 4px of padding --
    // at 320dp they otherwise read as one run of digits.
    gap: spacing.md,
  },
  // No horizontal padding of its own: the row's `gap` owns the spacing, so the
  // first and last columns stay flush with the panel's own padding.
  midItem: { flex: 1 },
  midLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: colors.textMuted,
    marginBottom: 3,
    // Two lines' worth. "Deckle Qty" wraps in a quarter-width column at 320dp,
    // and reserving the taller box for EVERY label is what keeps all four
    // values on one baseline -- sizing to one line would drop the wrapped
    // column's value below its neighbours.
    lineHeight: 12,
    minHeight: 24,
    fontFamily,
  },
  // .mid-value -- deliberately the largest, heaviest text on the screen:
  // these are the figures the operator runs the job against.
  midValue: {
    fontSize: 17,
    fontWeight: '800',
    color: colors.textDark,
    fontFamily,
  },
  midNote: { fontSize: 9.5, fontWeight: '600', color: colors.warningText, marginTop: 2, fontFamily },
  table: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    overflow: 'hidden',
  },
  tableRow: { flexDirection: 'row', alignItems: 'center' },
  tableHead: {
    backgroundColor: colors.headerRowBg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tableRowDivider: { borderTopWidth: 1, borderTopColor: colors.borderLight },
  tableHeadCell: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: colors.textMuted,
    paddingVertical: 7,
    paddingHorizontal: spacing.sm,
    fontFamily,
  },
  tableCell: {
    fontSize: 12.5,
    color: colors.textDark,
    paddingVertical: 8,
    paddingHorizontal: spacing.sm,
    fontFamily,
  },
  // Mirrors the web table's .jc-recipe-tag -- the layer name reads as the
  // row's own label rather than just another cell.
  tableCellTag: { color: colors.primary, fontWeight: '700' },
  // The mounted reel's code when it differs from the recipe's. Information,
  // not an error -- running a different-but-valid combination is allowed (the
  // reel already passed the recipe check) -- so it reads as a quiet aside next
  // to the planned code, not a red flag.
  recipeAltCode: { color: colors.textMuted, fontWeight: '600' },
  colLayer: { flex: 1.5 },
  colValue: { flex: 1.3 },
  colNum: { flex: 1, textAlign: 'right' },
  rollLine: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  rollLineText: { flex: 1 },
  rollLineTitle: { fontWeight: '600', color: colors.textDark, fontFamily },
  rollLineSub: { fontSize: 12, color: colors.textMuted, fontFamily },
  addRowButton: { alignSelf: 'flex-start', marginTop: spacing.xs },
  addRowText: { color: colors.primary, fontWeight: '600', fontSize: 13, fontFamily },
  // A read-only summary, NOT an action: a solid navy rounded block reads as a
  // button here, especially stacked directly above the navy "Save Production
  // Entry" button. A light tinted panel with a rule above it keeps the figures
  // prominent while clearly belonging to the log it closes -- the same job the
  // web table's <tfoot> total row does.
  totalsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  totalsCell: { flex: 1 },
  totalsDivider: {
    width: 1,
    alignSelf: 'stretch',
    backgroundColor: colors.borderLight,
    marginHorizontal: spacing.md,
  },
  totalsLabel: {
    fontSize: 9.5,
    fontWeight: '700',
    letterSpacing: 0.5,
    color: colors.textMuted,
    fontFamily,
  },
  totalsValue: { fontSize: 17, fontWeight: '800', color: colors.primary, marginTop: 2, fontFamily },
  // Equal halves: neither exit is a sub-action of the other, and at 320dp two
  // full-width-ish targets still clear a gloved thumb.
  jobActionsRow: { flexDirection: 'row', gap: spacing.md },
  jobActionButton: { flex: 1 },
  jobActionsHint: {
    marginTop: spacing.sm,
    fontSize: 11.5,
    color: colors.textMuted,
    textAlign: 'center',
    fontFamily,
  },
  hintText: {
    marginTop: spacing.md,
    fontSize: 12.5,
    color: colors.textMuted,
    textAlign: 'center',
    fontFamily,
  },
});
