import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { notificationService } from './notifications';

/**
 * Expo push notifications (expo-notifications SDK 54). The backend sends through Expo's push service using the
 * Expo push token registered here; on Android, Expo delivers through Firebase Cloud Messaging.
 *
 * Honest limits:
 *  - Expo Go on Android cannot receive remote push since SDK 53: use a development build. (Local
 *    notifications and the in-app polling of /api/sos/pending still work, so the "Are you safe?" prompt
 *    still appears while the app is open.)
 *  - getExpoPushTokenAsync needs an EAS projectId (`eas init` writes extra.eas.projectId into app.json).
 *  - Android also needs a Firebase project: google-services.json in the build (android.googleServicesFile in
 *    app.json) for the token, and its FCM V1 key uploaded with `eas credentials` for delivery.
 *  - Android 13+ needs the POST_NOTIFICATIONS permission prompt (requested below).
 */

// Foreground behaviour: show banner + list entry and play the sound.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export async function setupNotificationChannels() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('default', {
    name: 'General',
    importance: Notifications.AndroidImportance.DEFAULT,
  });
  // The channel the backend uses unless it names another (backend notificationService.notify).
  await Notifications.setNotificationChannelAsync('safety', {
    name: 'Safety updates',
    importance: Notifications.AndroidImportance.HIGH,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
  await Notifications.setNotificationChannelAsync('safety-check', {
    name: 'Safety checks ("Are you safe?")',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 500, 300, 500, 300, 500],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    bypassDnd: false,
  });
  await Notifications.setNotificationChannelAsync('geofence', {
    name: 'High-risk area alerts (offline)',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 300, 200, 300],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
  await Notifications.setNotificationChannelAsync('sos', {
    name: 'SOS alerts',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 400, 200, 400],
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
}

/**
 * Asks for permission, gets the Expo push token and registers it with the backend.
 * @returns {Promise<{ok:boolean, token?:string, reason?:string}>}
 */
export async function registerForPush() {
  try {
    await setupNotificationChannels(); // must run before the permission prompt on Android 13+

    if (!Device.isDevice) return { ok: false, reason: 'push needs a physical device' };
    if (Platform.OS === 'android' && Constants.executionEnvironment === ExecutionEnvironment.StoreClient) {
      return { ok: false, reason: 'Expo Go on Android cannot receive remote push (use a development build)' };
    }

    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') ({ status } = await Notifications.requestPermissionsAsync());
    if (status !== 'granted') return { ok: false, reason: 'notification permission denied' };

    const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    if (!projectId) return { ok: false, reason: 'no EAS projectId (run `eas init`)' };

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    await notificationService.registerDeviceToken({ token });
    return { ok: true, token };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

/**
 * @param {{onNotification?:(data:Object)=>void}} handlers  called with the notification's data payload
 * @returns {() => void} unsubscribe
 */
export function addNotificationListeners({ onNotification } = {}) {
  const received = Notifications.addNotificationReceivedListener((n) => onNotification?.(n.request.content.data || {}));
  const tapped = Notifications.addNotificationResponseReceivedListener((r) =>
    onNotification?.(r.notification.request.content.data || {})
  );
  return () => {
    received.remove();
    tapped.remove();
  };
}
