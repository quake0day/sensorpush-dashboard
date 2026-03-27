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

    // Video: transcode HEVC→H.264 (browser-compatible)
    "-c:v", "libx264",
    "-preset", "fast",
    "-tune", "zerolatency",
    "-profile:v", "high",
    "-level", "4.1",
    "-b:v", preset.vbr,
    "-maxrate", preset.maxrate,
    "-bufsize", preset.bufsize,
  ];

  // Scale if not 4K passthrough
  if (preset.scale) {
    args.push("-vf", `scale=${preset.scale}`);
  }

  args.push(
    "-r", "25",                    // Output 25fps
    "-g", "50",                    // Keyframe every 2s (25fps * 2)
    "-sc_threshold", "0",
    "-flags", "+cgop",             // Closed GOP for HLS

    // Audio: copy AAC directly from camera (re-encoding corrupts metadata)
    "-c:a", "copy",

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

// Cleanup ffmpeg on exit
process.on("SIGTERM", () => { if (ffmpegProc) ffmpegProc.kill(); process.exit(0); });
process.on("SIGINT", () => { if (ffmpegProc) ffmpegProc.kill(); process.exit(0); });

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Smart Garden Dashboard running at http://localhost:${PORT}`);
});
