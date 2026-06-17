// ─── routes/lab/index.js ── lab.huatlottery.com private playground ──
//
// Mounted only when req.hostname matches the lab host (see server.js).
// All routes below assume that prefix has already been stripped — i.e.
// the dashboard lives at GET "/" from the lab router's perspective.
//
// Auth: option B (cookie-based simple password). Password lives in the
// LAB_PASSWORD env var; cookie is HMAC-signed with LAB_SECRET, expires
// after 30 days. Login form is the only unauthenticated route.

const express = require("express");
const crypto  = require("crypto");

// ─── Config ────────────────────────────────────────────────────────
// Both values come from environment variables. If either is missing, we
// fall back to a fresh random value generated at startup so the lab
// stays inaccessible (no one — including the developer — can guess it).
// In that case we log a clear note so it's obvious what to set.
function randomHex(bytes) { return crypto.randomBytes(bytes).toString("hex"); }

const PASSWORD = process.env.LAB_PASSWORD || randomHex(16);
const SECRET   = process.env.LAB_SECRET   || randomHex(32);
const COOKIE   = "lab_session";
const COOKIE_TTL_DAYS = 30;

if (!process.env.LAB_PASSWORD) {
  console.warn("[lab] LAB_PASSWORD env var not set — lab login is disabled. " +
               "Set LAB_PASSWORD (and ideally LAB_SECRET) to enable.");
}

// ─── Token signing (HMAC-SHA256 over expiry timestamp) ──────────────
function makeToken(expiresAt) {
  const sig = crypto.createHmac("sha256", SECRET).update(String(expiresAt)).digest("hex");
  return `${expiresAt}.${sig}`;
}
function verifyToken(token) {
  if (!token || typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac("sha256", SECRET).update(exp).digest("hex");
  // constant-time compare to avoid timing leaks
  if (sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  if (Date.now() > parseInt(exp, 10)) return false;
  return true;
}
function getCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const p of raw.split(/;\s*/)) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    if (p.slice(0, eq) === name) return decodeURIComponent(p.slice(eq + 1));
  }
  return null;
}

