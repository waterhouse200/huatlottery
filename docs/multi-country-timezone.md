# Multi-country lottery — timezone convention

Locked design so adding other countries (Malaysia, Thailand, Laos, "global", …) never
causes timezone mix-ups. Established 2026-06-21.

## The one rule
The scheduler never works in wall-clock time. For each lottery we read its stated
draw time, stamp it with **that lottery's own timezone**, and turn it into a single
**absolute instant**. All scheduling math (start at draw-time **+1 min**, retry every
**5 min** until the result is out, then stop) then operates on that instant — so any
number of countries run side by side and never collide.

Today's code already does this: `Date.parse("...T18:30:00+08:00")`. The offset is the
only country-specific part (SG/Malaysia `+08:00`, Thailand/Laos `+07:00`).

## Per-lottery config shape
```js
const LOTTERIES = {
  sg_4d:   { country: "Singapore", tz: "Asia/Singapore",  source: "...", parse: ... }, // +08
  sg_toto: { country: "Singapore", tz: "Asia/Singapore",  source: "...", parse: ... },
  my_4d:   { country: "Malaysia",  tz: "Asia/Kuala_Lumpur", source: "...", parse: ... }, // +08
  th_gov:  { country: "Thailand",  tz: "Asia/Bangkok",    source: "...", parse: ... }, // +07
  lao:     { country: "Laos",      tz: "Asia/Vientiane",  source: "...", parse: ... }, // +07
};
```
You declare `tz` once per lottery; the same dynamic engine handles all of them.

## Two rules that keep it bulletproof
1. **Use IANA timezone names** (`Asia/Kuala_Lumpur`, `Asia/Bangkok`, `America/New_York`)
   — NOT raw offsets. SG/MY/TH/Laos have no daylight saving so a fixed offset would
   work, but a "global" lottery in a DST country (US Powerball, EuroMillions) shifts an
   hour twice a year. Declare the tz name, derive the offset at draw time → no drift.
2. **Store all timestamps in UTC, display in the lottery's local tz.** One storage
   truth (UTC, via SQLite `datetime('now')`) = no DB mix-ups; apply the country tz only
   when showing it. (This is the exact confusion that bit us on 2026-06-21 — a UTC
   `created_at` was misread as local.)

## Timing engine (already implemented, country-agnostic)
`scraper/auto.js`: reads SP's "Next Draw" line live each cycle → arms for that time
`+ SCRAPE_OFFSET_MS` (1 min) → polls every `RETRY_MS` (5 min) until the draw number is
captured → stops → reschedules. Dynamic: shifts automatically with special/big draws.
