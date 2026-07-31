// ─── lib/seo-layout.js ── Shared shell for server-rendered SEO pages ─
//
// Extracted from seo-pages-extra.js so the announcement pages render inside the
// same frame. The disclaimer in particular must have ONE definition — it
// carries the NCPG helpline and the "past results don't predict future draws"
// statement that every stats/results page is required to show, and two drifting
// copies is exactly how one of them ends up out of date.
//
// page() is unchanged from the original; `extraStyle` and `jsonld` are the only
// additions, so existing callers render byte-identically.

const SITE = 'https://huatlottery.com'
const GA = 'G-6WNQ6L7XKQ'

const STYLE = `
:root{--bg:#0f172a;--bg2:#1a1d26;--card:#ffffff;--ink:#0f172a;--ink2:#475569;--mute:#94a3b8;--line:#e2e8f0;--em:#059669;--em2:#047857;--cy:#0891b2;--gold:#b45309}
*{margin:0;padding:0;box-sizing:border-box}
body{background:#f1f5f9;color:var(--ink);font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:var(--em2);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:960px;margin:0 auto;padding:0 18px}
header.site{background:var(--bg);color:#fff}
header.site .wrap{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;flex-wrap:wrap;gap:10px}
.brand{font-weight:800;font-size:1.2rem;color:#fff;letter-spacing:-.01em}.brand span{color:var(--em)}
.nav a{color:#cbd5e1;font-size:.82rem;font-weight:600;margin-left:16px}.nav a:hover{color:#fff}
h1{font-size:clamp(1.5rem,3.4vw,2.1rem);line-height:1.15;margin:22px 0 8px}
.lead{color:var(--ink2);font-size:1.05rem;margin-bottom:18px;max-width:70ch}
h2{font-size:1.2rem;margin:26px 0 12px;color:var(--em2)}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin:14px 0}
table{width:100%;border-collapse:collapse;font-size:.92rem;background:#fff;border-radius:12px;overflow:hidden;border:1px solid var(--line)}
th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line)}
th{background:#f8fafc;font-size:.74rem;text-transform:uppercase;letter-spacing:.04em;color:var(--ink2)}
tr:last-child td{border-bottom:none}
.nums{font-variant-numeric:tabular-nums;font-weight:700;color:var(--em2)}
.add{color:var(--gold);font-weight:700}
.freq{display:flex;flex-wrap:wrap;gap:8px}
.chip{display:inline-flex;flex-direction:column;align-items:center;min-width:52px;background:#fff;border:1px solid var(--line);border-radius:10px;padding:8px 6px}
.chip b{font-size:1.15rem;color:var(--ink)}.chip s{font-size:.68rem;color:var(--mute);text-decoration:none}
.chip.hot{border-color:#fca5a5;background:#fef2f2}.chip.hot b{color:#b91c1c}
.chip.cold{border-color:#93c5fd;background:#eff6ff}.chip.cold b{color:#1d4ed8}
.checker input{font-size:1.3rem;letter-spacing:.3em;padding:12px 16px;border:2px solid var(--line);border-radius:10px;width:170px;text-align:center;font-variant-numeric:tabular-nums}
.checker button{font-size:1rem;font-weight:700;background:var(--em);color:#fff;border:none;border-radius:10px;padding:13px 24px;margin-left:10px;cursor:pointer}
.checker button:hover{background:var(--em2)}
#cres{margin-top:16px;font-size:1.02rem}
.links{margin:22px 0;font-size:.92rem;color:var(--ink2)}
.disc{font-size:.8rem;color:var(--mute);line-height:1.7;border-top:1px solid var(--line);margin-top:30px;padding:18px 0 40px}
footer.site{background:var(--bg2);color:#94a3b8}
@media(max-width:560px){th:nth-child(n+4),td:nth-child(n+4){display:none}}
`

const NAV = `<nav class="nav"><a href="/singapore-4d-results">SG 4D</a><a href="/singapore-toto-results">SG TOTO</a><a href="/malaysia-4d-results">Malaysia 4D</a><a href="/announcements">Announcements</a><a href="/">Home</a></nav>`
const FOOT_LINKS = `<p class="links">More results: <a href="/singapore-4d-results">Singapore 4D</a> · <a href="/singapore-toto-results">Singapore TOTO</a> · <a href="/magnum-4d-result">Magnum</a> · <a href="/sports-toto-4d-result">Sports Toto</a> · <a href="/da-ma-cai-result">Da Ma Cai</a> · <a href="/announcements">Announcements</a></p>`
const DISC = `<div class="disc">Results are compiled from official sources for reference and are provided without warranty; always verify against the official operator. Past results do not predict or influence future draws. Lottery is a form of gambling — if it stops being fun, call the National Problem Gambling Helpline <strong>1800-6-668-668</strong> or visit <a href="https://www.ncpg.org.sg" rel="nofollow">ncpg.org.sg</a>. Play responsibly. 18+.</div>`

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// `jsonld` accepts a single object or an array of them (e.g. Article +
// BreadcrumbList), each emitted as its own script tag.
function page({ title, desc, canonical, h1, lead, body, jsonld, extraStyle, breadcrumb }) {
  const e = esc
  const blocks = !jsonld ? [] : (Array.isArray(jsonld) ? jsonld : [jsonld])
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${e(desc)}">
<link rel="canonical" href="${canonical}">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta property="og:type" content="website"><meta property="og:title" content="${e(title)}"><meta property="og:description" content="${e(desc)}"><meta property="og:url" content="${canonical}"><meta property="og:site_name" content="Huatlottery">
<style>${STYLE}${extraStyle || ''}</style>
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${GA}');</script>
${blocks.map((j) => `<script type="application/ld+json">${JSON.stringify(j)}</script>`).join('\n')}
</head><body>
<header class="site"><div class="wrap"><a class="brand" href="/">Huat<span>lottery</span></a>${NAV}</div></header>
<main class="wrap">
${breadcrumb || ''}
<h1>${e(h1)}</h1>
${lead ? `<p class="lead">${lead}</p>` : ''}
${body}
${FOOT_LINKS}
${DISC}
</main></body></html>`
}

module.exports = { SITE, GA, STYLE, NAV, FOOT_LINKS, DISC, page, esc }
