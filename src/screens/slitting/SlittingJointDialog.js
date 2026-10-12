import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, Modal, TouchableOpacity, StyleSheet } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { colors, radii, spacing, fontFamily } from '../../theme/theme';
import Button from '../../theme/Button';
import Toast, { useToast } from '../../theme/Toast';
import { validateJointMtr } from '../../utils/meters';

// A Deckle is ONE web (not the lamination card's facestock + release laminate),
// so this records a single defect -- the slitting counterpart of
// jobcard/JointDialog.js, with no material to choose. "None" clears a joint that
// was recorded by mistake. Same card, dropdown and buttons, so the two cards
// read as one product.
const KINDS = [
  { key: '', label: 'None' },
  { key: 'Joint', label: 'Joint' },
  { key: 'Wrinkle', label: 'Wrinkle' },
];

// A tap-to-open picker styled to match the dialog's text inputs -- copied from
// jobcard/JointDialog.js so the two dialogs look identical.
function Dropdown({ open, onToggleOpen, onSelect, value, options, accessibilityLabel }) {
  const current = options.find(opt => opt.key === value) || options[0];
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
                key={opt.key || 'none'}
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

// Records one Deckle web's defect, in place of the always-on chip row + metre
// field that used to sit in the row. `joint` / `jointMtr` are the current
// values (for editing a finished row's note, or correcting a live one);
// `startMtrs` / `stopMtrs` bound the metre reading -- a joint is a mark on web
// that has already run, so it sits past the start reading and no later than the
// stop (blank on a row still running, which just leaves the upper bound off).
export default function SlittingJointDialog({ visible, joint, jointMtr, startMtrs, stopMtrs, onCancel, onSubmit }) {
  const [kind, setKind] = useState('');
  const [mtr, setMtr] = useState('');
  const [openDrop, setOpenDrop] = useState(false);
  const { toast, showToast, hideToast } = useToast();

  // Load the current value each time the dialog opens, so the fields describe
  // the entry being edited rather than starting blank.
  useEffect(() => {
    if (!visible) {
      return;
    }
    setKind(joint || '');
    setMtr(jointMtr === undefined || jointMtr === null ? '' : String(jointMtr));
    setOpenDrop(false);
    hideToast();
  }, [visible, joint, jointMtr, hideToast]);

  const handleSubmit = () => {
    // None clears the joint -- nothing to validate, and the metre is dropped.
    if (!kind) {
      onSubmit({ joint: '', jointMtr: '' });
      return;
    }
    const error = validateJointMtr(startMtrs, stopMtrs, mtr);
    if (error) {
      showToast(error);
      return;
    }
    onSubmit({ joint: kind, jointMtr: String(mtr).trim() });
  };

  return (
    <Modal visible={!!visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Record a Joint</Text>
          <Text style={styles.subtitle}>What happened on this Deckle web, and where on it.</Text>

          <Text style={styles.label}>Defect</Text>
          <Dropdown
            open={openDrop}
            onToggleOpen={() => setOpenDrop(o => !o)}
            onSelect={key => {
              setKind(key);
              setOpenDrop(false);
            }}
            value={kind}
            options={KINDS}
            accessibilityLabel="Defect"
          />

          {kind ? (
            <>
              <Text style={styles.label}>Metres</Text>
              <TextInput
                style={styles.input}
                value={mtr}
                onChangeText={setMtr}
                onFocus={() => setOpenDrop(false)}
                keyboardType="numeric"
                placeholder="Counter reading the joint ran at"
                placeholderTextColor={colors.textMuted}
              />
            </>
          ) : null}

          <View style={styles.buttonRow}>
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
  backdrop: { flex: 1, backgroundColor: 'rgba(11,31,51,0.55)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  card: {
    width: '100%', maxWidth: 360, backgroundColor: colors.cardBg, borderRadius: radii.lg, padding: spacing.lg,
    shadowColor: '#0B1F33', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.18, shadowRadius: 20, elevation: 6,
  },
  title: { fontSize: 16, fontWeight: '800', color: colors.textDark, fontFamily },
  subtitle: { fontSize: 12.5, color: colors.textMuted, marginTop: 2, fontFamily },
  label: { fontSize: 9.5, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase', color: colors.textMuted, marginTop: spacing.lg, marginBottom: 5, fontFamily },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, paddingHorizontal: spacing.sm, paddingVertical: 8, fontSize: 14, color: colors.textDark, fontFamily },
  dropdown: { position: 'relative', zIndex: 1 },
  dropdownRaised: { zIndex: 20, elevation: 20 },
  dropdownTrigger: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, paddingHorizontal: spacing.sm, paddingVertical: 9, backgroundColor: colors.cardBg },
  dropdownValue: { fontSize: 14, color: colors.textDark, fontFamily },
  dropdownMenu: {
    position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, backgroundColor: colors.cardBg,
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, paddingVertical: 4,
    shadowColor: '#0B1F33', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.18, shadowRadius: 12, elevation: 12,
  },
  dropdownOption: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.sm, paddingVertical: 9 },
  dropdownOptionActive: { backgroundColor: colors.rowMatchBg },
  dropdownOptionText: { fontSize: 14, color: colors.textDark, fontFamily },
  dropdownOptionTextActive: { fontWeight: '700', color: colors.primary },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xl },
  button: { flex: 1 },
  cancelButton: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, paddingVertical: 10, alignItems: 'center', justifyContent: 'center' },
  cancelButtonText: { color: colors.textDark, fontSize: 13, fontWeight: '700', fontFamily },
});
