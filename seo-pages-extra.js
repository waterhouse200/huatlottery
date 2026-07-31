// seo-pages-extra.js — additional server-rendered SEO pages (history tables,
// 4D checker, TOTO number-frequency). Purely additive: dedicated crawlable
// pages with real content, separate from the SPA. Registered from server.js.
// Compliance: reference/entertainment framing only — NO predictive-edge claims
// (Singapore Gambling Control Act 2022). Every stats page states past draws do
// not predict future draws; NCPG helpline in the footer.

module.exports = function registerSeoExtra(app, db, helpers) {
  const { seoDate, esc, parseFourdRow } = helpers
  const SITE = 'https://huatlottery.com'
  const e = (s) => esc ? esc(String(s ?? '')) : String(s ?? '')

  const { page } = require('./lib/seo-layout')

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
