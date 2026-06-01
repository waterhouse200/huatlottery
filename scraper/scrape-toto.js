#!/usr/bin/env node
// ─── scraper/scrape-toto.js ── Walk all TOTO draws and upsert to SQLite ─
//
// Usage:
//   node scraper/scrape-toto.js                  # latest → TOTO_FLOOR (full)
//   node scraper/scrape-toto.js --since N        # latest → max(N, TOTO_FLOOR)
//   node scraper/scrape-toto.js --count 5        # only newest 5 draws
//
// The scraper is idempotent: re-running skips draws already in the DB
// (via the UNIQUE constraint on draw_no). Draws that silently fall back
// to the latest (returned draw_no ≠ requested) are skipped, not inserted.

const { getDb, initSchema } = require("../db");
const { fetchDraw } = require("./fetch");
const { parseToto } = require("./parse-toto");
const { findLatest } = require("./findFloor");

// Empirically determined: the SP archive exposes TOTO from draw #40 onwards.
// Draws #1–#39 silently fall back to the latest draw.
const TOTO_FLOOR = 40;

function parseArgs(argv) {
  const args = { since: null, count: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--since")        args.since = parseInt(argv[++i], 10);
    else if (a === "--count")   args.count = parseInt(argv[++i], 10);
    else if (a === "-h" || a === "--help") {
      console.log("Usage: scrape-toto.js [--since N | --count K]");
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
    INSERT OR IGNORE INTO toto_draws
      (draw_no, draw_date, num1, num2, num3, num4, num5, num6, additional_num)
    VALUES (@draw_no, @draw_date, @num1, @num2, @num3, @num4, @num5, @num6, @additional_num)
  `);

  console.log("🎰 TOTO scraper starting…");

  const latest = await findLatest("toto");
  console.log(`   Latest live draw: #${latest.draw_no} (${latest.draw_date || "no date"})`);

  const floor = args.since != null ? Math.max(args.since, TOTO_FLOOR) : TOTO_FLOOR;
  const start = latest.draw_no;
  const end = args.count != null
    ? Math.max(floor, latest.draw_no - args.count + 1)
    : floor;

  console.log(`   Walking #${start} → #${end} (${start - end + 1} draws, ~${Math.round((start - end + 1) * 1.5)}s)`);

  let inserted = 0, skipped = 0, fallback = 0, parseFail = 0;
  for (let n = start; n >= end; n--) {
    const present = db.prepare("SELECT 1 FROM toto_draws WHERE draw_no = ?").get(n);
    if (present) { skipped++; continue; }

    const html = await fetchDraw("toto", n);
    const row  = parseToto(html);
    if (!row) {
      console.warn(`     #${n}: parse failed — skipping`);
      parseFail++;
      continue;
    }
    if (row.draw_no !== n) {
      // SP silently returned a different draw (almost always the latest).
      console.warn(`     #${n}: fallback to #${row.draw_no} — skipping`);
      fallback++;
      continue;
    }
    const r = insert.run({
      draw_no: row.draw_no,
      draw_date: row.draw_date,                   // may be null for pre-1997
      num1: row.nums[0], num2: row.nums[1], num3: row.nums[2],
      num4: row.nums[3], num5: row.nums[4],
      num6: row.nums[5] ?? null,                  // null for 5/49 era
      additional_num: row.additional_num,
    });
    if (r.changes) inserted++;
    const dateStr = row.draw_date || "no-date";
    console.log(`     #${n} (${dateStr}): ${row.nums.join(" ")} + ${row.additional_num}`);
  }

  console.log(`\n   ✅ Done. inserted=${inserted}  already_present=${skipped}  fallback=${fallback}  parse_fail=${parseFail}`);
  db.close();
}

main().catch(err => { console.error(err); process.exit(1); });
