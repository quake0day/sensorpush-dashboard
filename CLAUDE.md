# CLAUDE.md

## Project Overview

Smart Garden Dashboard — a real-time monitoring system integrating multiple IoT platforms with weather data and AI-powered bird detection. Runs on Node.js/Express serving static HTML pages.

## Architecture

### Server: `server.js` (~1500 lines)
Single Express server on port 3088 with these integrations:
- **SensorPush**: Temperature, humidity, pressure, VPD via OAuth API
- **Tuya**: Water sensor (pond alarm), Smart Dual Water Timer (2 valves), CO alarm
- **Reolink**: RTSP → FFmpeg → HLS streaming, PTZ control, snapshots
- **Blink**: Cloud-only cameras (no RTSP) via `blinkpy` — snapshots, motion clips, arm/disarm, best-effort liveview
- **NWS**: National Weather Service forecast + sunrise/sunset
- **BirdNET**: Bird detection via local Python scripts + Claude API for descriptions
- **Water Level**: Camera-based CV water level detection

### Pages (in `public/`)
| Page | Purpose | Notes |
|------|---------|-------|
| `index.html` | Main dashboard | Weather, sensors, charts, water timer, bird notifications |
| `tv.html` | 1080p TV display | Fixed 1920x1080, large fonts, no emoji (Linux/RPi5) |
| `koi.html` | Koi pond camera | HLS stream, PTZ controls, valve controls, motion events |
| `bird.html` | Bird detection | Leaderboard, BOTD, field guide with swipe gestures |
| `blink.html` | Blink cameras (all) | Snapshot grid, battery/temp, arm/disarm, motion clips, liveview |
| `cat.html` | Cat cam (single Blink cam) | Big auto-refresh snapshot, liveview, latest clip, arm/disarm; cross-links with `/koi` |
| `water.html` | Water level calibration | ROI selection tool |
| `edit.html` | Garden editor | 3D sprite editor (dev tool) |
| `garden.js` | Shared garden renderer | Animated canvas used by index.html and tv.html |

### Key Devices
| Device | ID | Integration |
|--------|-----|-------------|
| Reolink RLC-811A | 192.168.68.96 | RTSP camera, koi pond |
| Water Timer | eb42c3sv54vcakok | Tuya, valve 1=flowers, valve 2=pond |
| Water Sensor | eb4b975ccbbe3fb9dc98n2 | Tuya, pond alarm (dual probe) |
| SensorPush | via API | Temperature/humidity sensors |

### Water Timer Notes
- Tuya device countdown is **unreliable** — server uses `setTimeout` for auto-off
- API: `GET /api/timer/status`, `POST /api/timer/valve {valve, on, countdown}`
- Dashboard uses reference image (`water-timer-bg.png`) with SVG animation overlay
- Pin tool at `/water-pin.html` for coordinate calibration (800x436 reference)

### Blink Camera Notes
Blink cameras are **cloud-only** — no RTSP/ONVIF/local stream, no official API.
Integration goes through `blink_client.py` (the community `blinkpy` library),
which `server.js` spawns once per request (same pattern as the pinyin helper).

- **One-time setup (interactive 2FA):** `python3 blink_client.py setup`
  Reads `BLINK_USERNAME`/`BLINK_PASSWORD` from `.env`, prompts for the emailed
  2FA PIN, then persists the session to `$DATA_DIR/blink_creds.json`. After
  that, no PIN is needed — every call refreshes + re-saves the token.
- **Endpoints:** `GET /api/blink/cameras` (60s cached), `GET /api/blink/thumbnail/:name` (`?snap=1` forces a fresh photo), `POST /api/blink/snap/:name`, `GET /api/blink/clip/:name` (latest motion mp4), `POST /api/blink/arm {network, armed}`, `POST /api/blink/liveview/:name` → HLS at `/blink-hls/stream.m3u8`, `POST /api/blink/liveview/stop`.
- **Liveview is best-effort:** Blink liveviews are short-lived (~30–90s) and
  drain the battery — NOT a 24/7 stream like the koi camera. One at a time.
- **Reusing AI detection:** the motion-clip mp4 can be fed to the existing
  `motion_detector.py` / `bird_detector.py` if you want detection on Blink feeds.

## Development

```bash
# Local dev
npm install
node server.js  # starts on port 3088

# Environment
cp .env.example .env  # configure SensorPush, Tuya, Reolink, Anthropic keys
```

### Runtime data location (important)

All runtime data (bird detections, motion events, water level, gardens,
HLS cache, pond alarm log, backup SQLite) lives **outside the repo** at
`$DATA_DIR` — default `~/sensorpush-data/`. This is to guarantee no git
operation (`pull`, `reset --hard`, `clean -fdx`, even `rm -rf && git clone`)
can ever delete it. On 2026-04-13 we lost bird data to exactly that.

Override via `.env`: `DATA_DIR=/some/other/path`. Both `server.js` and
the Python detectors (`bird_detector.py`, `motion_detector.py`,
`water_detector.py`) and the backup scripts (`backup/sync.js`,
`backup/lib/db.js`) all read the same env var with the same default.

### HLS Streaming
- **Stable mode** (default): Sub stream copy, 0% CPU, 640x360
- **HD mode**: Main stream transcode to 720p H.264 + AAC
- Switch via `POST /api/camera/stream {quality: "stable"|"hd"}`

## Deployment

Production runs on **Raspberry Pi 5** (192.168.68.110) connected to 1080p TV.

```bash
# Deploy (from local machine)
git push
ssh quake0day@192.168.68.110 "cd ~/sensorpush-dashboard && git pull"

# If server.js changed, restart:
ssh ... "killall node; cd ~/sensorpush-dashboard && nohup node server.js > /tmp/sp.log 2>&1 &"
```

### TV Page Constraints
- **No emoji** — Linux on RPi5 has no emoji fonts, use text/SVG alternatives
- **Large fonts** — 30-50% bigger than desktop defaults for TV viewing distance
- **Chinese mode** — defaults to Celsius
- **Camera never disconnects** — infinite retry, reconnect every 10 min

## Bilingual Support
All user-facing pages support English and Chinese via URL prefix (`/cn/...`).
Language detection: `window.location.pathname.startsWith('/cn')`.

## Testing Priorities
1. HLS stream stability (sub stream copy mode)
2. Water timer valve control and auto-off
3. Mobile/iPad responsive layout
4. Bird detection field guide gestures
