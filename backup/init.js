#!/usr/bin/env node
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const db = require("./lib/db");
const d1 = require("./lib/d1");
const fs = require("fs");
const path = require("path");

async function main() {
  console.log("[init] applying local schema to", db.DB_PATH);
  db.applySchema();
  console.log("[init] local OK");

  console.log("[init] applying D1 schema");
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  const stmts = sql
    .split("\n")
    .filter(l => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map(s => s.trim())
    .filter(Boolean);
  for (const s of stmts) {
    await d1.query(s);
    console.log("  [OK]", s.replace(/\s+/g, " ").slice(0, 70));
  }
  console.log("[init] done");
}

main().catch(e => {
  console.error("[init] failed:", e);
  process.exit(1);
});
