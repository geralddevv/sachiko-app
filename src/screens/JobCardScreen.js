import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert, AppState } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { colors, radii, spacing, fontFamily } from '../theme/theme';
import Card from '../theme/Card';
import Button from '../theme/Button';
import AppDialog from '../theme/AppDialog';
import Toast, { useToast } from '../theme/Toast';
import MaterialsMountedStrip from './jobcard/MaterialsMountedStrip';
import JobSettingRow from './jobcard/JobSettingRow';
import ProductionLogRow from './jobcard/ProductionLogRow';
import MaterialUsedDialog from './jobcard/MaterialUsedDialog';
import PauseDialog from './jobcard/PauseDialog';
import { getJobCard, postJobCard, claimJob, heartbeatJob, ApiError, isOfflineError } from '../services/api';
import { getDraft, saveDraft, clearDraft, draftStartedHere } from '../storage/draftStorage';
import { outbox, useOutboxPending } from '../services/outbox';
import { subscribeProduced } from '../services/liveSync';
import {
  startDeckle as startOvertimeTimer,
  stopRun as stopOvertimeTimer,
  pauseJob as pauseOvertimeTimers,
  resumeJob as resumeOvertimeTimers,
  clearJob as clearOvertimeTimers,
  startBreak as startBreakTimer,
} from '../services/overtimeReminder';
import { useOffline, useOnReconnect } from '../services/connectivity';
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

// "1:05 PM" -- how the card shows when a hold began.
const clockOf = ms => {
  const d = new Date(ms);
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};

