const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
require("./config/envAliases");

console.log("1. Environment loaded");

const app = require("./app");
console.log("2. App loaded");

const connectDB = require("./config/db");
console.log("3. DB module loaded");

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    console.log("4. Connecting to MongoDB...");
    await connectDB();

    console.log("5. MongoDB connected");

    // Crime component: seed/clear DEMO crime data according to USE_DEMO_CRIME_DATA (default off).
    // Real data comes from `npm run crime:build -- file.csv` and always wins over demo.
    const { syncDemoCrimeState } = require('./services/crime/crimeDemo.service');
    await syncDemoCrimeState().catch((err) => console.error('Demo crime sync failed:', err.message));

    // Start community incident expiry scheduler background job
    const { startExpiryScheduler } = require('./scheduler/communityExpiryJob');
    startExpiryScheduler();

    // Start news risk scheduler background job
    const { startNewsScheduler } = require('./scheduler/newsScheduler');
    startNewsScheduler();

    // Safety scheduler: escalates expired "Are you safe?" checks and enforces Shadow Mode ETAs.
    // Deadlines are persisted in MongoDB, so this resumes correctly after a restart.
    const { startSafetyScheduler } = require('./scheduler/safetyScheduler');
    startSafetyScheduler();

    // Crowd producer: Geoapify places cached daily, crowd score recomputed hourly (IST time rules).
    const { startCrowdScheduler } = require('./scheduler/crowdScheduler');
    startCrowdScheduler();

    // Weather producer: one OpenWeather request per ~8 km region, written to every cell in it.
    const { startWeatherScheduler } = require('./scheduler/weatherScheduler');
    startWeatherScheduler();

    const server = app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.error(`\n❌ Port ${PORT} is already in use by another process.`);
        console.error(`   Run: lsof -iTCP:${PORT} -sTCP:LISTEN  to see what is using it.`);
        console.error(`   Then change PORT in your .env file to a free port (e.g. 5001, 8080).\n`);
      } else {
        console.error("Server error:", err);
      }
      process.exit(1);
    });
  } catch (err) {
    console.error("Startup failed:", err);
    process.exit(1);
  }
};

startServer();