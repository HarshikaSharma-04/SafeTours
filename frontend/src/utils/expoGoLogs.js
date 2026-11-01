import { LogBox } from 'react-native';

/**
 * Expo Go only: expo-notifications logs an error as soon as it is imported, because Expo Go on Android cannot receive
 * remote push since SDK 53. The app already handles that (services/pushNotifications.js skips registration and the
 * in-app poll still works), so it should not cover the screen. It stays in the Metro log.
 * Must be imported before anything that reaches expo-notifications.
 */
LogBox.ignoreLogs([
  'expo-notifications: Android Push notifications',
  '`expo-notifications` functionality is not fully supported in Expo Go',
]);
