// ─── scraper/parse-toto.js ── Parse one TOTO result page ────────────
//
// Returns { draw_no, draw_date, nums:[5 or 6 ints, sorted], additional_num }
// or null if the page has no usable result (wrong draw_no, fallback to
// latest, no win cells).
//
// Old draws (~#40 onwards) use the 5/49 format (5 main + 1 additional);
// later draws use 6/49 (6 main + 1 additional). The pool is 1–49 in both.
// Pre-1997 draws lack a real date on the site (rendered as "Mon, 01 Jan 0001");
// for those draw_date is returned as null.

const cheerio = require("cheerio");

const MONTHS = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

const PLACEHOLDER_DATE = "0001-01-01";

// "Mon, 28 Jul 2025" → "2025-07-28"
function parseDrawDate(text) {
  const m = String(text).match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  if (!m) return null;
  const [, d, mon, y] = m;
  const mm = MONTHS[mon];
  if (!mm) return null;
  return `${y}-${mm}-${d.padStart(2, "0")}`;
}

function parseInt49(text) {
  const n = parseInt(String(text).trim(), 10);
  if (!Number.isInteger(n) || n < 1 || n > 49) return null;
  return n;
}

function parseToto(html) {
  const $ = cheerio.load(html);

  const drawNoMatch = $.text().match(/Draw No\.\s+(\d+)/);
  if (!drawNoMatch) return null;
  const draw_no = parseInt(drawNoMatch[1], 10);

  const dateText = $(".drawDate").first().text().trim() || "";
  const parsedDate = parseDrawDate(dateText);
  const draw_date = parsedDate && parsedDate !== PLACEHOLDER_DATE ? parsedDate : null;

  // Collect win1..win6 (may be 5 or 6 cells depending on era).
  const nums = [];
  for (let i = 1; i <= 6; i++) {
    const v = parseInt49($(`td.win${i}`).first().text());
    if (v == null) break;
    nums.push(v);
  }
  if (nums.length < 5) return null;          // no real result on this page
  nums.sort((a, b) => a - b);

  const additional_num = parseInt49($("td.additional").first().text());
  if (additional_num == null) return null;

  // Sanity: all numbers distinct (5+1=6 or 6+1=7 unique values)
  const all = new Set([...nums, additional_num]);
  if (all.size !== nums.length + 1) return null;

  return { draw_no, draw_date, nums, additional_num };
}

module.exports = { parseToto, parseDrawDate };
