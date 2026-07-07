// Parse a gd4d.co "past-results-history/DD-MM-YYYY" page → structured MY 4D draws.
// gd4d serves clean SSR HTML; each operator is a `div.result.<operatorClass>`.
// Numbers sit in their own spans (.position-first/second/third, .number.position-special-N),
// which is why we read per-element, not via regex on concatenated text.
const cheerio = require("cheerio");

// gd4d class → our canonical operator id (big-3 + SG + secondary/regional 4D operators)
const OP = {
  magnum: "magnum", toto: "sportstoto", pmp: "damacai", singapore: "singapore",
  gd: "grandragon", perdana: "perdana", lucky: "lucky",
  sabah88: "sabah", sarawak: "sarawak", sandakan: "sandakan"
};
const clean = (s) => (s || "").replace(/[^0-9]/g, "");
const isNum = (s) => /^[0-9]{4}$/.test(s);

function parseDate(txt) {           // "Date: Sun, 5/7/2026" → "2026-07-05"
  const m = (txt || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${String(m[2]).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
}

function parseGd4d(html) {
  const $ = cheerio.load(html);
  const out = [];
  $("div.result").each((_, el) => {
    const cls = ($(el).attr("class") || "").split(/\s+/);
    const opKey = cls.find((c) => OP[c]);
    if (!opKey) return;                                   // not a big-3/SG operator block
    const operator = OP[opKey];
    const draw_date = parseDate($(el).find(".result-date").text());
    const first = clean($(el).find(".position-first").text());
    const second = clean($(el).find(".position-second").text());
    const third = clean($(el).find(".position-third").text());
    if (!isNum(first)) return;                            // no real result in this block
    // special vs consolation: split the two `.result-normal` sections by their legend label
    let special = [], consolation = [];
    $(el).find(".result-normal").each((__, sec) => {
      const label = $(sec).find(".result-legend").text().toLowerCase();
      const nums = $(sec).find("span.number").map((i, s) => $(s).text().trim()).get().filter(isNum);
      if (/consol/.test(label)) consolation = nums;
      else special = nums;                               // "Special" / "Starter"
    });
    out.push({ operator, draw_date, first_prize: first, second_prize: second, third_prize: third, special_prizes: special, consolation_prizes: consolation });
  });
  return out;
}
module.exports = { parseGd4d };

// self-test when run directly on a saved page
if (require.main === module) {
  const html = require("fs").readFileSync(process.argv[2] || "/tmp/gd2.html", "utf8");
  const rows = parseGd4d(html);
  console.log(`parsed ${rows.length} operator draws:`);
  for (const r of rows) console.log(`  ${r.operator.padEnd(11)} ${r.draw_date}  1st ${r.first_prize} 2nd ${r.second_prize} 3rd ${r.third_prize} · ${r.special_prizes.length} special · ${r.consolation_prizes.length} consolation`);
}
