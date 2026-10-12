import React, { useEffect, useState } from 'react';
import { View, Text, Modal, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { colors, radii, spacing, fontFamily } from '../../theme/theme';
import { getJobCard, getSlittingCard, isOfflineError } from '../../services/api';
import { fmtMtrs } from '../../utils/meters';
import DeckleWebStrip from '../slitting/DeckleWebStrip';

// Read-only views of a job, opened from the Work Queue's View button so the
// operator can see what a job is before deciding to start it. Opening one only
// reads (getJobCard / getSlittingCard). The claim is taken by Start alone, so a
// View never ties a job up or touches its draft.

const dashed = value =>
  value === null || value === undefined || String(value).trim() === '' ? '—' : String(value);

const errorMessage = err =>
  isOfflineError(err) ? 'Connect to the server to see this job’s layout.' : err?.message || 'Could not load this job.';

// Recipe layer tint by pool. Recipe tags are "Facestock" / "Adhesive" / "Release",
// with " 2" on a second layer of the same pool (DOUBLE FACESTOCK etc.).
const LAYER_BG = { facestock: '#EAF2FA', adhesive: '#FFF8E1', release: '#F1F5F9' };
const layerPool = tag => {
  const t = String(tag || '').toLowerCase();
  if (t.startsWith('facestock')) return 'facestock';
  if (t.startsWith('adhesive')) return 'adhesive';
  if (t.startsWith('release')) return 'release';
  return null;
};

// Material readiness wording, the same three states the queue card's chips use.
const POOL_TEXT = { none: colors.dangerStrong, partial: colors.noticeText, full: '#166534' };
const POOLS = [
  ['Facestock', 'facestockStatus'],
  ['Adhesive', 'adhesiveStatus'],
  ['Release', 'releaseStatus'],
];

// Shared shell: the kicker and lot as the header, a product capsule, a
// scrolling body and one Close. The body is whatever the caller renders.
function JobDialogShell({ visible, kicker, title, subtitle, product, onClose, children }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.head}>
            <View style={styles.headText}>
              {kicker ? <Text style={styles.kicker}>{kicker}</Text> : null}
              <Text style={styles.title} numberOfLines={2}>
                {title}
              </Text>
              {subtitle ? (
                <Text style={styles.subtitle} numberOfLines={1}>
                  {subtitle}
                </Text>
              ) : null}
            </View>
            <View style={styles.productPill}>
              <Text style={styles.productText}>{product}</Text>
            </View>
          </View>

          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            {children}
          </ScrollView>

          <TouchableOpacity onPress={onClose} accessibilityRole="button" style={styles.closeButton}>
            <Text style={styles.closeText}>Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// One figure: small uppercase-feel label over a bold value, as on the job card.
function Tile({ label, value }) {
  return (
    <View style={styles.tile}>
      <Text style={styles.tileLabel} numberOfLines={2}>
        {label}
      </Text>
      <Text style={styles.tileValue} numberOfLines={2}>
        {dashed(value)}
      </Text>
    </View>
  );
}

function Section({ title, children }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

// Lamination job: the recipe layer stack and the reels allotted to it, on top
// of the figures the queue card already carries.
export function LaminationViewDialog({ job, onClose }) {
  const pendingId = job?._id;
  const [prefill, setPrefill] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!pendingId) {
      return undefined;
    }
    let live = true;
    setPrefill(null);
    setError(null);
    getJobCard(pendingId)
      .then(res => {
        if (live) {
          setPrefill(res.prefill || {});
        }
      })
      .catch(err => {
        if (live) {
          setError(errorMessage(err));
        }
      });
    return () => {
      live = false;
    };
  }, [pendingId]);

  const recipe = prefill?.recipe || [];
  const allotments = prefill?.layerAllotments || [];
  const reels = allotments.flatMap(layer => (layer.reels || []).map(reel => ({ layer, reel })));

  return (
    <JobDialogShell
      visible={!!job}
      kicker="LAMINATION JOB"
      title={job?.lotNo}
      product={job?.productCode}
      onClose={onClose}>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      {job && !prefill && !error ? <ActivityIndicator color={colors.primary} style={styles.loader} /> : null}

      {prefill && job ? (
        <>
          {prefill.advance ? (
            <View style={styles.advanceBanner}>
              <Icon name="calendar-clock" size={16} color="#FFFFFF" />
              <Text style={styles.advanceText}>
                ADVANCE: {prefill.advance.rolls} roll(s) set before their sales order. Run it as normal.
              </Text>
            </View>
          ) : null}

          <View style={styles.tileGrid}>
            <Tile label="Deckle Size" value={job.deckleSize ? `${job.deckleSize} mm` : null} />
            <Tile label="RM / Deckle" value={prefill.deckleRunningMeters} />
            <Tile
              label="Deckle Qty"
              value={prefill.deckleTarget !== null && prefill.deckleTarget !== undefined && prefill.deckleTarget !== '' ? prefill.deckleTarget : prefill.quantity}
            />
            <Tile label="Deckles" value={job.rolls} />
            <Tile label="Produced" value={job.producedRolls} />
            <Tile label="Balance" value={job.balanceRolls} />
          </View>

          <Section title="Material readiness">
            <View style={styles.statusRow}>
              {POOLS.map(([label, key]) =>
                job[key] ? (
                  <Text key={key} style={[styles.statusText, { color: POOL_TEXT[job[key]] || POOL_TEXT.none }]}>
                    {label} · {job[key]}
                  </Text>
                ) : null,
              )}
            </View>
            {!job.canStart ? <Text style={styles.noteText}>Awaiting material. Not ready to start yet.</Text> : null}
          </Section>

          <Section title="Layout">
            {recipe.length ? (
              recipe.map((layer, i) => (
                <View
                  key={`${layer.tag}-${i}`}
                  style={[styles.layer, { backgroundColor: LAYER_BG[layerPool(layer.tag)] || '#FFFFFF' }]}>
                  <Text style={styles.layerIndex}>{i + 1}</Text>
                  <Text style={styles.layerTag} numberOfLines={1}>
                    {layer.tag}
                  </Text>
                  <Text style={styles.layerCode} numberOfLines={2}>
                    {dashed(layer.code)}
                  </Text>
                  <Text style={styles.layerGsm}>
                    {layer.gsm !== '' && layer.gsm != null ? `${layer.gsm} GSM` : '—'}
                  </Text>
                </View>
              ))
            ) : (
              <Text style={styles.noteText}>No recipe set for this job.</Text>
            )}
          </Section>

          <Section title="Allocated reels">
            {reels.length ? (
              reels.map(({ layer, reel }) => (
                <View key={reel._id} style={styles.reel}>
                  <Text style={styles.reelTitle}>
                    {layer.label}: {reel.rollId}
                  </Text>
                  <Text style={styles.reelSub}>
                    {reel.reelMtrs} · {reel.location}
                  </Text>
                </View>
              ))
            ) : (
              <Text style={styles.noteText}>No reels allotted to this order yet.</Text>
            )}
          </Section>
        </>
      ) : null}
    </JobDialogShell>
  );
}

