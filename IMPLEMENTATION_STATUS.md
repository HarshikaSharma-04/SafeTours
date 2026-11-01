# SafeTours IPD: Implementation Status and Handover

Written 2026-10-07 after Phase 6B; Phase 7 section added 2026-10-11, flow fixes added 2026-11-01 (see "Flow fixes" in section 4, and ARCHITECTURE.md for how everything works). Give this file, the Core Features document and the Integration document to a new reader (or a new AI session) and they should be able to continue the work.

**How to read it:** the repository is the source of truth. Where this file and the code disagree, trust the code. Statements are marked **[verified]** (an automated test or a build confirmed it), **[written, untested]** (code exists, only parsed or unit-tested), or **[not on a device]** (needs a real phone, which nobody has run yet).

---

## 1. Where we are (one-page summary)

| Original goal | Status |
|---|---|
| 1. Risk accuracy: replace mocked or hardcoded scoring with real, explainable scoring | **Coded and unit-tested** (Phases 1 to 3). Runs on real data feeds with graceful degradation. Crime data is real only if the CSV pipeline was run; otherwise it is flagged "demo". |
| 2. Offline support | **Coded and unit-tested** (Phases 6A, 6B): connectivity states, SQLite risk cache, on-device geofence, outbox with upload, SMS fallback for SOS. **Nothing has run on a phone.** |
| 3. Nearby hospitals, police, pharmacies, fire | **Coded and unit-tested** (Phase 5), including offline cache and download. |
| 4. Community plus Gemini chatbot feeding the risk formula | **Partly done.** The community component is wired into the risk formula (Phase 3). **The Gemini chatbot and community-scoring changes are not built (Phase 7).** An `AISafetyAssistantScreen` exists in the app but was not rebuilt. |

Rough estimate of planned work: about **80 % of the planned code is written**. The remaining 20 % is Phase 7 (chatbot, community changes) plus polish. **Device verification is about 0 %**: the dev build's behaviour has not been reported back yet. That is the main risk, not missing features.

Automated checks right now: backend **169 tests pass**, frontend **79 tests pass**, backend smoke test **28 routes pass**, **122 backend modules load**, Metro **Android export succeeds** (Hermes bytecode produced). The Kotlin SMS module has **never been compiled**.

---

## 2. Project layout and stack

```
D:\Desktop\IPD-1\SafeTours_IPD_NodeJS
  backend\        Node 22, Express 5, Mongoose 9, MongoDB Atlas, h3-js (H3 resolution 9 grid)
  frontend\       Expo SDK 54, React Native 0.81, React 19, Hermes, expo-sqlite, react-native-maps 1.20.1
  preprocessing\  crime/infra data preparation (CSV, infra_locations.json)
  IMPLEMENTATION_STATUS.md  (this file)
```

- Frontend uses **SDK 54 docs only** (`frontend/AGENTS.md`). Many features need an **EAS development build**, not Expo Go (SQLite works in Expo Go, but remote push on Android, background location, the SMS module and the volume-button module do not).
- `frontend/eas.json` and `expo-dev-client` were added in Phase 6B.
- Atlas access from the assistant is **read-only**. All writes, migrations and index builds are scripts the owner runs.

---

## 3. Standing rules from the owner (apply to all future work)

1. The repo is the source of truth, not pasted docs.
2. Change backend **and** every frontend caller in the same phase; include a "Contract changes" table.
3. Report each phase with: files changed/added/deleted, env vars/packages/indexes/migrations, contract changes, manual test checklist with curl, what is still hardcoded or limited, and the 5 riskiest assumptions.
4. Do not start the next phase early.
5. No database writes, deletes, drops or index builds from the assistant. Give scripts for the owner to run.
6. Everything must work with **no Firebase and no Twilio credentials**: Expo push, on-device SMS as the primary path, Twilio optional.
7. External APIs must degrade gracefully: cached last value plus a stale/unavailable flag, **never a fake number**.
8. A missing risk value is `UNKNOWN`, never `SAFE`. A missing location is never replaced with a made-up place.

---

## 4. Phase-by-phase history

