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
const transits = require("./transits");

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

  // All 5 natal facts computed for the reading. Only lottery-relevant ones
  // contribute to picks. Numerology + Western are personality context only.
  const sysN = numerology.compute(birthday);
  const sysW = zodiacWestern.compute(birthday, time);
  const sysC = zodiacChinese.compute(birthday, time);                 // VOTES
  const sysB = bazi.compute(birthday, time);                          // VOTES
  const sysQ = qimen.compute(birthday, time);                         // VOTES (Day Nine Star)
  const sysT = transits.compute({ dayMasterElement: sysB.facts.dayMasterElement, now });  // VOTES

  // Folk vote: birthday DD/MM digits (Singapore 4D players literally play their birthday)
  const [, bdMM, bdDD] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthday) || [];
  const birthdayDigitVote = {
    name: "birthdayDigits",
    facts: { dd: bdDD, mm: bdMM },
    digitWeights: new Array(10).fill(0).map((_, i) => {
      const c = String(i);
      let w = 0;
      if (bdDD && bdDD.includes(c)) w += 1;
      if (bdMM && bdMM.includes(c)) w += 1;
      return w;
    }),
    numberWeights: new Array(50).fill(0),
  };

  // Lottery-relevant voting pool (5 sources):
  //   sysC  Chinese zodiac        (fixed)
  //   sysB  BaZi day master       (fixed)
  //   sysQ  Nine Palace           (fixed)
  //   sysT  Transits              (weekly + daily + solar term + year + moon)
  //   birthdayDigitVote           (small folk vote)
  const votingPool = [sysC, sysB, sysQ, sysT, birthdayDigitVote];

  // Picks stay the same all week — refresh every Monday when the week
  // anchor changes. 3 weekly 4D draws (Wed/Sat/Sun) and 2 weekly TOTO
  // draws (Mon/Thu) all share the same picks.
  const weekKey = sysT.facts.weekStartDate;
  const picks = synthesize({
    systems: votingPool,
    fourDSeed: `${birthday}|${time || "none"}|4D|${weekKey}`,
    totoSeed:  `${birthday}|${time || "none"}|TOTO|${weekKey}`,
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
    transits:      sysT.facts,
  };

  const reading = buildReading(facts, lang);

  // Combined digit weights from the voting pool (for the daily personal number)
  const combinedDigitWeights = new Array(10).fill(0);
  for (const sys of votingPool) {
    for (let i = 0; i < 10; i++) combinedDigitWeights[i] += sys.digitWeights[i] || 0;
  }

  return {
    weekRange: range,
    weekLabel: week.label,
    birthday,
    time,
    lang,
    systems: facts,
    picks: {
      fourD: picks.fourD,
      toto: picks.toto,
      weekStart: weekKey,                       // Monday
      fourDDrawDays: "Wed / Sat / Sun",
      totoDrawDays: "Mon / Thu",
    },
    reading,                                    // weekly, stays Mon-Sun
    daily: daily.compute({ birthday, time, lang, now, digitWeights: combinedDigitWeights }),  // refreshes every day
    notes: {
      hourPillarFromUserTime: facts.bazi.hourPillarFromUserTime,
      moonOmitted: "Western moon sign requires an ephemeris and is omitted to avoid inaccuracy.",
      dataSource: "lunar-javascript (BaZi pillars, year ganzhi, Day Nine Star) — all authentic Chinese calendar primitives.",
      numbersRefresh: "per draw — 4D on Wed/Sat/Sun, TOTO on Mon/Thu (after 7 PM SGT rollover)",
      readingRefresh: "weekly — same reading Mon through Sun",
      dailyRefresh: "daily — color/direction/hour/do/avoid roll over each midnight SGT",
    },
  };
}

module.exports = { getLuckyNumbers, isoWeek, weekRange };
