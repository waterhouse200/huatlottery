// ─── lib/lucky/drawSchedule.js ── Next draw date per game ────────────
//
// Singapore Pools schedules (SGT, UTC+8):
//   - 4D   : Wed, Sat, Sun  (~6:30 PM SGT result)
//   - TOTO : Mon, Thu       (~6:30 PM SGT result)
//
// Rollover happens at 7:00 PM SGT — before that, today's draw (if today
// is a draw day) is the "upcoming" one; after that, look ahead.

const SGT_OFFSET_MIN = 8 * 60;

// Convert any Date to a SGT calendar object { ymd, dow, hourMin }.
function toSGT(now = new Date()) {
  const sgt = new Date(now.getTime() + (SGT_OFFSET_MIN - new Date().getTimezoneOffset() * -1) * 60000);
  // Use UTC accessors on a Date shifted into SGT so we get SGT calendar fields.
  const utcShift = new Date(now.getTime() + SGT_OFFSET_MIN * 60000);
  const y = utcShift.getUTCFullYear();
  const m = utcShift.getUTCMonth();
  const d = utcShift.getUTCDate();
  const dow = utcShift.getUTCDay();         // 0=Sun, 1=Mon, ..., 6=Sat
  const hh = utcShift.getUTCHours();
  const mm = utcShift.getUTCMinutes();
  return { y, m, d, dow, hh, mm };
}

function fmtYMD(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function addDays(y, m, d, n) {
  const dt = new Date(Date.UTC(y, m, d + n));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth(), d: dt.getUTCDate(), dow: dt.getUTCDay() };
}

// gameDraws: array of weekday indices (0=Sun..6=Sat) when this game draws.
function nextDrawDate(now, gameDraws) {
  const sgt = toSGT(now);
  // If today is a draw day AND it's before 7 PM SGT, today's draw is upcoming.
  const beforeRollover = sgt.hh < 19;
  for (let offset = 0; offset < 8; offset++) {
    const day = addDays(sgt.y, sgt.m, sgt.d, offset);
    if (!gameDraws.includes(day.dow)) continue;
    if (offset === 0 && !beforeRollover) continue;   // today's draw already done
    return fmtYMD(day.y, day.m, day.d);
  }
  // Should never happen — fall back to today.
  return fmtYMD(sgt.y, sgt.m, sgt.d);
}

const FOURD_DAYS = [3, 6, 0];   // Wed, Sat, Sun
const TOTO_DAYS  = [1, 4];      // Mon, Thu

function nextFourDDate(now = new Date()) { return nextDrawDate(now, FOURD_DAYS); }
function nextTotoDate(now = new Date())  { return nextDrawDate(now, TOTO_DAYS);  }

module.exports = { nextFourDDate, nextTotoDate, toSGT };
