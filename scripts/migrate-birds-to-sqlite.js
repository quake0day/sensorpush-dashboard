#!/usr/bin/env node
// One-shot migration: read translations.json + details/*.json into SQLite.
// Backs the JSON tree up to *.bak first. Does NOT delete originals — verify
// the DB is good before removing them by hand.

const fs = require("fs");
const path = require("path");
const os = require("os");
const birdsDb = require("../lib/birds-db");

const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), "sensorpush-data");
const BIRD_DIR = path.join(DATA_DIR, "bird-detections");
const TRANS_FILE = path.join(BIRD_DIR, "translations.json");
const DETAILS_DIR = path.join(BIRD_DIR, "details");

function backupOnce(src, dst) {
  if (!fs.existsSync(src)) return false;
  if (fs.existsSync(dst)) {
    console.log(`backup already exists: ${dst} (skipping copy)`);
    return true;
  }
  fs.cpSync(src, dst, { recursive: true });
  console.log(`backed up ${src} -> ${dst}`);
  return true;
}

const stats = { translations: 0, details: 0, skipped: 0, errors: [] };

// 1. Backups
backupOnce(TRANS_FILE, TRANS_FILE + ".bak");
backupOnce(DETAILS_DIR, DETAILS_DIR + ".bak");

// 2. Translations
if (fs.existsSync(TRANS_FILE)) {
  const trans = JSON.parse(fs.readFileSync(TRANS_FILE, "utf8"));
  const tx = birdsDb.transaction(() => {
    for (const [name, t] of Object.entries(trans)) {
      try {
        if (!t || !t.cn_name) { stats.skipped++; continue; }
        birdsDb.upsertTranslation({ ...t, common_name: name });
        stats.translations++;
      } catch (e) {
        stats.errors.push({ name, type: "translation", err: e.message });
      }
    }
  });
  tx();
} else {
  console.log(`no translations file at ${TRANS_FILE}`);
}

// 3. Details
if (fs.existsSync(DETAILS_DIR)) {
  const files = fs.readdirSync(DETAILS_DIR).filter(f => f.endsWith(".json"));
  const tx = birdsDb.transaction(() => {
    for (const f of files) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(DETAILS_DIR, f), "utf8"));
        if (!d.common_name) { stats.skipped++; continue; }
        birdsDb.upsertDetail(d);
        stats.details++;
      } catch (e) {
        stats.errors.push({ file: f, type: "detail", err: e.message });
      }
    }
  });
  tx();
} else {
  console.log(`no details dir at ${DETAILS_DIR}`);
}

console.log(JSON.stringify(stats, null, 2));
console.log(`db: ${birdsDb._DB_PATH}`);
