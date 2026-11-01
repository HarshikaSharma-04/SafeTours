# SafeTours: Architecture, Algorithms and Design Decisions

Everything here was read from the code (November 2026). Where your planning notes and the code differ, this document says what the code does. Section 16 lists what is missing or only partly built, so you can answer evaluators honestly.

**Contents:** 1 System overview · 2 Tech stack · 3 Authentication · 4 Profile · 5 Emergency contacts · 6 SOS engine · 7 Shadow Mode · 8 Location tracking · 9 Safety score · 10 Maps and routing · 11 Geofencing · 12 AI assistant · 13 Notifications · 14 Connectivity engine · 15 Database, API, failures, security, deployment, logging, testing · 16 Honest gaps · 17 How to run

---

## 1. System overview

```
 PHONE (Expo / React Native)                               SERVER (Node + Express)                 EXTERNAL
 ┌───────────────────────────────┐                        ┌──────────────────────────────┐
 │ Screens: Home, Map, SOS,      │                        │ Middleware: helmet, CORS,    │
 │ Journey, Assistant, Settings  │   HTTPS/JSON + JWT     │ rate limits, JWT, validators,│
 │                               │ ─────────────────────► │ idempotency                  │
 │ Contexts: Auth, Connectivity, │                        │                              │   OpenWeather
 │ Outbox, SosTrigger, Nearby,   │ ◄───────────────────── │ Controllers → Services       │◄─ NewsData.io
 │ OfflineData, SafetyCheck      │                        │                              │   Geoapify
 │                               │                        │ Risk engine (pure functions) │   Overpass
 │ Leaflet map in a WebView      │◄─ OpenStreetMap tiles  │                              │   OpenRouteService
 │                               │                        │ Schedulers: weather, crowd,  │   Gemini
 │ SQLite: risk cache, outbox,   │                        │ news, community expiry,      │   Expo Push
 │ chat, on-device geofence log  │                        │ safety deadlines (5 s)       │   Twilio (optional)
 │                               │                        └──────────────┬───────────────┘
 │ Native SMS module (Android)   │── SMS to contacts                     │ Mongoose
 └───────────────────────────────┘                        ┌──────────────▼───────────────┐
                                                          │ MongoDB Atlas (20 collections)│
                                                          └──────────────────────────────┘
```

**The main idea:** Mumbai is divided into 11,449 hexagons (H3 resolution 9, about 0.1 km² each). Background jobs write raw scores into each hexagon. When anyone asks for risk, the final score is calculated at that moment, because it depends on the time of day and on how old the data is. Geofencing, the map, the assistant, and route checks all read this one source.

**Three rules the code follows everywhere:**
- Missing data is `UNKNOWN`, never `SAFE`. A missing score is never counted as 0.
- A failed external service is reported as stale or unavailable. The app never invents a number.
- Anything important is written to the phone first, then sent, so it survives a lost connection.

**Backend structure:** `routes` (URLs) → `middleware` (checks) → `controllers` (HTTP) → `services` (logic) → `models` (MongoDB). Scoring logic is in pure functions with no database access, which is why it can be unit tested.

---

## 2. Tech stack, and how it differs from your plan

| Area | Your plan | What the code uses | Why it matters |
|---|---|---|---|
| App | React Native | Expo SDK 54, React Native 0.81, React 19, Hermes | Same family |
| Backend | Node + Express | Node, Express 5 | Same. Express 5 makes `req.query` read-only, so validator conversions like `.toFloat()` do not stick |
| Database | MongoDB | MongoDB Atlas, Mongoose 9 | Same |
| Auth | JWT + bcrypt | JWT + bcrypt (10 rounds) + refresh rotation | Same |
| Real-time | Socket.IO | **Not used.** Polling plus Expo push | Simpler and survives bad networks. The "Are you safe?" check polls every 5 s |
| Maps | Google Maps | **Leaflet + OpenStreetMap, no API key** | See section 10 |
| Directions | Google Directions | **OpenRouteService** | Straight-line fallback, labelled in the app |
| Places / geocoding | Google Places | **Geoapify**, then Overpass, then cache, then seed data | Free tier |
| AI | Gemini | Gemini, with a rule-based fallback | Same |
| Notifications | Firebase | **Expo Push** | No Firebase credentials needed |
| Weather | OpenWeather | OpenWeather | Same |
| SMS | Twilio or native | **Native Android module first**, Twilio optional | Works with no internet |
| File upload | Cloudinary | **Not used.** Profile image is a URL | Gap |
| Validation | Joi or Zod | `express-validator` on the server, Zod on the app forms | Same purpose |
| Logging | Morgan + Winston | Morgan + a small custom logger | No Winston |
| Spatial index | (PDF: PostGIS) | **H3 hexagons** + MongoDB `2dsphere` indexes | Equal-sized cells, fast neighbour lookup |

