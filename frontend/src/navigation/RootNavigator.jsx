import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { AuthNavigator } from './AuthNavigator';
import { MainTabs } from './MainTabs';
import { SplashScreen } from '../screens/auth/SplashScreen';
import { NotificationsScreen } from '../screens/main/NotificationsScreen';
import { EmergencyServicesScreen } from '../screens/main/EmergencyServicesScreen';
import { ProfileScreen } from '../screens/main/ProfileScreen';
import { UserProfileScreen } from '../screens/main/UserProfileScreen';
import { EmergencyContactsScreen } from '../screens/main/EmergencyContactsScreen';
import { ContactFormScreen } from '../screens/main/ContactFormScreen';
import { MedicalIdScreen } from '../screens/main/MedicalIdScreen';
import { JourneyHistoryScreen } from '../screens/main/JourneyHistoryScreen';
import { SOSHistoryScreen } from '../screens/main/SOSHistoryScreen';
import { LiveJourneyScreen } from '../screens/main/LiveJourneyScreen';
import { useAuth } from '../context/AuthContext';
import { SidebarProvider } from '../context/SidebarContext';
import { navigationRef } from './navigationRef';

const Stack = createNativeStackNavigator();

const MainNavigator = () => (
  <Stack.Navigator screenOptions={{ headerShown: false }}>
    <Stack.Screen name="Tabs" component={MainTabs} />
    <Stack.Screen name="Notifications" component={NotificationsScreen} />
    <Stack.Screen name="EmergencyServices" component={EmergencyServicesScreen} />
    <Stack.Screen name="Profile" component={UserProfileScreen} />
    <Stack.Screen name="EditProfile" component={ProfileScreen} />
    <Stack.Screen name="EmergencyContacts" component={EmergencyContactsScreen} />
    <Stack.Screen name="ContactForm" component={ContactFormScreen} />
    <Stack.Screen name="MedicalId" component={MedicalIdScreen} />
    <Stack.Screen name="JourneyHistory" component={JourneyHistoryScreen} />
    <Stack.Screen name="SOSHistory" component={SOSHistoryScreen} />
    <Stack.Screen name="LiveJourney" component={LiveJourneyScreen} />
  </Stack.Navigator>
);

const CompleteProfileNavigator = () => (
  <Stack.Navigator screenOptions={{ headerShown: false }}>
    <Stack.Screen name="CompleteProfile" component={ProfileScreen} />
  </Stack.Navigator>
);

export const RootNavigator = () => {
  const { user, isLoading, isProfileComplete, isAuthenticated } = useAuth();

  if (isLoading) {
    return <SplashScreen isRestoring={true} />;
  }

  return (
    // navigationInChildEnabled: lets a stack screen open a tab directly (LiveJourney's SOS button, the sidebar).
    // React Navigation 7 no longer does this by default, and the press would silently do nothing.
    <NavigationContainer ref={navigationRef} navigationInChildEnabled>
      <SidebarProvider>
        {isAuthenticated || user ? (
          isProfileComplete ? (
            <MainNavigator />
          ) : (
            <CompleteProfileNavigator />
          )
        ) : (
          <AuthNavigator />
        )}
      </SidebarProvider>
    </NavigationContainer>
  );
};

