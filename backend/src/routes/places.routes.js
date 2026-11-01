const express = require('express');
const { verifyJWT } = require('../middleware/authMiddleware');
const { userLimiter } = require('../middleware/rateLimiters');
const { validateRequest } = require('../validators/riskValidator');
const { searchRules, routeRules } = require('../validators/placesValidator');
const { searchPlaces, getRoute } = require('../controllers/places.controller');

const router = express.Router();

// These proxy paid or quota-limited APIs: signed-in users only, limited per user.
router.use(verifyJWT);
router.get('/search', userLimiter({ windowMs: 60 * 1000, limit: 40, message: 'Too many searches, slow down.' }), searchRules, validateRequest, searchPlaces);
router.get('/route', userLimiter({ windowMs: 60 * 1000, limit: 20, message: 'Too many route requests, slow down.' }), routeRules, validateRequest, getRoute);

module.exports = router;