Other libraries: `h3-js` (hexagon grid), `axios`, `helmet`, `express-rate-limit`, `cookie-parser`, `nodemailer` (reset codes); on the phone `expo-sqlite`, `expo-secure-store`, `expo-location`, `expo-task-manager`, `expo-notifications`, `@react-native-community/netinfo`, `react-hook-form`, `react-native-webview`, `react-navigation`.

---

## 3. Module 1: Authentication

**JWT:** a signed token proving who the user is. `POST /login` returns two:
- **Access token, 15 minutes.** Sent on every request as `Authorization: Bearer ...`.
- **Refresh token, 7 days.** Stored in MongoDB and used only to get new tokens.

**Refresh token rotation:** each refresh deletes the old token and issues a new pair. A stolen token that has already been used is refused.

**Password hashing:** `bcrypt.hash(password, salt)` with cost 10, done automatically in a Mongoose `pre('save')` hook. bcrypt is deliberately slow and uses a random salt, so identical passwords hash differently and guessing is expensive.

**Middleware:** `verifyJWT` checks the signature and expiry, loads the user without the password, and sets `req.user`. Protected routes put it first.

**Automatic refresh on the phone (`services/apiClient.js`):** an Axios interceptor catches a 401, refreshes once, and replays the request. Requests arriving during a refresh wait in a queue, so only one refresh runs.

**Token storage:** `expo-secure-store` (Android Keystore, iOS Keychain).

**Role-based access:** `role` is `user` or `admin`. `requireRole('admin')` protects `/api/admin`. Promote with `npm run user:role -- <email> admin`.

| Your question | Answer in the code |
|---|---|
| Multiple devices? | **No, one session.** Each login deletes that user's other refresh tokens. The other device works until its 15-minute token ends, then must log in again |
| Email verification? | **Not built** |
| Forgot password? | **Yes.** 6-digit code, hashed with SHA-256, 15-minute expiry, 5 attempts, single use. A reset signs out all devices. The answer is identical whether or not the email exists (prevents user enumeration). Needs SMTP settings to email the code; without them the code appears in the server log, in development only |
| Social login? | **Not built** |
| Guest mode? | **Not built** |

**Logout** revokes the refresh token on the server and also works offline.

---

## 4. Module 2: User profile

**Stored:** name, phone, email, username, nationality, languages, gender, date of birth, address, profile image URL, blood group, and medical info (allergies, conditions, medications, doctor, organ donor, wheelchair, notes), plus emergency settings.

**Not stored:** age (derived from date of birth) and a tourist/student/professional role (`role` here means access level only).

**What contacts receive during an SOS:** name, map link to the location, GPS accuracy, the time in IST, and the user's custom sentence (up to 120 characters). Medical details are **not** sent by SMS. They are on the Medical ID screen.

**Why short:** an SMS segment is 160 GSM-7 characters or 70 UCS-2 (for example Hindi). `offline/sosMessage.js` counts segments and trims the custom sentence to stay within two.

---

## 5. Module 3: Emergency contacts

- A separate `EmergencyContact` collection linked by user id (one user to many contacts).
- **Maximum 5.**
- Editable: full create, read, update, delete. Other users get a 404.
- **Priority:** a number, and SMS goes in priority order.
- **Primary contact:** an `isPrimary` flag.
- **Validation:** name and relationship required; phone must match `^\+?[\d\s\-()]{7,20}$`.
- **Offline:** `contactsCache` keeps a copy on the phone, so the SOS can text contacts with no internet.

---

## 6. Module 4: SOS engine (your main USP)

### Triggers
| Trigger | Status |
|---|---|
| Manual button (Home, SOS, Map, Journey) | Works |
| Triple volume press | Foreground only, off by default |
| Sticky Android notification shortcut | Works, with a 3-second cancel window |
| High-risk area entry | Only if the user turns it on in Edit Profile. It asks first |
| Shadow Mode (ETA passed) | Automatic. It asks first |

### Flow of a manual SOS
```
Press → write to SQLite outbox FIRST (with a UUID idempotency key)
      → get location (fresh fix for up to 5 s, else last known)
      ├─ Online: POST /api/sos (wait up to 8 s)
      └─ Offline: text contacts from the phone, retry every 20 s for 10 min
Server → validate → one open SOS per user → store → SMS contacts not already texted → push + notification
Screen shows 3 separate facts: queued on phone / SMS sent n of N / delivered to server
```

### Lifecycle
```
pending_confirmation ──(no answer by deadline)──► active ──► cancelled / closed
        │ (user says "I'm safe")
        └──► cancelled + cooldown
```
The deadline `confirmBy` is saved in MongoDB, and a job checks every 5 seconds, so **a server restart loses nothing**.

