// ─── scraper/generate-articles.js ── announcement → published article ─
//
// Runs after scraper/announcements.js. For every stored announcement that
// doesn't have an article yet:
//
//   1. assign a keyword cluster   (least-used first, so keywords spread)
//   2. write the article          (Claude API, or the deterministic fallback)
//   3. check it                   (no purchase language, figures match, no stuffing)
//   4. publish it                 (only if step 3 passes)
//
// Step 3 is a gate, not a filter: a draft that fails is discarded and logged,
// never patched and published anyway. Its keywords are not recorded either, so
// a rejected draft doesn't skew the spread.

const { getDb, initSchema } = require("../db");
const ledger = require("../lib/keyword-ledger");
const sanitizer = require("../lib/sanitizer");
const writer = require("../lib/article-writer");
const indexnow = require("../lib/indexnow");

const MAX_PER_RUN = 4;        // keep each scheduled run small and reviewable
const RETRIES_PER_ITEM = 2;   // a rejected draft gets one more attempt, then we move on

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

// Slug must stay unique and stable: an article's URL is its identity once
// Google has seen it, so we never reuse a slug for different content.
function uniqueSlug(db, base) {
  let slug = base, n = 2;
  const exists = db.prepare("SELECT 1 FROM articles WHERE slug = ?");
  while (exists.get(slug)) slug = `${base}-${n++}`;
  return slug;
}

// Only announcements that actually carry figures are worth an article. A bare
// "the next draw is on Saturday" notice has nothing to report beyond its own
// headline — it would fail the thin-content check on every attempt, so we skip
// it here rather than retrying it on every scheduled run forever. The draw date
// still reaches readers through the result pages, which is where it belongs.
function pending(db, limit) {
  return db.prepare(`
    SELECT a.* FROM announcements a
    LEFT JOIN articles ar ON ar.announcement_id = a.id
    WHERE ar.id IS NULL
      AND json_array_length(json_extract(a.facts, '$.prizes')) > 0
    ORDER BY a.seen_at DESC
    LIMIT ?`).all(limit);
}

async function generateOne(db, row) {
  const facts = JSON.parse(row.facts);
  const keywords = ledger.assign(db, row);
  const kwList = [keywords.primary, ...keywords.secondary];

  for (let attempt = 1; attempt <= RETRIES_PER_ITEM; attempt++) {
    const draft = await writer.write(row, facts, keywords);
    const verdict = sanitizer.check(draft, facts, kwList);

    if (!verdict.ok) {
      console.log(`  ✗ rejected (attempt ${attempt}/${RETRIES_PER_ITEM}) — ${verdict.reasons.join("; ")}`);
      continue;
    }

    const slug = uniqueSlug(db, slugify(`${keywords.primary}-${facts.draw_date || row.id}`));
    db.prepare(`INSERT INTO articles
      (slug, announcement_id, title, h1, meta_desc, lead, body_html, primary_keyword, secondary_keywords, writer)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      slug, row.id, draft.title, draft.h1, draft.meta_desc, draft.lead, draft.body_html,
      keywords.primary, JSON.stringify(keywords.secondary), draft.writer
    );
    ledger.record(db, keywords);   // only a published article consumes its keywords
    console.log(`  ✓ /announcements/${slug}  [${draft.writer}, primary: "${keywords.primary}"]`);
    return { ok: true, slug };
  }

  console.log(`  ⊘ giving up on announcement #${row.id} — nothing publishable this run`);
  return { ok: false };
}

async function run({ limit = MAX_PER_RUN, ping = true } = {}) {
  const db = getDb();
  initSchema(db);
  const rows = pending(db, limit);
  console.log(`[articles] ${rows.length} announcement(s) awaiting an article`);

  let published = 0;
  const fresh = [];
  for (const row of rows) {
    console.log(`  · ${row.source}/${row.kind}: ${row.official_title}`);
    const r = await generateOne(db, row);
    if (r.ok) { published++; fresh.push(`/announcements/${r.slug}`); }
  }

  console.log(`[articles] ${published} published`);

  // Push the new URLs the moment they exist rather than waiting for the next
  // sitemap crawl. The index page is included because its content changed too.
  if (ping && fresh.length) {
    await indexnow.submit([...fresh, "/announcements"]);
  }

  db.close();
  return { considered: rows.length, published, urls: fresh };
}

if (require.main === module) {
  run().catch((e) => { console.error("[articles] failed:", e.message); process.exit(1); });
}

module.exports = { run, slugify };
