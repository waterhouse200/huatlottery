// ─── scraper/my/backfill-sabah-file.js ───────────────────────────────────────
// One-shot deep backfill of Sabah 88 4D from a public bulk CSV
// (rouze-d/Malaysia-4D-Prediction), which covers 2001-12-15 onward — the whole
// life of the Sabah 88 4D game, which started 15 Dec 2001.
//
// Column layout (verified against our own scraped rows for 2026-02-11, where
// the top three matched exactly and both prize tiers contained the identical
// ten numbers): Draw_Date, 01=1st, 02=2nd, 03=3rd, 04..13=special, 14..23=consolation.
//
// INSERT OR IGNORE: rows the live scraper already stored always win, so running
// this can only add history, never rewrite today's results.
//
// Usage: node scraper/my/backfill-sabah-file.js
const path = require("path");
const Database = require("better-sqlite3");

const SRC = "https://raw.githubusercontent.com/rouze-d/Malaysia-4D-Prediction/main/2001-2026-88.txt";
const DB = path.join(__dirname, "..", "..", "huatlottery.db");
const pad4 = (s) => {
  const t = String(s == null ? "" : s).trim();
  return /^\d{1,4}$/.test(t) ? t.padStart(4, "0") : null;
};

(async () => {
  const res = await fetch(SRC, { headers: { "User-Agent": "huatlottery-backfill" } });
  if (!res.ok) throw new Error(`source returned HTTP ${res.status}`);
  const lines = (await res.text()).split(/\r?\n/).filter(Boolean);
  const header = lines.shift();
  if (!/^Draw_Date/i.test(header)) throw new Error("unexpected header: " + header.slice(0, 60));

  const db = new Database(DB);
  const ins = db.prepare(
    "INSERT OR IGNORE INTO my_draws (operator,draw_date,first_prize,second_prize,third_prize,special_prizes,consolation_prizes,source) VALUES (?,?,?,?,?,?,?,?)"
  );

  let added = 0, skipped = 0, malformed = 0;
  db.transaction(() => {
    for (const line of lines) {
      const c = line.split(",");
      if (c.length < 24) { malformed++; continue; }
      const date = c[0].trim();
      const first = pad4(c[1]), second = pad4(c[2]), third = pad4(c[3]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !first) { malformed++; continue; }
      const special = c.slice(4, 14).map(pad4).filter(Boolean);
      const consol = c.slice(14, 24).map(pad4).filter(Boolean);
      const r = ins.run("sabah", date, first, second, third,
        JSON.stringify(special), JSON.stringify(consol), "github:rouze-d");
      r.changes ? added++ : skipped++;
    }
  })();

  const row = db.prepare("SELECT COUNT(*) c, MIN(draw_date) a, MAX(draw_date) b FROM my_draws WHERE operator='sabah'").get();
  console.log(`parsed ${lines.length} rows — added ${added}, already present ${skipped}, malformed ${malformed}`);
  console.log(`sabah now: ${row.c} draws, ${row.a} -> ${row.b}`);
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
