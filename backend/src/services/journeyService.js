const Journey = require('../models/Journey');
const Location = require('../models/Location');
const sosService = require('./sosService');
const notificationService = require('./notificationService');
const cfg = require('../config/geofence.config');
const { haversineMeters } = require('../config/region.config');
const logger = require('../utils/logger');

/**
 * Journey service (the backend behind "Shadow Mode").
 *
 * Server-side ETA enforcement: when expectedArrivalTime passes without arrival, processEtaDue()
 * (run every few seconds by scheduler/safetyScheduler.js) creates an "Are you okay?" safety check with
 * a persisted deadline; with no answer the SOS service escalates it. Answering "I'm okay" extends the
 * ETA. Arrival is detected within journey arrival radius (100 m) of the destination.
 */
class JourneyService {
  /** Starts a journey. One active journey per user. */
  async startJourney(userId, data) {
    try {
      const existingActiveJourney = await Journey.findOne({ userId, status: 'ACTIVE' }).exec();
      if (existingActiveJourney) {
        throw new Error('User already has an active journey. Please complete or cancel it first.');
      }

      const { startLocation, destination, expectedArrivalTime, destinationName } = data;
      const newJourney = new Journey({
        userId,
        startLocation: { type: 'Point', coordinates: startLocation },
        destination: { type: 'Point', coordinates: destination },
        lastKnownLocation: { type: 'Point', coordinates: startLocation },
        expectedArrivalTime,
        status: 'ACTIVE',
        ...(destinationName ? { metadata: { destinationName } } : {}),
      });
      return await newJourney.save();
    } catch (error) {
      logger.error(`[JourneyService.startJourney] user ${userId}: ${error.message}`);
      throw new Error(error.message || 'Failed to start journey in the database.');
    }
  }

  /**
   * Updates an ongoing journey: ETA extension, metadata, and/or the current location (which also
   * runs arrival detection). Extending the ETA into the future cancels a pending "Are you okay?" check.
   */
  async updateJourney(journeyId, userId, updateData) {
    try {
      const journey = await Journey.findOne({ _id: journeyId, userId, status: 'ACTIVE' }).exec();
      if (!journey) throw new Error('Active journey not found or you do not have permission to update it.');

      let etaExtended = false;
      if (updateData.expectedArrivalTime) {
        const eta = new Date(updateData.expectedArrivalTime);
        if (Number.isNaN(eta.getTime())) throw new Error('expectedArrivalTime is not a valid date.');
        journey.expectedArrivalTime = eta;
        etaExtended = eta.getTime() > Date.now();
      }
      if (updateData.metadata) journey.metadata = { ...journey.metadata, ...updateData.metadata };
      const saved = await journey.save();

      if (etaExtended) await sosService.cancelPendingForJourney(saved._id, 'eta-extended');

      const loc = updateData.currentLocation;
      if (loc && Number.isFinite(Number(loc.latitude)) && Number.isFinite(Number(loc.longitude))) {
        const arrival = await this.checkArrival(userId, {
          latitude: Number(loc.latitude),
          longitude: Number(loc.longitude),
          accuracy: loc.accuracy,
        });
        if (arrival.arrived) return arrival.journey;
        return (await Journey.findById(saved._id)) || saved;
      }
      return saved;
    } catch (error) {
      logger.error(`[JourneyService.updateJourney] journey ${journeyId}: ${error.message}`);
      throw new Error(error.message || 'Failed to update journey.');
    }
  }

  /** Ends a journey (COMPLETED | CANCELLED) and cancels any pending check of it. */
  async endJourney(journeyId, userId, finalStatus) {
    try {
      if (!['COMPLETED', 'CANCELLED'].includes(finalStatus)) {
        throw new Error('Invalid final status. Must be COMPLETED or CANCELLED.');
      }
      const journey = await Journey.findOne({ _id: journeyId, userId, status: 'ACTIVE' }).exec();
      if (!journey) throw new Error('Active journey not found to end.');

      journey.status = finalStatus;
      journey.endTime = new Date();
      const saved = await journey.save();
      await sosService.cancelPendingForJourney(saved._id, 'journey-ended');
      return saved;
    } catch (error) {
      logger.error(`[JourneyService.endJourney] journey ${journeyId}: ${error.message}`);
      throw new Error(error.message || 'Failed to end journey.');
    }
  }

  async getJourneyStatus(userId) {
    try {
      return await Journey.findOne({ userId, status: 'ACTIVE' }).exec();
    } catch (error) {
      logger.error(`[JourneyService.getJourneyStatus] user ${userId}: ${error.message}`);
      throw new Error('Failed to retrieve journey status.');
    }
  }