| Your question | Answer |
|---|---|
| What if no response? | After 60 s the check escalates and contacts are alerted |
| Can the user cancel? | Yes. An unsent SOS is removed from the queue; a delivered one is cancelled on the server; the app offers an "I'm safe" text |
| Duplicate SOS? | Prevented in 3 layers: one idempotency key per press (unique index), one open SOS per user, and the phone's SMS report so the server does not re-text |
| Spam prevention? | 6 create requests per minute per user, 120 general SOS calls per minute, and a 30-minute cooldown within 2 rings of a cancelled cell |
| Does it expire? | Yes, an active SOS closes after 12 hours |
| Late delivery? | Queued more than 120 s: stored with the **original** time plus `lateDelivery: true`. The phone's clock is trusted only up to 48 hours back |
| No contacts? | The server refuses with a clear 400 |

**Idempotency, the key technique:** an action can be sent twice when a response is lost. The phone makes a key once. The server writes `{user, scope, key}` under a unique index before doing the work. A repeat replays the saved answer. If a handler crashed, its "pending" record can be taken over after 60 seconds.

---

## 7. Module 5: Shadow Mode

Shadow Mode is the **server** watching your ETA, so it works even if the phone dies.

| Your question | Answer |
|---|---|
| When does it start? | When a journey starts. It is ON exactly while a journey is active |
| When does it end? | Complete, cancel, or arrival detected |
| ETA extension? | Yes: Update ETA, or "I'm okay" adds 15 minutes (maximum 240) |
| Arrival detection? | Within **100 m** of the destination, with GPS accuracy of **50 m or better**. Haversine distance |
| Inactivity detection? | **Not built.** Only the ETA is watched |
| GPS interval? | Background 30 s / 50 m. Foreground 10 s / 25 m |
| False alarms? | Always asks first, gives 60 s to answer, and extends the ETA on "I'm okay" |

**Flow:** the 5-second job finds active journeys with a passed ETA → creates an "Are you okay?" check (`etaPromptedFor` stops a repeat for the same ETA) → phone shows it by push, or polling every 5 s → no answer in 60 s → escalate to SOS.

**Haversine formula** (distance between two GPS points on a sphere):
```
a = sin²(Δlat/2) + cos(lat1) × cos(lat2) × sin²(Δlng/2)
distance = 2R × atan2(√a, √(1−a)),   R = 6,371,000 m
```

**Background:** `expo-task-manager` plus a foreground service. Not available in Expo Go. The journey screen also syncs location while open, so arrival still works there.

---

## 8. Module 6: Location tracking

| Situation | Accuracy | Time | Distance |
|---|---|---|---|
| Foreground, whole app | High | 10 s | 25 m |
| Background, during a journey | High | 30 s | 50 m |
| Geofence checks sent to the server | | at most every 30 s (5 s if the cell changed) | |
| Stored to the server from the map | | | only after moving 20 m |
| Stored during a journey | | | only after moving 30 m |

**Your question: time-based or movement-based?** Both. An update needs the OS's time and distance rules to pass, so a still phone reports little. That is the battery strategy.

**One watch:** `locationWatcher` runs a single GPS watch and `locationBus` shares it with every feature. Previously the map opened a second watch.

**GPS accuracy:** readings worse than 50 m, or with unknown accuracy, are ignored for geofence and arrival decisions.

**Slow GPS:** `getBestPosition()` returns a position under 2 minutes old at once, otherwise waits up to 8 s for a new fix. Indoors a fix can take minutes, and a screen must not hang.

**Battery use has not been measured.**

---

## 9. Module 7: Safety score (the formula)

### Base score: weighted mean over the data that exists
```
base = Σ(wᵢ × fᵢ × sᵢ) / Σ(wᵢ × fᵢ)
```
`s` = component score 0-100, `w` = weight, `f` = freshness factor.

| Component | Weight | Fresh for | Mode |
|---|---|---|---|
| Crime | 0.40 | 180 days | cell |
| Weather | 0.20 | 90 min | cell |
| Crowd | 0.15 | 12 h | cell |
| Community | 0.15 | 3 h | feed |
| News | 0.10 | 2 h | feed |

**Freshness factor `f`:** 1 when fresh; 0.5 when stale (up to 4 × the fresh window); 0 beyond that.

**Renormalising** is why a missing component is not counted as 0: dividing by the sum of available weights spreads its weight across the others.

**Cell vs feed mode:** a cell-mode score exists only if that cell has it. A feed-mode score defaults to 0 while the feed is healthy, because "nobody reported anything" is a real observation.

### Final score
```
total = clamp(base × timeMultiplier × festivalMultiplier, 0, 100)
```
| Time (IST) | Multiplier |
|---|---|
| 22:00 to 05:00 | × 1.2 |
| 19:00 to 22:00 | × 1.08 |
| 05:00 to 19:00 | × 1.0 |

Festivals: Holi × 1.1, Ganesh Chaturthi × 1.1, Navratri × 1.08, Diwali × 1.1, New Year's Eve × 1.12. Time is a multiplier, not a weighted factor: the clock does not create danger, it amplifies danger that exists.

