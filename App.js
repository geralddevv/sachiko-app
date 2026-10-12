import React, { useEffect } from 'react';
import { View, StyleSheet, AppState } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import RootNavigator from './src/navigation/RootNavigator';
import ErrorBoundary from './src/components/ErrorBoundary';
import OfflineBanner from './src/components/OfflineBanner';
import OverrunAlarmModal from './src/components/OverrunAlarmModal';
import { startOvertimeReminder } from './src/services/overtimeReminder';
import { printQueue } from './src/services/printQueue';
import { outbox } from './src/services/outbox';
import { startLiveSync } from './src/services/liveSync';
import { subscribe as subscribeConnectivity } from './src/services/connectivity';

export default function App() {
  useEffect(() => {
    // The job card's live punches waiting in the outbox (services/outbox.js),
    // and what a deckle's Stop brings back once sent (services/liveSync.js).
    // Started here, not by a screen, so punches left from a previous run go
    // out on their own as soon as the app is open.
    const stopLiveSync = startLiveSync();
    // The overtime reminder: runs the Deckle timers kept on this tablet and asks,
    // once, why a Deckle ran late (services/overtimeReminder.js). Needs no connection.
    const stopOvertimeReminder = startOvertimeReminder();
    // Keep both queues draining without the operator having to open a screen
    // that retries them. A queued label needs both the server (it rebuilds
    // the label's TSPL at print time) and the printer, and a queued punch
    // needs the server, so the two moments worth retrying are the app coming
    // back to the foreground and the server reconnecting. flush() is a cheap
    // no-op on an empty queue or with a drain already running, and each queue
    // also runs its own widening retry timer once a flush has failed -- these
    // just cut the wait when something obviously changed.
    const appStateSub = AppState.addEventListener('change', state => {
      if (state === 'active') {
        outbox.flush();
        printQueue.flush();
      }
    });
    const unsubscribeConnectivity = subscribeConnectivity(online => {
      if (online) {
        outbox.flush();
        printQueue.flush();
      }
    });
    return () => {
      stopLiveSync();
      stopOvertimeReminder();
      appStateSub.remove();
      unsubscribeConnectivity();
    };
  }, []);

  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        {/* The banner is a sibling of the navigator, not a screen of it, so it
            stays on top of whatever is being shown -- including modals. */}
        <View style={styles.root}>
          <RootNavigator />
          <OfflineBanner />
          <OverrunAlarmModal />
        </View>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
