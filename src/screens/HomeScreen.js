import React, { useState, useEffect, useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import { colors, spacing } from '../theme/theme';
import { HeaderIconButton } from '../theme/HeaderBar';
import AppDialog from '../theme/AppDialog';
import SegmentedToggle from '../theme/SegmentedToggle';
import QueueScreen from './QueueScreen';
import LogsScreen from './LogsScreen';
import { logout } from '../services/api';

// The signed-in home. A segmented toggle under the nav bar switches between the
// Work Queue and Logs panels in place (no navigation push), and this screen
// owns the shared nav-bar chrome: title + the maintenance / settings / logout
// actions.
//
// Maintenance sits in the nav bar rather than in the toggle: it's an
// interruption ("something broke"), not one of the two views an operator
// works from, and the toggle is better spent on the work itself.
const SEGMENTS = [
  { key: 'queue', label: 'Work Queue' },
  { key: 'logs', label: 'Logs' },
];

export default function HomeScreen({ navigation, route, onLoggedOut }) {
  const [tab, setTab] = useState('queue');
  // In-app themed dialog in place of RN's Alert.alert -- see theme/AppDialog.js.
  const [dialog, setDialog] = useState(null);

  const handleLogout = useCallback(() => {
    setDialog({
      // App-accent (navy primary) dialog, not the platform Alert.
      tone: 'info',
      title: 'Log out?',
      buttons: [
        { label: 'Cancel', variant: 'ghost', onPress: () => setDialog(null) },
        {
          label: 'Log out',
          variant: 'danger',
          onPress: async () => {
            setDialog(null);
            await logout();
            onLoggedOut();
            navigation.reset({ index: 0, routes: [{ name: 'Login' }] });
          },
        },
      ],
    });
  }, [navigation, onLoggedOut]);

  useEffect(() => {
    navigation.setOptions({
      title: 'Sachiko Packaging',
      headerRight: () => (
        <View style={styles.headerActions}>
          <HeaderIconButton
            icon="hammer-wrench"
            accessibilityLabel="Maintenance"
            onPress={() => navigation.navigate('Maintenance')}
          />
          <HeaderIconButton
            icon="cog-outline"
            accessibilityLabel="Printer settings"
            onPress={() => navigation.navigate('PrinterSettings')}
          />
          <HeaderIconButton icon="logout" accessibilityLabel="Log out" onPress={handleLogout} />
        </View>
      ),
    });
  }, [navigation, handleLogout]);

  return (
    <View style={styles.container}>
      <View style={styles.toggleWrap}>
        <SegmentedToggle options={SEGMENTS} value={tab} onChange={setTab} />
      </View>
      <View style={styles.body}>
        {tab === 'queue' ? (
          <QueueScreen
            navigation={navigation}
            onLoggedOut={onLoggedOut}
            scannedCode={route?.params?.scannedCode}
            onScanHandled={() => navigation.setParams({ scannedCode: undefined })}
          />
        ) : (
          <LogsScreen navigation={navigation} onLoggedOut={onLoggedOut} />
        )}
      </View>

      <AppDialog
        visible={!!dialog}
        tone={dialog?.tone}
        title={dialog?.title}
        message={dialog?.message}
        buttons={dialog?.buttons}
        onRequestClose={() => setDialog(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  toggleWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  body: { flex: 1 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