### Levels
| Score | Level |
|---|---|
| 0-19 | SAFE |
| 20-39 | LOW |
| 40-59 | MODERATE |
| 60-79 | HIGH |
| 80-100 | EXTREME |

### Data confidence
```
confidence = Σ(wᵢ × fᵢ × lowConfidenceFactor × absenceFactor) / Σ wᵢ
```
`lowConfidenceFactor` is 0.5 for flagged or demo data. `absenceFactor` is 0.7 when Community has no reports. **Below 0.35 the level is `UNKNOWN` and the score is null.** HIGH from 0.85, MEDIUM from 0.6. Missing crime always sets `lowConfidence`.

### Worked example (real output for Bandra)
Crime and weather missing; crowd = 65, community = 0, news = 0.
```
base = (0.15×65 + 0.15×0 + 0.10×0) / (0.15 + 0.15 + 0.10) = 9.75 / 0.40 = 24.4  →  LOW
confidence = 0.15 + 0.15×0.7 + 0.10 = 0.355  →  35%, just above the UNKNOWN limit
```
**Right now every cell looks like this,** because crime and weather are missing. Section 16 explains how to fix it.

### How each component is scored

**Crime (`crimePipeline.js`), from a CSV:**
1. Keep rows inside Mumbai with a valid date under 3 years old.
2. `weight = severity × 0.5^(ageDays / 365)` (severity 1-10 by type: murder 10, robbery 8, theft 4).
3. **DBSCAN clustering** with haversine distance, radius 250 m, minimum 4 points. DBSCAN finds dense groups without being told how many exist and labels isolated points as noise. A spatial hash keeps the neighbour search near-linear. Noise still counts, at × 0.35.
4. Spread to neighbours: `ring k gets 0.5^k`, up to ring 2.
5. `score = 100 × min(1, ln(1+raw) / ln(1+p95))`. Log scaling stops a few very bad cells flattening the rest. So the score is **relative to the city**, not absolute.

**Weather (`weatherScore.js`):**
1. **12 sample points** across Mumbai, refreshed every 30 min (576 calls/day), not one per cell.
2. **Piecewise-linear curves** turn each reading into a hazard score. Examples: rain 7.5 mm/h → 45; visibility 1000 m → 50; wind 17 m/s → 50; feels-like 41°C → 50.
3. `score = strongest + 0.3 × second strongest`, capped at 100. Thunderstorm codes set a minimum (tornado = 100).
4. **Inverse Distance Weighting** gives each cell a value from its 3 nearest samples within 15 km:
   `value = Σ(sᵢ / dᵢ²) / Σ(1 / dᵢ²)`

**Crowd (`crowdModel.js`):**
1. Geoapify finds crowd magnets, each with a weight: railway station 45, stadium 40, mall 30, park 8. Cached daily.
2. Spread: `ring k gets 0.5^k`, up to ring 2.
3. Hourly: `raw = Σ units × activity(profile, hour, weekday/weekend)`. Example: a commute place is 1.0 at 07:00-11:00 on a weekday and 0.1 at night.
4. Festival bonus, then `score = 100 × (1 − e^(−raw/60))`.

The formula `1 − e^(−x/k)` appears often here. It is a **saturation curve**: it rises fast at first and flattens toward 100, so more input can never push a score past the maximum.

**News (`newsPipeline.js`):**
1. Fetch NewsData.io every 30 min.
2. **Phrase rules with exclusions and a negation check** ("building fire" counts; "under fire", "fire drill", and "no fire" do not).
3. Find the place: gazetteer of Mumbai localities first, then geocoding. No location means no contribution; there is no city-wide score.
4. `value = severity × 0.5^(ageHours / 6)` (× 0.8 if the place appeared only in the body). Older than 24 h is ignored.
5. The cell gets full weight and its 6 neighbours half. `score = 100 × (1 − e^(−raw/35))`.

**Community (`communityScoring.js`):**
```
weight = severity × timeDecay × verification × falsePenalty × reporterFactor
timeDecay    = (expiresAt − now) / (expiresAt − createdAt)
verification = 0.5 + 0.5 × min(1, confirmations / 3)
falsePenalty = max(0, 1 − 0.25 × falseReports)        (removed at 5)
reliability  = (confirmed + 2) / (confirmed + rejected + 4)      new user = exactly 0.5
reporterFactor = 0.6 + 0.8 × reliability                         new user = exactly 1.0
score = 100 × (1 − e^(−raw/60))
```
Reliability is a **Beta prior**: pretending each user starts with 2 good and 2 bad reports stops one report swinging their standing. One user can add at most 40 points per cell. Only reports confirmed by 2+ others spread (ring 1 × 0.5, ring 2 × 0.25). Severity runs from street light 5 to fire 50. A same-user duplicate within 100 m and 30 min gets a 409; another user's matching report becomes a confirmation.

