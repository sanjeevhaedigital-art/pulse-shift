// Minimal .env loader (no extra dependency) + defaults
const fs = require("fs");
const path = require("path");
const file = path.join(__dirname, "..", ".env");
if (fs.existsSync(file)) {
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
// Follow-up times and shift checks use this zone
process.env.TZ = process.env.TZ || "Asia/Dubai";
