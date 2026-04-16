const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DB_PATH = process.env.BACKUP_DB_PATH ||
  path.join(__dirname, "..", "..", "data", "backup.db");

let db = null;

function get() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  return db;
}

function applySchema() {
  const sql = fs.readFileSync(
    path.join(__dirname, "..", "local-schema.sql"),
    "utf8"
  );
  get().exec(sql);
}

module.exports = { get, applySchema, DB_PATH };
