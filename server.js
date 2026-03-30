require("dotenv").config();
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

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

// ============ Reolink Camera (Koi Pond) - RTSP/HLS ============
const { spawn } = require("child_process");
const REOLINK_IP = process.env.REOLINK_IP || "192.168.68.96";
const REOLINK_USER = process.env.REOLINK_USER || "admin";
const REOLINK_PASS = process.env.REOLINK_PASSWORD || "";
const HLS_DIR = path.join(__dirname, "hls-cam");

// Ensure HLS output directory exists
if (!fs.existsSync(HLS_DIR)) fs.mkdirSync(HLS_DIR, { recursive: true });

// Serve HLS segments with proper headers
app.use("/hls", (req, res, next) => {
  res.set("Cache-Control", "no-cache, no-store");
  res.set("Access-Control-Allow-Origin", "*");
  next();
}, express.static(HLS_DIR));

let ffmpegProc = null;
let ffmpegStream = "main"; // always use main for audio + quality
let ffmpegQuality = "1080p"; // "1080p", "720p", "4k"
let ffmpegStartTime = 0;
let ffmpegRestarts = 0;

function rtspUrl() {
  // Always use main stream (has audio; sub stream has NO audio)
  return `rtsp://${encodeURIComponent(REOLINK_USER)}:${encodeURIComponent(REOLINK_PASS)}@${REOLINK_IP}:554/h264Preview_01_main`;
}

const QUALITY_PRESETS = {
  "4k":    { scale: null, vbr: "8000k",  maxrate: "10000k", bufsize: "16000k" },
  "1080p": { scale: "1920:-2", vbr: "3000k", maxrate: "4000k", bufsize: "6000k" },
  "720p":  { scale: "1280:-2", vbr: "1500k", maxrate: "2000k", bufsize: "3000k" },
};

function startFFmpeg(quality) {
  if (ffmpegProc) {
    ffmpegProc.kill("SIGTERM");
    ffmpegProc = null;
  }
  // Clean old segments
  try {
    fs.readdirSync(HLS_DIR).forEach(f => fs.unlinkSync(path.join(HLS_DIR, f)));
  } catch (e) {}

  ffmpegQuality = quality || ffmpegQuality;
  ffmpegStartTime = Date.now();
  const url = rtspUrl();
  const preset = QUALITY_PRESETS[ffmpegQuality] || QUALITY_PRESETS["1080p"];
  console.log(`Starting ffmpeg: RTSP main → H.264 ${ffmpegQuality} + AAC → HLS`);

  const args = [
    // Input: RTSP over TCP, stable connection
    "-fflags", "+genpts+discardcorrupt",
    "-rtsp_transport", "tcp",
    "-rtsp_flags", "prefer_tcp",
    "-buffer_size", "8388608",    // 8MB input buffer
    "-max_delay", "1000000",      // 1s max delay
    "-reorder_queue_size", "2048",
    "-analyzeduration", "5000000",
    "-probesize", "5000000",
    "-i", url,

    // Explicit stream mapping (required for audio to work)
    "-map", "0:v:0",
    "-map", "0:a:0",

    // Video: transcode HEVC→H.264 (browser-compatible)
    "-c:v:0", "libx264",
    "-preset", "fast",
    "-tune", "zerolatency",
    "-profile:v", "high",
    "-level", "4.1",
    "-b:v:0", preset.vbr,
    "-maxrate:v", preset.maxrate,
    "-bufsize:v", preset.bufsize,
  ];

  // Scale if not 4K passthrough — use filter_complex to avoid affecting audio
  if (preset.scale) {
    args.push("-filter:v", `scale=${preset.scale}`);
  }

  args.push(
    "-r", "25",                    // Output 25fps
    "-g", "50",                    // Keyframe every 2s (25fps * 2)
    "-sc_threshold", "0",
    "-flags", "+cgop",             // Closed GOP for HLS

    // Audio: re-encode AAC with explicit params (copy loses channel metadata)
    "-c:a:0", "aac",
    "-ar", "16000",
    "-ac", "1",
    "-b:a:0", "64k",
    "-strict", "experimental",

    // HLS output
    "-f", "hls",
    "-hls_time", "4",             // 4s segments (more stable than 2s)
    "-hls_list_size", "5",
    "-hls_flags", "delete_segments+append_list+independent_segments",
    "-hls_segment_type", "mpegts",
    "-hls_start_number_source", "datetime",
    "-hls_segment_filename", path.join(HLS_DIR, "seg%05d.ts"),
    path.join(HLS_DIR, "stream.m3u8"),
  );

  ffmpegProc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });

  let stderrBuf = "";
  ffmpegProc.stderr.on("data", (data) => {
    stderrBuf += data.toString();
    // Log errors and periodic status
    const lines = stderrBuf.split("\n");
    stderrBuf = lines.pop(); // keep incomplete line
    for (const line of lines) {
      if (line.includes("error") || line.includes("Error") || line.includes("Opening") || line.includes("Output #0")) {
        console.log("ffmpeg:", line.trim());
      }
    }
  });

  ffmpegProc.on("exit", (code) => {
    console.log(`ffmpeg exited with code ${code}`);
    ffmpegProc = null;
    // Auto-restart if it crashed (max 10 restarts)
    if (code !== 0 && ffmpegRestarts < 10) {
      ffmpegRestarts++;
      console.log(`ffmpeg auto-restart #${ffmpegRestarts} in 3s...`);
      setTimeout(() => startFFmpeg(ffmpegQuality), 3000);
    }
  });

  // Reset restart counter after 60s of stable operation
  setTimeout(() => { ffmpegRestarts = Math.max(0, ffmpegRestarts - 1); }, 60000);
}

