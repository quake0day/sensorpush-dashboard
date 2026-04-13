# Smart Garden

A real-time IoT monitoring dashboard that integrates multiple smart home platforms with weather data and AI-powered bird detection into a unified web interface. Designed to run 24/7 on a Raspberry Pi 5 connected to a TV, with full bilingual (English/Chinese) support.

![Smart Garden Dashboard](screenshots/dashboard.png)

## Features

### SensorPush Environmental Monitoring
Real-time data from wireless SensorPush sensors including temperature, humidity, dew point, barometric pressure, and VPD (Vapor Pressure Deficit). Interactive historical charts with selectable time ranges (1H, 6H, 24H, 3D, 7D).

### Reolink Camera with HLS Streaming
Live RTSP-to-HLS video streaming from a Reolink RLC-811A camera monitoring a koi pond. Supports PTZ (Pan/Tilt/Zoom) control, snapshots, stable (sub-stream copy, 0% CPU) and HD (720p transcode) modes, with automatic reconnection and a latency watchdog.

### AI-Powered Bird Detection
BirdNET-based acoustic bird detection using a local microphone. Detected species are logged with timestamps and audio clips, then enriched with AI-generated descriptions via the Claude API. Includes a leaderboard, Bird of the Day (BOTD), a searchable field guide with swipe gestures, and species activity heatmaps.

### Tuya Smart Device Control
Integration with Tuya-compatible devices:
- **Smart Dual Water Timer** -- two independently controllable valves (flower basket & koi pond) with countdown timers and server-side auto-off
- **Water Leak Sensor** -- dual-probe pond alarm with event logging
- **CO Alarm** -- carbon monoxide monitoring

### Weather Integration
NWS (National Weather Service) forecast data including current conditions, hourly/daily forecast, and computed sunrise/sunset times.

### Water Level Monitoring
Camera-based computer vision water level detection for the koi pond, with a calibration UI for ROI (Region of Interest) selection.

### Animated Garden Visualization
Canvas-rendered 3D isometric garden scene with animated sprites, day/night cycle based on sunrise/sunset, and a built-in sprite editor.

### Bilingual Support
All pages support English and Chinese via URL prefix (`/cn/...`). The TV display defaults to Chinese with Celsius.

## Pages

| Route | Description |
|-------|-------------|
| `/` | Main dashboard -- weather, sensors, charts, water timer, bird notifications |
| `/tv` | 1080p TV display -- large fonts, no emoji (for Linux/RPi5), auto-reconnecting camera |
| `/koi` | Koi pond camera -- HLS stream, PTZ controls, valve controls, motion events |
| `/bird` | Bird detection -- leaderboard, Bird of the Day, field guide with swipe gestures |
| `/water` | Water level -- calibration ROI tool, level history |
| `/edit` | Garden editor -- 3D sprite editor (dev tool) |

All pages are also available in Chinese at `/cn/...` (e.g., `/cn/tv`, `/cn/bird`).

## Setup

### Prerequisites

- **Node.js** >= 18
- **FFmpeg** (for RTSP-to-HLS camera streaming)
- **Python 3** + BirdNET (for bird detection, optional)
- A **SensorPush** account with sensors
- A **Tuya IoT Platform** developer account
- A **Reolink** camera (optional, for live streaming)
- An **Anthropic API key** (optional, for AI bird descriptions)

### Installation

```bash
git clone https://github.com/quake0day/sensorpush-dashboard.git
cd sensorpush-dashboard
npm install
```

### Configuration

Create a `.env` file in the project root:

```bash
# ---- SensorPush ----
# Create an account at https://www.sensorpush.com
# These are your SensorPush app login credentials
SENSORPUSH_EMAIL=your-email@example.com
SENSORPUSH_PASSWORD=your-password

# ---- Tuya IoT Platform ----
# Create a project at https://platform.tuya.com
# Go to Cloud > Development > your project > Overview for these credentials
TUYA_ACCESS_ID=your-tuya-access-id
TUYA_ACCESS_SECRET=your-tuya-access-secret
TUYA_BASE_URL=https://openapi.tuyaus.com    # US data center, change for other regions

# ---- Reolink Camera (optional) ----
# Local IP address and credentials of your Reolink camera
REOLINK_IP=192.168.1.100
REOLINK_USER=admin
REOLINK_PASSWORD=your-camera-password

# ---- Anthropic / Claude API (optional) ----
# For AI-generated bird species descriptions in the field guide
# Get your key at https://console.anthropic.com
ANTHROPIC_API_KEY=sk-ant-...

# ---- Server ----
PORT=3088
```

### Running

```bash
# Start the server
node server.js

# Or use npm
npm start
```

The dashboard will be available at `http://localhost:3088`.

### Production Deployment (Raspberry Pi)

The project includes systemd service files for auto-start and auto-deploy:

```bash
# Auto-deploy checks GitHub every 60 seconds for new commits
sudo systemctl enable sensorpush-autodeploy.timer
sudo systemctl start sensorpush-autodeploy.timer

# Main service
sudo systemctl enable sensorpush-dashboard
sudo systemctl start sensorpush-dashboard
```

## API Endpoints

### Sensors
| Endpoint | Description |
|----------|-------------|
| `GET /api/sensors` | List all SensorPush sensors |
| `POST /api/samples` | Get historical sensor data |
| `GET /api/gateways` | List SensorPush gateways |

### Weather
| Endpoint | Description |
|----------|-------------|
| `GET /api/weather` | NWS forecast + sunrise/sunset |

### Camera
| Endpoint | Description |
|----------|-------------|
| `GET /api/camera/status` | HLS stream status |
| `POST /api/camera/stream` | Switch quality (stable/hd) |
| `POST /api/camera/restart` | Restart HLS stream |
| `GET /api/camera/snap` | Take a snapshot |
| `POST /api/camera/ptz` | PTZ control |

### Water Timer
| Endpoint | Description |
|----------|-------------|
| `GET /api/timer/status` | Valve status and countdowns |
| `POST /api/timer/valve` | Control valve (on/off/countdown) |

### Bird Detection
| Endpoint | Description |
|----------|-------------|
| `GET /api/birds/latest` | Recent detections |
| `GET /api/birds/daily/:date` | Detections for a specific date |
| `GET /api/birds/stats` | Species statistics |
| `GET /api/birds/botd` | Bird of the Day |
| `GET /api/birds/detail/:name` | AI-generated species detail |
| `GET /api/birds/image/:name` | AI-generated species image |

### Water Level
| Endpoint | Description |
|----------|-------------|
| `GET /api/water/current` | Current water level reading |
| `GET /api/water/readings` | Historical readings |
| `GET /api/water/calibration` | Get calibration config |
| `POST /api/water/calibration` | Set calibration ROI |

## Tech Stack

- **Backend**: Node.js + Express
- **Frontend**: Vanilla JS + HTML/CSS (no build step)
- **Charts**: Chart.js
- **Streaming**: FFmpeg (RTSP to HLS)
- **Bird Detection**: BirdNET (Python) + Claude API
- **APIs**: SensorPush, Tuya Cloud, NWS, Anthropic

## License

MIT
