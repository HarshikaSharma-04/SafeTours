import * as Location from 'expo-location';
import { apiClient, formatApiError } from './apiClient';

const coordsLabel = (latitude, longitude) => `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;

/** The phone's own geocoder: the fallback when the server cannot search (offline, no key, provider down). */
async function searchOnDevice(text) {
  const results = await Location.geocodeAsync(text);
  const places = await Promise.all(
    (results || []).slice(0, 5).map(async ({ latitude, longitude }) => {
      try {
        const [place] = await Location.reverseGeocodeAsync({ latitude, longitude });
        const parts = place ? [place.street, place.district, place.city, place.region, place.country].filter(Boolean) : [];
        return {
          name: (place && (place.name || place.district || place.city)) || text,
          address: parts.join(', ') || coordsLabel(latitude, longitude),
          latitude,
          longitude,
        };
      } catch (e) {
        return { name: text, address: coordsLabel(latitude, longitude), latitude, longitude };
      }
    })
  );
  const seen = new Set();
  return places.filter((p) => {
    const key = `${p.latitude.toFixed(4)}_${p.longitude.toFixed(4)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const placesService = {
  /**
   * Place suggestions: the server first (ranked near `around`), then the phone's geocoder.
   * @returns {Promise<{success:boolean, data:Array<{name,address,latitude,longitude}>, error?:Object}>}
   */
  async search(text, around) {
    const q = String(text || '').trim();
    if (q.length < 2) return { success: true, data: [] };
    try {
      const params = { q, ...(around ? { lat: around.latitude, lng: around.longitude } : {}) };
      const res = await apiClient.get('/places/search', { params, timeout: 10000 });
      if (res.data?.data?.length) return { success: true, data: res.data.data };
    } catch (error) {
      // falls through to the phone's geocoder
    }
    try {
      return { success: true, data: await searchOnDevice(q) };
    } catch (error) {
      return { success: false, data: [], error: { message: 'Place search is not available right now.' } };
    }
  },

  /**
   * A route with the risk of the cells it crosses. `source` is 'straight-line' when no routing provider answered, so
   * the screen can say that it is not a road route.
   */
  async getRoute(from, to, mode = 'foot') {
    try {
      const res = await apiClient.get('/places/route', {
        params: { fromLat: from.latitude, fromLng: from.longitude, toLat: to.latitude, toLng: to.longitude, mode },
        timeout: 15000,
      });
      return { success: true, data: res.data?.data || null };
    } catch (error) {
      return { success: false, data: null, error: formatApiError(error) };
    }
  },
};
