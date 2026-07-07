// Throttled historical backfill of Malaysia 4D from gd4d.co date-archive → my_draws.
// Only fetches likely draw days (Tue/Wed/Sat/Sun) to halve load; polite 2s spacing.
// Usage: node scraper/my/backfill-gd4d.js [daysBack]   (default 950 ≈ 2.6yr)
const { execSync } = require("child_process");
const path = require("path");
const Database = require("better-sqlite3");
const { parseGd4d } = require("./parse-gd4d.js");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const DB = path.join(__dirname, "..", "..", "huatlottery.db");
const DRAW_DAYS = new Set([0, 2, 3, 6]); // Sun, Tue(special), Wed, Sat

const daysBack = +(process.argv[2] || 950);
const db = new Database(DB);
const ins = db.prepare("INSERT OR REPLACE INTO my_draws (operator,draw_date,first_prize,second_prize,third_prize,special_prizes,consolation_prizes,source) VALUES (?,?,?,?,?,?,?,?)");
let fetched = 0, hitDays = 0, rows = 0, empty = 0;
const t0 = Date.now();
for (let i = 1; i <= daysBack; i++) {
  const d = new Date(Date.now() - i * 864e5);
  if (!DRAW_DAYS.has(d.getUTCDay())) continue;
  const ds = `${String(d.getUTCDate()).padStart(2,"0")}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${d.getUTCFullYear()}`;
  let html;
  try { html = execSync(`curl -sL --max-time 20 -A "${UA}" "https://gd4d.co/en/past-results-history/${ds}"`, { encoding: "utf8", maxBuffer: 8e6, timeout: 25000 }); } catch { empty++; continue; }
  fetched++;
  const parsed = parseGd4d(html);
  if (parsed.length) { hitDays++; for (const r of parsed) { ins.run(r.operator, r.draw_date, r.first_prize, r.second_prize, r.third_prize, JSON.stringify(r.special_prizes), JSON.stringify(r.consolation_prizes), "gd4d"); rows++; } }
  else empty++;
  if (fetched % 40 === 0) { db.pragma("wal_checkpoint(TRUNCATE)"); console.log(`  ${fetched} days fetched · ${rows} draws stored · ${Math.round((Date.now()-t0)/60000)}min`); }
  execSync("sleep 2");
}
db.pragma("wal_checkpoint(TRUNCATE)"); db.close();
console.log(`DONE: ${fetched} draw-days fetched, ${hitDays} with data, ${rows} operator-draws stored (${empty} empty) in ${Math.round((Date.now()-t0)/60000)}min`);
