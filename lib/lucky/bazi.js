// ─── lib/lucky/bazi.js ── BaZi 4-pillars votes ───────────────────────
//
// Each pillar = stem (10) + branch (12). Stems map to 5 elements × 2
// polarities (0-9 directly). Branches map to 12 zodiac animals (1-12),
// usable for the 1-49 pool via stride-by-12.

const { Solar } = require("lunar-javascript");

const STEM_TO_DIGIT = {
  "甲": 1, "乙": 2,  // Wood
  "丙": 3, "丁": 4,  // Fire
  "戊": 5, "己": 6,  // Earth
  "庚": 7, "辛": 8,  // Metal
  "壬": 9, "癸": 0,  // Water
};

const BRANCH_TO_NUM = {
  "子": 1, "丑": 2, "寅": 3, "卯": 4, "辰": 5, "巳": 6,
  "午": 7, "未": 8, "申": 9, "酉": 10, "戌": 11, "亥": 12,
};

const STEM_EN = {
  "甲": "Yang Wood", "乙": "Yin Wood",
  "丙": "Yang Fire", "丁": "Yin Fire",
  "戊": "Yang Earth", "己": "Yin Earth",
  "庚": "Yang Metal", "辛": "Yin Metal",
  "壬": "Yang Water", "癸": "Yin Water",
};

const STEM_ELEMENT = { 甲:"木",乙:"木",丙:"火",丁:"火",戊:"土",己:"土",庚:"金",辛:"金",壬:"水",癸:"水" };

// Branches a given day-master element favors (productive cycle).
const FAVOR_BRANCHES = {
  "木": ["子", "亥"],            // Wood favors Water
  "火": ["寅", "卯"],            // Fire favors Wood
  "土": ["巳", "午"],            // Earth favors Fire
  "金": ["辰", "未", "戌", "丑"], // Metal favors Earth
  "水": ["申", "酉"],            // Water favors Metal
};

function compute(birthday, time) {
  const [Y, M, D] = birthday.split("-").map(Number);
  const [hh, mm] = (time || "12:00").split(":").map(Number);
  const solar = Solar.fromYmdHms(Y, M, D, hh, mm, 0);
  const lunar = solar.getLunar();

  const pillars = {
    year:  { stem: lunar.getYearGan(),  branch: lunar.getYearZhi(),  display: lunar.getYearInGanZhi()  },
    month: { stem: lunar.getMonthGan(), branch: lunar.getMonthZhi(), display: lunar.getMonthInGanZhi() },
    day:   { stem: lunar.getDayGan(),   branch: lunar.getDayZhi(),   display: lunar.getDayInGanZhi()   },
    hour:  { stem: lunar.getTimeGan(),  branch: lunar.getTimeZhi(),  display: lunar.getTimeInGanZhi()  },
  };

  const dayMasterStem = pillars.day.stem;
  const dayMasterEl   = STEM_ELEMENT[dayMasterStem] || "土";
  const favored = FAVOR_BRANCHES[dayMasterEl] || [];

  const digitWeights = new Array(10).fill(0);
  const numberWeights = new Array(50).fill(0);

  // Stem → digit votes (day master strongest)
  const weighStem = (stem, w) => {
    const d = STEM_TO_DIGIT[stem];
    if (d != null) digitWeights[d] += w;
  };
  weighStem(pillars.day.stem,   3);
  weighStem(pillars.year.stem,  1);
  weighStem(pillars.month.stem, 1);
  weighStem(pillars.hour.stem,  time ? 2 : 0); // only count hour if user gave time

  // Branch → number votes (animal index 1-12, plus +12, +24, +36 multiples within 1-49)
  const weighBranch = (branch, w) => {
    const base = BRANCH_TO_NUM[branch];
    if (base == null) return;
    for (let k = 0; base + 12 * k <= 49; k++) numberWeights[base + 12 * k] += w;
  };
  weighBranch(pillars.day.branch,   3);
  weighBranch(pillars.year.branch,  2);
  weighBranch(pillars.month.branch, 1);
  weighBranch(pillars.hour.branch,  time ? 2 : 0);

  // Favored branches (productive cycle) also voted
  for (const b of favored) weighBranch(b, 1);

  return {
    name: "bazi",
    facts: {
      pillars: {
        year:  pillars.year.display,
        month: pillars.month.display,
        day:   pillars.day.display,
        hour:  pillars.hour.display,
      },
      dayMaster: dayMasterStem,
      dayMasterEn: STEM_EN[dayMasterStem] || dayMasterStem,
      dayMasterElement: dayMasterEl,
      hourPillarFromUserTime: !!time,
    },
    digitWeights,
    numberWeights,
  };
}

module.exports = { compute, STEM_TO_DIGIT, BRANCH_TO_NUM };
