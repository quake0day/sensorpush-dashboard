# SensorPush Dashboard

A smart home monitoring dashboard that aggregates IoT sensor data and smart device controls from SensorPush and Tuya into a unified web interface.

## Features

- **SensorPush Sensors** - Real-time temperature, humidity, dew point, VPD, and barometric pressure monitoring across multiple sensors
- **Tuya Smart Devices** - Water leak sensor monitoring with alarm detection, garage door status tracking
- **Interactive Charts** - Historical data visualization with selectable time ranges (1H, 6H, 24H, 3D, 7D)
- **Auto-refresh** - Data updates every 2 minutes
- **Dark Theme UI** - Clean, color-coded metrics display

## Tech Stack

- **Backend**: Node.js + Express
- **Frontend**: Vanilla JS + HTML/CSS
- **Charts**: Chart.js
- **APIs**: SensorPush Cloud API, Tuya Cloud API

## Setup

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your credentials:
#   SENSORPUSH_EMAIL, SENSORPUSH_PASSWORD
#   TUYA_ACCESS_ID, TUYA_ACCESS_SECRET

# Start server
node server.js
```

The dashboard runs on `http://localhost:3088` by default.

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/sensors` | List all SensorPush sensors |
| `GET /api/samples` | Get sensor historical data |
| `GET /api/tuya/devices` | List Tuya smart devices |
| `GET /api/tuya/device/:id/status` | Get device status |
| `GET /api/tuya/device/:id/logs` | Get device event logs |
