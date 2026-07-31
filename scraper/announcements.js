// ─── scraper/announcements.js ── Official announcements & jackpot amounts ─
//
// Reads what the operators themselves publish — nothing second-hand:
//
//   Singapore Pools  next-draw estimate files (the same authoritative files
//                    scraper/next-draw.js already uses) → next TOTO jackpot
//                    estimate, next draw date/time, incl. special/big draws.
//   Magnum           magnum4d.my home → live estimated jackpots for 4D Jackpot,
//                    4D Jackpot Gold, mGold, Magnum Life.
//   Da Ma Cai        damacai.com.my home → estimated 1+3D / 3D jackpots and
//                    3+3D prize bonuses, plus the estimate's draw date.
//   Sports Toto      sportstoto.my — attempted; the host refuses connections
//                    from outside Malaysia, so a failure here is expected and
//                    never fails the run (see SOURCES[].optional).
//
// Everything captured lands in `announcements.facts` as exact figures. That
// row is the source of truth: articles are generated FROM it and verified
// BACK against it, so a rewrite can never invent or drift a number.
//
// Only factual draw/jackpot information is captured. Anything that reads as
// marketing for buying or betting (app promos, "bet now" pushes) is dropped
// at the source by DROP_IF_MATCHES below — it must never reach an article.

const crypto = require("crypto");
const cheerio = require("cheerio");
const { fetchHtml } = require("./fetch");
const { getDb, initSchema } = require("../db");

// Single-attempt fetch for sources that are allowed to be unreachable.
// fetchHtml retries 6× with backoff up to 5 min, which is right for a result
// page we must not miss — but wrong for an optional host that is refusing
// connections outright: it would stall the whole scheduled run for ~8 minutes
// to learn what one 10s timeout already tells us.
async function fetchOnce(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Huatlottery/0.1 (personal analysis project)", "Accept": "text/html" },
      redirect: "follow",
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

const SP_BASE = "https://www.singaporepools.com.sg/DataFileArchive/Lottery/Output/";
const SP_TOTO_ESTIMATE = SP_BASE + "toto_next_draw_estimate_en.html";
const SP_4D_NEXT = SP_BASE + "fourd_next_draw_info_en.html";
const MAGNUM_HOME = "https://www.magnum4d.my/";
const DAMACAI_HOME = "https://www.damacai.com.my/";
const SPORTSTOTO_HOME = "https://www.sportstoto.my/";

// Source copy matching any of these is promotional rather than informational.
// Dropped before storage so no downstream step can surface it.
const DROP_IF_MATCHES = /\b(download|app store|google play|bet now|buy now|place your bet|sign up|register now|deposit|promo code|dmcgo|mobile betting)\b/i;

const MONTHS = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };

const textOf = (html) => cheerio.load(html).text().replace(/\s+/g, " ").trim();
const fingerprint = (parts) => crypto.createHash("sha1").update(parts.join("|")).digest("hex");

// The verbatim excerpt we keep must be the announcement itself, not the first
// 500 characters of the page — those are nav chrome ("Login", "Download the
// app") which both pollutes the record and trips the promotional filter on
// pages whose actual jackpot content is perfectly factual.
function excerptAround(text, re, span = 420) {
  const m = text.match(re);
  if (!m) return text.slice(0, span);
  const start = Math.max(0, m.index - 60);
  return text.slice(start, start + span).trim();
}