### Phase 1 to 3: risk engine rebuilt on the backend
- Scoring moved from the app into Node. Config in `backend/src/config/risk.config.js`, engine in `services/risk/riskEngine.js`, per-cell service `services/risk/cellRisk.service.js`.
- **Formula:** weighted average of up to five components, renormalised over the components that actually have usable data: crime 0.40, weather 0.20, crowd 0.15, community 0.15, news 0.10. Labels: SAFE below 20, LOW 20, MODERATE 40, HIGH 60, EXTREME 80. `UNKNOWN` is a separate sentinel (shown with a null score). Output includes `dataConfidence`, `lowConfidence`, `demo`, missing and stale component lists.
- **Time of day** is a multiplier applied on read (night x1.2, evening x1.08) plus festival boosts (config list). Cells store the raw component scores; the composite is computed on read.
- **Producers (each writes component scores and a `FeedStatus` heartbeat):**
  - weather: 12 sample points with inverse-distance weighting (`weather.config.js`, scheduler `weatherScheduler.js`)
  - crowd: Geoapify places, recomputed hourly in IST (`crowdScheduler.js`)
  - news: gazetteer plus classifier (`newsScheduler.js`, `mumbaiGazetteer.js`)
  - community: from `Incident` documents (`services/risk/communityComponent.js`)
  - crime: CSV pipeline with DBSCAN (`services/crime/crimePipeline.js`, script `npm run crime:build`), or a **demo flag** (`USE_DEMO_CRIME_DATA`) with a fixed 55/20/15/10 SAFE/LOW/MODERATE/HIGH distribution so demo data is always labelled as demo.
- Admin and validation: `routes/admin.routes.js`, `npm run validate:risk`, `npm run migrate:cells`.

### Phase 4: geofence and cancellable SOS
- **Geofence state machine** SAFE, ENTERING, IN_DANGER, EXITING. Enter at score 60 or more for 3 readings or 60 s; exit below 52 for 3 readings or 90 s (hysteresis). Accuracy cap `GEOFENCE_MAX_ACCURACY_M` (50). `UNKNOWN` never counts as danger. State persisted per user in `UserGeofenceState`, written with compare-and-set so two concurrent requests cannot both advance.
- **Cancellable auto-SOS:** entering a danger zone creates a `pending_confirmation` record with a persisted deadline `confirmBy` (60 s). The user can cancel ("I'm safe") or confirm; with no answer the 5-second `safetyScheduler` escalates it, so it survives a server restart. Cooldown after a cancel; idempotency keys; one open record per user.
- **Shadow Mode:** server-side ETA watch for active journeys; asks "Are you okay?" after the ETA passes.
- **Offline batch rule:** events older than 10 minutes are history only and never start a prompt.
- Push: Expo push with a 5-second polling fallback (`GET /api/sos/pending`).

### Phase 5: nearby services
- `GET /api/nearby` with a per-H3-resolution-8 cache (24 h TTL). Provider chain: Geoapify, then Overpass, then stale cache, then seed data, then "unavailable". One bounding-box fetch for missing cells. Geoapify credits cost about 1 per 20 places returned (worst case about 26 per cold request).
- Frontend: `NearbyContext` (refresh on a new cell or after 1 km, debounced), `locationBus` and `locationWatcher` (one shared GPS watch), widgets on Home, SOS and the map, and an EmergencyServices screen. Opening hours are computed, never guessed; offline `openNow` is null.

### Phase 6A: offline cache and on-device checks
- **Connectivity:** ONLINE / WEAK / OFFLINE from NetInfo plus a `GET /api/health` ping plus recent request outcomes; debounced (3 s worse, 5 s better); a "forced offline" test switch in Settings.
- **SQLite risk cache:** regions (current 3 km, destination 2 km, manual 2/5/10 km), cell rows with `baseRisk` so the phone re-applies the time multiplier offline. Fresh 6 h, usable 7 days, 30,000-row cap with oldest-first eviction. A cell missing from the cache means "no data", never safe.
- **On-device geofence:** the same state machine, shared as `backend/src/shared/deviceCore.js` with a byte-identical copy in `frontend/src/offline/deviceCore.js` (EAS cannot import outside the app folder). A backend parity test replays shared fixtures through both and fails if the copies differ. After editing run `npm run sync:device-core`. IST is fixed UTC+5:30 arithmetic, not `Intl`.
- Thresholds come from `GET /api/config/client`, cached on the phone with built-in defaults that a test keeps equal to the server's.
- Settings shows real cache sizes and ages, "Download this area", and the offline switch. The map shows an offline pill; on Android Google Maps `mapType` is `none` when offline.
- **Map tiles, plainly:** react-native-maps cannot download offline base tiles. Offline you get a blank (or OS-cached) base with cached risk cells and nearby pins on top. Real offline tiles would need MapLibre offline packs or a licensed/self-hosted tile source.

