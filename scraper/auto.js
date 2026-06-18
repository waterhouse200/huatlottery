// ─── scraper/auto.js ── Event-driven auto-scraper (TOTO + 4D, independent) ─
//
// Two independent self-scheduling loops — one for TOTO, one for 4D — each
// driven by Singapore Pools' own "Next Draw" datetime (handles special/odd
// day+time draws; never hardcodes a weekday or 6.30pm).
//
// Per game:  idle → wake at SP's stated draw time → poll every 5 min until
// that draw number is captured → stop → reschedule for the next draw.
// If we're ever behind (gap ≥ 1 published, unsaved), backfill it.
//
// Durability: after any insert we checkpoint WAL into the .db and
// git commit && push it (Render free tier is ephemeral; git is the store).

const path = require("path");
const { execSync } = require("child_process");
const { getDb, initSchema } = require("../db");
const { findLatest } = require("./findFloor");
const { fetchDraw } = require("./fetch");
const { parseToto } = require("./parse-toto");
const { parseFourd } = require("./parse-fourd");
const { fetchNextDraw } = require("./next-draw");

const GAMES = ["toto", "fourd"];
const TABLE = { toto: "toto_draws", fourd: "fourd_draws" };
const PARSE = { toto: parseToto, fourd: parseFourd };

const RETRY_MS = 5 * 60 * 1000;          // poll cadence once armed
const MAX_TIMER_MS = 6 * 60 * 60 * 1000; // re-evaluate idle wait at least every 6h
const REPO = path.join(__dirname, "..");

let db; // single long-lived connection
const ts = () => new Date().toISOString();
const log = (game, msg) => console.log(`[auto:${game}] ${ts()} ${msg}`);

function getMax(game) {
  const r = db.prepare(`SELECT MAX(draw_no) AS m FROM ${TABLE[game]}`).get();
  return r && r.m ? r.m : 0;
}

function insertRow(game, row) {
  if (game === "toto") {
    return db.prepare(`INSERT OR IGNORE INTO toto_draws
      (draw_no,draw_date,num1,num2,num3,num4,num5,num6,additional_num)
      VALUES (@draw_no,@draw_date,@num1,@num2,@num3,@num4,@num5,@num6,@additional_num)`).run({
      draw_no: row.draw_no, draw_date: row.draw_date,
      num1: row.nums[0], num2: row.nums[1], num3: row.nums[2], num4: row.nums[3], num5: row.nums[4],
      num6: row.nums[5] ?? null, additional_num: row.additional_num,
    }).changes;
  }
  return db.prepare(`INSERT OR IGNORE INTO fourd_draws
    (draw_no,draw_date,first_prize,second_prize,third_prize,starter_prizes,consolation_prizes)
    VALUES (@draw_no,@draw_date,@first_prize,@second_prize,@third_prize,@starter,@consolation)`).run({
    draw_no: row.draw_no, draw_date: row.draw_date,
    first_prize: row.first_prize, second_prize: row.second_prize, third_prize: row.third_prize,
    starter: JSON.stringify(row.starter_prizes), consolation: JSON.stringify(row.consolation_prizes),
  }).changes;
}

// scrape published draws [from..to], newest first; idempotent + fallback-guarded
async function scrapeRange(game, from, to) {
  let inserted = 0;
  for (let n = to; n >= from; n--) {
    if (db.prepare(`SELECT 1 FROM ${TABLE[game]} WHERE draw_no=?`).get(n)) continue;
    let html;
    try { html = await fetchDraw(game, n); } catch (e) { log(game, `fetch #${n} failed: ${e.message}`); continue; }
    const row = PARSE[game](html);
    if (!row || row.draw_no !== n) { log(game, `#${n}: no result / fallback — skip`); continue; }
    if (insertRow(game, row)) { inserted++; log(game, `inserted #${n} (${row.draw_date || "no-date"})`); }
  }
  return inserted;
}

// Returns true only if the next-draw values actually changed (so we don't
// rewrite the DB — and trigger a commit — every single 5-min tick).
function upsertSentinel(game, nextNo, next) {
  const cur = db.prepare("SELECT next_draw_no, next_draw_at FROM next_draws WHERE game=?").get(game);
  if (cur && cur.next_draw_no === nextNo && cur.next_draw_at === (next?.at ?? null)) return false;
  db.prepare(`INSERT INTO next_draws (game,next_draw_no,next_draw_date,next_draw_time,next_draw_at,raw,updated_at)
    VALUES (@g,@no,@d,@t,@at,@raw,datetime('now'))
    ON CONFLICT(game) DO UPDATE SET
      next_draw_no=@no, next_draw_date=@d, next_draw_time=@t, next_draw_at=@at, raw=@raw, updated_at=datetime('now')`)
    .run({ g: game, no: nextNo, d: next?.date ?? null, t: next?.time ?? null, at: next?.at ?? null, raw: next?.raw ?? null });
  return true;
}

function checkpoint() {
  try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch (e) { /* best-effort */ }
}

