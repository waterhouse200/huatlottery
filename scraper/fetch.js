// ─── scraper/fetch.js ── HTTP layer: sppl encoding, throttle, retry ─
//
// Singapore Pools result pages are reached by setting the `sppl` query
// param to base64("DrawNumber=N"). The site responds with HTTP 200 even
// for non-existent draws (silently falling back to the latest), so the
// caller is responsible for verifying the parsed draw number matches.

const URLS = {
  toto:  "https://www.singaporepools.com.sg/en/product/sr/Pages/toto_results.aspx",
  fourd: "https://www.singaporepools.com.sg/en/product/Pages/4d_results.aspx",
};

const REQUEST_DELAY_MS = 1500;        // politeness throttle between requests
const MAX_RETRIES      = 6;
const RETRY_BACKOFF_MS = [3000, 9000, 27000, 60000, 120000, 300000];
const REQUEST_TIMEOUT  = 30000;
const USER_AGENT       = "Huatlottery/0.1 (personal analysis project)";

function encodeSppl(drawNumber) {
  return Buffer.from(`DrawNumber=${drawNumber}`, "utf8").toString("base64");
}

function buildUrl(game, drawNumber) {
  const base = URLS[game];
  if (!base) throw new Error(`Unknown game: ${game}`);
  if (drawNumber == null) return base;          // request latest
  return `${base}?sppl=${encodeSppl(drawNumber)}`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// State so multiple sequential calls respect the throttle.
let lastRequestAt = 0;
async function throttle() {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < REQUEST_DELAY_MS) await sleep(REQUEST_DELAY_MS - elapsed);
  lastRequestAt = Date.now();
}

async function fetchHtml(url) {
  await throttle();
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, "Accept": "text/html" },
        redirect: "follow",
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.status >= 500 || res.status === 429) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} (non-retryable)`);
      }
      return await res.text();
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      const wait = RETRY_BACKOFF_MS[attempt];
      console.warn(`  ⚠  ${err.message} → retrying in ${wait}ms`);
      await sleep(wait);
    }
  }
}

async function fetchDraw(game, drawNumber) {
  return fetchHtml(buildUrl(game, drawNumber));
}

module.exports = {
  URLS,
  REQUEST_DELAY_MS,
  encodeSppl,
  buildUrl,
  fetchHtml,
  fetchDraw,
  sleep,
};
