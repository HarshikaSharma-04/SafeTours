# SafeTours: 5-minute demo runbook

Four goals shown in this order: **risk accuracy, nearby help, offline, community + assistant.**
Everything below uses features that exist in the code. If a step is not on the phone, it is not in this runbook.

Run `npm run demo:check` (in `backend/`) the day before and again 15 minutes before. Do not start the demo unless it says READY or READY WITH DEMO DATA.

---

## A. Before the audience arrives (about 20 minutes, once)

| # | Do this | Why |
|---|---|---|
| 1 | In `backend/.env` set `OPENWEATHER_API_KEY`, `GEOAPIFY_API_KEY`, `NEWSDATA_API_KEY`, `GEMINI_API_KEY`, `GEMINI_MODEL` (check the model name on https://ai.google.dev/gemini-api/docs/models) | The assistant and live feeds need them |
| 2 | Crime data: either `npm run crime:build -- <your file>.csv` (real) **or** set `USE_DEMO_CRIME_DATA=true` (demo, labelled "demo" in the app) | With no crime scores every area shows UNKNOWN |
| 3 | `npm run create:indexes` (dry run), then `npm run create:indexes -- --apply` | Dedupe and one-SOS-per-key rely on these indexes |
| 4 | `npm start` and leave it running 10 minutes | The weather, crowd and news jobs fill the cells on a timer |
| 5 | `npm run demo:check` until the verdict is not NOT READY | Read the table: it shows what the audience will see |
| 6 | Install the **development build** (not Expo Go) on phone A (yours) and phone B (a second person's) | SMS module, SQLite, volume module are native |
| 7 | Phone A: log in, grant location (while using, then always), notifications, and SMS when asked | |
| 8 | Phone A: add one emergency contact whose number is **phone B's**. Say yes to the SMS permission prompt | Real SMS will be sent in step 3 |
| 9 | Phone A: Settings, "Offline Mode" off. Open Home and wait for the risk card and Nearby card to load | Fills the on-device caches |
| 10 | Phone A: Settings → "Download this area" → 5 km → Download. Wait for "Saved ... risk cells" | The offline step depends on this |
| 11 | Phone A: Assistant tab → trash icon (clear chat) | Clean start |
| 12 | Phone B: log in with a different account | Needed for the community confirmation |
| 13 | Both phones on the same Wi-Fi or mobile data, battery above 50 % | |

Stand at the demo location (or use the destination search on the Map tab if GPS will not lock indoors).

---

## B. The 5-minute script

### 1. Risk accuracy (0:00 to 1:30)

1. **Home tab.** Point at the **Area Safety** card: level, score out of 100, "Main factor", **Data confidence**, and the line "Risk data updated just now".
2. Say what the label means. If crime is demo data the **demo badge** and "Includes demo data" are visible: read that out loud.
3. Scroll to **Safety tips for here**: 2 to 3 tips written from the real data (no AI call). Tap one: it opens the assistant (go back).
4. **Map tab.** Coloured hexagons are risk cells. Tap one: the chips show **Crime, Weather, Crowd, Community, News**, the **time-of-day multiplier**, and data confidence. Point at "no reports" on Community.

**What the audience should see:** five separate factors, a confidence number, demo and missing-data labels, and no invented numbers.

**If it fails**
- *Everything says UNKNOWN or "not enough data":* the feeds have not run or crime is empty. Say so plainly (that is the system refusing to guess), then use a cell that has data, or switch to the destination search below.
- *GPS will not lock:* on the Map tab use the **search box** to look up a Mumbai place name; the app shows the destination's risk.
- *Server unreachable:* turn Offline Mode on (step 3) and carry on: Home and Map will show cached cells.

### 2. Nearby help (1:30 to 2:30)

1. **Home tab → Nearby card:** nearest hospital, police, pharmacy, fire station with distance and open/closed when known.
2. Tap a hospital: call or directions options appear.
3. **Map tab:** use the type chips (Hospital, Police, ...) to show pins.

**What the audience should see:** real named places with distances, a "source" and age, and no invented phone numbers.

**If it fails**
- *Provider slow or down:* the card says "Offline data, updated X ago" and shows the saved places. That is the fallback working; point at the label.
- *Empty list:* it says "unavailable". Say that the app prefers saying nothing to inventing a hospital, and call 112 is always shown.

### 3. Offline and SOS (2:30 to 4:00)

1. Settings (tab or menu) → switch **Offline Mode** on. Go back to Home: the chip turns **OFFLINE** and the card says "Offline check · Risk data updated X ago".
2. **Map tab:** cells and nearby pins are still there. The base map shows only tiles this phone has already loaded: say that tiles cannot be downloaded in advance.
3. **SOS tab → press the SOS button.** Show the status card, three separate facts: **Queued on this phone / SMS sent n/N / Delivered to server**. The red "SOS pending" banner appears on every screen.
4. Phone B receives the text with a map link and the time in IST. Show it.
5. Turn Offline Mode **off** on phone A. Within about 30 seconds the card changes to **Delivered to the server** and the banner goes away.
6. Tap **Cancel this SOS** and show the "Send an I'm safe text?" prompt.

**What the audience should see:** the app never says "sent" for something that only reached the local queue; the text arrives without internet; the upload happens by itself when the connection returns.

**If it fails**
- *SMS permission was denied or the phone has no SIM:* the messaging app opens with the text ready (the card says "tap Send"). Tap Send on stage. Say that iPhones always work this way.
- *No text arrives on phone B:* the card still shows what is true (queued / not sent). Show the **Upload queue** in Settings and say that the SOS is saved and will upload.
- *"Offline Mode" is only a test switch:* for a real check, also turn on airplane mode; but remember airplane mode blocks the text too.

### 4. Community and assistant (4:00 to 5:00)

1. **Phone B:** Map tab → menu → **Community Feed** → report an incident (for example Harassment, at least 5 characters). Phone A: open the same panel and **Confirm** it.
2. **Phone A, Map tab:** the Community chip on the cell now shows a score and "n report(s)".
3. **Assistant tab (online):** tap **"Is this area safe?"**. Show the **AI** label, the answer using the real level and top factor, and the line about data quality.
4. Type: *"There's harassment near the bus stop."* A **report card** appears. Say: "Nothing is filed until I tap Confirm." Tap **Not now** (or **Confirm and report** if you want to show it).
5. Turn Offline Mode on and ask **"Nearest hospital"**. The label becomes **Offline assistant** and the answer says it uses data saved on the phone.

**What the audience should see:** the community score reacts to real reports and confirmations, the assistant quotes real data, labels where an answer came from, and cannot act on its own.

**If it fails**
- *Gemini down, no key or slow:* the reply is labelled **Offline assistant** with a one-line reason. Say that this is by design.
- *The report was refused as a duplicate:* "You already reported this nearby" (same account) means it works; use phone B for the report and phone A for the confirmation.
- *Community chip still shows no reports:* wait about 10 seconds and re-open the cell; the score is recalculated right after a report or confirmation.

---

## C. Reset between runs (1 minute)

1. Phone A: Assistant tab → trash icon. Settings → Upload queue → **Clear uploaded**.
2. Phone A: SOS tab → cancel any SOS still showing.
3. Make sure Offline Mode is **off**.
4. Optionally `npm run demo:check` again.

---

## D. What to say, honestly

- **Crime data:** "This build uses [real crime data for ... / demo data, labelled in the app]." Never call a demo-based level a measurement.
- **Risk score:** a weighted decision aid from five signals; the weights are design choices, not validated predictions.
- **SMS:** Android sends directly after the user allows it and reports what the radio confirmed. iPhone always needs a tap on Send. With no cell service a text cannot be forced out; the SOS is saved and retried.
- **Play Store:** the SMS-sending permission is restricted by Google; this build is for sideloading or internal testing.
- **Offline maps:** risk cells and nearby places are available offline. The base map (OpenStreetMap) shows only tiles already seen on this phone.
- **Assistant:** answers only from your live app data, says when data is missing or sample, cannot file anything without your tap, and falls back to rules when the AI is unavailable.

---

## E. Quick troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Every level is UNKNOWN | Crime empty or feeds never ran | Step A2 and A4, then `npm run demo:check` |
| Assistant always says "Offline assistant" | No `GEMINI_API_KEY`, wrong `GEMINI_MODEL`, or quota | Run `npm run demo:check` and read the Gemini line |
| SOS card says "SMS not sent" | No SMS permission or no SIM | Settings → SMS permission → Grant, or use the composer |
| "Delivered to server" never appears | Still offline, or signed out | Check the chip on Home; sign in again |
| Nearby empty | Provider down and nothing cached | Open Home online once before going offline |
| Duplicate report refused | Same account, same place, within 30 minutes | Use the second account |
