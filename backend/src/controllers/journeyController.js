const journeyService = require('../services/journeyService');

/**
 * POST /api/journey/start
 * Initializes a new journey.
 */
const startJourney = async (req, res) => {
  try {
    const userId = req.user._id; // Assumes verifyJWT middleware sets req.user
    const journeyData = req.body;
    
    const newJourney = await journeyService.startJourney(userId, journeyData);
    
    return res.status(201).json({
      success: true,
      message: 'Journey started successfully.',
      journey: newJourney
    });
  } catch (error) {
    // Determine if it's a client logic error (e.g., already active) vs server error
    const isClientError = error.message.includes('already has an active journey');
    return res.status(isClientError ? 400 : 500).json({
      success: false,
      message: 'Failed to start journey.',
      error: error.message
    });
  }
};

/**
 * PUT /api/journey/:id
 * Updates an ongoing journey (ETA, metadata, etc.)
 */
const updateJourney = async (req, res) => {
  try {
    const userId = req.user._id;
    const journeyId = req.params.id;
    const updateData = req.body;
    
    const updatedJourney = await journeyService.updateJourney(journeyId, userId, updateData);
    
    return res.status(200).json({
      success: true,
      message: 'Journey updated successfully.',
      journey: updatedJourney
    });
  } catch (error) {
    const isClientError = error.message.includes('not found') || error.message.includes('permission');
    return res.status(isClientError ? 404 : 500).json({
      success: false,
      message: 'Failed to update journey.',
      error: error.message
    });
  }
};

/**
 * PUT /api/journey/:id/end
 * Transitions a journey to COMPLETED or CANCELLED
 */
const endJourney = async (req, res) => {
  try {
    const userId = req.user._id;
    const journeyId = req.params.id;
    const { status } = req.body; // Expected to be validated as COMPLETED or CANCELLED
    
    const endedJourney = await journeyService.endJourney(journeyId, userId, status);
    
    return res.status(200).json({
      success: true,
      message: `Journey marked as ${status}.`,
      journey: endedJourney
    });
  } catch (error) {
    // Map service layer errors to appropriate HTTP status codes
    const isNotFoundError = error.message.includes('not found');
    const isValidationError = error.message.includes('Invalid final status');
    
    let statusCode = 500;
    if (isNotFoundError) statusCode = 404;
    else if (isValidationError) statusCode = 400;

    return res.status(statusCode).json({
      success: false,
      message: 'Failed to end journey.',
      error: error.message
    });
  }
};

/**
 * GET /api/journey/active
 * Retrieves the currently active journey for the user, if one exists.
 */
const getJourneyStatus = async (req, res) => {
  try {
    const userId = req.user._id;
    const activeJourney = await journeyService.getJourneyStatus(userId);
    
    // Applying the mobile-friendly empty state pattern (return 200 OK with null)
    return res.status(200).json({
      success: true,
      message: activeJourney ? 'Active journey retrieved successfully.' : 'No active journey found.',
      journey: activeJourney || null
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve journey status.',
      error: error.message
    });
  }
};

/**
 * GET /api/journey/history
 * Retrieves the user's journeys, newest first.
 */
const getJourneyHistory = async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const journeys = await journeyService.getJourneyHistory(req.user._id, limit);
    return res.status(200).json({
      success: true,
      message: 'Journey history retrieved successfully.',
      journeys
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve journey history.',
      error: error.message
    });
  }
};

module.exports = {
  startJourney,
  updateJourney,
  endJourney,
  getJourneyStatus,
  getJourneyHistory
};
