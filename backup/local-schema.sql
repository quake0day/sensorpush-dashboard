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

-- Bird name + short-description cache (Claude-generated, regenerable)
CREATE TABLE IF NOT EXISTS bird_translations (
  common_name TEXT PRIMARY KEY,
  scientific_name TEXT,
  cn_name TEXT NOT NULL,
  cn_name_pinyin TEXT,
  cn_desc TEXT,
  call_desc TEXT,
  call_desc_en TEXT,
  sound_url TEXT,
  translated_at TEXT
);

-- Bird field-guide details (Claude-generated, regenerable)
CREATE TABLE IF NOT EXISTS bird_details (
  common_name TEXT PRIMARY KEY,
  scientific_name TEXT,
  cn_name TEXT,
  order_en TEXT, order_cn TEXT,
  family_en TEXT, family_cn TEXT,
  genus_en TEXT,
  etymology_en TEXT, etymology_cn TEXT,
  description_en TEXT, description_cn TEXT,
  field_marks_en TEXT, field_marks_cn TEXT,
  similar_species_en TEXT, similar_species_cn TEXT,
  size_cm REAL, wingspan_cm REAL, weight_g REAL,
  diet TEXT, diet_cn TEXT,
  habitat TEXT, habitat_cn TEXT,
  migration_en TEXT, migration_cn TEXT,
  conservation TEXT, conservation_cn TEXT,
  fun_fact_en TEXT, fun_fact_cn TEXT,
  call_desc_en TEXT, call_desc_cn TEXT,
  generated_at TEXT
);
