#!/usr/bin/env node
// Nightly sync: local SQLite + media files → D1 + R2, then apply retention.
// Idempotent and resumable — safe to run multiple times.

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const db = require("./lib/db");
const d1 = require("./lib/d1");
const r2 = require("./lib/r2");

const DATA_DIR = path.join(__dirname, "..", "data");
const BIRD_DIR = path.join(DATA_DIR, "bird-detections");
const MOTION_DIR = path.join(DATA_DIR, "motion-events");

const R2_RETENTION_DAYS = parseInt(process.env.R2_RETENTION_DAYS || "90", 10);
const LOCAL_RETENTION_DAYS = parseInt(process.env.LOCAL_RETENTION_DAYS || "0", 10); // 0 = keep forever
// D1 caps bound parameters per query around 100. Size batches so cols*rows stays under.
const D1_MAX_VARS = 90;
const batchSize = (cols) => Math.max(1, Math.floor(D1_MAX_VARS / cols));

function datePartsFromTimestamp(ts) {
  const d = new Date(ts);
  return {
    y: d.getUTCFullYear(),
    m: String(d.getUTCMonth() + 1).padStart(2, "0"),
    d: String(d.getUTCDate()).padStart(2, "0"),
  };
}

function r2KeyFor(kind, subdir, id, ext, timestamp) {
  const { y, m, d } = datePartsFromTimestamp(timestamp);
  return `${kind}/${subdir}/${y}/${m}/${d}/${id}${ext}`;
}

// ---------- 1. Import metadata from daily JSONs into local SQLite ----------

function importBirdDetections() {
  const dir = path.join(BIRD_DIR, "daily");
  if (!fs.existsSync(dir)) return 0;
  const stmt = db.get().prepare(`
    INSERT OR IGNORE INTO bird_detections
      (id, timestamp, time_iso, common_name, scientific_name, confidence, has_clip, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
  `);
  let n = 0;
  const tx = db.get().transaction((files) => {
    for (const f of files) {
      const rows = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      for (const r of rows) {
        const info = stmt.run(
          r.id, r.timestamp, r.time,
          r.common_name ?? null, r.scientific_name ?? null,
          r.confidence ?? null, r.has_clip ? 1 : 0
        );
        if (info.changes > 0) n++;
      }
    }
  });
  tx(fs.readdirSync(dir).filter(f => f.endsWith(".json")));
  return n;
}

function importMotionEvents() {
  const dir = path.join(MOTION_DIR, "daily");
  if (!fs.existsSync(dir)) return 0;
  const stmt = db.get().prepare(`
    INSERT OR IGNORE INTO motion_events
      (id, timestamp, time_iso, duration, motion_percent, best_class,
       best_confidence, animals, has_clip, has_thumb, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `);
  let n = 0;
  const tx = db.get().transaction((files) => {
    for (const f of files) {
      const rows = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      for (const r of rows) {
        const info = stmt.run(
          r.id, r.timestamp, r.time,
          r.duration ?? null, r.motion_percent ?? null,
          r.best_class ?? null, r.best_confidence ?? null,
          JSON.stringify(r.animals ?? []),
          r.has_clip ? 1 : 0, r.has_thumb ? 1 : 0
        );
        if (info.changes > 0) n++;
      }
    }
  });
  tx(fs.readdirSync(dir).filter(f => f.endsWith(".json")));
  return n;
}

// ---------- 2. Upload media files to R2 ----------

async function uploadMediaFor(row, localDir, kind, subdir, ext) {
  const localPath = path.join(localDir, row.id + ext);
  if (!fs.existsSync(localPath)) return null;
  const r2Key = r2KeyFor(kind, subdir, row.id, ext, row.timestamp);
  const existing = db.get()
    .prepare("SELECT r2_key FROM r2_uploads WHERE local_path = ?")
    .get(localPath);
  if (existing) return existing.r2_key;
  const size = await r2.uploadFile(localPath, r2Key);
  db.get()
    .prepare(`INSERT OR REPLACE INTO r2_uploads (local_path, r2_key, size, uploaded_at)
              VALUES (?, ?, ?, ?)`)
    .run(localPath, r2Key, size, Date.now());
  return r2Key;
}