### Phase 6B: outbox, upload, SMS fallback
- One SQLite `outbox` table (schema version 2): types `sos`, `sos_cancel`, `journey_update`, `geofence_event`, `community_report`, `location_point`. Idempotency key (UUID v4) made once at creation. Statuses pending / sending / sent / failed / dead.
- Backoff with jitter (5 s base, 15 min max). Runs when ONLINE, on foreground, every 30 s, and after queueing; never while OFFLINE. Order: SOS, SOS cancel, journey updates, geofence events, community reports, location points; oldest first. Stuck "sending" rows reset at startup. 4xx (except 408, 429) is `dead`; 401 holds without charging an attempt. Poison items in a batch are isolated by splitting. Cap 3,000 live rows; oldest location points are dropped first; SOS is never dropped. Rows are owned by the signed-in user.
- **Server:** generic `Idempotency-Key` middleware (collection `idempotencyrecords`), `POST /api/location/batch`, `POST /api/geofence/events` (history only), `/api/sos` accepts `clientCreatedAt` and an SMS report. A queued SOS delivered more than 120 s late is stored with its **original time**, `lateDelivery:true` and `lateBySeconds`; texts and notifications say when it was triggered (IST) and how late it was. The server skips contacts the phone already texted (confirmed sends only).
- **SOS flow on the phone** (`services/sosDispatcher.js`): write to outbox first, upload at once if online (8 s wait), otherwise text the contacts from the phone and upload later. Failed texts retry every 20 s for 10 min. Three separate UI facts: queued on this phone / SMS sent n of N / delivered to server. A persistent "SOS pending: no signal" banner. Cancel removes an unsent SOS, flags an in-flight one, or cancels a delivered one on the server, and offers an "I'm safe" follow-up text.
- **SMS:** a small local Android native module (`frontend/modules/safetours-sms`, Kotlin, `SmsManager` with per-part sent confirmation) replaces `react-native-send-direct-sms` (fire-and-forget, no sent confirmation, last published 2023). iOS cannot send silently, so it opens the prefilled composer and never claims "sent" unless the composer says so. Android's composer only says "opened". `SEND_SMS` is in `app.json`. **Play Store:** `SEND_SMS` is restricted; expect a declaration review or rejection. Sideloaded and internal builds are fine.
- **Hardware trigger:** triple volume press (**foreground only**, off by default, via `react-native-volume-manager`) and a sticky Android notification shortcut. Both use a 3-second cancel window. A JS app cannot read volume buttons with the screen off.
- Settings: upload queue viewer (retry, discard, clear sent), contacts sync status, SMS permission with Grant, "Test SMS to myself", SOS text preview and custom sentence (120 characters), trigger switches.
- Package fixes found during verification: `expo-sms 57` (should be `~14.0.8`), `netinfo 12` (should be `11.4.1`), `expo-constants 17` and `expo` were wrong for SDK 54; fixed with `npx expo install --fix`.


