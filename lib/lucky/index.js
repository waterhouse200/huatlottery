// ─── lib/lucky/index.js ── Orchestrator ───────────────────────────────

const numerology    = require("./numerology");
const zodiacWestern = require("./zodiac-western");
const zodiacChinese = require("./zodiac-chinese");
const bazi          = require("./bazi");
const qimen         = require("./qimen");
const { synthesize } = require("./synthesize");
const { buildReading } = require("./reading");
const { nextFourDDate, nextTotoDate } = require("./drawSchedule");
const daily = require("./daily");

// Returns ISO week label ("2026-W22") and the Mon..Sun date range for that week.
function isoWeek(date = new Date()) {
  // Copy date so we don't modify it; shift to Thursday of current week
  // (ISO weeks pivot on Thursday).
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return {
    label: `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`,
    year: d.getUTCFullYear(),
    week: weekNo,
  };
}

function weekRange(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;        // 1..7, Mon=1
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - (day - 1));
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const fmt = x => x.toISOString().slice(0, 10);
  return { start: fmt(monday), end: fmt(sunday) };
}

function getLuckyNumbers({ birthday, time = null, lang = "en", now = new Date() }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday)) {
    throw new Error("birthday must be YYYY-MM-DD");
  }
  if (time && !/^\d{2}:\d{2}$/.test(time)) {
    throw new Error("time must be HH:MM");
  }

  const week = isoWeek(now);
  const range = weekRange(now);

  // Five system votes
  const sysN = numerology.compute(birthday);
  const sysW = zodiacWestern.compute(birthday, time);
  const sysC = zodiacChinese.compute(birthday, time);
  const sysB = bazi.compute(birthday, time);
  const sysQ = qimen.compute(birthday, time);

  const next4D   = nextFourDDate(now);
  const nextToto = nextTotoDate(now);
  const picks = synthesize({
    systems: [sysN, sysW, sysC, sysB, sysQ],
    fourDSeed: `${birthday}|${time || "none"}|4D|${next4D}`,
    totoSeed:  `${birthday}|${time || "none"}|TOTO|${nextToto}`,
    fourDSets: 3,
    totoSets: 2,
    totoSize: 6,
  });

  const facts = {
    numerology:    sysN.facts,
    zodiacWestern: sysW.facts,
    zodiacChinese: sysC.facts,
    bazi:          sysB.facts,
    qimen:         sysQ.facts,
  };

  const reading = buildReading(facts, lang);

  return {
    weekRange: range,
    weekLabel: week.label,
    birthday,
    time,
    lang,
    systems: facts,
    picks: {
      fourD: picks.fourD,
      fourDForDrawDate: next4D,                 // Wed/Sat/Sun
      toto: picks.toto,
      totoForDrawDate: nextToto,                // Mon/Thu
    },
    reading,                                    // weekly, stays Mon-Sun
    daily: daily.compute({ birthday, time, lang, now }),  // refreshes every day
    notes: {
      moonApproximated: facts.zodiacWestern.moonApproximated,
      hourPillarFromUserTime: facts.bazi.hourPillarFromUserTime,
      numbersRefresh: "per draw — 4D on Wed/Sat/Sun, TOTO on Mon/Thu (after 7 PM SGT rollover)",
      readingRefresh: "weekly — same reading Mon through Sun",
      dailyRefresh: "daily — color/direction/hour/do/avoid roll over each midnight SGT",
    },
  };
}

module.exports = { getLuckyNumbers, isoWeek, weekRange };