// ─── Schema (idempotent) ────────────────────────────────────────────
// Uses ALTER ADD COLUMN (with a try/catch) so existing prod data survives
// the v2 columns being added — SQLite has no IF NOT EXISTS for ALTER.
function initLabSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lab_pageviews (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ts        TEXT    NOT NULL DEFAULT (datetime('now')),
      path      TEXT    NOT NULL,
      tab       TEXT,
      referrer  TEXT,
      ua        TEXT,
      lang      TEXT,
      ip_hash   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_lab_pv_ts  ON lab_pageviews(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_lab_pv_tab ON lab_pageviews(tab);

    -- Geo cache — looked up once per unique IP, reused across rows.
    -- Stores ONLY country-level data (no precise location) so privacy
    -- impact is low even if the DB leaks.
    CREATE TABLE IF NOT EXISTS lab_geo_cache (
      ip            TEXT PRIMARY KEY,
      country       TEXT,
      country_code  TEXT,
      city          TEXT,
      fetched_at    TEXT DEFAULT (datetime('now'))
    );

    -- Dwell-time samples sent by the client when the page is unloaded.
    -- One row per (tab, session); session total has tab = NULL.
    -- duration_ms is capped client-side (sane upper bound = 30 min/tab,
    -- 2 hr/session) so an open-and-forgotten tab can't skew the average.
    CREATE TABLE IF NOT EXISTS lab_dwell (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ts              TEXT    NOT NULL DEFAULT (datetime('now')),
      ip_hash         TEXT,
      tab             TEXT,        -- NULL = whole-session row
      duration_ms     INTEGER NOT NULL,
      is_bot          INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_lab_dwell_ts  ON lab_dwell(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_lab_dwell_tab ON lab_dwell(tab);
  `);
  // Add v2 columns one-at-a-time, ignoring "duplicate column" errors
  // when they already exist (idempotent migration).
  const newCols = [
    "country TEXT", "country_code TEXT", "city TEXT",
    "device TEXT", "browser TEXT", "os TEXT", "is_bot INTEGER DEFAULT 0",
  ];
  for (const def of newCols) {
    try { db.exec(`ALTER TABLE lab_pageviews ADD COLUMN ${def}`); }
    catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }
}

// ─── User-agent parser ──────────────────────────────────────────────
// Tiny, regex-based. Covers the common cases; unknown UAs fall back to
// "other" rather than throwing. No new dependency added.
function parseUA(ua) {
  if (!ua) return { device: "unknown", browser: "unknown", os: "unknown", isBot: 0 };
  const u = ua.toLowerCase();
  const isBot = /bot|crawler|spider|crawl|slurp|bingpreview|facebookexternalhit|whatsapp|telegrambot|google-inspectiontool/i.test(ua) ? 1 : 0;

  // Device
  let device = "desktop";
  if (/ipad|tablet|playbook|silk/.test(u)) device = "tablet";
  else if (/mobi|iphone|ipod|android.*mobile|opera mini|blackberry/.test(u)) device = "mobile";

  // OS — order matters (ipad before mac, android before linux)
  let os = "other";
  if (/iphone|ipad|ipod/.test(u))      os = "iOS";
  else if (/android/.test(u))          os = "Android";
  else if (/windows nt/.test(u))       os = "Windows";
  else if (/mac os x|macintosh/.test(u)) os = "macOS";
  else if (/linux/.test(u))            os = "Linux";
  else if (/cros/.test(u))             os = "ChromeOS";

  // Browser — order matters (edge/opera before chrome, chrome before safari)
  let browser = "other";
  if (/edg\//.test(u))                       browser = "Edge";
  else if (/opr\/|opera/.test(u))            browser = "Opera";
  else if (/samsungbrowser/.test(u))         browser = "Samsung Internet";
  else if (/chrome\/|crios/.test(u))         browser = "Chrome";
  else if (/firefox|fxios/.test(u))          browser = "Firefox";
  else if (/safari/.test(u))                 browser = "Safari";

  return { device, browser, os, isBot };
}

// ─── Geo lookup (async, cached, best-effort) ─────────────────────────
// Uses ip-api.com — free, no key required, ~45 req/min. We cache the
// result per IP so the API is hit at most once per unique visitor.
// If lookup fails, the row just stays geo-NULL — nothing breaks.
function makeGeoLookup(db) {
  const findCache = db.prepare(`SELECT country, country_code, city FROM lab_geo_cache WHERE ip = ?`);
  const saveCache = db.prepare(`
    INSERT INTO lab_geo_cache (ip, country, country_code, city) VALUES (?, ?, ?, ?)
    ON CONFLICT(ip) DO UPDATE SET country=excluded.country,
      country_code=excluded.country_code, city=excluded.city, fetched_at=datetime('now')
  `);
  const updatePV = db.prepare(`
    UPDATE lab_pageviews SET country = ?, country_code = ?, city = ?
    WHERE id = ? AND country IS NULL
  `);

  // In-flight de-dupe so two concurrent visits from the same IP don't
  // hit the API twice while the first request is still pending.
  const pending = new Map();

  return function geoLookup(rowId, ip) {
    if (!ip) return;
    // Localhost / RFC1918 — never bother to look up
    if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|fe80:)/.test(ip)) return;

    // Cache hit — write geo synchronously and exit
    const cached = findCache.get(ip);
    if (cached) {
      try { updatePV.run(cached.country, cached.country_code, cached.city, rowId); } catch (_) {}
      return;
    }

    if (pending.has(ip)) return;
    pending.set(ip, true);

    // ip-api.com — http:// only on the free tier, so we use Node's
    // built-in http to avoid an https-only fetch issue on some envs.
    const http = require("http");
    const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,city`;
    http.get(url, { headers: { "User-Agent": "huatlottery-lab/1.0" } }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        pending.delete(ip);
        try {
          const j = JSON.parse(data);
          if (j.status !== "success") return;
          const country = j.country || null;
          const code    = j.countryCode || null;
          const city    = j.city || null;
          saveCache.run(ip, country, code, city);
          updatePV.run(country, code, city, rowId);
        } catch (_) { /* swallow — best effort */ }
      });
    }).on("error", () => { pending.delete(ip); });
  };
}

