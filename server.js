const express = require("express");
const cors = require("cors");
const path = require("path");
const { getDb, initSchema } = require("./db");
const { getLuckyNumbers } = require("./lib/lucky");
const autoScrape = require("./lib/auto-scrape");
const cache = require("./lib/cache");
const compression = require("compression");
const { parseTotoProducts, parseOtherGames } = require("./scraper/my/parse-other.js");
const { pickLang, dict } = require("./i18n");
const { Lunar, Solar } = require("lunar-javascript");
const { createLabRouter, makeTrackPageView, createDwellRouter } = require("./routes/lab");

// Convert a lunar (year, month, day) to a solar YYYY-MM-DD string.
function solarFromLunar(year, month, day) {
  try {
    const solar = Lunar.fromYmd(year, month, day).getSolar();
    return `${solar.getYear()}-${String(solar.getMonth()).padStart(2,'0')}-${String(solar.getDay()).padStart(2,'0')}`;
  } catch (e) { return null; }
}

// SG festivals — lunar-based ones computed dynamically, fixed ones returned as-is.
const FESTIVALS = {
  cny:         { name: "Chinese New Year",      solar_dates: y => [solarFromLunar(y, 1, 1)] },
  mid_autumn:  { name: "Mid-Autumn Festival",   solar_dates: y => [solarFromLunar(y, 8, 15)] },
  duanwu:      { name: "Dragon Boat (Duanwu)",  solar_dates: y => [solarFromLunar(y, 5, 5)] },
  qingming:    { name: "Qingming",              solar_dates: y => [`${y}-04-05`] },
  national:    { name: "National Day",          solar_dates: y => [`${y}-08-09`] },
  christmas:   { name: "Christmas",             solar_dates: y => [`${y}-12-25`] },
  new_year:    { name: "New Year's Day",        solar_dates: y => [`${y}-01-01`] },
  hari_raya:   { name: "Hari Raya Puasa (approx)", solar_dates: y => [solarFromLunar(y, 9, 1)] /* close to start of Shawwal */ },
};

// Singapore 4D folk dream-number dictionary (folk-belief, not statistical)
const DREAM_TO_NUMBERS = {
  fish:    { numbers: ["1228", "2891", "0438"], note: "Common SG 4D folk interpretation" },
  snake:   { numbers: ["0123", "7799", "8266"], note: "Snake dreams in folk lore" },
  tiger:   { numbers: ["0517", "0388", "8888"], note: "Tiger = strength" },
  dragon:  { numbers: ["8888", "0518", "1818"], note: "Dragon = imperial luck" },
  dog:     { numbers: ["1234", "0007", "8866"], note: "Dog = loyalty" },
  cat:     { numbers: ["0728", "8881", "0009"], note: "Cat dreams" },
  pig:     { numbers: ["1668", "2266", "9988"], note: "Pig = fortune" },
  bird:    { numbers: ["2828", "0007", "5566"], note: "Bird = freedom" },
  money:   { numbers: ["8888", "1688", "6868"], note: "Money dreams" },
  gold:    { numbers: ["8888", "0888", "1888"], note: "Gold = prosperity" },
  death:   { numbers: ["4444", "4040", "0440"], note: "Death = warning (4 = inauspicious in Chinese)" },
  blood:   { numbers: ["4499", "0044", "0099"], note: "Blood dreams" },
  ghost:   { numbers: ["0440", "4040", "0444"], note: "Ghost dreams" },
  wedding: { numbers: ["8888", "9999", "1234"], note: "Wedding = harmony" },
  baby:    { numbers: ["0606", "8181", "0099"], note: "Baby = new beginning" },
  fire:    { numbers: ["0707", "7707", "0077"], note: "Fire dreams" },
  water:   { numbers: ["1212", "0303", "8989"], note: "Water = wealth flow" },
  rain:    { numbers: ["1188", "0188", "8001"], note: "Rain = cleansing" },
  flying:  { numbers: ["1818", "1881", "0009"], note: "Flying = aspiration" },
  falling: { numbers: ["0440", "4040", "1313"], note: "Falling dreams" },
  car:     { numbers: ["1248", "8421", "0033"], note: "Vehicle dreams" },
  house:   { numbers: ["0288", "8820", "1212"], note: "Home dreams" },
  shoes:   { numbers: ["7711", "1177", "0077"], note: "Shoes = path / journey" },
  child:   { numbers: ["0709", "9070", "1707"], note: "Child dreams" },
};

const app = express();
const PORT = process.env.PORT || 3001;
app.disable("x-powered-by");                       // don't advertise the stack
// Security headers (no CSP — the SPA uses inline scripts + GA/AdSense)
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  next();
});
// Lightweight per-IP rate limit on the API (generous; localhost/warmup exempt)
const _rl = new Map();
app.use("/api", (req, res, next) => {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return next();
  const now = Date.now();
  let e = _rl.get(ip);
  if (!e || now - e.ts > 60000) { e = { ts: now, count: 0 }; _rl.set(ip, e); }
  e.count++;
  if (e.count > 300) return res.status(429).json({ success: false, error: "Too many requests — please slow down." });
  next();
});
setInterval(() => { const now = Date.now(); for (const [ip, e] of _rl) if (now - e.ts > 120000) _rl.delete(ip); }, 120000).unref();
app.use(cors());
app.use(express.json());

// ── Self-healing scraper ── catch up on web traffic, independent of GitHub's
// (flaky) scheduled cron. Throttled to ≤1 run / 5 min, fire-and-forget, and
// catchUp() can never throw — so it never blocks or affects a response.
// ON by default (pure code, no config). Set DISABLE_SELFHEAL=1 to switch off.
// Optional: POLLER_SELF_PUSH=1 + GH_TOKEN to also persist captures to git.
if (process.env.DISABLE_SELFHEAL !== "1") {
  const { catchUp } = require("./scraper/auto");
  app.use((req, _res, next) => { catchUp().catch(() => {}); next(); });
  console.log("[selfheal] active — traffic-driven catch-up (no setup needed)");
}

// Serve ALL static files from this directory (including index.html)
// ─── SEO: robots.txt + sitemap.xml (declare these BEFORE static so they
// take precedence over any same-named file in the directory) ───────────
// In production, use the canonical public domain. Override via SITE_URL env.
const SITE_URL = process.env.SITE_URL || "https://huatlottery.com";

app.get("/robots.txt", (req, res) => {
  // Lab subdomain — block all crawlers. Same hostname check used by the
  // lab router below; this just needs to fire earlier so the public
  // robots.txt below never reaches lab.* requests.
  const host = (req.hostname || "").toLowerCase();
  const isLab = host.startsWith("lab.") || req.query._lab === "1";
  if (isLab) {
    return res.type("text/plain").send("User-agent: *\nDisallow: /\n");
  }
  res.type("text/plain").send(
`User-agent: *
Allow: /
Disallow: /api/

Sitemap: ${SITE_URL}/sitemap.xml
`);
});

