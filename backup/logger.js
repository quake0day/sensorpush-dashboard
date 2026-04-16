// Sensor logger — polls the running server's /api/sensors endpoint and
// writes readings to local SQLite. Started from server.js.

const db = require("./lib/db");

const POLL_INTERVAL_MS = 5 * 60 * 1000;

let timer = null;

async function fetchSensors(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`sensors endpoint returned ${res.status}`);
  return res.json();
}

async function pollOnce(url) {
  try {
    const sensors = await fetchSensors(url);
    if (!sensors || typeof sensors !== "object") return;
    const now = Date.now();
    const stmt = db.get().prepare(`
      INSERT OR IGNORE INTO sensor_readings
        (sensor_id, timestamp, temperature_f, humidity, pressure_inhg,
         dewpoint_f, vpd, battery_v, rssi, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `);
    let inserted = 0;
    const tx = db.get().transaction((rows) => {
      for (const r of rows) {
        const info = stmt.run(
          r.sensor_id, r.timestamp, r.temperature_f, r.humidity,
          r.pressure_inhg, r.dewpoint_f, r.vpd, r.battery_v, r.rssi
        );
        if (info.changes > 0) inserted++;
      }
    });
    const rows = [];
    for (const s of Object.values(sensors)) {
      if (!s.last_update) continue;
      const ts = new Date(s.last_update).getTime();
      if (!Number.isFinite(ts)) continue;
      rows.push({
        sensor_id: s.id,
        timestamp: ts,
        temperature_f: s.temperature ?? null,
        humidity: s.humidity ?? null,
        pressure_inhg: s.barometric_pressure ?? null,
        dewpoint_f: s.dewpoint ?? null,
        vpd: s.vpd ?? null,
        battery_v: s.battery_voltage ?? null,
        rssi: s.rssi ?? null,
      });
    }
    tx(rows);
    if (inserted > 0) {
      console.log(`[sensor-logger] wrote ${inserted} new reading(s) at ${new Date(now).toISOString()}`);
    }
  } catch (e) {
    console.error("[sensor-logger] poll failed:", e.message);
  }
}

function start(url) {
  if (timer) return;
  db.applySchema();
  // Delay first poll to let the server finish booting.
  setTimeout(() => pollOnce(url), 10000);
  timer = setInterval(() => pollOnce(url), POLL_INTERVAL_MS);
  console.log(`[sensor-logger] started, polling ${url} every ${POLL_INTERVAL_MS/1000}s`);
}

module.exports = { start, pollOnce };
