import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, Switch, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { useFocusEffect } from '@react-navigation/native';
import { colors, radii, spacing, fontFamily } from '../theme/theme';
import Button from '../theme/Button';
import Card from '../theme/Card';
import { PrinterService } from '../services/PrinterService';
import { DEFAULT_PORT, DEFAULT_TIMEOUT_MS, CONNECTION_STATUS, STATUS_LABELS } from '../constants/printer';
import {
  emptyPrinter,
  getPrinters,
  savePrinter,
  deletePrinter,
  setDefaultPrinter,
} from '../storage/printersStorage';
import { printQueue } from '../services/printQueue';

// One look per tone, shared by the status card and the result line: success
// green, error red, a waiting amber, an informational blue, and a neutral
// slate for "nothing is happening" -- which, for a printer the app connects to
// per label and lets go of straight after, is the normal resting state, not a
// fault.
const TONES = {
  success: { color: '#047857', bg: colors.rowMatchBg, border: '#86EFAC', icon: 'check-circle' },
  error: { color: colors.dangerStrong, bg: colors.rowShortBg, border: '#FCA5A5', icon: 'alert-circle' },
  waiting: { color: colors.noticeText, bg: colors.noticeBg, border: colors.noticeBorder, icon: 'sync' },
  info: { color: colors.primaryDark, bg: colors.infoPanelBg, border: colors.border, icon: 'information' },
  neutral: { color: colors.holdText, bg: colors.holdBg, border: colors.holdBorder, icon: 'printer' },
};

const STATUS_LOOK = {
  [CONNECTION_STATUS.CONNECTED]: { tone: 'success', icon: 'printer-check' },
  [CONNECTION_STATUS.CONNECTING]: { tone: 'waiting', icon: 'printer' },
  [CONNECTION_STATUS.DISCONNECTED]: { tone: 'neutral', icon: 'printer' },
  [CONNECTION_STATUS.OFFLINE]: { tone: 'error', icon: 'printer-off' },
  [CONNECTION_STATUS.ERROR]: { tone: 'error', icon: 'printer-alert' },
};

// A labelled input in the login screen's style: tinted well, navy border while
// it has focus. Declared at module level so React keeps the same component
// type across renders (a component defined inside the screen would remount on
// every keystroke and drop the keyboard).
function Field({ label, icon, hint, style, ...inputProps }) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={[styles.field, style]}>
      <Text style={styles.label}>{label}</Text>
      <View style={[styles.inputWrap, focused && styles.inputWrapFocused]}>
        {icon ? <Icon name={icon} size={18} color={focused ? colors.primary : colors.textMuted} /> : null}
        <TextInput
          style={styles.input}
          placeholderTextColor={colors.disabled}
          autoCorrect={false}
          autoCapitalize="none"
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          {...inputProps}
        />
      </View>
      {hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
    </View>
  );
}