  /** The user's journeys, newest first, active and finished alike. */
  async getJourneyHistory(userId, limit = 50) {
    try {
      return await Journey.find({ userId }).sort({ startTime: -1 }).limit(limit).lean();
    } catch (error) {
      logger.error(`[JourneyService.getJourneyHistory] user ${userId}: ${error.message}`);
      throw new Error('Failed to retrieve journey history.');
    }
  }

  /**
   * Called for every stored location and every journey update. Remembers the last known location of the
   * active journey and completes it when the user is within the arrival radius of the destination
   * (readings less accurate than accuracyMaxMeters, and readings with UNKNOWN accuracy, are not trusted for
   * arrival: the position is still remembered as the last known one).
   * @returns {{arrived:boolean, journey?:Object}}
   */
  async checkArrival(userId, { latitude, longitude, accuracy }) {
    const journey = await Journey.findOne({ userId, status: 'ACTIVE' });
    if (!journey) return { arrived: false };

    journey.lastKnownLocation = { type: 'Point', coordinates: [longitude, latitude] };

    const [destLng, destLat] = journey.destination.coordinates;
    const distance = haversineMeters(latitude, longitude, destLat, destLng);
    // Unknown accuracy (null / undefined) is NOT accurate enough: arrival needs a position we can trust.
    const accurateEnough = accuracy !== undefined && accuracy !== null && Number.isFinite(Number(accuracy)) && Number(accuracy) <= cfg.accuracyMaxMeters;

    if (accurateEnough && distance <= cfg.eta.arrivalRadiusMeters) {
      const done = await Journey.findOneAndUpdate(
        { _id: journey._id, status: 'ACTIVE' },
        { $set: { status: 'COMPLETED', endTime: new Date(), 'metadata.arrived': true, lastKnownLocation: journey.lastKnownLocation } },
        { returnDocument: 'after' }
      );
      if (done) {
        await sosService.cancelPendingForJourney(done._id, 'arrived');
        notificationService
          .notify({ userId, type: 'JOURNEY', title: 'You have arrived', message: 'Your journey was completed automatically.', metadata: { journeyId: String(done._id) }, channelId: 'default' })
          .catch(() => {});
        return { arrived: true, journey: done };
      }
      return { arrived: false };
    }

    await journey.save();
    return { arrived: false, distanceMeters: Math.round(distance) };
  }

  /**
   * Creates "Are you okay?" checks for journeys whose ETA has passed. Each ETA value is prompted once
   * (etaPromptedFor); extending the ETA re-arms it. Runs after a restart too: an overdue journey is
   * picked up on the first poll.
   */
  async processEtaDue(now = new Date(), limit = 25) {
    const due = await Journey.find({
      status: 'ACTIVE',
      expectedArrivalTime: { $lte: now },
      $expr: { $lt: [{ $ifNull: ['$etaPromptedFor', new Date(0)] }, '$expectedArrivalTime'] },
    })
      .limit(limit)
      .lean();

    let created = 0;
    for (const j of due) {
      try {
        // Claim this ETA first so concurrent pollers / instances cannot prompt twice.
        const claimed = await Journey.findOneAndUpdate(
          { _id: j._id, status: 'ACTIVE', expectedArrivalTime: j.expectedArrivalTime, $or: [{ etaPromptedFor: null }, { etaPromptedFor: { $lt: j.expectedArrivalTime } }] },
          { $set: { etaPromptedFor: j.expectedArrivalTime } },
          { returnDocument: 'after' }
        );
        if (!claimed) continue;

        const last = j.lastKnownLocation?.coordinates || (await this.latestLocation(j.userId)) || j.startLocation.coordinates;
        const approximate = !j.lastKnownLocation?.coordinates;
        const check = await sosService.createSafetyCheck(
          j.userId,
          {
            trigger: 'SHADOW_MODE',
            journeyId: j._id,
            coords: { latitude: last[1], longitude: last[0], accuracy: null, timestamp: now, approximate },
            reason: 'Journey ETA passed without arrival',
            idempotencyKey: `eta:${j._id}:${new Date(j.expectedArrivalTime).getTime()}`,
          },
          now
        );
        if (check) created += 1;
      } catch (error) {
        logger.error(`[JourneyService.processEtaDue] journey ${j._id}`, error);
      }
    }
    return { due: due.length, created };
  }

  async latestLocation(userId) {
    const loc = await Location.findOne({ userId }).sort({ timestamp: -1 }).select('location').lean();
    return loc?.location?.coordinates || null;
  }
}

module.exports = new JourneyService();
