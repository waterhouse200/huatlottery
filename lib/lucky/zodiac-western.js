// ─── lib/lucky/zodiac-western.js ── Western sun-sign votes ───────────
//
// Approximated sun-sign cutoffs (good ±1 day). For Moon sign we use a
// noon-SGT fallback when birth time is missing — the synthesizer
// surfaces this caveat in the reading.

const SIGNS = [
  { name: "Capricorn",   element: "Earth", from: "12-22", to: "01-19", luckyDigits: [4, 8], luckyNumbers: [4, 8, 13, 22, 35] },
  { name: "Aquarius",    element: "Air",   from: "01-20", to: "02-18", luckyDigits: [4, 7], luckyNumbers: [4, 7, 11, 22, 29] },
  { name: "Pisces",      element: "Water", from: "02-19", to: "03-20", luckyDigits: [3, 9], luckyNumbers: [3, 9, 12, 15, 18] },
  { name: "Aries",       element: "Fire",  from: "03-21", to: "04-19", luckyDigits: [1, 9], luckyNumbers: [1, 9, 17, 21, 36] },
  { name: "Taurus",      element: "Earth", from: "04-20", to: "05-20", luckyDigits: [2, 6], luckyNumbers: [2, 6, 12, 24, 33] },
  { name: "Gemini",      element: "Air",   from: "05-21", to: "06-20", luckyDigits: [3, 5], luckyNumbers: [5, 14, 23, 32, 41] },
  { name: "Cancer",      element: "Water", from: "06-21", to: "07-22", luckyDigits: [2, 7], luckyNumbers: [2, 7, 11, 16, 20] },
  { name: "Leo",         element: "Fire",  from: "07-23", to: "08-22", luckyDigits: [1, 5], luckyNumbers: [1, 5, 10, 19, 28] },
  { name: "Virgo",       element: "Earth", from: "08-23", to: "09-22", luckyDigits: [5, 6], luckyNumbers: [5, 14, 15, 23, 32] },
  { name: "Libra",       element: "Air",   from: "09-23", to: "10-22", luckyDigits: [6, 9], luckyNumbers: [6, 15, 24, 33, 42] },
  { name: "Scorpio",     element: "Water", from: "10-23", to: "11-21", luckyDigits: [4, 8], luckyNumbers: [8, 13, 17, 22, 31] },
  { name: "Sagittarius", element: "Fire",  from: "11-22", to: "12-21", luckyDigits: [3, 9], luckyNumbers: [3, 9, 12, 21, 30] },
];

function mmddBetween(mmdd, from, to) {
  // Handles year-wrap (Capricorn 12-22 → 01-19)
  if (from <= to) return mmdd >= from && mmdd <= to;
  return mmdd >= from || mmdd <= to;
}

function sunSign(birthday) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthday);
  if (!m) throw new Error(`Invalid birthday: ${birthday}`);
  const mmdd = `${m[2]}-${m[3]}`;
  return SIGNS.find(s => mmddBetween(mmdd, s.from, s.to)) || SIGNS[0];
}

// Crude Moon-sign approximation: rotates through the 12 signs every ~2.5 days,
// starting from a known epoch. Real lunar position needs an ephemeris; this
// is good enough for "your moon sign is roughly X" without claiming precision.
// Epoch: 2000-01-01 12:00 UTC, Moon was ~Pisces.
const MOON_SIGN_ORDER = ["Pisces", "Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo", "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius"];
function moonSignApprox(birthday, timeHHMM) {
  const [Y, M, D] = birthday.split("-").map(Number);
  const [hh, mm] = (timeHHMM || "12:00").split(":").map(Number);
  const utc = Date.UTC(Y, M - 1, D, hh, mm, 0);
  const epoch = Date.UTC(2000, 0, 1, 12, 0, 0);
  const days = (utc - epoch) / 86400000;
  // Moon transits ~2.46 days per sign (27.3 days / 12 signs).
  const idx = ((Math.floor(days / 2.46) % 12) + 12) % 12;
  return MOON_SIGN_ORDER[idx];
}

function compute(birthday, time) {
  const sun  = sunSign(birthday);
  const moonName = moonSignApprox(birthday, time);
  const moon = SIGNS.find(s => s.name === moonName) || sun;

  const digitWeights = new Array(10).fill(0);
  const numberWeights = new Array(50).fill(0);

  for (const d of sun.luckyDigits)   digitWeights[d] += 2;
  for (const n of sun.luckyNumbers)  if (n >= 1 && n <= 49) numberWeights[n] += 2;
  for (const d of moon.luckyDigits)  digitWeights[d] += 1;
  for (const n of moon.luckyNumbers) if (n >= 1 && n <= 49) numberWeights[n] += 1;

  return {
    name: "zodiacWestern",
    facts: {
      sun: sun.name,
      sunElement: sun.element,
      moon: moon.name,
      moonElement: moon.element,
      moonApproximated: !time,
    },
    digitWeights,
    numberWeights,
  };
}

module.exports = { compute, SIGNS };
