// CI/standalone scraper for the non-4D "Other" Malaysia games → other_draws table.
// Runs without the express server (used by the daily GitHub Action) so history
// accrues even with zero site visitors. Idempotent per (game, draw_date).
//
// Usage: node scraper/my/scrape-other.js
const path = require("path");
const Database = require("better-sqlite3");
const { fetchAllOther } = require("./parse-other.js");

const DB = path.join(__dirname, "..", "..", "huatlottery.db");

(async () => {
  const db = new Database(DB);
  // ensure the archive table exists (mirrors db.js) so this can run stand-alone
  db.exec(`
    CREATE TABLE IF NOT EXISTS other_draws (
      game TEXT, draw_date TEXT, draw_no TEXT, payload TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (game, draw_date)
    );
    CREATE INDEX IF NOT EXISTS idx_other_draws_game_date ON other_draws(game, draw_date DESC);
  `);
  const ins = db.prepare("INSERT OR IGNORE INTO other_draws (game, draw_date, draw_no, payload) VALUES (?, ?, ?, ?)");
  const save = (game, obj) => {
    if (!obj || !obj.date) return 0;
    const r = ins.run(game, obj.date, obj.drawNo || null, JSON.stringify(obj));
    return r.changes;
  };

  let added = 0, seen = 0;
  try {
    const { totoProducts: tp, otherGames: og } = await fetchAllOther();
    const games = {
      fived: tp.fiveD && { ...tp.fiveD, date: tp.fiveD.date || tp.date },
      star: tp.star, power: tp.power, supreme: tp.supreme,
      damacai33d: og.damacai33d, magnumlife: og.magnumLife,
      jackpotgold: og.jackpotGold, sabahlotto: og.sabahLotto,
    };
    for (const [game, obj] of Object.entries(games)) {
      if (obj && obj.date) { seen++; added += save(game, obj); }
    }
  } catch (e) {
    console.error("scrape-other failed:", e.message);
  }

  db.pragma("wal_checkpoint(TRUNCATE)");
  const total = db.prepare("SELECT COUNT(*) n FROM other_draws").get().n;
  db.close();
  console.log(`other-games: ${seen} games scraped, ${added} new rows stored, ${total} total archived.`);
})();
