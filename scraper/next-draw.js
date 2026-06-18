// ─── scraper/next-draw.js ── Read Singapore Pools' "Next Draw" date+time ─
//
// SP injects the next-draw date via JS from a pregenerated file (not the
// results HTML). We fetch that file directly. It's the authoritative
// source for the NEXT draw — including special/big draws on odd days/times,
// so we never hardcode a weekday or 6.30pm.
//
//   TOTO : .../toto_next_draw_estimate_en.html → "Next Draw Mon, 22 Jun 2026 , 6.30pm"
//   4D   : .../fourd_next_draw_info_en.html    → "Next Draw Sat, 20 Jun 2026, 6.30pm"

const cheerio = require("cheerio");
const { fetchHtml } = require("./fetch");

const BASE = "https://www.singaporepools.com.sg/DataFileArchive/Lottery/Output/";
const FILES = {
  toto:  "toto_next_draw_estimate_en.html",
  fourd: "fourd_next_draw_info_en.html",
};
const MONTHS = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };

// "Mon, 22 Jun 2026 , 6.30pm"  → { date:'2026-06-22', time:'18:30', at:'2026-06-22T18:30:00+08:00', raw }
function parseNextDraw(text) {
  const t = String(text).replace(/\s+/g, " ");
  const m = t.match(/Next Draw\b[^A-Za-z0-9]*[A-Za-z]{3},?\s*(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s*,?\s*(\d{1,2})(?:[.:](\d{2}))?\s*(am|pm)/i);
  if (!m) return null;
  const [, dd, mon, yyyy, hrRaw, minRaw, ap] = m;
  const mm = MONTHS[mon[0].toUpperCase() + mon.slice(1).toLowerCase()];
  if (!mm) return null;
  let hr = parseInt(hrRaw, 10);
  const min = minRaw ? parseInt(minRaw, 10) : 0;
  if (/pm/i.test(ap) && hr < 12) hr += 12;
  if (/am/i.test(ap) && hr === 12) hr = 0;
  const date = `${yyyy}-${mm}-${String(dd).padStart(2, "0")}`;
  const time = `${String(hr).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  return { date, time, at: `${date}T${time}:00+08:00`, raw: m[0].replace(/\s+/g, " ").trim() };
}

// Fetch + parse the next-draw file for a game. Returns null on any failure
// (caller treats that as "unknown — try again next tick"), never throws.
async function fetchNextDraw(game) {
  const file = FILES[game];
  if (!file) throw new Error(`Unknown game: ${game}`);
  try {
    const html = await fetchHtml(BASE + file);
    return parseNextDraw(cheerio.load(html).text());
  } catch (e) {
    return null;
  }
}

module.exports = { fetchNextDraw, parseNextDraw, BASE, FILES };
