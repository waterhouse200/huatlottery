#!/usr/bin/env node
// ─── scraper/scrape-fourd.js ── Walk all 4D draws and upsert to SQLite ─
//
// Usage:
//   node scraper/scrape-fourd.js                  # latest → FOURD_FLOOR (full)
//   node scraper/scrape-fourd.js --since N        # latest → max(N, FOURD_FLOOR)
//   node scraper/scrape-fourd.js --count 5        # only newest 5 draws
//
// Idempotent: re-running skips draws already in the DB. Draws that
// silently fall back to a different number (almost always the latest)
// are skipped, not inserted.

const { getDb, initSchema } = require("../db");
const { fetchDraw } = require("./fetch");
const { parseFourd } = require("./parse-fourd");
const { findLatest } = require("./findFloor");

// 4D draw #1 = Sat, 31 May 1986. Confirmed on the SP archive.
const FOURD_FLOOR = 1;

function parseArgs(argv) {
  const args = { since: null, count: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since")        args.since = parseInt(argv[++i], 10);
    else if (a === "--count")   args.count = parseInt(argv[++i], 10);
    else if (a === "-h" || a === "--help") {
      console.log("Usage: scrape-fourd.js [--since N | --count K]");
      process.exit(0);
    } else { console.error(`Unknown arg: ${a}`); process.exit(2); }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  const db = getDb();
  initSchema(db);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO fourd_draws
      (draw_no, draw_date, first_prize, second_prize, third_prize, starter_prizes, consolation_prizes)
    VALUES (@draw_no, @draw_date, @first_prize, @second_prize, @third_prize, @starter_prizes, @consolation_prizes)
  `);

  console.log("🔢 4D scraper starting…");

  const latest = await findLatest("fourd");
  console.log(`   Latest live draw: #${latest.draw_no} (${latest.draw_date})`);

  const floor = args.since != null ? Math.max(args.since, FOURD_FLOOR) : FOURD_FLOOR;
  const start = latest.draw_no;
  const end = args.count != null
    ? Math.max(floor, latest.draw_no - args.count + 1)
    : floor;

  console.log(`   Walking #${start} → #${end} (${start - end + 1} draws, ~${Math.round((start - end + 1) * 1.5)}s)`);

  let inserted = 0, skipped = 0, fallback = 0, parseFail = 0;
  for (let n = start; n >= end; n--) {
    const present = db.prepare("SELECT 1 FROM fourd_draws WHERE draw_no = ?").get(n);
    if (present) { skipped++; continue; }

    const html = await fetchDraw("fourd", n);
    const row  = parseFourd(html);
    if (!row) {
      console.warn(`     #${n}: parse failed — skipping`);
      parseFail++;
      continue;
    }
    if (row.draw_no !== n) {
      console.warn(`     #${n}: fallback to #${row.draw_no} — skipping`);
      fallback++;
      continue;
    }
    const r = insert.run({
      draw_no: row.draw_no,
      draw_date: row.draw_date,
      first_prize: row.first_prize,
      second_prize: row.second_prize,
      third_prize: row.third_prize,
      starter_prizes: JSON.stringify(row.starter_prizes),
      consolation_prizes: JSON.stringify(row.consolation_prizes),
    });
    if (r.changes) inserted++;
    console.log(`     #${n} (${row.draw_date}): 1st=${row.first_prize} 2nd=${row.second_prize} 3rd=${row.third_prize}`);
  }

  console.log(`\n   ✅ Done. inserted=${inserted}  already_present=${skipped}  fallback=${fallback}  parse_fail=${parseFail}`);
  db.close();
}

main().catch(err => { console.error(err); process.exit(1); });
