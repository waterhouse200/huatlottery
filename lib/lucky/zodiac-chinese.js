// ─── lib/lucky/zodiac-chinese.js ── Chinese animal/element votes ─────

const { Solar } = require("lunar-javascript");

// Traditional lucky digits/numbers per animal (folk-belief consensus).
const ANIMALS = {
  "鼠": { en: "Rat",     luckyDigits: [2, 3], luckyNumbers: [2, 3, 11, 22, 33] },
  "牛": { en: "Ox",      luckyDigits: [1, 9], luckyNumbers: [1, 9, 19, 28, 37] },
  "虎": { en: "Tiger",   luckyDigits: [1, 3], luckyNumbers: [1, 3, 4, 13, 31] },
  "兔": { en: "Rabbit",  luckyDigits: [3, 4], luckyNumbers: [3, 4, 9, 24, 39] },
  "龙": { en: "Dragon",  luckyDigits: [1, 6], luckyNumbers: [1, 6, 7, 16, 25] },
  "蛇": { en: "Snake",   luckyDigits: [2, 8], luckyNumbers: [2, 8, 9, 18, 24] },
  "马": { en: "Horse",   luckyDigits: [2, 7], luckyNumbers: [2, 7, 19, 27, 38] },
  "羊": { en: "Goat",    luckyDigits: [3, 9], luckyNumbers: [3, 9, 12, 21, 39] },
  "猴": { en: "Monkey",  luckyDigits: [4, 8], luckyNumbers: [4, 8, 13, 31, 44] },
  "鸡": { en: "Rooster", luckyDigits: [5, 7], luckyNumbers: [5, 7, 25, 34, 47] },
  "狗": { en: "Dog",     luckyDigits: [3, 4], luckyNumbers: [3, 4, 9, 13, 26] },
  "猪": { en: "Pig",     luckyDigits: [2, 5], luckyNumbers: [2, 5, 8, 17, 35] },
};

// Stem-element → digits (5 elements × 2 polarities → 0-9)
const ELEMENT_DIGITS = {
  "木": [3, 4],  // Wood
  "火": [7, 9],  // Fire (lucky in SG culture)
  "土": [5, 6],  // Earth
  "金": [7, 8],  // Metal
  "水": [1, 2],  // Water
};

const STEM_ELEMENT = { 甲:"木",乙:"木",丙:"火",丁:"火",戊:"土",己:"土",庚:"金",辛:"金",壬:"水",癸:"水" };

function compute(birthday, time) {
  const [Y, M, D] = birthday.split("-").map(Number);
  const [hh, mm] = (time || "12:00").split(":").map(Number);
  const solar = Solar.fromYmdHms(Y, M, D, hh, mm, 0);
  const lunar = solar.getLunar();

  const animal = lunar.getYearShengXiao();          // 马
  const dayMasterStem = lunar.getDayGan();          // 己
  const dayMasterEl   = STEM_ELEMENT[dayMasterStem] || "土";

  const a = ANIMALS[animal] || { en: animal, luckyDigits: [], luckyNumbers: [] };
  const elDigits = ELEMENT_DIGITS[dayMasterEl] || [];

  const digitWeights = new Array(10).fill(0);
  const numberWeights = new Array(50).fill(0);

  for (const d of a.luckyDigits)   digitWeights[d] += 2;
  for (const n of a.luckyNumbers)  if (n >= 1 && n <= 49) numberWeights[n] += 2;
  for (const d of elDigits)        digitWeights[d] += 1;

  return {
    name: "zodiacChinese",
    facts: {
      animal,
      animalEn: a.en,
      dayMasterStem,
      dayMasterElement: dayMasterEl,
    },
    digitWeights,
    numberWeights,
  };
}

module.exports = { compute, ANIMALS };
