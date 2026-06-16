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
  `);
}

// ─── Tracking middleware (mounted on main app, not lab) ──────────────
// Records one row per GET to "/" — captures ?tab= so we know which tab
// the visitor landed on. Synchronous insert is fast (~0.1ms with WAL)
// and keeps the data write predictable.
function makeTrackPageView(db) {
  const ins = db.prepare(`
    INSERT INTO lab_pageviews (path, tab, referrer, ua, lang, ip_hash)
    VALUES (?, ?, ?, ?, ?, ?)
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
      ins.run(req.path, tab, ref, ua, lang, ipHash);
    } catch (_) { /* never break the request because of tracking */ }
  };
}

// ─── Data: compute the dashboard numbers ─────────────────────────────
function computeDashboard(db) {
  const q = db.prepare.bind(db);
  // Total counters
  const total = q(`SELECT COUNT(*) AS n FROM lab_pageviews`).get().n;
  const today = q(`SELECT COUNT(*) AS n FROM lab_pageviews WHERE date(ts) = date('now','localtime')`).get().n;
  const last7 = q(`SELECT COUNT(*) AS n FROM lab_pageviews WHERE ts >= datetime('now','-7 days')`).get().n;
  const last30 = q(`SELECT COUNT(*) AS n FROM lab_pageviews WHERE ts >= datetime('now','-30 days')`).get().n;
  const uniqIps = q(`SELECT COUNT(DISTINCT ip_hash) AS n FROM lab_pageviews WHERE ts >= datetime('now','-30 days') AND ip_hash IS NOT NULL`).get().n;
  // Top tabs (last 30 days)
  const tabs = q(`
    SELECT COALESCE(tab,'(none)') AS tab, COUNT(*) AS n
    FROM lab_pageviews
    WHERE ts >= datetime('now','-30 days')
    GROUP BY tab ORDER BY n DESC LIMIT 10
  `).all();
  // Last 14 days as histogram
  const days = q(`
    SELECT date(ts,'localtime') AS day, COUNT(*) AS n
    FROM lab_pageviews
    WHERE ts >= datetime('now','-14 days')
    GROUP BY day ORDER BY day ASC
  `).all();
  // Recent UA samples
  const recent = q(`
    SELECT ts, path, tab, ua
    FROM lab_pageviews
    ORDER BY id DESC LIMIT 20
  `).all();
  return { total, today, last7, last30, uniqIps, tabs, days, recent };
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
  .bars{display:flex;align-items:flex-end;gap:6px;height:120px;padding-top:12px}
  .bars .b{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0}
  .bars .b .fill{width:100%;background:linear-gradient(180deg,#7c3aed,#a855f7);border-radius:3px 3px 0 0;min-height:1px}
  .bars .b .n{font-size:10px;color:#7d8590;font-weight:700}
  .bars .b .d{font-size:9px;color:#7d8590}
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

function loginPage(err) {
  return layout("Lab · sign in", `
    <div class="login">
      <h1>Huatlottery Lab</h1>
      <div class="desc">Private research playground. Enter password to continue.</div>
      ${err ? `<div class="err">${err}</div>` : ""}
      <form method="POST" action="/login">
        <input type="password" name="password" placeholder="password" autofocus autocomplete="current-password">
        <button type="submit">Sign in</button>
      </form>
    </div>
  `);
}

function dashboardPage(d) {
  const maxDay = d.days.reduce((m, x) => Math.max(m, x.n), 1);
  const days14 = [];
  // Fill in zeros for days with no traffic, so the bar chart shows the full window
  for (let i = 13; i >= 0; i--) {
    const dt = new Date();
    dt.setDate(dt.getDate() - i);
    const iso = dt.toISOString().slice(0, 10);
    const hit = d.days.find(x => x.day === iso);
    days14.push({ day: iso, n: hit ? hit.n : 0 });
  }
  const bars = days14.map(x => {
    const h = Math.max(1, Math.round(x.n / maxDay * 100));
    const lbl = x.day.slice(5).replace("-", "/");
    return `<div class="b" title="${x.day} — ${x.n} views">
      <div class="n">${x.n || ""}</div>
      <div class="fill" style="height:${h}%"></div>
      <div class="d">${lbl}</div>
    </div>`;
  }).join("");

  const tabsRows = d.tabs.length ? d.tabs.map(t => `
    <tr><td>${escapeHtml(t.tab)}</td><td class="r">${t.n}</td></tr>
  `).join("") : "";

  const recentRows = d.recent.length ? d.recent.map(r => `
    <tr>
      <td><span class="pill">${r.ts.slice(5, 16).replace("T", " ")}</span></td>
      <td>${escapeHtml(r.tab || "—")}</td>
      <td style="color:#7d8590;font-size:11px">${escapeHtml((r.ua || "").slice(0, 70))}</td>
    </tr>
  `).join("") : "";

  return layout("Lab · dashboard", `
    <div class="wrap">
      <div class="topbar">
        <div class="logo">L</div>
        <div>
          <h1>Huatlottery Lab</h1>
          <div class="desc">Page views · self-hosted, no Google dependency</div>
        </div>
        <div class="right">
          <a href="/">dashboard</a>
          <a href="/logout">sign out</a>
        </div>
      </div>

      <div class="stat-row">
        <div class="stat"><div class="lab">Today</div><div class="val">${d.today}</div><div class="sub">page views</div></div>
        <div class="stat"><div class="lab">Last 7 days</div><div class="val">${d.last7}</div><div class="sub">page views</div></div>
        <div class="stat"><div class="lab">Last 30 days</div><div class="val">${d.last30}</div><div class="sub">page views</div></div>
        <div class="stat"><div class="lab">Unique visitors</div><div class="val">${d.uniqIps}</div><div class="sub">~30 days (by hashed IP)</div></div>
        <div class="stat"><div class="lab">All-time</div><div class="val">${d.total}</div><div class="sub">since tracking began</div></div>
      </div>

      <h2>Last 14 days</h2>
      <div class="card">
        ${d.total ? `<div class="bars">${bars}</div>` : `<div class="empty">No data yet. Open huatlottery.com in another tab to generate the first view.</div>`}
      </div>

      <h2>Top tabs (30 days)</h2>
      <div class="card" style="padding:0">
        ${tabsRows ? `<table>
          <thead><tr><th>Tab</th><th class="r">Views</th></tr></thead>
          <tbody>${tabsRows}</tbody>
        </table>` : `<div class="empty">No tab data yet.</div>`}
      </div>

      <h2>Last 20 views</h2>
      <div class="card" style="padding:0">
        ${recentRows ? `<table>
          <thead><tr><th>Time (UTC)</th><th>Tab</th><th>User agent</th></tr></thead>
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

  // Auth gate — everything except /login requires a valid cookie
  router.use((req, res, next) => {
    if (req.path === "/login") return next();
    const token = getCookie(req, COOKIE);
    if (verifyToken(token)) return next();
    return res.redirect("/login");
  });

  // ── Auth pages ──
  router.get("/login", (req, res) => {
    res.type("html").send(loginPage(""));
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
      return res.redirect("/");
    }
    res.type("html").send(loginPage("Incorrect password"));
  });

  router.get("/logout", (req, res) => {
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
    res.redirect("/login");
  });

  // ── Dashboard ──
  router.get("/", (req, res) => {
    const data = computeDashboard(db);
    res.type("html").send(dashboardPage(data));
  });

  return router;
}

module.exports = { createLabRouter, makeTrackPageView, initLabSchema };
