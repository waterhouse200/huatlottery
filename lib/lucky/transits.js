// ─── lib/lucky/transits.js ── Time-varying transits + natal interaction ─
//
// Five layers of temporal energy, each contributing votes:
//   1. Week pillar (ISO Monday)        — refreshes weekly
//   2. Day pillar (today)              — refreshes daily
//   3. Solar term (节气)               — refreshes every ~15 days
//   4. Year pillar                      — annual
//   5. Moon phase (waxing / waning)    — 2-week cycle
//
// All anchored on SGT (UTC+8). Headline comes from the relationship
// between user's natal day master and THIS WEEK's dominant element.

const { Solar } = require("lunar-javascript");

const STEM_ELEMENT = { 甲:"木",乙:"木",丙:"火",丁:"火",戊:"土",己:"土",庚:"金",辛:"金",壬:"水",癸:"水" };
const ELEMENT_EN   = { "木":"Wood", "火":"Fire", "土":"Earth", "金":"Metal", "水":"Water" };
const ELEMENT_DIGITS = { "木":[3,4], "火":[7,9], "土":[5,6], "金":[7,8], "水":[1,2] };
const NUM_CN = { "一":1,"二":2,"三":3,"四":4,"五":5,"六":6,"七":7,"八":8,"九":9 };

// Each of the 24 solar terms maps to a season's element.
const TERM_ELEMENT = {
  立春:"木", 雨水:"木", 惊蛰:"木", 春分:"木", 清明:"木", 谷雨:"木",
  立夏:"火", 小满:"火", 芒种:"火", 夏至:"火", 小暑:"火", 大暑:"火",
  立秋:"金", 处暑:"金", 白露:"金", 秋分:"金", 寒露:"金", 霜降:"金",
  立冬:"水", 小雪:"水", 大雪:"水", 冬至:"水", 小寒:"水", 大寒:"水",
};

const PRODUCES = { "木":"火", "火":"土", "土":"金", "金":"水", "水":"木" };
const CONTROLS = { "木":"土", "土":"水", "水":"火", "火":"金", "金":"木" };

function relationship(natalEl, weekEl) {
  if (natalEl === weekEl)               return { code: "peer",     favorable: true,  zhName: "比劫" };
  if (PRODUCES[weekEl]  === natalEl)    return { code: "resource", favorable: true,  zhName: "印" };
  if (PRODUCES[natalEl] === weekEl)     return { code: "output",   favorable: false, zhName: "食伤" };
  if (CONTROLS[weekEl]  === natalEl)    return { code: "officer",  favorable: false, zhName: "官杀" };
  if (CONTROLS[natalEl] === weekEl)     return { code: "wealth",   favorable: true,  zhName: "财" };
  return { code: "neutral", favorable: false, zhName: "" };
}

function sgtYmd(now) {
  const sgt = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return { Y: sgt.getUTCFullYear(), M: sgt.getUTCMonth() + 1, D: sgt.getUTCDate(), dow: sgt.getUTCDay() || 7 };
}

function isoMondayFrom(sgt) {
  const dt = new Date(Date.UTC(sgt.Y, sgt.M - 1, sgt.D));
  dt.setUTCDate(dt.getUTCDate() - (sgt.dow - 1));
  return { Y: dt.getUTCFullYear(), M: dt.getUTCMonth() + 1, D: dt.getUTCDate() };
}

function currentJieQi(solar) {
  const lunar = solar.getLunar();
  const table = lunar.getJieQiTable();
  const dStr = solar.toYmd();
  let best = null;
  for (const name of Object.keys(table)) {
    const ds = table[name].toYmd();
    if (ds <= dStr && (!best || ds > best.ds)) best = { name, ds };
  }
  return best || { name: null, ds: null };
}

