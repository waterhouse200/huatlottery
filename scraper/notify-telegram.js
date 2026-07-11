// Telegram results channel — pushes new draws the moment a scrape lands them.
//
// Broadcast model: a public Telegram CHANNEL (users just join it; no subscriber
// DB needed). This script runs at the end of each scrape workflow, diffs the DB
// against notify_state, and posts anything new. Idempotent: each draw notifies
// exactly once, tracked in the git-committed DB so CI runs stay in sync.
//
// Env (GitHub Actions secrets):
//   TELEGRAM_BOT_TOKEN  — from @BotFather
//   TELEGRAM_CHAT_ID    — channel @username (e.g. @huatlottery) or -100… id
// Without them the script exits 0 quietly (safe before the bot exists).
//
// Usage: node scraper/notify-telegram.js [--dry-run]
const path = require("path");
const Database = require("better-sqlite3");

const DB = path.join(__dirname, "..", "huatlottery.db");
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
const DRY = process.argv.includes("--dry-run");
const SITE = "https://huatlottery.com";

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDate(iso) { // 2026-07-11 -> Sat 11 Jul 2026
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${DOW[dt.getUTCDay()]} ${d} ${MON[m - 1]} ${y}`;
}
const J = (s) => { try { return JSON.parse(s || "[]"); } catch { return []; } };

// ── state ─────────────────────────────────────────────────────────────────────
const db = new Database(DB);
db.exec(`CREATE TABLE IF NOT EXISTS notify_state (key TEXT PRIMARY KEY, value TEXT)`);
const getState = (k) => (db.prepare("SELECT value FROM notify_state WHERE key=?").get(k) || {}).value || null;
const setState = (k, v) => db.prepare("INSERT OR REPLACE INTO notify_state (key, value) VALUES (?, ?)").run(k, String(v));

// ── send ─────────────────────────────────────────────────────────────────────
async function send(text) {
  if (DRY) { console.log("── DRY RUN — would send ──\n" + text + "\n"); return true; }
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) console.error("telegram send failed:", JSON.stringify(j).slice(0, 200));
  return !!j.ok;
}

// ── message builders ─────────────────────────────────────────────────────────
function msgFourd(r) {
  const st = J(r.starter_prizes).join("  "), co = J(r.consolation_prizes).join("  ");
  return [
    `🇸🇬 <b>Singapore 4D</b> — ${fmtDate(r.draw_date)} · Draw ${r.draw_no}`,
    ``,
    `🥇 1st  <code>${r.first_prize}</code>`,
    `🥈 2nd  <code>${r.second_prize}</code>`,
    `🥉 3rd  <code>${r.third_prize}</code>`,
    ``,
    `Starter: <code>${st}</code>`,
    `Consolation: <code>${co}</code>`,
    ``,
    `🔗 ${SITE}`,
  ].join("\n");
}

function msgToto(r, jackpot) {
  const nums = [r.num1, r.num2, r.num3, r.num4, r.num5, r.num6].join("  ");
  const lines = [
    `🇸🇬 <b>Singapore TOTO</b> — ${fmtDate(r.draw_date)} · Draw ${r.draw_no}`,
    ``,
    `Winning: <code>${nums}</code>`,
    `Additional: <code>${r.additional_num}</code>`,
  ];
  if (jackpot) lines.push(``, `💰 Next jackpot: <b>${jackpot}</b>`);
  lines.push(``, `🔗 ${SITE}`);
  return lines.join("\n");
}

const MY_OPS = [
  ["magnum", "Magnum"], ["sportstoto", "Sports Toto"], ["damacai", "Da Ma Cai"],
  ["sabah", "Sabah 88"], ["sarawak", "Cash Sweep"], ["sandakan", "Sandakan"],
];
function msgMy(date, rowsByOp) {
  const lines = [`🇲🇾 <b>Malaysia 4D</b> — ${fmtDate(date)}`, ``];
  for (const [op, label] of MY_OPS) {
    const r = rowsByOp[op];
    if (r) lines.push(`<b>${label}</b>  <code>${r.first_prize}</code> / <code>${r.second_prize}</code> / <code>${r.third_prize}</code>`);
  }
  lines.push(``, `(1st / 2nd / 3rd — full results incl. special &amp; consolation:)`, `🔗 ${SITE}`);
  return lines.join("\n");
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  if (!DRY && (!TOKEN || !CHAT)) { console.log("notify-telegram: no token/chat configured — skipping."); db.close(); return; }

  let sent = 0;

  // SG 4D — key by draw_no
  const f = db.prepare("SELECT * FROM fourd_draws ORDER BY draw_date DESC, draw_no DESC LIMIT 1").get();
  if (f && String(f.draw_no) !== getState("tg_fourd")) {
    if (await send(msgFourd(f))) { setState("tg_fourd", f.draw_no); sent++; }
  }

  // SG TOTO — key by draw_no (+ next jackpot if known)
  const t = db.prepare("SELECT * FROM toto_draws ORDER BY draw_date DESC, draw_no DESC LIMIT 1").get();
  if (t && String(t.draw_no) !== getState("tg_toto")) {
    const nd = db.prepare("SELECT jackpot FROM next_draws WHERE game='toto'").get();
    if (await send(msgToto(t, nd && nd.jackpot))) { setState("tg_toto", t.draw_no); sent++; }
  }

  // MY 4D — key by draw_date; send one combined message when the big-3 are in
  const latestMy = db.prepare("SELECT MAX(draw_date) m FROM my_draws").get().m;
  if (latestMy && latestMy !== getState("tg_my")) {
    const rows = db.prepare("SELECT * FROM my_draws WHERE draw_date=?").all(latestMy);
    const byOp = {}; rows.forEach((r) => { byOp[r.operator] = r; });
    // wait until at least the classic big-3 are present so we don't push a half-empty card
    if (byOp.magnum && byOp.sportstoto && byOp.damacai) {
      if (await send(msgMy(latestMy, byOp))) { setState("tg_my", latestMy); sent++; }
    }
  }

  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  console.log(`notify-telegram: ${sent} message(s) ${DRY ? "previewed" : "sent"}.`);
})();
