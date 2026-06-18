// ─── db.js ── Database connection & schema ───────────────────────────
const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.join(__dirname, "huatlottery.db");

function getDb() {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function initSchema(db) {
  db.exec(`
    ---------------------------------------------------------------
    -- TOTO draws: 5 or 6 main numbers (1-49) + 1 additional number.
    -- num6 is NULL for the original 5/49 era (~draws #40-#???).
    -- draw_date is NULL for early draws whose page lacks a real date.
    ---------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS toto_draws (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      draw_no       INTEGER NOT NULL UNIQUE,
      draw_date     TEXT,                       -- ISO 8601 date, NULL for placeholder-date draws
      num1          INTEGER NOT NULL CHECK(num1 BETWEEN 1 AND 49),
      num2          INTEGER NOT NULL CHECK(num2 BETWEEN 1 AND 49),
      num3          INTEGER NOT NULL CHECK(num3 BETWEEN 1 AND 49),
      num4          INTEGER NOT NULL CHECK(num4 BETWEEN 1 AND 49),
      num5          INTEGER NOT NULL CHECK(num5 BETWEEN 1 AND 49),
      num6          INTEGER          CHECK(num6 IS NULL OR num6 BETWEEN 1 AND 49),
      additional_num INTEGER NOT NULL CHECK(additional_num BETWEEN 1 AND 49),
      created_at    TEXT    DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_toto_draw_date ON toto_draws(draw_date DESC);
    CREATE INDEX IF NOT EXISTS idx_toto_draw_no   ON toto_draws(draw_no   DESC);

    ---------------------------------------------------------------
    -- 4D draws: 1st/2nd/3rd prize + 10 starters + 10 consolations
    ---------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS fourd_draws (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      draw_no           INTEGER NOT NULL UNIQUE,
      draw_date         TEXT    NOT NULL,
      first_prize       TEXT    NOT NULL CHECK(length(first_prize)  = 4),
      second_prize      TEXT    NOT NULL CHECK(length(second_prize) = 4),
      third_prize       TEXT    NOT NULL CHECK(length(third_prize)  = 4),
      starter_prizes    TEXT    NOT NULL,       -- JSON array of 10 strings
      consolation_prizes TEXT   NOT NULL,       -- JSON array of 10 strings
      created_at        TEXT    DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_fourd_draw_date ON fourd_draws(draw_date DESC);
    CREATE INDEX IF NOT EXISTS idx_fourd_draw_no   ON fourd_draws(draw_no   DESC);

    ---------------------------------------------------------------
    -- Next-draw sentinel (one row per game). Read from Singapore Pools'
    -- pregenerated next-draw file. next_draw_at is the exact SGT moment
    -- the upcoming draw is scheduled — always AHEAD of "now" when caught up.
    -- The poller arms at next_draw_at and stops once next_draw_no is captured.
    ---------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS next_draws (
      game           TEXT PRIMARY KEY,          -- 'toto' | 'fourd'
      next_draw_no   INTEGER,                   -- latest result_no + 1
      next_draw_date TEXT,                       -- ISO date (SGT)
      next_draw_time TEXT,                        -- HH:MM (SGT, 24h)
      next_draw_at   TEXT,                        -- ISO 8601 w/ +08:00 — the exact moment
      raw            TEXT,                        -- raw "Mon, 22 Jun 2026, 6.30pm"
      updated_at     TEXT DEFAULT (datetime('now'))
    );
  `);
}

module.exports = { getDb, initSchema, DB_PATH };
