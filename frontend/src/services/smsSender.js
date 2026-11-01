import { Platform, PermissionsAndroid } from 'react-native';
import * as SMS from 'expo-sms';
import { SafeToursSms } from '../../modules/safetours-sms';
import { kvCache } from '../storage/kvCache';
import { normalizePhone, sendToEach } from '../offline/smsLogic';

/**
 * Platform layer for the SOS text message. Decisions live in offline/smsLogic.js; this file only touches the OS.
 *
 * Android: SafeToursSms (our own small native module, modules/safetours-sms) sends directly with SmsManager and
 *          reports the radio's answer per contact. Needs the SEND_SMS permission.
 * iOS / no permission / no native module: the composer (expo-sms) opens prefilled and the user must tap Send.
 *          iOS reports 'sent' or 'cancelled'; Android reports only 'unknown'.
 */
const ASKED_KEY = 'settings:smsPermissionAsked';

const SEND_SMS = 'android.permission.SEND_SMS';

/** False in Expo Go, where our native module is not in the app: a development build is needed for direct texts. */
export const directSmsSupported = Platform.OS === 'android' && Boolean(SafeToursSms);

/**
 * 'granted' | 'denied' | 'blocked' (Android will not show the dialog again: only its Settings can change it)
 * | 'undetermined' (never asked) | 'unavailable' (iOS: there is no such permission)
 * The OS is the authority on 'granted' (the user can revoke it in Settings); the stored answer says whether we asked.
 */
export async function smsPermissionStatus() {
  if (Platform.OS !== 'android') return 'unavailable';
  try {
    if (await PermissionsAndroid.check(SEND_SMS)) return 'granted';
    const asked = await kvCache.get(ASKED_KEY, { allowExpired: true });
    if (!asked || !asked.value) return 'undetermined';
    return asked.value === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN ? 'blocked' : 'denied';
  } catch (e) {
    return 'undetermined';
  }
}

/** Shows the Android permission dialog (explain WHY before calling this). Returns the new status. */
export async function requestSmsPermission() {
  if (Platform.OS !== 'android') return 'unavailable';
  try {
    const result = await PermissionsAndroid.request(SEND_SMS, {
      title: 'Allow SafeTours to send SOS texts',
      message:
        'In an emergency, even without internet, SafeTours can text your emergency contacts your location straight from this phone. ' +
        'Standard SMS charges from your plan may apply. It only sends when you trigger an SOS, or when you press "Test SMS to myself".',
      buttonPositive: 'Allow',
      buttonNegative: 'Not now',
    });
    await kvCache.set(ASKED_KEY, result);
    if (result === PermissionsAndroid.RESULTS.GRANTED) return 'granted';
    return result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN ? 'blocked' : 'denied';
  } catch (e) {
    return 'denied';
  }
}

/** What this phone can do right now (input of smsLogic.planSms). */
export async function smsEnvironment() {
  let directAvailable = false;
  if (Platform.OS === 'android' && SafeToursSms) {
    try {
      directAvailable = await SafeToursSms.isAvailableAsync();
    } catch (e) {
      directAvailable = false;
    }
  }
  let composerAvailable = false;
  try {
    composerAvailable = await SMS.isAvailableAsync();
  } catch (e) {
    composerAvailable = false;
  }
  return { platform: Platform.OS, permission: await smsPermissionStatus(), directAvailable, composerAvailable };
}

/**
 * Sends `message` to every phone directly, one after another (smsLogic.sendToEach). Resolves to
 * [{phone, ok, error}]; ok is true only when the radio confirmed every part of the message. `phone` stays as stored
 * on the contact, only the number handed to the radio is cleaned.
 */
export function sendDirect(phones, message, onResult) {
  return sendToEach(
    phones,
    async (phone) => {
      const to = normalizePhone(phone);
      if (!to) return { phone, ok: false, error: 'invalid_number' };
      const res = await SafeToursSms.sendTextAsync(to, message);
      return { phone, ok: Boolean(res && res.ok), error: res && res.error ? res.error : undefined };
    },
    onResult
  );
}

/** Opens the composer prefilled; resolves to 'sent' | 'cancelled' | 'unknown' (expo-sms). */
export async function openComposer(phones, message) {
  const { result } = await SMS.sendSMSAsync(phones, message);
  return result;
}
