-- D1 schema (source of truth for long-term metadata)
-- Applied via: node backup/init.js

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
  PRIMARY KEY (sensor_id, timestamp)
);
CREATE INDEX IF NOT EXISTS idx_sensor_ts ON sensor_readings(timestamp);

CREATE TABLE IF NOT EXISTS bird_detections (
  id TEXT PRIMARY KEY,
  timestamp INTEGER NOT NULL,
  time_iso TEXT NOT NULL,
  common_name TEXT,
  scientific_name TEXT,
  confidence REAL,
  has_clip INTEGER,
  clip_r2_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_bird_ts ON bird_detections(timestamp);
CREATE INDEX IF NOT EXISTS idx_bird_species ON bird_detections(common_name);

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
  thumb_r2_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_motion_ts ON motion_events(timestamp);
