// ─── scraper/my/backfill-cashsweep.js ────────────────────────────────────────
// Deep backfill of Sarawak Special CashSweep from the operator's own JSON API,
// which is keyed by draw NUMBER (not date) and reaches back to draw 141 —
// 1996-01-07. Draw 140 and below return 404, so 141 is the archive floor.
//
//   GET https://www.cashsweep.my/api/results/draw/number/<n>
//   -> {"dn":141,"d":"1996-01-07T00:00:00","n":{"1":2629,"2":8032,"3":1251,...}}
//
// Payload mapping, verified by fetching draw 5300 and diffing it against our own
// scraped row for 2026-06-07 (top three identical, both prize tiers identical):
//   n[1..3]   = 1st / 2nd / 3rd
//   n[9..18]  = 10 special prizes
//   n[19..28] = 10 consolation prizes
//   n[4,5,6]  = derived 2-/3-digit forms — ignored
// Values arrive as integers, so they need zero-padding back to 4 digits.
//
// The API returns sporadic 404s when pushed, so a 404 is retried once before it
// is believed. INSERT OR IGNORE: live scraper rows always win.
//
// Usage: node scraper/my/backfill-cashsweep.js [fromDraw] [toDraw] [delayMs]
const path = require("path");
const Database = require("better-sqlite3");

const DB = path.join(__dirname, "..", "..", "huatlottery.db");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";
const API = (n) => `https://www.cashsweep.my/api/results/draw/number/${n}`;
const FLOOR = 141;

const from = +(process.argv[2] || FLOOR);
const to = +(process.argv[3] || 0);          // 0 = walk up until we run out
const delay = +(process.argv[4] || 1200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad4 = (v) => (Number.isInteger(v) && v >= 0 ? String(v).padStart(4, "0") : null);

async function getDraw(n) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(API(n), { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
      if (res.status === 404) { if (attempt === 0) { await sleep(1500); continue; } return null; }
      if (!res.ok) { await sleep(1500); continue; }
      const j = await res.json();
      if (!j || !j.d || !j.n) return null;
      const n1 = j.n;
      const pick = (a, b) => { const out = []; for (let k = a; k <= b; k++) { const v = pad4(n1[String(k)]); if (v) out.push(v); } return out; };
      return {
        draw_date: String(j.d).slice(0, 10),
        first: pad4(n1["1"]), second: pad4(n1["2"]), third: pad4(n1["3"]),
        special: pick(9, 18), consolation: pick(19, 28),
      };
    } catch { await sleep(1500); }
  }
  return null;
}

(async () => {
  const db = new Database(DB);
  const ins = db.prepare(
    "INSERT OR IGNORE INTO my_draws (operator,draw_date,first_prize,second_prize,third_prize,special_prizes,consolation_prizes,source) VALUES (?,?,?,?,?,?,?,?)"
  );
  let added = 0, seen = 0, misses = 0;
  const t0 = Date.now();

  for (let n = from; to ? n <= to : true; n++) {
    const d = await getDraw(n);
    if (!d) {
      if (++misses >= 12) { console.log(`stopping: ${misses} consecutive misses at draw ${n}`); break; }
      await sleep(delay);
      continue;
    }
    misses = 0; seen++;
    if (d.first) {
      const r = ins.run("sarawak", d.draw_date, d.first, d.second, d.third,
        JSON.stringify(d.special), JSON.stringify(d.consolation), "cashsweep-api");
      added += r.changes;
    }
    if (seen % 200 === 0) {
      console.log(`  draw ${n} (${d.draw_date}) · ${seen} fetched · ${added} added · ${Math.round((Date.now() - t0) / 60000)}min`);
      db.pragma("wal_checkpoint(TRUNCATE)");
    }
    await sleep(delay);
  }

  const row = db.prepare("SELECT COUNT(*) c, MIN(draw_date) a, MAX(draw_date) b FROM my_draws WHERE operator='sarawak'").get();
  console.log(`DONE: ${seen} fetched, ${added} added in ${Math.round((Date.now() - t0) / 60000)}min`);
  console.log(`sarawak now: ${row.c} draws, ${row.a} -> ${row.b}`);
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