// Slitting card: the same header and figures as the queue card, plus each
// Deckle's knife layout drawn to scale (DeckleWebStrip, the card's own picture).
export function SlittingViewDialog({ row, onClose }) {
  const cardId = row?._id;
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!cardId) {
      return undefined;
    }
    let live = true;
    setRows(null);
    setError(null);
    getSlittingCard(cardId)
      .then(res => {
        if (live) {
          setRows(res.card?.rows || []);
        }
      })
      .catch(err => {
        if (live) {
          setError(errorMessage(err));
        }
      });
    return () => {
      live = false;
    };
  }, [cardId]);

  return (
    <JobDialogShell
      visible={!!row}
      title={row?.lotNo}
      subtitle={row?.slittingJobCardId}
      product={row?.productCode}
      onClose={onClose}>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      {row && !rows && !error ? <ActivityIndicator color={colors.primary} style={styles.loader} /> : null}

      {rows && row ? (
        <>
          {row.curing ? (
            <View style={styles.curingBanner}>
              <Icon name="timer-sand" size={16} color={colors.noticeText} />
              <Text style={styles.curingText}>
                Curing{row.curingUntilLabel ? `, ready ${row.curingUntilLabel}` : ''}. The Deckle can be opened but not run yet.
              </Text>
            </View>
          ) : null}

          <View style={styles.tileGrid}>
            <Tile label="R. Meter" value={rows[0]?.plannedRunningMeter ? fmtMtrs(rows[0].plannedRunningMeter) : null} />
            <Tile label="Rolls" value={row.plannedRolls} />
            <Tile label="Rolls to make" value={row.plannedRolls - row.producedRolls} />
          </View>

          <Section title="Knife layout">
            {rows.length ? (
              rows.map((deckle, i) => (
                <View key={`${deckle.deckleId}-${i}`} style={[styles.deckle, i > 0 && styles.deckleDivider]}>
                  <View style={styles.deckleHead}>
                    <Text style={styles.deckleId} numberOfLines={1}>
                      {dashed(deckle.deckleId)}
                    </Text>
                    <Text style={styles.deckleMeta}>
                      {fmtMtrs(deckle.width)} mm · {fmtMtrs(deckle.plannedMeter)} m
                    </Text>
                  </View>
                  <DeckleWebStrip row={deckle} />
                </View>
              ))
            ) : (
              <Text style={styles.noteText}>No Deckles allocated to this card.</Text>
            )}
          </Section>
        </>
      ) : null}
    </JobDialogShell>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(11,31,51,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    maxHeight: '88%',
    backgroundColor: colors.cardBg,
    borderRadius: radii.lg,
    overflow: 'hidden',
    shadowColor: '#0B1F33',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 20,
    elevation: 6,
  },
  head: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  headText: { flex: 1 },
  kicker: { fontSize: 10.5, fontWeight: '800', color: '#BFD9EC', letterSpacing: 0.8, fontFamily },
  title: { fontSize: 18, fontWeight: '800', color: '#FFFFFF', marginTop: 2, fontFamily },
  subtitle: { fontSize: 12, fontWeight: '600', color: '#BFD9EC', marginTop: 1, fontFamily },
  productPill: {
    borderRadius: radii.pill,
    borderWidth: 2,
    borderColor: '#FFFFFF',
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
  productText: { fontSize: 15, fontWeight: '900', color: '#FFFFFF', letterSpacing: 0.4, fontFamily },
  body: { flexShrink: 1 },
  bodyContent: { padding: spacing.lg, paddingBottom: spacing.md },
  loader: { marginVertical: spacing.xl },
  errorText: { color: '#842029', fontSize: 13, fontFamily, marginBottom: spacing.md },
  advanceBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.advance,
    borderRadius: radii.sm,
    padding: spacing.sm,
    marginBottom: spacing.md,
  },
  advanceText: { flex: 1, color: '#FFFFFF', fontSize: 12, fontWeight: '700', fontFamily },
  curingBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.noticeBg,
    borderWidth: 1,
    borderColor: colors.noticeBorder,
    borderRadius: radii.sm,
    padding: spacing.sm,
    marginBottom: spacing.md,
  },
  curingText: { flex: 1, color: colors.noticeText, fontSize: 12, fontWeight: '600', fontFamily },
  tileGrid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -4 },
  tile: {
    width: '33.33%',
    paddingHorizontal: 4,
    paddingVertical: spacing.xs,
  },
  tileLabel: {
    fontSize: 10.5,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    fontFamily,
  },
  tileValue: { fontSize: 15, fontWeight: '800', color: colors.textDark, marginTop: 2, fontFamily },
  section: {
    marginTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.md,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: colors.primaryDark,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: spacing.sm,
    fontFamily,
  },
  statusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  statusText: { fontSize: 12.5, fontWeight: '700', fontFamily },
  noteText: { fontSize: 12.5, color: colors.textMuted, fontFamily },
  layer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: 6,
    gap: spacing.sm,
  },
  layerIndex: { width: 16, fontSize: 11, fontWeight: '800', color: colors.textMuted, fontFamily },
  layerTag: { width: 92, fontSize: 12.5, fontWeight: '800', color: colors.primaryDark, fontFamily },
  layerCode: { flex: 1, fontSize: 13, fontWeight: '700', color: colors.textDark, fontFamily },
  layerGsm: { fontSize: 12, fontWeight: '700', color: colors.textMuted, fontFamily },
  reel: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginBottom: 6,
  },
  reelTitle: { fontSize: 13, fontWeight: '700', color: colors.textDark, fontFamily },
  reelSub: { fontSize: 12, color: colors.textMuted, marginTop: 1, fontFamily },
  deckle: { paddingVertical: spacing.sm },
  deckleDivider: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: spacing.sm },
  deckleHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 },
  deckleId: { flex: 1, fontSize: 13, fontWeight: '800', color: colors.textDark, marginRight: spacing.sm, fontFamily },
  deckleMeta: { fontSize: 12, fontWeight: '600', color: colors.textMuted, fontFamily },
  closeButton: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  closeText: { fontSize: 15, fontWeight: '700', color: colors.primary, fontFamily },
});
