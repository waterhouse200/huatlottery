// ─── scraper/parse-fourd.js ── Parse one 4D result page ────────────
//
// Returns { draw_no, draw_date, first_prize, second_prize, third_prize,
//           starter_prizes:[10], consolation_prizes:[10] } or null.

const cheerio = require("cheerio");
const { parseDrawDate } = require("./parse-toto");

function valid4D(text) {
  const t = String(text).trim();
  return /^\d{4}$/.test(t) ? t : null;
}

function tbodyCells($, klass) {
  return $(`tbody.${klass} td`)
    .map((_, el) => valid4D($(el).text()))
    .get()
    .filter(Boolean);
}

function parseFourd(html) {
  const $ = cheerio.load(html);

  const drawNoMatch = $.text().match(/Draw No\.\s+(\d+)/);
  if (!drawNoMatch) return null;
  const draw_no = parseInt(drawNoMatch[1], 10);

  const draw_date = parseDrawDate($(".drawDate").first().text());
  if (!draw_date) return null;
  // Reject "0001-01-01" placeholder (server returns it for non-existent draws).
  if (draw_date < "1985-01-01") return null;

  const first_prize  = valid4D($("td.tdFirstPrize").first().text());
  const second_prize = valid4D($("td.tdSecondPrize").first().text());
  const third_prize  = valid4D($("td.tdThirdPrize").first().text());
  if (!first_prize || !second_prize || !third_prize) return null;

  // Early 4D draws (1988–1989 era) had 8 starters instead of 10. Accept any
  // non-empty count rather than rejecting old real data.
  const starter_prizes     = tbodyCells($, "tbodyStarterPrizes");
  const consolation_prizes = tbodyCells($, "tbodyConsolationPrizes");
  if (starter_prizes.length === 0 || consolation_prizes.length === 0) return null;

  return {
    draw_no,
    draw_date,
    first_prize,
    second_prize,
    third_prize,
    starter_prizes,
    consolation_prizes,
  };
}

module.exports = { parseFourd };
