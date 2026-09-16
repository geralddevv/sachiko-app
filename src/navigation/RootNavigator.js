import React, { useEffect, useState, useCallback } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { getSession } from '../storage/authStorage';
import { colors } from '../theme/theme';
import LoginScreen from '../screens/LoginScreen';
import HomeScreen from '../screens/HomeScreen';
import MaintenanceScreen from '../screens/MaintenanceScreen';
import JobCardScreen from '../screens/JobCardScreen';
import SlittingJobCardScreen from '../screens/SlittingJobCardScreen';
import ScanScreen from '../screens/ScanScreen';
import PrinterSettingsScreen from '../screens/PrinterSettingsScreen';
import ReportProblemScreen from '../screens/ReportProblemScreen';
import MaintenancePhotoScreen from '../screens/MaintenancePhotoScreen';

const Stack = createNativeStackNavigator();

const screenOptions = {
  headerStyle: { backgroundColor: colors.primary },
  headerTintColor: '#FFFFFF',
  headerTitleStyle: { fontWeight: '600' },
};

export default function RootNavigator() {
  const [checking, setChecking] = useState(true);
  const [loggedIn, setLoggedIn] = useState(false);

  const checkSession = useCallback(async () => {
    const session = await getSession();
    setLoggedIn(!!session?.token);
    setChecking(false);
  }, []);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  if (checking) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={screenOptions}>
        {loggedIn ? (
          <>
            <Stack.Screen name="Home" options={{ title: 'Sachiko Packaging' }}>
              {props => <HomeScreen {...props} onLoggedOut={() => setLoggedIn(false)} />}
            </Stack.Screen>
            <Stack.Screen name="JobCard" component={JobCardScreen} options={{ title: 'Production Entry' }} />
            {/* The step after lamination -- reached from the same Work Queue,
                from its own Slitting section. */}
            <Stack.Screen
              name="SlittingJobCard"
              component={SlittingJobCardScreen}
              options={{ title: 'Slitting Job Card' }}
            />
            {/* Reached from the nav bar's wrench, not from the home toggle --
                see HomeScreen for why it sits there rather than beside the
                work queue. */}
            <Stack.Screen name="Maintenance" options={{ title: 'Maintenance' }}>
              {props => <MaintenanceScreen {...props} onLoggedOut={() => setLoggedIn(false)} />}
            </Stack.Screen>
            <Stack.Screen
              name="Scan"
              component={ScanScreen}
              options={{ presentation: 'modal', title: 'Scan Roll ID' }}
            />
            <Stack.Screen
              name="PrinterSettings"
              component={PrinterSettingsScreen}
              options={{ title: 'Printer Settings' }}
            />
            <Stack.Screen
              name="ReportProblem"
              component={ReportProblemScreen}
              options={{ title: 'Report a Problem' }}
            />
            <Stack.Screen
              name="MaintenancePhoto"
              component={MaintenancePhotoScreen}
              options={{ presentation: 'modal', title: 'Photograph the Problem' }}
            />
          </>
        ) : (
          <Stack.Screen name="Login" options={{ headerShown: false }}>
            {props => <LoginScreen {...props} onLoggedIn={() => setLoggedIn(true)} />}
          </Stack.Screen>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
  },
});