// The body of a deckle's Stop -- POST /jobcard/log/produce -- from its row.
// Built from the row alone, so a Stop that has to be sent again later (see
// the recovery in `load`) carries exactly what the first one did.
const producePayload = (pendingId, row) => ({
  pendingId,
  rowToken: row.rowToken,
  fsRollId: row.fsRollId,
  adRollId: row.adRollId,
  rlRollId: row.rlRollId,
  materialsUsed: row.materialsUsed,
  startMtrs: row.startMtrs,
  stopMtrs: row.stopMtrs,
  meters: row.meters,
  faceJoint: row.faceJoint,
  faceJointReason: row.faceJointReason,
  faceMtr: row.faceMtr,
  releaseJoint: row.releaseJoint,
  releaseJointReason: row.releaseJointReason,
  releaseMtr: row.releaseMtr,
  startTime: row.startTime,
  endTime: row.endTime,
});

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
  // The job is on hold -- { at, reason } -- from this tablet's Pause, or the
  // server's when the job was paused elsewhere. Kept in the draft. While it is
  // set the office's WIP tab shows the job ON HOLD with its clock stopped.
  const [paused, setPaused] = useState(null);
  const [pauseDialogOpen, setPauseDialogOpen] = useState(false);
  const offline = useOffline();
  // This job's punches still waiting in the outbox (services/outbox.js).
  const unsentPunches = useOutboxPending(pendingId);
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

  // Re-take the running claim without holding anything up. `claimHeld` is
  // screen state, so leaving this job card -- Pause, an app restart, or just
  // backing out to the queue -- drops it, and with it the heartbeat; nothing
  // took it back, so a job still running on this device read "Started, last
  // seen <the moment they left>" on the office's WIP tab for the rest of the
  // run. A 409 means another device has the job now, which disables the
  // punches the same way a lost heartbeat does. Any other failure (offline)
  // is left for the next punch to retry -- the floor never waits on this.
  const reclaim = useCallback(() => {
    claimJob(pendingId)
      .then(() => {
        setClaimHeld(true);
        setRunningOnOther(null);
      })
      .catch(err => {
        if (err instanceof ApiError && err.status === 409) {
          setRunningOnOther(err.body?.runningOnLabel || 'another device');
        }
      });
  }, [pendingId]);

  // Take the job off hold: the server hears it through the outbox (so it is
  // kept, and dated when tapped, even offline) and the card stops showing the
  // hold. Any punch while on hold does this first -- a Start or Stop means the
  // machine is running again, whether or not Resume was tapped.
  const resumeNow = useCallback(() => {
    outbox.enqueue('resume', pendingId, { pendingId }).catch(() => {});
    resumeOvertimeTimers(pendingId);
    setPaused(null);
  }, [pendingId]);
  const pausedRef = useRef(null);
  pausedRef.current = paused;
  const resumeIfPaused = useCallback(() => {
    if (pausedRef.current) {
      resumeNow();
    }
  }, [resumeNow]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await getJobCard(pendingId);
      setData(res);
      setRunningOnOther(res.runningElsewhere ? res.runningOnLabel || 'another device' : null);
      const draft = await getDraft(pendingId);
      // Deckle Stops still waiting in the outbox from before -- their rows
      // stay "producing" until the answer comes back (services/liveSync.js).
      await outbox.ready();
      const queuedStops = new Set(outbox.pendingFor(pendingId, 'produce').map(op => op.body?.rowToken));
      // On hold: this tablet's own Pause (kept in the draft, and maybe not even
      // sent yet), else the server's -- the job paused on another device.
      const serverHold = res.paused?.since
        ? { at: new Date(res.paused.since).getTime(), reason: res.paused.reason || '' }
        : null;
      const hold = draft?.paused?.at ? draft.paused : serverHold;
      if (draft) {
        setMounted(draft.mounted || emptyMounted());
        setJobSetting(draft.jobSetting?.length ? draft.jobSetting : [emptyJsRow()]);
        setProductionLive(draft.productionLive || emptyLogRow());
        // `producing` is in-flight UI state, not a fact about the row: it is
        // true only while that row's Stop is still in the outbox. Restored
        // from the draft as-is it could sit on "Moving to Semi Finished
        // Stock…" forever after an app kill.
        const done = (draft.productionDone || []).map(r => ({ ...r, producing: queuedStops.has(r.rowToken) }));
        // A stopped row with no Deckle, no Stop waiting and no refusal on it
        // lost its Stop somewhere -- an app build that sent it only once, or
        // an answer that never got written back. Sent again: the server
        // matches the row's token, so it hands back the Deckle it already made
        // or makes the one it never did, and either way the label prints now
        // rather than at End Job.
        done.forEach(r => {
          if (!r.deckleId && !r.producing && !r.produceError && r.endTime && Number(r.meters) > 0) {
            r.producing = true;
            outbox.enqueue('produce', pendingId, producePayload(pendingId, r)).catch(() => {});
          }
        });
        setProductionDone(done);
        setSubmissionToken(draft.submissionToken || res.submissionToken);
        setProductionStarted(!!draft.productionStarted);
        // Only a job THIS device had already started -- opening one just to
        // look still doesn't tie it up (see ensureClaim below).
        if (draftStartedHere(draft)) {
          reclaim();
        }
      } else {
        setMounted(emptyMounted());
        setJobSetting([emptyJsRow()]);
        setProductionLive(emptyLogRow());
        setProductionDone([]);
        setSubmissionToken(res.submissionToken);
        setProductionStarted(false);
      }
      // Opened with the queue's Resume button: that tap is the resume.
      // Opened any other way, a job on hold stays on hold, and says so.
      if (hold && route.params?.resume) {
        navigation.setParams({ resume: undefined });
        resumeNow();
        showToast('Job resumed — the office sees it running again.', 'success');
      } else {
        setPaused(hold);
      }
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Could not load this job.');
    } finally {
      setLoading(false);
    }
    // route.params.resume is read once, at open; it is cleared right after.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingId, reclaim, resumeNow]);

  useEffect(() => {
    load();
  }, [load]);

  // A deckle's Stop answered by the server in the background -- write its
  // Deckle ID (or why it was refused) into this card's own copy of the row,
  // which the autosave then keeps. liveSync has already queued its label.
  useEffect(
    () =>
      subscribeProduced(({ pendingId: forJob, rowToken, patch }) => {
        if (forJob !== String(pendingId)) {
          return;
        }
        setProductionDone(rows => rows.map(r => (r.rowToken === rowToken ? { ...r, ...patch } : r)));
      }),
    [pendingId],
  );

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
      saveDraft(pendingId, {
        submissionToken,
        mounted,
        jobSetting,
        productionLive,
        productionDone,
        productionStarted,
        paused,
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [pendingId, submissionToken, mounted, jobSetting, productionLive, productionDone, productionStarted, paused]);

  // Write the draft NOW, with `changes` over what is on screen -- for the
  // moments that can't wait out the autosave's 400ms: a deckle's Stop (its
  // row must be in the draft before the server's answer comes back to be
  // written into it) and Pause (the screen is about to close).
  const persistNow = changes =>
    saveDraft(pendingId, {
      submissionToken,
      mounted,
      jobSetting,
      productionLive,
      productionDone,
      productionStarted,
      paused,
      ...changes,
    });

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
  // currently mounted -- see routes/api/operatorApi.js's mark-in-use. Through
  // the outbox like every live punch: never blocks the operator, and no
  // longer lost when the network is down at that moment.
  const markMountedInUse = useCallback(() => {
    ['facestock', 'adhesive', 'release'].forEach(pool => {
      const reel = mounted[pool];
      if (!reel) return;
      outbox.enqueue('mark-in-use', pendingId, { pendingId, pool, rollId: reel.rollId }).catch(() => {});
    });
  }, [mounted, pendingId]);

  // ── Running claim ──────────────────────────────────────────────────────
  // Taken lazily at the first Start punch rather than on open, so browsing a
  // job's recipe from a second device doesn't tie the job up.
  //
  // Only an actual refusal (409: the job is live on another device) stops the
  // punch. Anything else -- no connection, the server erroring -- lets it go
  // ahead: the punch is safe in the outbox, the claim is re-taken the moment
  // the server is back (the reconnect handler below), and refusing would have
  // told the operator the job was "running on another device" when all that
  // was wrong was the Wi-Fi -- and then disabled every punch on the card.
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
      if (!(err instanceof ApiError && err.status === 409)) {
        return true;
      }
      const label = err.body?.runningOnLabel;
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
  //
  // Android stops JS timers while the screen is off, which on a long deckle is
  // most of the time -- so the beat is also sent the moment the app is back in
  // front, rather than up to a minute later, and the office's "operator app
  // online" catches up as soon as the operator picks the tablet up.
  useEffect(() => {
    if (!claimHeld) {
      return undefined;
    }
    const beat = async () => {
      try {
        await heartbeatJob(pendingId);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setClaimHeld(false);
          setRunningOnOther(err.body?.runningOnLabel || 'another device');
        }
      }
    };
    const everyMs = data?.heartbeatMs || 60000;
    const timer = setInterval(beat, everyMs);
    const appStateSub = AppState.addEventListener('change', state => {
      if (state === 'active') {
        beat();
      }
    });
    return () => {
      clearInterval(timer);
      appStateSub.remove();
    };
  }, [claimHeld, pendingId, data?.heartbeatMs]);

  // The server is back after a drop: a job under way here takes its claim
  // straight back (the heartbeat may have lapsed while it was gone), rather
  // than waiting for the next punch to notice.
  const startedHereRef = useRef(false);
  startedHereRef.current = draftStartedHere({ productionStarted, jobSetting, productionDone, productionLive });
  useOnReconnect(() => {
    if (startedHereRef.current) {
      reclaim();
    }
  });

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
    resumeIfPaused();
    markMountedInUse();
    // Through the outbox, like every live punch: the office's WIP view hears
    // of it as soon as the server can, and the punch never waits on that.
    outbox
      .enqueue('setting-start', pendingId, { pendingId, startTime: time, startMtrs: jobSetting[index]?.mtrs1 })
      .catch(() => {});
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
    resumeIfPaused();
    outbox
      .enqueue('setting-stop', pendingId, { pendingId, startTime: jobSetting[index]?.startTime })
      .catch(() => {});
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
    // A Production Log punch is the job running -- make sure this device is
    // heartbeating it. In the background, unlike the Job Setting Start: this
    // punch has always gone through offline, and must keep doing so.
    if (!claimHeld) {
      reclaim();
    }
    resumeIfPaused();
    markMountedInUse();
    // Through the outbox: the office's ETA for this deckle counts from this
    // punch, so it is kept until the server has it -- and dated when it was
    // tapped, not when it finally got there.
    outbox
      .enqueue('log-start', pendingId, {
        pendingId,
        rowToken: productionLive.rowToken,
        startTime: time,
        startMtrs: productionLive.startMtrs,
      })
      .catch(() => {});
    // The overtime reminder times this Deckle from this punch, on the tablet --
    // its length over the machine's speed, so it needs no connection.
    startOvertimeTimer({
      kind: 'lamination',
      jobId: pendingId,
      runKey: productionLive.rowToken,
      deckleNo: (Number(data?.prefill?.producedRolls) || 0) + productionDone.length + 1,
      label: data?.timing?.lotNo,
      machineName: data?.timing?.machineName,
      mtrs: data?.timing?.deckleMtrs,
      speedMpm: data?.timing?.speedMpm,
      at: Date.now(),
    });
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
  // row, and sends the instant-produce -- ported from jobCardForm.ejs's
  // commitLogRowStop. Deliberately reads `productionLive` from the current
  // render rather than mutating inside a setState updater: an updater must be
  // a pure function of previous state, and queueing another component's
  // setState from inside one double-fires under React's dev double-invoke.
  //
  // The produce goes through the outbox, and its answer comes back through
  // services/liveSync.js -- which queues the Deckle's label and writes its
  // Deckle ID onto the row (subscribeProduced above) -- whenever the server
  // takes it: now, or once the connection is back. The draft is written
  // straight away too, so the row is in it when that answer arrives even if
  // the app has been closed in between (and if it somehow isn't, reopening
  // the card sends the Stop again -- see the recovery in `load`). A Stop the
  // server refuses leaves the row for the final save to make, as before
  // (matched on its rowToken).
  const commitLogRowStop = time => {
    resumeIfPaused();
    const stopped = { ...productionLive, endTime: time, producing: true };
    const nextDone = [...productionDone, stopped];
    const nextLive = emptyLogRow();
    outbox.enqueue('produce', pendingId, producePayload(pendingId, stopped)).catch(() => {});
    stopOvertimeTimer('lamination', pendingId, productionLive.rowToken);
    setProductionDone(nextDone);
    setProductionLive(nextLive);
    persistNow({ productionDone: nextDone, productionLive: nextLive, paused: null }).catch(() => {});
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
      // This job's live punches still in the outbox go first, so the server
      // has every deckle the card is about to file. Bounded: one that can't go
      // (the server erroring on it) mustn't hold End Job up -- the save files
      // that row itself, matched on its rowToken.
      await outbox.flushFor(pendingId, 15000);
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
      await finishedHere();
      Alert.alert('Saved', outcome.message || 'Production entry saved successfully!', [
        { text: 'OK', onPress: () => navigation.navigate('Home') },
      ]);
    } catch (err) {
      if (err instanceof ApiError && (err.body?.status === 'gate-failed' || err.body?.status === 'wip-clash')) {
        Alert.alert('Cannot save', err.body.message);
      } else if (err instanceof ApiError && err.body?.status === 'duplicate') {
        await finishedHere();
        navigation.navigate('Home');
      } else if (isOfflineError(err)) {
        // The one save that can't wait in the outbox -- the server has to
        // check the materials and file the card there and then. Nothing is
        // lost by it failing: say so, plainly.
        setDialog({
          tone: 'warning',
          title: 'No connection to the server',
          message:
            'The job was not saved yet, but nothing is lost — every punch and reading is kept on this tablet. Tap End Job again once the connection is back.',
          buttons: [{ label: 'OK', onPress: () => setDialog(null) }],
        });
      } else {
        Alert.alert('Save failed', err instanceof ApiError ? err.message : 'Something went wrong.');
      }
    } finally {
      setSaving(false);
    }
  };

  // The card is filed: forget its draft, and the live punches still waiting
  // for it -- sent now, they'd only put the finished job back on the WIP tab
  // (a Start, a Pause). A deckle's Stop stays: its answer still prints the
  // label of a Deckle the save has just made.
  const finishedHere = async () => {
    await clearDraft(pendingId);
    // (A remark on why a Deckle ran late stays too -- it is still owed to the office.)
    await outbox.dropForJob(pendingId, { keepKinds: ['produce', 'overtime-remark'] });
    clearOvertimeTimers(pendingId);
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
  // fetch), not finishing. The card is left unsaved and the job stays in the
  // Work Queue exactly as it is, with every punch, meter reading and mounted
  // reel kept in the draft; reopening it with Resume carries on from here.
  // Deckles already punched out are unaffected -- each one was inwarded to
  // Semi Finished Stock at its own Stop.
  //
  // The server is told too (POST /jobcard/pause, through the outbox so it is
  // kept and dated from the tap even with no connection): the office's WIP tab
  // then shows the job ON HOLD with the reason picked here, and holds its
  // clock -- the deckle on the machine stops filling, nothing turns overdue,
  // and the time on hold is never counted as a delay.
  //
  // The draft is written here directly rather than relying on the 400ms
  // autosave debounce, so nothing can be lost between the tap and the screen
  // going away. The running claim is deliberately left alone: it expires by
  // itself once the heartbeat stops, which is what frees the job for another
  // device if this operator never comes back to it.
  const handlePause = () => setPauseDialogOpen(true);
  const handleResumeTap = () => {
    resumeNow();
    showToast('Job resumed — the office sees it running again.', 'success');
  };
  const confirmPause = async reason => {
    setPauseDialogOpen(false);
    setPausing(true);
    const hold = { at: Date.now(), reason };
    try {
      await Promise.all([
        outbox.enqueue('pause', pendingId, { pendingId, reason }),
        persistNow({ paused: hold }),
        pauseOvertimeTimers(pendingId, hold.at),
        // Tea / Lunch Break: the "break is over" alarm is timed from this tap.
        startBreakTimer({
          jobId: pendingId,
          reason,
          label: data?.timing?.lotNo,
          machineName: data?.timing?.machineName,
          at: hold.at,
        }),
      ]);
    } catch (err) {
      // Both are local writes; the hold still shows on the queue from the
      // state below, and the server hears it once it is stored.
    } finally {
      setPausing(false);
    }
    setPaused(hold);
    navigation.navigate('Home');
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
        {/* Rolls on this job were set before their sales order was placed --
            the same ADVANCE flag the queue card carries. */}
        {prefill.advance ? (
          <View style={styles.advanceBanner}>
            <Text style={styles.advanceBannerText}>
              ADVANCE — {prefill.advance.rolls} roll(s) on this job were set before their sales order. Run it as normal.
            </Text>
          </View>
        ) : null}
        {/* On hold, and opened without the queue's Resume -- say so up top,
            with the way out right there. Any Start or Stop punched below
            resumes it too. */}
        {paused ? (
          <View style={styles.holdBanner}>
            <Icon name="pause-circle" size={22} color={colors.holdText} />
            <View style={styles.holdText}>
              <Text style={styles.holdTitle}>
                On hold since {clockOf(paused.at)}
                {paused.reason ? ` · ${paused.reason}` : ''}
              </Text>
              <Text style={styles.holdSub}>The office sees this job paused until you resume it.</Text>
            </View>
            <TouchableOpacity
              onPress={handleResumeTap}
              accessibilityRole="button"
              accessibilityLabel="Resume this job"
              style={styles.holdButton}>
              <Text style={styles.holdButtonText}>Resume</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        {/* Punches made with no connection, waiting on this tablet. The
            app-wide offline bar says the server is gone; this says what that
            means for THIS job -- nothing lost, it just hasn't reached the
            office yet. */}
        {offline && unsentPunches ? (
          <View style={styles.syncNotice}>
            <Icon name="cloud-upload-outline" size={18} color={colors.noticeText} />
            <Text style={styles.syncNoticeText}>
              {unsentPunches === 1 ? '1 punch' : `${unsentPunches} punches`} saved on this tablet — the office will
              see {unsentPunches === 1 ? 'it' : 'them'} once the connection is back.
            </Text>
          </View>
        ) : null}
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
              index={index}
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
                  index={i}
                  locked
                  editing={editingRowToken === row.rowToken}
                  offline={offline}
                  onToggleEdit={() =>
                    setEditingRowToken(t => (t === row.rowToken ? null : row.rowToken))
                  }
                  onChange={(field, value) => updateDoneRow(row.rowToken, field, value)}
                />
              ))}
              <ProductionLogRow
                row={productionLive}
                index={productionDone.length}
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
                title={paused ? 'Resume' : 'Pause'}
                icon={paused ? 'play' : 'pause'}
                variant={paused ? 'hold' : 'outline'}
                size="sm"
                onPress={paused ? handleResumeTap : handlePause}
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
              {paused ? 'On hold — Resume to carry on. ' : ''}Pause keeps this job in your queue. End Job saves the card and closes it.
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

        {/* A job can go on hold during Job Setting too -- a break doesn't
            wait for production to start. Offered once something has been
            punched here; before that there is nothing running to hold. */}
        {!productionStarted && startedHereRef.current && !runningOnOther ? (
          <>
            <View style={styles.spacer} />
            <Button
              title={paused ? 'Resume' : 'Pause'}
              icon={paused ? 'play' : 'pause'}
              variant={paused ? 'hold' : 'outline'}
              size="sm"
              onPress={paused ? handleResumeTap : handlePause}
              loading={pausing}
            />
          </>
        ) : null}

        <View style={styles.spacer} />

        <PauseDialog visible={pauseDialogOpen} onPause={confirmPause} onCancel={() => setPauseDialogOpen(false)} />

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
  advanceBanner: {
    backgroundColor: colors.advanceBg,
    borderColor: colors.advance,
    borderWidth: 1,
    borderLeftWidth: 5,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.md,
  },
  advanceBannerText: { color: colors.advanceText, fontSize: 12.5, fontWeight: '700', fontFamily },
  holdBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.holdBg,
    borderColor: colors.holdBorder,
    borderWidth: 1,
    borderLeftWidth: 5,
    borderLeftColor: colors.hold,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.md,
  },
  holdText: { flex: 1 },
  holdTitle: { color: colors.holdText, fontSize: 13, fontWeight: '700', fontFamily },
  holdSub: { color: colors.textMuted, fontSize: 11.5, marginTop: 1, fontFamily },
  holdButton: {
    backgroundColor: colors.success,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  holdButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700', fontFamily },
  syncNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.noticeBg,
    borderColor: colors.noticeBorder,
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: spacing.md,
  },
  syncNoticeText: { flex: 1, color: colors.noticeText, fontSize: 12, fontWeight: '600', fontFamily },
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
