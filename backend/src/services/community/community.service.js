const h3 = require('h3-js');
const Incident = require('../../models/Incident');
const IncidentConfirmation = require('../../models/IncidentConfirmation');
const FalseIncidentReport = require('../../models/FalseIncidentReport');
const { toCell } = require('../risk/cellRisk.service');
const communityComponent = require('../risk/communityComponent');
const communityScoring = require('../risk/communityScoring');
const { incidentCategories, severityLabel, scoring: scoringCfg } = require('../../config/communityConfig');
const logger = require('../../utils/logger');
const ApiError = require('../../utils/apiError');

class CommunityService {
  /**
   * Report a new incident.
   */
  async reportIncident(userId, data) {
    try {
      const { incidentType, description, latitude, longitude } = data;

      // 1. Get category config
      const category = incidentCategories[incidentType];
      if (!category) {
        throw new ApiError(400, 'Invalid incident type.');
      }

      // 2. Map coordinates to H3 Cell ID
      const h3CellId = toCell(latitude, longitude);

      // 2b. Duplicate handling (anti-spam). Same user + same type nearby recently: rejected. Another user's
      //     identical report nearby recently: counted as a confirmation of that report instead of a second one.
      const now = new Date();
      const since = new Date(now.getTime() - scoringCfg.duplicate.windowMinutes * 60000);
      const candidates = await Incident.find({
        status: 'ACTIVE',
        incidentType,
        createdAt: { $gte: since },
        h3CellId: { $in: h3.gridDisk(h3CellId, 2) },
      })
        .select('userId incidentType latitude longitude createdAt description')
        .lean();
      const dup = communityScoring.classifyDuplicate({ userId, incidentType, latitude, longitude, description }, candidates, now);
      if (dup.kind === 'own_duplicate') {
        throw new ApiError(409, 'You already reported this nearby a moment ago.');
      }
      if (dup.kind === 'merge') {
        const confirmed = await this.confirmIncident(dup.incident._id, userId);
        const out = typeof confirmed.toObject === 'function' ? confirmed.toObject() : { ...confirmed };
        return { ...out, merged: true };
      }

      // 3. Calculate expiration date
      const expiresAt = new Date(Date.now() + category.expiryHours * 60 * 60 * 1000);

      // 4. Create incident document
      const incident = new Incident({
        userId,
        incidentType,
        description,
        latitude,
        longitude,
        location: {
          type: 'Point',
          coordinates: [longitude, latitude], // GeoJSON standard
        },
        h3CellId,
        severity: severityLabel(category.severity),
        status: 'ACTIVE',
        confirmationCount: 0,
        falseReportCount: 0,
        expiresAt,
      });

      const savedIncident = await incident.save();
      logger.info(`[CommunityService.report] Incident reported: ${savedIncident._id} type: ${incidentType} in H3 cell: ${h3CellId}`);

      // 5. Recompute the community component for this cell and its neighbours before answering, so the app's next risk
      //    read already includes this report. A failure here must not lose the report: the sweep job catches up.
      await communityComponent.recomputeAround([h3CellId]).catch((err) => {
        logger.error(`[CommunityService.report] Community score recalculation failed for cell ${h3CellId}`, err);
      });

      return savedIncident;
    } catch (error) {
      logger.error('[CommunityService.reportIncident] Failed to report incident', error);
      throw error;
    }
  }

  /**
   * Find nearby active incidents sorted by nearest first, newest first.
   */
  async getNearbyIncidents(latitude, longitude, radiusInMeters = 5000) {
    try {
      const lat = Number(latitude);
      const lng = Number(longitude);
      const radius = Number(radiusInMeters);

      // Run $geoNear aggregate stage to get distance and sort by nearest, newest
      const results = await Incident.aggregate([
        {
          $geoNear: {
            near: {
              type: 'Point',
              coordinates: [lng, lat],
            },
            distanceField: 'distanceInMeters',
            spherical: true,
            query: { status: 'ACTIVE' },
            maxDistance: radius,
          },
        },
        {
          $sort: {
            distanceInMeters: 1, // nearest first
            createdAt: -1,       // newest first
          },
        },
      ]);

      logger.info(`[CommunityService.nearby] Found ${results.length} active incidents near coordinates [${lat}, ${lng}].`);
      return results;
    } catch (error) {
      logger.error('[CommunityService.getNearbyIncidents] Geospatial query failed', error);
      throw new ApiError(500, 'Failed to fetch nearby incidents.');
    }
  }

