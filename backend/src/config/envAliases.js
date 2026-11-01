/**
 * Other names this project's .env files have used for the same key. The code reads one canonical name; loading this
 * right after dotenv means a key saved under the older name still works. A canonical value always wins.
 */
const ALIASES = { OPENWEATHER_API_KEY: ['OWM_API_KEY'] };

for (const [name, others] of Object.entries(ALIASES)) {
  if (process.env[name]) continue;
  const found = others.find((other) => process.env[other]);
  if (found) process.env[name] = process.env[found];
}