**Your weightage question:** weights are design choices, not trained or validated. Say that to evaluators. A learned model would need real incident outcomes.

**Not in the formula:** connectivity, nearby help and road conditions, which your notes listed. Disaster alerts appear only through news keywords and weather codes.

---

## 10. Module 8: Maps

### What went wrong, and the fix
The app used `react-native-maps`, which on Android needs a **Google Maps key built into the app**. No key exists on this project, so the map came up blank or could fail on start. An earlier offline setting also blanked the base map whenever the backend was unreachable. Fixing this with Google requires a Google Cloud account with billing and a rebuild.

**The fix: Leaflet + OpenStreetMap in a WebView.** No key and no billing, and it works in Expo Go.

```
MapComponent.jsx   same props as before, so both map screens barely changed
      │  JSON messages both ways (injectJavaScript / postMessage)
      ▼
map/mapHtml.js     one HTML page containing Leaflet inline
      ├─ Base: OpenStreetMap → HOT style if that fails → a plain note if both fail
      ├─ Satellite: Esri imagery with place labels
      └─ One canvas draws all hexagons, so thousands stay smooth
```
- **Leaflet is inline, not from a CDN,** so the map starts with no internet.
- **Offline:** the WebView cache (`LOAD_CACHE_ELSE_NETWORK`) keeps tiles already seen. There is no guarantee an area was seen, and no "download tiles" feature. Risk cells and pins draw with no tiles at all.
- **Security:** report text from other users goes in via `textContent` only, tested with an XSS string.
- **A trap found in testing:** CARTO's free tiles now return HTTP 200 with an "API KEY REQUIRED" watermark, so no error fires. Check any new tile source by eye.
- OpenStreetMap's servers are volunteer-run with a usage policy, fine for a project. A real launch needs a paid or self-hosted tile source.

### Your questions
| Question | Answer |
|---|---|
| Offline maps? | Partly: seen tiles, plus SQLite risk cells and places |
| Nearby hospitals, police? | Yes, plus pharmacies and fire stations. Geoapify → Overpass → stale cache → seed → "unavailable", cached 24 h per H3 resolution 8 cell |
| Routing? | Yes, new. OpenRouteService walk or drive. No answer means a dashed straight line, labelled as such |
| Risk zones? | Yes: hexagons load around the camera as you pan, from 1.5 to 6 km radius |
| Geocoding? | Geoapify autocomplete through the server, then the phone's geocoder |
| Reverse geocoding? | Phone geocoder |

**Route risk (new):** points are sampled every 100 m along the route (a cell edge is about 175 m, so no cell is skipped), converted to unique H3 cells, and evaluated together. The app then says, for example: "Passes through 1 high-risk area". Cells with no data count as unknown, never as safe.

**H3:** Uber's hexagon grid. Hexagons suit this because all 6 neighbours are the same distance away, which makes "spread to neighbours" simple. `h3.latLngToCell(lat, lng, 9)` is the core call; `gridDisk` gives neighbours.

---

## 11. Module 9: Geofencing

### Polygon, circle, or GeoJSON?
**Polygons, as an H3 hexagon grid.** Each `GridCell` stores GeoJSON:
```json
{ "h3Index": "89608b0b13bffff",
  "geometry": { "type": "Polygon", "coordinates": [[[72.82, 19.05], ...]] },
  "center": { "lat": 19.05, "lng": 72.82 } }
```
GeoJSON order is `[lng, lat]`. `h3.cellToBoundary` returns `[lat, lng]`, so the code swaps them. There is a `2dsphere` index on `geometry`. The grid comes from `h3.polygonToCells(MUMBAI_BOUNDARY, 9, true)` in `generateH3Grid.js`.

**The check is a lookup, not point-in-polygon:** `h3.latLngToCell(lat, lng, 9)` directly gives the cell id, so the work is constant time however many zones exist. That is the main benefit over testing a point against thousands of polygons.

### Where danger zones come from
**There is no fixed list of danger zones.** A cell is "danger" when its live score reaches 60 (HIGH or EXTREME), so zones move with crime, weather, crowds, news and reports.

| Your question | Answer |
|---|---|
| Government APIs? | No |
| Static dataset? | Crime only (CSV) |
| Admin upload? | No upload screen. Crime is loaded by a script |
| How often updated? | Weather 30 min, news 30 min, crowd 1 h (places daily), community immediately after a report, crime when the script is run. The score itself is calculated on every read |

