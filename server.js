const express = require("express");
const cors = require("cors");
const path = require("path");
const { getDb, initSchema } = require("./db");
const { getLuckyNumbers } = require("./lib/lucky");
const { pickLang, dict } = require("./i18n");

const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors());
app.use(express.json());

// Serve ALL static files from this directory (including index.html)
app.use(express.static(path.join(__dirname)));

const db = getDb();
initSchema(db);

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

app.get("/api/latest", (req, res) => {
  try {
    const t = db.prepare("SELECT * FROM toto_draws ORDER BY draw_no DESC LIMIT 1").get();
    const f = db.prepare("SELECT * FROM fourd_draws ORDER BY draw_no DESC LIMIT 1").get();
    res.json({ success: true, data: { toto: formatTotoRow(t), fourd: parseFourdRow(f) } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/api/toto/draws", (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;
    const rows = db.prepare("SELECT * FROM toto_draws ORDER BY draw_no DESC LIMIT ? OFFSET ?").all(limit, offset);
    const total = db.prepare("SELECT COUNT(*) AS cnt FROM toto_draws").get().cnt;
    res.json({ success: true, data: rows.map(formatTotoRow), pagination: { limit, offset, total } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/api/toto/stats", (req, res) => {
  try {
    const rows = db.prepare("SELECT num1, num2, num3, num4, num5, num6 FROM toto_draws").all();
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
    const td = rows.length;
    const avg = sums.length ? Math.round(sums.reduce((a, b) => a + b, 0) / sums.length) : 0;
    const bk = {}; sums.forEach(s => { const k = `${Math.floor(s / 25) * 25}-${Math.floor(s / 25) * 25 + 24}`; bk[k] = (bk[k] || 0) + 1; });
    res.json({ success: true, data: {
      total_draws: td, frequency: sorted,
      hot_numbers: sorted.slice(0, 6).map(x => x.number), cold_numbers: sorted.slice(-6).map(x => x.number),
      even_odd: { total_even: tE, total_odd: tO, even_pct: Math.round(tE / (tE + tO) * 1000) / 10, odd_pct: Math.round(tO / (tE + tO) * 1000) / 10, distribution: Object.entries(eo).map(([l, c]) => ({ label: l, count: c })) },
      sum_analysis: { average: avg, min: sums.length ? Math.min(...sums) : 0, max: sums.length ? Math.max(...sums) : 0, buckets: Object.entries(bk).map(([r, c]) => ({ range: r, count: c })).sort((a, b) => parseInt(a.range) - parseInt(b.range)) },
    }});
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get("/api/toto/search", (req, res) => {
  try {
    const { number, date, from, to } = req.query;
    if (date) { const r = db.prepare("SELECT * FROM toto_draws WHERE draw_date = ? ORDER BY draw_no DESC").all(date); return res.json({ success: true, query: date, total_matches: r.length, data: r.map(formatTotoRow) }); }
    if (from && to) { const r = db.prepare("SELECT * FROM toto_draws WHERE draw_date BETWEEN ? AND ? ORDER BY draw_no DESC").all(from, to); return res.json({ success: true, query: `${from} to ${to}`, total_matches: r.length, data: r.map(formatTotoRow) }); }
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
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;
    const rows = db.prepare("SELECT * FROM fourd_draws ORDER BY draw_no DESC LIMIT ? OFFSET ?").all(limit, offset);
    const total = db.prepare("SELECT COUNT(*) AS cnt FROM fourd_draws").get().cnt;
    res.json({ success: true, data: rows.map(parseFourdRow), pagination: { limit, offset, total } });
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

app.get("/api/fourd/stats", (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM fourd_draws ORDER BY draw_no DESC").all();
    const totalDraws = rows.length;
    const byC = { first: [], second: [], third: [], starter: [], consolation: [] };
    const allNumbers = [];
    for (const row of rows) {
      const p = parseFourdRow(row);
      byC.first.push(p.first_prize); byC.second.push(p.second_prize); byC.third.push(p.third_prize);
      byC.starter.push(...p.starter_prizes); byC.consolation.push(...p.consolation_prizes);
      allNumbers.push(p.first_prize, p.second_prize, p.third_prize, ...p.starter_prizes, ...p.consolation_prizes);
    }
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
    const top10 = Object.entries(gf).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([number, count]) => ({ number, count, pct: Math.round(count / tn * 10000) / 100 }));
    const eTop = arr => { const f = {}; arr.forEach(n => f[n] = (f[n] || 0) + 1); const t = arr.length; return Object.entries(f).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([number, count]) => ({ number, count, pct: Math.round(count / t * 10000) / 100 })); };
    const pTop = arr => { const f = {}; arr.forEach(n => { const k = getSortedDigits(n); f[k] = (f[k] || 0) + 1; }); const t = arr.length; return Object.entries(f).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([sd, count]) => ({ sorted_digits: sd, count, pct: Math.round(count / t * 10000) / 100 })); };
    const exact = {}, perm = {};
    for (const cat of Object.keys(byC)) { exact[cat] = { top3: eTop(byC[cat]), total: byC[cat].length }; perm[cat] = { top3: pTop(byC[cat]), total: byC[cat].length }; }
    res.json({ success: true, data: {
      total_draws: totalDraws, total_numbers: tn,
      digit_classification: { double: { count: dC, pct: Math.round(dC / tn * 1000) / 10, top3: topN(dc.double, 3) }, triple: { count: tC, pct: Math.round(tC / tn * 1000) / 10, top3: topN(dc.triple, 3) }, quad: { count: qC, pct: Math.round(qC / tn * 1000) / 10, top3: topN(dc.quad, 3) } },
      top10_hot: top10, exact_match: exact, perm_match: perm,
    }});
  } catch (err) { console.error(err); res.status(500).json({ success: false, error: err.message }); }
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

// Start
app.listen(PORT, () => {
  const tc = db.prepare("SELECT COUNT(*) AS cnt FROM toto_draws").get().cnt;
  const fc = db.prepare("SELECT COUNT(*) AS cnt FROM fourd_draws").get().cnt;
  console.log("\n  🍀 Huatlottery · http://localhost:" + PORT);
  console.log("  TOTO: " + tc + " draws · 4D: " + fc + " draws");
  console.log("  Open the URL above in your browser!\n");
});

process.on("SIGINT", () => { db.close(); process.exit(0); });
