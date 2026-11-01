import { Alert, Linking, Platform } from 'react-native';
import { requestSmsPermission, smsPermissionStatus } from '../services/smsSender';

/**
 * Explains WHY the app wants the SEND_SMS permission, then shows the Android dialog.
 * Used from "first SOS setup" (after the first emergency contact is saved) and from Settings.
 * When Android will no longer show the dialog ('blocked'), it offers the app's Android settings page instead.
 * Resolves to 'granted' | 'denied' | 'blocked' | 'undetermined' | 'unavailable' (iOS has no such permission) | 'skipped'.
 */
export async function explainAndRequestSmsPermission() {
  if (Platform.OS !== 'android') return 'unavailable';
  if ((await smsPermissionStatus()) === 'blocked') {
    return new Promise((resolve) => {
      Alert.alert(
        'SMS permission is blocked',
        'Android will not ask again. To let SafeTours text your emergency contacts, open Settings, then Permissions, then SMS, and choose Allow.',
        [
          { text: 'Not now', style: 'cancel', onPress: () => resolve('blocked') },
          { text: 'Open Settings', onPress: () => { Linking.openSettings().catch(() => {}); resolve('blocked'); } },
        ],
        { cancelable: false }
      );
    });
  }
  return new Promise((resolve) => {
    Alert.alert(
      'Text your contacts when you press SOS?',
      'When you press SOS, SafeTours can text your emergency contacts your location straight from this phone, even with no internet.\n\n' +
        'It sends texts only when you trigger an SOS (or press "Test SMS to myself" in Settings). Your plan\'s normal SMS charges apply. ' +
        'If you say no, SafeTours opens your messaging app with the text ready and you tap Send yourself.',
      [
        { text: 'Not now', style: 'cancel', onPress: async () => resolve((await smsPermissionStatus()) === 'granted' ? 'granted' : 'skipped') },
        { text: 'Continue', onPress: async () => resolve(await requestSmsPermission()) },
      ],
      { cancelable: false }
    );
  });
}

/** Asks once, only when the permission has never been asked about (used right after the first contact is saved). */
export async function offerSmsPermissionOnce() {
  if ((await smsPermissionStatus()) !== 'undetermined') return null;
  return explainAndRequestSmsPermission();
}