### The state machine
GPS jumps around. Without protection, standing near a border would produce an alert every few seconds. So entering requires evidence:
```
       danger reading                 3 readings or 60 s
 SAFE ───────────────► ENTERING ─────────────────────────► IN_DANGER
   ▲                      │ safe reading                      │ safe reading
   │                      └──────────► back to SAFE           ▼
   │        3 readings or 90 s                             EXITING
   └──────────────────────────────────────────────────────────┘
                     danger reading: back to IN_DANGER
```
| Technique | Value | Why |
|---|---|---|
| **Dwell** | 3 readings, or 60 s with at least 2 readings | One bad reading cannot trigger an alert |
| **Hysteresis** | Enter at ≥ 60, leave only below 52 | A score of 55 changes nothing, so no flapping |
| **Accuracy filter** | Ignore readings worse than 50 m | Bad GPS is not evidence |
| `UNKNOWN` | Never danger | Missing data must not raise an alarm |
| Old events | Over 10 min old: history only | A late upload never starts a prompt |
| Future timestamps | Over 60 s ahead: rejected | Wrong phone clock |

### Reliability
- **Compare-and-set:** the state saves only if `lastReadingAt` has not changed since it was read, so two simultaneous requests cannot both advance. One retry, then 409.
- **Replay:** `geofenceReplay` sorts readings by time and removes duplicates, so an offline batch gives the same result as live readings.
- **Same code on phone and server:** `shared/deviceCore.js` is copied byte-for-byte to the app. A test fails if the copies differ. Offline, the phone runs the same state machine against its SQLite cells.

### After entering
`evaluatePrompt` decides. No prompt if: already handled this episode, the reading is stale, the setting is off, an SOS is already open, or a cooldown is active. **This setting is off by default.** A user gets a banner either way, but "Are you safe?" appears only after turning on *Ask if I am safe when I enter a high-risk area* in Edit Profile. Demo tip: turn this on first.

---

## 12. Module 10: AI assistant

**`POST /api/assistant/chat`, Gemini, rate limited to 10 per minute and 60 per hour.**

| Should the AI know... | Answer |
|---|---|
| Current location? | Yes, with its H3 cell |
| Weather? | Yes |
| Safety score? | Yes, with confidence and the top factor |
| Nearby hospitals? | Yes, nearest hospital, police, pharmacy, fire |
| Destination? | **Only the ETA** of the active journey, not the destination |
| History? | Recent chat turns, trimmed. Kept on the phone, never logged on the server |

Also included: nearby community reports and connectivity state.

**Prompt engineering (`prompt.js`, `sanitize.js`):**
- **Grounding:** the answer must come from the context given.
- **Prompt injection defence:** user text is sanitised and passed as quoted JSON data, not as instructions.
- **Fabrication check:** phone numbers in an answer are checked. If invented, the rule-based answer replaces it.
- **Proposals only:** the AI can suggest a community report but never files one. The user taps Confirm.
- **Fallback:** missing key, timeout (12 s), or a failed check gives a rule-based answer from `shared/assistantRules.js`, the same rules the phone uses offline. The label says which it was.

**Context window:** only relevant data and trimmed history are sent, to control cost and latency.

**Right now there is no Gemini key, so it answers from rules.**

---

## 13. Module 11: Notifications

**Expo Push**, plus in-app records in MongoDB. Tokens are saved per device by `POST /api/notifications/token`.

| Your type | Status |
|---|---|
| SOS | Yes (`SOS`) |
| Shadow Mode | Yes (`SAFETY_CHECK`, `JOURNEY`) |
| Route warning | In-app on the journey screen only, not a push |
| Weather | **No push** |
| Government alert | **No** |

**Background reliability:** remote push does not work in Expo Go (SDK 53+). So the "Are you safe?" check also polls `GET /api/sos/pending` every 5 s while the app is open. Android channels and locked-screen behaviour have not been tested on a device.

---

## 14. Module 12: Connectivity engine (major USP)

### The pattern
```
Action → write to SQLite outbox (with idempotency key)
       → ONLINE? send now
       ├─ success: mark sent
       └─ failure: retry later with backoff
Runner: on going online, on foreground, every 30 s, after queueing; never while OFFLINE
```

### Three states, not two
- **ONLINE**
- **WEAK:** connected, but a request failed or was slow, a ping failed once, or the link is 2G
- **OFFLINE:** no network, or 2 failed pings

Inputs: NetInfo, `GET /api/health` (30 s, or 10 s when degraded, 4 s timeout), and real request outcomes. **Debouncing:** a worse state must last 3 s and a better one 5 s, so the status does not flicker.

### Outbox
- Table `outbox`, with types `sos`, `sos_cancel`, `journey_update`, `geofence_event`, `community_report`, `location_point`.
- **Status:** pending → sending → sent / failed / dead.
- **Priority:** SOS first, location points last; oldest first within a type.
- **Exponential backoff with jitter:**
  `delay = min(15 min, 5 s × 2^(attempts−1)) × (0.75 to 1.25)`
  Jitter stops all phones retrying at the same moment.
