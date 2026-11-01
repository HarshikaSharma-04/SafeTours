const { query } = require('express-validator');

const coordinate = (name, max) =>
  query(name).exists({ checkNull: true, checkFalsy: true }).withMessage(`${name} is required.`)
    .isFloat({ min: -max, max }).withMessage(`${name} must be between -${max} and ${max}.`).toFloat();

const searchRules = [
  query('q').isString().withMessage('q is required.').trim().isLength({ min: 2, max: 200 }).withMessage('q must be 2 to 200 characters.'),
  query('lat').optional().isFloat({ min: -90, max: 90 }).toFloat(),
  query('lng').optional().isFloat({ min: -180, max: 180 }).toFloat(),
];

const routeRules = [
  coordinate('fromLat', 90),
  coordinate('fromLng', 180),
  coordinate('toLat', 90),
  coordinate('toLng', 180),
  query('mode').optional().isIn(['foot', 'car']).withMessage('mode must be foot or car.'),
];

module.exports = { searchRules, routeRules };
