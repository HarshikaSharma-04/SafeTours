const { body, validationResult } = require('express-validator');

/**
 * Helper function to validate if an array is a valid [longitude, latitude] pair.
 */
const isValidCoordinatePair = (value) => {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new Error('Must be an array of exactly two numbers.');
  }
  const [lng, lat] = value;
  
  if (typeof lng !== 'number' || typeof lat !== 'number') {
    throw new Error('Coordinates must be numeric values.');
  }
  if (lng < -180 || lng > 180) {
    throw new Error('Longitude must be between -180 and 180.');
  }
  if (lat < -90 || lat > 90) {
    throw new Error('Latitude must be between -90 and 90.');
  }
  
  return true;
};

// Validation rules for starting a new journey
const validateStartJourney = [
  body('startLocation')
    .exists({ checkNull: true }).withMessage('startLocation is required.')
    .custom(isValidCoordinatePair),

  body('destination')
    .exists({ checkNull: true }).withMessage('destination is required.')
    .custom(isValidCoordinatePair),

  body('expectedArrivalTime')
    .exists({ checkNull: true }).withMessage('expectedArrivalTime is required.')
    .isISO8601().withMessage('expectedArrivalTime must be a valid ISO 8601 date string.')
    .toDate() // Cast to Date object
    .custom(value => {
      // Ensure the ETA is actually in the future
      if (value.getTime() <= Date.now()) {
        throw new Error('expectedArrivalTime must be a time in the future.');
      }
      return true;
    }),

  body('destinationName')
    .optional({ nullable: true })
    .isString().withMessage('destinationName must be text.')
    .trim()
    .isLength({ max: 200 }).withMessage('destinationName must be at most 200 characters.'),
];

// Validation rules for updating a journey's status (e.g., finishing or cancelling a trip)
const validateUpdateJourney = [
  body('expectedArrivalTime').optional({ nullable: true }).isISO8601().withMessage('expectedArrivalTime must be ISO 8601.')
    .custom((v) => { if (new Date(v).getTime() <= Date.now()) throw new Error('expectedArrivalTime must be in the future.'); return true; }),
  body('currentLocation').optional({ nullable: true }).isObject().withMessage('currentLocation must be {latitude, longitude, accuracy?}.'),
  body('currentLocation.latitude').if(body('currentLocation').exists({ checkNull: true })).isFloat({ min: -90, max: 90 }).toFloat(),
  body('currentLocation.longitude').if(body('currentLocation').exists({ checkNull: true })).isFloat({ min: -180, max: 180 }).toFloat(),
  body('currentLocation.accuracy').optional({ nullable: true }).isFloat({ min: 0 }).toFloat(),
];

const validateUpdateJourneyStatus = [
  body('status')
    .exists({ checkNull: true }).withMessage('status is required.')
    .isIn(['ACTIVE', 'COMPLETED', 'CANCELLED']).withMessage('status must be one of: ACTIVE, COMPLETED, CANCELLED.')
];

// Middleware to intercept validation errors and return a clean 400 response
const validateJourneyRequest = (req, res, next) => {
  const errors = validationResult(req);
  
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed for journey data.',
      errors: errors.array().map(err => ({
        field: err.path,
        message: err.msg
      }))
    });
  }
  
  next();
};

module.exports = {
  validateStartJourney,
  validateUpdateJourney,
  validateUpdateJourneyStatus,
  validateJourneyRequest
};
