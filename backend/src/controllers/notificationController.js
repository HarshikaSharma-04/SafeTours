const notificationService = require('../services/notificationService');
const DeviceToken = require('../models/DeviceToken');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const asyncHandler = require('../utils/asyncHandler');
const { isExpoPushToken } = require('../services/pushService');

/**
 * GET /api/notifications
 * Returns all notifications for the authenticated user, sorted newest first.
 */
const getNotifications = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const notifications = await notificationService.getUserNotifications(userId);

  return res.status(200).json(
    new ApiResponse(200, notifications, 'Notifications retrieved successfully.')
  );
});

/**
 * POST /api/notifications/token
 * Stores (or refreshes) a Firebase device token for the authenticated user.
 * Uses upsert so re-registering the same token is idempotent.
 */
const registerDeviceToken = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { token, platform } = req.body;

  if (!token || !platform) {
    throw new ApiError(400, 'Both "token" and "platform" fields are required.');
  }

  if (!isExpoPushToken(token)) {
    throw new ApiError(400, 'token must be an Expo push token (ExponentPushToken[...]).');
  }

  if (!['android', 'ios'].includes(platform)) {
    throw new ApiError(400, 'Platform must be either "android" or "ios".');
  }

  // A token belongs to one phone: whoever logged in on it before must stop getting this user's phone's alerts.
  await DeviceToken.updateMany({ token, user: { $ne: userId } }, { $set: { isActive: false } });

  // Upsert: if this user already registered this token, just refresh isActive
  const deviceToken = await DeviceToken.findOneAndUpdate(
    { user: userId, token },
    { user: userId, token, platform, isActive: true },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return res.status(200).json(
    new ApiResponse(200, deviceToken, 'Device token registered successfully.')
  );
});

module.exports = {
  getNotifications,
  registerDeviceToken,
};