async function uploadAllMedia() {
  let uploaded = 0;

  const birdClipsDir = path.join(BIRD_DIR, "clips");
  const birds = db.get().prepare(
    `SELECT id, timestamp, has_clip, clip_r2_key FROM bird_detections
     WHERE has_clip = 1 AND clip_r2_key IS NULL`
  ).all();
  for (const r of birds) {
    const key = await uploadMediaFor(r, birdClipsDir, "bird", "clips", ".mp3");
    if (key) {
      db.get().prepare("UPDATE bird_detections SET clip_r2_key = ? WHERE id = ?")
        .run(key, r.id);
      uploaded++;
    }
  }

  const motionClipsDir = path.join(MOTION_DIR, "clips");
  const motionThumbsDir = path.join(MOTION_DIR, "thumbs");
  const motions = db.get().prepare(
    `SELECT id, timestamp, has_clip, has_thumb, clip_r2_key, thumb_r2_key FROM motion_events
     WHERE (has_clip = 1 AND clip_r2_key IS NULL) OR (has_thumb = 1 AND thumb_r2_key IS NULL)`
  ).all();
  for (const r of motions) {
    if (r.has_clip && !r.clip_r2_key) {
      const key = await uploadMediaFor(r, motionClipsDir, "motion", "clips", ".mp4");
      if (key) {
        db.get().prepare("UPDATE motion_events SET clip_r2_key = ? WHERE id = ?")
          .run(key, r.id);
        uploaded++;
      }
    }
    if (r.has_thumb && !r.thumb_r2_key) {
      const key = await uploadMediaFor(r, motionThumbsDir, "motion", "thumbs", ".jpg");
      if (key) {
        db.get().prepare("UPDATE motion_events SET thumb_r2_key = ? WHERE id = ?")
          .run(key, r.id);
        uploaded++;
      }
    }
  }

  return uploaded;
}

// ---------- 3. Push unsynced rows to D1 ----------