// Self-push only in persistent mode (POLLER_SELF_PUSH=1). Under GitHub Actions
// the workflow itself does the commit+push with its built-in token, so this is skipped.
function gitPush(message) {
  if (process.env.POLLER_SELF_PUSH !== "1") return;
  try {
    execSync("git add huatlottery.db", { cwd: REPO });
    try { execSync("git diff --staged --quiet", { cwd: REPO }); return; } catch { /* has changes */ }
    execSync(`git -c user.name="Huatlottery Bot" -c user.email="bot@huatlottery.local" commit -m ${JSON.stringify(message)}`, { cwd: REPO });
    if (process.env.GH_TOKEN) {
      const remote = `https://x-access-token:${process.env.GH_TOKEN}@github.com/waterhouse200/huatlottery.git`;
      execSync(`git push ${remote} HEAD:main`, { cwd: REPO, stdio: "ignore" });
      log("git", `pushed: ${message}`);
    }
  } catch (e) { console.warn(`[auto:git] ${ts()} push failed: ${e.message}`); }
}

// one cycle: backfill any gap, refresh sentinel. Returns {dbMax, nextNo, nextAt, inserted}.
async function tick(game) {
  const latest = await findLatest(game);          // newest published draw_no
  const next = await fetchNextDraw(game);          // exact next-draw datetime (or null)
  let dbMax = getMax(game);
  let inserted = 0;
  if (latest.draw_no > dbMax) {                    // we're behind → fill the gap
    inserted = await scrapeRange(game, dbMax + 1, latest.draw_no);
    dbMax = getMax(game);
  }
  const nextNo = latest.draw_no + 1;
  const sentinelChanged = upsertSentinel(game, nextNo, next);
  if (inserted > 0 || sentinelChanged) checkpoint();  // fold WAL into .db only when something changed
  if (inserted > 0) gitPush(`chore(scrape): ${game} +${inserted} → #${dbMax}`); // self-push only in persistent mode
  log(game, `dbMax=${dbMax} published=${latest.draw_no} next=#${nextNo} @ ${next?.at || "?"} ${inserted ? `(+${inserted})` : "(no change)"}`);
  return { dbMax, nextNo, nextAt: next?.at || null, inserted };
}

async function safeTick(game) {
  try { return await tick(game); }
  catch (e) { log(game, `tick error: ${e.message}`); return { dbMax: getMax(game), nextNo: null, nextAt: null, inserted: 0 }; }
}

// arm a timer for the exact draw moment, then poll until captured
function arm(game, targetNo, nextAt) {
  const at = nextAt ? Date.parse(nextAt) : NaN;
  if (isNaN(at)) { setTimeout(() => scheduleNext(game), MAX_TIMER_MS); return; }  // unknown → re-check in 6h
  const delay = at - Date.now();
  if (delay > MAX_TIMER_MS) { log(game, `idle ${Math.round(delay / 3.6e6)}h until draw`); setTimeout(() => scheduleNext(game), MAX_TIMER_MS); return; }
  log(game, `armed for #${targetNo} in ${Math.max(0, Math.round(delay / 60000))} min`);
  setTimeout(() => poll(game, targetNo), Math.max(0, delay));
}

async function poll(game, targetNo) {
  const st = await safeTick(game);
  if (targetNo == null || st.dbMax >= targetNo) {
    if (st.dbMax >= targetNo) log(game, `captured #${targetNo} ✓`);
    scheduleNext(game);                              // reschedule for the next future draw → STOP polling
  } else {
    setTimeout(() => poll(game, targetNo), RETRY_MS); // result not out yet → retry in 5 min
  }
}

async function scheduleNext(game) {
  const st = await safeTick(game);                   // catch-up + read next; heals any gap on boot/restart
  arm(game, st.nextNo, st.nextAt);
}

function start() {
  db = getDb();
  initSchema(db);
  log("init", "auto-scraper starting (TOTO + 4D independent loops)");
  for (const game of GAMES) scheduleNext(game);
}

// ── Self-healing lazy catch-up ──────────────────────────────────────
// Call this freely (e.g. on every web request). It runs at most once per
// throttle window, backfills any missed draw for BOTH games, and NEVER
// throws or blocks — so it can't affect the site. This is the safety net
// for when GitHub's scheduler doesn't fire: the next visitor heals the data.
let _lastCatchUp = 0;
const CATCHUP_THROTTLE_MS = 5 * 60 * 1000;
async function catchUp() {
  const now = Date.now();
  if (now - _lastCatchUp < CATCHUP_THROTTLE_MS) return { skipped: "throttled" };
  _lastCatchUp = now;
  try {
    if (!db) { db = getDb(); initSchema(db); }
    const out = {};
    for (const game of GAMES) out[game] = await safeTick(game); // safeTick already swallows errors
    return out;
  } catch (e) {
    console.warn(`[auto:catchUp] ${ts()} ${e.message}`);
    return { error: e.message };
  }
}

// CLI: `node scraper/auto.js --once`  → run one tick per game and exit (test/backfill, no timers)
if (require.main === module) {
  db = getDb(); initSchema(db);
  if (process.argv.includes("--once")) {
    (async () => { for (const g of GAMES) await safeTick(g); db.close(); })();
  } else {
    start();
  }
}

module.exports = { start, tick, safeTick, catchUp };
