import * as Location from 'expo-location';
import { locationBus } from './locationBus';
import { geofenceManager } from './geofenceManager';

/**
 * One foreground GPS watch for the whole app. Each fix is published on the locationBus (nearby services,
 * maps) and offered to the geofence manager (which throttles what it sends to the backend).
 * ensureWatching() is idempotent and never prompts: it starts only if foreground permission is already
 * granted. Screens call it right after they obtain permission.
 */
let subscription = null;
let starting = false;

export async function ensureWatching() {
  if (subscription || starting) return true;
  starting = true;
  try {
    const perm = await Location.getForegroundPermissionsAsync();
    if (perm.status !== 'granted') return false;

    // A fast first position so dependent features can start before the first GPS fix.
    const known = await Location.getLastKnownPositionAsync().catch(() => null);
    if (known) locationBus.publish(known);

    subscription = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, timeInterval: 10000, distanceInterval: 25 },
      (loc) => {
        locationBus.publish(loc);
        geofenceManager.submit(loc);
      }
    );
    return true;
  } catch (error) {
    console.log('[locationWatcher] not started:', error.message);
    return false;
  } finally {
    starting = false;
  }
}

const FRESH_ENOUGH_MS = 2 * 60 * 1000;
const GPS_WAIT_MS = 8000;

/**
 * The best position available without making the user wait: a recent known position straight away, otherwise a new
 * fix for up to 8 s, otherwise whatever was last known. Indoors a new fix can take minutes or never arrive, so a screen
 * must not wait on it. Null when there is no position at all. Never throws.
 */
export async function getBestPosition() {
  const known = await Location.getLastKnownPositionAsync().catch(() => null);
  if (known && Date.now() - known.timestamp < FRESH_ENOUGH_MS) return known;
  try {
    return await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('GPS timeout')), GPS_WAIT_MS)),
    ]);
  } catch (error) {
    return known;
  }
}

export function stopWatching() {
  subscription?.remove();
  subscription = null;
}
