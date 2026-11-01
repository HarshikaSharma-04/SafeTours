'use strict';

/**
 * offlineConfig: every tunable of the offline layer in one place (pure CommonJS so the unit tests and the
 * app share it).
 *
 * `clientConfigDefaults` are the server's own defaults (backend GET /api/config/client). The app uses the
 * values fetched from the server when it has ever been online and falls back to these on a fresh install
 * that has never reached the server. A backend test fails if these defaults drift from the server's.
 */

const clientConfigDefaults = {
  geofence: {
    accuracyMaxMeters: 50,
    enterScore: 60,
    exitScore: 52,
    enterReadings: 3,
    enterDwellSeconds: 60,
    exitReadings: 3,
    exitDwellSeconds: 90,
    minReadingsForDwell: 2,
    historicalAfterMinutes: 10,
    futureToleranceSeconds: 60,
  },
  risk: {
    timezone: 'Asia/Kolkata',
    thresholds: [
      { level: 'SAFE', min: 0 },
      { level: 'LOW', min: 20 },
      { level: 'MODERATE', min: 40 },
      { level: 'HIGH', min: 60 },
      { level: 'EXTREME', min: 80 },
    ],
    dangerLevels: ['HIGH', 'EXTREME'],
    confidence: { high: 0.85, medium: 0.6, minCoverageForLevel: 0.35 },
    timeModifier: {
      bands: [
        { from: 22, to: 5, multiplier: 1.2, label: 'night' },
        { from: 19, to: 22, multiplier: 1.08, label: 'evening' },
        { from: 5, to: 19, multiplier: 1.0, label: 'day' },
      ],
    },
    festivals: [
      { name: 'Holi', start: '2026-03-03', end: '2026-03-05', riskBoost: 1.1 },
      { name: 'Ganesh Chaturthi', start: '2026-09-14', end: '2026-09-24', riskBoost: 1.1 },
      { name: 'Navratri', start: '2026-10-11', end: '2026-10-20', riskBoost: 1.08 },
      { name: 'Diwali', start: '2026-11-06', end: '2026-11-10', riskBoost: 1.1 },
      { name: "New Year's Eve", start: '2026-12-31', end: '2027-01-01', riskBoost: 1.12 },
    ],
  },
};

