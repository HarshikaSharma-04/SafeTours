import { apiClient, formatApiError } from './apiClient';
import { sendOrQueue } from './outbox';

/**
 * Service for interacting with backend Journey endpoints.
 */
export const journeyService = {
  /**
   * Starts a new active journey.
   * @param {Object} data - { startLocation: [lng, lat], destination: [lng, lat], expectedArrivalTime, destinationName? }
   */
  async start(data) {
    try {
      const response = await apiClient.post('/journey/start', data);
      return {
        success: true,
        journey: response.data?.journey || null,
        message: response.data?.message || 'Journey started successfully.',
      };
    } catch (error) {
      return {
        success: false,
        journey: null,
        error: formatApiError(error),
      };
    }
  },

  /**
   * Updates an ongoing journey (ETA, location metadata).
   * @param {string} journeyId
   * @param {Object} updateData - { expectedArrivalTime, metadata }
   */
  async update(journeyId, updateData) {
    // Sent now, or kept in the outbox (same idempotency key) and sent when the connection returns.
    const res = await sendOrQueue({
      type: 'journey_update',
      payload: { journeyId, update: updateData },
      send: (key) => apiClient.post(`/journey/update/${journeyId}`, updateData, { headers: { 'Idempotency-Key': key } }),
    });
    if (res.success) {
      return {
        success: true,
        journey: res.response.data?.journey || null,
        message: res.response.data?.message || 'Journey updated successfully.',
      };
    }
    if (res.queued) {
      return { success: false, queued: true, journey: null, message: 'Saved offline: the update will be sent when you are back online.', error: { message: 'Saved offline: the update will be sent when you are back online.', status: 0 } };
    }
    return { success: false, journey: null, error: res.error };
  },

  /**
   * Terminates an active journey (COMPLETED or CANCELLED).
   * @param {string} journeyId
   * @param {string} status - 'COMPLETED' | 'CANCELLED'
   */
  async end(journeyId, status = 'COMPLETED') {
    try {
      const response = await apiClient.post(`/journey/end/${journeyId}`, { status });
      return {
        success: true,
        journey: response.data?.journey || null,
        message: response.data?.message || `Journey marked as ${status}.`,
      };
    } catch (error) {
      return {
        success: false,
        journey: null,
        error: formatApiError(error),
      };
    }
  },

  /**
   * Retrieves the currently active journey for the user (if any).
   */
  async getActive() {
    try {
      const response = await apiClient.get('/journey/status');
      return {
        success: true,
        journey: response.data?.journey || null,
        message: response.data?.message || '',
      };
    } catch (error) {
      return {
        success: false,
        journey: null,
        error: formatApiError(error),
      };
    }
  },

  /**
   * The user's journeys, newest first, active and finished alike.
   */
  async list() {
    try {
      const response = await apiClient.get('/journey/history');
      return { success: true, journeys: response.data?.journeys || [] };
    } catch (error) {
      return { success: false, journeys: [], error: formatApiError(error) };
    }
  },
};
