require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/garden", express.static(path.join(__dirname, "garden")));

// ============ SensorPush ============
const SP_BASE = "https://api.sensorpush.com/api/v1";
const SP_EMAIL = process.env.SENSORPUSH_EMAIL;
const SP_PASSWORD = process.env.SENSORPUSH_PASSWORD;

let spToken = null;
let spTokenExpiry = 0;

async function spPost(endpoint, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = token;
  const res = await fetch(`${SP_BASE}${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`SP ${endpoint} failed (${res.status})`);
  return res.json();
}

async function getSpToken() {
  if (spToken && Date.now() < spTokenExpiry) return spToken;
  const auth = await spPost("/oauth/authorize", { email: SP_EMAIL, password: SP_PASSWORD });
  const tok = await spPost("/oauth/accesstoken", { authorization: auth.authorization });
  spToken = tok.accesstoken;
  spTokenExpiry = Date.now() + 11 * 3600000;
  console.log("SensorPush token refreshed");
  return spToken;
}

// ============ Tuya ============
const TUYA_ID = process.env.TUYA_ACCESS_ID;
const TUYA_SECRET = process.env.TUYA_ACCESS_SECRET;
const TUYA_BASE = process.env.TUYA_BASE_URL || "https://openapi.tuyaus.com";

let tuyaToken = null;
let tuyaTokenExpiry = 0;

function tuyaSign(token, t, method, path, body) {
  const contentHash = crypto.createHash("sha256").update(body || "").digest("hex");
  const stringToSign = [method, contentHash, "", path].join("\n");
  const signStr = TUYA_ID + (token || "") + t + stringToSign;
  return crypto.createHmac("sha256", TUYA_SECRET).update(signStr).digest("hex").toUpperCase();
}

async function tuyaRequest(method, apiPath, token) {
  const t = Date.now().toString();
  const sign = tuyaSign(token, t, method, apiPath, "");
  const headers = { client_id: TUYA_ID, sign, t, sign_method: "HMAC-SHA256" };
  if (token) headers.access_token = token;
  const res = await fetch(`${TUYA_BASE}${apiPath}`, { method, headers });
  return res.json();
}

async function getTuyaToken() {
  if (tuyaToken && Date.now() < tuyaTokenExpiry) return tuyaToken;
  const data = await tuyaRequest("GET", "/v1.0/token?grant_type=1");
  if (!data.success) throw new Error(`Tuya token failed: ${data.msg}`);
  tuyaToken = data.result.access_token;
  tuyaTokenExpiry = Date.now() + (data.result.expire_time - 60) * 1000;
  console.log("Tuya token refreshed");
  return tuyaToken;
}

async function getTuyaDeviceInfo(deviceId) {
  const token = await getTuyaToken();
  return tuyaRequest("GET", `/v1.0/devices/${deviceId}`, token);
}

async function getTuyaDeviceLogs(deviceId, startTime, endTime, codes) {
  const token = await getTuyaToken();
  const params = new URLSearchParams({
    start_time: startTime.toString(),
    end_time: endTime.toString(),
    codes,
    size: "100",
    type: "1,2,3,4,5,6,7,8,9,10",
  });
  return tuyaRequest("GET", `/v1.0/devices/${deviceId}/logs?${params}`, token);
}

// ============ Weather (NWS) ============
const NWS_LAT = "39.957";
const NWS_LON = "-75.603";
const NWS_UA = "SmartGardenDashboard/1.0 (garden-monitor)";

let weatherCache = null;
let weatherCacheTime = 0;

app.get("/api/weather", async (req, res) => {
  try {
    if (weatherCache && Date.now() - weatherCacheTime < 30 * 60 * 1000) {
      return res.json(weatherCache);
    }
    const headers = { "User-Agent": NWS_UA };
    const pointsRes = await fetch(
      `https://api.weather.gov/points/${NWS_LAT},${NWS_LON}`,
      { headers }
    );
    const points = await pointsRes.json();
    const forecastUrl = points.properties.forecast;
    const hourlyUrl = points.properties.forecastHourly;

    const [forecastRes, hourlyRes, sunRes] = await Promise.all([
      fetch(forecastUrl, { headers }),
      fetch(hourlyUrl, { headers }),
      fetch(`https://api.sunrise-sunset.org/json?lat=${NWS_LAT}&lng=${NWS_LON}&formatted=0&date=today`),
    ]);
    const forecast = await forecastRes.json();
    const hourly = await hourlyRes.json();
    const sunData = await sunRes.json();

    weatherCache = {
      location: points.properties.relativeLocation?.properties,
      forecast: (forecast.properties.periods || []).slice(0, 14),
      hourly: (hourly.properties.periods || []).slice(0, 24),
      sun: sunData.results || {},
      updated: new Date().toISOString(),
    };
    weatherCacheTime = Date.now();
    res.json(weatherCache);
  } catch (err) {
    console.error("weather error:", err.message);
    if (weatherCache) return res.json(weatherCache);
    res.status(500).json({ error: err.message });
  }
});

