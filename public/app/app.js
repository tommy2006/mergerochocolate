// Mergero Origination — one page for advisors. Four questions, one flow:
//   Why (cover) · Owners (the working list: cards that expand) · one owner (the conversation) · Results · Add owners.
// Density rules: a card front is three lines plus the score and one button; everything longer sits behind a
// collapsible section with a count in its header; lists are capped at four with a link to the owner page.
// Everything reads the desk and engine APIs that already exist; nothing here changes server behaviour.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtM = (n) => (n == null ? "–" : `€${(Number(n) / 1e6).toFixed(1)}M`);
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
  const initials = (name) => String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  const sentences = (t) => String(t || "").replace(/\s+/g, " ").split(/(?<=[.!?])\s+(?=[A-ZÅÄÖÉ0-9])/).map((s) => s.trim()).filter(Boolean);
  const dateOf = (s) => (s ? String(s).slice(0, 10) : "");
  const cap = (items, n, moreHtml = "") => { const a = items || []; return a.slice(0, n).join("") + (a.length > n ? `<div class="note" style="margin-top:6px">${moreHtml || `+${a.length - n} more`}</div>` : ""); };
  const disc = (title, count, inner, open = false) => `<details class="disc" ${open ? "open" : ""}><summary><span>${title}</span><span class="cnt">${count}</span></summary><div class="disc-b">${inner}</div></details>`;

  const state = {
    rows: [], recs: {}, bundles: {}, details: {}, samples: null, intake: {}, expanded: null,
    filter: { band: "all", country: "", q: "" }, mode: { protected: [] }, busy: new Set(),
    reach: null, stats: null, screen: null, find: null,
  };

  async function api(path, opts = {}) {
    const r = await fetch(path, { method: opts.method || "GET", headers: { "content-type": "application/json" }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.status === "error") throw new Error(j.message || j.error || `Request failed (${r.status})`);
    return j;
  }
  function toast(msg, tone = "ok") {
    const el = document.createElement("div"); el.className = `toast${tone === "error" ? " err" : ""}`; el.textContent = msg;
    document.body.appendChild(el); setTimeout(() => el.remove(), tone === "error" ? 6000 : 3500);
  }

  // ---------- data ----------
  async function loadAll() {
    const [p, c, m] = await Promise.all([api("/api/prospects"), api("/api/engine/companies"), api("/api/demo/mode").catch(() => ({ protected: [] }))]);
    state.rows = p.data || [];
    const arr = Array.isArray(c) ? c : c.companies || c.data || [];
    state.recs = Object.fromEntries(arr.map((x) => [x.id, x]));
    state.mode = m;
    $("#live").innerHTML = `<span class="dot"></span>Live · ${state.rows.length} owners`;
  }
  async function refresh(id) {
    const p = await api("/api/prospects"); state.rows = p.data || [];
    const row = rowById(id);
    if (row?.engine_id) { const r = await api(`/api/engine/companies/${row.engine_id}`); state.recs[row.engine_id] = r.company || r; }
    delete state.bundles[id]; delete state.details[id];
  }
  const rowById = (id) => state.rows.find((r) => r.company_id === Number(id));
  const recOf = (row) => (row ? state.recs[row.engine_id] || {} : {});
  async function bundle(id) { if (!state.bundles[id]) state.bundles[id] = (await api(`/api/prospects/${id}`)).data; return state.bundles[id]; }
  async function detail(id) { if (!state.details[id]) state.details[id] = (await api(`/api/companies/${id}`)).data; return state.details[id]; }
  async function samples() { if (!state.samples) state.samples = (await api(`/api/prospects/${state.rows[0]?.company_id || 1}/sample-replies`)).data; return state.samples; }

  // ---------- derived ----------
  const num = (row) => (row.readiness ?? row.score ?? 0);
  const band = (row) => { const n = num(row); return n >= 60 ? { k: "hot", cls: "s-hot", label: "Call now" } : n >= 45 ? { k: "warm", cls: "s-warm", label: "Warm" } : { k: "later", cls: "s-cold", label: "Later" }; };
  function whyLines(row) {
    const rec = recOf(row); const s = sentences(rec.score?.why_now);
    if (s.length) return s;
    if (row.top_trigger) return [`${row.top_trigger.label}: ${row.top_trigger.evidence}.`];
    return ["Not scored yet. Expand the card and run Dig deeper."];
  }
  function ownerOf(row) {
    const rec = recOf(row); const o = rec.owner || {};
    return { name: o.name || "Owner not identified", age: o.age ?? null, source: o.age_source || (o.age != null ? "estimate" : ""), title: o.title || "" };
  }
  function money(row) {
    const rec = recOf(row); const rows = rec.research?.financials?.rows || []; const src = String(rows[0]?.source || "").replace(/\s*\(.*\)$/, "");
    const bits = [];
    if (rec.ebitda_eur != null) bits.push(`EBITDA ${fmtM(rec.ebitda_eur)}`);
    if (rec.revenue_eur != null) bits.push(`revenue ${fmtM(rec.revenue_eur)}`);
    if (rec.employees != null) bits.push(`${rec.employees} staff`);
    return { text: bits.join(" · "), source: src };
  }
  const stageClass = (row) => (/sent|replied/i.test(row.stage_label) ? "s1" : /warm|call/i.test(row.stage_label) ? "s2" : /letter|mandate/i.test(row.stage_label) ? "s3" : "");
  function filtered() {
    const f = state.filter;
    return state.rows.filter((r) => {
      if (f.band !== "all") {
        if (f.band === "contacted") { if (!/sent|replied|warm|call|letter/i.test(r.stage_label)) return false; }
        else if (f.band === "mandate") { if (!/letter|mandate/i.test(r.stage_label)) return false; }
        else if (band(r).k !== f.band) return false;
      }
      if (f.country && r.country !== f.country) return false;
      if (f.q) { const q = f.q.toLowerCase(); const o = ownerOf(r); if (!`${r.company_name} ${r.sector} ${o.name} ${r.country_name}`.toLowerCase().includes(q)) return false; }
      return true;
    }).sort((a, b) => num(b) - num(a) || (b.score || 0) - (a.score || 0));
  }

  // ---------- nav / router ----------
  const VIEWS = [["#/why", "Why"], ["#/", "Owners"], ["#/results", "Results"]];
  function route() { const h = location.hash || "#/"; const m = h.match(/^#\/owner\/(\d+)/); if (m) return { v: "owner", id: Number(m[1]) }; const v = h.replace(/^#\//, ""); return { v: v === "" || v === "owners" ? "owners" : v }; }
  function renderNav() {
    const r = route(); const cur = r.v === "owner" ? "owners" : r.v;
    $("#nav").innerHTML = VIEWS.map(([h, l]) => `<a class="step ${(h === "#/" && cur === "owners") || h === `#/${cur}` ? "on" : ""}" href="${h}"><span class="t">${l}</span></a>`).join("");
    $("#addBtn").classList.toggle("primary", r.v === "add");
  }
  async function render() {
    renderNav();
    const r = route(); const app = $("#app");
    try {
      if (r.v === "why") app.innerHTML = vWhy();
      else if (r.v === "owners") app.innerHTML = vOwners();
      else if (r.v === "owner") { app.innerHTML = `<div class="empty">Loading…</div>`; app.innerHTML = await vOwner(r.id); }
      else if (r.v === "results") { app.innerHTML = `<div class="empty">Loading…</div>`; app.innerHTML = await vResults(); }
      else if (r.v === "add") app.innerHTML = vAdd();
      else app.innerHTML = vOwners();
      if (r.v === "why") lazyCover();
      if (r.v === "owners" && state.expanded != null) fillBody(state.expanded);
      window.scrollTo({ top: 0 });
    } catch (e) { app.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }

  // ---------- 1 · why (cover) ----------
  function vWhy() {
    const hot = state.rows.filter((r) => band(r).k === "hot").length;
    const scored = state.rows.filter((r) => r.readiness != null).length;
    return `<section class="screen">
      <div class="eyebrow">Mergero · sell-side origination</div>
      <h1>Find the owners who are ready <em>before they know it</em>, and start the conversation.</h1>
      <p class="lead">Every mandate starts person by person. This desk reads the public registers and the web, spots owners likely to be open to a transaction, and writes the first email in the advisor's own voice. The advisor approves; replies come back already read and scored.</p>
      <div class="stats">
        <a class="card stat" href="#/add" style="text-decoration:none"><div class="v" id="reachV">${state.reach ? Number(state.reach).toLocaleString() : "…"}</div><div class="l">Norwegian companies in Mergero's size range, live from the public register. Click to pull more into the book.</div></a>
        <a class="card stat" href="#/" style="text-decoration:none"><div class="v">${hot} <small>of ${state.rows.length}</small></div><div class="l">owners worth a call now, each with a reason you can say out loud and the evidence behind it.</div></a>
        <a class="card stat" href="#/results" style="text-decoration:none"><div class="v" id="minV">${state.stats ? `${state.stats.scale.minutes_per_prospect} <small>min</small>` : "…"}</div><div class="l">to research a company, score it, match buyers and draft the first email${state.stats ? `, for about $${state.stats.scale.cost_per_prospect_usd}` : ""}. An analyst takes half a day.</div></a>
      </div>
      <div class="flow">
        ${[["Public register", "owner age"], ["Website & filings", "sourced facts"], ["Readiness score", "why now"], ["Buyer demand", "MGX mandates"], ["First email", "advisor's voice"], ["Owner replies", "read & re-scored"], ["First call", "the mandate path"]].map(([a, b], i, arr) => `<div class="f">${a}<span>${b}</span></div>${i < arr.length - 1 ? `<span class="arrow">→</span>` : ""}`).join("")}
      </div>
      <div class="actions"><a class="btn primary" href="#/">See who to call →</a><a class="btn" href="#/add">Add owners from the register</a><span class="note">Scored ${scored} of ${state.rows.length}; every model call stays on Verda's EU servers.</span></div>
    </section>`;
  }
  async function lazyCover() {
    if (!state.reach) api("/api/registry/reach").then((r) => { const no = (r.countries || []).find((c) => c.companies); state.reach = no?.companies || null; const el = $("#reachV"); if (el && state.reach) el.textContent = Number(state.reach).toLocaleString(); }).catch(() => {});
    if (!state.stats) api("/api/engine/stats").then((s) => { state.stats = s; const el = $("#minV"); if (el) el.innerHTML = `${s.scale.minutes_per_prospect} <small>min</small>`; }).catch(() => {});
  }

  // ---------- 2 · owners (the working list) ----------
  function vOwners() {
    const rows = filtered(); const all = state.rows;
    const counts = { hot: all.filter((r) => band(r).k === "hot").length, warm: all.filter((r) => band(r).k === "warm").length, contacted: all.filter((r) => /sent|replied|warm|call|letter/i.test(r.stage_label)).length, mandate: all.filter((r) => /letter|mandate/i.test(r.stage_label)).length };
    const countries = [...new Set(all.map((r) => r.country))].sort();
    const chip = (k, label, n) => `<span class="chip ${state.filter.band === k ? "on" : ""}" data-band="${k}">${label}${n != null ? ` · ${n}` : ""}</span>`;
    return `<section class="screen">
      <div class="page-h"><div><h2>Who to call</h2><p class="sub">Ranked by how likely the owner is to take a first conversation. The button is the one next thing to do; open a card for the evidence.</p></div></div>
      <div class="filters" id="filters">${chip("all", "All", all.length)}${chip("hot", "Call now", counts.hot)}${chip("warm", "Warm", counts.warm)}${chip("contacted", "In conversation", counts.contacted)}${chip("mandate", "Mandate", counts.mandate)}<span class="sep"></span>${countries.map((c) => `<span class="chip ${state.filter.country === c ? "on" : ""}" data-country="${c}">${c}</span>`).join("")}<input id="q" placeholder="Search" value="${esc(state.filter.q)}"></div>
      <div class="list">${rows.map(card).join("") || `<div class="card empty">No owners match. <a href="#/add">Add owners</a> from the register or by website.</div>`}</div>
    </section>`;
  }
  function card(row) {
    const b = band(row); const o = ownerOf(row); const rec = recOf(row);
    const open = state.expanded === row.company_id; const busy = state.busy.has(row.company_id);
    const why = whyLines(row)[0];
    return `<article class="card oc ${open ? "open" : ""}" id="oc-${row.company_id}">
      <div class="oc-head" data-toggle="${row.company_id}">
        <div class="oc-main">
          <div class="oc-line1"><span class="oc-name">${esc(row.company_name)}</span><span class="oc-stage ${stageClass(row)}">${esc(row.stage_label)}</span></div>
          <div class="oc-line2"><b>${esc(o.name)}</b>${o.age != null ? `, <span title="${esc(o.source)}">${o.age}</span>` : ""}${o.title ? ` · ${esc(o.title.replace(/\s*\(.*\)$/, ""))}` : ""}${rec.city ? ` · ${esc(rec.city)}` : ""}${row.country ? `, ${esc(row.country_name || row.country)}` : ""}</div>
          <p class="oc-why">${esc(why)}</p>
        </div>
        <div class="oc-side">
          <div class="score ${b.cls}" title="${row.readiness != null ? "Readiness by the model" : "Rule score; not researched yet"}"><div class="num">${num(row)}</div><div class="lab">${b.label}</div></div>
          <div class="acts">${actionButton(row, busy)}<span class="chev">▼</span></div>
        </div>
      </div>
      <div class="oc-body ${open ? "" : "hidden"}" id="ocb-${row.company_id}">${open ? `<div class="empty">Loading…</div>` : ""}</div>
    </article>`;
  }
  function actionButton(row, busy) {
    const a = row.next_action || {}; if (!a.key || row.closed) return "";
    const primary = ["plan", "send", "log_reply", "handoff", "mandate", "follow_up"].includes(a.key);
    return `<button class="btn sm ${primary ? "primary" : ""}" data-act="${row.company_id}" ${busy ? "disabled" : ""} data-stop>${busy ? `<span class="spin-inline"></span>` : ""}${esc(a.label)}</button>`;
  }
  async function fillBody(id) {
    const box = $(`#ocb-${id}`); if (!box) return;
    try {
      const [b, d] = await Promise.all([bundle(id), detail(id)]);
      box.innerHTML = body(id, b, d);
    } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  }
  function finTable(rec) {
    const rows = (rec.research?.financials?.rows || []).slice(0, 3);
    if (!rows.length) return `<div class="note">No filed accounts in the open registers yet.</div>`;
    return `<table class="tbl"><tr><th>Year</th><th class="num">Revenue</th><th class="num">EBIT</th><th class="num">EBITDA</th><th>Source</th></tr>${rows.map((r) => `<tr><td>${r.year}</td><td class="num">${fmtM(r.revenue_eur)}</td><td class="num">${fmtM(r.ebit_eur)}</td><td class="num">${fmtM(r.ebitda_eur)}${r.ebitda_basis === "derived" ? "*" : ""}</td><td><small>${esc(String(r.source || "").replace(/\s*\(NO\)|\s*\(FI\)/, ""))}${(r.also_from || []).length ? " + " + esc(r.also_from.join(", ")) : ""}</small></td></tr>`).join("")}</table>${rows.some((r) => r.ebitda_basis === "derived") ? `<div class="note">* EBIT + depreciation from the statement.</div>` : ""}`;
  }
  function buyersList(list, n = 3) {
    if (!list?.length) return `<div class="note">No buyer in the book fits yet: a new mandate to find.</div>`;
    return list.slice(0, n).map((m) => `<div class="buyer"><div class="bn"><span>${esc(m.buyer_name)}</span><span>${m.score}</span></div><div class="bar"><i style="width:${m.score}%"></i></div><p>${esc(m.summary || (m.reasons || [])[0] || "")}</p></div>`).join("");
  }
  function body(id, b, d) {
    const row = rowById(id); const rec = recOf(row);
    const facts = (rec.research?.facts || []).filter((f) => f.confidence !== "low");
    const signals = d.signals || []; const triggers = b.triggers || [];
    const seq = b.campaign?.sequence || []; const thread = b.conversation?.thread || []; const q = b.conversation?.last_qualification;
    const m = money(row); const link = state.intake[id]; const best = b.scored?.best_buyers || [];
    const points = (b.hypothesis?.agent_notes?.length ? b.hypothesis.agent_notes : whyLines(row)).slice(0, 3);
    const strip = [
      row.top_trigger ? `<span class="chip pos">${esc(row.top_trigger.label)}</span>` : "",
      best.length ? `<span class="chip">${best.length} mandates scored · best ${best[0].score}</span>` : `<span class="chip">no buyer fits yet</span>`,
      m.text ? `<span class="chip" title="${esc(m.source)}">${esc(m.text)}</span>` : "",
      rec.analysis?.ran_at ? `<span class="chip">analysed ${dateOf(rec.analysis.ran_at)}</span>` : "",
    ].filter(Boolean).join("");
    const evidence = `${triggers.length ? `<div class="rows" style="margin-bottom:12px">${cap(triggers.map((t) => `<div class="row"><b>${esc(t.label)}</b> · ${esc(t.evidence)}<small>${esc(t.source || "")}${t.date ? ` · ${dateOf(t.date)}` : ""}</small></div>`), 3)}</div>` : ""}
      ${facts.length ? `<div class="rows" style="margin-bottom:12px">${cap(facts.map((f) => `<div class="row">${esc(f.claim)} ${f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(host(f.url))}</a>` : ""}</div>`), 4, `<a href="#/owner/${id}">All ${facts.length} facts on the owner page</a>`)}</div>` : `<div class="note" style="margin-bottom:12px">No research yet. Run Dig deeper below.</div>`}
      ${finTable(rec)}`;
    const buyers = `${buyersList(best, 3)}${best.length > 3 ? `<div class="note" style="margin-top:6px"><a href="#/owner/${id}">All ${best.length} on the owner page</a></div>` : ""}`;
    const emails = seq.length
      ? `<div class="msg"><div class="m"><b>Step 1</b><span>${esc(seq[0].channel)}</span><span>${esc(seq[0].status)}</span>${seq[0].human_check ? `<span title="AI-tell score, lower is more human">human check ${seq[0].human_check.score} · ${esc(seq[0].human_check.grade)}</span>` : ""}</div><pre>${esc(seq[0].body)}</pre></div>${seq.length > 1 ? `<div class="note" style="margin-top:8px">${seq.length - 1} follow-ups on days ${seq.slice(1).map((s) => s.day).join(", ")}</div>` : ""}`
      : `<div class="note">The button on the card drafts four personal messages in the advisor's voice.</div>`;
    const convo = `${thread.length ? thread.slice(-2).map((t) => `<div class="msg" style="margin-bottom:8px"><div class="m"><b>${t.direction === "out" ? "Advisor" : "Owner"}</b><span>${dateOf(t.at)}</span></div><pre>${esc((t.text || "").slice(0, 320))}</pre></div>`).join("") : `<div class="note">No reply yet.</div>`}${q ? `<div class="chips" style="margin-top:8px"><span class="chip pos">${esc(q.label)}</span><span class="chip">${esc(q.timing)}</span><span class="chip">${q.mandate_likelihood}% potential mandate</span></div>` : ""}`;
    return `<div class="sumstrip">${strip}</div>
      <ul class="points">${points.map((p) => `<li>${esc(String(p).replace(/[.\s]+$/, ""))}.</li>`).join("")}</ul>
      <div class="discs">
        ${disc("Evidence", `${triggers.length} triggers · ${facts.length} facts · ${(rec.research?.financials?.rows || []).length} filed years`, evidence)}
        ${disc("Who would buy", best.length ? `${best.length} scored · best ${esc(best[0].buyer_name)} ${best[0].score}` : "none yet", buyers)}
        ${disc("Emails", seq.length ? `${seq.filter((s) => s.sent_at).length} of ${seq.length} sent` : "not drafted", emails)}
        ${disc("Conversation", q ? `${esc(q.label)} · ${esc(q.timing)}` : thread.length ? `${thread.length} messages` : "no reply yet", convo)}
      </div>
      <div class="actions-row">
        <a class="btn sm primary" href="#/owner/${id}">Open the conversation →</a>
        <button class="btn sm" data-dig="${id}">${rec.analysis ? "Re-analyze" : "Dig deeper"}</button>
        ${link ? `<span class="link-row">Intake link <code>${esc(link)}</code><button class="btn sm" data-copy="${esc(link)}">Copy</button></span>` : `<button class="btn sm" data-intake="${id}">Owner intake link</button>`}
        ${rec.website ? `<a class="note" href="${esc(rec.website)}" target="_blank" rel="noopener">${esc(host(rec.website))} ↗</a>` : ""}
      </div>`;
  }

  // ---------- 3 · one owner: the conversation ----------
  async function vOwner(id) {
    const row = rowById(id); if (!row) return `<div class="empty">Owner not found. <a href="#/">Back to the list</a></div>`;
    const [b, d, samp] = await Promise.all([bundle(id), detail(id), samples().catch(() => [])]);
    const rec = recOf(row); const bd = band(row); const o = ownerOf(row);
    const seq = b.campaign?.sequence || []; const first = seq[0]; const thread = b.conversation?.thread || []; const q = b.conversation?.last_qualification;
    const inbound = (rec.conversation || []).filter((e) => e.direction === "inbound"); const lastIn = inbound[inbound.length - 1]; const su = lastIn?.score_update;
    const link = state.intake[id]; const best = b.scored?.best_buyers || []; const facts = (rec.research?.facts || []).filter((f) => f.confidence !== "low");
    const done = (k) => (k === "email" ? seq.length > 0 : k === "reply" ? thread.some((t) => t.direction === "in") : k === "call" ? Boolean(b.conversation?.handoff) : false);
    const st = (k, text) => `<span class="st">${done(k) ? "✓ " : ""}${text}</span>`;
    const notes = (b.hypothesis?.agent_notes || []).slice(0, 3).map((s) => String(s).replace(/[.\s]+$/, ""));
    const ring = `<div class="ring"><svg width="92" height="92" viewBox="0 0 92 92"><circle cx="46" cy="46" r="40" stroke="#1e293b" stroke-width="8" fill="none"/><circle cx="46" cy="46" r="40" stroke="${bd.k === "hot" ? "#34d399" : bd.k === "warm" ? "#fbbf24" : "#64748b"}" stroke-width="8" fill="none" stroke-dasharray="${(2 * Math.PI * 40 * num(row)) / 100} 999" stroke-linecap="round"/></svg><div class="c"><b>${num(row)}</b><span>${bd.label}</span></div></div>`;
    const m = money(row);
    return `<section class="screen">
      <a class="back" href="#/">← Who to call</a>
      <div class="head">${ring}<div class="t"><h2>${esc(row.company_name)}</h2><div class="m">${esc(o.name)}${o.age != null ? `, ${o.age}` : ""}${o.title ? ` · ${esc(o.title.replace(/\s*\(.*\)$/, ""))}` : ""} · ${esc([rec.city, row.country_name].filter(Boolean).join(", "))}${rec.website ? ` · <a href="${esc(rec.website)}" target="_blank" rel="noopener">${esc(host(rec.website))}</a>` : ""}</div><div class="chips" style="margin-top:10px"><span class="chip stage ${stageClass(row)}">${esc(row.stage_label)}</span>${row.mandate_type ? `<span class="chip">${esc(row.mandate_type)}</span>` : ""}${m.text ? `<span class="chip" title="${esc(m.source)}">${esc(m.text)}</span>` : ""}</div></div>
        <div class="actions">${actionButton(row, state.busy.has(id))}</div></div>

      <div class="section card"><h3><span class="n">1</span>Why we call ${st("why", "")}</h3>
        <p class="why-text">${esc(notes.length ? notes.join(". ") + "." : whyLines(row).slice(0, 2).join(" "))}</p>
        <div class="discs">
          ${disc("Evidence", `${facts.length} facts · ${(d.signals || []).length} signals · ${(rec.research?.financials?.rows || []).length} filed years`, `<div class="rows" style="margin-bottom:12px">${cap((b.hypothesis?.why_now || []).map((x) => `<div class="row">${esc(x)}</div>`), 4)}</div><div class="rows" style="margin-bottom:12px">${facts.slice(0, 8).map((f) => `<div class="row">${esc(f.claim)} ${f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(host(f.url))}</a>` : ""}</div>`).join("") || `<div class="note">No research yet.</div>`}</div>${finTable(rec)}`)}
          ${disc("Who would buy", best.length ? `${best.length} scored · best ${esc(best[0].buyer_name)} ${best[0].score}` : "none yet", buyersList(best, 4) + (best.length > 4 ? `<div class="note" style="margin-top:6px">${best.length - 4} more mandates scored below the line.</div>` : ""), !q && !first)}
          ${disc("What to ask the owner", `${(b.hypothesis?.questions_for_owner || []).length} questions`, `<div class="rows">${(b.hypothesis?.questions_for_owner || []).map((x) => `<div class="row">${esc(x)}</div>`).join("")}</div>`)}
        </div></div>

      <div class="section card"><h3><span class="n">2</span>The first email ${st("email", first ? (first.sent_at ? `sent ${dateOf(first.sent_at)}` : "draft, waiting for approval") : "not drafted")}</h3>
        ${first ? `<div class="two"><div class="mail"><div class="mail-h"><span class="k">To</span><span>${esc(o.name)}</span><span class="k">Subject</span><span class="subj">${esc(first.subject)}</span></div><div class="mail-b">${esc(first.body)}</div></div>
          <div><div class="badges">${first.human_check ? `<span class="badge b-green" title="AI-tell score, lower is more human">human check ${first.human_check.score} · ${esc(first.human_check.grade)}</span><span class="badge b-sky">${first.human_check.facts_used} facts used</span>` : ""}<span class="badge b-amber">${esc(first.framing || "open")} framing</span></div>
            <div class="actions" style="margin:12px 0">${!first.sent_at ? `<button class="btn primary" data-send="${id}" data-step="0">Approve and send</button>` : `<span class="badge b-green">Sent ${dateOf(first.sent_at)}</span>`}<button class="btn" data-plan="${id}">Redraft</button></div>
            ${seq.length > 1 ? disc("Follow-ups", `${seq.length - 1} messages on days ${seq.slice(1).map((s) => s.day).join(", ")}`, seq.slice(1).map((s) => `<div class="msg" style="margin-bottom:8px"><div class="m"><b>Day ${s.day}</b><span>${esc(s.channel)}</span><span>${esc(s.status)}</span></div><div class="note" style="margin-bottom:4px">${esc(s.subject || "")}</div><pre>${esc(s.body || "")}</pre></div>`).join("")) : ""}</div></div>`
          : `<div class="actions"><button class="btn primary" data-plan="${id}">Draft the four messages</button><span class="note">About a minute: research facts, buyer demand, the advisor's voice, then the human-language check.</span></div>`}</div>

      <div class="section card"><h3><span class="n">3</span>What the owner said ${st("reply", q ? `${q.label} · ${q.timing}` : "no reply yet")}</h3>
        <div class="two">
          <div>${thread.length ? thread.slice(-2).map((t) => `<div class="msg" style="margin-bottom:8px"><div class="m"><b>${t.direction === "out" ? "Advisor" : "Owner"}</b><span>${dateOf(t.at)}</span></div><pre>${esc((t.text || "").slice(0, 600))}</pre></div>`).join("") : `<p class="note">${first?.sent_at ? "Waiting for the owner." : "Send the first email, then paste the reply here."}</p>`}
            <textarea id="replyText" placeholder="Paste the owner's reply…"></textarea>
            <div class="actions" style="margin-top:10px"><button class="btn primary" data-reply="${id}">Read this reply</button></div>
            ${(samp || []).length ? disc("Simulate a reply", `${samp.length} samples`, `<div class="samples">${samp.slice(0, 4).map((s) => `<button class="sample" data-sample="${esc(s.text)}"><b>${esc(s.label)}</b>${esc(s.text)}</button>`).join("")}</div>`) : ""}</div>
          <div class="result ${q ? "" : "empty"}">${q ? `<div class="chips"><span class="chip pos">${esc(q.label)}</span><span class="chip">${esc(q.timing)}</span><span class="chip">${q.mandate_likelihood}% potential mandate</span></div><p class="note">${esc(q.next_step || q.reason || "")}</p>${su ? `<div class="move"><span class="from">${su.from?.readiness ?? "–"}</span><span class="big">${su.to?.readiness ?? "–"}</span>${su.delta != null ? `<span class="d ${su.delta >= 0 ? "up" : "down"}">${su.delta >= 0 ? "+" : ""}${su.delta}</span>` : ""}<span class="note">readiness</span></div><ul class="quotes">${(su.evidence || []).slice(0, 4).map((e) => `<li class="${/rais/i.test(e.effect || "") ? "pos" : /low/i.test(e.effect || "") ? "neg" : ""}"><q>${esc(e.quote)}</q> ${esc(e.effect || "")}</li>`).join("")}</ul>${su.reason ? disc("Why the score moved", "", `<p class="note" style="margin:0">${esc(su.reason)}</p>`) : ""}` : ""}` : "The reply is read, the intent and timing extracted, and the readiness score moves with the owner's own words as evidence."}</div>
        </div></div>

      <div class="section card"><h3><span class="n">4</span>Next ${st("call", b.conversation?.handoff ? `first call booked with ${esc(b.conversation.handoff.advisor || "an advisor")}` : "")}</h3>
        <div class="actions">
          ${link ? `<span class="link-row">Owner intake link <code>${esc(link)}</code><button class="btn sm" data-copy="${esc(link)}">Copy</button></span>` : `<button class="btn" data-intake="${id}">Create the owner's private intake link</button>`}
          ${!b.conversation?.handoff && !row.closed ? `<button class="btn" data-handoff="${id}">Book the first call</button>` : ""}
          ${b.conversation?.handoff && !/letter|mandate/i.test(row.stage_label) ? `<button class="btn primary" data-mandate="${id}">Engagement letter signed</button>` : ""}
          ${/letter|mandate/i.test(row.stage_label) ? `<span class="badge b-green">Mandate won</span>` : ""}
        </div>
        <p class="note" style="margin:12px 0 0">Six questions on the owner's phone (revenue split, top clients, EBITDA, timing); the summary lands here before the call.</p></div>
    </section>`;
  }

  // ---------- 4 · results ----------
  async function vResults() {
    const [ps, st, cap_, learn, src, llm] = await Promise.all([api("/api/pipeline-summary"), api("/api/engine/stats"), api("/api/engine/advisors/capacity").catch(() => null), api("/api/engine/learning").catch(() => null), api("/api/sources").catch(() => ({ data: [] })), api("/api/llm/status").catch(() => null)]);
    const f = ps.data; const max = Math.max(1, f.data.companies);
    const frow = (label, small, v, final = false) => `<div class="frow ${final ? "final" : ""}"><div class="fl">${label}<small>${small}</small></div><div class="fb"><i style="width:${Math.max(2, (100 * v) / max)}%"></i></div><div class="fv">${v}</div></div>`;
    const pct = (x) => `${Math.round((x || 0) * 100)}%`;
    const sources = (src.data || []);
    return `<section class="screen">
      <div class="page-h"><div><h2>At scale</h2><p class="sub">What the desk does with the book, measured, next to Mergero's own benchmark.</p></div></div>
      <div class="scale">
        <div class="card funnel">
          ${frow("Companies", "in the book", f.data.companies)}${frow("With a trigger", "succession, growth, ownership", f.signals.with_triggers)}${frow("Sequences drafted", "four personal messages each", f.outreach.sequences)}${frow("First emails sent", "approved by the advisor", f.outreach.sent)}${frow("Qualified replies", `${f.qualification.potential_mandates} potential mandates`, f.qualification.qualified)}${frow("Mandates", "engagement letters", f.handoff.mandates, true)}
          <div class="sliders"><label><b>${cap_ ? cap_.emails_per_day : "150"}</b> first touches a day<br>${cap_ ? cap_.advisors.map((a) => `${esc(a.name)} · cap ${a.daily_cap}/day`).join("<br>") : ""}</label><label><b>${cap_ ? cap_.conversations_per_month : "~475"}</b> owner conversations a month<br>${esc(cap_?.benchmark || "Mergero: 1,000 outbound contacts → ~450–500 owner conversations")}</label></div>
        </div>
        <div>
          <div class="card why-scale"><ul>
            <li><span class="ic">⏱</span><div><b>${st.scale.minutes_per_prospect} min and $${st.scale.cost_per_prospect_usd} per prospect</b>${st.hours_saved} analyst hours saved on ${st.scale.prospects_measured} measured prospects.</div></li>
            <li><span class="ic">📈</span><div><b>Reply ${learn ? pct(learn.overall.reply_rate) : "–"} · meeting ${learn ? pct(learn.overall.meeting_rate) : "–"} · mandate ${learn ? pct(learn.overall.mandate_rate) : "–"}</b>${learn?.sample_included ? "Sample history until real outcomes accumulate. " : ""}By framing: ${learn ? learn.by_framing.map((x) => `${x.key} ${pct(x.reply_rate)}`).join(" · ") : "–"}.</div></li>
            <li><span class="ic">🇪🇺</span><div><b>${llm?.provider === "verda" ? `${esc(llm.verda?.model || "Mistral")} on Verda, EU${llm.fallback === false ? " · no call leaves Verda" : ""}` : "Claude (Anthropic)"}</b>Owner data, statements and drafts stay on EU compute; scanned register statements are read by OCR on the server.</div></li>
          </ul>
          <div style="margin-top:14px">${disc("Data sources", `${sources.filter((s) => /live|loaded|configured|demo/.test(String(s.status))).length} of ${sources.length} live`, `<div class="rows">${sources.map((s) => `<div class="row">${esc(s.name.replace(/^Language model: /, ""))}<small>${esc(String(s.status))}</small></div>`).join("")}</div>`)}</div></div>
          <div class="card pilot"><h3>Pilot on Monday</h3><p>MGX mandates over API, one advisor, Norway first: 50 first touches a day for two weeks; report replies, first calls and engagement letters against the 1,000 → 475 benchmark.</p></div>
        </div>
      </div>
    </section>`;
  }

  // ---------- 5 · add owners ----------
  function vAdd() {
    const f = state.find; const s = state.screen;
    return `<section class="screen">
      <div class="page-h"><div><h2>Add owners</h2><p class="sub">Two ways in. Both end as cards on the Owners list.</p></div></div>
      <div class="two">
        <div class="section card"><h3><span class="n">A</span>From the open registers</h3>
          <div class="form"><select id="fCountry"><option value="NO">Norway · Brønnøysund</option><option value="FI">Finland · PRH</option><option value="DK">Denmark · CVR (name)</option></select><input id="fIndustry" placeholder="Industry code, e.g. 28"><input id="fFounded" type="number" placeholder="Founded before"><input id="fStaff" type="number" placeholder="Min staff (NO)"><button class="btn primary sm" id="fGo">Search</button></div>
          <div class="try">Try: <button data-try="NO,28,2005,20">Norway · machinery before 2005, 20+ staff</button><button data-try="NO,25,2000,15">Norway · metal products, 15+ staff</button><button data-try="FI,62010,2010,">Finland · software before 2010</button></div>
          <div id="findOut" style="margin-top:14px">${f ? findHtml(f) : `<p class="note">Norway adds the CEO's real age from the roles register; Finland and Denmark add founding year and filed accounts.</p>`}</div></div>
        <div class="section card"><h3><span class="n">B</span>Screen a website</h3>
          <div class="form-1"><input id="sUrl" placeholder="https://www.company.com"><button class="btn primary sm" id="sGo">Screen</button></div>
          <div class="try">Try: <button data-url="https://www.aerfaber.no">aerfaber.no</button><button data-url="https://www.kolmeks.fi">kolmeks.fi</button><button data-url="https://www.efecte.com">efecte.com</button></div>
          <div id="screenOut" style="margin-top:14px">${s ? screenHtml(s) : `<p class="note">The quick read guesses the sector and scores every mandate in seconds. Dig deeper reads the site, the filed accounts and the customers, and puts the company on the list.</p>`}</div></div>
      </div>
    </section>`;
  }
  function findHtml(f) {
    if (f.error) return `<div class="note" style="color:var(--red)">${esc(f.error)}</div>`;
    const fresh = f.results.filter((r) => !r.already_imported);
    if (!f.results.length) return `<div class="note">Nothing found. Try a broader industry code.</div>`;
    const shown = f.showAll ? f.results : f.results.slice(0, 10);
    return `<div class="actions" style="margin-bottom:8px"><span><b>${f.results.length}</b> found${f.total > f.results.length ? ` of <b>${Number(f.total).toLocaleString()}</b> in the register` : ""} · ${fresh.length} new</span><button class="btn primary sm" id="fAdd" ${fresh.length ? "" : "disabled"}>Add ${fresh.length} to the list</button></div>
      <table class="tbl"><tr><th>Company</th><th>City</th><th>Founded</th><th class="num">Staff</th><th></th></tr>${shown.map((r) => `<tr><td>${esc(r.name)}<small style="display:block;color:var(--dim)">${esc(String(r.industry || "").slice(0, 44))}</small></td><td>${esc(r.city || "")}</td><td>${r.founded || esc(r.founded_note || "–")}</td><td class="num">${r.employees ?? "–"}</td><td>${r.already_imported ? `<span class="chip pos">in the book</span>` : ""}</td></tr>`).join("")}</table>${f.results.length > shown.length ? `<div class="note" style="margin-top:8px"><button class="btn sm" id="fMore">Show all ${f.results.length}</button></div>` : ""}`;
  }
  function screenHtml(s) {
    if (s.error) return `<div class="note" style="color:var(--red)">${esc(s.error)}</div>`;
    if (s.busy) return `<div class="note"><span class="spin-inline"></span>${esc(s.busy)}</div>`;
    const p = s.profile; const top = (s.matches || []).slice(0, 3);
    return `<div class="card" style="padding:16px"><div class="oc-name">${esc(p.company_name)} <span class="chip">${esc(p.sector)}</span></div>
      <div class="q-card"><div><b>${esc(p.ebitda)}</b><span>EBITDA</span></div><div><b style="font-size:13px">${esc(String(p.customers).slice(0, 60))}</b><span>customers</span></div><div><b style="font-size:13px">${esc(String(p.products).slice(0, 60))}</b><span>offering</span></div></div>
      ${disc("Who would buy", top.length ? `best ${esc(top[0].buyer_name)} ${top[0].score}` : "none", buyersList(top.map((m) => ({ buyer_name: m.buyer_name, score: m.score, summary: m.summary })), 3))}
      <div class="actions" style="margin-top:12px"><button class="btn primary sm" id="sDig">${p.analysis ? "Re-analyze" : "Dig deeper and add to the list"}</button>${p.company_id ? `<a class="btn sm" href="#/owner/${p.company_id}">Open on the list</a>` : `<button class="btn sm" id="sAdd">Add as is</button>`}<span class="note">${p.analysis ? `Analysed: ${p.analysis.pages_read} pages, ${p.analysis.facts} facts` : "Dig deeper takes about a minute."}</span></div></div>`;
  }

  // ---------- actions ----------
  async function withBusy(id, fn, okMsg) {
    state.busy.add(id); const btn = $(`[data-act="${id}"]`); if (btn) { btn.disabled = true; btn.innerHTML = `<span class="spin-inline"></span>${btn.textContent}`; }
    try { const out = await fn(); await refresh(id); state.busy.delete(id); await render(); if (okMsg) toast(typeof okMsg === "function" ? okMsg(out) : okMsg); }
    catch (e) { state.busy.delete(id); await render(); toast(e.message, "error"); }
  }
  const plan = (id) => withBusy(id, () => api(`/api/prospects/${id}/outreach`, { method: "POST" }), "Four messages drafted in the advisor's voice");
  const send = (id, step) => withBusy(id, () => api(`/api/prospects/${id}/outreach/${step}/send`, { method: "POST" }), "First email sent (demo mode delivers it to your inbox)");
  const handoff = (id) => withBusy(id, () => api(`/api/prospects/${id}/handoff`, { method: "POST", body: { advisor: "Mergero advisor" } }), "First call booked; the advisor got the briefing");
  const mandate = (id) => withBusy(id, () => api(`/api/prospects/${id}/mandate`, { method: "POST" }), "Engagement letter logged: mandate won");
  const reply = (id, text) => withBusy(id, () => api(`/api/prospects/${id}/replies`, { method: "POST", body: { text } }), "Reply read and scored");
  const dig = (id) => withBusy(id, () => api("/api/analyze", { method: "POST", body: { company_id: id } }), (r) => r.summary || "Analysis done");
  async function intake(id) {
    const row = rowById(id); try { const r = await api(`/api/companies/${row.engine_id}/intake-link`, { method: "POST" }); state.intake[id] = `${location.origin}/intake/${r.token}`; await render(); if (route().v === "owners") fillBody(id); toast("Owner intake link ready"); } catch (e) { toast(e.message, "error"); }
  }
  function act(id) {
    const row = rowById(id); const a = row?.next_action || {};
    if (a.key === "plan" || a.key === "follow_up") return plan(id);
    if (a.key === "send") return send(id, a.message_step ?? 0);
    if (a.key === "handoff") return handoff(id);
    if (a.key === "mandate") return mandate(id);
    if (a.key === "log_reply") { location.hash = `#/owner/${id}`; setTimeout(() => $("#replyText")?.focus(), 400); return; }
    location.hash = `#/owner/${id}`;
  }
  async function toggle(id) {
    state.expanded = state.expanded === id ? null : id;
    await render();
    if (state.expanded != null) { const el = $(`#oc-${state.expanded}`); el?.scrollIntoView({ behavior: "smooth", block: "start" }); }
  }
  async function findCompanies(country, industry, founded, staff) {
    state.find = { results: [], total: 0 }; $("#findOut").innerHTML = `<div class="note"><span class="spin-inline"></span>Asking the register…</div>`;
    try {
      const p = new URLSearchParams({ country }); if (country === "DK") { if (industry) p.set("q", industry); } else { if (industry) p.set("industry_code", industry); if (founded) p.set("founded_before", founded); if (staff) p.set("employees_min", staff); }
      const r = await api(`/api/registry/search?${p}`); state.find = { results: r.results || [], total: r.total ?? (r.results || []).length };
    } catch (e) { state.find = { results: [], total: 0, error: e.message }; }
    $("#findOut").innerHTML = findHtml(state.find);
  }
  async function importFound() {
    const fresh = (state.find?.results || []).filter((x) => !x.already_imported); if (!fresh.length) return;
    try { const r = await api("/api/companies/bulk", { method: "POST", body: { companies: fresh } }); toast(`${r.imported} companies added${r.people_looked_up ? `, ${r.people_looked_up} with the CEO's age from the roles register` : ""}`); state.find.results = state.find.results.map((x) => ({ ...x, already_imported: true })); await loadAll(); $("#findOut").innerHTML = findHtml(state.find); }
    catch (e) { toast(e.message, "error"); }
  }
  async function screen(url) {
    state.screen = { busy: `Reading ${url}…` }; $("#screenOut").innerHTML = screenHtml(state.screen);
    try { const r = await api("/api/match", { method: "POST", body: { url } }); state.screen = { profile: r.profile, matches: r.matches }; }
    catch (e) { state.screen = { error: e.message }; }
    $("#screenOut").innerHTML = screenHtml(state.screen);
  }
  async function screenDig() {
    const p = state.screen?.profile; if (!p) return;
    state.screen = { busy: "Reading up to 10 pages, the filed accounts and the customers. About a minute." }; $("#screenOut").innerHTML = screenHtml(state.screen);
    try { const r = await api("/api/analyze", { method: "POST", body: { profile: p } }); state.screen = { profile: r.profile, matches: r.matches }; await loadAll(); toast(r.summary || "Analysis done"); }
    catch (e) { state.screen = { profile: p, error: e.message }; toast(e.message, "error"); }
    $("#screenOut").innerHTML = screenHtml(state.screen);
  }
  async function screenAdd() {
    const p = state.screen?.profile; if (!p) return;
    try { const r = await api("/api/targets", { method: "POST", body: { profile: p } }); await loadAll(); toast(`${r.data?.company || p.company_name} is on the list`); location.hash = "#/"; }
    catch (e) { toast(e.message, "error"); }
  }

  // ---------- events ----------
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-toggle],[data-act],[data-dig],[data-intake],[data-copy],[data-send],[data-plan],[data-reply],[data-handoff],[data-mandate],[data-sample],[data-band],[data-country],[data-try],[data-url],#fGo,#fAdd,#fMore,#sGo,#sDig,#sAdd,[data-stop]");
    if (!t) return;
    if (t.matches("[data-stop]")) { e.stopPropagation(); return; }
    e.preventDefault();
    if (t.dataset.toggle) return toggle(Number(t.dataset.toggle));
    if (t.dataset.act) return act(Number(t.dataset.act));
    if (t.dataset.dig) return dig(Number(t.dataset.dig));
    if (t.dataset.intake) return intake(Number(t.dataset.intake));
    if (t.dataset.copy) { (navigator.clipboard ? navigator.clipboard.writeText(t.dataset.copy) : Promise.reject()).then(() => toast("Copied")).catch(() => toast(t.dataset.copy)); return; }
    if (t.dataset.send) return send(Number(t.dataset.send), Number(t.dataset.step || 0));
    if (t.dataset.plan) return plan(Number(t.dataset.plan));
    if (t.dataset.handoff) return handoff(Number(t.dataset.handoff));
    if (t.dataset.mandate) return mandate(Number(t.dataset.mandate));
    if (t.dataset.sample) { const box = $("#replyText"); if (box) box.value = t.dataset.sample; return; }
    if (t.dataset.reply) { const text = ($("#replyText")?.value || "").trim(); if (!text) return toast("Paste the owner's reply first, or pick a sample"); return reply(Number(t.dataset.reply), text); }
    if (t.dataset.band) { state.filter.band = t.dataset.band; return render(); }
    if (t.dataset.country) { state.filter.country = state.filter.country === t.dataset.country ? "" : t.dataset.country; return render(); }
    if (t.dataset.try) { const [c, i, f, s] = t.dataset.try.split(","); $("#fCountry").value = c; $("#fIndustry").value = i; $("#fFounded").value = f; $("#fStaff").value = s; return findCompanies(c, i, f, s); }
    if (t.dataset.url) { $("#sUrl").value = t.dataset.url; return screen(t.dataset.url); }
    if (t.id === "fGo") return findCompanies($("#fCountry").value, $("#fIndustry").value.trim(), $("#fFounded").value.trim(), $("#fStaff").value.trim());
    if (t.id === "fAdd") return importFound();
    if (t.id === "fMore") { state.find.showAll = true; $("#findOut").innerHTML = findHtml(state.find); return; }
    if (t.id === "sGo") { const u = $("#sUrl").value.trim(); return u ? screen(u) : toast("Paste a website first"); }
    if (t.id === "sDig") return screenDig();
    if (t.id === "sAdd") return screenAdd();
  });
  document.addEventListener("input", (e) => { if (e.target.id === "q") { state.filter.q = e.target.value; const list = $(".list"); if (list) list.innerHTML = filtered().map(card).join("") || `<div class="card empty">No owners match.</div>`; } });
  document.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.id === "sUrl") $("#sGo").click(); if (e.key === "Enter" && /^f(Industry|Founded|Staff)$/.test(e.target.id)) $("#fGo").click(); });
  window.addEventListener("hashchange", render);

  // ---------- boot ----------
  (async () => {
    try { await loadAll(); if (state.expanded == null && route().v === "owners") state.expanded = filtered()[0]?.company_id ?? null; await render(); }
    catch (e) { $("#app").innerHTML = `<div class="empty">Could not reach the engine: ${esc(e.message)}</div>`; }
  })();
})();