async function chunked(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function pushSensorsToD1() {
  const rows = db.get().prepare(
    `SELECT sensor_id, timestamp, temperature_f, humidity, pressure_inhg,
            dewpoint_f, vpd, battery_v, rssi
     FROM sensor_readings WHERE synced_at IS NULL ORDER BY timestamp`
  ).all();
  if (!rows.length) return 0;
  const batches = await chunked(rows, batchSize(9));
  for (const batch of batches) {
    const placeholders = batch.map(() => "(?,?,?,?,?,?,?,?,?)").join(",");
    const sql = `INSERT OR IGNORE INTO sensor_readings
      (sensor_id, timestamp, temperature_f, humidity, pressure_inhg,
       dewpoint_f, vpd, battery_v, rssi) VALUES ${placeholders}`;
    const params = [];
    for (const r of batch) {
      params.push(r.sensor_id, r.timestamp, r.temperature_f, r.humidity,
        r.pressure_inhg, r.dewpoint_f, r.vpd, r.battery_v, r.rssi);
    }
    await d1.query(sql, params);
    const now = Date.now();
    const mark = db.get().prepare(
      "UPDATE sensor_readings SET synced_at = ? WHERE sensor_id = ? AND timestamp = ?"
    );
    const tx = db.get().transaction((b) => {
      for (const r of b) mark.run(now, r.sensor_id, r.timestamp);
    });
    tx(batch);
  }
  return rows.length;
}

async function pushBirdsToD1() {
  const rows = db.get().prepare(
    `SELECT id, timestamp, time_iso, common_name, scientific_name,
            confidence, has_clip, clip_r2_key
     FROM bird_detections WHERE synced_at IS NULL ORDER BY timestamp`
  ).all();
  if (!rows.length) return 0;
  const batches = await chunked(rows, batchSize(8));
  for (const batch of batches) {
    const placeholders = batch.map(() => "(?,?,?,?,?,?,?,?)").join(",");
    const sql = `INSERT OR REPLACE INTO bird_detections
      (id, timestamp, time_iso, common_name, scientific_name,
       confidence, has_clip, clip_r2_key) VALUES ${placeholders}`;
    const params = [];
    for (const r of batch) {
      params.push(r.id, r.timestamp, r.time_iso, r.common_name,
        r.scientific_name, r.confidence, r.has_clip, r.clip_r2_key);
    }
    await d1.query(sql, params);
    const now = Date.now();
    const mark = db.get().prepare(
      "UPDATE bird_detections SET synced_at = ? WHERE id = ?"
    );
    const tx = db.get().transaction((b) => { for (const r of b) mark.run(now, r.id); });
    tx(batch);
  }
  return rows.length;
}

async function pushMotionsToD1() {
  const rows = db.get().prepare(
    `SELECT id, timestamp, time_iso, duration, motion_percent, best_class,
            best_confidence, animals, has_clip, has_thumb, clip_r2_key, thumb_r2_key
     FROM motion_events WHERE synced_at IS NULL ORDER BY timestamp`
  ).all();
  if (!rows.length) return 0;
  const batches = await chunked(rows, batchSize(12));
  for (const batch of batches) {
    const placeholders = batch.map(() => "(?,?,?,?,?,?,?,?,?,?,?,?)").join(",");
    const sql = `INSERT OR REPLACE INTO motion_events
      (id, timestamp, time_iso, duration, motion_percent, best_class,
       best_confidence, animals, has_clip, has_thumb, clip_r2_key, thumb_r2_key)
      VALUES ${placeholders}`;
    const params = [];
    for (const r of batch) {
      params.push(r.id, r.timestamp, r.time_iso, r.duration, r.motion_percent,
        r.best_class, r.best_confidence, r.animals,
        r.has_clip, r.has_thumb, r.clip_r2_key, r.thumb_r2_key);
    }
    await d1.query(sql, params);
    const now = Date.now();
    const mark = db.get().prepare(
      "UPDATE motion_events SET synced_at = ? WHERE id = ?"
    );
    const tx = db.get().transaction((b) => { for (const r of b) mark.run(now, r.id); });
    tx(batch);
  }
  return rows.length;
}

// ---------- 4. Retention ----------

async function applyRetention() {
  const cutoff = Date.now() - R2_RETENTION_DAYS * 86400000;
  const stale = db.get().prepare(
    `SELECT local_path, r2_key FROM r2_uploads WHERE uploaded_at < ?`
  ).all(cutoff);

  let deletedR2 = 0, deletedLocal = 0;
  for (const u of stale) {
    try {
      await r2.deleteObject(u.r2_key);
      deletedR2++;
    } catch (e) {
      console.warn("[retention] R2 delete failed for", u.r2_key, e.message);
      continue;
    }
    db.get().prepare("DELETE FROM r2_uploads WHERE local_path = ?").run(u.local_path);
    // Null out the r2 key refs (metadata stays, just no clip)
    db.get().prepare("UPDATE bird_detections SET clip_r2_key = NULL WHERE clip_r2_key = ?").run(u.r2_key);
    db.get().prepare("UPDATE motion_events SET clip_r2_key = NULL WHERE clip_r2_key = ?").run(u.r2_key);
    db.get().prepare("UPDATE motion_events SET thumb_r2_key = NULL WHERE thumb_r2_key = ?").run(u.r2_key);
  }

  if (LOCAL_RETENTION_DAYS > 0) {
    const localCutoff = Date.now() - LOCAL_RETENTION_DAYS * 86400000;
    for (const dir of [
      path.join(MOTION_DIR, "clips"),
      path.join(MOTION_DIR, "thumbs"),
      path.join(BIRD_DIR, "clips"),
    ]) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        const fp = path.join(dir, f);
        const st = fs.statSync(fp);
        if (st.mtimeMs < localCutoff) {
          fs.unlinkSync(fp);
          deletedLocal++;
        }
      }
    }
  }

  return { deletedR2, deletedLocal };
}

// ---------- Main ----------

async function main() {
  const t0 = Date.now();
  console.log(`[sync] start ${new Date().toISOString()}`);

  db.applySchema();

  const importedBirds = importBirdDetections();
  const importedMotions = importMotionEvents();
  console.log(`[sync] imported ${importedBirds} bird + ${importedMotions} motion from JSON`);

  const uploaded = await uploadAllMedia();
  console.log(`[sync] uploaded ${uploaded} media file(s) to R2`);

  const s = await pushSensorsToD1();
  const b = await pushBirdsToD1();
  const m = await pushMotionsToD1();
  console.log(`[sync] pushed to D1: ${s} sensor, ${b} bird, ${m} motion rows`);

  const { deletedR2, deletedLocal } = await applyRetention();
  console.log(`[sync] retention: deleted ${deletedR2} from R2, ${deletedLocal} local files`);

  console.log(`[sync] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch(e => {
  console.error("[sync] failed:", e);
  process.exit(1);
});
