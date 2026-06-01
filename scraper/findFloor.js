// ─── scraper/findFloor.js ── Binary search for earliest accessible draw ─
//
// Singapore Pools silently returns the latest draw when you request a
// non-existent draw number, so existence is established by:
//   1. Page parses cleanly with parser(html)
//   2. The parsed draw_no === the requested draw_no
//
// For TOTO this also implicitly enforces "current 6/49 format" — if the
// older format renders, parse-toto returns null (no win1..win6 cells of
// values 1..49 in the expected layout).

const { fetchDraw } = require("./fetch");
const { parseToto } = require("./parse-toto");
const { parseFourd } = require("./parse-fourd");

const PARSERS = { toto: parseToto, fourd: parseFourd };

async function probeExists(game, drawNumber) {
  const html = await fetchDraw(game, drawNumber);
  const parsed = PARSERS[game](html);
  return !!(parsed && parsed.draw_no === drawNumber);
}

async function findLatest(game) {
  // Singapore Pools silently returns the latest draw when sppl points
  // to a draw number above the current latest. The no-sppl URL works
  // for TOTO but for 4D the landing page is JS-rendered, so we use a
  // high sentinel for both games to keep one code path.
  const html = await fetchDraw(game, 99999999);
  const parsed = PARSERS[game](html);
  if (!parsed) throw new Error(`Could not parse latest ${game} page`);
  return parsed;
}

// Binary search the smallest N in [lo, hi] for which probeExists(game, N).
// Caller guarantees probeExists(game, hi) is true.
async function findFloor(game, { lo = 1, hi, onProbe } = {}) {
  if (hi == null) throw new Error("findFloor requires hi");
  let l = lo, h = hi, answer = hi;
  while (l <= h) {
    const mid = Math.floor((l + h) / 2);
    const ok  = await probeExists(game, mid);
    if (onProbe) onProbe({ mid, ok, lo: l, hi: h });
    if (ok) { answer = mid; h = mid - 1; }
    else { l = mid + 1; }
  }
  return answer;
}

module.exports = { findFloor, findLatest, probeExists };
