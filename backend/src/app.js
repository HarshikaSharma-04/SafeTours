const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

// import routes
const authRoutes = require('./routes/authRoutes');
const profileRoutes = require('./routes/profileRoutes');
const emergencyContactRoutes = require('./routes/emergencyContactRoutes');
const locationRoutes = require('./routes/locationRoutes');
const journeyRoutes = require('./routes/journeyRoutes');
const weatherRoutes = require('./routes/weather.routes');
const crowdRoutes = require('./routes/crowd.routes');
const sosRoutes = require('./routes/sosRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const communityRoutes = require('./routes/community.routes');
const geofenceRoutes = require('./services/geofence/geofence.routes');
const assistantRoutes = require('./routes/assistant.routes');
const riskRoutes = require('./routes/risk.routes');
const adminRoutes = require('./routes/admin.routes');
const nearbyRoutes = require('./routes/nearby.routes');
const placesRoutes = require('./routes/places.routes');
const metaRoutes = require('./routes/meta.routes');
const { verifyJWT } = require('./middleware/authMiddleware');

const { errorMiddleware } = require('./middleware/errorMiddleware');

const app = express();

// ─── Security headers ─────────────────────────────────────────────────────────
app.use(helmet());

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || process.env.NODE_ENV !== 'production') {
        return callback(null, true);
      }
      const allowedOrigins = (process.env.CLIENT_ORIGIN || '').split(',').map(o => o.trim()).filter(Boolean);
      if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })
);

// ─── Request rate limiting (auth routes get tighter limits) ──────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.RATE_LIMIT_MAX) || 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many auth attempts, please try again in 15 minutes.' },
});

app.use(globalLimiter);

// ─── Body parsers ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: true, limit: '16kb' }));
app.use(cookieParser());

// ─── HTTP request logger (dev only) ──────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Server is healthy 🚀'
  });
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api', metaRoutes); // /api/health and /api/config/client (no auth)
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/profile', profileRoutes);

app.use('/api/contacts', emergencyContactRoutes);

app.use('/api/location', locationRoutes);

app.use('/api/journey', journeyRoutes);

app.use('/api/sos', sosRoutes);

app.use('/api/notifications', notificationRoutes);

// These proxy paid third-party APIs: they require a signed-in user.
app.use('/api/weather', verifyJWT, weatherRoutes);

app.use('/api/crowd', verifyJWT, crowdRoutes);

app.use('/api/risk', riskRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/nearby', nearbyRoutes);
app.use('/api/places', placesRoutes);
app.use('/api/community', communityRoutes);
app.use('/api/geofence', geofenceRoutes);
app.use('/api/assistant', assistantRoutes);

// ─── 404 handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.originalUrl} not found`
  });
});

// ─── Global error handler (must be last) ─────────────────────────────────────
app.use(errorMiddleware);

module.exports = app;