function compute({ dayMasterElement, now = new Date() }) {
  const today = sgtYmd(now);
  const monday = isoMondayFrom(today);

  // Week (Monday anchor)
  const weekLunar = Solar.fromYmdHms(monday.Y, monday.M, monday.D, 12, 0, 0).getLunar();
  const weekStem   = weekLunar.getDayGan();
  const weekBranch = weekLunar.getDayZhi();
  const weekGanZhi = weekStem + weekBranch;
  const weekEl     = STEM_ELEMENT[weekStem] || "土";
  const weekPalace = NUM_CN[weekLunar.getDayNineStar().getNumber()] || 5;

  // Today
  const todaySolar = Solar.fromYmdHms(today.Y, today.M, today.D, 12, 0, 0);
  const todayLunar = todaySolar.getLunar();
  const todayStem   = todayLunar.getDayGan();
  const todayBranch = todayLunar.getDayZhi();
  const todayGanZhi = todayStem + todayBranch;
  const todayEl     = STEM_ELEMENT[todayStem] || "土";
  const todayPalace = NUM_CN[todayLunar.getDayNineStar().getNumber()] || 5;

  // Year
  const yearStem    = todayLunar.getYearGan();
  const yearBranch  = todayLunar.getYearZhi();
  const yearGanZhi  = todayLunar.getYearInGanZhi();
  const yearEl      = STEM_ELEMENT[yearStem] || "土";

  const monthGanZhi = todayLunar.getMonthInGanZhi();
  const monthStem   = todayLunar.getMonthGan();
  const monthEl     = STEM_ELEMENT[monthStem] || "土";

  // Solar term
  const jq = currentJieQi(todaySolar);
  const jqEl = jq.name ? (TERM_ELEMENT[jq.name] || null) : null;

  // Moon phase
  const lunarDay = todayLunar.getDay();
  const moonWaxing = lunarDay <= 15;
  const moonPhaseDesc = moonWaxing ? "waxing" : "waning";

  // Relationship: this week's element vs user's natal day master
  const natalEl = dayMasterElement || "土";
  const rel = relationship(natalEl, weekEl);

  // ── Combined votes from all 5 temporal layers ──
  const digitWeights = new Array(10).fill(0);
  const numberWeights = new Array(50).fill(0);

  // [1] WEEK (heaviest temporal vote — weight 3, +2 bonus if favorable)
  for (const d of (ELEMENT_DIGITS[weekEl] || [])) digitWeights[d] += 3;
  if (rel.favorable) {
    for (const d of (ELEMENT_DIGITS[weekEl] || [])) digitWeights[d] += 2;
  }
  for (let k = 0; weekPalace + 9 * k <= 49; k++) numberWeights[weekPalace + 9 * k] += 3;

  // [TODAY layer intentionally NOT voting] — kept in facts for display only.
  // Picks must stay stable through all 3 weekly 4D draws / 2 TOTO draws,
  // so the voting pool uses only week-level (or slower) anchors.

  // [2] SOLAR TERM (weight 2)
  if (jqEl) for (const d of (ELEMENT_DIGITS[jqEl] || [])) digitWeights[d] += 2;

  // [3] YEAR (weight 1)
  for (const d of (ELEMENT_DIGITS[yearEl] || [])) digitWeights[d] += 1;

  // [4] MOON (weight 1, growth digits if waxing, clearing if waning)
  if (moonWaxing) {
    for (const d of [3, 4, 7, 9]) digitWeights[d] += 1;
  } else {
    for (const d of [1, 2, 7, 8]) digitWeights[d] += 1;
  }

  return {
    name: "transits",
    facts: {
      weekStartDate: `${monday.Y}-${String(monday.M).padStart(2,"0")}-${String(monday.D).padStart(2,"0")}`,
      weekGanZhi, weekStem, weekBranch,
      weekElement: weekEl, weekElementEn: ELEMENT_EN[weekEl],
      weekPalace,

      todayDate: `${today.Y}-${String(today.M).padStart(2,"0")}-${String(today.D).padStart(2,"0")}`,
      todayGanZhi, todayStem, todayBranch,
      todayElement: todayEl, todayElementEn: ELEMENT_EN[todayEl],
      todayPalace,

      yearGanZhi, yearStem, yearBranch,
      yearElement: yearEl, yearElementEn: ELEMENT_EN[yearEl],
      monthGanZhi, monthElement: monthEl, monthElementEn: ELEMENT_EN[monthEl],

      jieQiName: jq.name, jieQiStartDate: jq.ds,
      jieQiElement: jqEl, jieQiElementEn: jqEl ? ELEMENT_EN[jqEl] : null,

      lunarDay,
      moonWaxing,
      moonPhaseDesc,

      natalElement: natalEl,
      natalElementEn: ELEMENT_EN[natalEl],
      relationship: rel.code,
      relationshipZh: rel.zhName,
      favorable: rel.favorable,
    },
    digitWeights,
    numberWeights,
  };
}

module.exports = { compute, relationship };