// "RM 7,608,000.00" → 7608000 ; "$2,500,000" → 2500000
function toAmount(raw) {
  const n = parseFloat(String(raw).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Money as the operator prints it, normalised for display: "RM7,608,000.00"
function money(cur, amount) {
  const s = amount.toLocaleString("en-US", { minimumFractionDigits: amount % 1 ? 2 : 0, maximumFractionDigits: 2 });
  return `${cur}${s}`;
}

// ─── Singapore Pools ────────────────────────────────────────────────
// "Next Draw Mon, 03 Aug 2026 , 6.30pm ... Next Jackpot $2,500,000 est"
function parseSingaporePools(totoText, fourdText) {
  const out = [];
  const drawOf = (t) => {
    const m = t.match(/Next Draw\b[^A-Za-z0-9]*[A-Za-z]{3},?\s*(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/i);
    if (!m) return null;
    const mm = MONTHS[m[2][0].toUpperCase() + m[2].slice(1).toLowerCase()];
    return mm ? `${m[3]}-${mm}-${String(m[1]).padStart(2, "0")}` : null;
  };

  const totoDate = drawOf(totoText);
  const jm = totoText.match(/Next Jackpot[^$]*\$([\d,]+(?:\.\d+)?)/i);
  if (totoDate && jm) {
    const amount = toAmount(jm[1]);
    out.push({
      source: "singaporepools",
      kind: "jackpot",
      source_url: SP_TOTO_ESTIMATE,
      official_title: `Singapore Pools TOTO estimated jackpot for the ${totoDate} draw`,
      official_text: totoText.slice(0, 500),
      published_date: totoDate,
      facts: {
        game: "Singapore Pools TOTO",
        region: "Singapore",
        currency: "$",
        draw_date: totoDate,
        estimated: true,
        prizes: [{ label: "TOTO jackpot (Group 1)", amount, display: money("$", amount) }],
      },
    });
  }

  const fourdDate = drawOf(fourdText);
  if (fourdDate) {
    out.push({
      source: "singaporepools",
      kind: "notice",
      source_url: SP_4D_NEXT,
      official_title: `Singapore Pools 4D next draw scheduled for ${fourdDate}`,
      official_text: fourdText.slice(0, 500),
      published_date: fourdDate,
      facts: { game: "Singapore Pools 4D", region: "Singapore", currency: "$", draw_date: fourdDate, estimated: false, prizes: [] },
    });
  }
  return out;
}

// ─── Magnum ─────────────────────────────────────────────────────────
// Home page prints, in order: "<Game> ... Jackpot 1 prize RM x Jackpot 2 prize RM y"
function parseMagnum(text) {
  const grab = (label, re) => {
    const m = text.match(re);
    if (!m) return null;
    const amount = toAmount(m[1]);
    return amount ? { label, amount, display: money("RM", amount) } : null;
  };

  const prizes = [
    grab("Magnum 4D Jackpot 1", /4D Jackpot[\s\S]{0,120}?Jackpot 1 prize\s*RM\s*([\d,]+(?:\.\d+)?)/i),
    grab("Magnum 4D Jackpot 2", /4D Jackpot[\s\S]{0,160}?Jackpot 2 prize\s*RM\s*([\d,]+(?:\.\d+)?)/i),
    grab("Magnum 4D Jackpot Gold 1", /Jackpot Gold[\s\S]{0,160}?Jackpot 1 prize\s*RM\s*([\d,]+(?:\.\d+)?)/i),
    grab("mGold 1st prize", /mgold[\s\S]{0,120}?1st prize\s*RM\s*([\d,]+(?:\.\d+)?)/i),
  ].filter(Boolean);

  if (!prizes.length) return [];
  return [{
    source: "magnum",
    kind: "jackpot",
    source_url: MAGNUM_HOME,
    official_title: "Magnum estimated jackpot amounts",
    official_text: excerptAround(text, /Jackpot 1 prize/i),
    published_date: null,
    facts: { game: "Magnum 4D", region: "Malaysia", currency: "RM", draw_date: null, estimated: true, prizes },
  }];
}

// ─── Da Ma Cai ──────────────────────────────────────────────────────
// "estimated Jackpot & Bonus draw date: 01/08/2026 (Sat) 1+3D Jackpot 1 RM 7,608,000.00 …"
function parseDamacai(text) {
  const dm = text.match(/draw date:\s*(\d{2})\/(\d{2})\/(\d{4})/i);
  const drawDate = dm ? `${dm[3]}-${dm[2]}-${dm[1]}` : null;

  const grab = (label, re) => {
    const m = text.match(re);
    if (!m) return null;
    const amount = toAmount(m[1]);
    return amount ? { label, amount, display: money("RM", amount) } : null;
  };

  const prizes = [
    grab("1+3D Jackpot 1", /1\+3D Jackpot 1\s*RM\s*([\d,]+(?:\.\d+)?)/i),
    grab("1+3D Jackpot 2", /1\+3D Jackpot 2\s*RM\s*([\d,]+(?:\.\d+)?)/i),
    grab("3D Jackpot", /3D Jackpot\s*RM\s*([\d,]+(?:\.\d+)?)/i),
    grab("3+3D 1st Prize Bonus", /3\+3D 1st Prize Bonus\s*RM\s*([\d,]+(?:\.\d+)?)/i),
    grab("3+3D 2nd Prize Bonus", /3\+3D 2nd Prize Bonus\s*RM\s*([\d,]+(?:\.\d+)?)/i),
    grab("3+3D 3rd Prize Bonus", /3\+3D 3rd Prize Bonus\s*RM\s*([\d,]+(?:\.\d+)?)/i),
  ].filter(Boolean);

  if (!prizes.length) return [];
  return [{
    source: "damacai",
    kind: "jackpot",
    source_url: DAMACAI_HOME,
    official_title: "Da Ma Cai estimated jackpot and bonus amounts",
    official_text: excerptAround(text, /1\+3D Jackpot 1/i),
    published_date: drawDate,
    facts: { game: "Da Ma Cai 1+3D", region: "Malaysia", currency: "RM", draw_date: drawDate, estimated: true, prizes },
  }];
}

// ─── Sports Toto (best effort) ──────────────────────────────────────
function parseSportsToto(text) {
  const grab = (label, re) => {
    const m = text.match(re);
    if (!m) return null;
    const amount = toAmount(m[1]);
    return amount ? { label, amount, display: money("RM", amount) } : null;
  };
  const prizes = [
    grab("Supreme Toto 6/58 jackpot", /Supreme[\s\S]{0,140}?RM\s*([\d,]+(?:\.\d+)?)/i),
    grab("Power Toto 6/55 jackpot", /Power[\s\S]{0,140}?RM\s*([\d,]+(?:\.\d+)?)/i),
    grab("Star Toto 6/50 jackpot", /Star[\s\S]{0,140}?RM\s*([\d,]+(?:\.\d+)?)/i),
  ].filter(Boolean);
  if (!prizes.length) return [];
  return [{
    source: "sportstoto",
    kind: "jackpot",
    source_url: SPORTSTOTO_HOME,
    official_title: "Sports Toto estimated jackpot amounts",
    official_text: excerptAround(text, /Supreme|Power|Star/i),
    published_date: null,
    facts: { game: "Sports Toto", region: "Malaysia", currency: "RM", draw_date: null, estimated: true, prizes },
  }];
}

// ─── Collection ─────────────────────────────────────────────────────
const SOURCES = [
  {
    name: "singaporepools",
    optional: false,
    async collect() {
      const [toto, fourd] = await Promise.all([fetchHtml(SP_TOTO_ESTIMATE), fetchHtml(SP_4D_NEXT)]);
      return parseSingaporePools(textOf(toto), textOf(fourd));
    },
  },
  { name: "magnum", optional: false, collect: async () => parseMagnum(textOf(await fetchHtml(MAGNUM_HOME))) },
  { name: "damacai", optional: false, collect: async () => parseDamacai(textOf(await fetchHtml(DAMACAI_HOME))) },
  // sportstoto.my refuses connections from outside Malaysia — expected to fail
  // off-shore, so it never fails the run. It will simply start working if the
  // host becomes reachable from wherever this runs.
  { name: "sportstoto", optional: true, collect: async () => parseSportsToto(textOf(await fetchOnce(SPORTSTOTO_HOME))) },
];

// An announcement is "new" when its figures change — the fingerprint covers the
// source, game and every prize figure, so an unchanged jackpot won't re-publish
// but a jackpot that has rolled over to a new amount will.
function fingerprintOf(a) {
  const f = a.facts;
  return fingerprint([a.source, a.kind, f.game || "", f.draw_date || "", ...(f.prizes || []).map((p) => `${p.label}=${p.amount}`)]);
}

async function collectAll() {
  const found = [];
  for (const src of SOURCES) {
    try {
      const items = await src.collect();
      const kept = items.filter((a) => !DROP_IF_MATCHES.test(a.official_title || "") && !DROP_IF_MATCHES.test(a.official_text || ""));
      if (kept.length !== items.length) console.log(`  [${src.name}] dropped ${items.length - kept.length} promotional item(s)`);
      console.log(`  [${src.name}] ${kept.length} announcement(s)`);
      found.push(...kept);
    } catch (err) {
      const level = src.optional ? "skip" : "WARN";
      console.log(`  [${src.name}] ${level}: ${err.message}`);
    }
  }
  return found;
}

function store(db, items) {
  const ins = db.prepare(`INSERT OR IGNORE INTO announcements
    (source, kind, source_url, official_title, official_text, published_date, facts, fingerprint)
    VALUES (?,?,?,?,?,?,?,?)`);
  let added = 0;
  const tx = db.transaction((rows) => {
    for (const a of rows) {
      const r = ins.run(a.source, a.kind, a.source_url, a.official_title, a.official_text,
        a.published_date, JSON.stringify(a.facts), fingerprintOf(a));
      if (r.changes) added++;
    }
  });
  tx(items);
  return added;
}

async function run() {
  const db = getDb();
  initSchema(db);
  console.log("[announcements] collecting from official operator sites…");
  const items = await collectAll();
  const added = store(db, items);
  console.log(`[announcements] ${items.length} collected, ${added} new`);
  db.close();
  return { collected: items.length, added };
}

if (require.main === module) {
  run().catch((e) => { console.error("[announcements] failed:", e.message); process.exit(1); });
}

module.exports = { run, collectAll, store, fingerprintOf, parseSingaporePools, parseMagnum, parseDamacai, parseSportsToto, DROP_IF_MATCHES };
