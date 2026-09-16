import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Switch,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { colors, radii, spacing, fontFamily } from '../theme/theme';
import Button from '../theme/Button';
import Card from '../theme/Card';
import { PrinterService } from '../services/PrinterService';
import { DEFAULT_PORT, DEFAULT_TIMEOUT_MS, CONNECTION_STATUS } from '../constants/printer';
import {
  emptyPrinter,
  getPrinters,
  savePrinter,
  deletePrinter,
  setDefaultPrinter,
} from '../storage/printersStorage';
import { printQueue } from '../services/printQueue';

export default function PrinterSettingsScreen() {
  const [printers, setPrinters] = useState([]);
  const [form, setForm] = useState(emptyPrinter());
  const [status, setStatus] = useState(CONNECTION_STATUS.DISCONNECTED);
  const [message, setMessage] = useState('');
  const [testing, setTesting] = useState(false);
  // Deckle labels that were produced but haven't reached the printer yet.
  const [queueJobs, setQueueJobs] = useState([]);
  const [queueBusy, setQueueBusy] = useState(false);
  const [queueError, setQueueError] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState({ scanned: 0, total: 0 });
  const [foundHosts, setFoundHosts] = useState([]);

  useEffect(() => {
    const unsubscribe = PrinterService.subscribe(state => setStatus(state.status));
    return unsubscribe;
  }, []);

  const loadPrinters = useCallback(async () => {
    const list = await getPrinters();
    setPrinters(list);
    const current = list.find(p => p.isDefault) ?? list[0];
    if (current) {
      setForm(current);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadPrinters();
    }, [loadPrinters]),
  );

  const setField = (field, value) => setForm(f => ({ ...f, [field]: value }));

  const handleSave = async () => {
    const saved = await savePrinter({
      ...form,
      port: Number(form.port) || DEFAULT_PORT,
      timeoutMs: Number(form.timeoutMs) || DEFAULT_TIMEOUT_MS,
    });
    await loadPrinters();
    setForm(saved);
    setMessage('Printer settings saved');
  };

  const handleTest = async () => {
    setTesting(true);
    const result = await PrinterService.testConnection(
      form.ip,
      Number(form.port) || DEFAULT_PORT,
      Number(form.timeoutMs) || DEFAULT_TIMEOUT_MS,
    );
    setTesting(false);
    setMessage(result.ok ? 'Connection successful' : `Test failed: ${result.error}`);
  };

  const handleConnect = async () => {
    try {
      await PrinterService.connectPrinter(form.ip, Number(form.port) || DEFAULT_PORT, {
        timeoutMs: Number(form.timeoutMs) || DEFAULT_TIMEOUT_MS,
        autoReconnect: form.autoReconnect,
      });
      setMessage('Printer connected');
    } catch (err) {
      setMessage(`Connection failed: ${err.message}`);
    }
  };

  const handleDisconnect = () => {
    PrinterService.disconnectPrinter();
    setMessage('Printer disconnected');
  };

  const handleScan = async () => {
    setScanning(true);
    setFoundHosts([]);
    setScanProgress({ scanned: 0, total: 0 });
    try {
      await PrinterService.scanNetwork({
        port: Number(form.port) || DEFAULT_PORT,
        onProgress: (scanned, total) => setScanProgress({ scanned, total }),
        onFound: host => setFoundHosts(prev => [...prev, host]),
      });
    } catch (err) {
      setMessage(err.message);
    } finally {
      setScanning(false);
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

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.statusRow}>
        <Text style={styles.statusLabel}>Status: </Text>
        <Text style={styles.statusValue}>{status}</Text>
      </View>

      {/* Labels a Deckle produced that the printer hasn't taken yet. Nothing
          is shown when the queue is empty -- the normal case is that a label
          prints by itself the moment its Deckle is made and never appears
          here at all. */}
      {queueJobs.length > 0 ? (
        <Card title={`Labels Waiting to Print (${queueJobs.length})`} style={styles.section}>
          {queueJobs.map(job => (
            <View key={job.id} style={styles.queueRow}>
              <View style={styles.queueRowText}>
                <Text style={styles.queueRollId}>{job.rollId || job.stockId}</Text>
                <Text style={styles.queueSub}>
                  {job.productCode ? `${job.productCode} · ` : ''}
                  {job.attempts ? `${job.attempts} failed attempt${job.attempts > 1 ? 's' : ''}` : 'Waiting'}
                </Text>
                {job.lastError ? <Text style={styles.queueError}>{job.lastError}</Text> : null}
              </View>
              {/* Discarding is a real decision -- the reel exists and its
                  sticker is outstanding -- so it stays a deliberate per-label
                  action rather than a "clear all". */}
              <TouchableOpacity style={styles.queueDiscard} onPress={() => printQueue.remove(job.id)}>
                <Text style={styles.queueDiscardText}>Discard</Text>
              </TouchableOpacity>
            </View>
          ))}
          {queueError ? <Text style={styles.queueError}>{queueError}</Text> : null}
          <Button
            title={queueBusy ? 'Printing…' : 'Print all now'}
            onPress={() => printQueue.flush()}
            loading={queueBusy}
            style={styles.queueButton}
          />
        </Card>
      ) : null}

      {printers.length > 0 ? (
        <Card title="Saved Printers" style={styles.section}>
          {printers.map(printer => (
            <TouchableOpacity key={printer.id} style={styles.printerRow} onPress={() => setForm(printer)}>
              <View style={styles.printerRowText}>
                <Text style={styles.printerName}>
                  {printer.isDefault ? '★ ' : ''}
                  {printer.name}
                </Text>
                <Text style={styles.printerSub}>
                  {printer.ip}:{printer.port}
                </Text>
              </View>
              <View style={styles.printerRowActions}>
                {!printer.isDefault ? (
                  <TouchableOpacity
                    onPress={async () => {
                      await setDefaultPrinter(printer.id);
                      loadPrinters();
                    }}>
                    <Text style={styles.printerAction}>Make Default</Text>
                  </TouchableOpacity>
                ) : null}
                <TouchableOpacity
                  onPress={async () => {
                    await deletePrinter(printer.id);
                    loadPrinters();
                  }}>
                  <Text style={[styles.printerAction, styles.printerActionDanger]}>Delete</Text>
                </TouchableOpacity>
              </View>
            </TouchableOpacity>
          ))}
        </Card>
      ) : null}

      <Card title="Connection Details" style={styles.section}>
        <Text style={styles.label}>Printer Name</Text>
        <TextInput style={styles.input} value={form.name} onChangeText={v => setField('name', v)} />

        <Text style={styles.label}>Printer IP Address</Text>
        <TextInput
          style={styles.input}
          value={form.ip}
          onChangeText={v => setField('ip', v)}
          keyboardType="numeric"
          placeholder="192.168.1.50"
        />

        <Text style={styles.label}>Port</Text>
        <TextInput
          style={styles.input}
          value={String(form.port)}
          onChangeText={v => setField('port', v)}
          keyboardType="number-pad"
        />

        <Text style={styles.label}>Connection Timeout (ms)</Text>
        <TextInput
          style={styles.input}
          value={String(form.timeoutMs)}
          onChangeText={v => setField('timeoutMs', v)}
          keyboardType="number-pad"
        />

        <View style={styles.switchRow}>
          <Text style={styles.label}>Auto Reconnect</Text>
          <Switch value={form.autoReconnect} onValueChange={v => setField('autoReconnect', v)} />
        </View>

        <View style={styles.buttonRow}>
          <Button title="Test Connection" onPress={handleTest} loading={testing} style={styles.buttonHalf} />
          <Button title="Save Settings" onPress={handleSave} style={styles.buttonHalf} />
        </View>
        <View style={styles.buttonRow}>
          <Button title="Connect" onPress={handleConnect} variant="success" style={styles.buttonHalf} />
          <Button title="Disconnect" onPress={handleDisconnect} variant="danger" style={styles.buttonHalf} />
        </View>
      </Card>

      <Card title="Network Scanner" style={styles.section}>
        <Button
          title={scanning ? `Scanning… (${scanProgress.scanned}/${scanProgress.total})` : 'Scan Local Network'}
          onPress={handleScan}
          loading={scanning}
          disabled={scanning}
        />
        {foundHosts.map(host => (
          <TouchableOpacity key={host} style={styles.foundHostRow} onPress={() => setField('ip', host)}>
            <Text style={styles.foundHostText}>{host}</Text>
            <Text style={styles.foundHostSub}>Printer found — tap to use</Text>
          </TouchableOpacity>
        ))}
      </Card>

      {message ? (
        <View style={styles.messageBanner}>
          <Text style={styles.messageText}>{message}</Text>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  queueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  queueRowText: { flex: 1 },
  queueRollId: { fontSize: 13.5, fontWeight: '700', color: colors.textDark, fontFamily },
  queueSub: { fontSize: 11.5, color: colors.textMuted, marginTop: 2, fontFamily },
  queueError: { fontSize: 11.5, color: colors.warningText, marginTop: 2, fontFamily },
  queueDiscard: {
    borderWidth: 1,
    borderColor: colors.dangerStrong,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  queueDiscardText: { color: colors.dangerStrong, fontSize: 11.5, fontWeight: '700', fontFamily },
  queueButton: { marginTop: spacing.md },
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg },
  statusRow: { flexDirection: 'row', marginBottom: spacing.md },
  statusLabel: { color: colors.textMuted, fontFamily },
  statusValue: { color: colors.textDark, fontWeight: '700', fontFamily },
  section: { marginBottom: spacing.md },
  label: { fontSize: 12, fontWeight: '600', color: colors.textMuted, marginBottom: 4, marginTop: spacing.sm, fontFamily },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 14,
    color: colors.textDark,
    fontFamily,
  },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  buttonHalf: { flex: 1 },
  printerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  printerRowText: { flex: 1 },
  printerName: { fontWeight: '600', color: colors.textDark, fontFamily },
  printerSub: { fontSize: 12, color: colors.textMuted, fontFamily },
  printerRowActions: { flexDirection: 'row', gap: spacing.md },
  printerAction: { color: colors.primary, fontSize: 12, fontWeight: '600', fontFamily },
  printerActionDanger: { color: colors.dangerStrong },
  foundHostRow: { paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.borderLight },
  foundHostText: { fontWeight: '600', color: colors.textDark, fontFamily },
  foundHostSub: { fontSize: 11, color: colors.textMuted, fontFamily },
  messageBanner: {
    backgroundColor: colors.infoPanelBg,
    borderRadius: radii.sm,
    padding: spacing.sm,
    marginTop: spacing.sm,
  },
  messageText: { color: colors.primaryDark, fontSize: 13, fontFamily },
});
