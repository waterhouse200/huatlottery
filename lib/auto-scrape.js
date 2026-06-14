// In-server auto-scrape: kicks off scrape-fourd + scrape-toto on startup
// and at a fixed interval. Each scraper is spawned as a child process so a
// crash never takes the API down. Scripts are idempotent (INSERT OR IGNORE).

const { spawn } = require("child_process");
const path = require("path");

const REPO = path.join(__dirname, "..");
let inFlight = false;
let lastRun = null;
let lastResult = null;

function runOne(script) {
  return new Promise((resolve) => {
    const full = path.join(REPO, "scraper", script);
    const proc = spawn(process.execPath, [full], { cwd: REPO, env: process.env });
    let out = "", err = "";
    proc.stdout.on("data", d => { out += d; process.stdout.write(`[scrape:${script}] ${d}`); });
    proc.stderr.on("data", d => { err += d; process.stderr.write(`[scrape:${script}] ${d}`); });
    proc.on("error", e => resolve({ script, ok: false, err: e.message }));
    proc.on("exit", code => resolve({ script, ok: code === 0, code, out, err }));
  });
}

async function runAll(label = "scheduled") {
  if (inFlight) {
    console.log(`[auto-scrape] ${label} skipped — previous run still in flight`);
    return { skipped: true };
  }
  inFlight = true;
  const startedAt = new Date();
  console.log(`[auto-scrape] ${label} starting at ${startedAt.toISOString()}`);
  try {
    const fourd = await runOne("scrape-fourd.js");
    const toto  = await runOne("scrape-toto.js");
    lastRun = startedAt.toISOString();
    lastResult = { label, fourd: { ok: fourd.ok, code: fourd.code }, toto: { ok: toto.ok, code: toto.code } };
    console.log(`[auto-scrape] ${label} done — 4D ok=${fourd.ok} TOTO ok=${toto.ok}`);
    return lastResult;
  } finally {
    inFlight = false;
  }
}

function startAutoScrape({ everyMs = 2 * 60 * 60 * 1000, startupDelayMs = 5000 } = {}) {
  setTimeout(() => runAll("startup").catch(e => console.error("[auto-scrape] startup err:", e)), startupDelayMs);
  setInterval(() => runAll("interval").catch(e => console.error("[auto-scrape] interval err:", e)), everyMs);
  console.log(`[auto-scrape] enabled — startup in ${startupDelayMs}ms, then every ${Math.round(everyMs / 60000)} min`);
}

function status() {
  return { inFlight, lastRun, lastResult };
}

module.exports = { startAutoScrape, runAll, status };
