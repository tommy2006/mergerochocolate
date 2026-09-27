// Mergero front door: the four-screen story a judge (or an advisor) understands from the first screen.
// 1 Why · 2 Who to call · 3 The conversation · 4 At scale. Arrow keys move between screens (presenter-friendly).
// Reads the engine's own API (/api/engine/*, same origin) and falls back to a baked snapshot so it never shows an empty screen.
(function () {
  'use strict';
  const app = document.getElementById('app');
  const STEPS = [
    { id: 'why', t: 'Why' },
    { id: 'who', t: 'Who to call' },
    { id: 'talk', t: 'The conversation' },
    { id: 'scale', t: 'At scale' },
  ];
  const S = { step: 'why', data: null, live: false, selected: null, busy: {}, conv2call: 8, call2mandate: 25 };

  /* ---------- helpers ---------- */
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtN = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
  const eurM = (n) => (n == null ? null : '€' + (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M');
  const initials = (n) => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join('').toUpperCase();
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
  const firstSentence = (t, max) => {
    t = String(t || '').replace(/\s+/g, ' ').trim();
    const m = t.match(/^(.{40,}?[.!?])\s/);
    let s = m ? m[1] : t;
    if (s.length > max) s = s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
    return s;
  };
  const COUNTRY = { NO: 'Norway', FI: 'Finland', SE: 'Sweden', DK: 'Denmark', DE: 'Germany', AT: 'Austria', CH: 'Switzerland' };
  // Register names come in capitals ("AGROMILJØ AS"): title-case word by word, keeping legal forms as written.
  const KEEP = { AS: 'AS', 'A/S': 'A/S', ASA: 'ASA', AB: 'AB', OY: 'Oy', OYJ: 'Oyj', GMBH: 'GmbH', APS: 'ApS', AG: 'AG', ROV: 'ROV' };
  const titleCase = (s) => String(s || '').split(/(\s+)/).map((w) => {
    const k = KEEP[w.toUpperCase().replace(/[.,]/g, '')];
    if (k) return k;
    return w.length > 1 && w === w.toUpperCase() && /\p{L}/u.test(w) ? w[0] + w.slice(1).toLowerCase() : w;
  }).join('');
  // A short English label for what the company does: the first product line from the profile, else the register's industry.
  const whatTheyDo = (c) => {
    const p = c.enrichment && (c.enrichment.products || [])[0];
    const t = typeof p === 'string' ? p : p && (p.name || p.product || p.line);
    return firstSentence(String(t || c.industry || '').replace(/\s*\([^)]*\)?/g, '').trim(), 48);
  };
  function band(r) {
    if (r == null) return { cls: 's-cold', lab: 'Not scored' };
    if (r >= 65) return { cls: 's-hot', lab: 'Call now' };
    if (r >= 40) return { cls: 's-warm', lab: 'Warm' };
    return { cls: 's-cold', lab: 'Not now' };
  }
  function toast(msg, err) {
    const el = document.createElement('div');
    el.className = 'toast' + (err ? ' err' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), err ? 7000 : 4500);
  }
  async function api(path, method, body) {
    const r = await fetch(path, { method: method || 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!r.ok) throw new Error((data && data.error) || r.status + ' ' + r.statusText);
    return data;
  }

  /* ---------- data ---------- */
  async function load() {
    let live = null;
    try {
      const [companies, settings, capacity, reach, stats] = await Promise.all([
        api('/api/engine/companies'), api('/api/engine/settings'), api('/api/engine/advisors/capacity'),
        api('/api/engine/registry/reach').catch(() => null), api('/api/engine/stats').catch(() => null),
      ]);
      const scored = companies.filter((c) => c.score);
      if (scored.length >= 3) live = { companies: scored, settings, capacity, reach, scale: stats && stats.scale, total: companies.length };
    } catch (e) { /* fall through to the snapshot */ }
    if (live) { S.data = live; S.live = true; }
    else {
      try { S.data = await api('/front/snapshot.json'); S.live = false; }
      catch (e) { S.data = { companies: [], settings: {}, capacity: null, reach: null }; }
    }
    S.data.companies.sort((a, b) => (b.score.readiness || 0) - (a.score.readiness || 0));
    document.getElementById('live').innerHTML = S.live ? '<span class="dot"></span>Live data' : '<span class="dot off"></span>Offline copy';
  }
  const companyById = (id) => S.data.companies.find((c) => c.id === id);
  const sender = () => (S.data.settings && S.data.settings.sender) || { name: 'Timo Tontti', title: 'Managing Partner', firm: 'Mergero' };
  function advisorFor(c) {
    const list = (S.data.settings && S.data.settings.advisors) || [];
    return list.find((a) => a.id === c.advisor_id) || list.find((a) => (a.markets || []).indexOf(c.country) >= 0) || list[0] || sender();
  }
  const firstEmail = (c) => (c.messages || []).find((m) => m.step === 1 && m.channel === 'email') || (c.messages || []).find((m) => m.step === 1);
  const lastUpdate = (c) => (c.conversation || []).filter((e) => e.direction === 'inbound' && e.score_update).pop();
  const noReg = () => { const r = (S.data.reach && S.data.reach.countries || []).find((x) => x.country === 'NO'); return r && r.companies; };

  /* ---------- router ---------- */
  function go(step, id) {
    if (id) S.selected = id;
    if (step === 'talk' && !S.selected && S.data.companies[0]) S.selected = S.data.companies[0].id;
    S.step = step;
    history.replaceState(null, '', '#' + step + (step === 'talk' && S.selected ? '/' + S.selected : ''));
    render();
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }
  function renderSteps() {
    const i = STEPS.findIndex((s) => s.id === S.step);
    document.getElementById('steps').innerHTML = STEPS.map((s, k) =>
      '<button class="step' + (k === i ? ' on' : k < i ? ' done' : '') + '" data-go="' + s.id + '"><span class="n">' + (k < i ? '✓' : k + 1) + '</span><span class="t">' + esc(s.t) + '</span></button>').join('');
  }
  function render() {
    renderSteps();
    const v = { why: vWhy, who: vWho, talk: vTalk, scale: vScale }[S.step] || vWhy;
    app.innerHTML = '<section class="screen">' + v() + '</section>';
  }
  function nextBtn(to, label) {
    return '<div class="next-bar"><button class="btn primary" data-go="' + to + '">' + esc(label) + ' →</button><span class="kbd">or press <b>→</b></span></div>';
  }

  /* ---------- 1 · Why ---------- */
  function vWhy() {
    const cs = S.data.companies;
    const worth = cs.filter((c) => (c.score.readiness || 0) >= 40).length;
    const sc = S.data.scale || {};
    const reg = noReg();
    return '<div class="eyebrow">Mergero · sell-side origination</div>' +
      '<h1>Find the owners who are ready <em>before they know it</em>, and start the conversation.</h1>' +
      '<p class="lead">Today every mandate starts person by person. This reads the public registers and the web, spots owners likely to be open to a transaction, and writes the first email in the advisor\'s own voice. The advisor approves; replies come back already read and scored.</p>' +
      '<div class="stats">' +
      '<div class="card stat"><div class="v">' + (reg ? fmtN(reg) : '35,113') + '</div><div class="l">Norwegian companies in Mergero\'s size range, pulled live from the public register. Finland and Denmark next.</div></div>' +
      '<div class="card stat"><div class="v">' + worth + ' <small>of ' + cs.length + ' researched</small></div><div class="l">owners worth a call this week, each with a reason you can say out loud and the evidence behind it.</div></div>' +
      '<div class="card stat"><div class="v">' + (sc.minutes_per_prospect ? sc.minutes_per_prospect + ' <small>min</small>' : '3 <small>min</small>') + '</div><div class="l">to research one company, score it, match buyers and draft the first email' + (sc.cost_per_prospect_usd ? ', for about $' + sc.cost_per_prospect_usd.toFixed(2) : '') + '. An analyst takes half a day.</div></div>' +
      '</div>' +
      '<div class="flow">' + [['Public register', 'owner age'], ['Website & filings', 'sourced facts'], ['Readiness score', 'why now'], ['Buyer demand', 'MGX mandates'], ['First email', 'advisor\'s voice'], ['Owner replies', 'read & re-scored'], ['First call', 'the mandate path']]
        .map((f, k) => '<div class="f' + (k === 2 || k === 4 || k === 5 ? ' h' : '') + '">' + esc(f[0]) + '<span>' + esc(f[1]) + '</span></div>').join('<span class="arrow">→</span>') + '</div>' +
      nextBtn('who', 'See this week\'s owners to call');
  }

  /* ---------- 2 · Who to call ---------- */
  function signalChips(c, n) {
    const sig = (c.score.signals || []).filter((g) => g.direction !== 'neutral').sort((a, b) => (b.weight === 'high') - (a.weight === 'high')).slice(0, n || 3);
    return sig.map((g) => '<span class="chip ' + (g.direction === 'positive' ? 'pos' : 'neg') + '" title="' + esc(g.note || '') + '">' + (g.direction === 'positive' ? '+ ' : '− ') + esc(firstSentence(g.signal, 42)) + '</span>').join('');
  }
  function ownerLine(c) {
    const o = c.owner || {};
    if (!o.name) return '<div class="oc-owner"><div class="avatar">?</div><div class="src">Owner not identified yet</div></div>';
    return '<div class="oc-owner"><div class="avatar">' + esc(initials(o.name)) + '</div><div><div>' + esc(o.name) + (o.age ? ', <span class="age">' + o.age + '</span>' : '') + '</div>' +
      '<div class="src">' + esc(o.title || 'Owner') + (o.age_source ? ' · age from the ' + esc(/brønnøysund/i.test(o.age_source) ? 'Norwegian register' : o.age_source) : '') + '</div></div></div>';
  }
  // For a low score, the sentence that says why not ("…but it isn't for sale"), not the "on paper it looks great" opener.
  function whyNot(t) {
    const parts = String(t || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/);
    const hit = parts.find((p) => /\b(but|however|isn't|is not|not for sale|no reason|unlikely|recently|just)\b/i.test(p));
    let s = (hit || parts[0] || '').replace(/^(but|however),?\s*/i, '');
    s = s.charAt(0).toUpperCase() + s.slice(1);
    return s.length > 190 ? s.slice(0, 189).replace(/\s+\S*$/, '') + '…' : s;
  }
  function vWho() {
    const cs = S.data.companies;
    const top = cs.filter((c) => (c.score.readiness || 0) >= 25);
    const rest = cs.filter((c) => (c.score.readiness || 0) < 25);
    const card = (c) => {
      const b = band(c.score.readiness);
      const m = (c.matches || []).slice().sort((x, y) => y.fit - x.fit);
      return '<button class="card owner-card" data-open="' + esc(c.id) + '">' +
        '<div class="oc-top"><div><div class="oc-name">' + esc(titleCase(c.name)) + '</div><div class="oc-meta">' + esc([titleCase(c.city), COUNTRY[c.country] || c.country].filter(Boolean).join(', ')) + (whatTheyDo(c) ? ' · ' + esc(whatTheyDo(c)) : '') + '</div></div>' +
        '<div class="score ' + b.cls + '"><div class="num">' + (c.score.readiness ?? '—') + '</div><div class="lab">' + b.lab + '</div></div></div>' +
        ownerLine(c) +
        '<div class="oc-why">' + esc(firstSentence(c.score.why_now, 190)) + '</div>' +
        '<div class="chips">' + signalChips(c, 3) + '</div>' +
        '<div class="oc-foot"><span>' + (m.length ? '<b>' + m.length + ' buyer' + (m.length > 1 ? 's' : '') + '</b> want this · best fit <b>' + m[0].fit + '%</b>' : 'No buyer match yet') + '</span><span class="go">Open →</span></div>' +
        '</button>';
    };
    return '<div class="eyebrow">Step 2 · This week</div><h2>Owners to call this week</h2>' +
      '<p class="sub">Ranked by <b>readiness</b>: how likely the owner is to be open to a first conversation (a sale, a partner, or growth capital) in the next 6–18 months. Every score comes with the reason and the evidence.</p>' +
      '<div class="grid">' + top.map(card).join('') + '</div>' +
      (rest.length ? '<div class="card also"><h4>Also screened, and deliberately not contacted</h4>' + rest.map((c) =>
        '<div class="also-row" data-open="' + esc(c.id) + '"><span class="nm">' + esc(titleCase(c.name)) + ' · ' + (c.score.readiness ?? '—') + '</span><span class="why">' + esc(whyNot(c.score.why_now)) + '</span></div>').join('') + '</div>' : '') +
      nextBtn('talk', 'Open the top owner');
  }

  /* ---------- 3 · The conversation ---------- */
  const PRIORITY = { ownership: 0, people: 1, events: 2, financials: 3, direction: 4, customers: 5, offering: 6, footprint: 7 };
  function ring(v) {
    const r = 40, circ = 2 * Math.PI * r, val = Math.max(0, Math.min(100, v || 0));
    const col = val >= 65 ? '#34d399' : val >= 40 ? '#fbbf24' : '#64748b';
    return '<div class="ring"><svg width="92" height="92"><circle cx="46" cy="46" r="' + r + '" fill="none" stroke="#1e293b" stroke-width="8"/><circle cx="46" cy="46" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="8" stroke-linecap="round" stroke-dasharray="' + circ.toFixed(1) + '" stroke-dashoffset="' + (circ * (1 - val / 100)).toFixed(1) + '"/></svg><div class="c"><div><b>' + (v ?? '—') + '</b><span>Readiness</span></div></div></div>';
  }
  // Two sentences on screen (readable from the back of the room); the full reasoning one click away.
  function whyNowHtml(t) {
    const parts = String(t || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/);
    let head = parts.slice(0, 2).join(' ');
    if (head.length > 320) head = head.slice(0, 319).replace(/\s+\S*$/, '') + '…';
    const rest = parts.length > 2 || head.endsWith('…');
    return '<p class="why-text">' + esc(head) + '</p>' + (rest ? '<details class="more"><summary>Read the full reasoning</summary><p class="why-text">' + esc(t) + '</p></details>' : '');
  }
  function vTalk() {
    const c = companyById(S.selected) || S.data.companies[0];
    if (!c) return '<p class="sub">No researched owners yet.</p>';
    const o = c.owner || {};
    const facts = ((c.research && c.research.facts) || []).slice().sort((a, b) => (PRIORITY[a.category] ?? 9) - (PRIORITY[b.category] ?? 9)).slice(0, 6);
    const fin = [c.revenue_eur != null && ['Revenue', eurM(c.revenue_eur)], c.ebitda_eur != null && ['EBITDA', eurM(c.ebitda_eur)], c.employees != null && ['People', fmtN(c.employees)], c.founded && ['Founded', c.founded]].filter(Boolean).slice(0, 3);
    const adv = advisorFor(c);
    const m = firstEmail(c);
    const matches = (c.matches || []).slice().sort((x, y) => y.fit - x.fit).slice(0, 4);
    const lint = m && m.lint && (m.lint.after || m.lint);
    return '<button class="back" data-go="who">← All owners</button>' +
      '<div class="head">' + ring(c.score.readiness) + '<div class="t"><div class="eyebrow" style="margin-bottom:6px">Step 3 · One owner</div><h2>' + esc(titleCase(c.name)) + '</h2>' +
      '<div class="m">' + esc([titleCase(c.city), COUNTRY[c.country]].filter(Boolean).join(', ')) + (whatTheyDo(c) ? ' · ' + esc(whatTheyDo(c)) : '') + (o.name ? ' · ' + esc(o.name) + (o.age ? ', ' + o.age : '') + ' · ' + esc(o.title || 'owner') : '') + (c.website ? ' · <a href="' + esc(c.website) + '" target="_blank" rel="noopener">' + esc(host(c.website)) + '</a>' : '') + '</div></div></div>' +
      '<div class="cols">' +
      // why now
      '<div class="card panel"><h3><span class="n">1</span>Why now</h3>' +
      (fin.length ? '<div class="fin">' + fin.map((f) => '<div><b>' + esc(f[1]) + '</b><span>' + esc(f[0]) + '</span></div>').join('') + '</div>' : '') +
      whyNowHtml(c.score.why_now) +
      (facts.length ? '<ul class="facts">' + facts.map((f) => '<li>' + esc(f.claim) + ' <a href="' + esc(f.url) + '" target="_blank" rel="noopener">' + esc(host(f.url)) + ' ↗</a></li>').join('') + '</ul>' : '') +
      '</div>' +
      // email
      '<div class="card panel"><h3><span class="n">2</span>The first email</h3>' +
      (m ? '<div class="mail"><div class="mail-h"><span class="k">From</span><span>' + esc(adv.name) + ', ' + esc(sender().firm || 'Mergero') + '</span><span class="k">To</span><span>' + esc(o.name || 'The owner') + '</span><span class="k">Subject</span><span class="subj">' + esc(m.subject || '') + '</span></div><div class="mail-b">' + esc(m.body) + '</div></div>' +
        '<div class="badges"><span class="badge b-green">Written from this company\'s own facts</span>' + (lint && lint.score != null ? '<span class="badge ' + (lint.blocks_send ? 'b-amber' : 'b-green') + '" title="Checked for templated phrasing, AI tells and wording reused from other emails">' + (lint.blocks_send ? 'Needs an edit' : 'Reads like a person') + ' · ' + lint.score + '/100 AI-tell</span>' : '') + '<span class="badge b-sky">Never says "sell" in a first touch</span></div>' +
        '<div class="actions">' + (m.status === 'sent' || m.status === 'replied' ? '<span class="badge b-green">✓ Sent</span>' :
          '<button class="btn primary sm" data-act="send" data-id="' + esc(m.id) + '" ' + (S.live ? '' : 'disabled title="Offline copy"') + '>' + (S.busy.send ? '<span class="spin"></span>Sending…' : 'Approve & send') + '</button>') +
        '<span class="note">Sent under ' + esc(adv.name) + '\'s name, within a 75-a-day cap. Nothing goes out without approval.</span></div>'
        : '<div class="result empty"><div>No email drafted yet.<br><br><button class="btn primary sm" data-act="draft" data-id="' + esc(c.id) + '" ' + (S.live ? '' : 'disabled') + '>' + (S.busy.draft ? '<span class="spin"></span>Writing in ' + esc(adv.name) + '\'s voice…' : 'Write the first email') + '</button></div></div>') +
      '</div>' +
      // buyers
      '<div class="card panel"><h3><span class="n">3</span>Buyers who want this</h3>' +
      (matches.length ? matches.map((x) => '<div class="buyer"><div class="bn">' + esc(x.buyer_name) + '<span>' + x.fit + '%</span></div><div class="bar"><i style="width:' + x.fit + '%"></i></div><p>' + esc(firstSentence(x.reason, 160)) + '</p></div>').join('') : '<p class="note">No buyer mandate fits yet.</p>') +
      '<p class="note" style="margin-top:12px">Anonymised mandates from the MGX network. The email mentions the demand, never the names.</p></div>' +
      '</div>' +
      replyBand(c) +
      nextBtn('scale', 'Now picture this at scale');
  }
  const SAMPLES = [
    { k: 'Interested', cls: 'pos', t: 'Thanks for reaching out. Timing is actually interesting: I turn 68 next year and none of my children want to take over. What kind of buyers are we talking about, and what are companies like ours usually valued at? Happy to talk next week.' },
    { k: 'Not now', cls: '', t: 'Appreciate the note. We are in the middle of a big expansion and I want to see it through first. Maybe get back to me in a couple of years.' },
    { k: 'No', cls: 'neg', t: 'Thanks, but we just brought in a minority investor last year and the family plans to run the company for the long term. Not interested.' },
  ];
  function replyBand(c) {
    const u = S.busy.reply ? null : lastUpdate(c);
    return '<div class="card reply-band"><div><h3 style="margin:0 0 6px;font-size:13px;text-transform:uppercase;letter-spacing:1px;color:var(--muted)"><span class="n" style="display:inline-grid;width:20px;height:20px;border-radius:50%;background:var(--green-bg);color:var(--green);place-items:center;font-size:11px;margin-right:8px">4</span>When the owner answers</h3>' +
      '<p class="note" style="font-size:13.5px;margin:0">Replies arrive by email. An agent reads the owner\'s own words, in any language, and moves the score, with the exact phrases as evidence. Try one:</p>' +
      '<div class="samples">' + SAMPLES.map((s, k) => '<button class="sample" data-sample="' + k + '" ' + (S.live && !S.busy.reply ? '' : 'disabled') + '><b class="' + (s.cls === 'pos' ? 'up' : s.cls === 'neg' ? 'down' : '') + '" style="background:none;padding:0">' + esc(s.k) + '</b>' + esc(s.t) + '</button>').join('') + '</div>' +
      '<textarea id="reply-text" placeholder="…or paste a real reply, in any language"></textarea>' +
      '<div class="actions" style="margin-top:10px"><button class="btn sm" data-act="reply" data-id="' + esc(c.id) + '" ' + (S.live && !S.busy.reply ? '' : 'disabled') + '>Read this reply</button></div></div>' +
      '<div class="result' + (u || S.busy.reply ? '' : ' empty') + '" id="reply-result">' + (S.busy.reply ? progressHtml(S.busy.reply) : u ? updateHtml(u) : 'The score change and the phrases behind it appear here.') + '</div></div>';
  }
  function progressHtml(p) {
    const steps = ['Reading the reply', 'Updating readiness and timing', 'Drafting the advisor\'s answer'];
    return '<div class="progress">' + steps.map((t, k) => '<div class="' + (k < p.i ? 'ok' : k === p.i ? 'on' : '') + '">' + (k < p.i ? '<span class="tick">✓</span>' : k === p.i ? '<span class="spin"></span>' : '<span class="tick">·</span>') + esc(t) + '</div>').join('') + '</div>' +
      '<p class="note">About 20–40 seconds on the EU-hosted model.</p>';
  }
  function updateHtml(e) {
    const u = e.score_update;
    const d = u.delta;
    return '<div class="move">' + (u.from && u.from.readiness != null ? '<span class="from">' + u.from.readiness + '</span>' : '') + '<span class="big">' + u.to.readiness + '</span>' +
      (d ? '<span class="d ' + (d > 0 ? 'up' : 'down') + '">' + (d > 0 ? '+' : '') + d + '</span>' : '') +
      '<span class="note" style="font-size:14px">timing: ' + (u.from && u.from.recommended_timing && u.from.recommended_timing !== u.to.recommended_timing ? esc(u.from.recommended_timing) + ' → ' : '') + '<b style="color:var(--text)">' + esc(u.to.recommended_timing) + '</b></span></div>' +
      '<div style="font-size:14.5px;line-height:1.55;color:#dbe3ee">' + esc(u.reason || '') + '</div>' +
      ((u.evidence || []).length ? '<ul class="quotes">' + u.evidence.slice(0, 4).map((q) => '<li class="' + (q.effect === 'raises' ? 'pos' : q.effect === 'lowers' ? 'neg' : '') + '"><q>' + esc(q.quote) + '</q> ' + esc(q.reading) + '</li>').join('') + '</ul>' : '') +
      (e.triage && e.triage.next_step ? '<div class="note" style="font-size:13.5px"><b style="color:var(--text)">Next step:</b> ' + esc(e.triage.next_step) + '</div>' : '');
  }

  /* ---------- 4 · At scale ---------- */
  function vScale() {
    const cap = S.data.capacity || { emails_per_day: 150, new_owners_per_month: 1050, conversations_per_month: 499, advisors: [] };
    const f = (S.data.settings && S.data.settings.funnel_assumptions) || { contact_to_reply: 0.475 };
    const owners = cap.new_owners_per_month;
    const convs = Math.round(owners * f.contact_to_reply);
    const calls = Math.round(convs * S.conv2call / 100);
    const mandates = Math.max(0, Math.round(calls * S.call2mandate / 100 * 10) / 10);
    const max = owners;
    const row = (l, sub, v, cls) => '<div class="frow ' + (cls || '') + '"><div class="fl">' + esc(l) + '<small>' + esc(sub) + '</small></div><div class="fb"><i style="width:' + Math.max(1.5, v / max * 100) + '%"></i></div><div class="fv">' + fmtN(v) + '</div></div>';
    const sc = S.data.scale || {};
    const reg = noReg();
    const nAdv = (cap.advisors || []).length || 2;
    return '<div class="eyebrow">Step 4 · At scale</div><h2>What ' + nAdv + ' advisors can do in a month</h2>' +
      '<p class="sub">Each advisor sends under their own name, at most ' + ((cap.advisors && cap.advisors[0] && cap.advisors[0].daily_cap) || 75) + ' emails a day so deliverability holds. The reply rate is Mergero\'s own: 1,000 outbound contacts bring about 450–500 owner conversations.</p>' +
      '<div class="scale"><div class="card funnel">' +
      row('New owners contacted', 'first email + 2 follow-ups share the daily cap', owners) +
      row('Owner conversations', Math.round(f.contact_to_reply * 100) + '% · Mergero\'s benchmark', convs) +
      row('First calls with an advisor', S.conv2call + '% of conversations · your assumption', calls) +
      row('Engagement letters', S.call2mandate + '% of first calls · your assumption', mandates, 'final') +
      '<div class="sliders"><label>Conversation → first call: <b id="v1">' + S.conv2call + '%</b><input type="range" min="1" max="30" value="' + S.conv2call + '" data-slider="conv2call"></label>' +
      '<label>First call → engagement letter: <b id="v2">' + S.call2mandate + '%</b><input type="range" min="5" max="60" value="' + S.call2mandate + '" data-slider="call2mandate"></label></div>' +
      '<p class="note" style="margin-top:12px">Per month, from ' + fmtN(cap.emails_per_day) + ' emails a day. Drag the two assumptions you know better than we do.</p>' +
      '</div>' +
      '<div><div class="card why-scale"><ul>' +
      '<li><div class="ic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg></div><div><b>' + (reg ? fmtN(reg) : '35,113') + ' Norwegian companies, live</b>From the public register, with owner birth dates and filed accounts. Finnish and Danish registers are connected; Sweden needs a data provider.</div></li>' +
      '<li><div class="ic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5"/><path d="M9 2h6"/></svg></div><div><b>' + (sc.minutes_per_prospect || 3) + ' minutes' + (sc.cost_per_prospect_usd ? ', $' + sc.cost_per_prospect_usd.toFixed(2) : '') + ' per company</b>Research, score, buyer match and a first email, ' + (sc.prospects_per_hour_at_3 ? '~' + fmtN(sc.prospects_per_hour_at_3) + ' companies an hour' : 'dozens an hour') + '. The advisor only approves.</div></li>' +
      '<li><div class="ic"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg></div><div><b>Runs on an EU-hosted model</b>Company and owner data never leave the EU. Plugs into Mergero\'s Claude → MCP → database workflow and the MGX buyer network.</div></li>' +
      '</ul></div>' +
      '<div class="card pilot"><h3>The pilot we propose</h3><p>Six weeks. Norway, one sector with strong buyer appetite. Two advisors, 75 emails a day each. We measure first calls booked against today\'s outbound, and hand over the engine if it wins.</p></div></div></div>' +
      '<div class="next-bar"><button class="btn" data-go="why">↺ Back to the start</button></div>';
  }

  /* ---------- actions ---------- */
  async function refreshCompany(id) {
    const fresh = await api('/api/engine/companies/' + encodeURIComponent(id));
    const i = S.data.companies.findIndex((c) => c.id === id);
    if (i >= 0) S.data.companies[i] = fresh;
    return fresh;
  }
  async function act(name, id) {
    if (S.busy[name]) return;
    if (name === 'send') {
      S.busy.send = true; render();
      try {
        const c = companyById(S.selected);
        const m = (c.messages || []).find((x) => x.id === id);
        if (m && m.status === 'draft') await api('/api/engine/messages/' + encodeURIComponent(id) + '/approve', 'POST');
        const r = await api('/api/engine/messages/' + encodeURIComponent(id) + '/send', 'POST');
        await refreshCompany(c.id);
        toast(r.deferred ? r.note : r.delivered ? 'Sent by email' + (S.data.settings && S.data.settings.demo_email ? ' (demo mode: to our own inbox)' : '') : 'Logged as sent');
      } catch (e) { toast(e.message, true); }
      S.busy.send = false; render();
    } else if (name === 'draft') {
      S.busy.draft = true; render();
      try { await api('/api/engine/companies/' + encodeURIComponent(id) + '/outreach', 'POST', {}); await refreshCompany(id); }
      catch (e) { toast(e.message, true); }
      S.busy.draft = false; render();
    } else if (name === 'reply') {
      const text = (document.getElementById('reply-text') || {}).value || '';
      if (!text.trim()) { toast('Pick a sample reply or paste one first.'); return; }
      S.busy.reply = { i: 0 }; render();
      const t1 = setTimeout(() => { if (S.busy.reply) { S.busy.reply.i = 1; paintReply(); } }, 7000);
      const t2 = setTimeout(() => { if (S.busy.reply) { S.busy.reply.i = 2; paintReply(); } }, 18000);
      try { await api('/api/engine/companies/' + encodeURIComponent(id) + '/replies', 'POST', { text: text.trim(), channel: 'email' }); await refreshCompany(id); }
      catch (e) { toast(e.message, true); }
      clearTimeout(t1); clearTimeout(t2);
      S.busy.reply = null; render();
      const u = lastUpdate(companyById(id));
      if (!u) toast('The reply was read, but the score update did not come back. Try again.', true);
    }
  }
  function paintReply() {
    const el = document.getElementById('reply-result');
    if (el && S.busy.reply) el.innerHTML = progressHtml(S.busy.reply);
  }

  /* ---------- events ---------- */
  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-go]');
    if (g) { go(g.dataset.go); return; }
    const o = e.target.closest('[data-open]');
    if (o) { go('talk', o.dataset.open); return; }
    const a = e.target.closest('[data-act]');
    if (a && !a.disabled) { act(a.dataset.act, a.dataset.id); return; }
    const s = e.target.closest('[data-sample]');
    if (s && !s.disabled) { const t = document.getElementById('reply-text'); if (t) { t.value = SAMPLES[+s.dataset.sample].t; t.focus(); } }
  });
  document.addEventListener('input', (e) => {
    const r = e.target.closest('[data-slider]');
    if (!r) return;
    S[r.dataset.slider] = +r.value;
    render();
    const again = document.querySelector('[data-slider="' + r.dataset.slider + '"]');
    if (again) again.focus();
  });
  document.addEventListener('keydown', (e) => {
    if (/input|textarea/i.test(e.target.tagName)) return;
    const i = STEPS.findIndex((s) => s.id === S.step);
    if (e.key === 'ArrowRight' && i < STEPS.length - 1) go(STEPS[i + 1].id);
    if (e.key === 'ArrowLeft' && i > 0) go(STEPS[i - 1].id);
  });

  /* ---------- start ---------- */
  (async function init() {
    app.innerHTML = '<div class="note" style="padding:40px 0">Loading…</div>';
    await load();
    const h = location.hash.replace(/^#/, '').split('/');
    if (h[0] && STEPS.some((s) => s.id === h[0])) { S.step = h[0]; if (h[1]) S.selected = h[1]; }
    render();
  })();
})();