// ============ SensorPush Routes ============
app.get("/api/sensors", async (req, res) => {
  try {
    const token = await getSpToken();
    const sensors = await spPost("/devices/sensors", {}, token);
    const sensorIds = Object.keys(sensors);
    if (sensorIds.length) {
      const samplesData = await spPost("/samples", { sensors: sensorIds, limit: 1 }, token);
      const samplesMap = samplesData.sensors || {};
      for (const [id, samples] of Object.entries(samplesMap)) {
        if (sensors[id] && samples.length > 0) {
          const latest = samples[0];
          sensors[id].temperature = latest.temperature;
          sensors[id].humidity = latest.humidity;
          sensors[id].dewpoint = latest.dewpoint;
          sensors[id].vpd = latest.vpd;
          sensors[id].barometric_pressure = latest.barometric_pressure;
          sensors[id].last_update = latest.observed;
        }
      }
    }
    res.json(sensors);
  } catch (err) {
    console.error("sensors error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/gateways", async (req, res) => {
  try {
    const token = await getSpToken();
    const gateways = await spPost("/devices/gateways", {}, token);
    res.json(gateways);
  } catch (err) {
    console.error("gateways error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/samples", async (req, res) => {
  try {
    const token = await getSpToken();
    const { sensors, startTime, stopTime, limit } = req.body;
    const body = { limit: limit || 500 };
    if (sensors) body.sensors = sensors;
    if (startTime) body.startTime = startTime;
    if (stopTime) body.stopTime = stopTime;
    const data = await spPost("/samples", body, token);
    res.json(data);
  } catch (err) {
    console.error("samples error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============ Pond Alarm Log (server-side tracking) ============
const fs = require("fs");
const POND_LOG_FILE = path.join(__dirname, "pond-alarm-log.json");
let pondLog = [];
let lastPondState = {};

// Load saved log on startup
try {
  if (fs.existsSync(POND_LOG_FILE)) {
    pondLog = JSON.parse(fs.readFileSync(POND_LOG_FILE, "utf8"));
  }
} catch (e) { console.error("Failed to load pond log:", e.message); }

function savePondLog() {
  // Keep only last 7 days
  const cutoff = Date.now() - 7 * 24 * 3600000;
  pondLog = pondLog.filter(e => e.time > cutoff);
  try { fs.writeFileSync(POND_LOG_FILE, JSON.stringify(pondLog, null, 2)); } catch (e) {}
}

function trackPondState(statusArr) {
  const statusMap = {};
  (statusArr || []).forEach(s => statusMap[s.code] = s.value);
  const rightAlarm = statusMap.watersensor_state === "alarm";
  const leftAlarm = statusMap.tamper_alarm === true;

  // Detect state changes
  if (lastPondState.right !== undefined) {
    if (rightAlarm !== lastPondState.right) {
      pondLog.push({ time: Date.now(), probe: "black", code: "watersensor_state", alarm: rightAlarm });
      console.log(`Pond: black probe ${rightAlarm ? "ALARM" : "normal"}`);
    }
    if (leftAlarm !== lastPondState.left) {
      pondLog.push({ time: Date.now(), probe: "white", code: "tamper_alarm", alarm: leftAlarm });
      console.log(`Pond: white probe ${leftAlarm ? "ALARM" : "normal"}`);
    }
    savePondLog();
  }
  lastPondState = { right: rightAlarm, left: leftAlarm };
}

// ============ Tuya Routes (water sensor only) ============
app.get("/api/tuya/devices", async (req, res) => {
  try {
    const devices = [
      { id: "eb4b975ccbbe3fb9dc98n2", type: "water_sensor" },
    ];
    const results = await Promise.all(
      devices.map(async (d) => {
        const info = await getTuyaDeviceInfo(d.id);
        const device = { ...d, ...info.result };
        // Track state changes for pond alarm log
        if (d.type === "water_sensor" && device.status) {
          trackPondState(device.status);
        }
        return device;
      })
    );
    res.json(results);
  } catch (err) {
    console.error("tuya devices error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/pond/logs", (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const cutoff = Date.now() - hours * 3600000;
  const logs = pondLog.filter(e => e.time > cutoff).sort((a, b) => b.time - a.time);
  res.json({ logs });
});

app.get("/api/tuya/device/:id/logs", async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const codes = req.query.codes || "watersensor_state";
    const endTime = Date.now();
    const startTime = endTime - hours * 3600000;
    const data = await getTuyaDeviceLogs(req.params.id, startTime, endTime, codes);
    res.json(data.result || { logs: [] });
  } catch (err) {
    console.error("tuya logs error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============ Garden Editor API ============
const GARDENS_DIR = path.join(__dirname, "data", "gardens");
if (!fs.existsSync(GARDENS_DIR)) fs.mkdirSync(GARDENS_DIR, { recursive: true });

app.get("/api/gardens", (req, res) => {
  const files = fs.readdirSync(GARDENS_DIR).filter(f => f.endsWith(".json"));
  const list = files.map(f => {
    const data = JSON.parse(fs.readFileSync(path.join(GARDENS_DIR, f), "utf8"));
    return { name: f.replace(".json", ""), label: data.label || f.replace(".json", ""), updated: data.updated };
  });
  res.json(list);
});

app.get("/api/garden/:name", (req, res) => {
  const file = path.join(GARDENS_DIR, req.params.name + ".json");
  if (!fs.existsSync(file)) return res.status(404).json({ error: "not found" });
  res.json(JSON.parse(fs.readFileSync(file, "utf8")));
});

app.post("/api/garden/:name", (req, res) => {
  const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!name) return res.status(400).json({ error: "invalid name" });
  const data = { ...req.body, updated: new Date().toISOString() };
  fs.writeFileSync(path.join(GARDENS_DIR, name + ".json"), JSON.stringify(data, null, 2));
  res.json({ ok: true, name });
});

app.delete("/api/garden/:name", (req, res) => {
  const file = path.join(GARDENS_DIR, req.params.name + ".json");
  if (fs.existsSync(file)) fs.unlinkSync(file);
  res.json({ ok: true });
});

// ============ Page Routes ============
app.get("/cn", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/pin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "pin.html"));
});

app.get("/edit", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "edit.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Smart Garden Dashboard running at http://localhost:${PORT}`);
});
