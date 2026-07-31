// seo-articles.js — the /announcements section.
//
// Server-rendered from the `articles` table: an index and one page per article,
// each with its own title, H1, meta description, canonical URL and Article
// structured data. These are the pages the announcement pipeline exists to
// produce, so they carry the internal links back into the result pages and are
// listed in sitemap.xml with a true lastmod.
//
// Compliance: articles report published figures only. Every page repeats that
// draws are chance events and carries the NCPG helpline via the shared shell.

const { SITE, page, esc } = require('./lib/seo-layout')

// Prose styling — the shared shell is built for tables, articles need measure
// and rhythm. Appended after the shared CSS so it can only add, never override
// the existing pages' look.
const ARTICLE_STYLE = `
.crumbs{font-size:.78rem;color:var(--mute);padding-top:16px}
.crumbs a{color:var(--ink2)}
article.post{max-width:68ch}
article.post p{margin:0 0 16px}
article.post h2{font-size:1.15rem;margin:26px 0 10px}
.meta{font-size:.8rem;color:var(--mute);margin:-4px 0 22px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.tag{background:#ecfdf5;color:var(--em2);border:1px solid #a7f3d0;border-radius:999px;padding:2px 10px;font-weight:700;font-size:.72rem}
.src{font-size:.82rem;color:var(--ink2);border-left:3px solid var(--line);padding:2px 0 2px 12px;margin:22px 0}
.feed{list-style:none;margin:8px 0 0;padding:0}
.feed li{border-bottom:1px solid var(--line);padding:16px 0}
.feed li:last-child{border-bottom:none}
.feed h2{margin:0 0 6px;font-size:1.05rem;color:var(--ink)}
.feed h2 a{color:var(--ink)}
.feed p{color:var(--ink2);font-size:.92rem;margin:0}
.feed .when{font-size:.74rem;color:var(--mute);text-transform:uppercase;letter-spacing:.04em}
.empty{color:var(--ink2)}
`

// Where each operator's articles should point readers next. Keeps every article
// one click from the live results it talks about — the internal linking that
// makes a new page discoverable instead of orphaned.
const RESULT_LINKS = {
  singaporepools: [['/singapore-toto-results', 'Singapore TOTO results'], ['/singapore-4d-results', 'Singapore 4D results']],
  magnum: [['/magnum-4d-result', 'Magnum 4D results'], ['/malaysia-4d-results', 'Malaysia 4D results']],
  damacai: [['/da-ma-cai-result', 'Da Ma Cai results'], ['/malaysia-4d-results', 'Malaysia 4D results']],
  sportstoto: [['/sports-toto-4d-result', 'Sports Toto results'], ['/malaysia-4d-results', 'Malaysia 4D results']],
}

const SOURCE_NAME = {
  singaporepools: 'Singapore Pools',
  magnum: 'Magnum',
  damacai: 'Da Ma Cai',
  sportstoto: 'Sports Toto',
}

