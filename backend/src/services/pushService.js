const axios = require('axios');
const DeviceToken = require('../models/DeviceToken');
const logger = require('../utils/logger');

/**
 * Expo push delivery. Uses the Expo push HTTP API directly (no Firebase code here, but on Android Expo delivers
 * through FCM, so the FCM V1 key must be uploaded with `eas credentials`).
 *  - only well-formed Expo push tokens are used (a placeholder token is ignored)
 *  - tokens Expo reports as DeviceNotRegistered are deactivated
 *  - never throws: push is best-effort, the in-app poll (GET /api/sos/pending) is the fallback
 * Optional env EXPO_ACCESS_TOKEN enables Expo "enhanced push security".
 */
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const TOKEN_RX = /^Expo(nent)?PushToken\[[^\]]+\]$/;

const isExpoPushToken = (t) => typeof t === 'string' && TOKEN_RX.test(t);

/**
 * @param {string|ObjectId} userId
 * @param {{title:string, body:string, data?:Object, channelId?:string, ttl?:number}} message
 * @returns {Promise<{sent:number, failed:number, reason?:string}>}
 */
async function sendToUser(userId, { title, body, data = {}, channelId = 'safety', ttl = 120 }) {
  try {
    const rows = await DeviceToken.find({ user: userId, isActive: true }).lean();
    const tokens = rows.map((r) => r.token).filter(isExpoPushToken);
    if (tokens.length === 0) return { sent: 0, failed: 0, reason: 'no-device-token' };

    const messages = tokens.map((to) => ({
      to,
      title,
      body,
      data,
      sound: 'default',
      priority: 'high',
      channelId,
      ttl,
    }));

    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (process.env.EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;

    const response = await axios.post(EXPO_PUSH_URL, messages, { headers, timeout: 10000 });
    const tickets = Array.isArray(response.data?.data) ? response.data.data : [];

    let sent = 0;
    let failed = 0;
    for (let i = 0; i < tickets.length; i += 1) {
      if (tickets[i].status === 'ok') {
        sent += 1;
      } else {
        failed += 1;
        logger.warn(`[push] Expo refused a message for user ${userId}: ${tickets[i].details?.error || tickets[i].message}`);
        if (tickets[i].details?.error === 'DeviceNotRegistered') {
          await DeviceToken.updateOne({ user: userId, token: tokens[i] }, { $set: { isActive: false } });
        }
      }
    }
    return { sent, failed };
  } catch (error) {
    logger.warn(`[push] delivery to user ${userId} failed: ${error.message}`);
    return { sent: 0, failed: 1, reason: error.message };
  }
}

module.exports = { sendToUser, isExpoPushToken };
