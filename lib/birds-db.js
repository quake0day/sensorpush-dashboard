// SQLite-backed cache for bird translations + field-guide details.
// Reuses the existing backup.db so we share schema/backups with the rest of
// the app. Connection is opened lazily and held for the lifetime of the
// process; better-sqlite3 is fully synchronous, so no pool needed.

const Database = require("better-sqlite3");
const path = require("path");
const os = require("os");
const fs = require("fs");

const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), "sensorpush-data");
const DB_PATH = process.env.BACKUP_DB_PATH || path.join(DATA_DIR, "backup.db");

let db = null;

function get() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(`
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
  `);
  return db;
}

const TRANS_COLS = [
  "common_name","scientific_name","cn_name","cn_name_pinyin","cn_desc",
  "call_desc","call_desc_en","sound_url","translated_at",
];

const DETAIL_COLS = [
  "common_name","scientific_name","cn_name",
  "order_en","order_cn","family_en","family_cn","genus_en",
  "etymology_en","etymology_cn","description_en","description_cn",
  "field_marks_en","field_marks_cn","similar_species_en","similar_species_cn",
  "size_cm","wingspan_cm","weight_g",
  "diet","diet_cn","habitat","habitat_cn",
  "migration_en","migration_cn","conservation","conservation_cn",
  "fun_fact_en","fun_fact_cn","call_desc_en","call_desc_cn",
  "generated_at",
];

function upsertSql(table, cols) {
  const updates = cols.filter(c => c !== "common_name").map(c => `${c}=excluded.${c}`).join(",");
  return `INSERT INTO ${table}(${cols.join(",")}) VALUES (${cols.map(()=>"?").join(",")})
          ON CONFLICT(common_name) DO UPDATE SET ${updates}`;
}

let _stmts = null;
function stmts() {
  if (_stmts) return _stmts;
  const d = get();
  _stmts = {
    upsertTrans: d.prepare(upsertSql("bird_translations", TRANS_COLS)),
    getTrans: d.prepare("SELECT * FROM bird_translations WHERE common_name = ?"),
    getAllTrans: d.prepare("SELECT * FROM bird_translations"),
    delTrans: d.prepare("DELETE FROM bird_translations WHERE common_name = ?"),
    upsertDetail: d.prepare(upsertSql("bird_details", DETAIL_COLS)),
    getDetail: d.prepare("SELECT * FROM bird_details WHERE common_name = ?"),
    delDetail: d.prepare("DELETE FROM bird_details WHERE common_name = ?"),
  };
  return _stmts;
}

function pick(obj, cols) {
  return cols.map(c => obj[c] === undefined ? null : obj[c]);
}

function upsertTranslation(entry) {
  if (!entry || !entry.common_name || !entry.cn_name) {
    throw new Error("upsertTranslation: common_name + cn_name required");
  }
  stmts().upsertTrans.run(...pick(entry, TRANS_COLS));
}

function getTranslation(name) {
  return stmts().getTrans.get(name) || null;
}

function getAllTranslations() {
  const rows = stmts().getAllTrans.all();
  const out = {};
  for (const r of rows) out[r.common_name] = r;
  return out;
}

function deleteTranslation(name) {
  stmts().delTrans.run(name);
}

function upsertDetail(entry) {
  if (!entry || !entry.common_name) throw new Error("upsertDetail: common_name required");
  stmts().upsertDetail.run(...pick(entry, DETAIL_COLS));
}

function getDetail(name) {
  return stmts().getDetail.get(name) || null;
}

function deleteDetail(name) {
  stmts().delDetail.run(name);
}

// Run multiple writes in one transaction. Use for bulk operations like
// regenerate-all so a crash mid-way leaves the DB in a coherent state.
function transaction(fn) {
  return get().transaction(fn);
}

module.exports = {
  upsertTranslation, getTranslation, getAllTranslations, deleteTranslation,
  upsertDetail, getDetail, deleteDetail,
  transaction,
  TRANS_COLS, DETAIL_COLS,
  _DB_PATH: DB_PATH,
};
