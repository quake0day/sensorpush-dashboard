-- Local SQLite buffer on the server.
-- Mirrors the D1 schema plus a synced_at column so sync.js knows what to push.

CREATE TABLE IF NOT EXISTS sensor_readings (
  sensor_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  temperature_f REAL,
  humidity REAL,
  pressure_inhg REAL,
  dewpoint_f REAL,
  vpd REAL,
  battery_v REAL,
  rssi INTEGER,
  synced_at INTEGER,
  PRIMARY KEY (sensor_id, timestamp)
);
CREATE INDEX IF NOT EXISTS idx_sensor_unsynced ON sensor_readings(synced_at);

CREATE TABLE IF NOT EXISTS bird_detections (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  time_iso TEXT NOT NULL,
  common_name TEXT,
  scientific_name TEXT,
  confidence REAL,
  has_clip INTEGER,
  clip_r2_key TEXT,
  synced_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bird_unsynced ON bird_detections(synced_at);

CREATE TABLE IF NOT EXISTS motion_events (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  time_iso TEXT NOT NULL,
  duration INTEGER,
  motion_percent REAL,
  best_class TEXT,
  best_confidence REAL,
  animals TEXT,
  has_clip INTEGER,
  has_thumb INTEGER,
  clip_r2_key TEXT,
  thumb_r2_key TEXT,
  synced_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_motion_unsynced ON motion_events(synced_at);

-- Upload log: tracks which local files have been pushed to R2
CREATE TABLE IF NOT EXISTS r2_uploads (
  local_path TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL,
  size INTEGER,
  uploaded_at INTEGER NOT NULL
);
