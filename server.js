require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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

async function getTuyaDeviceStatus(deviceId) {
  const token = await getTuyaToken();
  return tuyaRequest("GET", `/v1.0/iot-03/devices/${deviceId}/status`, token);
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

// ============ Tuya Routes ============
app.get("/api/tuya/devices", async (req, res) => {
  try {
    const devices = [
      { id: "eb4b975ccbbe3fb9dc98n2", type: "water_sensor" },
      { id: "02133168d8f15b852ef8", type: "garage_door" },
    ];
    const results = await Promise.all(
      devices.map(async (d) => {
        const info = await getTuyaDeviceInfo(d.id);
        return { ...d, ...info.result };
      })
    );
    res.json(results);
  } catch (err) {
    console.error("tuya devices error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/tuya/device/:id/status", async (req, res) => {
  try {
    const data = await getTuyaDeviceStatus(req.params.id);
    res.json(data.result || []);
  } catch (err) {
    console.error("tuya status error:", err.message);
    res.status(500).json({ error: err.message });
  }
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Smart Home Dashboard running at http://localhost:${PORT}`);
});
