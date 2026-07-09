// Shared parsers for the non-4D "Other" Malaysia games (5D, Da Ma Cai 3+3D,
// Magnum Life, Magnum Jackpot Gold, Sabah Lotto, Star/Power/Supreme Toto).
// Used by BOTH the live server (server.js) and the CI scraper (scrape-other.js)
// so the parsing logic lives in ONE place and can't drift.
//
// Sources: gd4d.co/en (for 5D structured rows) + check4d.org (flattened text).

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

function fetchTimeout(url, ms) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms || 8000);
  return fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal }).finally(() => clearTimeout(to));
}

// draw-date + draw-no grabber from a flattened check4d text segment
function grab(seg) {
  const dm = seg.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  const dn = seg.match(/\b(\d{3,4})[-/](\d{2})\b/);
  return {
    date: dm ? `${dm[3]}-${String(dm[2]).padStart(2, "0")}-${String(dm[1]).padStart(2, "0")}` : null,
    drawNo: dn ? dn[1] + "/" + dn[2] : null,
  };
}

// ── Sports Toto 5D + Star/Power/Supreme Toto (needs gd4d HTML + check4d text) ──
function parseTotoProducts(gd4dHtml, check4dText) {
  const cheerio = require("cheerio");
  const $ = cheerio.load(gd4dHtml);
  let fiveD = null, date = null;
  $(".result-jackpot").each((_, el) => {
    if (fiveD || !/5D/i.test($(el).text())) return;
    const dm = $(el).find(".result-date").text().match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (dm) date = `${dm[3]}-${String(dm[2]).padStart(2, "0")}-${String(dm[1]).padStart(2, "0")}`;
    $(el).find(".result-normal").each((__, sec) => {
      if (!/^5D$/i.test($(sec).find(".result-legend").first().text().trim())) return;
      const prizes = {};
      $(sec).find(".result-row").each((k, r) => {
        const label = $(r).find(".result-label").text().trim();
        const num = $(r).find(".result-number").first().text().trim();
        if (label && /^\d+$/.test(num)) prizes[label] = num;
      });
      if (Object.keys(prizes).length) fiveD = { date, prizes };
    });
  });

  const t = check4dText;
  // hasBonus: only Star Toto 6/50 has an extra number; Power/Supreme are 6 numbers only
  const lotto = (name, twoJp, hasBonus) => {
    const i = t.indexOf(name); if (i < 0) return null;
    const seg = t.slice(i + name.length, i + name.length + 240);
    const nums = (seg.match(/\b\d{1,2}\b/g) || []).slice(0, 7);
    const jps = seg.match(/RM\s?[\d,]+(?:\.\d+)?/g) || [];
    const meta = grab(t.slice(Math.max(0, i - 130), i + 240));
    return { nums: nums.slice(0, 6), additional: hasBonus ? (nums[6] || null) : null, jackpot1: jps[0] || null, jackpot2: twoJp ? (jps[1] || null) : null, drawNo: meta.drawNo, date: meta.date || date };
  };
  const i5 = t.indexOf("SportsToto 5D");
  if (fiveD && i5 >= 0) fiveD.drawNo = grab(t.slice(i5, i5 + 200)).drawNo;

  const data = { date, fiveD, star: lotto("Star Toto 6/50", true, true), power: lotto("Power Toto 6/55", false, false), supreme: lotto("Supreme Toto 6/58", false, false) };
  const lottoNo = (data.star && data.star.drawNo) || (data.power && data.power.drawNo) || (data.supreme && data.supreme.drawNo);
  [data.star, data.power, data.supreme].forEach((x) => { if (x && !x.drawNo) x.drawNo = lottoNo; });
  return data;
}

// ── Da Ma Cai 3+3D, Magnum Life, Magnum Jackpot Gold, Sabah Lotto (check4d text) ──
function parseOtherGames(check4dText) {
  const t = check4dText;
  let damacai33d = null;
  { const i = t.indexOf("Da Ma Cai 3+3D");
    if (i >= 0) { const seg = t.slice(i, i + 720); const m = grab(seg); const nums = seg.match(/\b\d{6}\b/g) || [];
      const prize = (n) => { const mm = seg.match(new RegExp(n + "\\s+([A-Z]+)\\s+Bonus\\s+\\d+\\s+(RM\\s?[\\d,]+(?:\\.\\d+)?)")); return { number: n, animal: mm ? mm[1] : null, bonus: mm ? mm[2] : null }; };
      if (nums.length >= 3) damacai33d = { drawNo: m.drawNo, date: m.date, prizes: [prize(nums[0]), prize(nums[1]), prize(nums[2])], special: nums.slice(3, 13), consolation: nums.slice(13, 23) }; } }
  let magnumLife = null;
  { const i = t.indexOf("Magnum Life");
    if (i >= 0) { const seg = t.slice(i, i + 230); const m = grab(seg);
      const wm = seg.match(/Winning Numbers\s+((?:\d{2}\s+){2,9}\d{2})\s+Bonus/), bm = seg.match(/Bonus Numbers\s+(\d{2})\s+(\d{2})/);
      magnumLife = { drawNo: m.drawNo, date: m.date, winning: wm ? wm[1].trim().split(/\s+/) : [], bonus: bm ? [bm[1], bm[2]] : [] }; } }
  let jackpotGold = null;
  { const i = t.indexOf("Jackpot Gold");
    if (i >= 0) { const seg = t.slice(i, i + 240); const m = grab(seg);
      const j1 = seg.match(/Jackpot 1\s+((?:\d\s+){5}\d)\s*\+\s*(\d\s*\d)/), prize = seg.match(/Prize\s*:\s*(RM\s?[\d,]+(?:\.\d+)?)/);
      jackpotGold = { drawNo: m.drawNo, date: m.date, number: j1 ? j1[1].replace(/\s+/g, "") : null, bonus: j1 ? j1[2].replace(/\s+/g, "") : null, prize: prize ? prize[1] : null }; } }
  let sabahLotto = null;
  { const i = t.indexOf("Lotto 6/45");
    if (i >= 0) { const seg = t.slice(i + 10, i + 150);
      const nm = seg.match(/((?:\d{1,2}\s+){5}\d{1,2})\s*\+\s*(\d{1,2})/);
      const jps = (seg.match(/Jackpot \d\s+(RM\s?[\d,]+(?:\.\d+)?)/g) || []).map((x) => x.replace(/Jackpot \d\s+/, ""));
      const s88 = t.indexOf("Sabah 88 4D"), meta = s88 >= 0 ? grab(t.slice(s88, s88 + 90)) : {};
      if (nm) sabahLotto = { drawNo: meta.drawNo, date: meta.date, nums: nm[1].trim().split(/\s+/), bonus: nm[2], jackpot1: jps[0] || null, jackpot2: jps[1] || null }; } }
  return { damacai33d, magnumLife, jackpotGold, sabahLotto };
}

// Fetch both sources once, return all parsed games. Used by server + CLI.
async function fetchAllOther() {
  const gd4dHtml = await (await fetchTimeout("https://gd4d.co/en", 8000)).text();
  const check4dText = (await (await fetchTimeout("https://www.check4d.org/", 8000)).text())
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  return {
    totoProducts: parseTotoProducts(gd4dHtml, check4dText),
    otherGames: parseOtherGames(check4dText),
  };
}

module.exports = { fetchTimeout, parseTotoProducts, parseOtherGames, fetchAllOther, UA };
