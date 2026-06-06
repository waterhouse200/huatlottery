// ─── lib/lucky/qimen.js ── Authentic Nine Star palace via lunar-javascript ─
//
// The 9 palaces (九宫) are part of both Qi Men Dun Jia and Flying Star Feng
// Shui. lunar-javascript exposes the Day Nine Star (日家九星) which gives
// the user's "personal palace" for their birth day — number, element,
// traditional color, and palace position (中宫, 坎宫, etc.).
//
// This is the authentic primary lookup; no homebrew arithmetic.

const { Solar } = require("lunar-javascript");

// Chinese numeral → Arabic
const NUM = { "一":1, "二":2, "三":3, "四":4, "五":5, "六":6, "七":7, "八":8, "九":9 };

// Palace position character → English direction
const POSITION_EN = {
  "中": "Center",
  "坎": "North",        "离": "South",
  "震": "East",         "兑": "West",
  "巽": "Southeast",    "乾": "Northwest",
  "艮": "Northeast",    "坤": "Southwest",
};

const ELEMENT_EN = { "木": "Wood", "火": "Fire", "土": "Earth", "金": "Metal", "水": "Water" };

function compute(birthday, time) {
  const [Y, M, D] = birthday.split("-").map(Number);
  const [hh, mm] = (time || "12:00").split(":").map(Number);
  const solar = Solar.fromYmdHms(Y, M, D, hh, mm, 0);
  const lunar = solar.getLunar();

  const ns = lunar.getDayNineStar();
  const palace   = NUM[ns.getNumber()] || 5;       // 1..9
  const color    = ns.getColor();                  // 白 / 黑 / 碧 / ...
  const element  = ns.getWuXing();                 // 土 / 水 / 木 / ...
  const position = ns.getPosition();               // 中 / 坎 / 离 / ...
  const positionEn = POSITION_EN[position] || position;
  const elementEn  = ELEMENT_EN[element] || element;

  const digitWeights = new Array(10).fill(0);
  const numberWeights = new Array(50).fill(0);

  // Heavy voter: Day Nine Star is the most direct "luck of the day" Chinese
  // flying-star tradition. Palace number + complement + element digits.
  for (let k = 0; palace + 9 * k <= 49; k++) numberWeights[palace + 9 * k] += 3;
  const complement = palace === 5 ? 5 : 10 - palace;
  for (let k = 0; complement + 9 * k <= 49; k++) numberWeights[complement + 9 * k] += 2;
  digitWeights[palace % 10] += 3;
  digitWeights[(10 - palace) % 10] += 2;
  // Element's digits too (黄土 → 5, 6)
  const elementDigits = { "木":[3,4], "火":[7,9], "土":[5,6], "金":[7,8], "水":[1,2] };
  for (const d of (elementDigits[element] || [])) digitWeights[d] += 2;

  return {
    name: "qimen",
    facts: {
      palace,                                    // 1..9
      colorZh: color,                            // 黄
      element,                                   // 土
      elementEn,                                 // Earth
      position,                                  // 中
      positionEn,                                // Center
      starGanZhi: color + element + position,    // 黄土中 — descriptive
    },
    digitWeights,
    numberWeights,
  };
}

module.exports = { compute };
