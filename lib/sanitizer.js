// ─── lib/sanitizer.js ── Publication gate for generated articles ─────
//
// Three rules, all enforced AFTER generation so they hold no matter what the
// writer produced (a prompt instruction is guidance; this is the guarantee):
//
//   1. No purchase direction. An article reports what was announced. It must
//      never tell, nudge or help a reader buy, bet, stake or claim anything.
//      Matching copy is rejected outright rather than patched, because a
//      half-scrubbed sales pitch is still a sales pitch.
//
//   2. No invented numbers. Every figure in the article must appear in the
//      official facts it was generated from. Rewriting is allowed to change
//      words, never values.
//
//   3. No keyword stuffing. A phrase repeated past a sane density reads as
//      spam to both readers and search engines, so it fails the gate.

// Direct instruction or encouragement to gamble/spend. Deliberately broad:
// a false rejection costs one article, a miss puts betting advice on the site.
const PURCHASE_PATTERNS = [
  /\b(buy|purchase|get|grab|pick up|order)\s+(a|your|the|his|her|their|some|more)?\s*(ticket|tickets|entry|entries|line|lines|number|numbers|bet|bets)\b/i,
  /\b(place|put|make|stake|wager|punt)\s+(a|your|the|some)?\s*(bet|bets|wager|money|stake)\b/i,
  /\b(bet|wager|stake|gamble|play)\s+(on|now|today|before|with|responsibly at|at)\b/i,
  /\b(don'?t miss|last chance|hurry|act fast|grab it|while stocks last|before the draw closes)\b/i,
  /\b(your chance to win|chance to become|could be you|try your luck|feeling lucky)\b/i,
  /\b(where|how)\s+to\s+(buy|bet|play|purchase|stake)\b/i,
  /\b(outlet|outlets|counter|agent|retailer|kiosk)\s+(near|nearest|locator|location)\b/i,
  /\b(download|install|sign up|register|log in|deposit|top up)\b/i,
  /\b(promo|promotion|discount|bonus offer|free bet|voucher|promo code)\b/i,
  /\b(claim your|redeem your|collect your)\b/i,
  /\bvisit\s+(any|your nearest|a nearby)\b/i,
];

// Numbers we never treat as "claims" needing a source: years, small counts,
// ordinals and the like appear naturally in prose.
const IGNORABLE_NUMBER = /^(19|20)\d{2}$|^\d{1,2}$/;

function textOf(html) {
  return String(html).replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
}

// Every money figure stated anywhere in the article.
function moneyFigures(text) {
  const out = [];
  const re = /(?:RM|MYR|S?\$)\s?([\d][\d,]*(?:\.\d+)?)/gi;
  let m;
  while ((m = re.exec(text))) {
    const n = parseFloat(m[1].replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

// Bare numbers with a scale word ("2.5 million") also assert a value.
function scaledFigures(text) {
  const out = [];
  const re = /([\d][\d,]*(?:\.\d+)?)\s*(million|mil|billion|juta)\b/gi;
  let m;
  while ((m = re.exec(text))) {
    const n = parseFloat(m[1].replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    const mult = /billion/i.test(m[2]) ? 1e9 : 1e6;
    out.push(n * mult);
  }
  return out;
}

// The set of values the article is allowed to state, taken from the official
// announcement: prize amounts plus their millions-shorthand equivalents.
function allowedValues(facts) {
  const vals = new Set();
  for (const p of facts.prizes || []) {
    if (typeof p.amount !== "number") continue;
    vals.add(p.amount);
    vals.add(Math.round(p.amount));
    // "RM7,608,000" may legitimately be written "RM7.6 million"
    vals.add(Number((p.amount / 1e6).toFixed(2)) * 1e6);
    vals.add(Number((p.amount / 1e6).toFixed(1)) * 1e6);
  }
  return vals;
}

const near = (a, b) => Math.abs(a - b) <= Math.max(1, Math.abs(b) * 0.005);

function checkNumbers(text, facts) {
  const allowed = allowedValues(facts);
  const stated = [...moneyFigures(text), ...scaledFigures(text)];
  const bad = [];
  for (const v of stated) {
    if (IGNORABLE_NUMBER.test(String(v))) continue;
    if (![...allowed].some((a) => near(v, a))) bad.push(v);
  }
  return bad;
}

// Keyword density: a phrase should read naturally, not be hammered.
//
// Density is measured as OCCURRENCES per total words, not keyword-words per
// total words. The latter punishes long phrases for being long: "next toto
// draw jackpot" used twice in a 150-word article scores 5.3% on the word-count
// measure and reads as stuffing, when in fact two mentions across a title and
// a body is exactly the natural usage we ask for.
function checkDensity(text, keywords) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const total = words.length || 1;
  const over = [];
  for (const kw of keywords.filter(Boolean)) {
    const needle = kw.toLowerCase();
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const hits = (text.toLowerCase().match(new RegExp(escaped, "g")) || []).length;
    const density = hits / total;
    if (hits > 5 || density > 0.03) over.push({ keyword: kw, hits, density: +(density * 100).toFixed(2) });
  }
  return over;
}

function findPurchaseLanguage(text) {
  return PURCHASE_PATTERNS.map((re) => (text.match(re) || [])[0]).filter(Boolean);
}

// Returns { ok, reasons[] }. `ok:false` means do not publish.
function check(article, facts, keywords = []) {
  const text = textOf(`${article.title} ${article.h1} ${article.meta_desc} ${article.lead} ${article.body_html}`);
  const reasons = [];

  const cta = findPurchaseLanguage(text);
  if (cta.length) reasons.push(`purchase/betting language: ${[...new Set(cta)].join(", ")}`);

  const badNums = checkNumbers(text, facts);
  if (badNums.length) reasons.push(`figures not present in the official announcement: ${badNums.join(", ")}`);

  const stuffed = checkDensity(text, keywords);
  if (stuffed.length) reasons.push(`keyword stuffing: ${stuffed.map((s) => `"${s.keyword}" ×${s.hits} (${s.density}%)`).join(", ")}`);

  if (!article.body_html || textOf(article.body_html).split(/\s+/).length < 90) {
    reasons.push("article body too thin to be useful");
  }

  return { ok: reasons.length === 0, reasons };
}

module.exports = { check, findPurchaseLanguage, checkNumbers, checkDensity, textOf, PURCHASE_PATTERNS };