app.get("/sitemap.xml", (req, res) => {
  // Each of these clean URLs is server-rendered with its OWN canonical + real
  // result content (see SEO_PAGES below), so they're genuinely distinct pages —
  // safe to list (no duplicate-canonical problem the old single-URL map avoided).
  const cleanUrl = SITE_URL.replace(/^https?:?\/\/?/, "").replace(/\/$/, "");
  const base = `https://${cleanUrl}`;
  const today = new Date().toISOString().slice(0, 10);
  const pages = [
    ["/", "1.0"], ["/singapore-4d-results", "0.9"], ["/singapore-toto-results", "0.9"],
    ["/malaysia-4d-results", "0.9"], ["/magnum-4d-result", "0.9"],
    ["/sports-toto-4d-result", "0.9"], ["/da-ma-cai-result", "0.9"],
  ];
  const urls = pages.map(([loc, pri]) =>
    `<url><loc>${base}${loc}</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>${pri}</priority></url>`
  ).join("\n");
  res.type("application/xml").send(
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`);
});

// gzip/brotli compression — cuts 316KB HTML to ~35KB, huge speed win
app.use(compression({ level: 6, threshold: 1024 }));

// Aggressive caching for HTML and static assets — browsers re-use without
// re-fetching for 5 min (HTML) / 1 day (assets), drops repeat-visit load
// to near-zero network time.
app.use((req, res, next) => {
  if (req.path === "/" || req.path.endsWith(".html")) {
    res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
  } else if (req.path.match(/\.(css|js|png|jpg|svg|woff2?|ico)$/)) {
    res.setHeader("Cache-Control", "public, max-age=86400");
  }
  next();
});

// ─── Lab subdomain routing (lab.huatlottery.com) ───────────────────────
// Hostname check happens before the static handler so lab.* never serves
// the public index.html. For local testing, `?_lab=1` flips a request
// into lab mode without needing a hosts-file entry.
const db = getDb();
initSchema(db);
const labRouter     = createLabRouter(db);
const dwellRouter   = createDwellRouter(db);
const trackPageView = makeTrackPageView(db);

app.use((req, _res, next) => {
  const host = (req.hostname || "").toLowerCase();
  req._isLab = host.startsWith("lab.") || req.query._lab === "1";
  next();
});

// Page-view tracking — only counts hits to the PUBLIC site, never lab itself
app.use((req, _res, next) => {
  if (!req._isLab) trackPageView(req);
  next();
});

// Dwell beacon endpoint — mounted on the main app because beacons come
// from huatlottery.com (not lab). It writes to the same lab_dwell table
// that the lab dashboard reads from.
app.use(dwellRouter);

// All lab.* requests are handled by the lab router; everything else falls
// through to the main app below.
app.use((req, res, next) => req._isLab ? labRouter(req, res, next) : next());

// ══ SEO: server-render distinct, crawlable pages per keyword target ══════════
// Each route gets its own <title>/description/canonical + real result content in the
// HTML (not just JS), so Google indexes them as separate pages instead of one SPA.
const _fs = require("fs");
let _seoHtml = null;
const seoBase = () => (_seoHtml = _seoHtml || _fs.readFileSync(path.join(__dirname, "index.html"), "utf8"));
const _esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const _DOW = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const _MON = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function seoDate(iso){ if(!iso) return ""; const p=iso.split("-").map(Number); const dt=new Date(Date.UTC(p[0],p[1]-1,p[2])); return _DOW[dt.getUTCDay()]+", "+p[2]+" "+_MON[p[1]-1]+" "+p[0]; }
function seoGrid(label, arr){ if(!arr||!arr.length) return ""; return "<h3>"+label+"</h3><p>"+arr.map(_esc).join(", ")+"</p>"; }
function sg4dBlock(){ const r=db.prepare("SELECT * FROM fourd_draws ORDER BY draw_no DESC LIMIT 1").get(); if(!r) return ""; const p=parseFourdRow(r);
  return "<h1>Singapore 4D Results Today</h1><p>Latest Singapore Pools 4D result — Draw #"+p.draw_no+", "+seoDate(p.draw_date)+".</p><h2>Winning Numbers</h2><p>1st Prize <b>"+p.first_prize+"</b>, 2nd Prize <b>"+p.second_prize+"</b>, 3rd Prize <b>"+p.third_prize+"</b>.</p>"+seoGrid("Starter Prizes",p.starter_prizes)+seoGrid("Consolation Prizes",p.consolation_prizes); }
function totoBlock(){ const r=db.prepare("SELECT * FROM toto_draws ORDER BY draw_no DESC LIMIT 1").get(); if(!r) return ""; const t=formatTotoRow(r);
  return "<h1>Singapore TOTO Results Today</h1><p>Latest Singapore Pools TOTO result — Draw #"+t.draw_no+", "+seoDate(t.draw_date)+".</p><h2>Winning Numbers</h2><p>"+(t.numbers||[]).join(", ")+" — Additional Number "+t.additional_num+".</p>"; }
function myBlock(op, name){ const r=db.prepare("SELECT * FROM my_draws WHERE operator=? ORDER BY draw_date DESC LIMIT 1").get(op); if(!r) return ""; const p=parseMyRow(r);
  return "<h1>"+name+" 4D Result Today</h1><p>Latest "+name+" 4D result — "+seoDate(p.draw_date)+".</p><h2>Winning Numbers</h2><p>1st Prize <b>"+p.first_prize+"</b>, 2nd Prize <b>"+p.second_prize+"</b>, 3rd Prize <b>"+p.third_prize+"</b>.</p>"+seoGrid("Special Prizes",p.special_prizes)+seoGrid("Consolation Prizes",p.consolation_prizes); }
const _seoLinks = '<p>More live results on Huatlottery: <a href="/singapore-4d-results">Singapore 4D</a>, <a href="/singapore-toto-results">Singapore TOTO</a>, <a href="/magnum-4d-result">Magnum 4D</a>, <a href="/sports-toto-4d-result">Sports Toto</a>, <a href="/da-ma-cai-result">Da Ma Cai</a>, <a href="/malaysia-4d-results">Malaysia 4D</a>.</p>';
const SEO_PAGES = {
  "/":                       { title:"4D & TOTO Results Today — Singapore & Malaysia | Huatlottery", desc:"Live 4D & TOTO results for Singapore Pools, Magnum, Sports Toto & Da Ma Cai. Latest winning numbers, jackpots and past results.", block:()=> sg4dBlock()+totoBlock()+_seoLinks },
  "/singapore-4d-results":   { title:"Singapore 4D Results Today — Live Winning Numbers | Huatlottery", desc:"Today's Singapore Pools 4D results and winning numbers — 1st, 2nd, 3rd, Starter and Consolation prizes. Live draws Wed, Sat & Sun.", block:()=> sg4dBlock()+_seoLinks },
  "/singapore-toto-results": { title:"Singapore TOTO Results Today — Winning Numbers | Huatlottery", desc:"Today's Singapore Pools TOTO winning numbers and additional number. Live TOTO draws every Monday and Thursday.", block:()=> totoBlock()+_seoLinks },
  "/magnum-4d-result":       { title:"Magnum 4D Result Today — Live Winning Numbers | Huatlottery", desc:"Today's Magnum 4D result and winning numbers — 1st, 2nd, 3rd, Special and Consolation prizes. Live Malaysia 4D draws.", block:()=> myBlock("magnum","Magnum")+_seoLinks },
  "/sports-toto-4d-result":  { title:"Sports Toto 4D Result Today — Winning Numbers | Huatlottery", desc:"Today's Sports Toto 4D result and winning numbers for Malaysia — 1st, 2nd, 3rd, Special and Consolation prizes.", block:()=> myBlock("sportstoto","Sports Toto")+_seoLinks },
  "/da-ma-cai-result":       { title:"Da Ma Cai 1+3D Result Today — Winning Numbers | Huatlottery", desc:"Today's Da Ma Cai (1+3D) result and winning numbers for Malaysia — 1st, 2nd, 3rd, Special and Consolation prizes.", block:()=> myBlock("damacai","Da Ma Cai")+_seoLinks },
  "/malaysia-4d-results":    { title:"Malaysia 4D Results Today — Magnum, Sports Toto, Da Ma Cai | Huatlottery", desc:"Live Malaysia 4D results — Magnum, Sports Toto and Da Ma Cai winning numbers, plus 5D, 6D, Lotto and jackpots.", block:()=> myBlock("magnum","Magnum")+myBlock("sportstoto","Sports Toto")+myBlock("damacai","Da Ma Cai")+_seoLinks },
};
function serveSeo(routePath, res){
  const cfg = SEO_PAGES[routePath]; if(!cfg) return false;
  const canon = "https://huatlottery.com" + routePath;
  let html = seoBase()
    .replace(/<title>[\s\S]*?<\/title>/, () => "<title>"+cfg.title+"</title>")
    .replace(/(<meta name="description" content=")[^"]*(">)/, (m,a,b)=> a+cfg.desc+b)
    .replace(/(<link rel="canonical" href=")[^"]*(">)/, (m,a,b)=> a+canon+b)
    .replace(/(<meta property="og:title" content=")[^"]*(">)/, (m,a,b)=> a+cfg.title+b)
    .replace(/(<meta property="og:description" content=")[^"]*(">)/, (m,a,b)=> a+cfg.desc+b)
    // Put the real content in a PERSISTENT sibling (#seoLander) the SPA never
    // overwrites — crawlers (and Googlebot after running JS) always read this
    // rich result content → no soft-404. Visually hidden (sr-only) so users see
    // only the app UI, not a raw text block; the text stays in the DOM for bots.
    .replace('<div class="content" id="content"></div>', () => '<div class="content" id="content"></div><div id="seoLander" style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);border:0">'+cfg.block()+'</div>');
  res.setHeader("Content-Type","text/html; charset=utf-8");
  res.setHeader("Cache-Control","public, max-age=300");
  res.send(html);
  return true;
}
Object.keys(SEO_PAGES).forEach((rp) => app.get(rp, (req, res) => { try { if(!serveSeo(rp,res)) res.status(404).end(); } catch(e){ res.status(500).end(); } }));

app.use(express.static(path.join(__dirname)));

function parseFourdRow(row) {
  if (!row) return null;
  return { ...row, starter_prizes: JSON.parse(row.starter_prizes), consolation_prizes: JSON.parse(row.consolation_prizes) };
}
function formatTotoRow(row) {
  if (!row) return null;
  return { ...row, numbers: [row.num1, row.num2, row.num3, row.num4, row.num5, row.num6] };
}
function classifyNumber(num) {
  const freq = {};
  num.split("").forEach(d => freq[d] = (freq[d] || 0) + 1);
  const mx = Math.max(...Object.values(freq));
  return mx === 4 ? "quad" : mx === 3 ? "triple" : mx === 2 ? "double" : "none";
}
function getSortedDigits(num) { return num.split("").sort().join(""); }

// ─── API ROUTES ──────────────────────────────────────────────

app.get("/api/latest", cache.withCache((req, res) => {
  try {
    const t = db.prepare("SELECT * FROM toto_draws ORDER BY draw_no DESC LIMIT 1").get();
    const f = db.prepare("SELECT * FROM fourd_draws ORDER BY draw_no DESC LIMIT 1").get();
    const fourd = parseFourdRow(f);

    // For each of the latest 4D top-3 prizes, count how often THAT number
    // has appeared in the top-3 across the whole archive.
    const top3Count = db.prepare(
      "SELECT COUNT(*) AS cnt FROM fourd_draws WHERE first_prize = ? OR second_prize = ? OR third_prize = ?"
    );
    // …and how many of those hits landed on the SAME weekday as this draw
    // (players track day-of-week luck). strftime('%w') = 0(Sun)–6(Sat).
    const top3Dow = db.prepare(
      "SELECT COUNT(*) AS cnt FROM fourd_draws WHERE (first_prize = ? OR second_prize = ? OR third_prize = ?) AND strftime('%w', draw_date) = strftime('%w', ?)"
    );
    if (fourd) {
      fourd.top3_counts = {
        first:  top3Count.get(fourd.first_prize,  fourd.first_prize,  fourd.first_prize).cnt,
        second: top3Count.get(fourd.second_prize, fourd.second_prize, fourd.second_prize).cnt,
        third:  top3Count.get(fourd.third_prize,  fourd.third_prize,  fourd.third_prize).cnt,
      };
      fourd.top3_dow = {
        first:  top3Dow.get(fourd.first_prize,  fourd.first_prize,  fourd.first_prize,  f.draw_date).cnt,
        second: top3Dow.get(fourd.second_prize, fourd.second_prize, fourd.second_prize, f.draw_date).cnt,
        third:  top3Dow.get(fourd.third_prize,  fourd.third_prize,  fourd.third_prize,  f.draw_date).cnt,
      };
    }

    // next-draw sentinels (date/time + TOTO jackpot estimate) for the footer
    const nd = {};
    db.prepare("SELECT game, next_draw_date, next_draw_time, jackpot FROM next_draws").all()
      .forEach((r) => { nd[r.game] = { date: r.next_draw_date, time: r.next_draw_time, jackpot: r.jackpot }; });
    res.json({ success: true, data: { toto: formatTotoRow(t), fourd, next_draws: nd } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
}));

// ─── MALAYSIA 4D (my_draws: magnum · sportstoto · damacai · singapore) ───
const MY_OPS = ["magnum", "sportstoto", "damacai", "singapore", "grandragon", "perdana", "lucky", "sabah", "sarawak", "sandakan"];
function parseMyRow(row) {
  if (!row) return null;
  return { ...row, special_prizes: JSON.parse(row.special_prizes), consolation_prizes: JSON.parse(row.consolation_prizes) };
}
app.get("/api/my/latest", (req, res) => {
  try {
    const data = {};
    const top3 = db.prepare("SELECT COUNT(*) AS n FROM my_draws WHERE operator=? AND (first_prize=? OR second_prize=? OR third_prize=?)");
    // same number, but only on the SAME weekday as this operator's latest draw
    const top3Dow = db.prepare("SELECT COUNT(*) AS n FROM my_draws WHERE operator=? AND (first_prize=? OR second_prize=? OR third_prize=?) AND strftime('%w', draw_date)=strftime('%w', ?)");
    for (const op of MY_OPS) {
      const row = parseMyRow(db.prepare("SELECT * FROM my_draws WHERE operator=? ORDER BY draw_date DESC LIMIT 1").get(op));
      if (row) {
        row.top3_counts = {
          first:  top3.get(op, row.first_prize,  row.first_prize,  row.first_prize).n,
          second: top3.get(op, row.second_prize, row.second_prize, row.second_prize).n,
          third:  top3.get(op, row.third_prize,  row.third_prize,  row.third_prize).n,
        };
        row.top3_dow = {
          first:  top3Dow.get(op, row.first_prize,  row.first_prize,  row.first_prize,  row.draw_date).n,
          second: top3Dow.get(op, row.second_prize, row.second_prize, row.second_prize, row.draw_date).n,
          third:  top3Dow.get(op, row.third_prize,  row.third_prize,  row.third_prize,  row.draw_date).n,
        };
      }
      data[op] = row;
    }
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.get("/api/my/:operator/draws", (req, res, next) => {
  try {
    const op = req.params.operator;
    if (op === "6d") return next();   // handled by the dedicated /api/my/6d/draws route
    if (!MY_OPS.includes(op)) return res.status(404).json({ success: false, error: "unknown operator" });
    const year = req.query.year, month = req.query.month;
    let where = " WHERE operator=?", params = [op];
    if (year) { where += " AND substr(draw_date,1,4)=?"; params.push(String(year));
      if (month) { where += " AND substr(draw_date,6,2)=?"; params.push(String(month).padStart(2, "0")); } }
    const limit = year ? 400 : Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = year ? 0 : (parseInt(req.query.offset) || 0);
    const rows = db.prepare("SELECT * FROM my_draws" + where + " ORDER BY draw_date DESC LIMIT ? OFFSET ?").all(...params, limit, offset);
    const total = db.prepare("SELECT COUNT(*) AS cnt FROM my_draws" + where).get(...params).cnt;
    const yr = db.prepare("SELECT MIN(substr(draw_date,1,4)) mn, MAX(substr(draw_date,1,4)) mx FROM my_draws WHERE operator=?").get(op);
    res.json({ success: true, data: rows.map(parseMyRow), pagination: { limit, offset, total }, year_range: { min: +yr.mn, max: +yr.mx } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
app.get("/api/my/:operator/check", (req, res) => {
  try {
    const op = req.params.operator;
    if (!MY_OPS.includes(op)) return res.status(404).json({ success: false, error: "unknown operator" });
    const num = String(req.query.num || "").padStart(4, "0");
    if (!/^[0-9]{4}$/.test(num)) return res.status(400).json({ success: false, error: "num must be 4 digits" });
    const rows = db.prepare("SELECT * FROM my_draws WHERE operator=? ORDER BY draw_date DESC").all(op);
    const hits = { first: 0, second: 0, third: 0, special: 0, consolation: 0 }, recent = [];
    for (const r of rows) {
      let tier = r.first_prize === num ? "first" : r.second_prize === num ? "second" : r.third_prize === num ? "third"
        : JSON.parse(r.special_prizes).includes(num) ? "special" : JSON.parse(r.consolation_prizes).includes(num) ? "consolation" : null;
      if (tier) { hits[tier]++; if (recent.length < 10) recent.push({ date: r.draw_date, tier }); }
    }
    const total_wins = hits.first + hits.second + hits.third + hits.special + hits.consolation;
    res.json({ success: true, data: { operator: op, number: num, total_wins, hits, recent, draws_scanned: rows.length } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
// deep stats over an operator's full history (mirrors /api/fourd/stats, on my_draws)
app.get("/api/my/:operator/stats", cache.withCache((req, res) => {
  try {
    const op = req.params.operator;
    if (!MY_OPS.includes(op)) return res.status(404).json({ success: false, error: "unknown operator" });
    const rows = db.prepare("SELECT * FROM my_draws WHERE operator=? ORDER BY draw_date DESC").all(op);
    const freq = {}, tierBreak = {}, lastSeen = {}, digitFreq = [0,0,0,0,0,0,0,0,0,0], yearFreq = {};
    const doubleD = [0,0,0,0,0,0,0,0,0,0], tripleD = [0,0,0,0,0,0,0,0,0,0], quadD = [0,0,0,0,0,0,0,0,0,0];
    const cls = { double: 0, triple: 0, quad: 0 };
    let totalNumbers = 0;
    rows.forEach((row, idx) => {
      const yr = row.draw_date.slice(0, 4);
      const sp = JSON.parse(row.special_prizes), cn = JSON.parse(row.consolation_prizes);
      const tiered = [[row.first_prize,"first"],[row.second_prize,"second"],[row.third_prize,"third"]]
        .concat(sp.map(n => [n,"special"])).concat(cn.map(n => [n,"consol"]));
      for (const [num, tier] of tiered) {
        if (!num) continue;
        freq[num] = (freq[num] || 0) + 1;
        tierBreak[num] = tierBreak[num] || { first:0, second:0, third:0, special:0, consol:0 };
        tierBreak[num][tier]++;
        if (lastSeen[num] == null) lastSeen[num] = idx;          // rows DESC → first hit = most recent
        const dcount = {};
        for (const d of num) { digitFreq[+d]++; dcount[d] = (dcount[d] || 0) + 1; }
        for (const d in dcount) { if (dcount[d] === 2) doubleD[+d]++; else if (dcount[d] === 3) tripleD[+d]++; else if (dcount[d] === 4) quadD[+d]++; }
        const c = classifyNumber(num); if (c !== "none") cls[c]++;
        const yb = (yearFreq[yr] = yearFreq[yr] || {});
        const e = yb[num] = yb[num] || { first:0, second:0, third:0, special:0, consol:0, total:0 };
        e[tier]++; e.total++;
        totalNumbers++;
      }
    });
    const hot = Object.entries(freq).sort((a,b) => b[1]-a[1]).slice(0,20)
      .map(([number,count]) => ({ number, count, pct: Math.round(count/totalNumbers*10000)/100, breakdown: tierBreak[number] }));
    const cold = Object.entries(freq).sort((a,b) => a[1]-b[1] || (a[0] < b[0] ? -1 : 1)).slice(0,10)
      .map(([number,count]) => ({ number, count, pct: Math.round(count/totalNumbers*10000)/100, breakdown: tierBreak[number] }));
    const overdue = Object.entries(lastSeen).sort((a,b) => b[1]-a[1]).slice(0,20)
      .map(([number,idx]) => ({ number, draws_since: idx, last_date: rows[idx] ? rows[idx].draw_date : null }));
    const digit_frequency = digitFreq.map((count,d) => ({ digit: String(d), count, pct: Math.round(count/totalNumbers*1000)/10 }));
    // Repeat 1st-Prize Winners — numbers that won 1st prize more than once
    const repeat_winners = Object.entries(tierBreak).filter(([n,b]) => b.first >= 2).sort((a,b) => b[1].first - a[1].first).slice(0,25)
      .map(([number,b]) => ({ number, wins: b.first }));
    // Year-by-Year — most-frequent number each year (across all 23 prize positions)
    const year_by_year = Object.keys(yearFreq).sort().reverse().map((yr) => {
      const top = Object.entries(yearFreq[yr]).sort((a,b) => b[1].total - a[1].total)[0], b = top[1];
      return { year: yr, number: top[0], count: b.total, breakdown: { first: b.first, second: b.second, third: b.third, special: b.special, consol: b.consol } };
    });
    const rank = (arr, n) => arr.map((count, d) => ({ number: String(d).repeat(n), count })).sort((a, b) => b.count - a.count);
    const pick = (a) => ({ top: a.slice(0, 3), bottom: a.slice(-3).reverse() });
    const sum = (arr) => arr.reduce((s, v) => s + v, 0);
    // total = category occurrences, so each item's % can be measured against its own kind
    const digit_pairs = {
      doubles: Object.assign(pick(rank(doubleD, 2)), { total: sum(doubleD) }),
      triples: Object.assign(pick(rank(tripleD, 3)), { total: sum(tripleD) }),
      quads: Object.assign(pick(rank(quadD, 4)), { total: sum(quadD) }),
    };
    res.json({ success: true, data: {
      operator: op, total_draws: rows.length, total_numbers: totalNumbers,
      date_range: { from: rows.length ? rows[rows.length-1].draw_date : null, to: rows.length ? rows[0].draw_date : null },
      hot_numbers: hot, cold_numbers: cold, overdue_numbers: overdue, digit_frequency, classification: cls,
      repeat_winners, year_by_year, digit_pairs
    } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
}));

// SG TOTO winning shares (Group 1–7: share amount + no. of winners) for the CURRENT draw.
// Live-fetched from SG Pools' server-rendered result page (has the shares statically), cached 1h.
let _totoShares = {};   // per-draw cache: { [drawNo]: { ts, data } }
app.get("/api/toto/shares", async (req, res) => {
  try {
    const latest = db.prepare("SELECT draw_no FROM toto_draws ORDER BY draw_no DESC LIMIT 1").get();
    if (!latest) return res.json({ success: true, data: null });
    const drawNo = req.query.draw ? parseInt(req.query.draw, 10) : latest.draw_no;
    const cached = _totoShares[drawNo];
    if (cached && Date.now() - cached.ts < 3600e3) return res.json({ success: true, data: cached.data });
    const sppl = Buffer.from("DrawNumber=" + drawNo).toString("base64");
    const url = "https://www.singaporepools.com.sg/en/product/sr/Pages/toto_results.aspx?sppl=" + sppl;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36" } });
    const $ = require("cheerio").load(await r.text());
    const groups = [];
    $("table").each((i, t) => {
      if (!/Prize Group|Group 1/i.test($(t).text())) return;
      $(t).find("tr").each((j, tr) => {
        const c = $(tr).find("td,th").map((k, x) => $(x).text().replace(/\s+/g, " ").trim()).get();
        const m = c[0] && c[0].match(/Group ([1-7])/);
        if (m) groups.push({ group: +m[1], share: c[1] || "-", winners: c[2] || "-" });
      });
    });
    const seen = {}, uniq = [];
    for (const g of groups) if (!seen[g.group]) { seen[g.group] = 1; uniq.push(g); }
    uniq.sort((a, b) => a.group - b.group);
    const g1 = $.text().replace(/\s+/g, " ").match(/Group 1 Prize[^0-9]*(\$[\d,]+)/i);
    const snowball = uniq.length > 0 && (uniq[0].share === "-" || uniq[0].winners === "-" || uniq[0].winners === "0");
    const data = { draw_no: drawNo, g1_prize: g1 ? g1[1] : null, groups: uniq, snowball };
    _totoShares[drawNo] = { ts: Date.now(), data };
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Check a specific TOTO combination against the full archive — precise "how would my numbers have done"
app.get("/api/toto/combo-check", (req, res) => {
  try {
    const nums = [...new Set((req.query.nums || "").split(/[,\s]+/).map((n) => parseInt(n, 10)).filter((n) => n >= 1 && n <= 49))];
    if (!nums.length) return res.json({ success: false, error: "Enter 1–6 numbers between 1 and 49." });
    const rows = db.prepare("SELECT * FROM toto_draws ORDER BY draw_no DESC").all();
    const perNum = {}; nums.forEach((n) => (perNum[n] = 0));
    const dist = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    const all = [];
    for (const row of rows) {
      const d = formatTotoRow(row);
      const drawSet = new Set(d.numbers.map(Number));
      let matched = 0;
      for (const n of nums) if (drawSet.has(n)) { matched++; perNum[n]++; }
      dist[matched] = (dist[matched] || 0) + 1;
      all.push({ draw_no: d.draw_no, draw_date: d.draw_date, numbers: d.numbers, additional_num: d.additional_num, matched, add_match: nums.includes(Number(d.additional_num)) });
    }
    all.sort((a, b) => b.matched - a.matched || b.draw_no - a.draw_no);
    res.json({ success: true, data: {
      input: nums.slice().sort((a, b) => a - b), total_draws: rows.length, best_match: all.length ? all[0].matched : 0,
      distribution: dist, per_number: nums.slice().sort((a, b) => a - b).map((n) => ({ number: n, count: perNum[n] })),
      top_draws: all.slice(0, 10),
    } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Sports Toto 6D — latest from my6d_draws (backfilled from gd4d; stored history enables future stats).
app.get("/api/my/6d", (req, res) => {
  try {
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='my6d_draws'").get();
    if (!has) return res.json({ success: true, data: null });
    const row = db.prepare("SELECT draw_date, number FROM my6d_draws ORDER BY draw_date DESC LIMIT 1").get();
    const total = db.prepare("SELECT COUNT(*) AS n FROM my6d_draws").get().n;
    res.json({ success: true, data: row ? { operator: "sportstoto", game: "6D", draw_date: row.draw_date, number: row.number, total_draws: total } : null });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// 6D history — past draws with year/month filter (Others "View History")
app.get("/api/my/6d/draws", (req, res) => {
  try {
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='my6d_draws'").get();
    if (!has) return res.json({ success: true, data: [], year_range: null });
    const year = req.query.year, month = req.query.month;
    let where = "", params = [];
    if (year) { where = " WHERE substr(draw_date,1,4)=?"; params.push(String(year));
      if (month) { where += " AND substr(draw_date,6,2)=?"; params.push(String(month).padStart(2, "0")); } }
    const limit = year ? 400 : 20;
    const rows = db.prepare("SELECT draw_date, number FROM my6d_draws" + where + " ORDER BY draw_date DESC LIMIT ?").all(...params, limit);
    const yr = db.prepare("SELECT MIN(substr(draw_date,1,4)) mn, MAX(substr(draw_date,1,4)) mx FROM my6d_draws").get();
    res.json({ success: true, data: rows.map((r) => ({ draw_date: r.draw_date, number: r.number })), year_range: yr.mn ? { min: +yr.mn, max: +yr.mx } : null });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Malaysia big-3 current draw number + 4D Jackpot 1/2 amount and winner status, live from check4d,
// cached 1h. Parsed per operator block (name at top, jackpot at bottom of each block).
// Shape: { magnum: { no:"390/26", j1:{amt,status}, j2:{amt,status} }, ... }
let _drawNos = { ts: 0, data: null };
app.get("/api/my/drawnos", async (req, res) => {
  try {
    if (_drawNos.data && Date.now() - _drawNos.ts < 3600e3) return res.json({ success: true, data: _drawNos.data });
    const r = await fetch("https://www.check4d.org/", { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36" } });
    const t = (await r.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const anchors = { magnum: "Magnum 4D", damacai: "Da Ma Cai 1+3D", sportstoto: "SportsToto 4D" };
    const pos = Object.keys(anchors).map((op) => ({ op, i: t.indexOf(anchors[op]) })).filter((x) => x.i >= 0).sort((a, b) => a.i - b.i);
    const map = {};
    const fmt = (p) => (p ? { amt: p[1].replace(/\s+/g, " ").trim(), status: p[2] || "No winner" } : null);
    for (let idx = 0; idx < pos.length; idx++) {
      const op = pos[idx].op;
      const block = t.slice(pos[idx].i, idx + 1 < pos.length ? pos[idx + 1].i : pos[idx].i + 2500);
      const info = {};
      const dm = block.match(/Draw No[.:]*\s*(\d{2,5}\/\d{2})/i);
      if (dm) info.no = dm[1];
      const jm = block.match(/4D Jackpot 1 Prize\s*4D Jackpot 2 Prize\s*(.*?)(?:Next Draw|3D Jackpot|$)/i);
      if (jm) {
        const parts = [...jm[1].matchAll(/(RM\s?[\d,]+(?:\.\d+)?)\s*(Partially Won|Won)?/gi)];
        info.j1 = fmt(parts[0]); info.j2 = fmt(parts[1]);
      }
      const nm = block.match(/Next Draw Estimated Amount\s*4D Jackpot 1 Prize\s*4D Jackpot 2 Prize\s*(RM\s?[\d,]+(?:\.\d+)?)\s*(RM\s?[\d,]+(?:\.\d+)?)/i);
      if (nm) info.next = { j1: nm[1].replace(/\s+/g, " ").trim(), j2: nm[2].replace(/\s+/g, " ").trim() };
      map[op] = info;
    }
    _drawNos = { ts: Date.now(), data: map };
    res.json({ success: true, data: map });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Sports Toto non-4D products: 5D (gd4d) + Star/Power/Supreme Toto lotto (check4d). Cached 1h.
// External scrapes with a hard timeout so a slow source can't hang the request.
const _SCRAPE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
function fetchTimeout(url, ms) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms || 8000);
  return fetch(url, { headers: { "User-Agent": _SCRAPE_UA }, signal: ctrl.signal }).finally(() => clearTimeout(to));
}
// Persist a single Other-game result into the archive (idempotent per game+date).
// Called from the live scrapes so history accrues going forward.
const _archiveOther = db.prepare(
  "INSERT OR IGNORE INTO other_draws (game, draw_date, draw_no, payload) VALUES (?, ?, ?, ?)"
);
function archiveOtherGame(game, obj) {
  try {
    if (!obj || !obj.date) return;                  // need at least a date to key on
    _archiveOther.run(game, obj.date, obj.drawNo || null, JSON.stringify(obj));
  } catch (e) { /* archival is best-effort; never break the live response */ }
}
async function computeTotoProd() {
    // Parsing lives in the shared module (scraper/my/parse-other.js) so the live
    // server and the CI scraper stay in lockstep.
    const gd4dHtml = await (await fetchTimeout("https://gd4d.co/en", 8000)).text();
    const check4dText = (await (await fetchTimeout("https://www.check4d.org/", 8000)).text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const data = parseTotoProducts(gd4dHtml, check4dText);
    // archive each game for history (5D keys on the page date if it lacks its own)
    archiveOtherGame("fived", data.fiveD && { ...data.fiveD, date: data.fiveD.date || data.date });
    archiveOtherGame("star", data.star);
    archiveOtherGame("power", data.power);
    archiveOtherGame("supreme", data.supreme);
    return data;
}
// Stale-while-revalidate: answer from cache instantly; refresh in background when stale.
let _totoProd = { ts: 0, data: null, refreshing: false };
async function refreshTotoProd() {
  if (_totoProd.refreshing) return;
  _totoProd.refreshing = true;
  try { _totoProd = { ts: Date.now(), data: await computeTotoProd(), refreshing: false }; }
  catch (e) { _totoProd.refreshing = false; }
}
app.get("/api/my/toto-products", async (req, res) => {
  if (_totoProd.data) {
    res.json({ success: true, data: _totoProd.data });
    if (Date.now() - _totoProd.ts >= 3600e3) refreshTotoProd();   // stale → refresh in bg
    return;
  }
  try { await refreshTotoProd(); } catch (e) {}                    // first-ever fetch (cold)
  res.json({ success: true, data: _totoProd.data || {} });
});

// More non-4D MY games: Da Ma Cai 3+3D, Magnum Life, Magnum 4D Jackpot Gold, Sabah Lotto 6/45.
async function computeOtherGames() {
    const t = (await (await fetchTimeout("https://www.check4d.org/", 8000)).text()).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
    const data = parseOtherGames(t);   // shared parser (scraper/my/parse-other.js)
    archiveOtherGame("damacai33d", data.damacai33d);
    archiveOtherGame("magnumlife", data.magnumLife);
    archiveOtherGame("jackpotgold", data.jackpotGold);
    archiveOtherGame("sabahlotto", data.sabahLotto);
    return data;
}
let _otherGames = { ts: 0, data: null, refreshing: false };
async function refreshOtherGames() {
  if (_otherGames.refreshing) return;
  _otherGames.refreshing = true;
  try { _otherGames = { ts: Date.now(), data: await computeOtherGames(), refreshing: false }; }
  catch (e) { _otherGames.refreshing = false; }
}
app.get("/api/my/other-games", async (req, res) => {
  if (_otherGames.data) {
    res.json({ success: true, data: _otherGames.data });
    if (Date.now() - _otherGames.ts >= 3600e3) refreshOtherGames();   // stale → refresh in bg
    return;
  }
  try { await refreshOtherGames(); } catch (e) {}                      // first-ever fetch (cold)
  res.json({ success: true, data: _otherGames.data || {} });
});

app.get("/api/toto/draws", (req, res) => {
  try {
    const year = req.query.year, month = req.query.month;
    let where = "", params = [];
    if (year) { where = " WHERE substr(draw_date,1,4)=?"; params.push(String(year));
      if (month) { where += " AND substr(draw_date,6,2)=?"; params.push(String(month).padStart(2, "0")); } }
    const limit = year ? 400 : Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = year ? 0 : (parseInt(req.query.offset) || 0);
    const rows = db.prepare("SELECT * FROM toto_draws" + where + " ORDER BY draw_no DESC LIMIT ? OFFSET ?").all(...params, limit, offset);
    const total = db.prepare("SELECT COUNT(*) AS cnt FROM toto_draws" + where).get(...params).cnt;
    const yr = db.prepare("SELECT MIN(substr(draw_date,1,4)) mn, MAX(substr(draw_date,1,4)) mx FROM toto_draws").get();
    res.json({ success: true, data: rows.map(formatTotoRow), pagination: { limit, offset, total }, year_range: { min: +yr.mn, max: +yr.mx } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/api/toto/stats", cache.withCache((req, res) => {
  try {
    // CRITICAL: only count draws from the strict 6/49 era (post-9-Oct-2014).
    // Before that, Singapore TOTO was 6/45 (numbers 46-49 didn't exist) or
    // 5/49 (only 5 numbers per draw). Including pre-2014 data would make
    // 46-49 look perpetually "cold" and skew every hot/cold classification.
    const rows = db.prepare(
      "SELECT num1, num2, num3, num4, num5, num6 FROM toto_draws " +
      "WHERE draw_date >= '2014-10-09' AND num6 IS NOT NULL"
    ).all();
    const freq = {}; for (let n = 1; n <= 49; n++) freq[n] = 0;
    const eo = { "0E/6O": 0, "1E/5O": 0, "2E/4O": 0, "3E/3O": 0, "4E/2O": 0, "5E/1O": 0, "6E/0O": 0 };
    const sums = []; let tE = 0, tO = 0;
    for (const row of rows) {
      const nums = [row.num1, row.num2, row.num3, row.num4, row.num5, row.num6];
      let ec = 0, ds = 0;
      for (const n of nums) { freq[n]++; ds += n; if (n % 2 === 0) { ec++; tE++; } else tO++; }
      eo[`${ec}E/${6 - ec}O`]++; sums.push(ds);
    }
    const sorted = Object.entries(freq).map(([n, c]) => ({ number: parseInt(n), count: c })).sort((a, b) => b.count - a.count);

    // 3-tier classification covering ALL 49 numbers. Top 15 / Middle 19 / Bottom 15.
    // Simpler than 5 tiers — 'very hot' vs 'hot' was a meaningless distinction.
    const tiers = {};
    sorted.forEach((item, idx) => {
      let tier;
      if (idx < 15)       tier = "HOT";
      else if (idx < 34)  tier = "AVERAGE";
      else                tier = "COLD";
      tiers[item.number] = { tier, rank: idx + 1, count: item.count };
    });
    const td = rows.length;
    const avg = sums.length ? Math.round(sums.reduce((a, b) => a + b, 0) / sums.length) : 0;
    const bk = {}; sums.forEach(s => { const k = `${Math.floor(s / 25) * 25}-${Math.floor(s / 25) * 25 + 24}`; bk[k] = (bk[k] || 0) + 1; });
    // Per-position distribution: for the 6 numbers sorted ascending in each draw,
    // what's the mean / range of each position? Tells you "typical shape" of a draw.
    const positionStats = [[], [], [], [], [], []];   // 6 positions
    for (const row of rows) {
      const sortedNums = [row.num1, row.num2, row.num3, row.num4, row.num5, row.num6]
        .filter(n => n != null).sort((a,b) => a - b);
      sortedNums.forEach((n, i) => positionStats[i].push(n));
    }
    const positionDist = positionStats.map((vals, i) => {
      if (!vals.length) return null;
      const mean = vals.reduce((a,b)=>a+b,0) / vals.length;
      return {
        position: i + 1,
        mean: Math.round(mean * 10) / 10,
        min: Math.min(...vals),
        max: Math.max(...vals),
      };
    }).filter(Boolean);

    res.json({ success: true, data: {
      total_draws: td, frequency: sorted, tiers, position_dist: positionDist,
      hot_numbers: sorted.slice(0, 6).map(x => x.number), cold_numbers: sorted.slice(-6).map(x => x.number),
      even_odd: { total_even: tE, total_odd: tO, even_pct: Math.round(tE / (tE + tO) * 1000) / 10, odd_pct: Math.round(tO / (tE + tO) * 1000) / 10, distribution: Object.entries(eo).map(([l, c]) => ({ label: l, count: c })) },
      sum_analysis: { average: avg, min: sums.length ? Math.min(...sums) : 0, max: sums.length ? Math.max(...sums) : 0, buckets: Object.entries(bk).map(([r, c]) => ({ range: r, count: c })).sort((a, b) => parseInt(a.range) - parseInt(b.range)) },
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
}));

app.get("/api/toto/search", (req, res) => {
  try {
    const { number, date, from, to } = req.query;
    if (date) { const r = db.prepare("SELECT * FROM toto_draws WHERE draw_date = ? ORDER BY draw_no DESC").all(date); return res.json({ success: true, query: date, total_matches: r.length, data: r.map(formatTotoRow) }); }
    if (from && to) { const r = db.prepare("SELECT * FROM toto_draws WHERE draw_date BETWEEN ? AND ? ORDER BY draw_no DESC").all(from, to); return res.json({ success: true, query: `${from} to ${to}`, total_matches: r.length, data: r.map(formatTotoRow) }); }
    // Multi-number combination search: 1–6 numbers → draws whose 6-ball combination
    // contains ALL of them (each entered number must be among num1..num6).
    if (req.query.numbers) {
      const uniq = [...new Set(String(req.query.numbers).split(/[\s,]+/).map((x) => parseInt(x, 10)).filter((x) => x >= 1 && x <= 49))].slice(0, 6);
      if (!uniq.length) return res.status(400).json({ success: false, error: "Enter 1–6 numbers (1–49)." });
      const cond = uniq.map(() => "(num1=? OR num2=? OR num3=? OR num4=? OR num5=? OR num6=?)").join(" AND ");
      const params = [];
      uniq.forEach((n) => { for (let i = 0; i < 6; i++) params.push(n); });
      const r = db.prepare(`SELECT * FROM toto_draws WHERE ${cond} ORDER BY draw_no DESC`).all(...params);
      return res.json({ success: true, query: uniq.join(","), searched: uniq, total_matches: r.length, data: r.map(formatTotoRow) });
    }
    if (number) {
      const n = parseInt(number);
      const r = db.prepare("SELECT * FROM toto_draws WHERE num1=? OR num2=? OR num3=? OR num4=? OR num5=? OR num6=? OR additional_num=? ORDER BY draw_no DESC").all(n, n, n, n, n, n, n);
      return res.json({ success: true, query: number, total_matches: r.length, data: r.map(formatTotoRow) });
    }
    res.status(400).json({ success: false, error: "Provide ?number=, ?date=, or ?from=&to=" });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/api/fourd/draws", (req, res) => {
  try {
    const year = req.query.year, month = req.query.month;
    let where = "", params = [];
    if (year) { where = " WHERE substr(draw_date,1,4)=?"; params.push(String(year));
      if (month) { where += " AND substr(draw_date,6,2)=?"; params.push(String(month).padStart(2, "0")); } }
    const limit = year ? 400 : Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = year ? 0 : (parseInt(req.query.offset) || 0);
    const rows = db.prepare("SELECT * FROM fourd_draws" + where + " ORDER BY draw_no DESC LIMIT ? OFFSET ?").all(...params, limit, offset);
    const total = db.prepare("SELECT COUNT(*) AS cnt FROM fourd_draws" + where).get(...params).cnt;
    const yr = db.prepare("SELECT MIN(substr(draw_date,1,4)) mn, MAX(substr(draw_date,1,4)) mx FROM fourd_draws").get();
    res.json({ success: true, data: rows.map(parseFourdRow), pagination: { limit, offset, total }, year_range: { min: +yr.mn, max: +yr.mx } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/api/fourd/search", (req, res) => {
  try {
    const { number, date, from, to } = req.query;
    if (date) { const r = db.prepare("SELECT * FROM fourd_draws WHERE draw_date = ? ORDER BY draw_no DESC").all(date); return res.json({ success: true, query: date, total_matches: r.length, data: r.map(parseFourdRow) }); }
    if (from && to) { const r = db.prepare("SELECT * FROM fourd_draws WHERE draw_date BETWEEN ? AND ? ORDER BY draw_no DESC").all(from, to); return res.json({ success: true, query: `${from} to ${to}`, total_matches: r.length, data: r.map(parseFourdRow) }); }
    if (number) {
      if (!/^\d{4}$/.test(number)) return res.status(400).json({ success: false, error: "4-digit number required" });
      const rows = db.prepare("SELECT * FROM fourd_draws ORDER BY draw_no DESC").all();
      const matches = [];
      for (const row of rows) {
        const p = parseFourdRow(row);
        const hit = { draw_no: p.draw_no, draw_date: p.draw_date, prizes: [] };
        if (p.first_prize === number) hit.prizes.push("1st Prize");
        if (p.second_prize === number) hit.prizes.push("2nd Prize");
        if (p.third_prize === number) hit.prizes.push("3rd Prize");
        if (p.starter_prizes.includes(number)) hit.prizes.push("Starter");
        if (p.consolation_prizes.includes(number)) hit.prizes.push("Consolation");
        if (hit.prizes.length > 0) matches.push(hit);
      }
      return res.json({ success: true, query: number, total_matches: matches.length, data: matches });
    }
    res.status(400).json({ success: false, error: "Provide ?number=, ?date=, or ?from=&to=" });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/api/fourd/stats", cache.withCache((req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM fourd_draws ORDER BY draw_no DESC").all();
    const totalDraws = rows.length;
    const byC = { first: [], second: [], third: [], starter: [], consolation: [] };
    const allNumbers = [], lastSeen = {};
    rows.forEach((row, idx) => {
      const p = parseFourdRow(row);
      byC.first.push(p.first_prize); byC.second.push(p.second_prize); byC.third.push(p.third_prize);
      byC.starter.push(...p.starter_prizes); byC.consolation.push(...p.consolation_prizes);
      const nums = [p.first_prize, p.second_prize, p.third_prize, ...p.starter_prizes, ...p.consolation_prizes];
      allNumbers.push(...nums);
      for (const n of nums) if (lastSeen[n] == null) lastSeen[n] = idx;   // rows DESC → first hit = most recent
    });
    const tn = allNumbers.length;
    const dc = { double: {}, triple: {}, quad: {} };
    let dC = 0, tC = 0, qC = 0;
    for (const num of allNumbers) {
      const cls = classifyNumber(num);
      if (cls === "double") { dC++; dc.double[num] = (dc.double[num] || 0) + 1; }
      if (cls === "triple") { tC++; dc.triple[num] = (dc.triple[num] || 0) + 1; }
      if (cls === "quad") { qC++; dc.quad[num] = (dc.quad[num] || 0) + 1; }
    }
    const topN = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([num, count]) => ({ number: num, count }));
    const gf = {}; allNumbers.forEach(n => gf[n] = (gf[n] || 0) + 1);
    // Per-tier breakdown for Top 10 — how many 1st/2nd/3rd/starter/consol each
    const tierBreak = {};
    for (const num of byC.first)       { tierBreak[num] = tierBreak[num] || {first:0,second:0,third:0,starter:0,consol:0}; tierBreak[num].first++; }
    for (const num of byC.second)      { tierBreak[num] = tierBreak[num] || {first:0,second:0,third:0,starter:0,consol:0}; tierBreak[num].second++; }
    for (const num of byC.third)       { tierBreak[num] = tierBreak[num] || {first:0,second:0,third:0,starter:0,consol:0}; tierBreak[num].third++; }
    for (const num of byC.starter)     { tierBreak[num] = tierBreak[num] || {first:0,second:0,third:0,starter:0,consol:0}; tierBreak[num].starter++; }
    for (const num of byC.consolation) { tierBreak[num] = tierBreak[num] || {first:0,second:0,third:0,starter:0,consol:0}; tierBreak[num].consol++; }
    const earliestDate = rows.length ? rows[rows.length - 1].draw_date : null;
    const latestDate   = rows.length ? rows[0].draw_date : null;
    const top10 = Object.entries(gf).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([number, count]) => ({
      number, count,
      pct: Math.round(count / tn * 10000) / 100,
      breakdown: tierBreak[number] || {first:0,second:0,third:0,starter:0,consol:0},
    }));
    const top10Range = { from: earliestDate, to: latestDate };
    // Coldest 10 — least-frequent numbers that have still appeared at least once
    const top10Cold = Object.entries(gf).sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 10).map(([number, count]) => ({
      number, count, pct: Math.round(count / tn * 10000) / 100,
      breakdown: tierBreak[number] || {first:0,second:0,third:0,starter:0,consol:0},
    }));
    const eTop = arr => { const f = {}; arr.forEach(n => f[n] = (f[n] || 0) + 1); const t = arr.length; return Object.entries(f).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([number, count]) => ({ number, count, pct: Math.round(count / t * 10000) / 100 })); };
    const pTop = arr => { const f = {}; arr.forEach(n => { const k = getSortedDigits(n); f[k] = (f[k] || 0) + 1; }); const t = arr.length; return Object.entries(f).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([sd, count]) => ({ sorted_digits: sd, count, pct: Math.round(count / t * 10000) / 100 })); };
    const exact = {}, perm = {};
    for (const cat of Object.keys(byC)) { exact[cat] = { top3: eTop(byC[cat]), total: byC[cat].length }; perm[cat] = { top3: pTop(byC[cat]), total: byC[cat].length }; }
    res.json({ success: true, data: {
      total_draws: totalDraws, total_numbers: tn,
      digit_classification: { double: { count: dC, pct: Math.round(dC / tn * 1000) / 10, top3: topN(dc.double, 3) }, triple: { count: tC, pct: Math.round(tC / tn * 1000) / 10, top3: topN(dc.triple, 3) }, quad: { count: qC, pct: Math.round(qC / tn * 1000) / 10, top3: topN(dc.quad, 3) } },
      top10_hot: top10, top10_cold: top10Cold, top10_date_range: top10Range,
      overdue_numbers: Object.entries(lastSeen).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([number, idx]) => ({ number, draws_since: idx, last_date: rows[idx] ? rows[idx].draw_date : null })),
      exact_match: exact, perm_match: perm,
    }});
  } catch (err) { console.error(err); res.status(500).json({ success: false, error: err.message }); }
}));

// ─── This month vs all-time ─────────────────────────────────────────
app.get("/api/toto/current-month", (req, res) => {
  try {
    const sgt = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const monthPrefix = `${sgt.getUTCFullYear()}-${String(sgt.getUTCMonth() + 1).padStart(2, "0")}`;
    const rows = db.prepare(
      "SELECT num1, num2, num3, num4, num5, num6 FROM toto_draws " +
      "WHERE draw_date >= '2014-10-09' AND num6 IS NOT NULL AND substr(draw_date, 1, 7) = ?"
    ).all(monthPrefix);
    const freq = {};
    for (let n = 1; n <= 49; n++) freq[n] = 0;
    for (const r of rows) {
      for (const k of [r.num1, r.num2, r.num3, r.num4, r.num5, r.num6]) freq[k]++;
    }
    const sorted = Object.entries(freq).map(([k,c]) => ({n:+k, c})).sort((a,b) => b.c - a.c);
    res.json({ success: true, data: {
      month: monthPrefix,
      draws_this_month: rows.length,
      hot:  sorted.filter(x => x.c > 0).slice(0, 6),
      cold: sorted.slice(-6).reverse(),
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Best partners for a given additional number ─────────────────────
app.get("/api/toto/additional-partners", (req, res) => {
  try {
    const a = parseInt(req.query.add, 10);
    if (!Number.isInteger(a) || a < 1 || a > 49) {
      return res.status(400).json({ success: false, error: "?add=NUMBER (1-49)" });
    }
    const rows = db.prepare(
      "SELECT num1, num2, num3, num4, num5, num6 FROM toto_draws " +
      "WHERE additional_num = ? AND draw_date >= '2014-10-09' AND num6 IS NOT NULL"
    ).all(a);
    const partners = {};
    for (let k = 1; k <= 49; k++) partners[k] = 0;
    for (const r of rows) {
      for (const k of [r.num1, r.num2, r.num3, r.num4, r.num5, r.num6]) partners[k]++;
    }
    const sorted = Object.entries(partners)
      .filter(([k]) => +k !== a)
      .map(([k,c]) => ({n:+k, c}))
      .sort((a,b) => b.c - a.c);
    res.json({ success: true, data: {
      additional: a,
      draws_with_anchor: rows.length,
      top_partners: sorted.slice(0, 6),
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Festival draws ─────────────────────────────────────────────────
app.get("/api/festival", cache.withCache((req, res) => {
  try {
    const key = req.query.festival;
    if (!key) {
      return res.json({ success: true, data: {
        available: Object.entries(FESTIVALS).map(([k,v]) => ({ key: k, name: v.name }))
      }});
    }
    if (!FESTIVALS[key]) return res.status(400).json({ success: false, error: "Unknown festival" });

    const currentYear = new Date().getFullYear();
    const dates = [];
    for (let y = 2014; y <= currentYear; y++) {
      const arr = FESTIVALS[key].solar_dates(y) || [];
      arr.forEach(d => d && dates.push({ year: y, date: d }));
    }
    if (dates.length === 0) return res.json({ success: true, data: { festival: key, dates: [], toto: [], fourd: [] }});

    const dateList = dates.map(x => x.date);
    const placeholders = dateList.map(() => '?').join(',');
    const totoRows = db.prepare(
      "SELECT draw_no, draw_date, num1, num2, num3, num4, num5, num6, additional_num " +
      "FROM toto_draws WHERE draw_date IN (" + placeholders + ") ORDER BY draw_no DESC"
    ).all(...dateList);
    const fourdRows = db.prepare(
      "SELECT draw_no, draw_date, first_prize, second_prize, third_prize " +
      "FROM fourd_draws WHERE draw_date IN (" + placeholders + ") ORDER BY draw_no DESC"
    ).all(...dateList);
    res.json({ success: true, data: {
      festival: key,
      name: FESTIVALS[key].name,
      dates_checked: dates,
      toto: totoRows.map(r => ({ ...r, numbers: [r.num1, r.num2, r.num3, r.num4, r.num5, r.num6].filter(n => n != null) })),
      fourd: fourdRows,
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
}));

// ─── Lunar date lookup ──────────────────────────────────────────────
app.get("/api/lunar-lookup", (req, res) => {
  try {
    const lm = parseInt(req.query.lunar_month, 10);
    const ld = parseInt(req.query.lunar_day, 10);
    if (!Number.isInteger(lm) || lm < 1 || lm > 12 || !Number.isInteger(ld) || ld < 1 || ld > 30) {
      return res.status(400).json({ success: false, error: "?lunar_month=1-12&lunar_day=1-30" });
    }
    const currentYear = new Date().getFullYear();
    const dates = [];
    for (let y = 2014; y <= currentYear; y++) {
      const d = solarFromLunar(y, lm, ld);
      if (d) dates.push({ lunar_year: y, solar: d });
    }
    if (dates.length === 0) return res.json({ success: true, data: { lunar_month: lm, lunar_day: ld, toto: [], fourd: [] }});

    const dateList = dates.map(x => x.solar);
    const placeholders = dateList.map(() => '?').join(',');
    const totoRows = db.prepare(
      "SELECT draw_no, draw_date, num1, num2, num3, num4, num5, num6, additional_num " +
      "FROM toto_draws WHERE draw_date IN (" + placeholders + ") ORDER BY draw_no DESC"
    ).all(...dateList);
    const fourdRows = db.prepare(
      "SELECT draw_no, draw_date, first_prize, second_prize, third_prize " +
      "FROM fourd_draws WHERE draw_date IN (" + placeholders + ") ORDER BY draw_no DESC"
    ).all(...dateList);
    res.json({ success: true, data: {
      lunar_month: lm,
      lunar_day: ld,
      solar_dates_checked: dates,
      toto: totoRows.map(r => ({ ...r, numbers: [r.num1, r.num2, r.num3, r.num4, r.num5, r.num6].filter(n => n != null) })),
      fourd: fourdRows,
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── 4D Dream-number lookup (Singapore folk-belief mapping) ─────────
app.get("/api/fourd/dream", (req, res) => {
  try {
    const q = String(req.query.q || "").toLowerCase().trim();
    if (!q) {
      return res.json({ success: true, data: {
        available: Object.keys(DREAM_TO_NUMBERS).sort()
      }});
    }
    const matches = Object.entries(DREAM_TO_NUMBERS)
      .filter(([k]) => k.includes(q))
      .map(([k,v]) => ({ dream: k, numbers: v.numbers, note: v.note }));
    res.json({ success: true, data: { query: q, results: matches }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Mon vs Thu comparison (TOTO draws on different days) ───────────
app.get("/api/toto/dow-comparison", (req, res) => {
  try {
    const rows = db.prepare(
      "SELECT draw_date, num1, num2, num3, num4, num5, num6 FROM toto_draws " +
      "WHERE draw_date >= '2014-10-09' AND num6 IS NOT NULL"
    ).all();
    const monFreq = {}, thuFreq = {};
    let monCount = 0, thuCount = 0;
    for (let n = 1; n <= 49; n++) { monFreq[n] = 0; thuFreq[n] = 0; }
    for (const r of rows) {
      const dow = new Date(r.draw_date).getUTCDay();   // 1=Mon, 4=Thu
      const target = dow === 1 ? monFreq : (dow === 4 ? thuFreq : null);
      if (!target) continue;
      if (dow === 1) monCount++; else thuCount++;
      for (const k of [r.num1, r.num2, r.num3, r.num4, r.num5, r.num6]) target[k]++;
    }
    const sort = obj => Object.entries(obj).map(([k,c]) => ({n:+k, c}))
      .sort((a,b) => b.c - a.c);
    res.json({ success: true, data: {
      monday: { draws: monCount, hot: sort(monFreq).slice(0,5), cold: sort(monFreq).slice(-5).reverse() },
      thursday: { draws: thuCount, hot: sort(thuFreq).slice(0,5), cold: sort(thuFreq).slice(-5).reverse() },
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Additional Number stats (the +7th number) ──────────────────────
app.get("/api/toto/additional", (req, res) => {
  try {
    const rows = db.prepare(
      "SELECT num1, num2, num3, num4, num5, num6, additional_num FROM toto_draws " +
      "WHERE draw_date >= '2014-10-09' AND num6 IS NOT NULL AND additional_num IS NOT NULL"
    ).all();
    const addFreq = {};
    const partners = {};       // count of times each main number co-appeared with each additional
    for (let n = 1; n <= 49; n++) { addFreq[n] = 0; partners[n] = 0; }
    for (const r of rows) {
      addFreq[r.additional_num]++;
      for (const k of [r.num1, r.num2, r.num3, r.num4, r.num5, r.num6]) partners[k]++;
    }
    const sortedAdd = Object.entries(addFreq).map(([k,c]) => ({n:+k, c}))
      .sort((a,b) => b.c - a.c);
    res.json({ success: true, data: {
      total_draws: rows.length,
      hot:  sortedAdd.slice(0, 6),
      cold: sortedAdd.slice(-6).reverse(),
      avg_per_number: Math.round(rows.length / 49 * 10) / 10,
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Hot Streak — single hottest in last N draws ────────────────────
app.get("/api/toto/hot-streak", (req, res) => {
  try {
    const n = Math.min(parseInt(req.query.n) || 10, 100);
    const rows = db.prepare(
      "SELECT num1, num2, num3, num4, num5, num6 FROM toto_draws " +
      "WHERE draw_date >= '2014-10-09' AND num6 IS NOT NULL " +
      "ORDER BY draw_no DESC LIMIT ?"
    ).all(n);
    const freq = {};
    for (let k = 1; k <= 49; k++) freq[k] = 0;
    for (const r of rows) {
      for (const k of [r.num1, r.num2, r.num3, r.num4, r.num5, r.num6]) freq[k]++;
    }
    const sorted = Object.entries(freq).map(([k,c]) => ({n:+k, c}))
      .sort((a,b) => b.c - a.c);
    res.json({ success: true, data: {
      window: n,
      hottest: sorted.slice(0, 5),
      coldest_not_seen: sorted.filter(x => x.c === 0).slice(0, 10),
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Date Pattern — number frequency for a specific MM-DD across years ─
// Research / experimental. Sample size is small (Singapore TOTO ≈ 2 draws/week,
// so ~2 hits per MM-DD per year × 12 years ≈ 24 draws max). Honest caveat
// surfaced in the UI: small sample, statistically meaningless.
app.get("/api/toto/date-pattern", (req, res) => {
  try {
    const md = String(req.query.month_day || "").trim();
    if (!/^\d{2}-\d{2}$/.test(md)) {
      return res.status(400).json({ success: false, error: "Provide ?month_day=MM-DD" });
    }
    const rows = db.prepare(
      "SELECT num1, num2, num3, num4, num5, num6 FROM toto_draws " +
      "WHERE draw_date >= '2014-10-09' AND num6 IS NOT NULL " +
      "AND substr(draw_date, 6) = ?"
    ).all(md);

    const freq = {}; for (let n = 1; n <= 49; n++) freq[n] = 0;
    for (const r of rows) {
      for (const k of [r.num1, r.num2, r.num3, r.num4, r.num5, r.num6]) freq[k]++;
    }
    const sorted = Object.entries(freq).map(([k, c]) => ({ number: parseInt(k), count: c }))
      .sort((a, b) => b.count - a.count);
    res.json({
      success: true,
      data: {
        month_day: md,
        draws_on_date: rows.length,
        top_numbers:    sorted.slice(0, 6),
        bottom_numbers: sorted.slice(-6).reverse(),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Number Deep Dive — comprehensive per-number stats ──────────────
app.get("/api/toto/number-detail", (req, res) => {
  try {
    const n = parseInt(req.query.n, 10);
    if (!Number.isInteger(n) || n < 1 || n > 49) {
      return res.status(400).json({ success: false, error: "?n=NUMBER (1-49)" });
    }
    const rows = db.prepare(
      "SELECT draw_no, draw_date, num1, num2, num3, num4, num5, num6 FROM toto_draws " +
      "WHERE draw_date >= '2014-10-09' AND num6 IS NOT NULL " +
      "ORDER BY draw_no ASC"
    ).all();

    let lastIdx = -1, longestGap = 0;
    const gaps = [];
    let firstDraw = null, lastDraw = null;
    const byMonth = {}, byDow = {}, byYear = {};
    const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const dowNames   = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

    rows.forEach((r, idx) => {
      const has = [r.num1, r.num2, r.num3, r.num4, r.num5, r.num6].includes(n);
      if (!has) return;
      if (firstDraw === null) firstDraw = r;
      lastDraw = r;
      if (lastIdx >= 0) {
        const gap = idx - lastIdx;
        gaps.push(gap);
        if (gap > longestGap) longestGap = gap;
      }
      lastIdx = idx;
      const dt = new Date(r.draw_date);
      const m = dt.getUTCMonth(), w = dt.getUTCDay(), y = dt.getUTCFullYear();
      byMonth[m] = (byMonth[m] || 0) + 1;
      byDow[w]   = (byDow[w]   || 0) + 1;
      byYear[y]  = (byYear[y]  || 0) + 1;
    });
    const appearances = gaps.length + (lastIdx >= 0 ? 1 : 0);
    const avgGap = gaps.length ? gaps.reduce((a,b)=>a+b,0) / gaps.length : null;
    const currentGap = lastIdx >= 0 ? rows.length - 1 - lastIdx : rows.length;

    const sortedMonths = Object.entries(byMonth).sort((a,b) => b[1] - a[1]);
    const sortedDows   = Object.entries(byDow).sort((a,b) => b[1] - a[1]);

    res.json({
      success: true,
      data: {
        number: n,
        total_draws_scanned: rows.length,
        appearances,
        first_appearance: firstDraw ? { draw_no: firstDraw.draw_no, draw_date: firstDraw.draw_date } : null,
        last_appearance:  lastDraw  ? { draw_no: lastDraw.draw_no,  draw_date: lastDraw.draw_date  } : null,
        avg_gap: avgGap !== null ? Math.round(avgGap * 10) / 10 : null,
        current_gap: currentGap,
        longest_gap: longestGap,
        best_month: sortedMonths[0] ? { name: monthNames[+sortedMonths[0][0]], count: sortedMonths[0][1] } : null,
        best_dow:   sortedDows[0]   ? { name: dowNames[+sortedDows[0][0]],     count: sortedDows[0][1]   } : null,
        by_year: Object.entries(byYear).map(([y, c]) => ({ year: +y, count: c })).sort((a,b) => a.year - b.year),
        by_month: monthNames.map((m, i) => ({ month: m, count: byMonth[i] || 0 })),
        by_dow:   dowNames.map((d, i) => ({ day: d, count: byDow[i] || 0 })),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Combination Shape stats — what does a typical winning draw look like? ─
app.get("/api/toto/shape-stats", (req, res) => {
  try {
    const rows = db.prepare(
      "SELECT num1, num2, num3, num4, num5, num6 FROM toto_draws " +
      "WHERE draw_date >= '2014-10-09' AND num6 IS NOT NULL " +
      "ORDER BY draw_no ASC"
    ).all();

    const decadeCount = [0, 0, 0, 0, 0];
    let consecutiveDraws = 0, repeatPrevDraws = 0, allEvenDraws = 0, allOddDraws = 0;
    let lowTotal = 0, highTotal = 0;
    const ranges = [];
    let prevSet = null;

    rows.forEach(r => {
      const nums = [r.num1, r.num2, r.num3, r.num4, r.num5, r.num6].sort((a,b) => a-b);
      const set = new Set(nums);

      // Decade counts + low/high
      nums.forEach(num => {
        if      (num <= 10) decadeCount[0]++;
        else if (num <= 20) decadeCount[1]++;
        else if (num <= 30) decadeCount[2]++;
        else if (num <= 40) decadeCount[3]++;
        else               decadeCount[4]++;
        if (num <= 25) lowTotal++; else highTotal++;
      });

      // Has any consecutive pair?
      let hasConsec = false;
      for (let i = 0; i < nums.length - 1; i++) {
        if (nums[i+1] === nums[i] + 1) { hasConsec = true; break; }
      }
      if (hasConsec) consecutiveDraws++;

      // Shares ≥1 number with previous draw?
      if (prevSet) {
        for (const v of set) if (prevSet.has(v)) { repeatPrevDraws++; break; }
      }
      prevSet = set;

      const evens = nums.filter(v => v % 2 === 0).length;
      if (evens === nums.length) allEvenDraws++;
      else if (evens === 0)      allOddDraws++;

      ranges.push(Math.max(...nums) - Math.min(...nums));
    });

    const total = rows.length;
    const sortedRanges = [...ranges].sort((a,b) => a-b);
    res.json({
      success: true,
      data: {
        total_draws_scanned: total,
        decade_distribution: ["1-10","11-20","21-30","31-40","41-49"].map((r, i) => ({
          range: r, total: decadeCount[i],
          avg_per_draw: Math.round(decadeCount[i]/total * 100) / 100,
        })),
        consecutive: {
          count: consecutiveDraws,
          pct: Math.round(consecutiveDraws/total*1000)/10,
        },
        repeat_from_previous: {
          count: repeatPrevDraws,
          pct: Math.round(repeatPrevDraws/(total-1)*1000)/10,
        },
        all_even: {
          count: allEvenDraws,
          pct: Math.round(allEvenDraws/total*1000)/10,
        },
        all_odd: {
          count: allOddDraws,
          pct: Math.round(allOddDraws/total*1000)/10,
        },
        low_high: {
          low_total: lowTotal,
          high_total: highTotal,
          low_pct:  Math.round(lowTotal/(lowTotal+highTotal)*1000)/10,
          high_pct: Math.round(highTotal/(lowTotal+highTotal)*1000)/10,
        },
        range_stats: {
          avg:    Math.round(ranges.reduce((a,b)=>a+b,0)/total * 10) / 10,
          median: sortedRanges[Math.floor(sortedRanges.length / 2)],
          min:    sortedRanges[0],
          max:    sortedRanges[sortedRanges.length - 1],
        },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Recent N draws hot/cold ────────────────────────────────────────
app.get("/api/toto/recent", (req, res) => {
  try {
    const window = Math.min(parseInt(req.query.window) || 50, 500);
    const rows = db.prepare(
      "SELECT num1, num2, num3, num4, num5, num6 FROM toto_draws " +
      "WHERE draw_date >= '2014-10-09' AND num6 IS NOT NULL " +
      "ORDER BY draw_no DESC LIMIT ?"
    ).all(window);
    const freq = {}; for (let n = 1; n <= 49; n++) freq[n] = 0;
    for (const r of rows) {
      for (const k of [r.num1, r.num2, r.num3, r.num4, r.num5, r.num6]) freq[k]++;
    }
    const sorted = Object.entries(freq).map(([n,c]) => ({ number: parseInt(n), count: c }))
      .sort((a,b) => b.count - a.count);
    res.json({ success: true, data: {
      window, total_draws_scanned: rows.length,
      hot: sorted.slice(0, 6),
      cold: sorted.slice(-6).reverse(),
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Per-number gap stats (avg gap, current gap, longest gap, last appearance) ─
app.get("/api/toto/gaps", (req, res) => {
  try {
    const rows = db.prepare(
      "SELECT draw_no, draw_date, num1, num2, num3, num4, num5, num6 FROM toto_draws " +
      "WHERE draw_date >= '2014-10-09' AND num6 IS NOT NULL " +
      "ORDER BY draw_no ASC"
    ).all();
    const lastIdx = {};        // index of last appearance
    const lastDraw = {};       // last draw object
    const gapHist = {};        // history of gaps per number
    for (let n = 1; n <= 49; n++) { lastIdx[n] = -1; gapHist[n] = []; }

    rows.forEach((r, idx) => {
      const set = new Set([r.num1, r.num2, r.num3, r.num4, r.num5, r.num6]);
      for (const n of set) {
        if (lastIdx[n] >= 0) gapHist[n].push(idx - lastIdx[n]);
        lastIdx[n] = idx;
        lastDraw[n] = { draw_no: r.draw_no, draw_date: r.draw_date };
      }
    });

    const totalDraws = rows.length;
    const out = [];
    for (let n = 1; n <= 49; n++) {
      const gaps = gapHist[n];
      const avgGap = gaps.length ? gaps.reduce((a,b)=>a+b,0) / gaps.length : null;
      const longestGap = gaps.length ? Math.max(...gaps) : null;
      const currentGap = lastIdx[n] >= 0 ? totalDraws - 1 - lastIdx[n] : totalDraws;
      out.push({
        number: n,
        appearances: gaps.length + (lastIdx[n] >= 0 ? 1 : 0),
        avg_gap: avgGap !== null ? Math.round(avgGap * 10) / 10 : null,
        longest_gap: longestGap,
        current_gap: currentGap,
        last_drawn: lastDraw[n] || null,
      });
    }
    // Find the overall cold-streak record holder
    const recordHolder = out.reduce((best, x) =>
      (x.longest_gap > (best?.longest_gap || 0)) ? x : best, null);
    res.json({ success: true, data: {
      total_draws_scanned: totalDraws,
      per_number: out,
      cold_streak_record: recordHolder,
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Year-by-year hottest number ────────────────────────────────────
app.get("/api/toto/yearly-hot", (req, res) => {
  try {
    const rows = db.prepare(
      "SELECT draw_date, num1, num2, num3, num4, num5, num6 FROM toto_draws " +
      "WHERE draw_date >= '2014-10-09' AND num6 IS NOT NULL"
    ).all();
    const byYear = {};
    for (const r of rows) {
      const year = new Date(r.draw_date).getUTCFullYear();
      if (!byYear[year]) { byYear[year] = { year, freq: {}, draws: 0 }; for (let k = 1; k <= 49; k++) byYear[year].freq[k] = 0; }
      byYear[year].draws++;
      for (const n of [r.num1, r.num2, r.num3, r.num4, r.num5, r.num6]) byYear[year].freq[n]++;
    }
    const years = Object.values(byYear).map(y => {
      const sorted = Object.entries(y.freq).map(([k,c]) => ({n: parseInt(k), c})).sort((a,b) => b.c - a.c);
      return {
        year: y.year,
        draws: y.draws,
        hottest: sorted[0],
        coldest: sorted[sorted.length - 1],
      };
    }).sort((a,b) => b.year - a.year);
    res.json({ success: true, data: { years } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Birthday range stats (1-31 vs 32-49) ───────────────────────────
app.get("/api/toto/birthday-stats", (req, res) => {
  try {
    const rows = db.prepare(
      "SELECT num1, num2, num3, num4, num5, num6 FROM toto_draws " +
      "WHERE draw_date >= '2014-10-09' AND num6 IS NOT NULL"
    ).all();
    let lower = 0, upper = 0;
    const freq = {};
    for (let n = 1; n <= 49; n++) freq[n] = 0;
    for (const r of rows) {
      for (const k of [r.num1, r.num2, r.num3, r.num4, r.num5, r.num6]) {
        freq[k]++;
        if (k <= 31) lower++; else upper++;
      }
    }
    const total = lower + upper;
    const lowerSlots = 31, upperSlots = 18;
    res.json({ success: true, data: {
      total_numbers_drawn: total,
      lower_range: { start: 1, end: 31, slot_count: lowerSlots, total_appearances: lower,
                     pct: Math.round(lower/total*1000)/10,
                     avg_per_number: Math.round(lower/lowerSlots*10)/10 },
      upper_range: { start: 32, end: 49, slot_count: upperSlots, total_appearances: upper,
                     pct: Math.round(upper/total*1000)/10,
                     avg_per_number: Math.round(upper/upperSlots*10)/10 },
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Special Draws — TOTO non-Mon/Thu and 4D non-Wed/Sat/Sun ─────────
// These are typically CNY Hongbao, National Day, Christmas/NY shifts, etc.
function tagSpecial(dateStr) {
  // Heuristic: tag what KIND of special draw based on date proximity to known events
  const d = new Date(dateStr);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const tags = [];
  // National Day (Aug 9) — draws on Aug 8 / 7 are NDP-eve specials
  if (m === 8 && day >= 6 && day <= 10) tags.push("National Day");
  // Christmas / New Year window
  if ((m === 12 && day >= 22) || (m === 1 && day <= 5)) tags.push("Year-end / New Year");
  // CNY window — Jan late or Feb (lunar varies). Use lunar-javascript to be precise.
  try {
    const solar = Solar.fromYmd(y, m, day);
    const lunar = solar.getLunar();
    // CNY = lunar Jan 1. Most SG Pools "Hongbao TOTO" draws happen 1–3 weeks
    // after CNY day (lunar 1/9–1/20), or 1 week before (lunar 12/22+).
    if (lunar.getMonth() === 1 && lunar.getDay() <= 20) tags.push("Chinese New Year");
    if (lunar.getMonth() === 12 && lunar.getDay() >= 18) tags.push("Chinese New Year");
    // Mid-Autumn = lunar 8/15. Window 8/1–8/20 catches the actual 4 historical
    // Mid-Autumn TOTO draws (2006, 2007, 2009, 2011); none after 2011.
    if (lunar.getMonth() === 8 && lunar.getDay() >= 1 && lunar.getDay() <= 20) tags.push("Mid-Autumn");
  } catch (e) {}
  // Hari Raya etc. — would need full Islamic calendar, skip
  return tags;
}

// ─── Festival Index — picks the ONE closest draw per (year, festival) ──
// Avoids double-tagging when a pre-CNY Hongbao + post-CNY cascade both
// fall in the window. Falls back to closest regular Mon/Thu draw if no
// special draw exists that year (so e.g. Mid-Autumn weeks still get a
// representative draw even after Singapore Pools stopped Mid-Autumn TOTO).
let _festivalIndex = null;
function getFestivalIndex() {
  if (_festivalIndex) return _festivalIndex;
  const rows = db.prepare(
    "SELECT draw_date FROM toto_draws WHERE draw_date IS NOT NULL AND num6 IS NOT NULL"
  ).all();
  const candidates = {};   // "Festival-Year" → { date, distance }
  function pick(key, date, distance) {
    if (!candidates[key] || candidates[key].distance > distance) {
      candidates[key] = { date, distance };
    }
  }
  for (const r of rows) {
    const [y, m, d] = r.draw_date.split("-").map(Number);
    const jsDate = new Date(r.draw_date);
    try {
      const sol = Solar.fromYmd(y, m, d);
      const lun = sol.getLunar();
      const ly = lun.getYear();
      // CNY anchor = lunar 1/1
      try {
        const cny = Lunar.fromYmd(ly, 1, 1).getSolar();
        const cnyDate = new Date(`${cny.getYear()}-${String(cny.getMonth()).padStart(2,"0")}-${String(cny.getDay()).padStart(2,"0")}`);
        const dist = Math.abs(jsDate - cnyDate) / 86400000;
        if (dist <= 30) pick(`Chinese New Year|${ly}`, r.draw_date, dist);
      } catch {}
      // Mid-Autumn anchor = lunar 8/15
      try {
        const ma = Lunar.fromYmd(ly, 8, 15).getSolar();
        const maDate = new Date(`${ma.getYear()}-${String(ma.getMonth()).padStart(2,"0")}-${String(ma.getDay()).padStart(2,"0")}`);
        const dist = Math.abs(jsDate - maDate) / 86400000;
        if (dist <= 14) pick(`Mid-Autumn|${ly}`, r.draw_date, dist);
      } catch {}
    } catch {}
    // National Day = solar Aug 9
    if (m === 8 || m === 7) {
      const nd = new Date(`${y}-08-09`);
      const dist = Math.abs(jsDate - nd) / 86400000;
      if (dist <= 5) pick(`National Day|${y}`, r.draw_date, dist);
    }
    // Year-end / New Year = solar Dec 31. A Jan draw counts toward the prior year.
    if (m === 12) {
      const ye = new Date(`${y}-12-31`);
      const dist = Math.abs(jsDate - ye) / 86400000;
      if (dist <= 10) pick(`Year-end / New Year|${y}`, r.draw_date, dist);
    }
    if (m === 1 && d <= 10) {
      const ye = new Date(`${y - 1}-12-31`);
      const dist = Math.abs(jsDate - ye) / 86400000;
      if (dist <= 10) pick(`Year-end / New Year|${y - 1}`, r.draw_date, dist);
    }
  }
  // Flatten: date → Set<festival>
  const dateMap = new Map();
  Object.entries(candidates).forEach(([k, v]) => {
    const fest = k.split("|")[0];
    if (!dateMap.has(v.date)) dateMap.set(v.date, new Set());
    dateMap.get(v.date).add(fest);
  });
  _festivalIndex = dateMap;
  return dateMap;
}

function festivalTagsFor(date) {
  const idx = getFestivalIndex();
  const set = idx.get(date);
  return set ? Array.from(set) : [];
}
app.get("/api/toto/special-draws", (req, res) => {
  try {
    const rows = db.prepare(
      "SELECT draw_no, draw_date, num1, num2, num3, num4, num5, num6, additional_num " +
      "FROM toto_draws WHERE draw_date IS NOT NULL AND num6 IS NOT NULL ORDER BY draw_no DESC"
    ).all();
    const dows = {0:'Sun',1:'Mon',2:'Tue',3:'Wed',4:'Thu',5:'Fri',6:'Sat'};
    const special = rows.filter(r => {
      const dow = new Date(r.draw_date).getUTCDay();
      return dow !== 1 && dow !== 4;     // regular TOTO = Mon, Thu
    }).map(r => {
      const t = tagSpecial(r.draw_date);
      return {
        draw_no: r.draw_no,
        draw_date: r.draw_date,
        dow: dows[new Date(r.draw_date).getUTCDay()],
        numbers: [r.num1, r.num2, r.num3, r.num4, r.num5, r.num6],
        additional_num: r.additional_num,
        tags: t.length ? t : ["Snowball / Cascade"],   // fallback only here
      };
    });
    res.json({ success: true, data: { total: special.length, draws: special }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Festival-only TOTO stats — filter draws by tag, return hot/cold ────
app.get("/api/toto/festival-stats", (req, res) => {
  try {
    const tag = req.query.tag || "Chinese New Year";
    const rows = db.prepare(
      "SELECT draw_no, draw_date, num1, num2, num3, num4, num5, num6, additional_num " +
      "FROM toto_draws WHERE draw_date IS NOT NULL AND num6 IS NOT NULL ORDER BY draw_no ASC"
    ).all();
    // Festival analysis = SPECIAL-draws only (non-Mon/Thu). Mon/Thu that
    // happen to fall during CNY week are still "regular" TOTO and excluded.
    const specials = rows.filter(r => {
      const dow = new Date(r.draw_date).getUTCDay();
      return dow !== 1 && dow !== 4;
    });
    let filtered;
    if (tag === "All Special") {
      filtered = specials;
    } else {
      filtered = specials.filter(r => tagSpecial(r.draw_date).includes(tag));
    }
    // Tally main-number counts (1..49) over filtered subset
    const counts = new Array(50).fill(0);
    const addCounts = new Array(50).fill(0);
    const sums = [];
    let evenCount = 0, oddCount = 0;
    filtered.forEach(r => {
      const nums = [r.num1, r.num2, r.num3, r.num4, r.num5, r.num6];
      nums.forEach(n => {
        counts[n]++;
        if (n % 2 === 0) evenCount++; else oddCount++;
      });
      if (r.additional_num) addCounts[r.additional_num]++;
      sums.push(nums.reduce((a,b)=>a+b,0));
    });
    const ranked = [];
    for (let n = 1; n <= 49; n++) ranked.push({ n, c: counts[n] });
    ranked.sort((a,b) => b.c - a.c || a.n - b.n);
    const addRanked = [];
    for (let n = 1; n <= 49; n++) addRanked.push({ n, c: addCounts[n] });
    addRanked.sort((a,b) => b.c - a.c || a.n - b.n);
    const sumAvg = sums.length ? Math.round(sums.reduce((a,b)=>a+b,0) / sums.length) : 0;
    const sumMin = sums.length ? Math.min.apply(null, sums) : 0;
    const sumMax = sums.length ? Math.max.apply(null, sums) : 0;
    res.json({
      success: true,
      data: {
        tag,
        total_draws: filtered.length,
        hot: ranked.slice(0, 6),
        cold: ranked.slice(-6).reverse(),     // lowest counts first
        never: ranked.filter(x => x.c === 0).map(x => x.n),
        additional_hot: addRanked.slice(0, 6),
        additional_never: addRanked.filter(x => x.c === 0).map(x => x.n),
        even_pct: (evenCount + oddCount) ? Math.round(evenCount / (evenCount + oddCount) * 100) : 0,
        odd_pct: (evenCount + oddCount) ? Math.round(oddCount / (evenCount + oddCount) * 100) : 0,
        sum_avg: sumAvg, sum_min: sumMin, sum_max: sumMax,
        latest_date: filtered.length ? filtered[filtered.length-1].draw_date : null,
        earliest_date: filtered.length ? filtered[0].draw_date : null,
      },
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/api/fourd/special-draws", (req, res) => {
  try {
    const rows = db.prepare(
      "SELECT draw_no, draw_date, first_prize, second_prize, third_prize " +
      "FROM fourd_draws WHERE draw_date IS NOT NULL ORDER BY draw_no DESC"
    ).all();
    const dows = {0:'Sun',1:'Mon',2:'Tue',3:'Wed',4:'Thu',5:'Fri',6:'Sat'};
    const special = rows.filter(r => {
      const dow = new Date(r.draw_date).getUTCDay();
      return dow !== 0 && dow !== 3 && dow !== 6;   // regular 4D = Sun, Wed, Sat
    }).map(r => ({
      ...r,
      dow: dows[new Date(r.draw_date).getUTCDay()],
      tags: tagSpecial(r.draw_date),
    }));
    res.json({ success: true, data: { total: special.length, draws: special }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── 4D digit-position heatmap (frequency per position × digit) ─────
app.get("/api/fourd/digit-positions", (req, res) => {
  try {
    const rows = db.prepare("SELECT first_prize, second_prize, third_prize FROM fourd_draws").all();
    const total = rows.length * 3;       // 3 prize tiers × N draws
    const matrix = [];                   // [position][digit]
    for (let pos = 0; pos < 4; pos++) {
      matrix.push(Array(10).fill(0));
    }
    for (const r of rows) {
      for (const prize of [r.first_prize, r.second_prize, r.third_prize]) {
        if (!prize) continue;
        for (let pos = 0; pos < 4; pos++) {
          matrix[pos][parseInt(prize[pos], 10)]++;
        }
      }
    }
    res.json({ success: true, data: {
      total_numbers_scanned: rows.length * 3,
      matrix,                              // [position 0-3][digit 0-9]
      expected_per_cell: Math.round(total / 10),
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── 4D digit-class % per year (quad/triple/double/none) ─────────────
// Scans ALL 23 prize positions (1st + 2nd + 3rd + 10 starter + 10 consolation)
// per draw, not just the 1st prize. This gives a real "is digit 3 trending"
// signal because there are 23 numbers/draw × 4 digits = 92 digits to sample.
app.get("/api/fourd/class-by-year", cache.withCache((req, res) => {
  try {
    const rows = db.prepare(
      "SELECT draw_date, first_prize, second_prize, third_prize, starter_prizes, consolation_prizes FROM fourd_draws WHERE draw_date IS NOT NULL"
    ).all();
    const byYear = {};
    function digitClass(s) {
      const c = {};
      for (const ch of s) c[ch] = (c[ch] || 0) + 1;
      const mx = Math.max(...Object.values(c));
      return mx === 4 ? "quad" : mx === 3 ? "triple" : mx === 2 ? "double" : "none";
    }
    for (const r of rows) {
      const year = new Date(r.draw_date).getUTCFullYear();
      if (!byYear[year]) byYear[year] = {
        year, quad: 0, triple: 0, double: 0, none: 0,
        total_draws: 0,
        total_prizes: 0,          // 23 × draws
        total_digits: 0,          // 92 × draws (4 digits × 23 prizes)
        digitFreq: {},            // digit 0-9 → count across ALL prize digits
        doubledDigit: {},         // digit → # of prizes where it doubles
        tripledDigit: {},
        quadDigit: {},
      };
      const Y = byYear[year];
      Y.total_draws++;
      // Gather all 23 prize numbers
      const prizes = [r.first_prize, r.second_prize, r.third_prize];
      try { prizes.push(...JSON.parse(r.starter_prizes || "[]")); } catch {}
      try { prizes.push(...JSON.parse(r.consolation_prizes || "[]")); } catch {}
      for (const p of prizes) {
        if (!p) continue;
        const s = String(p).padStart(4, "0");
        Y[digitClass(s)]++;
        Y.total_prizes++;
        for (const ch of s) {
          Y.digitFreq[ch] = (Y.digitFreq[ch] || 0) + 1;
          Y.total_digits++;
        }
        const counts = {};
        for (const ch of s) counts[ch] = (counts[ch] || 0) + 1;
        Object.entries(counts).forEach(([dig, c]) => {
          if (c === 2) Y.doubledDigit[dig] = (Y.doubledDigit[dig] || 0) + 1;
          if (c === 3) Y.tripledDigit[dig] = (Y.tripledDigit[dig] || 0) + 1;
          if (c === 4) Y.quadDigit[dig] = (Y.quadDigit[dig] || 0) + 1;
        });
      }
    }
    function digitPctMap(counts, denom, places) {
      const p = places == null ? 2 : places;
      const m = {};
      for (let d = 0; d <= 9; d++) {
        const c = counts[String(d)] || 0;
        // Return real percentage (e.g. 10.03 not 0.1003)
        const pct = denom > 0 ? c / denom * 100 : 0;
        m[String(d)] = { count: c, pct: Math.round(pct * Math.pow(10, p)) / Math.pow(10, p) };
      }
      return m;
    }
    const years = Object.values(byYear).sort((a,b) => a.year - b.year).map(y => ({
      year: y.year,
      total_draws: y.total_draws,
      total_prizes: y.total_prizes,            // 23 × draws
      total_digits: y.total_digits,            // 92 × draws
      quad_pct:   Math.round(y.quad   / y.total_prizes * 1000) / 10,
      triple_pct: Math.round(y.triple / y.total_prizes * 1000) / 10,
      double_pct: Math.round(y.double / y.total_prizes * 1000) / 10,
      none_pct:   Math.round(y.none   / y.total_prizes * 1000) / 10,
      // % of all prize digits that are 0, 1, 2 … 9 — expected ~10% each if random
      digit_pct:   digitPctMap(y.digitFreq,     y.total_digits, 2),
      // % of prize numbers (out of 23/draw) where that digit doubles (xx_ _)
      double_pct_per_digit: digitPctMap(y.doubledDigit, y.total_prizes, 2),
      triple_pct_per_digit: digitPctMap(y.tripledDigit, y.total_prizes, 2),
      quad_pct_per_digit:   digitPctMap(y.quadDigit,    y.total_prizes, 3),
    }));
    // Aggregate overall across all years
    const overall = { total_draws: 0, total_prizes: 0, total_digits: 0,
      quad: 0, triple: 0, double: 0, none: 0,
      digitFreq: {}, doubledDigit: {}, tripledDigit: {}, quadDigit: {} };
    Object.values(byYear).forEach(y => {
      overall.total_draws += y.total_draws;
      overall.total_prizes += y.total_prizes;
      overall.total_digits += y.total_digits;
      overall.quad += y.quad; overall.triple += y.triple; overall.double += y.double; overall.none += y.none;
      Object.entries(y.digitFreq).forEach(([k,v]) => overall.digitFreq[k] = (overall.digitFreq[k]||0)+v);
      Object.entries(y.doubledDigit).forEach(([k,v]) => overall.doubledDigit[k] = (overall.doubledDigit[k]||0)+v);
      Object.entries(y.tripledDigit).forEach(([k,v]) => overall.tripledDigit[k] = (overall.tripledDigit[k]||0)+v);
      Object.entries(y.quadDigit).forEach(([k,v]) => overall.quadDigit[k] = (overall.quadDigit[k]||0)+v);
    });
    const overallSummary = {
      total_draws: overall.total_draws,
      total_prizes: overall.total_prizes,
      total_digits: overall.total_digits,
      year_range: { from: years.length ? years[0].year : null, to: years.length ? years[years.length-1].year : null },
      none_pct:   Math.round(overall.none   / overall.total_prizes * 1000) / 10,
      double_pct: Math.round(overall.double / overall.total_prizes * 1000) / 10,
      triple_pct: Math.round(overall.triple / overall.total_prizes * 1000) / 10,
      quad_pct:   Math.round(overall.quad   / overall.total_prizes * 1000) / 10,
      digit_pct:            digitPctMap(overall.digitFreq,     overall.total_digits, 2),
      double_pct_per_digit: digitPctMap(overall.doubledDigit, overall.total_prizes, 2),
      triple_pct_per_digit: digitPctMap(overall.tripledDigit, overall.total_prizes, 3),
      quad_pct_per_digit:   digitPctMap(overall.quadDigit,    overall.total_prizes, 4),
    };
    res.json({ success: true, data: { overall: overallSummary, years } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
}));

// ─── 4D palindromes (1221, 4334, etc.) ──────────────────────────────
app.get("/api/fourd/palindromes", cache.withCache((req, res) => {
  try {
    const rows = db.prepare(
      "SELECT draw_no, draw_date, first_prize, second_prize, third_prize FROM fourd_draws"
    ).all();
    const isPalindrome = s => s[0] === s[3] && s[1] === s[2];
    let firstHits = [], secondHits = [], thirdHits = [];
    for (const r of rows) {
      if (isPalindrome(r.first_prize))  firstHits.push({ draw_no: r.draw_no, draw_date: r.draw_date, number: r.first_prize });
      if (isPalindrome(r.second_prize)) secondHits.push({ draw_no: r.draw_no, draw_date: r.draw_date, number: r.second_prize });
      if (isPalindrome(r.third_prize))  thirdHits.push({ draw_no: r.draw_no, draw_date: r.draw_date, number: r.third_prize });
    }
    res.json({ success: true, data: {
      total_draws_scanned: rows.length,
      first_prize:  { count: firstHits.length,  pct: Math.round(firstHits.length/rows.length*1000)/10,  recent: firstHits.slice(-5).reverse() },
      second_prize: { count: secondHits.length, pct: Math.round(secondHits.length/rows.length*1000)/10, recent: secondHits.slice(-5).reverse() },
      third_prize:  { count: thirdHits.length,  pct: Math.round(thirdHits.length/rows.length*1000)/10,  recent: thirdHits.slice(-5).reverse() },
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
}));

// ─── 4D repeat winners (numbers that won 1st prize >1 time) ─────────
// ─── Dry-Spell Distribution Analyzer ──────────────────────────────────
// For every gap-bucket: hazard rate (P(hit | still dry)), average payout,
// per-bucket ROI if you only bet in that bucket. Reveals which gap ranges
// are profitable to bet — the bucket where most numbers "turn into winners".
app.get("/api/fourd/dry-distribution", cache.withCache((req, res) => {
  try {
    const PAY = { first: 2000, second: 1000, third: 490, starter: 250, consol: 60 };
    const HOUSE_EDGE_PCT = 34.1;
    const bucketSize = parseInt(req.query.bucket || "100", 10);
    const rows = db.prepare(
      "SELECT first_prize, second_prize, third_prize, starter_prizes, consolation_prizes FROM fourd_draws ORDER BY draw_date ASC, draw_no ASC"
    ).all();
    const totalDraws = rows.length;
    const numHistory = {};
    rows.forEach((r, idx) => {
      function add(num, tier) {
        if (num == null) return;
        const k = String(num).padStart(4, "0");
        if (!numHistory[k]) numHistory[k] = [];
        numHistory[k].push({ idx, tier });
      }
      add(r.first_prize, "first"); add(r.second_prize, "second"); add(r.third_prize, "third");
      try { JSON.parse(r.starter_prizes || "[]").forEach(p => add(p, "starter")); } catch {}
      try { JSON.parse(r.consolation_prizes || "[]").forEach(p => add(p, "consol")); } catch {}
    });
    // Collect ALL gaps after first top-3 hit (top-3 qualifying universe)
    const allGaps = [];
    for (const k of Object.keys(numHistory)) {
      const hits = numHistory[k];
      const ft3 = hits.findIndex(h => h.tier === "first" || h.tier === "second" || h.tier === "third");
      if (ft3 < 0) continue;
      for (let i = ft3 + 1; i < hits.length; i++) {
        allGaps.push({ length: hits[i].idx - hits[i-1].idx, tier: hits[i].tier, num: k });
      }
    }
    // Bucket analysis
    const maxLen = Math.max(...allGaps.map(g => g.length));
    const buckets = [];
    for (let b = 0; b < maxLen; b += bucketSize) {
      const bEnd = b + bucketSize;
      const hitsInBucket = allGaps.filter(g => g.length >= b && g.length < bEnd);
      const survivorsPast = allGaps.filter(g => g.length >= bEnd).length;
      const totalAtRisk = hitsInBucket.length + survivorsPast;
      if (totalAtRisk === 0) continue;
      let revenue = 0, cost = 0;
      const tb = { first:0,second:0,third:0,starter:0,consol:0 };
      for (const g of hitsInBucket) {
        revenue += PAY[g.tier];
        cost += g.length - b + 1;
        tb[g.tier]++;
      }
      cost += survivorsPast * bucketSize;
      const profit = revenue - cost;
      const roi = cost > 0 ? +((profit / cost) * 100).toFixed(1) : 0;
      buckets.push({
        bucket_start: b,
        bucket_end: bEnd,
        hits: hitsInBucket.length,
        survivors_past: survivorsPast,
        hazard_rate_pct: +((hitsInBucket.length / totalAtRisk) * 100).toFixed(2),
        total_cost: cost,
        total_revenue: revenue,
        profit, roi,
        avg_payout: hitsInBucket.length > 0 ? Math.round(revenue / hitsInBucket.length) : 0,
        tier_breakdown: tb,
        top3_pct: hitsInBucket.length > 0 ? +(((tb.first + tb.second + tb.third) / hitsInBucket.length) * 100).toFixed(1) : 0,
        vs_random_pp: cost > 0 ? +(roi - (-HOUSE_EDGE_PCT)).toFixed(1) : 0,
      });
    }
    // Pattern analysis for profitable vs unprofitable ranges
    function patternStats(gaps) {
      const n = gaps.length;
      const digitFreq = new Array(10).fill(0);
      const tb = { first:0,second:0,third:0,starter:0,consol:0 };
      for (const g of gaps) {
        for (const ch of g.num) digitFreq[parseInt(ch, 10)]++;
        tb[g.tier]++;
      }
      const digits = digitFreq.map((c, i) => ({ digit: i, count: c, pct: n > 0 ? +((c / (n * 4)) * 100).toFixed(1) : 0 }));
      return {
        n,
        digit_freq: digits,
        tier_pct: {
          first: n > 0 ? +((tb.first / n) * 100).toFixed(1) : 0,
          second: n > 0 ? +((tb.second / n) * 100).toFixed(1) : 0,
          third: n > 0 ? +((tb.third / n) * 100).toFixed(1) : 0,
          starter: n > 0 ? +((tb.starter / n) * 100).toFixed(1) : 0,
          consol: n > 0 ? +((tb.consol / n) * 100).toFixed(1) : 0,
        },
        top3_pct: n > 0 ? +(((tb.first + tb.second + tb.third) / n) * 100).toFixed(1) : 0,
      };
    }
    const profitable = allGaps.filter(g => g.length >= 1900 && g.length < 2400);
    const typical = allGaps.filter(g => g.length >= 100 && g.length < 500);
    const all = allGaps;
    res.json({ success: true, data: {
      total_draws_scanned: totalDraws,
      total_gaps_analyzed: allGaps.length,
      bucket_size: bucketSize,
      buckets,
      profitable_buckets: buckets.filter(b => b.roi > 0 && b.hits >= 5),
      patterns: {
        profitable_zone: { range: "1900-2400 draws", ...patternStats(profitable) },
        typical_zone:    { range: "100-500 draws",  ...patternStats(typical) },
        baseline:        { range: "all gaps",       ...patternStats(all) },
      },
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
}));

// ─── Alpha filter — step-by-step filter for currently actionable numbers ──
app.get("/api/fourd/alpha-filter", (req, res) => {
  try {
    const start = parseInt(req.query.start || "2000", 10);
    const stop = parseInt(req.query.stop || "2200", 10);
    const minHits = parseInt(req.query.min_hits || "0", 10);
    const minTop3 = parseInt(req.query.min_top3 || "0", 10);
    const minFirst = parseInt(req.query.min_first || "0", 10);
    const rows = db.prepare(
      "SELECT first_prize, second_prize, third_prize, starter_prizes, consolation_prizes, draw_date FROM fourd_draws ORDER BY draw_date ASC, draw_no ASC"
    ).all();
    const totalDraws = rows.length;
    const numHistory = {};
    rows.forEach((r, idx) => {
      function add(num, tier) {
        if (num == null) return;
        const k = String(num).padStart(4, "0");
        if (!numHistory[k]) numHistory[k] = [];
        numHistory[k].push({ idx, tier, date: r.draw_date });
      }
      add(r.first_prize, "first"); add(r.second_prize, "second"); add(r.third_prize, "third");
      try { JSON.parse(r.starter_prizes || "[]").forEach(p => add(p, "starter")); } catch {}
      try { JSON.parse(r.consolation_prizes || "[]").forEach(p => add(p, "consol")); } catch {}
    });
    let layer0 = 0, layer1 = 0, layer2 = 0, layer3 = 0;
    const candidates = [];
    for (const k of Object.keys(numHistory)) {
      const hits = numHistory[k];
      const lastHit = hits[hits.length - 1];
      const curGap = totalDraws - 1 - lastHit.idx;
      if (curGap < start || curGap > stop) continue;
      layer0++;
      const top3 = hits.filter(h => h.tier === "first" || h.tier === "second" || h.tier === "third").length;
      const first = hits.filter(h => h.tier === "first").length;
      if (top3 < minTop3) continue;
      layer1++;
      if (first < minFirst) continue;
      layer2++;
      if (hits.length < minHits) continue;
      layer3++;
      candidates.push({
        number: k,
        gap: curGap,
        total_hits: hits.length,
        top3_count: top3,
        first_count: first,
        last_hit_date: lastHit.date,
        last_hit_tier: lastHit.tier,
      });
    }
    candidates.sort((a, b) => a.gap - b.gap);
    res.json({ success: true, data: { layer0, layer1, layer2, layer3, candidates }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Q1 (Jan-Mar) Historical Filter Replay ────────────────────────────
// For each year in the archive, snapshot the universe and filter state
// as of Jan 1, then check how many of the filter-passing numbers actually
// hit during that year's Jan-Mar window.
app.get("/api/fourd/q1-history", (req, res) => {
  try {
    const start    = parseInt(req.query.start    || "2000", 10);
    const stop     = parseInt(req.query.stop     || "2200", 10);
    const minHits  = parseInt(req.query.min_hits || "0",    10);
    const minTop3  = parseInt(req.query.min_top3 || "0",    10);
    const minFirst = parseInt(req.query.min_first|| "0",    10);

    const rows = db.prepare(
      "SELECT first_prize, second_prize, third_prize, starter_prizes, consolation_prizes, draw_date FROM fourd_draws ORDER BY draw_date ASC, draw_no ASC"
    ).all();

    // numHistory[num] = [{idx, tier, year, month}] sorted by idx
    const numHistory = {};
    rows.forEach((r, idx) => {
      const y = parseInt(r.draw_date.slice(0, 4), 10);
      const m = parseInt(r.draw_date.slice(5, 7), 10);
      function add(num, tier) {
        if (num == null) return;
        const k = String(num).padStart(4, "0");
        if (!numHistory[k]) numHistory[k] = [];
        numHistory[k].push({ idx, tier, year: y, month: m });
      }
      add(r.first_prize, "first"); add(r.second_prize, "second"); add(r.third_prize, "third");
      try { JSON.parse(r.starter_prizes || "[]").forEach(p => add(p, "starter")); } catch {}
      try { JSON.parse(r.consolation_prizes || "[]").forEach(p => add(p, "consol")); } catch {}
    });

    // All years present in archive
    const years = Array.from(new Set(rows.map(r => parseInt(r.draw_date.slice(0, 4), 10)))).sort((a,b) => a-b);

    // Precompute cutoff idx (last idx with date < Jan 1, y) for each year via single pass
    const cutoffByYear = {};
    let curIdx = -1;
    for (const y of years) {
      const cutoffDate = `${y}-01-01`;
      while (curIdx + 1 < rows.length && rows[curIdx + 1].draw_date < cutoffDate) curIdx++;
      cutoffByYear[y] = curIdx;  // -1 means no history before this year
    }

    const report = [];
    for (const y of years) {
      const cutoff = cutoffByYear[y];
      let universe = 0;
      let layer0 = 0, layer1 = 0, layer2 = 0, layer3 = 0;
      const passing = [];

      for (const k of Object.keys(numHistory)) {
        const hits = numHistory[k];
        // Hits strictly before Jan 1 of year y
        let lastBeforeIdx = -1;
        let firstCount = 0, top3Count = 0, totalBefore = 0;
        for (const h of hits) {
          if (h.idx > cutoff) break;
          totalBefore++;
          lastBeforeIdx = h.idx;
          if (h.tier === "first") { firstCount++; top3Count++; }
          else if (h.tier === "second" || h.tier === "third") top3Count++;
        }
        if (totalBefore === 0) continue;
        universe++;
        if (cutoff < 0) continue;
        const curGap = cutoff - lastBeforeIdx;
        if (curGap < start || curGap > stop) continue;
        layer0++;
        if (top3Count < minTop3) continue;
        layer1++;
        if (firstCount < minFirst) continue;
        layer2++;
        if (totalBefore < minHits) continue;
        layer3++;
        passing.push(k);
      }

      // For each passing number, did it hit during Q1 of year y?
      const tierBreakdown = { first:0, second:0, third:0, starter:0, consol:0 };
      let q1HitNumbers = 0;
      for (const k of passing) {
        const q1Hits = numHistory[k].filter(h => h.year === y && h.month >= 1 && h.month <= 3);
        if (q1Hits.length > 0) {
          q1HitNumbers++;
          for (const h of q1Hits) tierBreakdown[h.tier]++;
        }
      }

      const q1Draws = rows.filter(r =>
        r.draw_date >= `${y}-01-01` && r.draw_date < `${y}-04-01`
      ).length;

      report.push({
        year: y,
        universe,
        layer0, layer1, layer2, layer3,
        q1_draws: q1Draws,
        q1_hit_numbers: q1HitNumbers,
        q1_hit_rate_pct: layer3 > 0 ? Math.round(q1HitNumbers / layer3 * 100) : 0,
        q1_tier_breakdown: tierBreakdown,
      });
    }

    res.json({ success: true, data: {
      years: report,
      filter: { start, stop, minHits, minTop3, minFirst },
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Strategy Simulator — rolling pool, forward-only, configurable filters ──
// Match the live forward backtest: every draw updates gaps; pool = numbers
// with gap in [gap_lo, gap_hi] that also pass lifetime tier filters; bets only
// on draws matching month + DOW filters; no look-ahead.
app.get("/api/fourd/strategy-simulator", (req, res) => {
  try {
    const startYear  = parseInt(req.query.start_year || "2004", 10);
    const gapLo      = parseInt(req.query.gap_lo     || "2010", 10);
    const gapHi      = parseInt(req.query.gap_hi     || "2140", 10);
    const months     = (req.query.months || "1,2,3").split(",").map(s => parseInt(s, 10));
    const dows       = (req.query.dows   || "2,6"  ).split(",").map(s => parseInt(s, 10));
    const minFirst   = parseInt(req.query.min_first   || "0", 10);
    const minSecond  = parseInt(req.query.min_second  || "0", 10);
    const minThird   = parseInt(req.query.min_third   || "0", 10);
    const minStarter = parseInt(req.query.min_starter || "0", 10);
    const minConsol  = parseInt(req.query.min_consol  || "0", 10);
    const minTop3    = parseInt(req.query.min_top3    || "0", 10);
    const minTotal   = parseInt(req.query.min_total   || "0", 10);
    const stakeBig   = Math.max(0, parseFloat(req.query.stake_big   || req.query.stake || "1"));
    const stakeSmall = Math.max(0, parseFloat(req.query.stake_small || "2"));
    const stopOnHit  = req.query.stop_on_hit !== "0";   // default true

    const BIG   = { first:2000, second:1000, third:500, starter:250, consol:60 };
    const SMALL = { first:3000, second:2000, third:800, starter:0,   consol:0  };
    const COMBO = {}; for (const t in BIG) COMBO[t] = BIG[t] + 2 * SMALL[t];

    const rows = db.prepare(
      "SELECT draw_no, draw_date, first_prize, second_prize, third_prize, starter_prizes, consolation_prizes FROM fourd_draws ORDER BY draw_date ASC, draw_no ASC"
    ).all();

    // Per-draw hit map: number → highest tier
    const drawHits = rows.map(r => {
      const h = {};
      const add = (n, t) => {
        if (n == null) return;
        const k = String(n).padStart(4, "0");
        if (!(k in h)) h[k] = t;
      };
      add(r.first_prize,  "first");
      add(r.second_prize, "second");
      add(r.third_prize,  "third");
      try { JSON.parse(r.starter_prizes      || "[]").forEach(p => add(p, "starter")); } catch {}
      try { JSON.parse(r.consolation_prizes  || "[]").forEach(p => add(p, "consol"));  } catch {}
      return h;
    });

    // Per-draw metadata
    const drawMeta = rows.map(r => {
      const d = new Date(r.draw_date);
      return {
        year:  d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        dow:   (d.getUTCDay() + 6) % 7,
      };
    });

    // Forward simulation state
    const lastHitIdx = {};
    const numTiers   = {};
    let inPool       = new Set();
    const yearStats  = {};
    // Per-year persistent bet list. Once a number qualifies during Q1, it stays
    // in the bet list until end of season OR (if stopOnHit) until it hits.
    const yearBetList = {};       // year → Set(numbers actively bet on)
    const yearHitSet  = {};       // year → Set(numbers that already hit this year)

    function ensureYear(y) {
      if (!yearStats[y]) yearStats[y] = {
        bets:0, wins:0,
        tiers:{first:0,second:0,third:0,starter:0,consol:0},
        bigRev:0, smallRev:0, comboRev:0,
        entries:0, exitsHit:0,
        activeSet: new Set(),
        poolSizes: [],
      };
      if (!yearBetList[y]) yearBetList[y] = new Set();
      if (!yearHitSet[y])  yearHitSet[y]  = new Set();
      return yearStats[y];
    }

    function passesFilter(k, gap) {
      if (gap < gapLo || gap > gapHi) return false;
      const t = numTiers[k]; if (!t) return false;
      if (t.first   < minFirst)   return false;
      if (t.second  < minSecond)  return false;
      if (t.third   < minThird)   return false;
      if (t.starter < minStarter) return false;
      if (t.consol  < minConsol)  return false;
      if ((t.first + t.second + t.third) < minTop3) return false;
      if (t.total < minTotal) return false;
      return true;
    }

    for (let idx = 0; idx < rows.length; idx++) {
      const meta = drawMeta[idx];
      const y = meta.year;
      const isBetDraw = y >= startYear && months.includes(meta.month) && dows.includes(meta.dow);

      // Recompute gap-based pool (for entry tracking + abandon detection)
      const newPool = new Set();
      for (const k in lastHitIdx) {
        const gap = idx - lastHitIdx[k];
        if (passesFilter(k, gap)) newPool.add(k);
      }

      if (y >= startYear) {
        const s = ensureYear(y);
        for (const k of newPool) if (!inPool.has(k)) s.entries++;
      }
      inPool = newPool;

      if (isBetDraw) {
        const s = ensureYear(y);
        // Persistent bet list: add anyone newly qualifying (in pool now), remove
        // anyone abandoned (gap exceeded gapHi → exited pool entirely).
        // Persistence: once added during a Q1 draw, stays until Q1 ends OR (if
        // stopOnHit) until they hit. We track abandons via the pool exit.
        for (const k of inPool) yearBetList[y].add(k);
        // Remove abandons: numbers that were in bet list but their gap is now
        // > gapHi (not in pool AND gap > gapHi). Allow gap < gapLo too (means
        // they recently hit and reset — those exit only if stopOnHit; otherwise
        // continue mode keeps them).
        const toRemove = [];
        for (const k of yearBetList[y]) {
          const gap = idx - (lastHitIdx[k] ?? 0);
          if (gap > gapHi) toRemove.push(k);            // abandoned
          else if (stopOnHit && yearHitSet[y].has(k)) toRemove.push(k);  // stop mode
        }
        for (const k of toRemove) yearBetList[y].delete(k);

        s.poolSizes.push(yearBetList[y].size);
        // Place a bet on each member of the bet list
        for (const k of yearBetList[y]) {
          s.bets++;
          s.activeSet.add(k);
          const tier = drawHits[idx][k];
          if (tier) {
            s.wins++;
            s.tiers[tier]++;
            const bigPay   = BIG[tier]   * stakeBig;
            const smallPay = SMALL[tier] * stakeSmall;
            s.bigRev   += bigPay;
            s.smallRev += smallPay;
            s.comboRev += bigPay + smallPay;          // Combo = placing both bets together
            yearHitSet[y].add(k);
          }
        }
      }

      // Settle: update last-hit and lifetime tier counts AFTER bets resolved
      for (const k in drawHits[idx]) {
        if (y >= startYear && inPool.has(k)) {
          ensureYear(y).exitsHit++;
        }
        const t = drawHits[idx][k];
        if (!numTiers[k]) numTiers[k] = {first:0,second:0,third:0,starter:0,consol:0,total:0};
        numTiers[k][t]++;
        numTiers[k].total++;
        lastHitIdx[k] = idx;
      }
    }

    let totalBigCost = 0, totalBigRev = 0,
        totalSmallCost = 0, totalSmallRev = 0,
        totalComboCost = 0, totalComboRev = 0,
        totalHits = 0;
    let totalEntries = 0, totalExitsHit = 0;
    let cumBig = 0, cumSmall = 0, cumCombo = 0;
    const yearlyArr = [];
    for (const yk of Object.keys(yearStats).sort()) {
      const y = parseInt(yk, 10);
      const s = yearStats[y];
      const bigCost   = s.bets * stakeBig;
      const smallCost = s.bets * stakeSmall;
      const comboCost = s.bets * (stakeBig + stakeSmall);
      const bigNet    = s.bigRev   - bigCost;
      const smallNet  = s.smallRev - smallCost;
      const comboNet  = s.comboRev - comboCost;
      cumBig   += bigNet;
      cumSmall += smallNet;
      cumCombo += comboNet;
      totalBigCost   += bigCost;
      totalBigRev    += s.bigRev;
      totalSmallCost += smallCost;
      totalSmallRev  += s.smallRev;
      totalComboCost += comboCost;
      totalComboRev  += s.comboRev;
      totalHits      += s.wins;
      totalEntries   += s.entries;
      totalExitsHit  += s.exitsHit;
      const avgPool = s.poolSizes.length
        ? s.poolSizes.reduce((a,b) => a+b, 0) / s.poolSizes.length : 0;
      yearlyArr.push({
        year: y,
        active_count: s.activeSet.size,
        avg_pool: Math.round(avgPool * 10) / 10,
        bets: s.bets,
        entries: s.entries,
        exits_hit: s.exitsHit,
        wins: s.wins,
        tiers: s.tiers,
        big_rev: s.bigRev,
        small_rev: s.smallRev,
        combo_rev: s.comboRev,
        big_net: bigNet,
        small_net: smallNet,
        combo_net: comboNet,
        cum_big: cumBig,
        cum_small: cumSmall,
        cum_combo: cumCombo,
      });
    }

    // Current pool snapshot
    const lastIdx = rows.length - 1;
    const currentPool = [];
    for (const k in lastHitIdx) {
      const gap = lastIdx - lastHitIdx[k];
      if (passesFilter(k, gap)) {
        currentPool.push({
          number: k,
          gap,
          last_hit_date: rows[lastHitIdx[k]].draw_date,
          tiers: numTiers[k],
        });
      }
    }
    currentPool.sort((a, b) => a.gap - b.gap);

    res.json({ success: true, data: {
      params: { start_year: startYear, gap_lo: gapLo, gap_hi: gapHi, months, dows,
                min_first: minFirst, min_second: minSecond, min_third: minThird,
                min_starter: minStarter, min_consol: minConsol,
                min_top3: minTop3, min_total: minTotal,
                stake_big: stakeBig, stake_small: stakeSmall, stop_on_hit: stopOnHit },
      yearly: yearlyArr,
      totals: {
        big:   { cost: totalBigCost,   rev: totalBigRev,   pl: totalBigRev - totalBigCost,
                 roi_pct: totalBigCost > 0 ? (totalBigRev - totalBigCost) / totalBigCost * 100 : 0,
                 multiple: totalBigCost > 0 ? totalBigRev / totalBigCost : 0 },
        small: { cost: totalSmallCost, rev: totalSmallRev, pl: totalSmallRev - totalSmallCost,
                 roi_pct: totalSmallCost > 0 ? (totalSmallRev - totalSmallCost) / totalSmallCost * 100 : 0,
                 multiple: totalSmallCost > 0 ? totalSmallRev / totalSmallCost : 0 },
        combo: { cost: totalComboCost, rev: totalComboRev, pl: totalComboRev - totalComboCost,
                 roi_pct: totalComboCost > 0 ? (totalComboRev - totalComboCost) / totalComboCost * 100 : 0,
                 multiple: totalComboCost > 0 ? totalComboRev / totalComboCost : 0 },
        hits: totalHits, entries: totalEntries, exits_hit: totalExitsHit,
      },
      current_pool: currentPool,
      current_pool_count: currentPool.length,
      last_draw_date: rows[lastIdx].draw_date,
      payouts: { big: BIG, small: SMALL, combo: COMBO },
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Profitable Buckets — reverse-engineer winners by gap bucket ────────
// Bucket every (number, draw) pair by current gap. Count bets/wins per bucket
// within the bet window (months × DOWs). For each winner, capture the number's
// point-in-time lifetime tier counts to enable backward analysis.
app.get("/api/fourd/profitable-buckets", (req, res) => {
  try {
    const data = cache.compute(req, () => doProfitableBuckets(req));
    return res.json({ success: true, data });
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
});
function doProfitableBuckets(req) {
    const bucketWidth = Math.max(10, parseInt(req.query.bucket_width || "100", 10));
    const bucketMin   = parseInt(req.query.bucket_min || "0",    10);
    const bucketMax   = parseInt(req.query.bucket_max || "3500", 10);
    const months      = (req.query.months || "1,2,3").split(",").map(s => parseInt(s, 10));
    const dows        = (req.query.dows   || "2,6"  ).split(",").map(s => parseInt(s, 10));
    const tiers       = (req.query.tiers  || "first,second,third").split(",");
    const startYear   = parseInt(req.query.start_year || "2004", 10);

    const BIG   = { first:2000, second:1000, third:500, starter:250, consol:60 };
    const SMALL = { first:3000, second:2000, third:800, starter:0,   consol:0  };
    const COMBO = {}; for (const t in BIG) COMBO[t] = BIG[t] + 2 * SMALL[t];

    const rows = db.prepare(
      "SELECT draw_no, draw_date, first_prize, second_prize, third_prize, starter_prizes, consolation_prizes FROM fourd_draws ORDER BY draw_date ASC, draw_no ASC"
    ).all();

    const drawHits = rows.map(r => {
      const h = {};
      const add = (n, t) => {
        if (n == null) return;
        const k = String(n).padStart(4, "0");
        if (!(k in h)) h[k] = t;
      };
      add(r.first_prize,  "first");
      add(r.second_prize, "second");
      add(r.third_prize,  "third");
      try { JSON.parse(r.starter_prizes      || "[]").forEach(p => add(p, "starter")); } catch {}
      try { JSON.parse(r.consolation_prizes  || "[]").forEach(p => add(p, "consol"));  } catch {}
      return h;
    });

    const drawMeta = rows.map(r => {
      const d = new Date(r.draw_date);
      return {
        year:  d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        dow:   (d.getUTCDay() + 6) % 7,
      };
    });

    // Buckets
    const buckets = [];
    for (let lo = bucketMin; lo < bucketMax; lo += bucketWidth) {
      buckets.push({
        lo, hi: lo + bucketWidth,
        n_bets: 0,
        n_wins: 0,
        n_wins_target: 0,                        // matches `tiers` filter
        big_rev: 0, small_rev: 0, combo_rev: 0,
        tier_counts: { first:0, second:0, third:0, starter:0, consol:0 },
        winners: [],                             // detailed winning bets
      });
    }
    function bucketIdxFor(gap) {
      if (gap < bucketMin || gap >= bucketMax) return -1;
      return Math.floor((gap - bucketMin) / bucketWidth);
    }

    const lastHitIdx = {};
    const numTiers   = {};   // point-in-time tier counts

    for (let idx = 0; idx < rows.length; idx++) {
      const meta = drawMeta[idx];
      const y = meta.year;
      const isBetDraw = y >= startYear && months.includes(meta.month) && dows.includes(meta.dow);

      if (isBetDraw) {
        // For each number with prior history, compute current gap and place in bucket
        for (const k in lastHitIdx) {
          const gap = idx - lastHitIdx[k];
          const bIdx = bucketIdxFor(gap);
          if (bIdx < 0) continue;
          const b = buckets[bIdx];
          b.n_bets++;
          const wTier = drawHits[idx][k];
          if (wTier) {
            b.n_wins++;
            b.tier_counts[wTier]++;
            b.big_rev   += BIG[wTier];
            b.small_rev += SMALL[wTier];
            b.combo_rev += COMBO[wTier];
            if (tiers.includes(wTier)) {
              b.n_wins_target++;
              // Capture detail (snapshot of state) — cap detail at 200 per bucket
              if (b.winners.length < 200) {
                const lf = numTiers[k] || {first:0,second:0,third:0,starter:0,consol:0,total:0};
                b.winners.push({
                  draw_date: rows[idx].draw_date,
                  year: y,
                  number: k,
                  gap_at_win: gap,
                  tier: wTier,
                  big_payout: BIG[wTier],
                  small_payout: SMALL[wTier],
                  combo_payout: COMBO[wTier],
                  lifetime_at_win: lf,
                });
              }
            }
          }
        }
      }

      // Settle: update lifetime tier counts and last-hit AFTER stats captured
      for (const k in drawHits[idx]) {
        const t = drawHits[idx][k];
        if (!numTiers[k]) numTiers[k] = {first:0,second:0,third:0,starter:0,consol:0,total:0};
        numTiers[k][t]++;
        numTiers[k].total++;
        lastHitIdx[k] = idx;
      }
    }

    // Aggregate baseline for significance testing
    let totalBets = 0, totalTargetWins = 0;
    for (const b of buckets) { totalBets += b.n_bets; totalTargetWins += b.n_wins_target; }
    const baselineRate = totalBets > 0 ? totalTargetWins / totalBets : 0;

    // Normal CDF approximation (Abramowitz & Stegun)
    function normCdf(z) {
      const a1 =  0.254829592, a2 = -0.284496736, a3 = 1.421413741;
      const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
      const sign = z < 0 ? -1 : 1;
      const x = Math.abs(z) / Math.sqrt(2);
      const t = 1.0 / (1.0 + p * x);
      const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
      return 0.5 * (1.0 + sign * y);
    }

    // Compute per-bucket stats
    let topRevBucket = null;
    let topHitRateBucket = null;
    for (const b of buckets) {
      b.hit_rate_pct      = b.n_bets > 0 ? (b.n_wins / b.n_bets * 100) : 0;
      b.target_rate_pct   = b.n_bets > 0 ? (b.n_wins_target / b.n_bets * 100) : 0;
      b.big_pl            = b.big_rev   - b.n_bets;
      b.small_pl          = b.small_rev - b.n_bets;
      b.combo_pl          = b.combo_rev - b.n_bets * 3;
      b.big_roi_pct       = b.n_bets > 0 ? (b.big_pl / b.n_bets) * 100 : 0;
      b.small_roi_pct     = b.n_bets > 0 ? (b.small_pl / b.n_bets) * 100 : 0;
      b.combo_roi_pct     = b.n_bets > 0 ? (b.combo_pl / (b.n_bets * 3)) * 100 : 0;

      // Statistical significance vs uniform null (baseline hit rate)
      b.expected_target_wins = b.n_bets * baselineRate;
      const variance = b.expected_target_wins * (1 - baselineRate);
      b.z_score = variance > 0 ? (b.n_wins_target - b.expected_target_wins) / Math.sqrt(variance) : 0;
      b.p_value = b.n_bets > 0 ? 2 * (1 - normCdf(Math.abs(b.z_score))) : 1;
      // Share of total target wins coming from this bucket
      b.share_of_wins_pct  = totalTargetWins > 0 ? (b.n_wins_target / totalTargetWins * 100) : 0;
      b.share_of_bets_pct  = totalBets > 0 ? (b.n_bets / totalBets * 100) : 0;
      // Lift over expected share
      b.lift_pct = b.expected_target_wins > 0
        ? ((b.n_wins_target - b.expected_target_wins) / b.expected_target_wins * 100)
        : 0;

      if (!topRevBucket || b.combo_pl > topRevBucket.combo_pl) topRevBucket = b;
      if (b.n_bets > 100 && (!topHitRateBucket || b.target_rate_pct > topHitRateBucket.target_rate_pct)) topHitRateBucket = b;
      b.winners.sort((a, b2) => b2.big_payout - a.big_payout);
    }

    // Identify significant buckets (Bonferroni-corrected)
    const nNonEmptyBuckets = buckets.filter(b => b.n_bets > 0).length;
    const bonferroniAlpha = 0.05 / Math.max(1, nNonEmptyBuckets);
    for (const b of buckets) {
      b.is_significant_uncorrected = b.p_value < 0.05 && b.n_bets > 0;
      b.is_significant_bonferroni  = b.p_value < bonferroniAlpha && b.n_bets > 0;
    }

    // Aggregate winner profile: average lifetime stats of winners
    const allWinners = [];
    for (const b of buckets) allWinners.push(...b.winners);
    function avgLifetime(arr) {
      if (!arr.length) return null;
      const sums = {first:0,second:0,third:0,starter:0,consol:0,total:0};
      for (const w of arr) for (const k in sums) sums[k] += w.lifetime_at_win[k] || 0;
      const out = {};
      for (const k in sums) out[k] = Math.round(sums[k] / arr.length * 100) / 100;
      return out;
    }
    const totalsByTier = { first:0, second:0, third:0, starter:0, consol:0 };
    for (const w of allWinners) totalsByTier[w.tier]++;

    return {
      params: { bucket_width: bucketWidth, bucket_min: bucketMin, bucket_max: bucketMax,
                months, dows, tiers, start_year: startYear },
      buckets,
      summary: {
        total_winners: allWinners.length,
        total_bets: totalBets,
        total_target_wins: totalTargetWins,
        baseline_rate_pct: baselineRate * 100,
        bonferroni_alpha: bonferroniAlpha,
        winner_tier_totals: totalsByTier,
        winner_lifetime_avg: avgLifetime(allWinners),
        top_revenue_bucket: topRevBucket ? { lo: topRevBucket.lo, hi: topRevBucket.hi, combo_pl: topRevBucket.combo_pl } : null,
        top_hit_rate_bucket: topHitRateBucket ? { lo: topHitRateBucket.lo, hi: topHitRateBucket.hi, rate: topHitRateBucket.target_rate_pct } : null,
      },
      payouts: { big: BIG, small: SMALL, combo: COMBO },
    };
}

// ─── Buckets-by-Time — month × bucket and DOW × bucket heatmaps ──────
// For every draw, for every number with prior history, increments counters
// keyed by (month, bucket) and (DOW, bucket). Surfaces whether the
// 2000-2200 signal is consistent across months/DOWs or driven by a slice.
app.get("/api/fourd/buckets-by-time", cache.withCache((req, res) => {
  try {
    const bucketWidth = Math.max(10, parseInt(req.query.bucket_width || "100", 10));
    const bucketMin   = parseInt(req.query.bucket_min || "0",    10);
    const bucketMax   = parseInt(req.query.bucket_max || "3000", 10);
    const tiers       = (req.query.tiers  || "first,second,third").split(",");
    const startYear   = parseInt(req.query.start_year || "2004", 10);

    const rows = db.prepare(
      "SELECT draw_date, first_prize, second_prize, third_prize, starter_prizes, consolation_prizes FROM fourd_draws ORDER BY draw_date ASC, draw_no ASC"
    ).all();

    const drawHits = rows.map(r => {
      const h = {};
      const add = (n, t) => {
        if (n == null) return;
        const k = String(n).padStart(4, "0");
        if (!(k in h)) h[k] = t;
      };
      add(r.first_prize,  "first");
      add(r.second_prize, "second");
      add(r.third_prize,  "third");
      try { JSON.parse(r.starter_prizes      || "[]").forEach(p => add(p, "starter")); } catch {}
      try { JSON.parse(r.consolation_prizes  || "[]").forEach(p => add(p, "consol"));  } catch {}
      return h;
    });

    const drawMeta = rows.map(r => {
      const d = new Date(r.draw_date);
      return {
        year:  d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        dow:   (d.getUTCDay() + 6) % 7,
      };
    });

    const BIG   = { first:2000, second:1000, third:500, starter:250, consol:60 };
    const SMALL = { first:3000, second:2000, third:800, starter:0,   consol:0  };

    const nBuckets = Math.ceil((bucketMax - bucketMin) / bucketWidth);
    function bucketIdxFor(gap) {
      if (gap < bucketMin || gap >= bucketMax) return -1;
      return Math.floor((gap - bucketMin) / bucketWidth);
    }
    function makeMatrix() {
      const m = new Array(nBuckets);
      for (let i = 0; i < nBuckets; i++) {
        m[i] = { n_bets: 0, n_wins: 0, big_rev: 0, small_rev: 0 };
      }
      return m;
    }

    const byMonth = {};
    const byDow   = {};
    for (let m = 1; m <= 12; m++) byMonth[m] = makeMatrix();
    for (let d = 0; d < 7;  d++)  byDow[d]   = makeMatrix();

    const lastHitIdx = {};
    let totalBets = 0, totalWins = 0;

    for (let idx = 0; idx < rows.length; idx++) {
      const meta = drawMeta[idx];
      if (meta.year < startYear) {
        for (const k in drawHits[idx]) lastHitIdx[k] = idx;
        continue;
      }

      const monthRow = byMonth[meta.month];
      const dowRow   = byDow[meta.dow];

      for (const k in lastHitIdx) {
        const gap = idx - lastHitIdx[k];
        const bIdx = bucketIdxFor(gap);
        if (bIdx < 0) continue;
        monthRow[bIdx].n_bets++;
        dowRow[bIdx].n_bets++;
        totalBets++;
        const tier = drawHits[idx][k];
        if (tier) {
          // Accumulate revenue from ANY tier (Big pays starter/consol too;
          // Small does not, but we still record both so user can see)
          monthRow[bIdx].big_rev   += BIG[tier];
          monthRow[bIdx].small_rev += SMALL[tier];
          dowRow[bIdx].big_rev   += BIG[tier];
          dowRow[bIdx].small_rev += SMALL[tier];
          if (tiers.includes(tier)) {
            monthRow[bIdx].n_wins++;
            dowRow[bIdx].n_wins++;
            totalWins++;
          }
        }
      }

      for (const k in drawHits[idx]) lastHitIdx[k] = idx;
    }

    const baselineRate = totalBets > 0 ? totalWins / totalBets : 0;

    function normCdf(z) {
      const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429, p=0.3275911;
      const sign = z < 0 ? -1 : 1;
      const x = Math.abs(z) / Math.sqrt(2);
      const t = 1.0 / (1.0 + p * x);
      const y = 1.0 - (((((a5*t + a4)*t) + a3)*t + a2)*t + a1)*t * Math.exp(-x*x);
      return 0.5 * (1.0 + sign * y);
    }

    function enrich(row) {
      return row.map(cell => {
        const expected = cell.n_bets * baselineRate;
        const variance = expected * (1 - baselineRate);
        const z = variance > 0 ? (cell.n_wins - expected) / Math.sqrt(variance) : 0;
        const p = cell.n_bets > 0 ? 2 * (1 - normCdf(Math.abs(z))) : 1;
        // P/L per unit stake — Big at $1, Small at $1 cost; Combo = $1 Big + $2 Small ($3 cost)
        const big_pl   = cell.big_rev   - cell.n_bets;
        const small_pl = cell.small_rev - cell.n_bets;            // $1 Small stake
        const combo_pl = cell.big_rev + 2 * cell.small_rev - cell.n_bets * 3;  // $1 Big + $2 Small
        return {
          n_bets: cell.n_bets,
          n_wins: cell.n_wins,
          rate_pct: cell.n_bets > 0 ? cell.n_wins / cell.n_bets * 100 : 0,
          expected: Math.round(expected * 100) / 100,
          z_score: Math.round(z * 100) / 100,
          p_value: p,
          big_rev: cell.big_rev,
          small_rev: cell.small_rev,
          big_pl:   big_pl,
          small_pl: small_pl,
          combo_pl: combo_pl,
        };
      });
    }

    const monthOut = {};
    for (const m in byMonth) monthOut[m] = enrich(byMonth[m]);
    const dowOut = {};
    for (const d in byDow) dowOut[d] = enrich(byDow[d]);

    // Bucket labels
    const bucketLabels = [];
    for (let i = 0; i < nBuckets; i++) {
      const lo = bucketMin + i * bucketWidth;
      bucketLabels.push({ lo, hi: lo + bucketWidth });
    }

    res.json({ success: true, data: {
      params: { bucket_width: bucketWidth, bucket_min: bucketMin, bucket_max: bucketMax, tiers, start_year: startYear },
      bucket_labels: bucketLabels,
      baseline_rate_pct: baselineRate * 100,
      total_bets: totalBets,
      total_wins: totalWins,
      by_month: monthOut,
      by_dow:   dowOut,
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
}));

// ─── Slice Detail — drill into a specific (months, dows, gap range) cell ─
// Returns every winning bet that matches the slice + per-year aggregation.
app.get("/api/fourd/slice-detail", (req, res) => {
  try {
    const months     = (req.query.months || "1,2,3").split(",").map(s => parseInt(s, 10));
    const dows       = (req.query.dows   || "2,6"  ).split(",").map(s => parseInt(s, 10));
    const gapLo      = parseInt(req.query.gap_lo || "2000", 10);
    const gapHi      = parseInt(req.query.gap_hi || "2200", 10);
    const tiers      = (req.query.tiers  || "first,second,third").split(",");
    const startYear  = parseInt(req.query.start_year || "2004", 10);
    const stakeBig   = Math.max(0, parseFloat(req.query.stake_big   || "1"));
    const stakeSmall = Math.max(0, parseFloat(req.query.stake_small || "2"));

    const BIG   = { first:2000, second:1000, third:500, starter:250, consol:60 };
    const SMALL = { first:3000, second:2000, third:800, starter:0,   consol:0  };

    const rows = db.prepare(
      "SELECT draw_date, first_prize, second_prize, third_prize, starter_prizes, consolation_prizes FROM fourd_draws ORDER BY draw_date ASC, draw_no ASC"
    ).all();

    const drawHits = rows.map(r => {
      const h = {};
      const add = (n, t) => {
        if (n == null) return;
        const k = String(n).padStart(4, "0");
        if (!(k in h)) h[k] = t;
      };
      add(r.first_prize,  "first");
      add(r.second_prize, "second");
      add(r.third_prize,  "third");
      try { JSON.parse(r.starter_prizes      || "[]").forEach(p => add(p, "starter")); } catch {}
      try { JSON.parse(r.consolation_prizes  || "[]").forEach(p => add(p, "consol"));  } catch {}
      return h;
    });

    const drawMeta = rows.map(r => {
      const d = new Date(r.draw_date);
      return { year: d.getUTCFullYear(), month: d.getUTCMonth()+1, dow: (d.getUTCDay()+6)%7 };
    });

    const lastHitIdx = {};
    const numTiers   = {};
    const winners = [];
    const byYear = {};
    let totalBets = 0;

    for (let idx = 0; idx < rows.length; idx++) {
      const meta = drawMeta[idx];
      const inSlice = meta.year >= startYear && months.includes(meta.month) && dows.includes(meta.dow);

      if (inSlice) {
        for (const k in lastHitIdx) {
          const gap = idx - lastHitIdx[k];
          if (gap < gapLo || gap > gapHi) continue;
          totalBets++;
          const y = meta.year;
          if (!byYear[y]) byYear[y] = { bets:0, wins:0, big_rev:0, small_rev:0, tiers:{first:0,second:0,third:0,starter:0,consol:0} };
          byYear[y].bets++;
          const tier = drawHits[idx][k];
          if (tier) {
            byYear[y].wins++;
            byYear[y].tiers[tier]++;
            // Scale by stake — Big stake × BIG, Small stake × SMALL
            byYear[y].big_rev   += BIG[tier]   * stakeBig;
            byYear[y].small_rev += SMALL[tier] * stakeSmall;
            if (tiers.includes(tier)) {
              const lf = numTiers[k] || {first:0,second:0,third:0,starter:0,consol:0,total:0};
              winners.push({
                year: y,
                draw_date: rows[idx].draw_date,
                number: k,
                gap_at_win: gap,
                tier,
                big_payout: BIG[tier] * stakeBig,
                small_payout: SMALL[tier] * stakeSmall,
                lifetime_at_win: { ...lf },
              });
            }
          }
        }
      }

      for (const k in drawHits[idx]) {
        const t = drawHits[idx][k];
        if (!numTiers[k]) numTiers[k] = {first:0,second:0,third:0,starter:0,consol:0,total:0};
        numTiers[k][t]++;
        numTiers[k].total++;
        lastHitIdx[k] = idx;
      }
    }

    // Sort winners by payout desc
    winners.sort((a, b) => b.big_payout - a.big_payout);

    const years = Object.keys(byYear).sort().map(y => ({
      year: parseInt(y, 10),
      bets: byYear[y].bets,
      wins: byYear[y].wins,
      tiers: byYear[y].tiers,
      big_rev: byYear[y].big_rev,
      small_rev: byYear[y].small_rev,
      big_pl:    byYear[y].big_rev   - byYear[y].bets * stakeBig,
      small_pl:  byYear[y].small_rev - byYear[y].bets * stakeSmall,
      combo_pl:  byYear[y].big_rev + byYear[y].small_rev - byYear[y].bets * (stakeBig + stakeSmall),
    }));

    const totalWins = winners.length;
    const totalBigRev   = winners.reduce((s, w) => s + w.big_payout, 0);
    const totalSmallRev = winners.reduce((s, w) => s + w.small_payout, 0);
    const tierCounts = { first:0, second:0, third:0, starter:0, consol:0 };
    for (const w of winners) tierCounts[w.tier]++;

    // Lifetime avg of these winners
    let lfSum = {first:0,second:0,third:0,starter:0,consol:0,total:0};
    if (winners.length) {
      for (const w of winners) for (const k in lfSum) lfSum[k] += w.lifetime_at_win[k] || 0;
      for (const k in lfSum) lfSum[k] = Math.round(lfSum[k] / winners.length * 100) / 100;
    }

    res.json({ success: true, data: {
      params: { months, dows, gap_lo: gapLo, gap_hi: gapHi, tiers, start_year: startYear,
                stake_big: stakeBig, stake_small: stakeSmall },
      total_bets: totalBets,
      total_wins: totalWins,
      tier_counts: tierCounts,
      total_big_rev: totalBigRev,
      total_small_rev: totalSmallRev,
      total_big_pl:   totalBigRev   - totalBets * stakeBig,
      total_small_pl: totalSmallRev - totalBets * stakeSmall,
      total_combo_pl: totalBigRev + totalSmallRev - totalBets * (stakeBig + stakeSmall),
      lifetime_avg: lfSum,
      hit_rate_pct: totalBets > 0 ? totalWins / totalBets * 100 : 0,
      by_year: years,
      winners: winners.slice(0, 100),
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Bounded Bet Window (start..stop) — abandon if no hit by stop ─────
// Filter: top-3 qualifying numbers only.
// Strategy: when a number's current gap reaches START draws, bet $1/draw
// until either it hits OR gap reaches STOP draws (then abandon, no more bets).
// Max cost per number per segment = (stop - start + 1) dollars.
app.get("/api/fourd/bounded-window", (req, res) => {
  try {
    const PAY = { first: 2000, second: 1000, third: 490, starter: 250, consol: 60 };
    const HOUSE_EDGE_PCT = 34.1;
    const start = parseInt(req.query.start || "2050", 10);
    const stop  = parseInt(req.query.stop  || "2100", 10);
    const rows = db.prepare(
      "SELECT draw_date, first_prize, second_prize, third_prize, starter_prizes, consolation_prizes FROM fourd_draws ORDER BY draw_date ASC, draw_no ASC"
    ).all();
    const totalDraws = rows.length;
    const numHistory = {};
    rows.forEach((r, idx) => {
      function add(num, tier) {
        if (num == null) return;
        const k = String(num).padStart(4, "0");
        if (!numHistory[k]) numHistory[k] = [];
        numHistory[k].push({ idx, tier, date: r.draw_date });
      }
      add(r.first_prize, "first"); add(r.second_prize, "second"); add(r.third_prize, "third");
      try { JSON.parse(r.starter_prizes || "[]").forEach(p => add(p, "starter")); } catch {}
      try { JSON.parse(r.consolation_prizes || "[]").forEach(p => add(p, "consol")); } catch {}
    });
    const qualifying = {};
    for (const k of Object.keys(numHistory)) {
      const hits = numHistory[k];
      const ft3 = hits.findIndex(h => h.tier === "first" || h.tier === "second" || h.tier === "third");
      if (ft3 >= 0) qualifying[k] = { hits, firstTop3Idx: ft3 };
    }
    function backtest(s, e) {
      let cost = 0, revenue = 0, wins = 0, abandons = 0, openBets = 0, openCost = 0, openAbandons = 0;
      const tb = { first:0,second:0,third:0,starter:0,consol:0 };
      const yearly = {};
      const events = [];
      for (const k of Object.keys(qualifying)) {
        const { hits, firstTop3Idx } = qualifying[k];
        for (let i = firstTop3Idx + 1; i < hits.length; i++) {
          const gap = hits[i].idx - hits[i-1].idx;
          if (gap < s) continue;
          if (gap <= e) {
            const drawsBet = gap - s + 1;
            cost += drawsBet;
            revenue += PAY[hits[i].tier];
            tb[hits[i].tier]++;
            wins++;
            const yr = hits[i].date.slice(0,4);
            if (!yearly[yr]) yearly[yr] = { year:yr, wins:0, abandons:0, cost:0, revenue:0 };
            yearly[yr].wins++; yearly[yr].cost += drawsBet; yearly[yr].revenue += PAY[hits[i].tier];
          } else {
            const drawsBet = e - s + 1;
            cost += drawsBet;
            abandons++;
            const abandonIdx = hits[i-1].idx + e;
            if (abandonIdx < rows.length) {
              const yr = rows[abandonIdx].draw_date.slice(0,4);
              if (!yearly[yr]) yearly[yr] = { year:yr, wins:0, abandons:0, cost:0, revenue:0 };
              yearly[yr].abandons++; yearly[yr].cost += drawsBet;
            }
          }
        }
        const lastIdx = hits[hits.length-1].idx;
        const curGap = totalDraws - 1 - lastIdx;
        if (curGap >= s) {
          if (curGap <= e) { openCost += curGap - s + 1; openBets++; }
          else { openCost += e - s + 1; openAbandons++; }
        }
      }
      const totalCost = cost + openCost;
      const profit = revenue - totalCost;
      const roi = totalCost > 0 ? +((profit/totalCost)*100).toFixed(1) : 0;
      const yearlyArr = Object.values(yearly).sort((a,b) => a.year.localeCompare(b.year));
      yearlyArr.forEach(y => y.net = y.revenue - y.cost);
      return {
        start: s, stop: e, max_per_segment: e - s + 1,
        wins, abandons, total_segments: wins + abandons,
        win_rate: wins + abandons > 0 ? Math.round(wins / (wins + abandons) * 100) : 0,
        openBets, openAbandons, openCost,
        cost, totalCost, revenue, profit, roi,
        vs_random_pp: +(roi - (-HOUSE_EDGE_PCT)).toFixed(1),
        tier_breakdown: tb,
        yearly: yearlyArr,
      };
    }
    // Grid search: vary start 1800-2200 by 50, stop = start + 50..400 by 50
    const grid = [];
    for (let s = 1800; s <= 2200; s += 50) {
      for (let e = s + 50; e <= s + 400; e += 50) {
        grid.push(backtest(s, e));
      }
    }
    grid.sort((a, b) => b.roi - a.roi);
    // User-requested specific configuration
    const userPick = backtest(start, stop);
    // Currently actionable for the user's window
    const actionable = [];
    for (const k of Object.keys(qualifying)) {
      const { hits } = qualifying[k];
      const lastIdx = hits[hits.length-1].idx;
      const curGap = totalDraws - 1 - lastIdx;
      if (curGap >= start && curGap <= stop) {
        const tiers = { first:0,second:0,third:0,starter:0,consol:0 };
        for (const h of hits) tiers[h.tier]++;
        actionable.push({
          number: k,
          current_gap: curGap,
          years_dry: +(curGap/156).toFixed(1),
          last_hit_date: hits[hits.length-1].date,
          last_hit_tier: hits[hits.length-1].tier,
          total_lifetime_hits: hits.length,
          tiers,
          draws_remaining_in_window: stop - curGap,
        });
      }
    }
    actionable.sort((a, b) => a.draws_remaining_in_window - b.draws_remaining_in_window);
    res.json({ success: true, data: {
      total_draws_scanned: totalDraws,
      qualifying_universe: Object.keys(qualifying).length,
      user_pick: userPick,
      grid_top10: grid.slice(0, 10),
      grid_positive: grid.filter(r => r.profit > 0),
      best: grid[0],
      currently_actionable: actionable,
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Top-3 Qualified Dry-Spell Threshold Sweep ────────────────────────
// Filter universe to numbers that have hit top-3 (1st/2nd/3rd) at least once.
// For each threshold X (draws): once a number's gap reaches X, bet $1/draw
// until the next hit. Walk-forward, no look-ahead. Aggregate across all
// qualifying numbers + thresholds to find the optimal trigger point.
app.get("/api/fourd/top3-dry-sweep", (req, res) => {
  try {
    const PAY = { first: 2000, second: 1000, third: 490, starter: 250, consol: 60 };
    const EXPECTED_PER_DOLLAR = (2000 + 1000 + 490 + 10*250 + 10*60) / 10000;
    const HOUSE_EDGE_PCT = (1 - EXPECTED_PER_DOLLAR) * 100;
    const rows = db.prepare(
      "SELECT first_prize, second_prize, third_prize, starter_prizes, consolation_prizes FROM fourd_draws ORDER BY draw_date ASC, draw_no ASC"
    ).all();
    const totalDraws = rows.length;
    const numHistory = {};
    rows.forEach((r, idx) => {
      function add(num, tier) {
        if (num == null) return;
        const k = String(num).padStart(4, "0");
        if (!numHistory[k]) numHistory[k] = [];
        numHistory[k].push({ idx, tier });
      }
      add(r.first_prize, "first"); add(r.second_prize, "second"); add(r.third_prize, "third");
      try { JSON.parse(r.starter_prizes || "[]").forEach(p => add(p, "starter")); } catch {}
      try { JSON.parse(r.consolation_prizes || "[]").forEach(p => add(p, "consol")); } catch {}
    });
    const qualifying = {};
    for (const k of Object.keys(numHistory)) {
      const hits = numHistory[k];
      const firstTop3 = hits.findIndex(h => h.tier === "first" || h.tier === "second" || h.tier === "third");
      if (firstTop3 >= 0) qualifying[k] = { hits, firstTop3Idx: firstTop3 };
    }
    function backtest(threshold) {
      let cost = 0, revenue = 0, completed = 0, openBets = 0, openCost = 0;
      const tb = { first:0, second:0, third:0, starter:0, consol:0 };
      for (const k of Object.keys(qualifying)) {
        const { hits, firstTop3Idx } = qualifying[k];
        for (let i = firstTop3Idx + 1; i < hits.length; i++) {
          const gap = hits[i].idx - hits[i-1].idx;
          if (gap >= threshold) {
            cost += gap - threshold + 1;
            revenue += PAY[hits[i].tier];
            tb[hits[i].tier]++;
            completed++;
          }
        }
        if (hits.length > firstTop3Idx) {
          const lastHitIdx = hits[hits.length - 1].idx;
          const currentGap = totalDraws - 1 - lastHitIdx;
          if (currentGap >= threshold) { openCost += currentGap - threshold + 1; openBets++; }
        }
      }
      const totalCost = cost + openCost;
      const profit = revenue - totalCost;
      return {
        threshold, completed, openBets, totalCost, revenue, profit,
        roi_pct: totalCost > 0 ? Number(((profit / totalCost) * 100).toFixed(1)) : 0,
        vs_random_pp: totalCost > 0 ? Number((((profit / totalCost) * 100 + HOUSE_EDGE_PCT)).toFixed(1)) : 0,
        tier_breakdown: tb,
      };
    }
    // Sweep granularity: coarse 500-3000 by 100, fine 1700-2200 by 50
    const thresholds = [];
    for (let t = 500; t <= 3000; t += 100) thresholds.push(t);
    for (let t = 1725; t < 2300; t += 50) if (!thresholds.includes(t)) thresholds.push(t);
    thresholds.sort((a, b) => a - b);
    const sweep = thresholds.map(t => backtest(t));
    // Two "bests": highest ROI overall, AND highest ROI with adequate sample
    let bestOverall = sweep[0];
    let bestReliable = sweep[0];
    for (const r of sweep) {
      if (r.totalCost > 0 && r.roi_pct > bestOverall.roi_pct) bestOverall = r;
      // Require ≥100 completed bet runs for statistical reliability
      if (r.totalCost > 0 && r.completed >= 100 && r.roi_pct > bestReliable.roi_pct) bestReliable = r;
    }
    const bestROI = bestReliable;     // use reliable as "the recommended"
    // Currently actionable for the best threshold
    const actionable = [];
    for (const k of Object.keys(qualifying)) {
      const { hits, firstTop3Idx } = qualifying[k];
      const lastHit = hits[hits.length - 1];
      const currentGap = totalDraws - 1 - lastHit.idx;
      if (currentGap >= bestROI.threshold) {
        // Tier breakdown of this number's lifetime hits
        const t = { first:0,second:0,third:0,starter:0,consol:0 };
        for (const h of hits) t[h.tier]++;
        actionable.push({
          number: k,
          current_gap: currentGap,
          current_gap_years: Number((currentGap / 156).toFixed(1)),
          total_lifetime_hits: hits.length,
          tiers: t,
          last_hit_idx: lastHit.idx,
        });
      }
    }
    actionable.sort((a, b) => b.current_gap - a.current_gap);
    // Build histogram of longest-dry across the qualifying universe
    const drys = [];
    for (const k of Object.keys(qualifying)) {
      const { hits, firstTop3Idx } = qualifying[k];
      let longest = 0;
      for (let i = 1; i < hits.length; i++) {
        const gap = hits[i].idx - hits[i-1].idx;
        if (gap > longest) longest = gap;
      }
      const openGap = totalDraws - 1 - hits[hits.length-1].idx;
      if (openGap > longest) longest = openGap;
      drys.push(longest);
    }
    drys.sort((a, b) => a - b);
    function percentile(arr, p) { return arr[Math.min(arr.length-1, Math.floor(arr.length * p))]; }
    const distStats = {
      mean: Math.round(drys.reduce((a,b) => a+b, 0) / drys.length),
      median: percentile(drys, 0.5),
      p25: percentile(drys, 0.25),
      p75: percentile(drys, 0.75),
      p90: percentile(drys, 0.9),
      p95: percentile(drys, 0.95),
      p99: percentile(drys, 0.99),
      min: drys[0],
      max: drys[drys.length - 1],
      n: drys.length,
    };
    // Histogram in 200-draw buckets
    const histogram = [];
    const bucketSize = 200;
    const maxDry = Math.max(...drys);
    for (let b = 0; b <= maxDry; b += bucketSize) {
      const count = drys.filter(d => d >= b && d < b + bucketSize).length;
      histogram.push({ bucket_start: b, bucket_end: b + bucketSize - 1, count });
    }
    res.json({ success: true, data: {
      total_draws_scanned: totalDraws,
      qualifying_universe: Object.keys(qualifying).length,
      total_universe: 10000,
      house_edge_pct: Number(HOUSE_EDGE_PCT.toFixed(1)),
      sweep,
      best: bestROI,
      best_overall_unreliable: bestOverall,
      distribution: distStats,
      histogram,
      currently_actionable: {
        threshold_used: bestROI.threshold,
        count: actionable.length,
        list: actionable.slice(0, 25),
      },
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Multi-variant H1→H2 strategy tester with filters ────────────────
// Runs a sweep of strategy variants: vary H1 1st-prize-hit-count required,
// minimum-longest-dry-spell filter, and top-K-by-dry filter. For each
// variant: aggregate cost/revenue/ROI across all years, compare to
// random house-edge baseline (~-34%). Want to see if ANY combination
// produces a positive (or at least better-than-random) edge.
app.get("/api/fourd/h1-h2-multi-test", (req, res) => {
  try {
    const PAY = { first: 2000, second: 1000, third: 490, starter: 250, consol: 60 };
    const EXPECTED_PER_DOLLAR = (2000 + 1000 + 490 + 10*250 + 10*60) / 10000;
    const HOUSE_EDGE_PCT = (1 - EXPECTED_PER_DOLLAR) * 100;
    const rows = db.prepare(
      "SELECT draw_date, first_prize, second_prize, third_prize, starter_prizes, consolation_prizes FROM fourd_draws ORDER BY draw_date ASC"
    ).all();
    const totalDraws = rows.length;
    // Precompute each number's draw indices where it hit (any tier) so we can
    // calculate longest-dry-up-to-some-date.
    const numHitIdx = {};
    rows.forEach((r, idx) => {
      function add(num) {
        if (num == null) return;
        const k = String(num).padStart(4, "0");
        if (!numHitIdx[k]) numHitIdx[k] = [];
        numHitIdx[k].push(idx);
      }
      add(r.first_prize); add(r.second_prize); add(r.third_prize);
      try { JSON.parse(r.starter_prizes || "[]").forEach(add); } catch {}
      try { JSON.parse(r.consolation_prizes || "[]").forEach(add); } catch {}
    });
    // Compute longest dry spell of number up to (and including) a given draw index
    function longestDryUpTo(num, upToIdx) {
      const hits = numHitIdx[num] || [];
      let longest = 0;
      let prev = -1;
      for (const h of hits) {
        if (h > upToIdx) break;
        if (prev >= 0) longest = Math.max(longest, h - prev);
        prev = h;
      }
      // Also include open gap from last hit to upToIdx
      if (prev >= 0) longest = Math.max(longest, upToIdx - prev);
      return longest;
    }
    // Split rows into year halves
    const byYear = {};
    rows.forEach((r, idx) => {
      const [y, m] = r.draw_date.split("-").map(Number);
      if (!byYear[y]) byYear[y] = { h1: [], h2: [], h1End: -1 };
      const slot = m <= 6 ? "h1" : "h2";
      byYear[y][slot].push({ row: r, idx });
      if (slot === "h1") byYear[y].h1End = idx;
    });
    function runStrategy({ hit_count_filter, min_dry, top_k }) {
      let totalCost = 0, totalRev = 0, totalQualifying = 0, profitableYears = 0;
      const yearlyResults = [];
      const yearsSorted = Object.keys(byYear).map(Number).sort((a,b) => a-b);
      for (const y of yearsSorted) {
        const { h1, h2, h1End } = byYear[y];
        if (h1.length < 30 || h2.length < 30) continue;
        // Count H1 1st-prize hits per number
        const h1FirstCount = {};
        for (const { row } of h1) h1FirstCount[row.first_prize] = (h1FirstCount[row.first_prize] || 0) + 1;
        // Apply hit-count filter
        let candidates;
        if (hit_count_filter === "any") candidates = Object.keys(h1FirstCount);
        else if (hit_count_filter === "1") candidates = Object.entries(h1FirstCount).filter(([_, c]) => c === 1).map(([n]) => n);
        else if (hit_count_filter === "2+") candidates = Object.entries(h1FirstCount).filter(([_, c]) => c >= 2).map(([n]) => n);
        else if (hit_count_filter === "3+") candidates = Object.entries(h1FirstCount).filter(([_, c]) => c >= 3).map(([n]) => n);
        else candidates = Object.keys(h1FirstCount);
        // Apply longest-dry filter (computed UP TO end of H1, no look-ahead)
        if (min_dry > 0) {
          candidates = candidates.filter(n => longestDryUpTo(n, h1End) >= min_dry);
        }
        // Apply top_k by dry-spell
        if (top_k > 0 && candidates.length > top_k) {
          const withDry = candidates.map(n => ({ n, dry: longestDryUpTo(n, h1End) }));
          withDry.sort((a, b) => b.dry - a.dry);
          candidates = withDry.slice(0, top_k).map(x => x.n);
        }
        if (!candidates.length) continue;
        const winnerSet = new Set(candidates);
        let cost = candidates.length * h2.length;
        let revenue = 0;
        for (const { row } of h2) {
          if (winnerSet.has(row.first_prize))  revenue += PAY.first;
          if (winnerSet.has(row.second_prize)) revenue += PAY.second;
          if (winnerSet.has(row.third_prize))  revenue += PAY.third;
          try { JSON.parse(row.starter_prizes || "[]").forEach(p => { if (winnerSet.has(p)) revenue += PAY.starter; }); } catch {}
          try { JSON.parse(row.consolation_prizes || "[]").forEach(p => { if (winnerSet.has(p)) revenue += PAY.consol; }); } catch {}
        }
        const profit = revenue - cost;
        if (profit > 0) profitableYears++;
        totalCost += cost; totalRev += revenue; totalQualifying += candidates.length;
        yearlyResults.push({ year: y, qual: candidates.length, cost, revenue, profit });
      }
      const overallROI = totalCost > 0 ? Number(((totalRev - totalCost) / totalCost * 100).toFixed(1)) : 0;
      const vsRandom = Math.round(totalRev - totalCost * EXPECTED_PER_DOLLAR);
      return {
        avg_qualifying_per_year: yearlyResults.length > 0 ? Math.round(totalQualifying / yearlyResults.length) : 0,
        years_tested: yearlyResults.length,
        profitable_years: profitableYears,
        total_cost: totalCost,
        total_revenue: totalRev,
        net_profit: totalRev - totalCost,
        roi_pct: overallROI,
        vs_random: vsRandom,
      };
    }
    // Define grid of strategies to test
    const variants = [];
    const hitFilters = ["1", "2+", "3+", "any"];
    const minDrys = [0, 100, 200, 300, 500, 1000];
    for (const hc of hitFilters) {
      for (const md of minDrys) {
        variants.push({ name: `hits=${hc} · dry≥${md}`, hit_count_filter: hc, min_dry: md, top_k: 0 });
      }
    }
    // Plus top-K by dry (using multiple base filters)
    for (const k of [1, 2, 3, 5, 7, 10, 15, 20, 30, 50]) {
      variants.push({ name: `hits=1 · top-${k} by dry`, hit_count_filter: "1", min_dry: 0, top_k: k });
      variants.push({ name: `hits=any · top-${k} by dry`, hit_count_filter: "any", min_dry: 0, top_k: k });
      variants.push({ name: `hits=2+ · top-${k} by dry`, hit_count_filter: "2+", min_dry: 0, top_k: k });
    }
    const results = variants.map(v => ({ name: v.name, params: v, ...runStrategy(v) }));
    // Sort by ROI descending
    results.sort((a, b) => b.roi_pct - a.roi_pct);
    res.json({ success: true, data: {
      strategy_grid_size: variants.length,
      house_edge_pct: Number(HOUSE_EDGE_PCT.toFixed(1)),
      best_variants: results.slice(0, 10),
      worst_variants: results.slice(-5).reverse(),
      all_results: results,
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── H1 1st-prize → H2 bet Backtest ───────────────────────────────────
// Strategy: For each year, find numbers that won 1st prize EXACTLY ONCE
// in Jan-Jun (H1). Bet $1 Big per H2 draw on each qualifying number.
// Aggregate profit across all years. Random baseline included for honest
// comparison — Singapore Pools' built-in house edge is ~34%, so any
// strategy needs to beat that to be considered "doing something".
app.get("/api/fourd/h1-to-h2-backtest", (req, res) => {
  try {
    const PAY = { first: 2000, second: 1000, third: 490, starter: 250, consol: 60 };
    // Random-baseline expected revenue per $1 per draw on any number:
    // 1/10000 × $2000 + 1/10000 × $1000 + 1/10000 × $490 + 10/10000 × $250 + 10/10000 × $60
    const EXPECTED_PER_DOLLAR = (2000 + 1000 + 490 + 10*250 + 10*60) / 10000;   // = $0.659
    const HOUSE_EDGE_PCT = (1 - EXPECTED_PER_DOLLAR) * 100;                      // ~34.1%
    const rows = db.prepare(
      "SELECT draw_date, first_prize, second_prize, third_prize, starter_prizes, consolation_prizes FROM fourd_draws ORDER BY draw_date ASC"
    ).all();
    const byYear = {};
    for (const r of rows) {
      const [y, m] = r.draw_date.split("-").map(Number);
      if (!byYear[y]) byYear[y] = { h1: [], h2: [] };
      if (m <= 6) byYear[y].h1.push(r);
      else byYear[y].h2.push(r);
    }
    const years = Object.keys(byYear).map(Number).sort((a,b) => a-b);
    const yearResults = [];
    for (const y of years) {
      const { h1, h2 } = byYear[y];
      if (h1.length < 30 || h2.length < 30) continue;
      const firstPrizeCount = {};
      for (const r of h1) firstPrizeCount[r.first_prize] = (firstPrizeCount[r.first_prize] || 0) + 1;
      const onceWinners = Object.entries(firstPrizeCount).filter(([_, c]) => c === 1).map(([n]) => n);
      const winnerSet = new Set(onceWinners);
      let cost = onceWinners.length * h2.length;       // $1/number/draw
      let revenue = 0;
      const tierHits = { first:0, second:0, third:0, starter:0, consol:0 };
      for (const r of h2) {
        if (winnerSet.has(r.first_prize))  { revenue += PAY.first;  tierHits.first++; }
        if (winnerSet.has(r.second_prize)) { revenue += PAY.second; tierHits.second++; }
        if (winnerSet.has(r.third_prize))  { revenue += PAY.third;  tierHits.third++; }
        try { JSON.parse(r.starter_prizes || "[]").forEach(p => { if (winnerSet.has(p)) { revenue += PAY.starter; tierHits.starter++; } }); } catch {}
        try { JSON.parse(r.consolation_prizes || "[]").forEach(p => { if (winnerSet.has(p)) { revenue += PAY.consol; tierHits.consol++; } }); } catch {}
      }
      const profit = revenue - cost;
      const expectedRandomRevenue = cost * EXPECTED_PER_DOLLAR;
      const vsRandom = revenue - expectedRandomRevenue;
      yearResults.push({
        year: y,
        h1_draws: h1.length,
        h2_draws: h2.length,
        qualifying_numbers: onceWinners.length,
        cost, revenue, profit,
        roi_pct: cost > 0 ? Number(((profit / cost) * 100).toFixed(1)) : 0,
        total_hits: tierHits.first + tierHits.second + tierHits.third + tierHits.starter + tierHits.consol,
        tier_hits: tierHits,
        expected_random_revenue: Math.round(expectedRandomRevenue),
        vs_random: Math.round(vsRandom),
      });
    }
    let totalCost = 0, totalRev = 0, totalHits = 0, totalQualifying = 0, profitableYears = 0;
    yearResults.forEach(y => {
      totalCost += y.cost; totalRev += y.revenue; totalHits += y.total_hits;
      totalQualifying += y.qualifying_numbers;
      if (y.profit > 0) profitableYears++;
    });
    const aggregate = {
      years_tested: yearResults.length,
      total_qualifying_numbers: totalQualifying,
      avg_qualifying_per_year: yearResults.length > 0 ? Math.round(totalQualifying / yearResults.length) : 0,
      total_cost: totalCost,
      total_revenue: totalRev,
      total_profit: totalRev - totalCost,
      total_hits: totalHits,
      overall_roi_pct: totalCost > 0 ? Number(((totalRev - totalCost) / totalCost * 100).toFixed(1)) : 0,
      profitable_years: profitableYears,
      losing_years: yearResults.length - profitableYears,
      expected_random_revenue: Math.round(totalCost * EXPECTED_PER_DOLLAR),
      vs_random: Math.round(totalRev - totalCost * EXPECTED_PER_DOLLAR),
      house_edge_pct: Number(HOUSE_EDGE_PCT.toFixed(1)),
    };
    res.json({ success: true, data: {
      strategy: "For each year: find 4D numbers that won 1st prize EXACTLY ONCE in Jan-Jun (H1). Bet $1 Big per H2 (Jul-Dec) draw on each qualifying number. House edge baseline: ~34.1% (random picks lose 34¢ per $1 over time).",
      aggregate,
      yearly: yearResults,
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Dry-Spell 90% Backtest ───────────────────────────────────────────
// Strategy: walk a number's hit history. After every hit, watch the next
// gap. If/when current gap reaches 90% of the LONGEST dry spell observed
// SO FAR (no look-ahead), start betting $1 per draw until the number hits.
// Then record cost vs payout. Aggregate across all 10,000 numbers.
app.get("/api/fourd/dry-spell-backtest", (req, res) => {
  try {
    const THRESHOLD_PCT = parseInt(req.query.threshold || "90", 10) / 100;
    const PAY = { first: 2000, second: 1000, third: 490, starter: 250, consol: 60 };
    const rows = db.prepare(
      "SELECT draw_date, first_prize, second_prize, third_prize, starter_prizes, consolation_prizes FROM fourd_draws ORDER BY draw_date ASC, draw_no ASC"
    ).all();
    const totalDraws = rows.length;
    const numHits = {};
    rows.forEach((r, idx) => {
      function add(num, tier) {
        if (num == null) return;
        const k = String(num).padStart(4, "0");
        if (!numHits[k]) numHits[k] = [];
        numHits[k].push({ idx, date: r.draw_date, tier, payout: PAY[tier] });
      }
      add(r.first_prize, "first");
      add(r.second_prize, "second");
      add(r.third_prize, "third");
      try { JSON.parse(r.starter_prizes || "[]").forEach(p => add(p, "starter")); } catch {}
      try { JSON.parse(r.consolation_prizes || "[]").forEach(p => add(p, "consol")); } catch {}
    });

    const results = [];
    for (const k of Object.keys(numHits)) {
      const hits = numHits[k];
      if (hits.length < 5) continue;
      let totalCost = 0, totalRevenue = 0, betRuns = 0, winRuns = 0;
      let longestDrySoFar = 0;
      const sampleRuns = [];
      for (let i = 1; i < hits.length; i++) {
        const gapLen = hits[i].idx - hits[i - 1].idx;        // # of draws from last hit to this hit
        if (longestDrySoFar > 0) {
          const threshold = Math.floor(THRESHOLD_PCT * longestDrySoFar);
          if (gapLen >= threshold && threshold > 0) {
            // Start betting at draw where gap = threshold
            const startBetIdx = hits[i - 1].idx + threshold;
            const drawsBet = hits[i].idx - startBetIdx + 1;
            const cost = drawsBet;
            const revenue = hits[i].payout;
            const profit = revenue - cost;
            totalCost += cost;
            totalRevenue += revenue;
            betRuns++;
            if (profit > 0) winRuns++;
            if (sampleRuns.length < 5) sampleRuns.push({
              triggered_at: threshold,
              longest_dry_seen: longestDrySoFar,
              draws_bet: drawsBet,
              hit_date: hits[i].date,
              hit_tier: hits[i].tier,
              payout: revenue,
              profit,
            });
          }
        }
        if (gapLen > longestDrySoFar) longestDrySoFar = gapLen;
      }
      // Handle open gap (right now): are we currently in a bet run?
      const lastHitIdx = hits[hits.length - 1].idx;
      const currentGap = totalDraws - 1 - lastHitIdx;
      const currentThreshold = Math.floor(THRESHOLD_PCT * longestDrySoFar);
      const currentlyBetting = currentGap >= currentThreshold && currentThreshold > 0;
      const drawsBetOpen = currentlyBetting ? (currentGap - currentThreshold + 1) : 0;
      const finalProfit = totalRevenue - totalCost - drawsBetOpen;     // pending bets count as cost
      const winRate = betRuns > 0 ? Math.round(winRuns / betRuns * 100) : 0;
      results.push({
        number: k,
        total_lifetime_hits: hits.length,
        longest_dry: longestDrySoFar,
        current_gap: currentGap,
        currently_betting: currentlyBetting,
        draws_bet_open: drawsBetOpen,
        last_hit_date: hits[hits.length - 1].date,
        last_hit_tier: hits[hits.length - 1].tier,
        bet_runs: betRuns,
        win_runs: winRuns,
        loss_runs: betRuns - winRuns,
        win_rate_pct: winRate,
        total_cost: totalCost + drawsBetOpen,
        total_revenue: totalRevenue,
        total_profit: finalProfit,
        roi_pct: (totalCost + drawsBetOpen) > 0 ? Number(((finalProfit) / (totalCost + drawsBetOpen) * 100).toFixed(1)) : 0,
        sample_runs: sampleRuns.slice(-3),
      });
    }
    // Aggregate
    let totalCostAgg = 0, totalRevAgg = 0, totalRuns = 0, totalWins = 0, profitableNumbers = 0, losingNumbers = 0, breakEvenNumbers = 0;
    results.forEach(x => {
      totalCostAgg += x.total_cost;
      totalRevAgg += x.total_revenue;
      totalRuns += x.bet_runs;
      totalWins += x.win_runs;
      if (x.total_profit > 0) profitableNumbers++;
      else if (x.total_profit < 0) losingNumbers++;
      else breakEvenNumbers++;
    });
    const aggregate = {
      numbers_tested: results.length,
      total_bet_runs: totalRuns,
      total_wins: totalWins,
      total_losses: totalRuns - totalWins,
      win_rate_pct: totalRuns > 0 ? Math.round(totalWins / totalRuns * 100) : 0,
      total_cost: totalCostAgg,
      total_revenue: totalRevAgg,
      total_profit: totalRevAgg - totalCostAgg,
      avg_profit_per_number: results.length > 0 ? Math.round((totalRevAgg - totalCostAgg) / results.length) : 0,
      profitable_numbers: profitableNumbers,
      losing_numbers: losingNumbers,
      break_even_numbers: breakEvenNumbers,
    };
    results.sort((a, b) => b.total_profit - a.total_profit);
    res.json({ success: true, data: {
      total_draws_scanned: totalDraws,
      threshold_pct: Math.round(THRESHOLD_PCT * 100),
      strategy: `Walk-forward backtest. For each number: after each hit, watch next gap. When current gap reaches ${Math.round(THRESHOLD_PCT*100)}% of the longest dry spell seen SO FAR (no look-ahead), start betting $1 Big per draw until the number hits.`,
      aggregate,
      top_winners: results.slice(0, 15),
      top_losers: results.slice(-15).reverse(),
      currently_actionable: results.filter(x => x.currently_betting).sort((a, b) => b.total_profit - a.total_profit).slice(0, 15),
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Yearly Regulars — numbers that hit consistently year over year ───
// For each number, measure how MANY distinct years it has appeared in (any
// prize tier). High year-coverage % = the number "keeps coming back". A
// 4-hit year with 5-year drought after counts the year ONCE, not 4× — this
// prevents the metric from being skewed by clusters.
app.get("/api/fourd/yearly-regulars", cache.withCache((req, res) => {
  try {
    const PAY = { first: 2000, second: 1000, third: 490, starter: 250, consol: 60 };
    const rows = db.prepare(
      "SELECT draw_date, first_prize, second_prize, third_prize, starter_prizes, consolation_prizes FROM fourd_draws"
    ).all();
    const totalDraws = rows.length;
    const numHistory = {};        // num → [{year, date, tier, payout}]
    const yearDraws = {};
    for (const r of rows) {
      const y = parseInt(r.draw_date.slice(0, 4), 10);
      yearDraws[y] = (yearDraws[y] || 0) + 1;
      function add(num, tier) {
        if (num == null) return;
        const k = String(num).padStart(4, "0");
        if (!numHistory[k]) numHistory[k] = [];
        numHistory[k].push({ year: y, date: r.draw_date, tier, payout: PAY[tier] });
      }
      add(r.first_prize, "first");
      add(r.second_prize, "second");
      add(r.third_prize, "third");
      try { JSON.parse(r.starter_prizes || "[]").forEach(p => add(p, "starter")); } catch {}
      try { JSON.parse(r.consolation_prizes || "[]").forEach(p => add(p, "consol")); } catch {}
    }
    const allYears = Object.keys(yearDraws).map(Number).sort((a,b) => a-b);
    const latestYear = allYears[allYears.length - 1];
    const totalYears = allYears.length;

    function analyzeHistory(hist) {
      const yearsSet = new Set(hist.map(h => h.year));
      const yearsHit = Array.from(yearsSet).sort((a,b) => a-b);
      // Streaks of consecutive hit years
      let longestStreak = 1, currentStreak = 1;
      for (let i = 1; i < yearsHit.length; i++) {
        if (yearsHit[i] - yearsHit[i - 1] === 1) {
          currentStreak++;
          if (currentStreak > longestStreak) longestStreak = currentStreak;
        } else currentStreak = 1;
      }
      // Drought = longest gap between hit years
      let longestDrought = 0;
      const yearGaps = [];
      for (let i = 1; i < yearsHit.length; i++) {
        const gap = yearsHit[i] - yearsHit[i - 1];
        yearGaps.push(gap);
        if (gap - 1 > longestDrought) longestDrought = gap - 1;
      }
      const avgYearGap = yearGaps.length ? Number((yearGaps.reduce((a,b)=>a+b,0) / yearGaps.length).toFixed(2)) : null;
      const yearsSinceLast = latestYear - yearsHit[yearsHit.length - 1];
      const recent10 = yearsHit.filter(y => y > latestYear - 10).length;
      const recent5  = yearsHit.filter(y => y > latestYear - 5).length;
      const tiers = { first:0, second:0, third:0, starter:0, consol:0 };
      const perYear = {};  // year → { first, second, third, starter, consol, total }
      let revenue = 0;
      for (const h of hist) {
        tiers[h.tier]++;
        revenue += h.payout;
        if (!perYear[h.year]) perYear[h.year] = { first:0, second:0, third:0, starter:0, consol:0, total:0 };
        perYear[h.year][h.tier]++;
        perYear[h.year].total++;
      }
      return {
        years_hit: yearsHit.length,
        year_coverage_pct: Math.round(yearsHit.length / totalYears * 100),
        longest_streak: longestStreak,
        longest_drought: longestDrought,
        avg_year_gap: avgYearGap,
        years_since_last_hit: yearsSinceLast,
        last_hit_year: yearsHit[yearsHit.length - 1],
        recent_5y_coverage: recent5,
        recent_10y_coverage: recent10,
        hits_per_active_year: Number((hist.length / yearsHit.length).toFixed(2)),
        tiers, lifetime_profit: revenue - totalDraws,
        years_hit_list: yearsHit,
        per_year_breakdown: perYear,
      };
    }

    // === DIRECT 4D regulars ===
    const directResults = [];
    for (const k of Object.keys(numHistory)) {
      const hist = numHistory[k];
      if (hist.length < 10) continue;
      const a = analyzeHistory(hist);
      directResults.push({ number: k, total_hits: hist.length, ...a });
    }
    directResults.sort((a, b) =>
      b.year_coverage_pct - a.year_coverage_pct ||
      a.longest_drought - b.longest_drought ||
      b.recent_5y_coverage - a.recent_5y_coverage
    );

    // === iBet regulars — group by sorted digits ===
    const ibetHistory = {};        // sortedKey → combined history
    const ibetPerms = {};          // sortedKey → Set of distinct perms
    for (const k of Object.keys(numHistory)) {
      const sortedKey = k.split("").sort().join("");
      if (!ibetHistory[sortedKey]) { ibetHistory[sortedKey] = []; ibetPerms[sortedKey] = new Set(); }
      ibetHistory[sortedKey] = ibetHistory[sortedKey].concat(numHistory[k]);
      ibetPerms[sortedKey].add(k);
    }
    const ibetResults = [];
    for (const sk of Object.keys(ibetHistory)) {
      const hist = ibetHistory[sk];
      if (hist.length < 20) continue;
      const a = analyzeHistory(hist);
      // iBet profit: payouts divided by num unique perms
      const N = (function uniquePerms(s){
        const out = new Set();
        (function rec(arr, cur){
          if (cur.length === 4) { out.add(cur.join("")); return; }
          for (let i = 0; i < arr.length; i++) rec(arr.slice(0,i).concat(arr.slice(i+1)), cur.concat(arr[i]));
        })(s.split(""), []);
        return out;
      })(sk).size;
      const ibetRev = hist.reduce((s, x) => s + x.payout, 0) / N;
      a.lifetime_profit = Math.round(ibetRev - totalDraws);
      ibetResults.push({
        sorted_digits: sk,
        digits: sk.split(""),
        perms_count: N,
        example_perms: Array.from(ibetPerms[sk]).slice(0, 4),
        total_hits: hist.length,
        ...a
      });
    }
    ibetResults.sort((a, b) =>
      b.year_coverage_pct - a.year_coverage_pct ||
      a.longest_drought - b.longest_drought
    );

    res.json({ success: true, data: {
      total_draws_scanned: totalDraws,
      year_range: { from: allYears[0], to: latestYear },
      total_years: totalYears,
      direct_4d: {
        total_candidates: directResults.length,
        most_consistent: directResults.slice(0, 15),
      },
      ibet: {
        total_candidates: ibetResults.length,
        most_consistent: ibetResults.slice(0, 10),
      },
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
}));

// ─── Calendar-Bias Hunter ─────────────────────────────────────────────
// For each 4-digit number with ≥ MIN_HITS lifetime appearances, find its
// strongest monthly concentration. If a number's hits cluster heavily in
// 1-2 months (vs ~8.3% expected per month), it's a candidate for a
// calendar-specific betting strategy: only bet during those months.
// HONEST CAVEAT: with 5,493 draws and 10,000 numbers, most "biases" we find
// will be noise. We only return numbers where the bias is unlikely to be
// random (chi-square or simple Z-score above threshold).
app.get("/api/fourd/calendar-bias", cache.withCache((req, res) => {
  try {
    const MIN_HITS = parseInt(req.query.min_hits || "12", 10);
    const PAY = { first: 2000, second: 1000, third: 490, starter: 250, consol: 60 };
    const rows = db.prepare(
      "SELECT draw_date, first_prize, second_prize, third_prize, starter_prizes, consolation_prizes FROM fourd_draws WHERE draw_date IS NOT NULL"
    ).all();
    // Total draws per month (calendar month 1-12, all years combined)
    const drawsPerMonth = new Array(13).fill(0);
    for (const r of rows) {
      const m = parseInt(r.draw_date.split("-")[1], 10);
      drawsPerMonth[m]++;
    }
    const totalDraws = rows.length;
    // For each number track hits per month, per-tier, and full hit history
    const numHits = {};
    function bump(num, monthIdx, tier, date) {
      if (num == null) return;
      const k = String(num).padStart(4, "0");
      if (!numHits[k]) numHits[k] = {
        months: new Array(13).fill(0),
        tiers: {first:0,second:0,third:0,starter:0,consol:0},
        history: [],          // array of { date, month, tier, payout }
      };
      numHits[k].months[monthIdx]++;
      numHits[k].tiers[tier]++;
      numHits[k].history.push({ date, month: monthIdx, tier, payout: PAY[tier] });
    }
    for (const r of rows) {
      const m = parseInt(r.draw_date.split("-")[1], 10);
      bump(r.first_prize, m, "first", r.draw_date);
      bump(r.second_prize, m, "second", r.draw_date);
      bump(r.third_prize, m, "third", r.draw_date);
      try { JSON.parse(r.starter_prizes || "[]").forEach(p => bump(p, m, "starter", r.draw_date)); } catch {}
      try { JSON.parse(r.consolation_prizes || "[]").forEach(p => bump(p, m, "consol", r.draw_date)); } catch {}
    }
    const monthNames = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const results = [];
    for (const k of Object.keys(numHits)) {
      const h = numHits[k];
      const total = h.months.reduce((a,b) => a+b, 0);
      if (total < MIN_HITS) continue;
      // Find best 2-month window by hit % vs expected % of draws
      let best = { months: [], hits: 0, draws_in_window: 0, lift: 0 };
      // Score each single month
      for (let m = 1; m <= 12; m++) {
        const drawsInMonth = drawsPerMonth[m];
        if (drawsInMonth === 0) continue;
        const expectedHits = total * (drawsInMonth / totalDraws);
        const lift = h.months[m] - expectedHits;
        if (lift > best.lift) best = { months: [m], hits: h.months[m], draws_in_window: drawsInMonth, expected: expectedHits.toFixed(1), lift };
      }
      // Also try best 2-consecutive-month window
      for (let m = 1; m <= 11; m++) {
        const hits = h.months[m] + h.months[m+1];
        const drawsInWindow = drawsPerMonth[m] + drawsPerMonth[m+1];
        if (drawsInWindow === 0) continue;
        const expectedHits = total * (drawsInWindow / totalDraws);
        const lift = hits - expectedHits;
        if (lift > best.lift) best = { months: [m, m+1], hits, draws_in_window: drawsInWindow, expected: expectedHits.toFixed(1), lift };
      }
      if (best.lift <= 0) continue;
      // EXACT cluster-window economics — only count hits whose month is in best window
      const inWindow = h.history.filter(x => best.months.includes(x.month));
      const revInWindow = inWindow.reduce((s, x) => s + x.payout, 0);
      const costInWindow = best.draws_in_window;
      const profit = Math.round(revInWindow - costInWindow);
      // Identify the single biggest hit (the "lucky-strike" — usually a 1st prize)
      let biggestHit = null;
      for (const x of inWindow) if (!biggestHit || x.payout > biggestHit.payout) biggestHit = x;
      const profitWithoutBiggest = biggestHit
        ? Math.round((revInWindow - biggestHit.payout) - costInWindow)
        : profit;
      // Recency check — when did the cluster last actually pay out?
      const sortedInWindow = inWindow.slice().sort((a, b) => b.date.localeCompare(a.date));
      const lastClusterHit = sortedInWindow.length ? sortedInWindow[0] : null;
      // Cluster hits in last 10 years
      const cutoff10 = String(new Date().getFullYear() - 10);
      const clusterHitsRecent = inWindow.filter(x => x.date.slice(0,4) >= cutoff10).length;
      // Z-score for one-month bias (approximate, n=total)
      const p = best.draws_in_window / totalDraws;
      const expected = total * p;
      const sd = Math.sqrt(total * p * (1 - p));
      const z = sd > 0 ? (best.hits - expected) / sd : 0;
      if (z < 2.0) continue;     // require z ≥ 2 (rough p < 0.05)
      // iBet variant: payout divided by number of unique permutations
      const N_perms = new Set(
        (function uniquePerms(s){
          const out = new Set();
          (function rec(arr, cur){
            if (cur.length === 4) { out.add(cur.join("")); return; }
            for (let i = 0; i < arr.length; i++) rec(arr.slice(0,i).concat(arr.slice(i+1)), cur.concat(arr[i]));
          })(s.split(""), []);
          return out;
        })(k)
      ).size;
      const ibetRev = revInWindow / N_perms;
      const ibetProfit = Math.round(ibetRev - costInWindow);
      const hitsOutside = total - best.hits;
      const drawsOutside = totalDraws - best.draws_in_window;
      results.push({
        number: k,
        total_hits: total,
        best_months: best.months.map(m => monthNames[m]),
        hits_in_window: best.hits,
        draws_in_window: best.draws_in_window,
        hits_outside: hitsOutside,
        draws_outside: drawsOutside,
        expected_hits: Number(best.expected),
        lift: Number(best.lift.toFixed(1)),
        z_score: Number(z.toFixed(2)),
        big_profit_only_window: profit,
        big_profit_without_biggest_hit: profitWithoutBiggest,
        biggest_hit: biggestHit ? { date: biggestHit.date, tier: biggestHit.tier, payout: biggestHit.payout } : null,
        last_cluster_hit: lastClusterHit ? { date: lastClusterHit.date, tier: lastClusterHit.tier } : null,
        cluster_hits_recent_10y: clusterHitsRecent,
        ibet_perms: N_perms,
        ibet_profit_only_window: ibetProfit,
        monthly_hits: h.months.slice(1),
      });
    }
    results.sort((a, b) => b.z_score - a.z_score);
    res.json({ success: true, data: {
      total_draws_scanned: totalDraws,
      min_hits_threshold: MIN_HITS,
      total_candidates: results.length,
      top: results.slice(0, 10),
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
}));

// ─── $1 Big-Bet Simulator ─────────────────────────────────────────────
// For each 4-digit number 0000-9999: if you bet $1 (Big) on it for every
// single 4D draw in the archive, how much would you have won?
// SG Pools $1 Big payouts: 1st $2000, 2nd $1000, 3rd $490, starter $250,
// consolation $60 per hit.
app.get("/api/fourd/dollar-sim", cache.withCache((req, res) => {
  try {
    const PAY = { first: 2000, second: 1000, third: 490, starter: 250, consol: 60 };
    const rows = db.prepare(
      "SELECT first_prize, second_prize, third_prize, starter_prizes, consolation_prizes FROM fourd_draws"
    ).all();
    const totalDraws = rows.length;
    // Tally hits per 4-digit number across all prize tiers
    const hits = {};
    function add(num, key) {
      if (num == null) return;
      const k = String(num).padStart(4, "0");
      if (!hits[k]) hits[k] = { first: 0, second: 0, third: 0, starter: 0, consol: 0 };
      hits[k][key]++;
    }
    for (const r of rows) {
      add(r.first_prize, "first");
      add(r.second_prize, "second");
      add(r.third_prize, "third");
      try { JSON.parse(r.starter_prizes || "[]").forEach(p => add(p, "starter")); } catch {}
      try { JSON.parse(r.consolation_prizes || "[]").forEach(p => add(p, "consol")); } catch {}
    }
    const results = [];
    for (const k of Object.keys(hits)) {
      const h = hits[k];
      const revenue = h.first * PAY.first + h.second * PAY.second + h.third * PAY.third
                    + h.starter * PAY.starter + h.consol * PAY.consol;
      const cost = totalDraws;     // $1 every draw
      results.push({ number: k, ...h, revenue, cost, profit: revenue - cost, roi_pct: ((revenue - cost) / cost * 100).toFixed(1) });
    }
    results.sort((a, b) => b.profit - a.profit);
    res.json({ success: true, data: {
      total_draws_scanned: totalDraws,
      payouts: PAY,
      most_profitable: results.slice(0, 10),
      least_profitable: results.slice(-10).reverse(),
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
}));

// Year-by-year $1 Big-bet profit for a specific number
app.get("/api/fourd/dollar-sim-yearly", (req, res) => {
  try {
    const num = String(req.query.num || "").replace(/\D/g, "").padStart(4, "0").slice(0, 4);
    if (num.length !== 4) return res.status(400).json({ success: false, error: "Need 4 digits" });
    const PAY = { first: 2000, second: 1000, third: 490, starter: 250, consol: 60 };
    const rows = db.prepare(
      "SELECT draw_date, first_prize, second_prize, third_prize, starter_prizes, consolation_prizes FROM fourd_draws"
    ).all();
    const byYear = {};
    for (const r of rows) {
      const y = new Date(r.draw_date).getUTCFullYear();
      if (!byYear[y]) byYear[y] = { year: y, draws: 0, first:0, second:0, third:0, starter:0, consol:0 };
      byYear[y].draws++;
      if (String(r.first_prize).padStart(4,"0") === num) byYear[y].first++;
      if (String(r.second_prize).padStart(4,"0") === num) byYear[y].second++;
      if (String(r.third_prize).padStart(4,"0") === num) byYear[y].third++;
      try { if (JSON.parse(r.starter_prizes || "[]").includes(num)) byYear[y].starter++; } catch {}
      try { if (JSON.parse(r.consolation_prizes || "[]").includes(num)) byYear[y].consol++; } catch {}
    }
    const years = Object.values(byYear).sort((a,b) => a.year - b.year).map(y => {
      const revenue = y.first*PAY.first + y.second*PAY.second + y.third*PAY.third + y.starter*PAY.starter + y.consol*PAY.consol;
      const cost = y.draws;
      return { year: y.year, draws: y.draws, hits: y.first+y.second+y.third+y.starter+y.consol,
               first: y.first, second: y.second, third: y.third, starter: y.starter, consol: y.consol,
               revenue, cost, profit: revenue - cost };
    });
    res.json({ success: true, data: { number: num, years }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// For each year, the single most-profitable number under $1 Big bet
app.get("/api/fourd/dollar-sim-yearly-winners", (req, res) => {
  try {
    const PAY = { first: 2000, second: 1000, third: 490, starter: 250, consol: 60 };
    const rows = db.prepare(
      "SELECT draw_date, first_prize, second_prize, third_prize, starter_prizes, consolation_prizes FROM fourd_draws"
    ).all();
    const byYear = {};       // year → { drawCount, hits[num] }
    for (const r of rows) {
      const y = new Date(r.draw_date).getUTCFullYear();
      if (!byYear[y]) byYear[y] = { year: y, draws: 0, hits: {} };
      byYear[y].draws++;
      function add(num, key) {
        if (num == null) return;
        const k = String(num).padStart(4,"0");
        if (!byYear[y].hits[k]) byYear[y].hits[k] = { first:0,second:0,third:0,starter:0,consol:0 };
        byYear[y].hits[k][key]++;
      }
      add(r.first_prize, "first"); add(r.second_prize, "second"); add(r.third_prize, "third");
      try { JSON.parse(r.starter_prizes || "[]").forEach(p => add(p, "starter")); } catch {}
      try { JSON.parse(r.consolation_prizes || "[]").forEach(p => add(p, "consol")); } catch {}
    }
    const years = Object.values(byYear).sort((a,b) => a.year - b.year).map(y => {
      let best = null;
      for (const num of Object.keys(y.hits)) {
        const h = y.hits[num];
        const revenue = h.first*PAY.first + h.second*PAY.second + h.third*PAY.third + h.starter*PAY.starter + h.consol*PAY.consol;
        const profit = revenue - y.draws;
        if (!best || profit > best.profit) best = { number: num, ...h, revenue, cost: y.draws, profit, roi: ((profit/y.draws)*100).toFixed(0) };
      }
      return { year: y.year, draws: y.draws, ...best };
    });
    res.json({ success: true, data: { years }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Lookup a specific number's $1 simulator result
app.get("/api/fourd/dollar-sim-lookup", (req, res) => {
  try {
    const num = String(req.query.num || "").replace(/\D/g, "").padStart(4, "0").slice(0, 4);
    if (num.length !== 4) return res.status(400).json({ success: false, error: "Need 4 digits" });
    const PAY = { first: 2000, second: 1000, third: 490, starter: 250, consol: 60 };
    const rows = db.prepare(
      "SELECT first_prize, second_prize, third_prize, starter_prizes, consolation_prizes FROM fourd_draws"
    ).all();
    let h = { first: 0, second: 0, third: 0, starter: 0, consol: 0 };
    for (const r of rows) {
      if (String(r.first_prize).padStart(4,"0") === num) h.first++;
      if (String(r.second_prize).padStart(4,"0") === num) h.second++;
      if (String(r.third_prize).padStart(4,"0") === num) h.third++;
      try { if (JSON.parse(r.starter_prizes || "[]").includes(num)) h.starter++; } catch {}
      try { if (JSON.parse(r.consolation_prizes || "[]").includes(num)) h.consol++; } catch {}
    }
    const revenue = h.first * PAY.first + h.second * PAY.second + h.third * PAY.third
                  + h.starter * PAY.starter + h.consol * PAY.consol;
    const cost = rows.length;
    res.json({ success: true, data: {
      number: num,
      ...h,
      total_hits: h.first + h.second + h.third + h.starter + h.consol,
      revenue, cost, profit: revenue - cost, roi_pct: ((revenue - cost) / cost * 100).toFixed(1),
      total_draws_scanned: rows.length,
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── iBet $1 Bet Simulator ────────────────────────────────────────────
// For a 4-digit input, treat it as an iBet (any permutation wins).
// Payout = Big prize ÷ number_of_unique_permutations.
// e.g. iBet $1 on 1234 (24 perms): 1st prize pays $2000/24 ≈ $83.
function uniquePerms(digits) {
  const seen = new Set();
  const out = [];
  (function gen(arr, cur) {
    if (cur.length === 4) {
      const k = cur.join("");
      if (!seen.has(k)) { seen.add(k); out.push(k); }
      return;
    }
    for (let i = 0; i < arr.length; i++) {
      gen(arr.slice(0, i).concat(arr.slice(i+1)), cur.concat(arr[i]));
    }
  })(digits.split(""), []);
  return out;
}

function simulateIbet(num, rows, PAY) {
  const perms = uniquePerms(String(num).padStart(4, "0"));
  const N = perms.length;
  const permSet = new Set(perms);
  let first = 0, second = 0, third = 0, starter = 0, consol = 0;
  for (const r of rows) {
    if (permSet.has(String(r.first_prize).padStart(4, "0"))) first++;
    if (permSet.has(String(r.second_prize).padStart(4, "0"))) second++;
    if (permSet.has(String(r.third_prize).padStart(4, "0"))) third++;
    try { JSON.parse(r.starter_prizes || "[]").forEach(p => { if (permSet.has(String(p).padStart(4, "0"))) starter++; }); } catch {}
    try { JSON.parse(r.consolation_prizes || "[]").forEach(p => { if (permSet.has(String(p).padStart(4, "0"))) consol++; }); } catch {}
  }
  // Per-hit payout = Big payout ÷ N permutations
  const firstRev   = Math.round(first   * PAY.first   / N);
  const secondRev  = Math.round(second  * PAY.second  / N);
  const thirdRev   = Math.round(third   * PAY.third   / N);
  const starterRev = Math.round(starter * PAY.starter / N);
  const consolRev  = Math.round(consol  * PAY.consol  / N);
  const revenue    = firstRev + secondRev + thirdRev + starterRev + consolRev;
  const cost = rows.length;
  return {
    number: String(num).padStart(4, "0"),
    unique_perms: N,
    first, second, third, starter, consol,
    revenue_by_tier: { first: firstRev, second: secondRev, third: thirdRev, starter: starterRev, consol: consolRev },
    per_hit_payout:  { first: Math.round(PAY.first/N), second: Math.round(PAY.second/N), third: Math.round(PAY.third/N), starter: Math.round(PAY.starter/N), consol: Math.round(PAY.consol/N) },
    total_hits: first + second + third + starter + consol,
    revenue,
    cost,
    profit: revenue - cost,
    roi_pct: ((revenue - cost) / cost * 100).toFixed(1),
  };
}

app.get("/api/fourd/ibet-sim", cache.withCache((req, res) => {
  try {
    const PAY = { first: 2000, second: 1000, third: 500, starter: 250, consol: 60 };
    const rows = db.prepare(
      "SELECT first_prize, second_prize, third_prize, starter_prizes, consolation_prizes FROM fourd_draws"
    ).all();
    // Rank by profit across distinct iBet *sets* (sorted digits = unique set)
    const seen = new Set();
    const results = [];
    for (let n = 0; n < 10000; n++) {
      const k = String(n).padStart(4, "0").split("").sort().join("");
      if (seen.has(k)) continue;
      seen.add(k);
      results.push(simulateIbet(n, rows, PAY));
    }
    results.sort((a, b) => b.profit - a.profit);
    res.json({ success: true, data: {
      total_draws_scanned: rows.length,
      total_unique_sets: results.length,
      payouts: PAY,
      most_profitable: results.slice(0, 10),
      least_profitable: results.slice(-10).reverse(),
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
}));

app.get("/api/fourd/ibet-sim-lookup", (req, res) => {
  try {
    const num = String(req.query.num || "").replace(/\D/g, "").padStart(4, "0").slice(0, 4);
    if (num.length !== 4) return res.status(400).json({ success: false, error: "Need 4 digits" });
    const PAY = { first: 2000, second: 1000, third: 490, starter: 250, consol: 60 };
    const rows = db.prepare(
      "SELECT first_prize, second_prize, third_prize, starter_prizes, consolation_prizes FROM fourd_draws"
    ).all();
    res.json({ success: true, data: { ...simulateIbet(num, rows, PAY), total_draws_scanned: rows.length }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── Top iBet sets — 4-digit multisets with highest total prize hits ───
// Group by sorted-digit key. For a set like {1,2,3,4}, total hits = sum
// of prize-tier hits across all 24 permutations.
app.get("/api/fourd/ibet-top", (req, res) => {
  try {
    const rows = db.prepare(
      "SELECT first_prize, second_prize, third_prize, starter_prizes, consolation_prizes FROM fourd_draws"
    ).all();
    const sets = {};        // sortedDigits → { hits, perms: Set }
    function key(num) {
      return String(num).padStart(4, "0").split("").sort().join("");
    }
    function bump(num) {
      if (num == null) return;
      const k = key(num);
      if (!sets[k]) sets[k] = { total_hits: 0, perms: new Set() };
      sets[k].total_hits++;
      sets[k].perms.add(String(num).padStart(4, "0"));
    }
    for (const r of rows) {
      bump(r.first_prize); bump(r.second_prize); bump(r.third_prize);
      try { JSON.parse(r.starter_prizes || "[]").forEach(bump); } catch {}
      try { JSON.parse(r.consolation_prizes || "[]").forEach(bump); } catch {}
    }
    const ranked = Object.entries(sets).map(([k, v]) => ({
      sorted_digits: k,
      digits: k.split(""),
      total_hits: v.total_hits,
      unique_perms_hit: v.perms.size,
      example_perms: Array.from(v.perms).slice(0, 6),
    })).sort((a, b) => b.total_hits - a.total_hits);
    res.json({ success: true, data: {
      total_draws_scanned: rows.length,
      top: ranked.slice(0, 5),
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── iBet Permutation Checker ─────────────────────────────────────────
// Given 4 digits, generate all unique permutations and count appearances
// in 1st / 2nd / 3rd / starter / consolation across the whole 4D archive.
app.get("/api/fourd/ibet", (req, res) => {
  try {
    const raw = String(req.query.digits || "").replace(/\D/g, "").slice(0, 4);
    if (raw.length !== 4) return res.status(400).json({ success: false, error: "Need exactly 4 digits (e.g. 1234)" });
    // Generate unique permutations of the 4 digits
    const seen = new Set();
    const perms = [];
    (function gen(arr, current) {
      if (current.length === 4) {
        const key = current.join("");
        if (!seen.has(key)) { seen.add(key); perms.push(key); }
        return;
      }
      for (let i = 0; i < arr.length; i++) {
        const next = arr.slice(0, i).concat(arr.slice(i + 1));
        gen(next, current.concat(arr[i]));
      }
    })(raw.split(""), []);

    // Pull every 4D draw once, then check each permutation's hits
    const rows = db.prepare(
      "SELECT first_prize, second_prize, third_prize, starter_prizes, consolation_prizes, draw_no, draw_date FROM fourd_draws"
    ).all();

    const results = perms.map(p => {
      let first = 0, second = 0, third = 0, starter = 0, consol = 0;
      for (const r of rows) {
        if (r.first_prize === p) first++;
        if (r.second_prize === p) second++;
        if (r.third_prize === p) third++;
        try { if (JSON.parse(r.starter_prizes || "[]").includes(p)) starter++; } catch {}
        try { if (JSON.parse(r.consolation_prizes || "[]").includes(p)) consol++; } catch {}
      }
      const totalHits = first + second + third + starter + consol;
      return { perm: p, first, second, third, starter, consol, total: totalHits };
    }).sort((a, b) => b.total - a.total);

    const totalHitsAll = results.reduce((s, r) => s + r.total, 0);
    res.json({ success: true, data: {
      input: raw,
      unique_perms: perms.length,
      total_draws_scanned: rows.length,
      total_ibet_hits: totalHitsAll,
      hit_rate_pct: rows.length ? (totalHitsAll / rows.length * 100).toFixed(2) : 0,
      perms: results,
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── 4D Digit Sum Histogram — sum of the 4 digits of 1st prize ─────────
app.get("/api/fourd/digit-sum", (req, res) => {
  try {
    const rows = db.prepare("SELECT first_prize FROM fourd_draws").all();
    const counts = new Array(37).fill(0);    // sum range 0..36
    for (const r of rows) {
      const s = String(r.first_prize).padStart(4, "0").split("").reduce((a, c) => a + parseInt(c, 10), 0);
      counts[s]++;
    }
    const buckets = [];
    [[0,9],[10,14],[15,18],[19,21],[22,25],[26,30],[31,36]].forEach(([lo, hi]) => {
      let c = 0;
      for (let i = lo; i <= hi; i++) c += counts[i];
      buckets.push({ range: lo + "–" + hi, count: c });
    });
    const per_sum = counts.map((c, i) => ({ sum: i, count: c })).filter(x => x.count > 0);
    res.json({ success: true, data: { total_draws: rows.length, buckets, per_sum }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── 4D Sequential / Consecutive Patterns ──────────────────────────────
// Sequential = digits strictly inc/dec (1234, 9876). Two-pair adjacency etc.
app.get("/api/fourd/sequential", (req, res) => {
  try {
    const rows = db.prepare("SELECT first_prize, draw_no, draw_date FROM fourd_draws ORDER BY draw_no DESC").all();
    let strictlyInc = 0, strictlyDec = 0, threeRun = 0, twoPairRun = 0;
    const recentExamples = { strictlyInc: [], strictlyDec: [], threeRun: [] };
    for (const r of rows) {
      const s = String(r.first_prize).padStart(4, "0");
      const d = s.split("").map(c => parseInt(c, 10));
      const inc = d[1] === d[0] + 1 && d[2] === d[1] + 1 && d[3] === d[2] + 1;
      const dec = d[1] === d[0] - 1 && d[2] === d[1] - 1 && d[3] === d[2] - 1;
      const has3Run = (d[1] === d[0] + 1 && d[2] === d[1] + 1) || (d[2] === d[1] + 1 && d[3] === d[2] + 1) ||
                      (d[1] === d[0] - 1 && d[2] === d[1] - 1) || (d[2] === d[1] - 1 && d[3] === d[2] - 1);
      const hasAdjPair = (Math.abs(d[1]-d[0])===1) || (Math.abs(d[2]-d[1])===1) || (Math.abs(d[3]-d[2])===1);
      if (inc) { strictlyInc++; if (recentExamples.strictlyInc.length < 5) recentExamples.strictlyInc.push({ number: s, draw_no: r.draw_no, draw_date: r.draw_date }); }
      if (dec) { strictlyDec++; if (recentExamples.strictlyDec.length < 5) recentExamples.strictlyDec.push({ number: s, draw_no: r.draw_no, draw_date: r.draw_date }); }
      if (has3Run && !inc && !dec) { threeRun++; if (recentExamples.threeRun.length < 5) recentExamples.threeRun.push({ number: s, draw_no: r.draw_no, draw_date: r.draw_date }); }
      if (hasAdjPair) twoPairRun++;
    }
    res.json({ success: true, data: {
      total_draws: rows.length,
      strictly_inc: strictlyInc,        // 0123, 1234, … 6789
      strictly_dec: strictlyDec,        // 9876, 8765, …
      three_in_a_row: threeRun,         // contains a 3-digit run (but not full 4-run)
      any_adjacent_pair: twoPairRun,    // contains at least one adjacent digit pair
      recent_examples: recentExamples,
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ─── 4D Ending-Digit Frequency — last digit of 1st prize ───────────────
app.get("/api/fourd/ending-digit", (req, res) => {
  try {
    const rows = db.prepare("SELECT first_prize FROM fourd_draws").all();
    const counts = new Array(10).fill(0);
    for (const r of rows) {
      const last = parseInt(String(r.first_prize).slice(-1), 10);
      if (!isNaN(last)) counts[last]++;
    }
    const total = rows.length;
    const expected = total / 10;
    res.json({ success: true, data: {
      total_draws: total,
      expected_per_digit: Math.round(expected),
      per_digit: counts.map((c, d) => ({ digit: d, count: c, vs_expected: c - Math.round(expected) })),
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/api/fourd/repeat-winners", cache.withCache((req, res) => {
  try {
    const rows = db.prepare(
      "SELECT first_prize, draw_no, draw_date FROM fourd_draws ORDER BY draw_no ASC"
    ).all();
    const counts = {};
    const wins = {};
    for (const r of rows) {
      counts[r.first_prize] = (counts[r.first_prize] || 0) + 1;
      if (!wins[r.first_prize]) wins[r.first_prize] = [];
      wins[r.first_prize].push({ draw_no: r.draw_no, draw_date: r.draw_date });
    }
    const repeats = Object.entries(counts).filter(([,c]) => c >= 2)
      .map(([num, c]) => ({ number: num, wins: c, history: wins[num] }))
      .sort((a,b) => b.wins - a.wins);
    res.json({ success: true, data: {
      total_draws_scanned: rows.length,
      unique_winners: Object.keys(counts).length,
      repeat_winners_count: repeats.length,
      top_15: repeats.slice(0, 15),
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
}));

// ─── Best Combos: top number pairs and triples that came out together ─
// Returns the most frequently co-occurring 2-number and 3-number sets in
// the strict 6/49 era. Pure descriptive — same caveat as everywhere else:
// past co-occurrence does NOT predict future draws.
app.get("/api/toto/combos", (req, res) => {
  try {
    const rows = db.prepare(
      "SELECT num1, num2, num3, num4, num5, num6 FROM toto_draws " +
      "WHERE draw_date >= '2014-10-09' AND num6 IS NOT NULL"
    ).all();

    const pairs = {};
    const triples = {};
    for (const r of rows) {
      const nums = [r.num1, r.num2, r.num3, r.num4, r.num5, r.num6].sort((a, b) => a - b);
      for (let i = 0; i < 6; i++) {
        for (let j = i + 1; j < 6; j++) {
          const pk = nums[i] + "-" + nums[j];
          pairs[pk] = (pairs[pk] || 0) + 1;
          for (let k = j + 1; k < 6; k++) {
            const tk = nums[i] + "-" + nums[j] + "-" + nums[k];
            triples[tk] = (triples[tk] || 0) + 1;
          }
        }
      }
    }

    // For "rare pairs" we need every possible pair (including 0-occurrence ones) —
    // start with all C(49,2) at 0 then merge in observed counts.
    const allPairs = {};
    for (let a = 1; a <= 49; a++)
      for (let b = a + 1; b <= 49; b++)
        allPairs[a + "-" + b] = pairs[a + "-" + b] || 0;
    const pairListAll = Object.entries(allPairs)
      .map(([k, c]) => ({ numbers: k.split("-").map(Number), count: c }))
      .sort((a, b) => b.count - a.count);

    // Triples: only the OBSERVED set is sorted descending. Bottom 5 are taken from
    // C(49,3) – sort ascending. Many 0-occurrence triples exist; we pick the first 5
    // in numeric order so the answer is stable across calls.
    const tripleListSorted = Object.entries(triples)
      .map(([k, c]) => ({ numbers: k.split("-").map(Number), count: c }))
      .sort((a, b) => b.count - a.count);

    // Build full triple universe to get rare ones
    const allTriples = {};
    for (let a = 1; a <= 49; a++)
      for (let b = a + 1; b <= 49; b++)
        for (let c = b + 1; c <= 49; c++)
          allTriples[a + "-" + b + "-" + c] = triples[a + "-" + b + "-" + c] || 0;
    const tripleListAll = Object.entries(allTriples)
      .map(([k, c]) => ({ numbers: k.split("-").map(Number), count: c }))
      .sort((a, b) => a.count - b.count || a.numbers[0] - b.numbers[0]);

    res.json({
      success: true,
      data: {
        total_draws:    rows.length,
        top_pairs:      pairListAll.slice(0, 5),
        rare_pairs:     pairListAll.slice(-5).reverse(),       // ascending by count
        top_triples:    tripleListSorted.slice(0, 5),
        rare_triples:   tripleListAll.slice(0, 5),             // 5 with lowest count
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Co-occurrence Explorer ─────────────────────────────────────────
// Given an anchor number N, returns for every other number 1-49 how often
// it appeared in the SAME draw as N. P(Y in draw | N in draw).
// Baseline under uniform random: 5/48 ≈ 10.4% (since 5 other slots, 48 candidates).
app.get("/api/toto/cooccurrence", (req, res) => {
  try {
    const n = parseInt(req.query.n, 10);
    if (!Number.isInteger(n) || n < 1 || n > 49) {
      return res.status(400).json({ success: false, error: "Provide ?n=NUMBER (1-49)" });
    }
    // Only strict 6/49 era — apples-to-apples comparison across all 49 numbers
    const rows = db.prepare(
      "SELECT num1, num2, num3, num4, num5, num6 FROM toto_draws " +
      "WHERE draw_date >= '2014-10-09' AND num6 IS NOT NULL"
    ).all();

    const cooc = {}; for (let k = 1; k <= 49; k++) cooc[k] = 0;
    let drawsWithN = 0;
    for (const r of rows) {
      const set = new Set([r.num1, r.num2, r.num3, r.num4, r.num5, r.num6]);
      if (!set.has(n)) continue;
      drawsWithN++;
      for (const k of set) if (k !== n) cooc[k]++;
    }
    const baseline = 5 / 48;    // expected probability of any specific other number co-appearing
    const list = Object.entries(cooc).map(([k, count]) => ({
      number: parseInt(k),
      count,
      pct: drawsWithN > 0 ? Math.round(count / drawsWithN * 1000) / 10 : 0,
      vs_random_pp: drawsWithN > 0 ? Math.round((count / drawsWithN - baseline) * 1000) / 10 : 0,
    })).filter(x => x.number !== n).sort((a, b) => b.count - a.count);

    res.json({
      success: true,
      data: {
        anchor: n,
        draws_with_anchor: drawsWithN,
        baseline_pct: Math.round(baseline * 1000) / 10,
        most_paired: list.slice(0, 10),
        least_paired: list.slice(-10).reverse(),
        all: list,
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── My Numbers: rich history for a user's saved combination ────────
// Returns aggregate stats so the UI can show "how often have your numbers hit"
app.get("/api/my-numbers/toto", (req, res) => {
  try {
    const nums = String(req.query.nums || "")
      .split(",").map(s => parseInt(s.trim(), 10)).filter(n => n >= 1 && n <= 49);
    if (nums.length !== 6) {
      return res.status(400).json({ success: false, error: "Provide ?nums=n1,n2,n3,n4,n5,n6 (6 numbers 1-49)" });
    }
    const numSet = new Set(nums);

    // Iterate all dated 6/49-era draws
    const rows = db.prepare(
      "SELECT draw_no, draw_date, num1, num2, num3, num4, num5, num6, additional_num " +
      "FROM toto_draws WHERE num6 IS NOT NULL AND draw_date IS NOT NULL ORDER BY draw_no ASC"
    ).all();

    const hitsPerNumber = {};
    nums.forEach(n => hitsPerNumber[n] = { count: 0, last_draw_no: null, last_date: null });
    const hitsPerDraw = { 0:0,1:0,2:0,3:0,4:0,5:0,6:0 };
    let bestDraw = null;
    let lastFullSetMatch = null;

    for (const r of rows) {
      const drawNums = new Set([r.num1, r.num2, r.num3, r.num4, r.num5, r.num6]);
      let hits = 0;
      for (const n of nums) {
        if (drawNums.has(n)) {
          hits++;
          const h = hitsPerNumber[n];
          h.count++;
          h.last_draw_no = r.draw_no;
          h.last_date = r.draw_date;
        }
      }
      hitsPerDraw[hits]++;
      if (!bestDraw || hits > bestDraw.hits) {
        bestDraw = { draw_no: r.draw_no, draw_date: r.draw_date, hits,
                     drawn: [r.num1, r.num2, r.num3, r.num4, r.num5, r.num6],
                     additional_num: r.additional_num };
      }
      if (hits === 6) lastFullSetMatch = { draw_no: r.draw_no, draw_date: r.draw_date };
    }

    res.json({
      success: true,
      data: {
        saved_numbers: nums,
        total_draws_scanned: rows.length,
        hits_per_number: hitsPerNumber,
        hits_distribution: hitsPerDraw,    // {0: 1000, 1: 200, 2: 50, ...}
        best_draw: bestDraw,
        avg_hits_per_draw: rows.length ? (Object.entries(hitsPerDraw).reduce((s,[k,v])=>s+parseInt(k)*v,0) / rows.length) : 0,
        exact_match_draws: hitsPerDraw[6] || 0,
        last_full_set_match: lastFullSetMatch,
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/my-numbers/fourd", (req, res) => {
  try {
    const num = String(req.query.num || "").trim();
    if (!/^\d{4}$/.test(num)) {
      return res.status(400).json({ success: false, error: "Provide ?num=NNNN (4-digit number)" });
    }
    const rows = db.prepare(
      "SELECT draw_no, draw_date, first_prize, second_prize, third_prize, " +
      "starter_prizes, consolation_prizes FROM fourd_draws ORDER BY draw_no ASC"
    ).all();

    const buckets = { first:[], second:[], third:[], starter:[], consolation:[] };
    for (const r of rows) {
      const starters = JSON.parse(r.starter_prizes);
      const consols  = JSON.parse(r.consolation_prizes);
      const ref = { draw_no: r.draw_no, draw_date: r.draw_date };
      if (r.first_prize === num)  buckets.first.push(ref);
      if (r.second_prize === num) buckets.second.push(ref);
      if (r.third_prize === num)  buckets.third.push(ref);
      if (starters.includes(num)) buckets.starter.push(ref);
      if (consols.includes(num))  buckets.consolation.push(ref);
    }
    const totalHits = buckets.first.length + buckets.second.length + buckets.third.length
                    + buckets.starter.length + buckets.consolation.length;
    res.json({
      success: true,
      data: {
        saved_number: num,
        total_draws_scanned: rows.length,
        hit_counts: {
          first: buckets.first.length,
          second: buckets.second.length,
          third: buckets.third.length,
          starter: buckets.starter.length,
          consolation: buckets.consolation.length,
          total: totalHits,
        },
        first_prize_hits: buckets.first.slice(-10),     // last 10 of each
        recent_appearances: [...buckets.first, ...buckets.second, ...buckets.third,
                             ...buckets.starter, ...buckets.consolation]
          .sort((a,b) => b.draw_no - a.draw_no).slice(0, 10),
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Cultural calendar: numbers drawn on a specific solar date across years
app.get("/api/draws-on-date", (req, res) => {
  try {
    const md = String(req.query.month_day || "").trim();
    if (!/^\d{2}-\d{2}$/.test(md)) {
      return res.status(400).json({ success: false, error: "Provide ?month_day=MM-DD" });
    }
    // Malaysia operator anniversary — returned in the `fourd` slot so the frontend renders it the same way
    const op = String(req.query.operator || "").trim();
    if (op && op !== "sg4d" && MY_OPS.includes(op)) {
      const myRows = db.prepare(
        "SELECT draw_date, first_prize, second_prize, third_prize FROM my_draws WHERE operator=? AND substr(draw_date,6)=? ORDER BY draw_date DESC"
      ).all(op, md);
      return res.json({ success: true, data: { month_day: md, toto: [], fourd: myRows.map(r => ({ draw_no: null, draw_date: r.draw_date, first_prize: r.first_prize, second_prize: r.second_prize, third_prize: r.third_prize })) } });
    }
    // Find all draws where draw_date matches MM-DD across all years
    const totoRows = db.prepare(
      "SELECT draw_no, draw_date, num1, num2, num3, num4, num5, num6, additional_num " +
      "FROM toto_draws WHERE substr(draw_date, 6) = ? ORDER BY draw_no DESC"
    ).all(md);
    const fourdRows = db.prepare(
      "SELECT draw_no, draw_date, first_prize, second_prize, third_prize " +
      "FROM fourd_draws WHERE substr(draw_date, 6) = ? ORDER BY draw_no DESC"
    ).all(md);

    res.json({
      success: true,
      data: {
        month_day: md,
        toto: totoRows.map(r => ({
          draw_no: r.draw_no, draw_date: r.draw_date,
          numbers: [r.num1, r.num2, r.num3, r.num4, r.num5, r.num6].filter(n => n != null),
          additional_num: r.additional_num,
        })),
        fourd: fourdRows,
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── AI Prediction endpoint (reads from predictions table) ──────────
// Python writes weekly picks via `analysis/serve.py`. We just serve them.
app.get("/api/ai/picks", (req, res) => {
  try {
    // Ensure the table exists (no-op if Python hasn't run yet)
    db.exec(`
      CREATE TABLE IF NOT EXISTS predictions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        game         TEXT NOT NULL,
        for_week_of  TEXT NOT NULL,
        pick_idx     INTEGER NOT NULL,
        numbers      TEXT NOT NULL,
        rationale    TEXT,
        generated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(game, for_week_of, pick_idx)
      )
    `);

    // Find the most recent week's picks
    const latestWeek = db.prepare(
      "SELECT for_week_of FROM predictions ORDER BY for_week_of DESC LIMIT 1"
    ).get();

    if (!latestWeek) {
      return res.json({
        success: true,
        data: { generated: false, toto: [], fourd: [],
                message: "No picks generated yet. Run: .venv/bin/python -m analysis.serve" }
      });
    }

    const totoRows = db.prepare(
      "SELECT pick_idx, numbers, rationale, generated_at FROM predictions " +
      "WHERE game = 'toto' AND for_week_of = ? ORDER BY pick_idx"
    ).all(latestWeek.for_week_of);

    const fourdRows = db.prepare(
      "SELECT pick_idx, numbers, rationale, generated_at FROM predictions " +
      "WHERE game = '4d' AND for_week_of = ? ORDER BY pick_idx"
    ).all(latestWeek.for_week_of);

    res.json({
      success: true,
      data: {
        generated: true,
        for_week_of: latestWeek.for_week_of,
        generated_at: (totoRows[0] && totoRows[0].generated_at) || null,
        toto:  totoRows.map(r => ({
          pick_idx: r.pick_idx, numbers: JSON.parse(r.numbers), rationale: r.rationale
        })),
        fourd: fourdRows.map(r => ({
          pick_idx: r.pick_idx, numbers: JSON.parse(r.numbers), rationale: r.rationale
        })),
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── i18n dictionary endpoint (UI strings) ──────────────────────────
app.get("/api/i18n", (req, res) => {
  const lang = pickLang(req);
  res.json({ success: true, lang, strings: dict(lang) });
});

// ─── Lucky numbers endpoint ─────────────────────────────────────────
// GET /api/lucky?bd=YYYY-MM-DD&time=HH:MM&lang=en|zh
// Picks refresh per draw (4D Wed/Sat/Sun, TOTO Mon/Thu); reading refreshes weekly.
app.get("/api/lucky", (req, res) => {
  try {
    const bd = String(req.query.bd || "").trim();
    const time = req.query.time ? String(req.query.time).trim() : null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bd)) {
      return res.status(400).json({ success: false, error: "bd (birthday) must be YYYY-MM-DD" });
    }
    if (time && !/^\d{2}:\d{2}$/.test(time)) {
      return res.status(400).json({ success: false, error: "time must be HH:MM (24h)" });
    }
    const lang = pickLang(req);
    const result = getLuckyNumbers({ birthday: bd, time, lang });
    res.json({ success: true, lang, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/health", (req, res) => {
  const tc = db.prepare("SELECT COUNT(*) AS cnt FROM toto_draws").get().cnt;
  const fc = db.prepare("SELECT COUNT(*) AS cnt FROM fourd_draws").get().cnt;
  res.json({ status: "ok", tables: { toto_draws: tc, fourd_draws: fc } });
});

// ─── Admin: manual refresh + auto-scrape status ───────────────────────
app.post("/api/admin/refresh", async (req, res) => {
  try {
    const result = await autoScrape.runAll("manual");
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get("/api/admin/scrape-status", (req, res) => {
  res.json({ success: true, status: autoScrape.status() });
});

// Pre-warm cache: fire each heavy endpoint internally after server.listen()
// so the cache is hot before any real user arrives. Sequential to avoid
// CPU/memory pressure on Render's free tier (512MB).
function warmupCache() {
  const http = require("http");
  const endpoints = [
    // Dashboard / landing-page fires these on every initial load
    "/api/latest",
    "/api/fourd/stats",
    "/api/toto/stats",
    // 4D Stats tab
    "/api/fourd/dollar-sim",
    "/api/fourd/ibet-sim",
    "/api/fourd/repeat-winners",
    "/api/fourd/yearly-regulars",
    "/api/fourd/calendar-bias",
    "/api/fourd/class-by-year",
    "/api/fourd/palindromes",
    "/api/fourd/dry-distribution",
    // Simulator tab
    "/api/fourd/profitable-buckets",
    "/api/fourd/buckets-by-time",
    // Lucky tab
    "/api/festival",
    // Malaysia 4D stats — pre-warm so switching operators is instant (heavy scans)
    "/api/my/magnum/stats",
    "/api/my/sportstoto/stats",
    "/api/my/damacai/stats",
    "/api/my/sabah/stats",
    "/api/my/sarawak/stats",
    "/api/my/sandakan/stats",
    // Other Results tab — pre-warm so it's instant on first open
    "/api/my/latest",
    "/api/my/toto-products",
    "/api/my/other-games",
    "/api/my/drawnos",
    "/api/my/6d",
  ];
  console.log("[warmup] starting — " + endpoints.length + " endpoints to cache");
  let i = 0;
  function next() {
    if (i >= endpoints.length) {
      console.log("[warmup] complete");
      return;
    }
    const url = endpoints[i++];
    const t0 = Date.now();
    http.get(`http://localhost:${PORT}${url}`, (res) => {
      res.on("data", () => {});
      res.on("end", () => {
        console.log(`[warmup] ${url} cached in ${Date.now() - t0}ms`);
        setImmediate(next);
      });
    }).on("error", (err) => {
      console.warn(`[warmup] ${url} failed:`, err.message);
      setImmediate(next);
    });
  }
  next();
}

// Start
app.listen(PORT, () => {
  const tc = db.prepare("SELECT COUNT(*) AS cnt FROM toto_draws").get().cnt;
  const fc = db.prepare("SELECT COUNT(*) AS cnt FROM fourd_draws").get().cnt;
  console.log("\n  🍀 Huatlottery · http://localhost:" + PORT);
  console.log("  TOTO: " + tc + " draws · 4D: " + fc + " draws");
  console.log("  Open the URL above in your browser!\n");

  if (process.env.AUTO_SCRAPE !== "0") {
    autoScrape.startAutoScrape({ everyMs: 2 * 60 * 60 * 1000 });
  } else {
    console.log("[auto-scrape] disabled (AUTO_SCRAPE=0)");
  }

  // Background warmup — runs sequentially, doesn't block startup
  setTimeout(warmupCache, 2000);
});

process.on("SIGINT", () => { db.close(); process.exit(0); });