  /**
   * Confirm an incident.
   */
  async confirmIncident(incidentId, userId) {
    try {
      // 1. Check if incident exists and is ACTIVE
      const incident = await Incident.findOne({ _id: incidentId, status: 'ACTIVE' });
      if (!incident) {
        throw new ApiError(404, 'Active incident not found.');
      }

      // 2. Check if user already confirmed it
      const existingConfirmation = await IncidentConfirmation.findOne({ incidentId, userId });
      if (existingConfirmation) {
        throw new ApiError(400, 'You have already confirmed this incident.');
      }

      // 3. A reporter cannot confirm their own report (it would count as an independent confirmation).
      if (String(incident.userId) === String(userId)) {
        throw new ApiError(400, 'You cannot confirm your own report.');
      }

      // 4. Save confirmation
      const confirmation = new IncidentConfirmation({ incidentId, userId });
      await confirmation.save();

      // 5. Atomically increment confirmation count
      incident.confirmationCount += 1;
      const updatedIncident = await incident.save();

      logger.info(`[CommunityService.confirm] Incident ${incidentId} confirmed by user ${userId}`);

      // 6. Recalculate H3 Cell score
      await communityComponent.recomputeAround([incident.h3CellId]).catch((err) => {
        logger.error(`[CommunityService.confirm] Community score recalculation failed for cell ${incident.h3CellId}`, err);
      });

      return updatedIncident;
    } catch (error) {
      logger.error(`[CommunityService.confirmIncident] Confirmation failed for incident ${incidentId}`, error);
      throw error;
    }
  }

  /**
   * Flag an incident as false report.
   */
  async reportFalse(incidentId, userId) {
    try {
      // 1. Check if incident exists and is ACTIVE
      const incident = await Incident.findOne({ _id: incidentId, status: 'ACTIVE' });
      if (!incident) {
        throw new ApiError(404, 'Active incident not found.');
      }

      // 2. Check if user already flagged it as false
      const existingReport = await FalseIncidentReport.findOne({ incidentId, userId });
      if (existingReport) {
        throw new ApiError(400, 'You have already reported this incident as false.');
      }

      // 3. Save false report
      const falseReport = new FalseIncidentReport({ incidentId, userId });
      await falseReport.save();

      // 4. Increment false report count
      incident.falseReportCount += 1;

      // 5. If false reports exceed or meet threshold (>= 5), remove the incident
      if (incident.falseReportCount >= scoringCfg.removeAfterFalseReports) {
        incident.status = 'REMOVED';
        logger.warn(`[CommunityService.reportFalse] Incident ${incidentId} REMOVED due to threshold of ${scoringCfg.removeAfterFalseReports} false reports.`);
      }

      const updatedIncident = await incident.save();
      logger.info(`[CommunityService.reportFalse] Incident ${incidentId} flagged as false by user ${userId}. Count: ${updatedIncident.falseReportCount}`);

      // 6. Recalculate H3 Cell score
      communityComponent.recomputeAround([incident.h3CellId]).catch((err) => {
        logger.error(`[CommunityService.reportFalse] Community score recalculation failed for cell ${incident.h3CellId}`, err);
      });

      return updatedIncident;
    } catch (error) {
      logger.error(`[CommunityService.reportFalse] Failed to flag false incident ${incidentId}`, error);
      throw error;
    }
  }

  /**
   * Retrieve details of a specific incident.
   */
  async getIncidentDetails(incidentId) {
    try {
      const incident = await Incident.findById(incidentId).populate('userId', 'username');
      if (!incident) {
        throw new ApiError(404, 'Incident not found.');
      }
      return incident;
    } catch (error) {
      logger.error(`[CommunityService.getIncidentDetails] Failed to retrieve incident ${incidentId}`, error);
      throw error;
    }
  }

  /**
   * Retrieve all incidents reported by a specific user.
   */
  async getMyReports(userId) {
    try {
      const reports = await Incident.find({ userId })
        .sort({ createdAt: -1 })
        .lean();
      return reports;
    } catch (error) {
      logger.error(`[CommunityService.getMyReports] Failed to retrieve reports for user ${userId}`, error);
      throw new ApiError(500, 'Failed to retrieve your incident reports.');
    }
  }
}

module.exports = new CommunityService();
