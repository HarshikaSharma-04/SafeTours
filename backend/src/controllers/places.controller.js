const placesService = require('../services/places/placesService');
const asyncHandler = require('../utils/asyncHandler');

// GET /api/places/search?q=&lat=&lng=
const searchPlaces = asyncHandler(async (req, res) => {
  // Express 5 keeps req.query read-only, so the validator's toFloat() cannot convert these: convert them here.
  const { q, lat, lng } = req.query;
  const data = await placesService.search(q.trim(), {
    lat: lat === undefined ? undefined : Number(lat),
    lng: lng === undefined ? undefined : Number(lng),
  });
  res.status(200).json({ success: true, message: 'Places retrieved successfully.', data });
});

// GET /api/places/route?fromLat&fromLng&toLat&toLng&mode=foot|car
const getRoute = asyncHandler(async (req, res) => {
  const { fromLat, fromLng, toLat, toLng, mode } = req.query;
  const data = await placesService.route(
    { lat: Number(fromLat), lng: Number(fromLng) },
    { lat: Number(toLat), lng: Number(toLng) },
    mode
  );
  res.status(200).json({ success: true, message: 'Route retrieved successfully.', data });
});

module.exports = { searchPlaces, getRoute };