// ─── Tracking middleware (mounted on main app, not lab) ──────────────
// Records one row per GET to "/" — captures ?tab= so we know which tab
// the visitor landed on. Sync insert is fast (~0.1ms WAL); geo lookup
// fires async after the row is created so the visitor never waits.
//
// If a CDN like Cloudflare is in front, prefer the CF-IPCountry header
// for instant geo without an API call.
function makeTrackPageView(db) {
  const geoLookup = makeGeoLookup(db);
  const ins = db.prepare(`
    INSERT INTO lab_pageviews (path, tab, referrer, ua, lang, ip_hash,
                               device, browser, os, is_bot,
                               country_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return function trackPageView(req) {
    try {
      if (req.method !== "GET") return;
      if (req.path !== "/" && !req.path.endsWith(".html")) return;
      const tab = (req.query && req.query.tab) ? String(req.query.tab).slice(0, 24) : null;
      const ref = (req.headers.referer || req.headers.referrer || "").slice(0, 200) || null;
      const ua  = (req.headers["user-agent"] || "").slice(0, 200) || null;
      const lang = (req.headers["accept-language"] || "").slice(0, 40) || null;
      const ip = (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
      const ipHash = ip ? crypto.createHash("sha256").update(ip + SECRET).digest("hex").slice(0, 16) : null;
      const { device, browser, os, isBot } = parseUA(ua);
      // Cheap CDN-provided country (Cloudflare, Render's geo middleware)
      const cfCountry = (req.headers["cf-ipcountry"] || req.headers["x-vercel-ip-country"] || "").slice(0, 2).toUpperCase() || null;
      const info = ins.run(req.path, tab, ref, ua, lang, ipHash,
                           device, browser, os, isBot, cfCountry);
      // Fire async ip-api lookup only if CDN didn't already give us geo
      if (!cfCountry && !isBot) geoLookup(info.lastInsertRowid, ip);
    } catch (_) { /* never break the request because of tracking */ }
  };
}

// ─── Data: compute the dashboard numbers ─────────────────────────────
// Most queries default to "non-bot human visitors only" — bot traffic is
// reported in its own card so it doesn't inflate humans-numbers.
function computeDashboard(db) {
  const q = db.prepare.bind(db);
  const HUMAN = `is_bot = 0`;

  // Total counters
  const total   = q(`SELECT COUNT(*) AS n FROM lab_pageviews WHERE ${HUMAN}`).get().n;
  const today   = q(`SELECT COUNT(*) AS n FROM lab_pageviews WHERE ${HUMAN} AND date(ts,'localtime') = date('now','localtime')`).get().n;
  const last7   = q(`SELECT COUNT(*) AS n FROM lab_pageviews WHERE ${HUMAN} AND ts >= datetime('now','-7 days')`).get().n;
  const last30  = q(`SELECT COUNT(*) AS n FROM lab_pageviews WHERE ${HUMAN} AND ts >= datetime('now','-30 days')`).get().n;
  const uniqAll = q(`SELECT COUNT(DISTINCT ip_hash) AS n FROM lab_pageviews WHERE ${HUMAN} AND ip_hash IS NOT NULL`).get().n;
  const uniq30  = q(`SELECT COUNT(DISTINCT ip_hash) AS n FROM lab_pageviews WHERE ${HUMAN} AND ts >= datetime('now','-30 days') AND ip_hash IS NOT NULL`).get().n;
  const uniq7   = q(`SELECT COUNT(DISTINCT ip_hash) AS n FROM lab_pageviews WHERE ${HUMAN} AND ts >= datetime('now','-7 days') AND ip_hash IS NOT NULL`).get().n;
  const bots    = q(`SELECT COUNT(*) AS n FROM lab_pageviews WHERE is_bot = 1 AND ts >= datetime('now','-30 days')`).get().n;

  // Top tabs (30 days, humans)
  const tabs = q(`
    SELECT COALESCE(tab,'(landing)') AS tab, COUNT(*) AS n
    FROM lab_pageviews
    WHERE ${HUMAN} AND ts >= datetime('now','-30 days')
    GROUP BY tab ORDER BY n DESC LIMIT 10
  `).all();

  // 14-day pageview + unique-visitor history
  const days = q(`
    SELECT date(ts,'localtime') AS day,
           COUNT(*) AS views,
           COUNT(DISTINCT ip_hash) AS uniques
    FROM lab_pageviews
    WHERE ${HUMAN} AND ts >= datetime('now','-14 days')
    GROUP BY day ORDER BY day ASC
  `).all();

  // Country breakdown (30 days, humans)
  const countries = q(`
    SELECT COALESCE(NULLIF(country, ''), country_code, '(unknown)') AS country,
           COUNT(*) AS n,
           COUNT(DISTINCT ip_hash) AS visitors
    FROM lab_pageviews
    WHERE ${HUMAN} AND ts >= datetime('now','-30 days')
    GROUP BY country ORDER BY n DESC LIMIT 15
  `).all();

  // Device, browser, OS breakdown (30 days, humans)
  const devices  = q(`
    SELECT COALESCE(device,'unknown') AS k, COUNT(*) AS n
    FROM lab_pageviews
    WHERE ${HUMAN} AND ts >= datetime('now','-30 days')
    GROUP BY k ORDER BY n DESC
  `).all();
  const browsers = q(`
    SELECT COALESCE(browser,'unknown') AS k, COUNT(*) AS n
    FROM lab_pageviews
    WHERE ${HUMAN} AND ts >= datetime('now','-30 days')
    GROUP BY k ORDER BY n DESC LIMIT 8
  `).all();
  const oses = q(`
    SELECT COALESCE(os,'unknown') AS k, COUNT(*) AS n
    FROM lab_pageviews
    WHERE ${HUMAN} AND ts >= datetime('now','-30 days')
    GROUP BY k ORDER BY n DESC LIMIT 8
  `).all();

  // Top referrers (30 days, humans)
  const referrers = q(`
    SELECT
      CASE WHEN referrer IS NULL OR referrer = '' THEN '(direct)'
           ELSE substr(referrer, 1, 60) END AS ref,
      COUNT(*) AS n
    FROM lab_pageviews
    WHERE ${HUMAN} AND ts >= datetime('now','-30 days')
    GROUP BY ref ORDER BY n DESC LIMIT 10
  `).all();

  // Recent raw rows
  const recent = q(`
    SELECT ts, path, tab, ua, country_code, device, browser, is_bot
    FROM lab_pageviews
    ORDER BY id DESC LIMIT 20
  `).all();

  // ── Dwell time (30 days, humans) ──
  // Whole-session avg = rows with tab IS NULL.
  // Per-tab avg = grouped by tab (tab IS NOT NULL).
  // Median would be ideal but SQLite has no native percentile —
  // sticking with mean for v1; can switch to median if outliers bite.
  const avgSession = q(`
    SELECT AVG(duration_ms) AS avg_ms, COUNT(*) AS samples
    FROM lab_dwell WHERE is_bot = 0 AND tab IS NULL AND ts >= datetime('now','-30 days')
  `).get();
  const tabDwell = q(`
    SELECT tab, AVG(duration_ms) AS avg_ms, COUNT(*) AS samples
    FROM lab_dwell
    WHERE is_bot = 0 AND tab IS NOT NULL AND ts >= datetime('now','-30 days')
    GROUP BY tab ORDER BY samples DESC LIMIT 10
  `).all();

  // ── Returning visitors (30 days, humans) ──
  // A visitor's "days_active" = distinct calendar days they had pageviews.
  // Same-day reloads don't count as a return — would inflate the metric.
  // Buckets are picked to match SG lottery cadence:
  //   4D draws Wed/Sat/Sun (3/week) + TOTO Mon/Thu (2/week) = 5 draw days/week.
  //   So 4-7 days/month = catches 1 draw/week, 8-15 = catches most draws,
  //   16+ = catches every draw day.
  const visitorDays = q(`
    SELECT days_active, COUNT(*) AS n
    FROM (
      SELECT ip_hash, COUNT(DISTINCT date(ts,'localtime')) AS days_active
      FROM lab_pageviews
      WHERE is_bot = 0 AND ts >= datetime('now','-30 days') AND ip_hash IS NOT NULL
      GROUP BY ip_hash
    )
    GROUP BY days_active
  `).all();
  const VISIT_BUCKETS = [
    { label: "One-shot",   hint: "landed once, never returned",       min: 1,  max: 1  },
    { label: "Casual",     hint: "2-3 days · occasional check-in",     min: 2,  max: 3  },
    { label: "Weekly",     hint: "4-7 days · ~1 draw/week",            min: 4,  max: 7  },
    { label: "Frequent",   hint: "8-15 days · most 4D or TOTO+4D",     min: 8,  max: 15 },
    { label: "Power user", hint: "16+ days · catches every draw day",  min: 16, max: 99 },
  ];
  const visitFreq = VISIT_BUCKETS.map(b => ({
    label: b.label, hint: b.hint,
    n: visitorDays.filter(v => v.days_active >= b.min && v.days_active <= b.max)
                  .reduce((s, v) => s + v.n, 0),
  }));
  const returning = visitFreq.slice(1).reduce((s, b) => s + b.n, 0);  // tier 2+ days
  const returnRate = uniq30 ? Math.round(returning / uniq30 * 100) : 0;

  return {
    total, today, last7, last30, uniqAll, uniq30, uniq7, bots,
    tabs, days, countries, devices, browsers, oses, referrers, recent,
    avgSession, tabDwell,
    visitFreq, returning, returnRate,
  };
}

// ─── Views ───────────────────────────────────────────────────────────
const STYLE = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
       background:#0b0f17;color:#e6edf3;padding:24px;line-height:1.5}
  a{color:#79c0ff;text-decoration:none} a:hover{text-decoration:underline}
  .wrap{max-width:1100px;margin:0 auto}
  h1{font-size:18px;font-weight:700;margin-bottom:6px;letter-spacing:.02em}
  h2{font-size:13px;font-weight:700;color:#7d8590;text-transform:uppercase;
     letter-spacing:.08em;margin:28px 0 10px}
  .topbar{display:flex;align-items:center;gap:14px;margin-bottom:18px;
          padding-bottom:14px;border-bottom:1px solid #21262d}
  .logo{width:28px;height:28px;border-radius:6px;background:linear-gradient(135deg,#7c3aed,#a855f7);
        display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;color:#fff}
  .topbar .desc{font-size:11px;color:#7d8590}
  .topbar .right{margin-left:auto;display:flex;gap:14px;font-size:11.5px}
  .stat-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:8px}
  .stat{padding:14px;background:#0d1117;border:1px solid #21262d;border-radius:8px}
  .stat .lab{font-size:10.5px;color:#7d8590;text-transform:uppercase;letter-spacing:.06em;font-weight:700}
  .stat .val{font-size:28px;font-weight:800;color:#fff;margin-top:6px;line-height:1}
  .stat .sub{font-size:11px;color:#7d8590;margin-top:4px}
  .card{padding:14px 16px;background:#0d1117;border:1px solid #21262d;border-radius:8px;margin-bottom:14px}
  .bars{display:flex;align-items:flex-end;gap:6px;height:130px;padding-top:12px}
  .bars .b{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0;justify-content:flex-end}
  .bars .b .fill{width:100%;background:linear-gradient(180deg,#7c3aed,#a855f7);border-radius:3px 3px 0 0;min-height:1px}
  .bars .b .n{font-size:10px;color:#fff;font-weight:700}
  .bars .b .u{font-size:9px;color:#a855f7;font-weight:700;margin-top:2px}
  .bars .b .d{font-size:9px;color:#7d8590}
  .hbar{height:6px;background:#161b22;border-radius:3px;overflow:hidden}
  .hbar-fill{height:100%;background:linear-gradient(90deg,#7c3aed,#a855f7);border-radius:3px}
  .grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:14px;margin-bottom:14px}
  .grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-bottom:14px}
  .grid2 h2,.grid3 h2{margin-top:0}
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  th,td{padding:7px 10px;text-align:left;border-bottom:1px solid #21262d}
  th{color:#7d8590;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;font-weight:700}
  td.r,th.r{text-align:right;font-variant-numeric:tabular-nums}
  .pill{display:inline-block;padding:1px 6px;background:#1f2937;border-radius:3px;font-size:10.5px;color:#9ca3af}
  .empty{color:#7d8590;font-style:italic;padding:18px;text-align:center;font-size:13px}
  .login{max-width:380px;margin:140px auto 0;padding:28px;background:#0d1117;
         border:1px solid #21262d;border-radius:12px}
  .login h1{margin-bottom:6px}
  .login .desc{font-size:12px;color:#7d8590;margin-bottom:22px}
  .login input{display:block;width:100%;padding:10px 12px;background:#010409;
               border:1px solid #21262d;color:#e6edf3;border-radius:6px;
               font-family:inherit;font-size:14px;margin-bottom:12px}
  .login input:focus{outline:none;border-color:#7c3aed}
  .login button{width:100%;padding:10px;background:#7c3aed;color:#fff;border:none;
                border-radius:6px;font-weight:700;cursor:pointer;font-family:inherit;font-size:13px}
  .login button:hover{background:#6b21a8}
  .err{color:#f87171;font-size:12px;margin-bottom:10px;text-align:center}
`;

function layout(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>${title}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<style>${STYLE}</style></head><body>${body}</body></html>`;
}

function loginPage(err, labQ) {
  return layout("Lab · sign in", `
    <div class="login">
      <h1>Huatlottery Lab</h1>
      <div class="desc">Private research playground. Enter password to continue.</div>
      ${err ? `<div class="err">${err}</div>` : ""}
      <form method="POST" action="/login${labQ || ""}">
        <input type="password" name="password" placeholder="password" autofocus autocomplete="current-password">
        <button type="submit">Sign in</button>
      </form>
    </div>
  `);
}

// ─── Helpers used by dashboardPage ───────────────────────────────────
function flagEmoji(code) {
  if (!code || code.length !== 2) return "";
  const cc = code.toUpperCase();
  return String.fromCodePoint(...[...cc].map(c => 0x1F1E6 + (c.charCodeAt(0) - 65)));
}
function pct(n, total) { return total ? Math.round(n / total * 1000) / 10 : 0; }

// Render a duration in a human-friendly way: "23s", "1m 47s", "12m 03s"
function fmtDuration(ms) {
  if (!ms || ms < 1000) return ms ? Math.round(ms) + "ms" : "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return m + "m " + String(r).padStart(2, "0") + "s";
  const h = Math.floor(m / 60);
  return h + "h " + String(m % 60).padStart(2, "0") + "m";
}
function barRow(label, n, total) {
  const p = pct(n, total);
  return `<tr>
    <td>${escapeHtml(label)}</td>
    <td style="width:50%"><div class="hbar"><div class="hbar-fill" style="width:${p}%"></div></div></td>
    <td class="r" style="font-weight:700">${n}</td>
    <td class="r" style="color:#7d8590;font-size:11px">${p}%</td>
  </tr>`;
}

function dashboardPage(d, labQ) {
  labQ = labQ || "";
  // ─ 14-day bar chart (views + uniques) ─
  const maxDay = d.days.reduce((m, x) => Math.max(m, x.views), 1);
  const days14 = [];
  for (let i = 13; i >= 0; i--) {
    const dt = new Date(); dt.setDate(dt.getDate() - i);
    const iso = dt.toISOString().slice(0, 10);
    const hit = d.days.find(x => x.day === iso);
    days14.push({ day: iso, views: hit ? hit.views : 0, uniques: hit ? hit.uniques : 0 });
  }
  const bars = days14.map(x => {
    const h = Math.max(1, Math.round(x.views / maxDay * 100));
    const lbl = x.day.slice(5).replace("-", "/");
    return `<div class="b" title="${x.day} — ${x.views} views · ${x.uniques} unique">
      <div class="n">${x.views || ""}</div>
      <div class="fill" style="height:${h}%"></div>
      <div class="u">${x.uniques || ""}</div>
      <div class="d">${lbl}</div>
    </div>`;
  }).join("");

  // ─ Totals for proportional bars ─
  const devTotal = d.devices.reduce((s, x) => s + x.n, 0);
  const brTotal  = d.browsers.reduce((s, x) => s + x.n, 0);
  const osTotal  = d.oses.reduce((s, x) => s + x.n, 0);
  const cTotal   = d.countries.reduce((s, x) => s + x.n, 0);
  const refTotal = d.referrers.reduce((s, x) => s + x.n, 0);

  // ─ Tables ─
  // Merge tab pageview counts with avg-dwell so a single table shows both
  const dwellByTab = Object.fromEntries(d.tabDwell.map(x => [x.tab, x]));
  const tabsRows = d.tabs.map(t => {
    const dw = dwellByTab[t.tab];
    const avg = dw ? fmtDuration(dw.avg_ms) : '—';
    const samples = dw ? dw.samples : 0;
    return `<tr>
      <td>${escapeHtml(t.tab)}</td>
      <td class="r">${t.n}</td>
      <td class="r" style="color:#a855f7;font-weight:700">${avg}</td>
      <td class="r" style="color:#7d8590;font-size:11px">${samples}</td>
    </tr>`;
  }).join("");

  const countriesRows = d.countries.map(c => {
    const label = (flagEmoji(c.country) === "" ? "" : flagEmoji(c.country) + " ") + (c.country || "(unknown)");
    return `<tr>
      <td>${escapeHtml(label)}</td>
      <td style="width:45%"><div class="hbar"><div class="hbar-fill" style="width:${pct(c.n, cTotal)}%"></div></div></td>
      <td class="r" style="font-weight:700">${c.n}</td>
      <td class="r" style="color:#7d8590">${c.visitors} <span style="font-size:10.5px">uniq</span></td>
    </tr>`;
  }).join("");

  const devRows = d.devices.map(x  => barRow(x.k, x.n, devTotal)).join("");
  const brRows  = d.browsers.map(x => barRow(x.k, x.n, brTotal)).join("");
  const osRows  = d.oses.map(x     => barRow(x.k, x.n, osTotal)).join("");
  const refRows = d.referrers.map(r => barRow(r.ref, r.n, refTotal)).join("");

  const recentRows = d.recent.map(r => {
    const flag = flagEmoji(r.country_code);
    const botBadge = r.is_bot ? '<span class="pill" style="background:#7c2d12;color:#fed7aa">bot</span>' : '';
    return `<tr>
      <td><span class="pill">${r.ts.slice(5, 16).replace("T", " ")}</span></td>
      <td>${flag} ${escapeHtml(r.country_code || "")}</td>
      <td>${escapeHtml(r.tab || "(landing)")}</td>
      <td>${escapeHtml(r.device || "—")}</td>
      <td>${escapeHtml(r.browser || "—")}</td>
      <td>${botBadge}</td>
    </tr>`;
  }).join("");

  return layout("Lab · dashboard", `
    <div class="wrap">
      <div class="topbar">
        <div class="logo">L</div>
        <div>
          <h1>Huatlottery Lab</h1>
          <div class="desc">Self-hosted analytics · humans only (bots tracked separately)</div>
        </div>
        <div class="right">
          <a href="/${labQ}">dashboard</a>
          <a href="/logout${labQ}">sign out</a>
        </div>
      </div>

      <div class="stat-row">
        <div class="stat"><div class="lab">Today</div><div class="val">${d.today}</div><div class="sub">page views</div></div>
        <div class="stat"><div class="lab">Last 7 days</div><div class="val">${d.last7}</div><div class="sub">${d.uniq7} unique</div></div>
        <div class="stat"><div class="lab">Last 30 days</div><div class="val">${d.last30}</div><div class="sub">${d.uniq30} unique</div></div>
        <div class="stat"><div class="lab">All-time</div><div class="val">${d.total}</div><div class="sub">${d.uniqAll} unique visitors</div></div>
        <div class="stat"><div class="lab">Avg session</div><div class="val">${fmtDuration(d.avgSession.avg_ms)}</div><div class="sub">over ${d.avgSession.samples} sessions (30d)</div></div>
        <div class="stat"><div class="lab">Returning</div><div class="val">${d.returning}</div><div class="sub">${d.returnRate}% of 30-day uniques came back</div></div>
        <div class="stat" style="opacity:.7"><div class="lab">Bots (30d)</div><div class="val">${d.bots}</div><div class="sub">excluded from above</div></div>
      </div>

      <h2>Last 14 days · views (bar) + uniques (top number)</h2>
      <div class="card">
        ${d.total ? `<div class="bars">${bars}</div>` : `<div class="empty">No data yet. Open huatlottery.com in another tab to generate the first view.</div>`}
      </div>

      <h2>Visit frequency (30 days) · is this a quality site or a one-shot?</h2>
      <div class="card" style="padding:0">
        <table>
          <thead><tr>
            <th>Tier</th><th></th><th class="r">Visitors</th><th class="r">Share</th>
          </tr></thead>
          <tbody>
            ${(() => {
              const freqTotal = d.visitFreq.reduce((s, b) => s + b.n, 0);
              return d.visitFreq.map((b, i) => `<tr>
                <td>
                  <div style="font-weight:700;color:${i === 0 ? '#7d8590' : i >= 3 ? '#a855f7' : '#e6edf3'}">${escapeHtml(b.label)}</div>
                  <div style="font-size:10.5px;color:#7d8590;margin-top:2px">${escapeHtml(b.hint)}</div>
                </td>
                <td style="width:45%"><div class="hbar"><div class="hbar-fill" style="width:${pct(b.n, freqTotal)}%;${i === 0 ? 'background:linear-gradient(90deg,#475569,#64748b)' : ''}"></div></div></td>
                <td class="r" style="font-weight:700">${b.n}</td>
                <td class="r" style="color:#7d8590">${pct(b.n, freqTotal)}%</td>
              </tr>`).join("");
            })()}
          </tbody>
        </table>
      </div>

      <div class="grid2">
        <div>
          <h2>Country (30 days)</h2>
          <div class="card" style="padding:0">
            ${countriesRows ? `<table>
              <thead><tr><th>Country</th><th></th><th class="r">Views</th><th class="r">Visitors</th></tr></thead>
              <tbody>${countriesRows}</tbody>
            </table>` : `<div class="empty">No geo data yet. ip-api.com fills this as visitors arrive.</div>`}
          </div>
        </div>
        <div>
          <h2>Top tabs (30 days)</h2>
          <div class="card" style="padding:0">
            ${tabsRows ? `<table>
              <thead><tr>
                <th>Tab</th>
                <th class="r">Views</th>
                <th class="r">Avg time</th>
                <th class="r" style="color:#7d8590">n</th>
              </tr></thead>
              <tbody>${tabsRows}</tbody>
            </table>` : `<div class="empty">No tab data yet.</div>`}
          </div>
        </div>
      </div>

      <div class="grid3">
        <div>
          <h2>Device</h2>
          <div class="card" style="padding:0">
            ${devRows ? `<table><tbody>${devRows}</tbody></table>` : `<div class="empty">—</div>`}
          </div>
        </div>
        <div>
          <h2>Browser</h2>
          <div class="card" style="padding:0">
            ${brRows ? `<table><tbody>${brRows}</tbody></table>` : `<div class="empty">—</div>`}
          </div>
        </div>
        <div>
          <h2>Operating system</h2>
          <div class="card" style="padding:0">
            ${osRows ? `<table><tbody>${osRows}</tbody></table>` : `<div class="empty">—</div>`}
          </div>
        </div>
      </div>

      <h2>Top referrers (30 days)</h2>
      <div class="card" style="padding:0">
        ${refRows ? `<table><tbody>${refRows}</tbody></table>` : `<div class="empty">No referrer data yet.</div>`}
      </div>

      <h2>Last 20 views</h2>
      <div class="card" style="padding:0;overflow-x:auto">
        ${recentRows ? `<table>
          <thead><tr><th>Time</th><th>Geo</th><th>Tab</th><th>Device</th><th>Browser</th><th></th></tr></thead>
          <tbody>${recentRows}</tbody>
        </table>` : `<div class="empty">No views recorded yet.</div>`}
      </div>
    </div>
  `);
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ─── Router factory ──────────────────────────────────────────────────
function createLabRouter(db) {
  initLabSchema(db);
  const router = express.Router();

  // Parse url-encoded body (login form) — local to lab to avoid affecting main app
  router.use(express.urlencoded({ extended: false }));

  // Tell every search engine to ignore everything on this subdomain.
  // Sent as an HTTP header on every response — works for non-HTML responses
  // too (redirects, JSON, etc.) where the <meta> tag can't reach.
  router.use((req, res, next) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    next();
  });

  // Subdomain-specific robots.txt that blocks all crawlers. Must be served
  // BEFORE the auth gate or crawlers see a login-redirect instead of the
  // Disallow directive (and might keep trying).
  router.get("/robots.txt", (req, res) => {
    res.type("text/plain").send("User-agent: *\nDisallow: /\n");
  });

  // Preserve the local-testing flag across redirects. On prod, hostname
  // is `lab.huatlottery.com` so this returns ""; on localhost where we
  // route via `?_lab=1`, we have to carry it forward or the next request
  // hits the main app and 404s on /login.
  function labQuery(req) {
    return req.query._lab === "1" ? "?_lab=1" : "";
  }

  // Auth gate — everything except /login requires a valid cookie
  router.use((req, res, next) => {
    if (req.path === "/login") return next();
    const token = getCookie(req, COOKIE);
    if (verifyToken(token)) return next();
    return res.redirect("/login" + labQuery(req));
  });

  // ── Auth pages ──
  router.get("/login", (req, res) => {
    res.type("html").send(loginPage("", labQuery(req)));
  });

  router.post("/login", (req, res) => {
    const submitted = req.body && req.body.password;
    if (submitted && submitted === PASSWORD) {
      const expires = Date.now() + COOKIE_TTL_DAYS * 86400 * 1000;
      const token = makeToken(expires);
      const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";
      const parts = [
        `${COOKIE}=${token}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        `Max-Age=${COOKIE_TTL_DAYS * 86400}`,
      ];
      if (isSecure) parts.push("Secure");
      res.setHeader("Set-Cookie", parts.join("; "));
      return res.redirect("/" + labQuery(req));
    }
    res.type("html").send(loginPage("Incorrect password", labQuery(req)));
  });

  router.get("/logout", (req, res) => {
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
    res.redirect("/login" + labQuery(req));
  });

  // ── Dashboard ──
  router.get("/", (req, res) => {
    const data = computeDashboard(db);
    res.type("html").send(dashboardPage(data, labQuery(req)));
  });

  return router;
}

