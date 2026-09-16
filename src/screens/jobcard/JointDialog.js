import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, Modal, TouchableOpacity, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { colors, radii, spacing, fontFamily } from '../../theme/theme';
import Button from '../../theme/Button';
import Toast, { useToast } from '../../theme/Toast';
import { validateJointMtr } from '../../utils/meters';

// Which material the defect was on, and what kind it was. Both lists are fixed
// -- the same two webs the job card model carries a joint for
// (machineJobCard.js's face / release, still the values sent back), and the
// same two defect kinds the row's old segmented control offered.
const MATERIALS = [
  { key: 'face', label: 'Face' },
  { key: 'release', label: 'Release' },
];
const KINDS = [
  { key: 'Joint', label: 'Joint' },
  { key: 'Wrinkle', label: 'Wrinkle' },
];

// A tap-to-open picker styled to match the dialog's text inputs. Inline rather
// than a nested Modal (this dialog is itself a Modal): the option lists are two
// items each, so the menu overlays the field below it without needing its own
// layer. `open` / `onToggle` are lifted so only one dropdown is ever open and
// focusing a field closes both.
function Dropdown({ open, onToggleOpen, onSelect, value, options, accessibilityLabel }) {
  const current = options.find(opt => opt.key === value);
  return (
    <View style={[styles.dropdown, open && styles.dropdownRaised]}>
      <TouchableOpacity
        style={styles.dropdownTrigger}
        activeOpacity={0.7}
        onPress={onToggleOpen}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ expanded: open }}>
        <Text style={styles.dropdownValue}>{current?.label ?? ''}</Text>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={20} color={colors.textMuted} />
      </TouchableOpacity>
      {open ? (
        <View style={styles.dropdownMenu}>
          {options.map(opt => {
            const active = opt.key === value;
            return (
              <TouchableOpacity
                key={opt.key}
                style={[styles.dropdownOption, active && styles.dropdownOptionActive]}
                activeOpacity={0.7}
                onPress={() => onSelect(opt.key)}
                accessibilityRole="menuitem"
                accessibilityState={{ selected: active }}>
                <Text style={[styles.dropdownOptionText, active && styles.dropdownOptionTextActive]}>
                  {opt.label}
                </Text>
                {active ? <Icon name="check" size={16} color={colors.primary} /> : null}
              </TouchableOpacity>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

// Records one material defect against a Production Log row, in place of the two
// always-on segmented controls that used to sit in the row itself. Those cost
// a third of the row's height on every deckle, while most deckles run clean
// and never need them -- so entry moves behind the row's "Joint" button and
// what's recorded shows as a short list under Deckle Meters.
//
// Reopening with a material already recorded loads it for correction rather
// than starting blank: the job card stores ONE joint per material per deckle,
// so a second entry against the same one replaces the first, and the dialog
// should show what it is about to replace.
export default function JointDialog({ visible, row, onCancel, onSubmit }) {
  const [web, setWeb] = useState('face');
  const [kind, setKind] = useState('Joint');
  const [mtr, setMtr] = useState('');
  const [reason, setReason] = useState('');
  // Which dropdown is open, if any -- 'material' | 'defect' | null. Lifted here
  // so opening one closes the other and so focusing a text field closes both.
  const [openDrop, setOpenDrop] = useState(null);
  // The dialog carries its own toast: this is a Modal, and a toast rendered by
  // the screen behind it would come up underneath the backdrop.
  const { toast, showToast, hideToast } = useToast();

  // Load whatever that material already holds each time the dialog opens or the
  // material is switched, so the fields always describe the entry being edited.
  useEffect(() => {
    if (!visible) {
      return;
    }
    const joint = web === 'face' ? row?.faceJoint : row?.releaseJoint;
    const meters = web === 'face' ? row?.faceMtr : row?.releaseMtr;
    const why = web === 'face' ? row?.faceJointReason : row?.releaseJointReason;
    setKind(joint || 'Joint');
    setMtr(meters === undefined || meters === null ? '' : String(meters));
    setReason(why || '');
    setOpenDrop(null);
    // The fields just changed underneath it, so any rejection still showing is
    // about a reading that is no longer on screen.
    hideToast();
  }, [visible, web, row, hideToast]);

  // A joint is a mark on material that has already run through the machine, so
  // it sits past this row's own start reading and no later than where it
  // stopped (the stop reading is blank on a row still running, which just
  // leaves the upper bound off). Checked here on Save rather than as the
  // operator types -- see utils/meters.js for why.
  const handleSubmit = () => {
    const error = validateJointMtr(row?.startMtrs, row?.stopMtrs, mtr);
    if (error) {
      showToast(error);
      return;
    }
    onSubmit({ web, kind, mtr: String(mtr).trim(), reason: String(reason).trim() });
  };

  return (
    <Modal visible={!!visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Record a Joint</Text>
          <Text style={styles.subtitle}>Which material, what happened, where on it, and why.</Text>

          <Text style={styles.label}>Material</Text>
          <Dropdown
            open={openDrop === 'material'}
            onToggleOpen={() => setOpenDrop(open => (open === 'material' ? null : 'material'))}
            onSelect={key => {
              setWeb(key);
              setOpenDrop(null);
            }}
            value={web}
            options={MATERIALS}
            accessibilityLabel="Material"
          />

          <Text style={styles.label}>Defect</Text>
          <Dropdown
            open={openDrop === 'defect'}
            onToggleOpen={() => setOpenDrop(open => (open === 'defect' ? null : 'defect'))}
            onSelect={key => {
              setKind(key);
              setOpenDrop(null);
            }}
            value={kind}
            options={KINDS}
            accessibilityLabel="Defect"
          />

          <Text style={styles.label}>Metres</Text>
          <TextInput
            style={styles.input}
            value={mtr}
            onChangeText={setMtr}
            onFocus={() => setOpenDrop(null)}
            keyboardType="numeric"
            placeholder="0"
            placeholderTextColor={colors.textMuted}
          />

          {/* Why the joint happened. Free text and optional -- an operator
              who doesn't know the cause must still be able to record the
              joint, and forcing a guess would only put noise in the data. */}
          <Text style={styles.label}>Reason</Text>
          <TextInput
            style={[styles.input, styles.reasonInput]}
            value={reason}
            onChangeText={setReason}
            onFocus={() => setOpenDrop(null)}
            multiline
            numberOfLines={2}
            textAlignVertical="top"
            placeholder="Enter a reason"
            // Set explicitly, as everywhere else in the app: the platform
            // default hint colour renders near-white on this theme.
            placeholderTextColor={colors.textMuted}
          />

          <View style={styles.buttonRow}>
            {/* Outlined by hand rather than through Button: it has no ghost
                variant, and an unknown variant falls back to navy -- Cancel
                would come out looking exactly like Save. */}
            <TouchableOpacity activeOpacity={0.85} onPress={onCancel} style={[styles.button, styles.cancelButton]}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
            <Button title="Save" onPress={handleSubmit} style={styles.button} />
          </View>
        </View>

        <Toast toast={toast} onHide={hideToast} />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(11,31,51,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: colors.cardBg,
    borderRadius: radii.lg,
    padding: spacing.lg,
    shadowColor: '#0B1F33',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 20,
    elevation: 6,
  },
  title: { fontSize: 16, fontWeight: '800', color: colors.textDark, fontFamily },
  subtitle: { fontSize: 12.5, color: colors.textMuted, marginTop: 2, fontFamily },
  label: {
    fontSize: 9.5,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: colors.textMuted,
    marginTop: spacing.lg,
    marginBottom: 5,
    fontFamily,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 8,
    fontSize: 14,
    color: colors.textDark,
    fontFamily,
  },
  reasonInput: { minHeight: 56, paddingTop: 8 },
  // While a dropdown is open its menu is absolutely positioned over whatever
  // sits below, so the open one has to win the stacking order against the next
  // field (later siblings render on top by default).
  dropdown: { position: 'relative', zIndex: 1 },
  dropdownRaised: { zIndex: 20, elevation: 20 },
  dropdownTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 9,
    backgroundColor: colors.cardBg,
  },
  dropdownValue: { fontSize: 14, color: colors.textDark, fontFamily },
  dropdownMenu: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    marginTop: 4,
    backgroundColor: colors.cardBg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingVertical: 4,
    shadowColor: '#0B1F33',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 12,
  },
  dropdownOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: 9,
  },
  dropdownOptionActive: { backgroundColor: colors.rowMatchBg },
  dropdownOptionText: { fontSize: 14, color: colors.textDark, fontFamily },
  dropdownOptionTextActive: { fontWeight: '700', color: colors.primary },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xl },
  button: { flex: 1 },
  cancelButton: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelButtonText: { color: colors.textDark, fontSize: 13, fontWeight: '700', fontFamily },
});