module.exports = {
  clientConfigDefaults,

  // How often the cached server config is refreshed when online.
  clientConfigRefreshMs: 24 * 3600 * 1000,

  /**
   * Connectivity state machine (ONLINE / WEAK / OFFLINE).
   * WEAK = connected, but a recent request failed or was slow, the ping was slow/failed once, or the link is 2G.
   */
  connectivity: {
    pingPath: '/health', // relative to the API base URL (-> GET /api/health, no auth)
    pingIntervalMs: 30 * 1000,
    pingIntervalDegradedMs: 10 * 1000, // faster while not ONLINE, to notice recovery
    pingTimeoutMs: 4000,
    slowRequestMs: 4000,
    slowPingMs: 3000,
    weakWindowMs: 60 * 1000, // how long a failed / slow request keeps the state at WEAK
    recentRequests: 5,
    pingFailuresForOffline: 2, // consecutive failed pings = server unreachable = OFFLINE
    degradeDebounceMs: 3000, // a worse state must persist this long before it is shown
    recoverDebounceMs: 5000, // a better state must persist this long
    weakCellularGenerations: ['2g'],
  },

  /**
   * Risk-cell cache (SQLite). A "region" is one downloaded bounding box.
   * A cached cell is fresh for freshMs, usable (shown with its age) up to usableMs, then ignored.
   * maxRows caps the table; the oldest regions are evicted first (protected kinds last).
   */
  riskCache: {
    freshMs: 6 * 3600 * 1000,
    usableMs: 7 * 24 * 3600 * 1000,
    maxRows: 30000, // about 3 MB at ~100 bytes per row
    protectedKinds: ['current', 'destination'],
    tileSizeDeg: 0.1, // a download is split into tiles of at most this size (each <= ~1,400 cells < server cap 3,000)
    currentRadiusM: 3000,
    destinationRadiusM: 2000,
    prefetchMinIntervalMs: 15 * 60 * 1000,
    rowBytesEstimate: 110,
  },

  nearbyCache: {
    ttlMs: 7 * 24 * 3600 * 1000,
    maxEntries: 40,
    maxBytes: 2 * 1024 * 1024,
    lookupRadiusM: 3000,
    centerSpacingM: 4200, // download centres: 3 km circles on a 4.2 km square lattice cover the area
    creditsPerCenterEstimate: 12, // rough Geoapify credits for a cold 3 km lookup (phase 5 report: ~10-25)
  },

  /**
   * Outbox (SQLite): everything that must reach the server but could not while offline.
   * Retry delay = min(maxMs, baseMs * factor^(attempts-1)), then randomised by +/- jitter so many phones
   * coming back online together do not hit the server at the same instant.
   */
  outbox: {
    backoff: { baseMs: 5000, factor: 2, maxMs: 15 * 60 * 1000, jitter: 0.25 },
    // Retryable failures (network, 5xx, 408, 429) give up after this many tries (status 'failed', user can retry).
    // SOS never gives up: its limit is null.
    maxAttempts: { sos: null, sos_cancel: null, journey_update: 12, geofence_event: 12, community_report: 12, location_point: 12 },
    // Upload order: lower number first. Within one type: oldest first.
    priority: { sos: 0, sos_cancel: 1, journey_update: 2, geofence_event: 3, community_report: 4, location_point: 5 },
    drainIntervalMs: 30 * 1000, // timer while ONLINE
    sendingStaleMs: 2 * 60 * 1000, // a row stuck in 'sending' this long is reset to pending
    batchSize: { location_point: 100, geofence_event: 100 },
    sosImmediateTimeoutMs: 8000, // how long "send now" waits before the SOS is left to the background retry
    smsHoldMs: 30 * 1000, // the upload of an SOS waits at most this long for its SMS attempt to finish
    smsFirstWaitMs: 6000, // online: the upload starts after the texts went out, or after this long if they are slow
    cap: {
      maxRows: 3000, // live rows (pending / sending / failed / dead)
      pendingMaxAgeMs: 7 * 24 * 3600 * 1000, // older rows are dropped (SOS excepted)
      sentKeepMs: 24 * 3600 * 1000, // 'sent' rows are kept this long for the history list, then purged
      // When maxRows is exceeded rows are dropped in this order, oldest first. 'sos' and 'sos_cancel' are never dropped.
      dropOrder: ['location_point', 'geofence_event', 'community_report', 'journey_update'],
    },
  },

  /** SOS text message and its automatic retry window. */
  sms: {
    maxSegments: 2,
    retryEveryMs: 20 * 1000, // retry a FAILED send (no signal / no service) after this long, doubling each try...
    retryMaxEveryMs: 5 * 60 * 1000, // ...up to this gap (Android warns the user about an app sending many texts)...
    retryWindowMs: 30 * 60 * 1000, // ...for this long after the SOS was triggered
    permissionWaitMs: 15 * 1000, // a first SOS waits this long for the SEND_SMS answer before it carries on
    staleFixMs: 5 * 60 * 1000, // a GPS fix older than this is labelled with its own time in the text
    defaultName: 'A SafeTours user',
    customTextMax: 120,
  },

  /** Hardware trigger (foreground volume-button press) and the shared cancellation window. */
  hardware: { presses: 3, windowMs: 2000, cooldownMs: 10000 },
  sos: { countdownSeconds: 3 },

  // Readings and events recorded while offline, kept for the upload step (phase 6B).
  deviceLog: { maxReadings: 2000, maxEvents: 500 },

  download: { radiiM: [2000, 5000, 10000] },
};
