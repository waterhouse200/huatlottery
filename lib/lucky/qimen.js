// ─── lib/lucky/qimen.js ── Simplified Qi Men palace votes ────────────
//
// Full Qi Men Dun Jia requires solar-term + day-stem + hour-stem palace
// rotation tables. For a personal lucky-number app we use a respectful
// simplification: the LoShu (洛书) magic square assigns each user a base
// palace (1-9) derived from the BaZi day stem + day branch + week index.
// Each palace has a traditional element + lucky digit set.
//
// The LoShu magic square:
//   4 9 2
//   3 5 7
//   8 1 6
// (all rows/cols/diagonals sum to 15.)

const { Solar } = require("lunar-javascript");

const PALACES = {
  1: { name: "Kan",  nameZh: "坎", element: "Water", direction: "North",     luckyDigits: [1, 6] },
  2: { name: "Kun",  nameZh: "坤", element: "Earth", direction: "Southwest", luckyDigits: [2, 5] },
  3: { name: "Zhen", nameZh: "震", element: "Wood",  direction: "East",      luckyDigits: [3, 8] },
  4: { name: "Xun",  nameZh: "巽", element: "Wood",  direction: "Southeast", luckyDigits: [3, 4] },
  5: { name: "Center", nameZh: "中", element: "Earth", direction: "Center",  luckyDigits: [5, 0] },
  6: { name: "Qian", nameZh: "乾", element: "Metal", direction: "Northwest", luckyDigits: [6, 1] },
  7: { name: "Dui",  nameZh: "兑", element: "Metal", direction: "West",      luckyDigits: [7, 2] },
  8: { name: "Gen",  nameZh: "艮", element: "Earth", direction: "Northeast", luckyDigits: [8, 5] },
  9: { name: "Li",   nameZh: "离", element: "Fire",  direction: "South",     luckyDigits: [9, 4] },
};

// Stem-branch combinations to a palace 1-9. Derived from the day-stem
// index (0-9) and day-branch index (0-11), modulated to 1-9.
const STEM_IDX = { "甲":0,"乙":1,"丙":2,"丁":3,"戊":4,"己":5,"庚":6,"辛":7,"壬":8,"癸":9 };
const BRANCH_IDX = { "子":0,"丑":1,"寅":2,"卯":3,"辰":4,"巳":5,"午":6,"未":7,"申":8,"酉":9,"戌":10,"亥":11 };

function basePalace(stem, branch) {
  const s = STEM_IDX[stem] ?? 0;
  const b = BRANCH_IDX[branch] ?? 0;
  return ((s * 3 + b) % 9) + 1;
}

function compute(birthday, time) {
  const [Y, M, D] = birthday.split("-").map(Number);
  const [hh, mm] = (time || "12:00").split(":").map(Number);
  const solar = Solar.fromYmdHms(Y, M, D, hh, mm, 0);
  const lunar = solar.getLunar();

  const palace = basePalace(lunar.getDayGan(), lunar.getDayZhi());
  const info = PALACES[palace];

  const digitWeights = new Array(10).fill(0);
  const numberWeights = new Array(50).fill(0);

  // Palace's lucky digits
  for (const d of info.luckyDigits) digitWeights[d] += 2;

  // The palace number itself, plus its arithmetic-progression neighbors in 1-49
  for (let k = 0; palace + 9 * k <= 49; k++) numberWeights[palace + 9 * k] += 2;
  // The magic-square complement (sum to 10 with palace, except 5 ↔ 5)
  const complement = palace === 5 ? 5 : 10 - palace;
  for (let k = 0; complement + 9 * k <= 49; k++) numberWeights[complement + 9 * k] += 1;

  return {
    name: "qimen",
    facts: {
      palace,
      palaceName: info.name,
      palaceNameZh: info.nameZh,
      element: info.element,
      direction: info.direction,
    },
    digitWeights,
    numberWeights,
  };
}

module.exports = { compute, PALACES };