// Auto-start ffmpeg on server boot (1080p with audio)
startFFmpeg("1080p");

// API: stream status
app.get("/api/camera/status", (req, res) => {
  const m3u8Exists = fs.existsSync(path.join(HLS_DIR, "stream.m3u8"));
  const segments = fs.readdirSync(HLS_DIR).filter(f => f.endsWith(".ts")).length;
  res.json({
    running: !!ffmpegProc,
    quality: ffmpegQuality,
    hlsReady: m3u8Exists && segments > 0,
    segments,
    uptime: ffmpegProc ? Math.floor((Date.now() - ffmpegStartTime) / 1000) : 0,
    restarts: ffmpegRestarts,
  });
});

// API: switch output quality (always from main RTSP stream)
app.post("/api/camera/stream", (req, res) => {
  const { quality } = req.body;
  if (!["4k", "1080p", "720p"].includes(quality)) return res.status(400).json({ error: "Invalid quality: 4k, 1080p, or 720p" });
  startFFmpeg(quality);
  res.json({ ok: true, quality });
});

// API: restart stream
app.post("/api/camera/restart", (req, res) => {
  ffmpegRestarts = 0;
  startFFmpeg(ffmpegStream);
  res.json({ ok: true });
});

// API: snapshot (grab from RTSP directly)
app.get("/api/camera/snap", async (req, res) => {
  try {
    const url = `http://${REOLINK_IP}/cgi-bin/api.cgi?cmd=Snap&channel=0&rs=${Date.now()}&user=${encodeURIComponent(REOLINK_USER)}&password=${encodeURIComponent(REOLINK_PASS)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Camera returned ${response.status}`);
    res.set("Content-Type", response.headers.get("content-type") || "image/jpeg");
    res.set("Cache-Control", "no-cache, no-store");
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error("camera snap error:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// API: PTZ control
app.post("/api/camera/ptz", async (req, res) => {
  try {
    const { command, speed } = req.body;
    const ptzMap = {
      left: "Left", right: "Right", up: "Up", down: "Down",
      zoomin: "ZoomInc", zoomout: "ZoomDec", stop: "Stop"
    };
    const op = ptzMap[command];
    if (!op) return res.status(400).json({ error: "Invalid PTZ command" });
    const body = [{ cmd: "PtzCtrl", action: 0, param: { channel: 0, op, speed: speed || 10 } }];
    const url = `http://${REOLINK_IP}/cgi-bin/api.cgi?token=null&user=${encodeURIComponent(REOLINK_USER)}&password=${encodeURIComponent(REOLINK_PASS)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    res.json(await response.json());
  } catch (err) {
    console.error("camera ptz error:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// API: camera device info
app.get("/api/camera/info", async (req, res) => {
  try {
    const body = [{ cmd: "GetDevInfo", action: 0, param: { channel: 0 } }];
    const url = `http://${REOLINK_IP}/cgi-bin/api.cgi?token=null&user=${encodeURIComponent(REOLINK_USER)}&password=${encodeURIComponent(REOLINK_PASS)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const data = await response.json();
    res.json(data[0]?.value?.DevInfo || {});
  } catch (err) {
    console.error("camera info error:", err.message);
    res.status(502).json({ error: err.message });
  }
});

// ============ Bird Detection API ============
const BIRD_DIR = path.join(__dirname, "data", "bird-detections");
const BIRD_CLIPS = path.join(BIRD_DIR, "clips");
const BIRD_FILE = path.join(BIRD_DIR, "latest.json");
if (!fs.existsSync(BIRD_CLIPS)) fs.mkdirSync(BIRD_CLIPS, { recursive: true });

// Serve bird audio clips
app.use("/api/birds/clip", express.static(BIRD_CLIPS));

// Latest detections
app.get("/api/birds/latest", (req, res) => {
  const since = parseInt(req.query.since) || 0;
  try {
    if (!fs.existsSync(BIRD_FILE)) return res.json({ detections: [] });
    const all = JSON.parse(fs.readFileSync(BIRD_FILE, "utf8"));
    const filtered = since ? all.filter(d => d.timestamp > since) : all.slice(-20);
    res.json({ detections: filtered });
  } catch (e) {
    res.json({ detections: [] });
  }
});

// Helper: local date string (not UTC)
function localDateStr(d) {
  const dd = d || new Date();
  return dd.getFullYear() + '-' + String(dd.getMonth()+1).padStart(2,'0') + '-' + String(dd.getDate()).padStart(2,'0');
}

// Daily detections by date
app.get("/api/birds/daily/:date?", (req, res) => {
  try {
    const dateStr = req.params.date || localDateStr();
    const file = path.join(BIRD_DIR, "daily", `${dateStr}.json`);
    if (!fs.existsSync(file)) return res.json({ date: dateStr, detections: [] });
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    res.json({ date: dateStr, detections: data });
  } catch (e) {
    res.json({ date: req.params.date, detections: [] });
  }
});

// Available dates that have detections
app.get("/api/birds/dates", (req, res) => {
  try {
    const dailyDir = path.join(BIRD_DIR, "daily");
    if (!fs.existsSync(dailyDir)) return res.json({ dates: [] });
    const files = fs.readdirSync(dailyDir).filter(f => f.endsWith(".json")).sort().reverse();
    const dates = files.map(f => {
      const date = f.replace(".json", "");
      const data = JSON.parse(fs.readFileSync(path.join(dailyDir, f), "utf8"));
      return { date, count: data.length };
    });
    res.json({ dates });
  } catch (e) {
    res.json({ dates: [] });
  }
});

// Stats/leaderboard for a date range
app.get("/api/birds/stats", (req, res) => {
  try {
    const date = req.query.date || localDateStr();
    const days = parseInt(req.query.days) || 1;
    const allDetections = [];

    for (let i = 0; i < days; i++) {
      const d = new Date(date);
      d.setDate(d.getDate() - i);
      const ds = d.toISOString().slice(0, 10);
      const file = path.join(BIRD_DIR, "daily", `${ds}.json`);
      if (fs.existsSync(file)) {
        try {
          const data = JSON.parse(fs.readFileSync(file, "utf8"));
          allDetections.push(...data);
        } catch (e) {}
      }
    }

    // Build species leaderboard
    const speciesMap = {};
    for (const d of allDetections) {
      const key = d.common_name;
      if (!speciesMap[key]) {
        speciesMap[key] = { common_name: d.common_name, scientific_name: d.scientific_name, count: 0, total_conf: 0, first_seen: d.time, last_seen: d.time, best_clip: null };
      }
      speciesMap[key].count++;
      speciesMap[key].total_conf += d.confidence;
      if (d.time < speciesMap[key].first_seen) speciesMap[key].first_seen = d.time;
      if (d.time > speciesMap[key].last_seen) speciesMap[key].last_seen = d.time;
      if (d.has_clip && (!speciesMap[key].best_clip || d.confidence > (speciesMap[key].best_conf || 0))) {
        speciesMap[key].best_clip = d.id;
        speciesMap[key].best_conf = d.confidence;
      }
    }

    const leaderboard = Object.values(speciesMap)
      .map(s => ({ ...s, avg_conf: Math.round((s.total_conf / s.count) * 1000) / 1000 }))
      .sort((a, b) => b.count - a.count);

    // Hourly activity
    const hourly = Array(24).fill(0);
    for (const d of allDetections) {
      const h = new Date(d.time).getHours();
      hourly[h]++;
    }

    res.json({
      total_detections: allDetections.length,
      unique_species: leaderboard.length,
      leaderboard,
      hourly,
      period: { date, days },
    });
  } catch (e) {
    res.json({ total_detections: 0, unique_species: 0, leaderboard: [], hourly: Array(24).fill(0) });
  }
});

// Bird detector process management
let birdProc = null;
function startBirdDetector() {
  if (birdProc) return;
  const script = path.join(__dirname, "bird_detector.py");
  if (!fs.existsSync(script)) return;
  console.log("Starting bird detector...");
  birdProc = spawn("python3", ["-u", script], {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  birdProc.stdout.on("data", d => {
    const line = d.toString().trim();
    if (line) console.log("bird:", line);
  });
  birdProc.stderr.on("data", d => {
    const line = d.toString().trim();
    if (line && !line.startsWith("INFO:")) console.error("bird-err:", line);
  });
  birdProc.on("exit", (code) => {
    console.log(`Bird detector exited (code ${code})`);
    birdProc = null;
    // Auto-restart after 30s
    setTimeout(startBirdDetector, 30000);
  });
}

// Start bird detector 15s after server boot (wait for HLS)
setTimeout(startBirdDetector, 15000);

app.get("/api/birds/status", (req, res) => {
  res.json({ running: !!birdProc });
});

// Wikipedia image + info proxy for bird photos
const birdImageCache = {};

async function wikiLookup(term) {
  // Wikipedia REST API needs underscores, not spaces
  const slug = term.replace(/ /g, "_");
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(slug)}`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "SmartGardenDashboard/1.0" },
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (data.type === "disambiguation" || !data.extract) return null;
  // Use originalimage for higher quality, fall back to thumbnail
  const img = data.originalimage?.source || data.thumbnail?.source || null;
  // Make thumbnail URL larger (replace /XXXpx- with /400px-)
  const image = img ? img.replace(/\/\d+px-/, "/400px-") : null;
  return {
    image,
    extract: data.extract || "",
    extract_html: data.extract_html || "",
    url: data.content_urls?.desktop?.page || "",
    title: data.title || term,
  };
}

app.get("/api/birds/image/:name", async (req, res) => {
  const name = req.params.name;
  if (birdImageCache[name]) {
    return res.json(birdImageCache[name]);
  }
  try {
    // Try common name first, then scientific name via query param
    let result = await wikiLookup(name);
    // If common name fails, try with " (bird)" suffix
    if (!result || !result.image) {
      result = await wikiLookup(name + " (bird)") || result;
    }
    // Try scientific name if provided
    const sci = req.query.sci;
    if ((!result || !result.image) && sci) {
      const sciResult = await wikiLookup(sci);
      if (sciResult) {
        result = {
          image: sciResult.image || result?.image || null,
          extract: result?.extract || sciResult.extract || "",
          url: result?.url || sciResult.url || "",
          title: result?.title || sciResult.title || name,
        };
      }
    }
    const final = result || { image: null, extract: "", url: "" };
    birdImageCache[name] = final;
    res.json(final);
  } catch (e) {
    res.json({ image: null, extract: "", url: "" });
  }
});

// ============ Bird Translation (Claude API + local cache) ============
const BIRD_TRANS_FILE = path.join(BIRD_DIR, "translations.json");
let birdTranslations = {};
try {
  if (fs.existsSync(BIRD_TRANS_FILE)) {
    birdTranslations = JSON.parse(fs.readFileSync(BIRD_TRANS_FILE, "utf8"));
  }
} catch (e) { birdTranslations = {}; }

function saveBirdTranslations() {
  fs.writeFileSync(BIRD_TRANS_FILE, JSON.stringify(birdTranslations, null, 2));
}

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

async function translateBird(commonName, scientificName) {
  if (!anthropic) return null;
  try {
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      system: "You are an ornithology JSON API. Use OFFICIAL standard Chinese bird names. Return ONLY valid JSON with no extra text.",
      messages: [{
        role: "user",
        content: `Bird: ${commonName} (${scientificName})

Known correct Chinese names for reference:
Northern Cardinal=北美红雀, Blue Jay=冠蓝鸦, American Robin=旅鸫, American Crow=美洲鸦, American Goldfinch=美洲金翅雀, House Sparrow=家麻雀, House Finch=家朱雀, Mourning Dove=哀鸽, Song Sparrow=歌带鹀, Carolina Wren=卡罗来纳鹪鹩, Tufted Titmouse=丛林山雀, Black-capped Chickadee=黑顶山雀, Carolina Chickadee=卡罗来纳山雀, White-breasted Nuthatch=白胸鳾, Red-bellied Woodpecker=红腹啄木鸟, Downy Woodpecker=绒啄木鸟, Northern Flicker=扑动鴷, Eastern Bluebird=东蓝鸲, Northern Mockingbird=北方嘲鸫, Fox Sparrow=狐色雀鹀, Least Bittern=小苇鳽, Pied-billed Grebe=斑嘴巨鸊鷉, Summer Tanager=夏裸鹎鵐, Green-winged Teal=绿翅鸭, Northern Shoveler=琵嘴鸭, Eurasian Collared-Dove=灰斑鸠, Yellow-billed Cuckoo=黄嘴美洲鹃, Tree Swallow=树燕

Return JSON:
{"cn_name":"official Chinese name","cn_name_pinyin":"FULL pinyin with tone marks for entire cn_name, e.g. bei3 mei3 hong2 que4","cn_desc":"50-80 char Chinese description. For any rare bird characters (鳽鸊鷉鹪鹩鹀鸲鹂鹟鸮鵟鴷鸫鹃鳾) add pinyin in parentheses after them","call_desc":"20 char call description in Chinese","call_desc_en":"20 word call description in English"}`,
      }],
    });
    let text = msg.content[0].text.trim();
    // Strip any markdown fences or extra text
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    // Extract JSON object if surrounded by other text
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) { console.error("No JSON found in:", text.slice(0, 200)); return null; }
    try {
      return JSON.parse(match[0]);
    } catch (parseErr) {
      // Try fixing common JSON issues: unescaped quotes in values
      let fixed = match[0].replace(/:\s*"([^"]*?)(?:"([^",}\]]*?))"/g, ': "$1\\"$2"');
      try { return JSON.parse(fixed); } catch {}
      console.error("Translation parse error:", parseErr.message, "text:", match[0].slice(0, 200));
      return null;
    }
  } catch (e) {
    console.error("Translation error:", e.message);
    return null;
  }
}

// Generate AllAboutBirds sound page URL
function allAboutBirdsUrl(commonName) {
  const slug = commonName.replace(/['']/g, "").replace(/\s+/g, "_");
  return `https://www.allaboutbirds.org/guide/${slug}/sounds`;
}

// Generate pinyin using pypinyin (100% accurate, no LLM needed)
function generatePinyin(chinese) {
  return new Promise((resolve) => {
    const { execFile } = require("child_process");
    execFile("python3", ["-c", `from pypinyin import pinyin, Style; print(' '.join([p[0] for p in pinyin("${chinese.replace(/"/g, '')}", style=Style.TONE)]))`],
      { timeout: 5000 }, (err, stdout) => {
        resolve(err ? "" : stdout.trim());
      });
  });
}

// Get or create translation for a bird
app.get("/api/birds/translate/:name", async (req, res) => {
  const name = req.params.name;
  const sci = req.query.sci || "";

  // Check cache first
  if (birdTranslations[name]) {
    return res.json(birdTranslations[name]);
  }

  // Call Claude API for translation
  const result = await translateBird(name, sci);
  if (result) {
    // Generate accurate pinyin via pypinyin (not Claude)
    const py = await generatePinyin(result.cn_name);

    birdTranslations[name] = {
      cn_name: result.cn_name,
      cn_name_pinyin: py,
      cn_desc: result.cn_desc,
      call_desc: result.call_desc || "",
      call_desc_en: result.call_desc_en || "",
      sound_url: allAboutBirdsUrl(name),
      common_name: name,
      scientific_name: sci,
      translated_at: new Date().toISOString(),
    };
    saveBirdTranslations();
    return res.json(birdTranslations[name]);
  }

  res.json({ cn_name: name, cn_desc: "" });
});

// Bulk: get all cached translations
app.get("/api/birds/translations", (req, res) => {
  res.json(birdTranslations);
});

// Regenerate pinyin for all cached translations
app.post("/api/birds/fix-pinyin", async (req, res) => {
  let fixed = 0;
  for (const [name, entry] of Object.entries(birdTranslations)) {
    if (entry.cn_name) {
      const py = await generatePinyin(entry.cn_name);
      if (py && py !== entry.cn_name_pinyin) {
        entry.cn_name_pinyin = py;
        fixed++;
      }
    }
  }
  saveBirdTranslations();
  res.json({ fixed, total: Object.keys(birdTranslations).length });
});

// Cleanup on exit
// ============ Water Level Detector ============
let waterProc = null;
function startWaterDetector() {
  if (waterProc) return;
  const script = path.join(__dirname, "water_detector.py");
  if (!fs.existsSync(script)) return;
  console.log("Starting water level detector...");
  waterProc = spawn("python3", ["-u", script], {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  waterProc.stdout.on("data", d => {
    const line = d.toString().trim();
    if (line) console.log("water:", line);
  });
  waterProc.stderr.on("data", d => {
    const line = d.toString().trim();
    if (line && !line.startsWith("INFO:")) console.error("water-err:", line);
  });
  waterProc.on("exit", (code) => {
    console.log(`Water detector exited (code ${code})`);
    waterProc = null;
    setTimeout(startWaterDetector, 30000);
  });
}
setTimeout(startWaterDetector, 25000);

function cleanup() {
  if (ffmpegProc) ffmpegProc.kill();
  if (birdProc) birdProc.kill();
  if (motionProc) motionProc.kill();
  if (waterProc) waterProc.kill();
  process.exit(0);
}
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

// ============ Water Level API ============
const WATER_DIR = path.join(__dirname, "data", "water-level");
if (!fs.existsSync(WATER_DIR)) fs.mkdirSync(WATER_DIR, { recursive: true });
const WATER_CAL_FILE = path.join(WATER_DIR, "calibration.json");
const WATER_READINGS_FILE = path.join(WATER_DIR, "readings.json");

// Save/load calibration
app.get("/api/water/calibration", (req, res) => {
  try {
    if (!fs.existsSync(WATER_CAL_FILE)) return res.json({ roi: null, levels: [] });
    res.json(JSON.parse(fs.readFileSync(WATER_CAL_FILE, "utf8")));
  } catch (e) { res.json({ roi: null, levels: [] }); }
});

app.post("/api/water/calibration", (req, res) => {
  try {
    fs.writeFileSync(WATER_CAL_FILE, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Snapshot for calibration
app.get("/api/water/snapshot", async (req, res) => {
  try {
    // Login to get token first (password with @ doesn't work in query string)
    const loginBody = JSON.stringify([{cmd:"Login",action:0,param:{User:{userName:REOLINK_USER,password:REOLINK_PASS}}}]);
    const loginRes = await fetch(`http://${REOLINK_IP}/cgi-bin/api.cgi?cmd=Login`, {
      method: "POST", headers: {"Content-Type":"application/json"}, body: loginBody, signal: AbortSignal.timeout(5000),
    });
    const loginData = await loginRes.json();
    const token = loginData[0]?.value?.Token?.name;
    if (!token) throw new Error("Login failed");

    const url = `http://${REOLINK_IP}/cgi-bin/api.cgi?cmd=Snap&channel=0&rs=${Date.now()}&token=${token}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Camera returned ${response.status}`);
    const ct = response.headers.get("content-type") || "";
    if (!ct.includes("image")) throw new Error("Not an image: " + ct);
    res.set("Content-Type", ct);
    res.set("Cache-Control", "no-cache");
    res.send(Buffer.from(await response.arrayBuffer()));
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// Water level readings
app.get("/api/water/readings", (req, res) => {
  try {
    if (!fs.existsSync(WATER_READINGS_FILE)) return res.json({ readings: [] });
    const all = JSON.parse(fs.readFileSync(WATER_READINGS_FILE, "utf8"));
    const hours = parseInt(req.query.hours) || 24;
    const cutoff = Date.now() - hours * 3600000;
    res.json({ readings: all.filter(r => r.timestamp > cutoff) });
  } catch (e) { res.json({ readings: [] }); }
});

app.get("/api/water/current", (req, res) => {
  try {
    if (!fs.existsSync(WATER_READINGS_FILE)) return res.json({ level_pct: null });
    const all = JSON.parse(fs.readFileSync(WATER_READINGS_FILE, "utf8"));
    if (!all.length) return res.json({ level_pct: null });
    res.json(all[all.length - 1]);
  } catch (e) { res.json({ level_pct: null }); }
});

// ============ Bird of the Day API ============
const BOTD_FILE = path.join(BIRD_DIR, "bird-of-the-day.json");

app.get("/api/birds/botd", (req, res) => {
  try {
    const today = localDateStr();
    const dailyFile = path.join(BIRD_DIR, "daily", `${today}.json`);
    if (!fs.existsSync(dailyFile)) return res.json({ bird: null });
    const detections = JSON.parse(fs.readFileSync(dailyFile, "utf8"));
    if (!detections.length) return res.json({ bird: null });

    // Load history of past BOTDs to avoid repeats
    let botdHistory = {};
    if (fs.existsSync(BOTD_FILE)) {
      try { botdHistory = JSON.parse(fs.readFileSync(BOTD_FILE, "utf8")); } catch {}
    }

    // Build species stats for today
    const speciesMap = {};
    for (const d of detections) {
      const k = d.common_name;
      if (!speciesMap[k]) speciesMap[k] = { common_name: k, scientific_name: d.scientific_name, count: 0, total_conf: 0, max_conf: 0, first_seen: d.time, last_seen: d.time };
      speciesMap[k].count++;
      speciesMap[k].total_conf += d.confidence;
      if (d.confidence > speciesMap[k].max_conf) speciesMap[k].max_conf = d.confidence;
      if (d.time > speciesMap[k].last_seen) speciesMap[k].last_seen = d.time;
    }
    const species = Object.values(speciesMap);

    // Load 30 days of history to determine rarity
    const allTimeCounts = {};
    const dailyDir = path.join(BIRD_DIR, "daily");
    if (fs.existsSync(dailyDir)) {
      const files = fs.readdirSync(dailyDir).filter(f => f.endsWith(".json")).slice(-30);
      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(dailyDir, f), "utf8"));
          const seen = new Set();
          for (const d of data) {
            if (!seen.has(d.common_name)) { allTimeCounts[d.common_name] = (allTimeCounts[d.common_name] || 0) + 1; seen.add(d.common_name); }
          }
        } catch {}
      }
    }

    // Score each species
    // Factors: rarity (fewer days seen = higher), today's count, confidence, not recently BOTD
    const recentBotds = Object.entries(botdHistory).filter(([date]) => {
      const daysAgo = (Date.now() - new Date(date).getTime()) / 86400000;
      return daysAgo < 14;
    }).map(([, v]) => v.common_name);

    for (const sp of species) {
      const daysSeenIn30 = allTimeCounts[sp.common_name] || 1;
      const rarityScore = Math.max(1, 30 / daysSeenIn30); // rarer = higher
      const countScore = Math.log2(sp.count + 1); // more today = higher
      const confScore = sp.max_conf * 2; // high confidence = good
      const recentPenalty = recentBotds.includes(sp.common_name) ? 0.2 : 1; // penalize recent BOTDs
      const firstTimerBonus = daysSeenIn30 <= 1 ? 5 : 1; // huge bonus for first-ever sighting

      sp.score = (rarityScore * 2 + countScore + confScore) * recentPenalty * firstTimerBonus;
      sp.rarity_days = daysSeenIn30;
      sp.avg_conf = Math.round((sp.total_conf / sp.count) * 1000) / 1000;
    }

    // Pick the winner
    species.sort((a, b) => b.score - a.score);
    const winner = species[0];

    // Check if current BOTD should be replaced
    const currentBotd = botdHistory[today];
    let shouldUpdate = !currentBotd;
    if (currentBotd && winner.common_name !== currentBotd.common_name) {
      // Replace if new bird scores significantly higher (rare bird appeared)
      shouldUpdate = winner.score > (currentBotd.score || 0) * 1.5;
    }

    if (shouldUpdate) {
      botdHistory[today] = {
        common_name: winner.common_name,
        scientific_name: winner.scientific_name,
        count: winner.count,
        max_conf: winner.max_conf,
        avg_conf: winner.avg_conf,
        rarity_days: winner.rarity_days,
        score: Math.round(winner.score * 100) / 100,
        first_seen: winner.first_seen,
        last_seen: winner.last_seen,
        selected_at: new Date().toISOString(),
      };
      // Keep last 90 days of history
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 90);
      for (const d of Object.keys(botdHistory)) { if (new Date(d) < cutoff) delete botdHistory[d]; }
      fs.writeFileSync(BOTD_FILE, JSON.stringify(botdHistory, null, 2));
    }

    res.json({ bird: botdHistory[today], date: today });
  } catch (e) {
    console.error("BOTD error:", e);
    res.json({ bird: null });
  }
});

// Detailed bird info via Claude
app.get("/api/birds/detail/:name", async (req, res) => {
  const name = req.params.name;
  const sci = req.query.sci || "";
  const cacheFile = path.join(BIRD_DIR, "details", `${name.replace(/[^a-zA-Z0-9]/g, '_')}.json`);
  const detailDir = path.join(BIRD_DIR, "details");
  if (!fs.existsSync(detailDir)) fs.mkdirSync(detailDir, { recursive: true });

  if (fs.existsSync(cacheFile)) {
    try { return res.json(JSON.parse(fs.readFileSync(cacheFile, "utf8"))); } catch {}
  }

  if (!anthropic) return res.json({});

  try {
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1200,
      system: "You are an ornithology JSON API. Use official standard Chinese bird names. Return ONLY valid JSON with no extra text.",
      messages: [{ role: "user", content: `Bird: ${name} (${sci})

Return a JSON object with these keys:
- cn_name: Chinese common name
- description_en: 100-150 word English description covering appearance, size, habitat, diet, behavior, and range
- description_cn: 150-200 character Chinese description covering the same topics
- size_cm: typical body length in cm (number)
- wingspan_cm: typical wingspan in cm (number)
- weight_g: typical weight in grams (number)
- diet: main diet in English (short phrase)
- diet_cn: main diet in Chinese
- habitat: typical habitat in English
- habitat_cn: typical habitat in Chinese
- conservation: IUCN conservation status (e.g. "Least Concern")
- conservation_cn: conservation status in Chinese
- fun_fact_en: one interesting fact in English (1 sentence)
- fun_fact_cn: same fact in Chinese
- call_desc_en: description of its song/call in English (1 sentence)
- call_desc_cn: description of its song/call in Chinese` }],
    });
    let text = msg.content[0].text.trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.json({});
    const detail = JSON.parse(match[0]);
    detail.common_name = name;
    detail.scientific_name = sci;
    fs.writeFileSync(cacheFile, JSON.stringify(detail, null, 2));
    res.json(detail);
  } catch (e) {
    console.error("Bird detail error:", e.message);
    res.json({});
  }
});

// ============ Motion Detection API ============
const MOTION_DIR = path.join(__dirname, "data", "motion-events");
const MOTION_CLIPS = path.join(MOTION_DIR, "clips");
const MOTION_THUMBS = path.join(MOTION_DIR, "thumbs");
const MOTION_FILE = path.join(MOTION_DIR, "latest.json");
if (!fs.existsSync(MOTION_CLIPS)) fs.mkdirSync(MOTION_CLIPS, { recursive: true });
if (!fs.existsSync(MOTION_THUMBS)) fs.mkdirSync(MOTION_THUMBS, { recursive: true });

app.use("/api/motion/clip", express.static(MOTION_CLIPS));
app.use("/api/motion/thumb", express.static(MOTION_THUMBS));

app.get("/api/motion/latest", (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const limit = parseInt(req.query.limit) || 20;
  try {
    if (!fs.existsSync(MOTION_FILE)) return res.json({ events: [] });
    const all = JSON.parse(fs.readFileSync(MOTION_FILE, "utf8"));
    const filtered = since ? all.filter(e => e.timestamp > since) : all.slice(-limit);
    res.json({ events: filtered });
  } catch (e) {
    res.json({ events: [] });
  }
});

app.get("/api/motion/daily/:date?", (req, res) => {
  try {
    const dateStr = req.params.date || localDateStr();
    const file = path.join(MOTION_DIR, "daily", `${dateStr}.json`);
    if (!fs.existsSync(file)) return res.json({ date: dateStr, events: [] });
    res.json({ date: dateStr, events: JSON.parse(fs.readFileSync(file, "utf8")) });
  } catch (e) {
    res.json({ events: [] });
  }
});

// Motion detector process
let motionProc = null;
function startMotionDetector() {
  if (motionProc) return;
  const script = path.join(__dirname, "motion_detector.py");
  if (!fs.existsSync(script)) return;
  console.log("Starting motion detector...");
  motionProc = spawn("python3", ["-u", script], {
    cwd: __dirname,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  motionProc.stdout.on("data", d => {
    const line = d.toString().trim();
    if (line) console.log("motion:", line);
  });
  motionProc.stderr.on("data", d => {
    const line = d.toString().trim();
    if (line && !line.startsWith("INFO:")) console.error("motion-err:", line);
  });
  motionProc.on("exit", (code) => {
    console.log(`Motion detector exited (code ${code})`);
    motionProc = null;
    setTimeout(startMotionDetector, 30000);
  });
}
setTimeout(startMotionDetector, 20000);

app.get("/api/motion/status", (req, res) => {
  res.json({ running: !!motionProc });
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

app.get("/koi", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "koi.html"));
});
app.get("/cn/koi", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "koi.html"));
});

app.get("/bird", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "bird.html"));
});
app.get("/cn/bird", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "bird.html"));
});

app.get("/water", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "water.html"));
});
app.get("/cn/water", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "water.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Smart Garden Dashboard running at http://localhost:${PORT}`);
});
