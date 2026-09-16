import React, { useEffect } from 'react';
import { View, StyleSheet, AppState } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import RootNavigator from './src/navigation/RootNavigator';
import ErrorBoundary from './src/components/ErrorBoundary';
import OfflineBanner from './src/components/OfflineBanner';
import { printQueue } from './src/services/printQueue';
import { subscribe as subscribeConnectivity } from './src/services/connectivity';

export default function App() {
  useEffect(() => {
    // Keep the print queue draining without the operator having to open a
    // screen that retries it. A queued label needs both the server (it rebuilds
    // the label's TSPL at print time) and the printer, so the two moments worth
    // retrying are the app coming back to the foreground and the server
    // reconnecting. printQueue.flush() is a cheap no-op when the queue is empty
    // or a drain is already running, and the queue also runs its own widening
    // retry timer once a flush has failed -- these just cut the wait when
    // something obviously changed.
    const appStateSub = AppState.addEventListener('change', state => {
      if (state === 'active') {
        printQueue.flush();
      }
    });
    const unsubscribeConnectivity = subscribeConnectivity(online => {
      if (online) {
        printQueue.flush();
      }
    });
    return () => {
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
        </View>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
