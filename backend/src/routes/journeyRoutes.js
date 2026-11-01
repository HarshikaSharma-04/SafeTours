const express = require('express');
const router = express.Router();

// Import existing auth middleware
const { verifyJWT } = require('../middleware/authMiddleware');
const { idempotent } = require('../middleware/idempotency');

// Import controller methods
const {
  startJourney,
  updateJourney,
  endJourney,
  getJourneyStatus,
  getJourneyHistory
} = require('../controllers/journeyController');

// Import validators
const {
  validateStartJourney,
  validateUpdateJourney,
  validateUpdateJourneyStatus,
  validateJourneyRequest
} = require('../middleware/journeyValidator');

/**
 * POST /api/journey/start
 * Starts a new journey. Validates coordinates and ETA.
 */
router.post(
  '/start',
  verifyJWT,
  idempotent('journey.start'),
  validateStartJourney,
  validateJourneyRequest,
  startJourney
);

/**
 * POST /api/journey/update/:id
 * Updates an ongoing journey. 
 * Note: Added /:id to the route path to maintain RESTful resource targeting 
 * and to match the controller's expectation of `req.params.id`.
 */
router.post(
  '/update/:id',
  verifyJWT,
  idempotent('journey.update'),
  validateUpdateJourney,
  validateJourneyRequest,
  updateJourney
);

/**
 * POST /api/journey/end/:id
 * Completes or cancels an active journey.
 * Validates that the payload contains a valid final status.
 */
router.post(
  '/end/:id',
  verifyJWT,
  idempotent('journey.end'),
  validateUpdateJourneyStatus,
  validateJourneyRequest,
  endJourney
);

/**
 * GET /api/journey/status
 * Retrieves the user's currently active journey (if any).
 */
router.get(
  '/status',
  verifyJWT,
  getJourneyStatus
);

/**
 * GET /api/journey/history
 * Retrieves the user's journeys, newest first.
 */
router.get(
  '/history',
  verifyJWT,
  getJourneyHistory
);

module.exports = router;