### Phase 7: community score rebuilt, Gemini assistant (last feature phase)  (added 2026-10-11)
- **Community score** (`backend/src/services/risk/communityScoring.js`, pure; config `config/communityConfig.js`): weight = category severity x time decay (per-category TTL) x verification (0.5 until 3 confirmations from OTHER users) x false-report penalty x reporter reliability (new user exactly neutral; Beta prior from confirmed vs rejected reports in 90 days). Per-user cap per cell. Only incidents confirmed by 2+ users spread to neighbouring rings (0.5, 0.25). One severity number per category; the LOW/MEDIUM/HIGH/CRITICAL label is derived from it. `GET /api/community/categories` serves the single list to the app.
- **"No reports" vs "no data":** community stays a `feed` component. With a healthy feed, a cell without reports scores 0 (a real observation) and counts at 0.7 of its confidence weight, with a note in the response (`notes`, `breakdown.community.noReports/reports`). A dead feed makes it missing/stale, never silently 0. Community can never carry demo data.
- **Anti-spam:** 10 reports/hour per user (existing), same-user duplicate within 100 m / 30 min rejected (409), another user's identical report becomes a confirmation, reporters cannot confirm their own report, 5 false flags remove a report (config).
- **Assistant** `POST /api/assistant/chat` (`services/assistant/*`, `shared/assistantRules.js`): grounded context (location + H3 cell, risk, weather, nearest hospital/police, journey ETA, nearby community reports, connectivity); untrusted text sanitised, truncated and sent as quoted JSON data; invented phone numbers are detected and replaced by the rule-based answer; Gemini failure/timeout/missing key gives the rule-based "offline assistant" answer from the same context; report **proposals** only (never filed by the assistant; the app files after the user taps Confirm). No message content in server logs; chat history stays on the phone.
- **Phone:** new AISafetyAssistantScreen (real messages, loading/error states, AI vs offline label, quick prompts, proposal card, Clear), offline answers from cached risk/nearby via the shared rules file, Home "Safety tips" from real data (no AI call), community contribution in the risk detail chips, report categories from the server list.
- Tests now: backend 213, frontend 88. Env: `GEMINI_API_KEY`, `GEMINI_MODEL` (+ optional `GEMINI_TIMEOUT_MS`, `ASSISTANT_PER_MINUTE`, `ASSISTANT_PER_HOUR`).
- Two shared files now need syncing after edits: `npm run sync:device-core` copies `deviceCore.js` and `assistantRules.js`.

### Flow fixes (2026-11-01)
- **Map engine replaced.** `react-native-maps` (needed a Google key in the Android build, none exists) is gone. `components/MapComponent.jsx` keeps its props but renders Leaflet with OpenStreetMap tiles in a WebView (`map/mapHtml.js`, `map/leafletBundle.js`; run `node scripts/buildLeafletBundle.js` after upgrading Leaflet). No key. **A development build must be rebuilt** (`react-native-webview`); Expo Go already includes it. This replaces the Phase 6A notes about Google Maps and `mapType` none.
- **Map screen:** cells follow the camera and include SAFE; a tapped cell shows its own score and factors; search suggestions keep their coordinates; denied location permission can browse the map; a note explains an empty map.
- **New endpoints:** `GET /api/journey/history`, `POST /api/auth/logout`, `/forgot-password`, `/reset-password`, `GET /api/places/search`, `GET /api/places/route` (env `ORS_API_KEY`, optional `SMTP_*`).
- **Journeys:** destination is searched by name, not typed as coordinates; route, ETA estimate, risk along the route, real progress, arrival sync in the foreground.
- **Sessions:** a dropped connection no longer logs the user out, at startup or during a token refresh.
- **Navigation:** `navigationInChildEnabled` on the container: stack screens could not open tabs on React Navigation 7, so the journey SOS button and sidebar silently did nothing from them.
- **Dead controls fixed:** Share Location (Map, Home, SOS share sheet), Forgot Password (screen was not registered and its service did not exist), Terms row, repeat SOS from Home (only the first press fired), notification icons (type casing), a setting mislabelled as fall detection.
- `OWM_API_KEY` is accepted for `OPENWEATHER_API_KEY` (`config/envAliases.js`).
- **Crime data is still missing:** `preprocessing/crime_clean.csv` has only 2 rows inside the Mumbai box, so `crime:build` refuses it. Everything else in the risk score is working as designed.
- Tests: backend 226, frontend 95, plus a 90-check API run on a throwaway MongoDB. **Still not run on a phone.**

---

## 5. Backend inventory

### Route groups (`backend/src/app.js`)
| Mount | Purpose | Auth |
|---|---|---|
| `/api` (meta) | `GET /health`, `GET /config/client` | none |
| `/api/auth` | register, login, refresh, logout | rate limited |
| `/api/profile` | profile, medical info, emergency settings (including `customSosMessage`), completeness, image | JWT |
| `/api/contacts` | emergency contacts CRUD | JWT |
| `/api/location` | `POST /` single point, `POST /batch`, `GET /latest` | JWT, idempotent |
| `/api/journey` | `start`, `update/:id`, `end/:id`, `status` | JWT, idempotent |
| `/api/sos` | create, `/pending`, `/active`, `/history`, `/:id/confirm`, `/:id/cancel` | JWT |
| `/api/geofence` | `check`, `sync`, `events`, `status`, `history` | JWT |
| `/api/risk` | `location`, `live`, `cells` (with `compact`), `cell/:h3` | JWT |
| `/api/nearby` | nearby services | JWT |
| `/api/community` | report (idempotent), nearby, my-reports, confirm, report-false, details | JWT |
| `/api/notifications`, `/api/weather`, `/api/crowd`, `/api/admin` | alerts, feeds, admin tools | JWT (admin role for admin) |