module.exports = function registerArticles(app, db, helpers) {
  const { seoDate } = helpers
  const e = esc
  const safe = (fn, res) => { try { const html = fn(); if (html === null) { res.status(404).end(); return } res.send(html) } catch (err) { res.status(500).end() } }

  const crumbs = (trail) =>
    `<nav class="crumbs">${trail.map((t, i) => (i === trail.length - 1 ? e(t[0]) : `<a href="${t[1]}">${e(t[0])}</a> ›`)).join(' ')}</nav>`

  const breadcrumbLd = (trail) => ({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((t, i) => ({ '@type': 'ListItem', position: i + 1, name: t[0], item: `${SITE}${t[1]}` })),
  })

  const day = (ts) => String(ts || '').slice(0, 10)

  // ─── Index ──────────────────────────────────────────────
  app.get('/announcements', (req, res) => safe(() => {
    const rows = db.prepare(`
      SELECT ar.slug, ar.title, ar.h1, ar.lead, ar.published_at, an.source
      FROM articles ar LEFT JOIN announcements an ON an.id = ar.announcement_id
      WHERE ar.status = 'published'
      ORDER BY ar.published_at DESC LIMIT 100`).all()

    const trail = [['Home', '/'], ['Announcements', '/announcements']]

    const body = rows.length
      ? `<ul class="feed">${rows.map((r) => `<li>
<div class="when">${e(seoDate(day(r.published_at)) || day(r.published_at))}${r.source ? ` · ${e(SOURCE_NAME[r.source] || r.source)}` : ''}</div>
<h2><a href="/announcements/${e(r.slug)}">${e(r.h1)}</a></h2>
<p>${e(r.lead)}</p>
</li>`).join('')}</ul>`
      : `<p class="empty">No announcements have been published yet. Jackpot figures and draw notices appear here as operators publish them.</p>`

    return page({
      title: 'Lottery Announcements — Singapore & Malaysia Jackpot Updates | Huatlottery',
      desc: 'Jackpot amounts and draw announcements reported from the official Singapore Pools, Magnum, Da Ma Cai and Sports Toto publications, updated as they are released.',
      canonical: `${SITE}/announcements`,
      h1: 'Lottery Announcements — Jackpot Updates',
      lead: 'What Singapore and Malaysia lottery operators have published about upcoming draws — estimated jackpot amounts, prize figures and draw dates, reported from each operator\'s own announcement.',
      body,
      extraStyle: ARTICLE_STYLE,
      breadcrumb: crumbs(trail),
      jsonld: [
        breadcrumbLd(trail),
        {
          '@context': 'https://schema.org',
          '@type': 'CollectionPage',
          name: 'Lottery Announcements',
          url: `${SITE}/announcements`,
          isPartOf: { '@type': 'WebSite', name: 'Huatlottery', url: SITE },
          hasPart: rows.slice(0, 25).map((r) => ({
            '@type': 'Article', headline: r.h1, url: `${SITE}/announcements/${r.slug}`, datePublished: day(r.published_at),
          })),
        },
      ],
    })
  }, res))

  // ─── One article ────────────────────────────────────────
  app.get('/announcements/:slug', (req, res) => safe(() => {
    const r = db.prepare(`
      SELECT ar.*, an.source, an.source_url, an.official_title, an.published_date
      FROM articles ar LEFT JOIN announcements an ON an.id = ar.announcement_id
      WHERE ar.slug = ? AND ar.status = 'published'`).get(req.params.slug)
    if (!r) return null   // → 404, so a bad slug never renders an empty shell

    const trail = [['Home', '/'], ['Announcements', '/announcements'], [r.h1, `/announcements/${r.slug}`]]
    const links = RESULT_LINKS[r.source] || RESULT_LINKS.singaporepools
    const srcName = SOURCE_NAME[r.source] || 'the operator'

    const body = `<article class="post">
<div class="meta"><span class="tag">${e(srcName)}</span><span>Published ${e(seoDate(day(r.published_at)) || day(r.published_at))}</span></div>
${r.body_html}
<div class="src">Reported from ${e(srcName)}&rsquo;s published announcement${r.source_url ? `: <a href="${e(r.source_url)}" rel="nofollow noopener" target="_blank">${e(r.official_title || 'official source')}</a>` : ''}. Figures are quoted as published and may be revised by the operator.</div>
<h2>Follow the numbers</h2>
<p>${links.map(([href, label]) => `<a href="${href}">${e(label)}</a>`).join(' · ')}${r.source === 'singaporepools' ? ' · <a href="/singapore-toto-hot-cold-numbers">TOTO number frequency</a>' : ''} · <a href="/announcements">More announcements</a></p>
</article>`

    return page({
      title: r.title,
      desc: r.meta_desc,
      canonical: `${SITE}/announcements/${r.slug}`,
      h1: r.h1,
      lead: e(r.lead),
      body,
      extraStyle: ARTICLE_STYLE,
      breadcrumb: crumbs(trail),
      jsonld: [
        breadcrumbLd(trail),
        {
          '@context': 'https://schema.org',
          '@type': 'Article',
          headline: r.h1,
          description: r.meta_desc,
          datePublished: day(r.published_at),
          dateModified: day(r.updated_at || r.published_at),
          mainEntityOfPage: { '@type': 'WebPage', '@id': `${SITE}/announcements/${r.slug}` },
          publisher: { '@type': 'Organization', name: 'Huatlottery', url: SITE },
          author: { '@type': 'Organization', name: 'Huatlottery', url: SITE },
          isBasedOn: r.source_url || undefined,
        },
      ],
    })
  }, res))

  // sitemap entries: the index, plus every published article with its own lastmod
  return {
    index: ['/announcements', "SELECT MAX(published_at) d FROM articles WHERE status='published'"],
    articles: (database) =>
      database.prepare("SELECT slug, updated_at, published_at FROM articles WHERE status='published' ORDER BY published_at DESC").all()
        .map((a) => [`/announcements/${a.slug}`, String(a.updated_at || a.published_at).slice(0, 10)]),
  }
}
