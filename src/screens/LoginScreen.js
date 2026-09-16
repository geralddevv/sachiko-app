import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, TextInput, StyleSheet, ScrollView, TouchableOpacity, Modal } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';
import { colors, radii, spacing, fontFamily } from '../theme/theme';
import Button from '../theme/Button';
import AppLogo from '../theme/AppLogo';
import { login, getLocations, ApiError, isOfflineError } from '../services/api';
// Sign-in geolocation is temporarily disabled -- see services/geolocation.js.
// import { getLoginLocation } from '../services/geolocation';

// Mirrors SACHIKO2's operator login page (views/auth/operatorLogin.ejs +
// public/css/login.css): brand mark in a rounded navy-tinted square, a white
// card, "Login" / "Sign in to your work queue" copy. The server
// address itself is fixed (see storage/authStorage.js's getServerUrl) --
// deliberately not shown or editable here, unlike an earlier revision.
export default function LoginScreen({ onLoggedIn }) {
  const [operatorNick, setOperatorNick] = useState('');
  const [location, setLocation] = useState('');
  const [locations, setLocations] = useState([]);
  const [locationModalVisible, setLocationModalVisible] = useState(false);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [focusedField, setFocusedField] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const passwordRef = useRef(null);

  const loadLocations = useCallback(async () => {
    try {
      const data = await getLocations();
      setLocations(data.locations || []);
    } catch (err) {
      // Non-fatal -- the operator can still type a location by hand.
    }
  }, []);

  useEffect(() => {
    loadLocations();
  }, [loadLocations]);

  const handleLogin = async () => {
    setError(null);
    if (!operatorNick.trim() || !location.trim() || !password) {
      setError('Please fill in all three fields.');
      return;
    }
    setLoading(true);
    try {
      // Sign-in geolocation is temporarily disabled: no device position is
      // read or sent to the server for now. Re-add `geo` here and restore the
      // getLoginLocation import above to turn it back on.
      await login({ operatorNick: operatorNick.trim(), location: location.trim(), password });
      onLoggedIn();
    } catch (err) {
      if (isOfflineError(err)) {
        // OfflineBanner is already up and says exactly this; a second copy in
        // the form's own error row is noise.
        setError(null);
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <KeyboardAwareScrollView
        style={styles.flex}
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        enableOnAndroid
        extraScrollHeight={spacing.xl}
        showsVerticalScrollIndicator={false}>
      <View style={styles.brandRow}>
        <AppLogo size={52} variant="navy" style={styles.brandMark} />
        <Text style={styles.brandName}>Sachiko Packaging</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Login</Text>
        <Text style={styles.subtitle}>Sign in to your work queue</Text>

        {error ? (
          <View style={styles.errorBanner}>
            <Icon name="alert-circle-outline" size={16} color="#842029" style={styles.errorIcon} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        <View style={styles.field}>
          <Text style={styles.label}>Nick Name</Text>
          <View style={[styles.inputWrap, focusedField === 'nick' && styles.inputWrapFocused]}>
            <Icon name="account-outline" size={20} color={colors.textMuted} style={styles.inputIcon} />
            <TextInput
              style={styles.input}
              value={operatorNick}
              onChangeText={setOperatorNick}
              autoCapitalize="characters"
              autoCorrect={false}
              placeholder="Your name"
              placeholderTextColor={colors.textMuted}
              returnKeyType="next"
              onFocus={() => setFocusedField('nick')}
              onBlur={() => setFocusedField(null)}
              onSubmitEditing={() => passwordRef.current?.focus()}
            />
          </View>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Location</Text>
          <TouchableOpacity
            style={styles.inputWrap}
            activeOpacity={0.7}
            onPress={() => setLocationModalVisible(true)}>
            <Icon name="map-marker-outline" size={20} color={colors.textMuted} style={styles.inputIcon} />
            <Text style={[styles.input, location ? styles.selectValue : styles.selectPlaceholder]}>
              {location || 'Select your unit'}
            </Text>
            <Icon name="chevron-down" size={22} color={colors.textMuted} />
          </TouchableOpacity>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Password</Text>
          <View style={[styles.inputWrap, focusedField === 'password' && styles.inputWrapFocused]}>
            <Icon name="lock-outline" size={20} color={colors.textMuted} style={styles.inputIcon} />
            <TextInput
              ref={passwordRef}
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPassword}
              placeholder="Enter your password"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="go"
              onFocus={() => setFocusedField('password')}
              onBlur={() => setFocusedField(null)}
              onSubmitEditing={handleLogin}
            />
            <TouchableOpacity
              onPress={() => setShowPassword(v => !v)}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}>
              <Icon name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={20} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
        </View>

        <Button title="Sign In" onPress={handleLogin} loading={loading} style={styles.submit} />

        <Text style={styles.helpText}>Trouble signing in? Contact your supervisor.</Text>
      </View>
      </KeyboardAwareScrollView>

      <Modal
        visible={locationModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setLocationModalVisible(false)}>
        <TouchableOpacity
          style={styles.modalBackdrop}
          activeOpacity={1}
          onPress={() => setLocationModalVisible(false)}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Select Location</Text>
            <ScrollView style={styles.modalList} keyboardShouldPersistTaps="handled">
              {locations.length > 0 ? (
                locations.map(loc => (
                  <TouchableOpacity
                    key={loc}
                    style={styles.modalOption}
                    onPress={() => {
                      setLocation(loc);
                      setLocationModalVisible(false);
                    }}>
                    <Text style={styles.modalOptionText}>{loc}</Text>
                  </TouchableOpacity>
                ))
              ) : (
                <Text style={styles.modalEmptyText}>No locations found.</Text>
              )}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  scroll: { flexGrow: 1, padding: spacing.lg, justifyContent: 'center' },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xl,
  },
  brandMark: { marginRight: spacing.sm },
  brandName: { color: colors.primary, fontWeight: '700', fontSize: 19, fontFamily },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: 'rgba(4,74,120,0.14)',
    padding: spacing.xl,
    // Soft lift off the tinted background.
    shadowColor: '#0B1F33',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 3,
  },
  title: { fontSize: 22, fontWeight: '700', color: colors.textDark, fontFamily },
  subtitle: { fontSize: 13.5, color: colors.textMuted, marginTop: 3, marginBottom: spacing.lg, fontFamily },
  field: { marginBottom: spacing.md },
  label: { fontSize: 12.5, fontWeight: '600', color: colors.textDark, marginBottom: 6, fontFamily },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: colors.headerRowBg,
    paddingHorizontal: spacing.md,
  },
  inputWrapFocused: {
    borderColor: colors.primary,
    backgroundColor: '#FFFFFF',
  },
  inputIcon: { marginRight: spacing.sm },
  input: {
    flex: 1,
    paddingVertical: spacing.md,
    fontSize: 15,
    color: colors.textDark,
    fontFamily,
  },
  selectValue: { color: colors.textDark },
  selectPlaceholder: { color: colors.textMuted },
  submit: { marginTop: spacing.md },
  helpText: {
    textAlign: 'center',
    fontSize: 12,
    color: colors.textMuted,
    marginTop: spacing.md,
    fontFamily,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  modalCard: {
    width: '100%',
    maxWidth: 360,
    maxHeight: '70%',
    backgroundColor: '#FFFFFF',
    borderRadius: radii.lg,
    padding: spacing.lg,
  },
  modalTitle: { fontSize: 16, fontWeight: '700', color: colors.textDark, marginBottom: spacing.sm, fontFamily },
  modalList: { flexGrow: 0 },
  modalOption: {
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  modalOptionText: { fontSize: 15, color: colors.textDark, fontFamily },
  modalEmptyText: { fontSize: 13, color: colors.textMuted, textAlign: 'center', paddingVertical: spacing.lg, fontFamily },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,229,229,0.8)',
    borderWidth: 1,
    borderColor: 'rgba(132,32,41,0.2)',
    borderRadius: radii.sm,
    padding: spacing.sm,
    marginBottom: spacing.md,
  },
  errorIcon: { marginRight: spacing.xs },
  errorText: { color: '#842029', fontSize: 13, flex: 1, fontFamily },
});