### Mongo collections (models)
User, EmergencyContact, Location, Journey, SOSHistory, GeofenceEvent, UserGeofenceState, GridCell (risk components per H3 cell), FeedStatus, Incident, IncidentConfirmation, FalseIncidentReport, NearbyCellCache, NearbyPlace, PoiCache, GeocodeCache, Notification, DeviceToken, RefreshToken, **IdempotencyRecord** (new in 6B).

### Background jobs (`backend/src/scheduler`)
`safetyScheduler` (SOS deadlines, every 5 s), `weatherScheduler`, `crowdScheduler`, `newsScheduler`, `communityExpiryJob`.

### Environment variables found in the code
`MONGO_URI`, `PORT`, `NODE_ENV`, `CLIENT_ORIGIN`, `ACCESS_TOKEN_SECRET`, `ACCESS_TOKEN_EXPIRY`, `REFRESH_TOKEN_SECRET`, `REFRESH_TOKEN_EXPIRY`, `RATE_LIMIT_MAX`, `OPENWEATHER_API_KEY`, `GEOAPIFY_API_KEY`, `NEWSDATA_API_KEY`, `NEWS_API_URL`, `NEWS_QUERY`, `OVERPASS_URLS`, `EXPO_ACCESS_TOKEN`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` (all three optional), `USE_DEMO_CRIME_DATA`, `WEATHER_REFRESH_MS`, `CROWD_REFRESH_MS`, `NEWS_REFRESH_MS`, `GEOFENCE_*` (enter/exit score, readings, dwell, max accuracy, historical minutes), `SOS_*` (confirm seconds, cooldown, poll seconds, active max hours, `SOS_LATE_AFTER_SECONDS`, `SOS_MAX_BACKDATE_HOURS`), `JOURNEY_ARRIVAL_RADIUS_M`, `JOURNEY_ETA_EXTEND_MIN`. Defaults live in `backend/src/config/*.config.js`.

### Scripts the owner runs (never the assistant)
```bash
npm run migrate:cells        # GridCell migration
npm run crime:build          # crime pipeline
npm run validate:risk
npm run seed:nearby          # dry run; add -- --apply
npm run create:indexes       # dry run; add -- --apply   (new in 6B)
npm run user:role -- <email> admin
npm run sync:device-core     # after editing backend/src/shared/deviceCore.js
```

---

## 6. Frontend inventory (`frontend/src`)

- **Screens (`screens/main`):** Home, SOS, SafetyMap, EmergencyServices, LiveJourney, Settings, EmergencyContacts, ContactForm, MedicalId, Profile, UserProfile, Notifications, JourneyHistory, SOSHistory, **AISafetyAssistant (present, not rebuilt)**; auth screens under `screens/auth`.
- **Contexts:** Auth, Connectivity, Outbox, SosTrigger (3-second countdown, volume trigger, notification shortcut), OfflineData (prefetch, stats, downloads), SafetyCheck (server "Are you safe?" prompt), Nearby, Sidebar.
- **Services:** `apiClient` (axios, forced-offline guard, outcome reporting), `riskService` (cache fallback), `riskCache`, `clientConfig`, `nearby`, `outbox`, `outboxRunner`, `outboxUploaders`, `sosDispatcher`, `smsSender`, `contactsCache`, `profile`, `contacts`, `journeys`, `locationService`, `communityService`, `geofence`, `sos`, `pushNotifications`, `session`.
- **Storage (SQLite, `storage/`):** `db.js` (schema v2), `kvCache`, `riskCellStore`, `outboxStore`, `deviceLogStore`.
- **Pure, unit-tested logic (`offline/`, CommonJS, run by `node --test`):** `deviceCore` (shared with backend), `deviceGeofence`, `connectivityMachine`, `cacheLogic`, `offlineConfig`, `outboxLogic`, `outboxStoreCore`, `batchSend`, `smsLogic`, `sosMessage`, `pressDetector`, `uuid`.
- **Native:** `modules/safetours-sms` (Kotlin, Android only). Found by Expo autolinking [verified]; never compiled.
- **Utilities:** `geofenceManager` (server check, or on-device check when offline), `deviceGeofenceRunner`, `locationBus`, `locationWatcher`, `backgroundGeofence` (task-manager background tracking during journeys), `smsPermissionFlow`.

---

## 7. Test and verification status

| Area | State |
|---|---|
| Backend unit tests (risk engine, producers, geofence, SOS, nearby, community, idempotency, location batch, device events, late delivery, device-core parity) | 169 pass **[verified]** |
| Frontend unit tests (connectivity machine, cache TTL and eviction, device geofence parity, backoff, ordering, startup reset, dead letters, queue cap, dedupe on real SQLite, batch splitting, SMS state machine, message segments, press detector) | 79 pass **[verified]** |
| Smoke test of 28 routes (expects 401 without a token) | pass **[verified]** |
| Android bundle (Metro plus Hermes) | success **[verified]** |
| Kotlin SMS module compile, SQLite v2 migration on expo-sqlite, h3-js on Hermes, notifications, volume module on RN 0.81, airplane-mode and killed-app flows | **[not on a device]** |
| Live Mongo behaviour of the new unique indexes | not run (owner runs `create:indexes`) |

---

## 8. Known limitations and honest caveats

- **Offline SOS cannot be guaranteed:** airplane mode blocks SMS too; with no cell service a text fails and is retried for 10 minutes. iOS always needs a tap on Send. Android composer texts cannot be confirmed, so the server may text those contacts as well (chosen deliberately).
- **Play Store** restricts `SEND_SMS`.
- **Hardware trigger** is foreground only; no widget.
- **Crime data:** real only after the crime pipeline is run on real data; otherwise the demo flag labels it as demo.
- **Weather** is not cached offline; **nearby** `openNow` is null offline.
- **Map base tiles** are not available offline (see Phase 6A).
- The SOS list on the SOS screen is not filtered by user (upload is, via the row owner tag).
- Geoapify credit cost of "Download this area" is an estimate (about 12 credits per lookup).
- `locationService` still sets accuracy to 10 when none is supplied (older behaviour).
- The first on-device geofence check after going offline starts from a fresh state, not the server's counters.

### Five riskiest assumptions (from the Phase 6B report) to test first on a phone
1. The Kotlin SMS module compiles and reports real per-contact results.
2. `SEND_SMS` behaves on current Android (Android 14+, OEM skins).
3. The SQLite v2 migration and killed-app reset work on expo-sqlite (unit tests used `node:sqlite`).
4. `react-native-volume-manager` builds and fires on RN 0.81; the sticky notification works and behaves on a locked screen.
5. Retry timings (8 s upload wait, 30 s SMS hold, debounce) hold up on a flaky network without double texts.

---

## 9. What is left

**Phase 7 (next, not started):**
- Gemini chatbot (`AISafetyAssistantScreen` exists; backend integration, safety guardrails and how chatbot or community signals enter the risk formula are undecided).
- Community scoring changes (the component exists and is wired; the owner asked for changes in Phase 7).
- Push to locked screens.

**Not planned but worth doing:** a real device test pass of everything in Section 7's last row; a licensed offline tile source; background (not just foreground) on-device geofencing; Play Store compliance decision for SMS.

---

## 10. How to run things

```bash
# backend
cd backend && npm start                  # or: npm run dev
node --test                              # 169 tests
# frontend
cd frontend && npx expo install --check  # should report nothing outdated
node --test --no-warnings                # 79 tests (run the directory form on Windows via PowerShell if Git Bash fails)
eas build --profile development --platform android   # new dev build needed for 6B (native modules)
```
Use PowerShell for `npm` and `npx` on this machine; Git Bash does not run `npm`. Bash heredocs with quotes break the tool; write files with the editor tool.

---

## 11. Glossary

- **H3 cell:** hexagon id; resolution 9 (about 175 m edge) for risk, resolution 8 for nearby caching.
- **Outbox:** the phone's SQLite queue of things waiting to reach the server.
- **Idempotency key:** a UUID made once per action; sending it twice produces one record.
- **Late delivery:** an SOS queued offline and delivered after more than 120 s; stored with its original trigger time.
- **Demo flag:** data labelled as sample data (crime), never presented as real.
- **UNKNOWN:** "not enough data"; never shown or treated as safe.