// ─── Dwell-beacon endpoint ───────────────────────────────────────────
// Mounted on the MAIN app (not the lab router) because the beacon is
// fired from huatlottery.com, not from lab.huatlottery.com.
//
// Body shape: { sessionMs: int, tabs: { [tabName]: ms, ... } }
// Inserts one row per tab plus one whole-session row (tab = NULL).
function createDwellRouter(db) {
  const router = express.Router();
  router.use(express.json({ limit: "8kb" }));

  const insTab = db.prepare(`
    INSERT INTO lab_dwell (ip_hash, tab, duration_ms, is_bot) VALUES (?, ?, ?, ?)
  `);

  router.post("/api/lab/dwell", (req, res) => {
    try {
      const b = req.body || {};
      const sessionMs = Number(b.sessionMs) || 0;
      const tabs = (b.tabs && typeof b.tabs === "object") ? b.tabs : {};

      // Reject obviously bad input — keeps the table clean
      if (sessionMs < 100 || sessionMs > 7200_000) return res.status(204).end();

      // Derive IP hash + bot flag the same way we did at page-view time
      const ip = (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
      const ipHash = ip ? crypto.createHash("sha256").update(ip + SECRET).digest("hex").slice(0, 16) : null;
      const { isBot } = parseUA(req.headers["user-agent"] || "");
      if (isBot) return res.status(204).end();

      // One row per tab
      for (const [tab, raw] of Object.entries(tabs)) {
        const ms = Number(raw);
        if (!isFinite(ms) || ms < 200 || ms > 1800_000) continue;
        insTab.run(ipHash, String(tab).slice(0, 24), Math.round(ms), 0);
      }
      // One whole-session row (tab = NULL)
      insTab.run(ipHash, null, Math.round(sessionMs), 0);
      res.status(204).end();
    } catch (_) { res.status(204).end(); }
  });

  return router;
}

module.exports = { createLabRouter, makeTrackPageView, createDwellRouter, initLabSchema };
