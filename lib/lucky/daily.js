// ─── lib/lucky/daily.js ── Daily-rotating snippets ───────────────────
//
// Today's color / direction / lucky hour / avoid — seeded by
// (birthday + today's date) so each day brings fresh content.
// This is what brings users back daily.

const crypto = require("crypto");
const { Solar } = require("lunar-javascript");

function seedRng(s) {
  const h = crypto.createHash("sha256").update(s).digest();
  let a = h.readUInt32LE(0) >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

const COLORS = {
  en: [
    { name: "Red",        element: "Fire",  hex: "#dc2626" },
    { name: "Orange",     element: "Fire",  hex: "#ea580c" },
    { name: "Yellow",     element: "Earth", hex: "#eab308" },
    { name: "Gold",       element: "Earth", hex: "#d97706" },
    { name: "Green",      element: "Wood",  hex: "#16a34a" },
    { name: "Jade",       element: "Wood",  hex: "#0d9488" },
    { name: "Blue",       element: "Water", hex: "#2563eb" },
    { name: "Navy",       element: "Water", hex: "#1e3a8a" },
    { name: "White",      element: "Metal", hex: "#f5f5f4" },
    { name: "Silver",     element: "Metal", hex: "#a8a29e" },
    { name: "Purple",     element: "Wood",  hex: "#7c3aed" },
    { name: "Pink",       element: "Fire",  hex: "#ec4899" },
  ],
  zh: [
    { name: "红色",   element: "火", hex: "#dc2626" },
    { name: "橙色",   element: "火", hex: "#ea580c" },
    { name: "黄色",   element: "土", hex: "#eab308" },
    { name: "金色",   element: "土", hex: "#d97706" },
    { name: "绿色",   element: "木", hex: "#16a34a" },
    { name: "翡翠绿", element: "木", hex: "#0d9488" },
    { name: "蓝色",   element: "水", hex: "#2563eb" },
    { name: "深蓝",   element: "水", hex: "#1e3a8a" },
    { name: "白色",   element: "金", hex: "#f5f5f4" },
    { name: "银色",   element: "金", hex: "#a8a29e" },
    { name: "紫色",   element: "木", hex: "#7c3aed" },
    { name: "粉色",   element: "火", hex: "#ec4899" },
  ],
};

const DIRECTIONS = {
  en: ["North", "Northeast", "East", "Southeast", "South", "Southwest", "West", "Northwest"],
  zh: ["北方", "东北", "东方", "东南", "南方", "西南", "西方", "西北"],
};

const HOURS_EN = [
  { label: "Rat hour (11pm-1am)",     start: 23 },
  { label: "Ox hour (1am-3am)",       start: 1 },
  { label: "Tiger hour (3am-5am)",    start: 3 },
  { label: "Rabbit hour (5am-7am)",   start: 5 },
  { label: "Dragon hour (7am-9am)",   start: 7 },
  { label: "Snake hour (9am-11am)",   start: 9 },
  { label: "Horse hour (11am-1pm)",   start: 11 },
  { label: "Goat hour (1pm-3pm)",     start: 13 },
  { label: "Monkey hour (3pm-5pm)",   start: 15 },
  { label: "Rooster hour (5pm-7pm)",  start: 17 },
  { label: "Dog hour (7pm-9pm)",      start: 19 },
  { label: "Pig hour (9pm-11pm)",     start: 21 },
];
const HOURS_ZH = [
  { label: "子时 (晚11时-凌晨1时)", start: 23 },
  { label: "丑时 (凌晨1时-3时)",     start: 1 },
  { label: "寅时 (凌晨3时-5时)",     start: 3 },
  { label: "卯时 (清晨5时-7时)",     start: 5 },
  { label: "辰时 (早晨7时-9时)",     start: 7 },
  { label: "巳时 (上午9时-11时)",    start: 9 },
  { label: "午时 (中午11时-下午1时)",start: 11 },
  { label: "未时 (下午1时-3时)",     start: 13 },
  { label: "申时 (下午3时-5时)",     start: 15 },
  { label: "酉时 (傍晚5时-7时)",     start: 17 },
  { label: "戌时 (晚7时-9时)",       start: 19 },
  { label: "亥时 (晚9时-11时)",      start: 21 },
];

const ACTIVITY_DOS = {
  en: [
    "Sign contracts or close deals",
    "Have an important conversation",
    "Start a creative project",
    "Travel or take a short trip",
    "Network and meet new people",
    "Buy lottery — your numbers are aligned",
    "Make a financial decision",
    "Move forward on something you've delayed",
  ],
  zh: [
    "签合约、谈生意",
    "进行重要对话",
    "开启创意项目",
    "出行或短途旅行",
    "扩展人脉、结识新朋友",
    "购买彩票，今日号码顺势",
    "做重大财务决定",
    "推进搁置已久的事",
  ],
};

const ACTIVITY_AVOIDS = {
  en: [
    "Major arguments or confrontations",
    "Risky bets outside lottery",
    "Signing anything in a hurry",
    "Long-distance moves",
    "Borrowing or lending money",
    "Decisions made when tired",
    "Eating heavy late-night meals",
    "Starting new ventures with strangers",
  ],
  zh: [
    "重大争执或冲突",
    "彩票之外的高风险投注",
    "匆忙签署任何文件",
    "长距离搬迁",
    "借贷往来",
    "疲惫状态下做决策",
    "深夜大餐",
    "与陌生人合伙开新项目",
  ],
};

// Local "today" date in SGT (UTC+8) → YYYY-MM-DD
function todaySGT(now = new Date()) {
  const sgt = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return sgt.toISOString().slice(0, 10);
}

// Animal of today's date (Chinese zodiac of the day branch)
function todayAnimal(lang = "en", now = new Date()) {
  const [Y, M, D] = todaySGT(now).split("-").map(Number);
  const lunar = Solar.fromYmdHms(Y, M, D, 12, 0, 0).getLunar();
  const branch = lunar.getDayZhi();
  const map = {
    "子": { en: "Rat",     zh: "鼠" }, "丑": { en: "Ox",      zh: "牛" },
    "寅": { en: "Tiger",   zh: "虎" }, "卯": { en: "Rabbit",  zh: "兔" },
    "辰": { en: "Dragon",  zh: "龙" }, "巳": { en: "Snake",   zh: "蛇" },
    "午": { en: "Horse",   zh: "马" }, "未": { en: "Goat",    zh: "羊" },
    "申": { en: "Monkey",  zh: "猴" }, "酉": { en: "Rooster", zh: "鸡" },
    "戌": { en: "Dog",     zh: "狗" }, "亥": { en: "Pig",     zh: "猪" },
  };
  return (map[branch] || { en: branch, zh: branch })[lang];
}

// Pick one index from `weights` using rng (weighted). Inline duplicate so
// daily stays self-contained.
function weightedPick(rng, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return Math.floor(rng() * weights.length);
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

function compute({ birthday, time, lang = "en", now = new Date(), digitWeights = null }) {
  const today = todaySGT(now);
  const seedStr = `${birthday}|${time || "none"}|${today}|daily`;
  const rng = seedRng(seedStr);

  // Personal lucky number for today — 2 digits sampled from the user's
  // combined natal+transit digit weights, with a dedicated seed so it
  // doesn't collide with the 4D picks.
  let personalLuckyNumber = null;
  if (digitWeights && Array.isArray(digitWeights) && digitWeights.length === 10) {
    const personalRng = seedRng(`${birthday}|${time || "none"}|${today}|personal`);
    const smoothed = digitWeights.map(v => v + 0.5);
    const d1 = weightedPick(personalRng, smoothed);
    const d2 = weightedPick(personalRng, smoothed);
    personalLuckyNumber = String(d1) + String(d2);     // "07", "47", "99"
  }

  return {
    date: today,
    dayAnimal: todayAnimal(lang, now),
    color:        pick(rng, COLORS[lang === "zh" ? "zh" : "en"]),
    direction:    pick(rng, DIRECTIONS[lang === "zh" ? "zh" : "en"]),
    luckyHour:    pick(rng, lang === "zh" ? HOURS_ZH : HOURS_EN),
    doActivity:   pick(rng, ACTIVITY_DOS[lang === "zh" ? "zh" : "en"]),
    avoidActivity: pick(rng, ACTIVITY_AVOIDS[lang === "zh" ? "zh" : "en"]),
    personalLuckyNumber,
  };
}

module.exports = { compute, todaySGT };
