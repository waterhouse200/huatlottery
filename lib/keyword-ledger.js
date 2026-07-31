// ─── lib/keyword-ledger.js ── Spread keywords across the archive ─────
//
// The failure mode this exists to prevent: every generated article reaching
// for the same handful of high-volume phrases, so the site ends up with 40
// near-identical pages all chasing "singapore toto jackpot" and Google treats
// the lot as thin duplication.
//
// Instead each article is handed ONE primary keyword plus a couple of related
// secondaries, drawn from the cluster that fits its subject and used least so
// far. Usage is recorded in keyword_usage, so the next article on the same
// game naturally reaches for a different angle.

// Clusters are grouped by subject so an article only ever gets keywords that
// genuinely describe it — a Magnum jackpot piece can't be handed a TOTO phrase.
const CLUSTERS = {
  "singaporepools:jackpot": [
    "singapore toto jackpot",
    "toto jackpot amount",
    "singapore pools toto prize",
    "next toto draw jackpot",
    "toto group 1 prize",
    "singapore toto draw estimate",
  ],
  "singaporepools:notice": [
    "singapore 4d draw date",
    "next singapore 4d draw",
    "singapore pools 4d schedule",
    "4d draw days singapore",
  ],
  "magnum:jackpot": [
    "magnum 4d jackpot",
    "magnum jackpot gold amount",
    "magnum 4d jackpot 1 prize",
    "magnum jackpot estimate",
    "mgold prize amount",
  ],
  "damacai:jackpot": [
    "da ma cai jackpot",
    "1+3d jackpot amount",
    "da ma cai 3d jackpot",
    "damacai jackpot estimate",
    "3+3d prize bonus",
  ],
  "sportstoto:jackpot": [
    "sports toto jackpot",
    "supreme toto 6/58 jackpot",
    "power toto 6/55 prize",
    "star toto jackpot amount",
  ],
};

// Generic phrases any article may draw one secondary from — they describe the
// section itself rather than a specific game, so sharing them is honest.
const SHARED = [
  "lottery jackpot news",
  "singapore and malaysia lottery",
  "official lottery announcement",
  "latest jackpot update",
];

function clusterKey(announcement) {
  return `${announcement.source}:${announcement.kind}`;
}

function ensureRows(db, keywords) {
  const ins = db.prepare("INSERT OR IGNORE INTO keyword_usage (keyword, uses) VALUES (?, 0)");
  const tx = db.transaction((ks) => ks.forEach((k) => ins.run(k)));
  tx(keywords);
}

// Least-used first, then alphabetical so the choice is deterministic and a
// re-run can't silently reshuffle assignments.
function leastUsed(db, keywords, n) {
  ensureRows(db, keywords);
  const marks = keywords.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT keyword, uses FROM keyword_usage WHERE keyword IN (${marks}) ORDER BY uses ASC, keyword ASC`
  ).all(...keywords);
  return rows.slice(0, n).map((r) => r.keyword);
}

// Assign one primary + up to `secondaries` related keywords for an article.
// Nothing is recorded yet — call record() only once the article actually
// survives sanitising and gets published, so rejected drafts don't burn a
// keyword and skew the spread.
function assign(db, announcement, { secondaries = 2 } = {}) {
  const key = clusterKey(announcement);
  const cluster = CLUSTERS[key] || CLUSTERS[`${announcement.source}:jackpot`] || SHARED;
  const picked = leastUsed(db, cluster, 1 + secondaries);
  const primary = picked[0];
  const rest = picked.slice(1);
  // Top up from the shared pool if the cluster is small, so every article still
  // gets a couple of supporting phrases without repeating its primary.
  if (rest.length < secondaries) {
    const extra = leastUsed(db, SHARED, secondaries - rest.length);
    rest.push(...extra.filter((k) => k !== primary && !rest.includes(k)));
  }
  return { primary, secondary: rest.slice(0, secondaries) };
}

function record(db, { primary, secondary = [] }) {
  const all = [primary, ...secondary].filter(Boolean);
  ensureRows(db, all);
  const bump = db.prepare("UPDATE keyword_usage SET uses = uses + 1, last_used_at = datetime('now') WHERE keyword = ?");
  const tx = db.transaction((ks) => ks.forEach((k) => bump.run(k)));
  tx(all);
}

function stats(db) {
  return db.prepare("SELECT keyword, uses, last_used_at FROM keyword_usage ORDER BY uses DESC, keyword ASC").all();
}

module.exports = { CLUSTERS, SHARED, assign, record, stats, clusterKey };
