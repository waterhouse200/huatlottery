// Backfill Sports Toto 6D history from gd4d dated pages → my6d_draws.
// Usage: node scraper/my/backfill-6d.js [daysBack]  (default 220 ≈ gd4d's window)
const { execSync } = require("child_process");
const path = require("path");
const Database = require("better-sqlite3");
const cheerio = require("cheerio");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const DB = path.join(__dirname, "..", "..", "huatlottery.db");
const DRAW_DAYS = new Set([0, 2, 3, 6]); // Sun Tue Wed Sat

function parse6D(html) {
  const $ = cheerio.load(html);
  let number = null, date = null;
  $("div.result.toto").each((_, el) => {
    const dm = $(el).find(".result-date").text().match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (dm) date = `${dm[3]}-${String(dm[2]).padStart(2, "0")}-${String(dm[1]).padStart(2, "0")}`;
    $(el).find(".result-normal").each((__, sec) => {
      if (/^6D$/i.test($(sec).find(".result-legend").first().text().trim())) {
        const n = $(sec).find(".result-number").first().text().trim();
        if (/^\d{6}$/.test(n)) number = n;
      }
    });
  });
  return (number && date) ? { draw_date: date, number } : null;
}

const db = new Database(DB);
db.exec("CREATE TABLE IF NOT EXISTS my6d_draws (draw_date TEXT PRIMARY KEY, number TEXT NOT NULL, operator TEXT DEFAULT 'sportstoto', source TEXT, created_at TEXT DEFAULT (datetime('now')))");
const ins = db.prepare("INSERT OR REPLACE INTO my6d_draws (draw_date, number, source) VALUES (?,?,?)");
const daysBack = +(process.argv[2] || 220);
let n = 0;
for (let i = 0; i <= daysBack; i++) {
  const d = new Date(Date.now() - i * 864e5);
  if (!DRAW_DAYS.has(d.getUTCDay())) continue;
  const ds = `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`;
  let html;
  try { html = execSync(`curl -sL --max-time 20 -A "${UA}" "https://gd4d.co/en/past-results-history/${ds}"`, { encoding: "utf8", maxBuffer: 8e6, timeout: 25000 }); } catch { continue; }
  const r = parse6D(html);
  if (r) { ins.run(r.draw_date, r.number, "gd4d"); n++; }
  if (n % 30 === 0 && n) db.pragma("wal_checkpoint(TRUNCATE)");
  execSync("sleep 2");
}
db.pragma("wal_checkpoint(TRUNCATE)"); db.close();
console.log(`6D backfill: ${n} draws stored`);