- **Retry limits:** SOS never gives up; others stop after 12 tries.
- **Errors:** network, 5xx, 408, 429 retry. Other 4xx is `dead` (no point retrying). 401 waits without counting an attempt.
- **Batches:** 100 at a time. A bad item is found by **splitting the batch** repeatedly.
- **Cap:** 3,000 rows, dropping oldest location points first. SOS is never dropped.
- **Crash recovery:** rows stuck in `sending` for 2 minutes reset to pending.
- **Ownership:** rows are tagged with the user, so one account's queued SOS can never upload under another.

### Conflict resolution
No general merge is needed, because the records are events, not shared documents:
- Repeats are handled by idempotency keys.
- Risk data is server-authoritative; the phone's copy is a read-only cache.
- Geofence: the phone's events are stored as history and never start a server prompt if old.

### Offline risk cache
SQLite stores regions: current 3 km, destination 2 km, manual 2/5/10 km. Fresh for 6 h, usable for 7 days, 30,000 rows with oldest-first eviction. Each row stores `baseRisk`, so the phone re-applies the time multiplier itself. A missing cell means "no data", never safe.

### New in this round
Opening the app with no signal used to **log the user out**, because any failure of the session check cleared the tokens. Now only a real 400 or 401 from the server ends a session. The cached user is used and refreshed when the server answers.

---

## 15. Database, API, flows, failures, security, deployment, logging, testing

### Step 2: Collections
| Collection | Holds | Key indexes |
|---|---|---|
| User | Account, profile, medical, settings | unique email, username |
| RefreshToken | Active refresh tokens | token |
| EmergencyContact | Up to 5 per user | user |
| Location | GPS history | unique (userId, idempotencyKey) |
| Journey | Trips, ETA, status | (userId, status), expectedArrivalTime, 2dsphere |
| SOSHistory | All SOS and checks | unique (user, idempotencyKey), (status, confirmBy) |
| GridCell | 11,449 hexagons with raw scores | unique h3Index, 2dsphere, center |
| FeedStatus | Last success of each feed | key |
| UserGeofenceState | State machine per user | unique userId |
| GeofenceEvent | Enter/exit history | unique (userId, idempotencyKey) |
| Incident, IncidentConfirmation, FalseIncidentReport | Community | |
| Notification, DeviceToken | Alerts, push tokens | |
| NearbyCellCache, NearbyPlace, PoiCache, GeocodeCache | Provider caches | |
| IdempotencyRecord | Replay store | unique (user, scope, key), TTL |

Your planned `SafetyScores`, `WeatherCache` and `DangerZones` collections do not exist, on purpose: scores are computed on read, and danger is a property of cells.

### Step 3: API
| Base | Endpoints |
|---|---|
| `/api` | `GET /health`, `GET /config/client` |
| `/api/auth` | `POST /signup /login /refresh-token /logout /forgot-password /reset-password`, `GET /me` |
| `/api/profile` | `GET /`, `PUT / /medical /settings`, `GET /completeness`, `DELETE /image` |
| `/api/contacts` | CRUD |
| `/api/location` | `POST / /batch`, `GET /latest` |
| `/api/journey` | `POST /start /update/:id /end/:id`, `GET /status /history` |
| `/api/sos` | `POST /`, `GET /pending /active /history`, `POST /:id/confirm /:id/cancel` |
| `/api/geofence` | `POST /check /sync /events`, `GET /status /history` |
| `/api/risk` | `GET /location /live /cells /cell/:h3` |
| `/api/nearby` | `GET /` |
| `/api/places` | `GET /search /route` |
| `/api/community` | `POST /report`, `GET /categories /nearby /my-reports /:id`, `POST /:id/confirm /:id/report-false` |
| `/api/assistant` | `POST /chat` |
| `/api/notifications` | `GET /`, `POST /token` |
| `/api/weather`, `/api/crowd` | `GET /`, `GET /score` |
| `/api/admin` | `GET /risk/debug` (admin) |

### Step 6: What if...
| Failure | What happens |
|---|---|
| GPS unavailable | Last known position, screens keep working, the SOS says location is unknown rather than inventing one |
| Internet lost | Outbox queues, SMS goes direct, cached risk, offline assistant |
| Maps tiles fail | OSM → HOT → note; cells and pins still draw |
| Gemini down | Rule-based answer, labelled |
| Weather API timeout | Old value ages and is flagged stale, then dropped; confidence falls |
| MongoDB disconnected | Mongoose errors return 500. The phone keeps retrying with backoff. **Startup fails if Mongo is unreachable** |
| Duplicate SOS | Idempotency key plus one open SOS per user |
| User closes the app | Outbox stays in SQLite; server keeps ETA deadlines |
| Phone battery dies | **Shadow Mode still escalates, because the deadline is on the server** |
| Shadow Mode timer killed | There is no phone timer to kill |
| Server restarts | Deadlines are in MongoDB, and the 5 s job resumes |

