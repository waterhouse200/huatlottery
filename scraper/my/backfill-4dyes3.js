// ─── scraper/my/backfill-4dyes3.js ───────────────────────────────────────────
// Multi-operator historical backfill. One request per DATE returns every
// operator for that day, which makes this the cheapest way to deepen the
// secondary operators (Sandakan, Grand Dragon, Lucky Hari Hari, Perdana) that
// have no bulk dataset of their own.
//
//   GET https://4dyes3.com/getLiveResult.php?date=YYYY-MM-DD
//   -> { "H": {"Name":"GDLotto","_1":["2071"],"_2":[..],"_3":[..],
//              "C":[10 consolation], "_P":[specials, "----" for empty]}, ... }
//
// Mapping verified by diffing the 2026-08-02 GDLotto record against the row we
// had already scraped independently: 1st/2nd/3rd and both prize tiers matched
// exactly, in order.
//
// IMPORTANT: the API answers for ANY date, returning "----" placeholders where
// it has no data — so a response is not evidence a draw happened. Rows whose
// 1st prize is "----" are skipped, otherwise this would invent draws for years
// before an operator existed (GD Lotto launched 2017, Perdana and Lucky Hari
// Hari 2018). Never relax that check.
//
// Throttle: the host returns a 3-byte body when pushed, so keep >=6s spacing.
// INSERT OR IGNORE — live scraper rows always win.
//
// Usage: node scraper/my/backfill-4dyes3.js <fromDate> <toDate> [delayMs]
//   e.g. node scraper/my/backfill-4dyes3.js 2016-01-01 2026-02-07 6500
const path = require("path");
const Database = require("better-sqlite3");

const DB = path.join(__dirname, "..", "..", "huatlottery.db");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";
// 4dyes3 key -> our canonical operator id. Only the ones we store.
const OP = { M: "magnum", P: "damacai", T: "sportstoto", B: "sabah", K: "sandakan", W: "sarawak", H: "grandragon", N: "perdana", R: "lucky" };

const from = process.argv[2], to = process.argv[3];
const delay = +(process.argv[4] || 6500);
if (!/^\d{4}-\d{2}-\d{2}$/.test(from || "") || !/^\d{4}-\d{2}-\d{2}$/.test(to || "")) {
  console.error("usage: node scraper/my/backfill-4dyes3.js <fromDate> <toDate> [delayMs]");
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (arr) => (Array.isArray(arr) ? arr.filter((x) => x && x !== "----" && /^\d{3,4}$/.test(x)) : []);
const one = (arr) => { const c = clean(arr); return c.length ? c[0] : null; };

async function fetchDate(ds) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`https://4dyes3.com/getLiveResult.php?date=${ds}`, {
        headers: { "User-Agent": UA, Referer: "https://4dyes3.com/" },
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) { await sleep(4000); continue; }
      const txt = await res.text();
      if (txt.length < 20) { await sleep(6000); continue; }   // throttled stub
      return JSON.parse(txt);
    } catch { await sleep(4000); }
  }
  return null;
}

(async () => {
  const db = new Database(DB);
  const ins = db.prepare(
    "INSERT OR IGNORE INTO my_draws (operator,draw_date,first_prize,second_prize,third_prize,special_prizes,consolation_prizes,source) VALUES (?,?,?,?,?,?,?,?)"
  );
  const start = new Date(from + "T00:00:00Z"), end = new Date(to + "T00:00:00Z");
  const totalDays = Math.round((end - start) / 864e5) + 1;
  let days = 0, added = 0, empty = 0;
  const per = {};
  const t0 = Date.now();

  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const ds = d.toISOString().slice(0, 10);
    const j = await fetchDate(ds);
    days++;
    if (!j) { empty++; await sleep(delay); continue; }

    for (const [key, op] of Object.entries(OP)) {
      const blk = j[key];
      if (!blk || typeof blk !== "object") continue;
      const first = one(blk._1);
      if (!first) continue;                       // "----" => no draw; never invent one
      const r = ins.run(op, ds, first, one(blk._2), one(blk._3),
        JSON.stringify(clean(blk._P)), JSON.stringify(clean(blk.C)), "4dyes3");
      if (r.changes) { added++; per[op] = (per[op] || 0) + 1; }
    }
    if (days % 100 === 0) {
      console.log(`  ${ds} · ${days}/${totalDays} days · ${added} added · ${Math.round((Date.now() - t0) / 60000)}min`);
      db.pragma("wal_checkpoint(TRUNCATE)");
    }
    await sleep(delay);
  }

  console.log(`DONE: ${days} days, ${added} draws added (${empty} unreachable) in ${Math.round((Date.now() - t0) / 60000)}min`);
  for (const [op, n] of Object.entries(per).sort((a, b) => b[1] - a[1])) console.log(`  ${op.padEnd(12)} +${n}`);
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