export default function PrinterSettingsScreen() {
  const [printers, setPrinters] = useState([]);
  const [form, setForm] = useState(emptyPrinter());
  // The live connection as PrinterService reports it -- status, and the
  // address and last error that go with it.
  const [conn, setConn] = useState(() => PrinterService.getState());
  // The outcome of the last action on this screen, shown right under the
  // buttons that caused it: { text, tone }.
  const [message, setMessage] = useState(null);
  const [testing, setTesting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  // Deckle labels that were produced but haven't reached the printer yet.
  const [queueJobs, setQueueJobs] = useState([]);
  const [queueBusy, setQueueBusy] = useState(false);
  const [queueError, setQueueError] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState({ scanned: 0, total: 0 });
  const [foundHosts, setFoundHosts] = useState([]);
  // A scan has finished (so "nothing found" can be said), and why one failed.
  const [scanDone, setScanDone] = useState(false);
  const [scanError, setScanError] = useState(null);

  useEffect(() => PrinterService.subscribe(state => setConn(state)), []);

  const loadPrinters = useCallback(async () => {
    const list = await getPrinters();
    setPrinters(list);
    const current = list.find(p => p.isDefault) ?? list[0];
    if (current) {
      setForm(current);
    }
    return list;
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadPrinters();
    }, [loadPrinters]),
  );

  const setField = (field, value) => setForm(f => ({ ...f, [field]: value }));
  const say = (text, tone) => setMessage({ text, tone });
  const hasIp = !!String(form.ip || '').trim();

  const handleSave = async () => {
    const saved = await savePrinter({
      ...form,
      port: Number(form.port) || DEFAULT_PORT,
      timeoutMs: Number(form.timeoutMs) || DEFAULT_TIMEOUT_MS,
    });
    await loadPrinters();
    setForm(saved);
    say('Printer settings saved', 'success');
  };

  const handleTest = async () => {
    setTesting(true);
    const result = await PrinterService.testConnection(
      form.ip,
      Number(form.port) || DEFAULT_PORT,
      Number(form.timeoutMs) || DEFAULT_TIMEOUT_MS,
    );
    setTesting(false);
    say(result.ok ? 'Connection successful' : `Test failed: ${result.error}`, result.ok ? 'success' : 'error');
  };

  const handleConnect = async () => {
    setConnecting(true);
    try {
      await PrinterService.connectPrinter(form.ip, Number(form.port) || DEFAULT_PORT, {
        timeoutMs: Number(form.timeoutMs) || DEFAULT_TIMEOUT_MS,
        autoReconnect: form.autoReconnect,
      });
      say('Printer connected', 'success');
    } catch (err) {
      say(`Connection failed: ${err.message}`, 'error');
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = () => {
    PrinterService.disconnectPrinter();
    say('Printer disconnected', 'info');
  };

  const handleScan = async () => {
    setScanning(true);
    setScanDone(false);
    setScanError(null);
    setFoundHosts([]);
    setScanProgress({ scanned: 0, total: 0 });
    try {
      await PrinterService.scanNetwork({
        port: Number(form.port) || DEFAULT_PORT,
        onProgress: (scanned, total) => setScanProgress({ scanned, total }),
        onFound: host => setFoundHosts(prev => [...prev, host]),
      });
      setScanDone(true);
    } catch (err) {
      setScanError(err.message);
    } finally {
      setScanning(false);
    }
  };

  const pickFoundHost = host => {
    setField('ip', host);
    say(`IP address set to ${host} — tap Save Settings to keep it.`, 'info');
  };

  // Start a blank form, so a second printer can be added instead of
  // overwriting the one being edited.
  const startNewPrinter = () => {
    setForm(emptyPrinter());
    setMessage(null);
  };

  const handleDelete = async printer => {
    await deletePrinter(printer.id);
    const list = await loadPrinters();
    // The last printer gone: the form must not keep pointing at it.
    if (!list.length) {
      setForm(emptyPrinter());
    }
  };

  useEffect(
    () =>
      printQueue.subscribe(({ jobs, flushing, lastError }) => {
        setQueueJobs(jobs);
        setQueueBusy(flushing);
        setQueueError(lastError);
      }),
    [],
  );

  // Opening this screen is itself a good moment to retry: the operator is
  // usually here because a label didn't come out, and by the time they leave
  // the printer details may be fixed.
  useFocusEffect(
    useCallback(() => {
      printQueue.flush();
    }, []),
  );

  // ── Status card ──────────────────────────────────────────────────────────
  const look = STATUS_LOOK[conn.status] || STATUS_LOOK[CONNECTION_STATUS.DISCONNECTED];
  const tone = TONES[look.tone];
  const defaultPrinter = printers.find(p => p.isDefault) ?? printers[0] ?? null;
  const connAddress = conn.ip ? `${conn.ip}:${conn.port}` : '';
  let statusDetail;
  if (conn.status === CONNECTION_STATUS.CONNECTED) {
    statusDetail = `Connected to ${connAddress}`;
  } else if (conn.status === CONNECTION_STATUS.CONNECTING) {
    statusDetail = `Connecting to ${connAddress}…`;
  } else if (conn.status === CONNECTION_STATUS.ERROR || conn.status === CONNECTION_STATUS.OFFLINE) {
    statusDetail = conn.lastError || 'The printer did not respond.';
  } else if (defaultPrinter) {
    // Idle is normal: every label opens its own connection and closes it.
    statusDetail = `${defaultPrinter.name} · ${defaultPrinter.ip}:${defaultPrinter.port} — connects by itself for each label.`;
  } else {
    statusDetail = 'No printer set up yet — add one below.';
  }

  const scanPct = scanProgress.total ? Math.round((scanProgress.scanned / scanProgress.total) * 100) : 0;
  const scanPort = Number(form.port) || DEFAULT_PORT;
  const messageTone = message ? TONES[message.tone] || TONES.info : null;

  return (
    <KeyboardAwareScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      enableOnAndroid
      extraScrollHeight={24}
      keyboardShouldPersistTaps="handled">
      <View style={[styles.statusCard, { borderLeftColor: tone.color }]}>
        <View style={[styles.statusIcon, { backgroundColor: tone.bg, borderColor: tone.border }]}>
          {conn.status === CONNECTION_STATUS.CONNECTING ? (
            <ActivityIndicator size="small" color={tone.color} />
          ) : (
            <Icon name={look.icon} size={24} color={tone.color} />
          )}
        </View>
        <View style={styles.statusText}>
          <Text style={styles.statusCaption}>PRINTER STATUS</Text>
          <Text style={[styles.statusValue, { color: tone.color }]}>{STATUS_LABELS[conn.status] || conn.status}</Text>
          <Text style={styles.statusDetail} numberOfLines={3}>
            {statusDetail}
          </Text>
        </View>
      </View>

      {/* Labels a Deckle produced that the printer hasn't taken yet. Nothing
          is shown when the queue is empty -- the normal case is that a label
          prints by itself the moment its Deckle is made and never appears
          here at all. */}
      {queueJobs.length > 0 ? (
        <Card title={`Labels Waiting to Print (${queueJobs.length})`} style={styles.section}>
          {queueJobs.map((job, i) => (
            <View key={job.id} style={[styles.listRow, i > 0 && styles.listRowDivider]}>
              <View style={[styles.rowIcon, styles.rowIconWarn]}>
                <Icon name="printer-alert" size={18} color={colors.noticeText} />
              </View>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {job.rollId || job.stockId}
                </Text>
                <Text style={styles.rowSub} numberOfLines={1}>
                  {job.productCode ? `${job.productCode} · ` : ''}
                  {job.attempts ? `${job.attempts} failed attempt${job.attempts > 1 ? 's' : ''}` : 'Waiting'}
                </Text>
                {job.lastError ? <Text style={styles.rowError}>{job.lastError}</Text> : null}
              </View>
              {/* Discarding is a real decision -- the reel exists and its
                  sticker is outstanding -- so it stays a deliberate per-label
                  action rather than a "clear all". */}
              <TouchableOpacity
                style={styles.discardButton}
                onPress={() => printQueue.remove(job.id)}
                accessibilityRole="button"
                accessibilityLabel={`Discard the label for ${job.rollId || job.stockId}`}>
                <Text style={styles.discardText}>Discard</Text>
              </TouchableOpacity>
            </View>
          ))}
          {queueError ? (
            <View style={[styles.inlineNote, { backgroundColor: TONES.error.bg, borderColor: TONES.error.border }]}>
              <Icon name="alert-circle" size={16} color={TONES.error.color} />
              <Text style={[styles.inlineNoteText, { color: TONES.error.color }]}>{queueError}</Text>
            </View>
          ) : null}
          <Button
            title={queueBusy ? 'Printing…' : 'Print all now'}
            icon="printer"
            onPress={() => printQueue.flush()}
            loading={queueBusy}
            style={styles.blockButton}
          />
        </Card>
      ) : null}

      {printers.length > 0 ? (
        <Card title="Saved Printers" style={styles.section}>
          {printers.map((printer, i) => {
            const editing = form.id === printer.id;
            return (
              <TouchableOpacity
                key={printer.id}
                activeOpacity={0.8}
                style={[styles.printerRow, i > 0 && styles.printerRowGap, editing && styles.printerRowEditing]}
                onPress={() => setForm(printer)}
                accessibilityRole="button"
                accessibilityLabel={`Edit ${printer.name}`}>
                <View style={[styles.rowIcon, printer.isDefault && styles.rowIconDefault]}>
                  <Icon name="printer" size={18} color={printer.isDefault ? '#FFFFFF' : colors.primary} />
                </View>
                <View style={styles.rowText}>
                  <View style={styles.nameLine}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {printer.name}
                    </Text>
                    {printer.isDefault ? (
                      <View style={styles.defaultPill}>
                        <Icon name="star" size={11} color={colors.primary} />
                        <Text style={styles.defaultPillText}>Default</Text>
                      </View>
                    ) : null}
                  </View>
                  <Text style={styles.rowSub} numberOfLines={1}>
                    {printer.ip || 'No IP address'}:{printer.port}
                    {editing ? ' · Editing below' : ''}
                  </Text>
                  {!printer.isDefault ? (
                    <TouchableOpacity
                      style={styles.makeDefault}
                      hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
                      onPress={async () => {
                        await setDefaultPrinter(printer.id);
                        loadPrinters();
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`Make ${printer.name} the default printer`}>
                      <Icon name="star-outline" size={14} color={colors.primary} />
                      <Text style={styles.makeDefaultText}>Make Default</Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
                <TouchableOpacity
                  style={styles.deleteButton}
                  onPress={() => handleDelete(printer)}
                  accessibilityRole="button"
                  accessibilityLabel={`Delete ${printer.name}`}>
                  <Icon name="trash-can-outline" size={20} color={colors.dangerStrong} />
                </TouchableOpacity>
              </TouchableOpacity>
            );
          })}
          <TouchableOpacity
            style={styles.addPrinter}
            onPress={startNewPrinter}
            accessibilityRole="button"
            accessibilityLabel="Add another printer">
            <Icon name="plus" size={18} color={colors.primary} />
            <Text style={styles.addPrinterText}>Add another printer</Text>
          </TouchableOpacity>
        </Card>
      ) : null}

      <Card title="Connection Details" style={styles.section}>
        <View style={styles.formMode}>
          <Icon name={form.id ? 'pencil' : 'plus'} size={14} color={colors.textMuted} />
          <Text style={styles.formModeText} numberOfLines={1}>
            {form.id ? `Editing ${form.name || 'saved printer'}` : 'New printer — not saved yet'}
          </Text>
        </View>

        <Field
          label="Printer Name"
          icon="tag-outline"
          value={form.name}
          onChangeText={v => setField('name', v)}
          placeholder="TSC Printer"
          autoCapitalize="words"
        />
        <Field
          label="Printer IP Address"
          icon="lan-connect"
          value={form.ip}
          onChangeText={v => setField('ip', v)}
          keyboardType="numeric"
          placeholder="192.168.1.50"
        />
        <View style={styles.fieldPair}>
          <Field
            label="Port"
            value={String(form.port ?? '')}
            onChangeText={v => setField('port', v)}
            keyboardType="number-pad"
            placeholder={String(DEFAULT_PORT)}
            style={styles.fieldHalf}
          />
          <Field
            label="Timeout (ms)"
            value={String(form.timeoutMs ?? '')}
            onChangeText={v => setField('timeoutMs', v)}
            keyboardType="number-pad"
            placeholder={String(DEFAULT_TIMEOUT_MS)}
            style={styles.fieldHalf}
          />
        </View>

        <View style={styles.switchRow}>
          <View style={styles.switchText}>
            <Text style={styles.switchLabel}>Auto Reconnect</Text>
            <Text style={styles.switchHint}>Connect again by itself if the connection drops.</Text>
          </View>
          <Switch
            value={!!form.autoReconnect}
            onValueChange={v => setField('autoReconnect', v)}
            trackColor={{ false: colors.border, true: '#93C5FD' }}
            thumbColor={form.autoReconnect ? colors.primary : '#F8FAFC'}
          />
        </View>

        <Button
          title="Test Connection"
          icon="lan-connect"
          variant="outline"
          onPress={handleTest}
          loading={testing}
          disabled={!hasIp}
          style={styles.blockButton}
        />
        <Button
          title="Save Settings"
          icon="content-save"
          onPress={handleSave}
          disabled={!hasIp}
          style={styles.stackedButton}
        />

        {message ? (
          <View style={[styles.inlineNote, { backgroundColor: messageTone.bg, borderColor: messageTone.border }]}>
            <Icon name={messageTone.icon} size={16} color={messageTone.color} />
            <Text style={[styles.inlineNoteText, { color: messageTone.color }]}>{message.text}</Text>
          </View>
        ) : null}

        {/* Labels connect and let go on their own, so holding a connection
            open is a check, not a step -- kept below the line, a size down. */}
        <View style={styles.divider} />
        <Text style={styles.subheading}>MANUAL CONNECTION</Text>
        <Text style={styles.cardHint}>Labels connect by themselves. Use these only to check the printer.</Text>
        <View style={styles.buttonRow}>
          <Button
            title="Connect"
            icon="printer-check"
            variant="success"
            size="sm"
            onPress={handleConnect}
            loading={connecting}
            disabled={!hasIp}
            style={styles.buttonHalf}
          />
          <Button
            title="Disconnect"
            icon="lan-disconnect"
            variant="danger"
            size="sm"
            onPress={handleDisconnect}
            style={styles.buttonHalf}
          />
        </View>
      </Card>

      <Card title="Network Scanner" style={styles.section}>
        <Text style={styles.cardHint}>
          Looks for printers on this Wi-Fi network that take labels on port {scanPort}.
        </Text>
        <Button
          title={scanDone || foundHosts.length ? 'Scan Again' : 'Scan Local Network'}
          icon="radar"
          variant="outline"
          onPress={handleScan}
          loading={scanning}
          disabled={scanning}
          style={styles.blockButton}
        />

        {scanning ? (
          <View style={styles.scanProgress}>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${scanPct}%` }]} />
            </View>
            <Text style={styles.progressText}>
              {scanProgress.total
                ? `Checked ${scanProgress.scanned} of ${scanProgress.total} addresses`
                : 'Finding this Wi-Fi network…'}
              {foundHosts.length ? ` · ${foundHosts.length} found` : ''}
            </Text>
          </View>
        ) : null}

        {scanError ? (
          <View style={[styles.inlineNote, { backgroundColor: TONES.error.bg, borderColor: TONES.error.border }]}>
            <Icon name="alert-circle" size={16} color={TONES.error.color} />
            <Text style={[styles.inlineNoteText, { color: TONES.error.color }]}>{scanError}</Text>
          </View>
        ) : null}

        {foundHosts.map(host => {
          const inUse = host === String(form.ip || '').trim();
          return (
            <TouchableOpacity
              key={host}
              style={[styles.foundRow, inUse && styles.foundRowInUse]}
              onPress={() => pickFoundHost(host)}
              accessibilityRole="button"
              accessibilityLabel={`Use printer at ${host}`}>
              <View style={styles.rowIcon}>
                <Icon name="printer" size={18} color={colors.primary} />
              </View>
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>{host}</Text>
                <Text style={styles.rowSub}>{inUse ? 'In the form above' : 'Printer found — tap to use'}</Text>
              </View>
              <Icon
                name={inUse ? 'check-circle' : 'chevron-right'}
                size={20}
                color={inUse ? TONES.success.color : colors.textMuted}
              />
            </TouchableOpacity>
          );
        })}

        {scanDone && !scanning && !foundHosts.length ? (
          <Text style={styles.emptyText}>
            No printer answered on port {scanPort}. Check that it is switched on and on the same Wi-Fi as this
            tablet.
          </Text>
        ) : null}
      </Card>
    </KeyboardAwareScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  // The bottom padding keeps the last card clear of the app-wide offline bar,
  // which floats over the bottom of every screen.
  content: { padding: spacing.lg, paddingBottom: spacing.xl * 4 },
  section: { marginBottom: spacing.md },

  // Status card -- the first thing on the screen, so its state reads at a
  // glance: a coloured edge and icon well, a big label, one line of detail.
  statusCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.cardBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 5,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  statusIcon: {
    width: 48,
    height: 48,
    borderRadius: radii.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  statusText: { flex: 1 },
  statusCaption: { fontSize: 10, fontWeight: '700', letterSpacing: 0.6, color: colors.textMuted, fontFamily },
  statusValue: { fontSize: 18, fontWeight: '800', marginTop: 1, fontFamily },
  statusDetail: { fontSize: 12, color: colors.textMuted, marginTop: 2, lineHeight: 17, fontFamily },

  // List rows shared by the label queue, saved printers and scan results.
  listRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm },
  listRowDivider: { borderTopWidth: 1, borderTopColor: colors.borderLight },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: radii.pill,
    backgroundColor: colors.infoPanelBg,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  rowIconWarn: { backgroundColor: colors.noticeBg, borderColor: colors.noticeBorder },
  rowIconDefault: { backgroundColor: colors.primary, borderColor: colors.primary },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: 14, fontWeight: '700', color: colors.textDark, flexShrink: 1, fontFamily },
  rowSub: { fontSize: 12, color: colors.textMuted, marginTop: 2, fontFamily },
  rowError: { fontSize: 11.5, color: colors.warningText, marginTop: 2, fontFamily },
  discardButton: {
    borderWidth: 1,
    borderColor: colors.dangerStrong,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    minHeight: 36,
    justifyContent: 'center',
  },
  discardText: { color: colors.dangerStrong, fontSize: 12, fontWeight: '700', fontFamily },

  // Saved printers: each one a tappable tile; the one in the form below is
  // outlined in navy so it's clear which printer Save will change.
  printerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radii.sm,
    backgroundColor: '#FFFFFF',
  },
  printerRowGap: { marginTop: spacing.sm },
  printerRowEditing: { borderColor: colors.primary, backgroundColor: colors.infoPanelBg },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs + 2 },
  defaultPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: radii.pill,
    paddingHorizontal: 6,
    paddingVertical: 1,
    flexShrink: 0,
  },
  defaultPillText: { fontSize: 10.5, fontWeight: '700', color: colors.primary, fontFamily },
  makeDefault: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', marginTop: 6 },
  makeDefaultText: { fontSize: 12, fontWeight: '700', color: colors.primary, fontFamily },
  // 44dp square: the trash glyph is small, its target must not be.
  deleteButton: {
    width: 44,
    height: 44,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  addPrinter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs + 2,
    marginTop: spacing.sm,
    minHeight: 44,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.primary,
    borderRadius: radii.sm,
  },
  addPrinterText: { fontSize: 13.5, fontWeight: '700', color: colors.primary, fontFamily },

  // Connection Details form.
  formMode: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: spacing.xs },
  formModeText: { flex: 1, fontSize: 12, fontWeight: '600', color: colors.textMuted, fontFamily },
  field: { marginTop: spacing.sm },
  fieldPair: { flexDirection: 'row', gap: spacing.sm },
  fieldHalf: { flex: 1 },
  label: { fontSize: 12.5, fontWeight: '600', color: colors.textDark, marginBottom: 6, fontFamily },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: colors.headerRowBg,
    paddingHorizontal: spacing.md,
  },
  inputWrapFocused: { borderColor: colors.primary, backgroundColor: '#FFFFFF' },
  input: { flex: 1, paddingVertical: spacing.sm + 2, fontSize: 15, color: colors.textDark, fontFamily },
  fieldHint: { fontSize: 11, color: colors.textMuted, marginTop: 4, fontFamily },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radii.sm,
    backgroundColor: colors.headerRowBg,
  },
  switchText: { flex: 1 },
  switchLabel: { fontSize: 13.5, fontWeight: '600', color: colors.textDark, fontFamily },
  switchHint: { fontSize: 11.5, color: colors.textMuted, marginTop: 2, fontFamily },
  blockButton: { marginTop: spacing.md },
  stackedButton: { marginTop: spacing.sm },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  buttonHalf: { flex: 1 },
  divider: { height: 1, backgroundColor: colors.borderLight, marginTop: spacing.lg, marginBottom: spacing.md },
  subheading: { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.6, color: colors.textMuted, fontFamily },
  cardHint: { fontSize: 12, color: colors.textMuted, marginTop: 2, lineHeight: 17, fontFamily },

  // A result line under whatever produced it, in that result's tone.
  inlineNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginTop: spacing.md,
  },
  inlineNoteText: { flex: 1, fontSize: 12.5, fontWeight: '600', lineHeight: 17, fontFamily },

  // Network scanner.
  scanProgress: { marginTop: spacing.md },
  progressTrack: { height: 6, borderRadius: radii.pill, backgroundColor: colors.borderLight, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: radii.pill, backgroundColor: colors.primary },
  progressText: { fontSize: 11.5, color: colors.textMuted, marginTop: 6, fontFamily },
  foundRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.borderLight,
    borderRadius: radii.sm,
  },
  foundRowInUse: { borderColor: '#86EFAC', backgroundColor: colors.rowMatchBg },
  emptyText: { fontSize: 12.5, color: colors.textMuted, marginTop: spacing.md, lineHeight: 18, fontFamily },
});