### Step 7: Security
| Item | Status |
|---|---|
| JWT expiry | 15 min / 7 days |
| Refresh rotation | Yes |
| Rate limiting | 600 per IP per 15 min; auth 20 per 15 min; per-user limits on SOS, risk, nearby, geofence, community, assistant, places |
| Helmet | Yes |
| CORS | Open in development; `CLIENT_ORIGIN` list in production |
| Input validation | Yes, on every route with input. Body limit 16 KB |
| Password hashing | bcrypt, cost 10 |
| XSS | JSON API; map page uses `textContent` |
| NoSQL injection | Validators check types on most routes. **No dedicated sanitiser** such as a `$`-key filter. Login's fields are type-checked |
| HTTPS | **Development is plain HTTP.** Must run behind TLS in production |
| Location encryption | Atlas encrypts at rest and in transit. No extra field-level encryption |

**Before production:** set `usesCleartextTraffic` to false in `app.json` (I turned it on so an APK can reach a development server over HTTP), and rotate any key that has ever been shared.

### Step 8: Deployment
**Nothing is deployed, and there is no Dockerfile, PM2 or NGINX config.** Simplest path: Render or Railway running `npm start`, Atlas already exists, set the environment variables and `CLIENT_ORIGIN`, then build the APK with `EXPO_PUBLIC_API_URL` set. Run a single instance: rate limit counters are in memory and schedulers would run twice on two.

### Step 9: Logging
| Log | Status |
|---|---|
| API | Morgan, development only |
| Errors | Custom logger to stderr, and central error middleware |
| SOS / notifications | Stored in `SOSHistory.metadata` and `Notification` |
| Locations | `Location` collection |
| AI | Metadata only (source, latency, failure code). Message text is never logged |

No log files or rotation; the custom logger writes to stdout and stderr.

### Step 10: Testing
| Layer | Tool | Result now |
|---|---|---|
| Backend unit | `node --test` | **226 pass** |
| Frontend logic | `node --test` | **95 pass** |
| API end to end | Temporary script on a throwaway MongoDB (not in the repo) | **90 of 90 pass** |
| Map page | Real browser | Tiles, hexagons, tap events, satellite, XSS |
| App in a browser | Expo web build | Login, Home, Map, tap a zone, search, route, start a journey |
| Android bundle | `expo export` | Builds |
| **On a real phone** | | **Not done. See section 16** |

No Jest or Supertest; Node's built-in test runner replaces them.

---

## 16. Honest gaps

### Needs you
1. **No crime data, the biggest gap.** `preprocessing/crime_clean.csv` has 2,496 rows but only **2 fall inside Mumbai**. Its coordinates are scattered across India ("Saket" and "Connaught Place" are Delhi). `npm run crime:build` correctly refuses to write it. Options: find real Mumbai data, or set `USE_DEMO_CRIME_DATA=true`, which fills cells with demo values labelled "demo" in the app.
2. **News key does not look like NewsData.io's.** `.env` has `NEWS_API_KEY`, but the code reads `NEWSDATA_API_KEY`, whose keys normally start `pub_`. I did not rename it. Check which service it is for.
3. **No Gemini key.** Add `GEMINI_API_KEY` and `GEMINI_MODEL`, or the assistant stays rule-based.
4. **Weather key.** The code now accepts `OWM_API_KEY`, but the key itself has not been tested. Restart the backend and run `npm run demo:check`.
5. **Routing and place search keys** also have not been called with your real keys; the fallbacks were tested.
6. **Email:** add `SMTP_*` to email reset codes.

### Never run on a real phone
Tested here by unit tests, API tests, and a browser build, but **not** on a device: the WebView on Android, the Kotlin SMS module (never compiled), SQLite migrations on `expo-sqlite`, push, background tracking, the volume trigger. Test these first. On the browser build, buttons that use `Alert` confirmation (end journey, cancel SOS) could not be exercised, since `Alert` is mobile-only. The API behind them passed.

### Not built
Email verification, social login, guest mode, multi-device sessions, Socket.IO, FCM, Cloudinary upload, inactivity detection, weather and government push alerts, downloadable offline tiles, fall detection, a user-to-user location chat. Deployment config.

### Known limitations
- Coverage is **Mumbai only**. Elsewhere the map says so.
- Play Store restricts `SEND_SMS`, so this is for sideloading.
- Weights are design choices, not validated.
- iPhone always needs a tap on Send.
- Airplane mode blocks SMS too, so offline SOS cannot be guaranteed.
- No dedicated NoSQL sanitiser.

---

## 17. How to run

```bash
# Backend (terminal 1)
cd backend
npm install
npm start
```
```bash
# App (terminal 2)
cd frontend
npm install
npx expo start
```
Then scan the QR code with **Expo Go** on a phone on the same Wi-Fi. If the app cannot reach the server, allow port 5001 through Windows Firewall.

**If you use a development build instead of Expo Go, you must rebuild it**, because the map now uses `react-native-webview`:
```bash
eas build --profile development --platform android
```

**Check readiness any time (read-only):**
```bash
cd backend
npm run demo:check
```
