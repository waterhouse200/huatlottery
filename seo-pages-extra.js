// seo-pages-extra.js — additional server-rendered SEO pages (history tables,
// 4D checker, TOTO number-frequency). Purely additive: dedicated crawlable
// pages with real content, separate from the SPA. Registered from server.js.
// Compliance: reference/entertainment framing only — NO predictive-edge claims
// (Singapore Gambling Control Act 2022). Every stats page states past draws do
// not predict future draws; NCPG helpline in the footer.

module.exports = function registerSeoExtra(app, db, helpers) {
  const { seoDate, esc, parseFourdRow } = helpers
  const SITE = 'https://huatlottery.com'
  const GA = 'G-6WNQ6L7XKQ'
  const e = (s) => esc ? esc(String(s ?? '')) : String(s ?? '')

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

  const NAV = `<nav class="nav"><a href="/singapore-4d-results">SG 4D</a><a href="/singapore-toto-results">SG TOTO</a><a href="/malaysia-4d-results">Malaysia 4D</a><a href="/">Home</a></nav>`
  const FOOT_LINKS = `<p class="links">More results: <a href="/singapore-4d-results">Singapore 4D</a> · <a href="/singapore-toto-results">Singapore TOTO</a> · <a href="/magnum-4d-result">Magnum</a> · <a href="/sports-toto-4d-result">Sports Toto</a> · <a href="/da-ma-cai-result">Da Ma Cai</a></p>`
  const DISC = `<div class="disc">Results are compiled from official sources for reference and are provided without warranty; always verify against the official operator. Past results do not predict or influence future draws. Lottery is a form of gambling — if it stops being fun, call the National Problem Gambling Helpline <strong>1800-6-668-668</strong> or visit <a href="https://www.ncpg.org.sg" rel="nofollow">ncpg.org.sg</a>. Play responsibly. 18+.</div>`

  function page({ title, desc, canonical, h1, lead, body, jsonld }) {
    return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${e(desc)}">
<link rel="canonical" href="${canonical}">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta property="og:type" content="website"><meta property="og:title" content="${e(title)}"><meta property="og:description" content="${e(desc)}"><meta property="og:url" content="${canonical}"><meta property="og:site_name" content="Huatlottery">
<style>${STYLE}</style>
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${GA}');</script>
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>` : ''}
</head><body>
<header class="site"><div class="wrap"><a class="brand" href="/">Huat<span>lottery</span></a>${NAV}</div></header>
<main class="wrap">
<h1>${e(h1)}</h1>
${lead ? `<p class="lead">${lead}</p>` : ''}
${body}
${FOOT_LINKS}
${DISC}
</main></body></html>`
  }

  const HISTORY_LIMIT = 300 // ~2 years across games
  const safe = (fn, res) => { try { res.send(fn()) } catch (err) { res.status(500).end() } }

  // ─── 1. SG TOTO history ─────────────────────────────────
  app.get('/singapore-toto-results/history', (req, res) => safe(() => {
    const rows = db.prepare('SELECT * FROM toto_draws ORDER BY draw_no DESC LIMIT ?').all(HISTORY_LIMIT)
    const body = `<div class="card"><table><thead><tr><th>Draw</th><th>Date</th><th>Winning Numbers</th><th>Additional</th></tr></thead><tbody>${rows.map(r => `<tr><td>#${r.draw_no}</td><td>${e(seoDate(r.draw_date))}</td><td class="nums">${[r.num1, r.num2, r.num3, r.num4, r.num5, r.num6].join(' · ')}</td><td class="add">${r.additional_num}</td></tr>`).join('')}</tbody></table></div>`
    return page({ title: 'Singapore TOTO Past Results & History — Winning Numbers Archive | Huatlottery', desc: `Singapore Pools TOTO past results and winning-number history — the last ${rows.length} draws with dates and additional numbers.`, canonical: `${SITE}/singapore-toto-results/history`, h1: 'Singapore TOTO Past Results & History', lead: `A complete archive of recent Singapore Pools TOTO draws — winning numbers and the additional number for the last ${rows.length} draws. TOTO is drawn every Monday and Thursday.`, body })
  }, res))

  // ─── 2. SG 4D history ───────────────────────────────────
  app.get('/singapore-4d-results/history', (req, res) => safe(() => {
    const rows = db.prepare('SELECT * FROM fourd_draws ORDER BY draw_no DESC LIMIT ?').all(HISTORY_LIMIT)
    const body = `<div class="card"><table><thead><tr><th>Draw</th><th>Date</th><th>1st</th><th>2nd</th><th>3rd</th></tr></thead><tbody>${rows.map(r => `<tr><td>#${r.draw_no}</td><td>${e(seoDate(r.draw_date))}</td><td class="nums">${e(r.first_prize)}</td><td>${e(r.second_prize)}</td><td>${e(r.third_prize)}</td></tr>`).join('')}</tbody></table></div>`
    return page({ title: 'Singapore 4D Past Results & History — Winning Numbers Archive | Huatlottery', desc: `Singapore Pools 4D past results and winning-number history — 1st, 2nd and 3rd prizes for the last ${rows.length} draws.`, canonical: `${SITE}/singapore-4d-results/history`, h1: 'Singapore 4D Past Results & History', lead: `Recent Singapore Pools 4D results — 1st, 2nd and 3rd prize winning numbers for the last ${rows.length} draws. 4D is drawn on Wednesday, Saturday and Sunday.`, body })
  }, res))

  // ─── 3. Malaysia 4D history ─────────────────────────────
  app.get('/malaysia-4d-results/history', (req, res) => safe(() => {
    const opName = { magnum: 'Magnum', sportstoto: 'Sports Toto', damacai: 'Da Ma Cai' }
    const rows = db.prepare("SELECT * FROM my_draws WHERE operator IN ('magnum','sportstoto','damacai') ORDER BY draw_date DESC, operator LIMIT ?").all(HISTORY_LIMIT)
    const body = `<div class="card"><table><thead><tr><th>Date</th><th>Operator</th><th>1st</th><th>2nd</th><th>3rd</th></tr></thead><tbody>${rows.map(r => `<tr><td>${e(seoDate(r.draw_date))}</td><td>${e(opName[r.operator] || r.operator)}</td><td class="nums">${e(r.first_prize)}</td><td>${e(r.second_prize)}</td><td>${e(r.third_prize)}</td></tr>`).join('')}</tbody></table></div>`
    return page({ title: 'Malaysia 4D Past Results & History — Magnum, Sports Toto, Da Ma Cai | Huatlottery', desc: `Malaysia 4D past results and history for Magnum, Sports Toto and Da Ma Cai — 1st, 2nd and 3rd prizes across the last ${rows.length} draws.`, canonical: `${SITE}/malaysia-4d-results/history`, h1: 'Malaysia 4D Past Results & History', lead: `Recent Malaysia 4D results for Magnum, Sports Toto and Da Ma Cai — 1st, 2nd and 3rd prize winning numbers. Draws are held on Wednesday, Saturday and Sunday (plus occasional special draws).`, body })
  }, res))

  // ─── 4. Singapore 4D results checker ────────────────────
  app.get('/4d-results-checker', (req, res) => safe(() => {
    const rows = db.prepare('SELECT * FROM fourd_draws ORDER BY draw_no DESC LIMIT 200').all().map(r => {
      const p = parseFourdRow ? parseFourdRow(r) : r
      return { d: r.draw_no, dt: r.draw_date, top: [r.first_prize, r.second_prize, r.third_prize], st: p.starter_prizes || [], co: p.consolation_prizes || [] }
    })
    const data = JSON.stringify(rows).replace(/</g, '\\u003c')
    const body = `
<p class="lead">Enter a 4-digit number to check whether it appeared in the last 200 Singapore Pools 4D draws, and in which prize category. This checks <strong>past results only</strong>.</p>
<div class="card checker">
  <input id="q" inputmode="numeric" maxlength="4" placeholder="1234" aria-label="4-digit number">
  <button id="go">Check</button>
  <div id="cres"></div>
</div>
<h2>How 4D prizes work</h2>
<p>Each Singapore Pools 4D draw produces 23 winning numbers: the <strong>1st, 2nd and 3rd</strong> prizes, <strong>10 Starter</strong> prizes and <strong>10 Consolation</strong> prizes. A number wins if it matches any of these, with the payout depending on the category and your bet type (Big or Small).</p>
<script>
const D=${data};
const cat={0:'1st Prize',1:'2nd Prize',2:'3rd Prize'};
function check(){
  var v=(document.getElementById('q').value||'').replace(/\\D/g,'').padStart(4,'0').slice(-4);
  if(v.length!==4){document.getElementById('cres').textContent='Enter a 4-digit number.';return}
  var hits=[];
  for(const dr of D){
    var idx=dr.top.indexOf(v); if(idx>-1) hits.push('Draw #'+dr.d+' ('+dr.dt+') — '+cat[idx]);
    if(dr.st.indexOf(v)>-1) hits.push('Draw #'+dr.d+' ('+dr.dt+') — Starter prize');
    if(dr.co.indexOf(v)>-1) hits.push('Draw #'+dr.d+' ('+dr.dt+') — Consolation prize');
  }
  var el=document.getElementById('cres');
  if(!hits.length){el.innerHTML='<strong>'+v+'</strong> did not appear in the last 200 draws.';}
  else{el.innerHTML='<strong>'+v+'</strong> appeared '+hits.length+' time'+(hits.length>1?'s':'')+':<br>'+hits.slice(0,20).map(function(h){return '• '+h}).join('<br>');}
  if(window.gtag)gtag('event','4d_check',{value:v});
}
document.getElementById('go').addEventListener('click',check);
document.getElementById('q').addEventListener('keydown',function(e){if(e.key==='Enter')check()});
</script>`
    return page({ title: 'Singapore 4D Results Checker — Check Your 4D Number | Huatlottery', desc: 'Free Singapore 4D results checker. Enter your 4-digit number to see if it won in recent Singapore Pools 4D draws and in which prize category.', canonical: `${SITE}/4d-results-checker`, h1: 'Singapore 4D Results Checker', body })
  }, res))

  // ─── 5. TOTO number frequency (hot & cold) ──────────────
  app.get('/singapore-toto-hot-cold-numbers', (req, res) => safe(() => {
    const rows = db.prepare('SELECT num1,num2,num3,num4,num5,num6,additional_num FROM toto_draws').all()
    const freq = Array(50).fill(0)
    for (const r of rows) for (const n of [r.num1, r.num2, r.num3, r.num4, r.num5, r.num6, r.additional_num]) if (n >= 1 && n <= 49) freq[n]++
    const ranked = Array.from({ length: 49 }, (_, i) => ({ n: i + 1, c: freq[i + 1] })).sort((a, b) => b.c - a.c)
    const hot = ranked.slice(0, 10), cold = ranked.slice(-10).reverse()
    const chips = (arr, cls) => `<div class="freq">${arr.map(x => `<div class="chip ${cls}"><b>${x.n}</b><s>${x.c}×</s></div>`).join('')}</div>`
    const body = `
<div class="card" style="background:#fffbeb;border-color:#fde68a"><strong>Important:</strong> These frequencies are historical trivia only. Every TOTO draw is independent and random — past frequency does <strong>not</strong> make any number more or less likely to be drawn next. This page does not predict results.</div>
<h2>Most frequently drawn numbers</h2>${chips(hot, 'hot')}
<h2>Least frequently drawn numbers</h2>${chips(cold, 'cold')}
<p style="margin-top:18px;color:var(--ink2)">Based on all ${rows.length} Singapore Pools TOTO draws in our archive (numbers 1–49, including the additional number).</p>`
    return page({ title: 'Singapore TOTO Hot & Cold Numbers — Most Drawn Numbers (Stats) | Huatlottery', desc: `Singapore Pools TOTO number frequency: the most and least frequently drawn numbers across all ${rows.length} draws. Historical statistics for interest only.`, canonical: `${SITE}/singapore-toto-hot-cold-numbers`, h1: 'Singapore TOTO Hot & Cold Numbers', lead: 'Which TOTO numbers have come up most and least often across every draw in our archive — presented as historical statistics for interest.', body })
  }, res))

  // sitemap entries this module adds: [path, lastmodSql]
  return [
    ['/singapore-toto-results/history', 'SELECT MAX(draw_date) d FROM toto_draws'],
    ['/singapore-4d-results/history', 'SELECT MAX(draw_date) d FROM fourd_draws'],
    ['/malaysia-4d-results/history', "SELECT MAX(draw_date) d FROM my_draws WHERE operator IN ('magnum','sportstoto','damacai')"],
    ['/4d-results-checker', 'SELECT MAX(draw_date) d FROM fourd_draws'],
    ['/singapore-toto-hot-cold-numbers', 'SELECT MAX(draw_date) d FROM toto_draws'],
  ]
}
