import { Alert, Share } from 'react-native';
import { getBestPosition } from './locationWatcher';
import { locationBus } from './locationBus';

/**
 * Opens the phone's share sheet with a map link to the given (or current) position. Nothing is sent by the app:
 * the user picks who receives it, so this also works with no connection to SafeTours.
 */
export async function shareLocation(position, { prefix = 'My current location' } = {}) {
  let latitude = position?.latitude;
  let longitude = position?.longitude;

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    const last = locationBus.getLast();
    const best = last ? null : await getBestPosition();
    latitude = last?.latitude ?? best?.coords?.latitude;
    longitude = last?.longitude ?? best?.coords?.longitude;
  }

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    Alert.alert('Location not available', 'Turn on location and try again.');
    return false;
  }

  const link = `https://maps.google.com/?q=${latitude.toFixed(6)},${longitude.toFixed(6)}`;
  try {
    await Share.share({ message: `${prefix}: ${link}` });
    return true;
  } catch (error) {
    Alert.alert('Could not share', error.message || 'The share sheet could not be opened.');
    return false;
  }
}
