"use strict";

/* The company workspace: one page per company that follows the workflow
   Research -> Analysis -> Buyers -> Outreach. This file has the workspace frame and the
   first two steps; deal.js has Buyers and Outreach. */

const STEPS = [
  { id: "research", label: "Research" },
  { id: "analysis", label: "Analysis" },
  { id: "buyers", label: "Buyers" },
  { id: "outreach", label: "Outreach" },
];
const KIND_TAB = { analysis: "analysis", brief: "buyers", find: "buyers", "add-buyer": "buyers", emails: "outreach", followup: "outreach", batch: "buyers" };

function defaultTab(p, c) {
  if (c && Object.keys(c.emails || {}).length) return "outreach";
  if (c && (c.buyers.length || c.brief)) return "buyers";
  if (p.ai_analysis) return "analysis";
  return "research";
}

async function showCompany(bid, tab, from) {
  const fresh = state.bid !== bid || !state.profile;
  const tabChanged = state.tab !== tab;
  state.bid = bid;
  state.from = from;
  if (fresh) {
    state.profile = null;
    Object.assign(cmp, { bid, data: null, seller: null, jobs: {} });
    mount($("#main"), html`<section class="card"><p class="muted">Loading…</p></section>`);
    try {
      const [p, c] = await Promise.all([api(`/api/companies/${bid}`), api(`/api/campaigns/${bid}`)]);
      if (state.bid !== bid) return;
      state.profile = p;
      cmp.data = c.campaign;
      cmp.seller = c.seller;
    } catch (e) {
      if (state.bid !== bid) return;
      mount($("#main"), html`${notice("info", `${bid} isn't saved yet`, "Add it to look it up in the trade register.")}
        <div><button type="button" class="btn primary" data-action="add-company" data-query="${bid}">Add ${bid}</button></div>`);
      return;
    }
  }
  state.tab = tab || defaultTab(state.profile, cmp.data);
  document.title = `${state.profile.registry.name} – Company Scraper`;
  renderWorkspace();
  if (fresh) window.scrollTo({ top: 0 });
  else if (tabChanged) scrollToSteps();
  resumeJobs(bid);
  if (fresh) maybeAutoAnalyze(bid);
}

function scrollToSteps() {
  const steps = document.getElementById("ws-steps");
  if (steps && window.scrollY > steps.offsetTop - 64) window.scrollTo({ top: steps.offsetTop - 64 });
}

// Jobs started elsewhere (the pipeline, another visit, before a reload) keep showing progress here.
function resumeJobs(bid) {
  for (const j of jobsFor(bid)) {
    if (j.kind === "analysis" && !(state.analysis[bid] && state.analysis[bid].jobId === j.id)) {
      const slot = (state.analysis[bid] = { jobId: j.id, timer: null, status: "running", elapsed: j.elapsed });
      poll(slot, j.id, (x) => onAnalysisUpdate(bid, x));
      refreshAIParts();
    }
    const key = { brief: "brief", find: "find", "add-buyer": "add", emails: "emails", followup: "followup", batch: "research" }[j.kind];
    if (key && !(cmp.jobs[key] && cmp.jobs[key].jobId === j.id)) followCampaignJob(key, j);
  }
}

function maybeAutoAnalyze(bid) {
  if (!state.autoAnalyze.has(bid)) return;
  state.autoAnalyze.delete(bid);
  const a = state.profile.ai_analysis;
  const running = (state.analysis[bid] || {}).status === "running" || jobsFor(bid).some((j) => j.kind === "analysis");
  if (state.ai.configured && !running && (!a || a.based_on !== state.profile.scraped_at)) startAnalysis(bid);
}

// ---------- frame: header, workflow steps, next step ----------

const tabHref = (id) => `#/c/${state.bid}/${id}${state.from ? `?from=${state.from}` : ""}`;

function renderWorkspace() {
  const from = state.from && companyRow(state.from);
  mount($("#main"), html`
    <a class="backlink" href="${from ? `#/c/${from.business_id}/buyers` : "#/"}">← ${from ? `Buyers for ${from.name}` : "All companies"}</a>
    <header class="card ws-head" id="ws-head">${renderWsHead()}</header>
    <nav id="ws-steps" class="stepper-wrap" aria-label="Workflow">${renderStepper()}</nav>
    <div id="ws-body" class="ws-body">${renderTab()}</div>`);
}

function refreshWorkspace() {
  if (state.route.view !== "company" || !state.profile) return;
  setHtml("ws-head", renderWsHead());
  setHtml("ws-steps", renderStepper());
  setHtml("ws-body", renderTab());
}
const refreshSteps = () => {
  if (state.route.view !== "company" || !state.profile) return;
  setHtml("ws-steps", renderStepper());
  setHtml("ws-next", renderNext());
};

function renderWsHead() {
  const p = state.profile;
  const r = p.registry;
  const row = companyRow(r.business_id) || {};
  const f = p.financials && p.financials.available ? p.financials : null;
  const year = f ? Object.keys(f.years).sort().reverse()[0] : null;
  const cur = year ? f.years[year] : {};
  const badges = [
    r.active ? badge("good", "✓ Active") : badge("bad", "✕ Not active"),
    ...(r.situations || []).filter((s) => !s.until).map((s) => badge("bad", `! ${s.type} since ${fmtDate(s.since)}`)),
    r.in_employer_register ? badge("", "Employer") : "",
    r.vat_registered ? badge("", "VAT registered") : "",
  ];
  const figure = (label, value, note) => html`<div class="fig"><span class="fig-label">${label}</span><span class="fig-value">${value}</span>${note ? html`<span class="fig-note">${note}</span>` : ""}</div>`;
  const givenSite = p.website && p.website.url_source === "given" ? p.website.url : "";
  return html`
    <div class="ws-title">
      <h1>${r.name}</h1>
      <div class="profile-sub">
        <button type="button" class="copy" data-copy="${r.business_id}" title="Copy Business ID">${r.business_id} ${ICON.copy}</button>
        ${r.municipality ? html`<span>${titleCase(r.municipality)}</span>` : ""}
        ${r.industry ? html`<span>${r.industry}</span>` : ""}
      </div>
      <div class="badges">${badges}</div>
      ${(row.buyer_for || []).length ? html`<p class="buyer-for">Potential buyer for ${row.buyer_for.map((s, i) => html`${i ? ", " : ""}<a href="#/c/${s.seller}/buyers">${s.name}</a> <span class="muted">(fit ${s.fit})</span>`)}</p>` : ""}
    </div>
    <div class="ws-figs">
      ${figure("Revenue", eurCompact(cur.revenue), cur.revenue_growth_pct != null ? signed(cur.revenue_growth_pct) : year ? "" : "no digital accounts")}
      ${figure("Net profit", eurCompact(cur.net_profit), year ? year.slice(0, 4) : "")}
      ${figure("Equity ratio", pct(cur.equity_ratio_pct), "")}
      ${figure("Age", r.company_age_years != null ? `${Math.floor(r.company_age_years)} years` : "–", r.registered_on ? `since ${r.registered_on.slice(0, 4)}` : "")}
    </div>
    <div class="ws-actions">
      <button type="button" class="btn small" data-action="refresh" data-query="${r.business_id}" data-website="${givenSite}" title="Fetch the latest data again">Refresh data</button>
      <a class="btn small" href="/api/export?format=xlsx&ids=${r.business_id}" title="Excel with a sheet of evidence for every fact">Excel</a>
      <a class="btn small" href="/api/companies/${r.business_id}?download=1">JSON</a>
    </div>`;
}

function stepStates() {
  const p = state.profile;
  const c = cmp.data || { buyers: [], emails: {} };
  const a = p.ai_analysis;
  const aRunning = (state.analysis[state.bid] || {}).status === "running";
  const running = (k) => cmp.jobs[k] && cmp.jobs[k].status === "running";
  const emails = Object.values(c.emails || {});
  const sent = emails.filter((e) => e.status !== "draft").length;
  const interested = emails.filter((e) => e.status === "interested").length;
  const selected = c.buyers.filter((b) => b.selected).length;
  const x = a && a.analysis ? a.analysis : {};
  return {
    research: { done: true, text: `Fetched ${fmtDate(p.scraped_at)}` },
    analysis: aRunning ? { busy: true, text: "Claude is writing…" }
      : a ? { done: true, text: `${cap((x.financial_health || {}).rating || "unknown")} · sale signals ${(x.sale_signals || {}).rating || "unknown"}${a.based_on !== p.scraped_at ? " · outdated" : ""}` }
      : { text: "Not started" },
    buyers: running("brief") ? { busy: true, text: "Writing the seller story…" }
      : running("find") ? { busy: true, text: "Searching for buyers…" }
      : c.buyers.length ? { done: true, text: `${c.buyers.length} found · ${selected} selected` }
      : c.brief ? { half: true, text: "Seller story ready" } : { text: "Not started" },
    outreach: running("emails") || running("followup") ? { busy: true, text: "Writing emails…" }
      : emails.length ? { done: sent === emails.length, half: sent < emails.length,
        text: interested ? `${interested} interested · ${sent} of ${emails.length} sent` : `${sent} of ${plural(emails.length, "email", "emails")} sent` }
      : { text: selected ? `${selected} buyers to contact` : "Not started" },
  };
}

function renderStepper() {
  const st = stepStates();
  return html`<ol class="stepper">${STEPS.map((s, i) => {
    const x = st[s.id];
    const cls = [s.id === state.tab ? "current" : "", x.done ? "done" : "", x.half ? "half" : "", x.busy ? "busy" : ""].join(" ");
    return html`<li class="${cls}"><a href="${tabHref(s.id)}" ${s.id === state.tab ? html`aria-current="step"` : ""}>
      <span class="step-dot">${x.busy ? ICON.spinner : x.done ? "✓" : i + 1}</span>
      <span class="step-text"><span class="step-name">${s.label}</span><span class="step-state">${x.text}</span></span>
    </a></li>`;
  })}</ol>`;
}

function renderTab() {
  const body = { analysis: () => renderAICard(state.profile), buyers: renderBuyersTab, outreach: renderOutreachTab }[state.tab];
  return html`${body ? body() : renderResearch(state.profile)}<div id="ws-next">${renderNext()}</div>`;
}

// The way forward from each step.
function renderNext() {
  const p = state.profile;
  const c = cmp.data || { buyers: [], emails: {} };
  const selected = c.buyers.filter((b) => b.selected).length;
  const emails = Object.values(c.emails || {});
  const sent = emails.filter((e) => e.status !== "draft").length;
  const next = (title, text, action) => html`<section class="next-step">
    <div><div class="eyebrow">Next step</div><strong>${title}</strong><p class="muted">${text}</p></div>${action}</section>`;
  const go = (tab, label) => html`<a class="btn primary" href="${tabHref(tab)}">${label} →</a>`;
  switch (state.tab) {
    case "research":
      return p.ai_analysis ? next("See Claude's analysis", "A short summary, financial health and sale signals, each with its sources.", go("analysis", "Open the analysis"))
        : state.ai.configured ? next("Get Claude's analysis", "Claude reads the facts above and writes a short summary, a financial health rating and the sale signals.",
          html`<button type="button" class="btn primary" data-action="analyze" data-bid="${state.bid}" data-detail="brief" data-goto="analysis">Analyze with Claude →</button>`)
          : next("Find buyers", "Look for companies that could buy this one.", go("buyers", "Find buyers"));
    case "analysis":
      return next(c.buyers.length ? "Review the buyers" : "Find buyers for this company",
        c.buyers.length ? `${plural(c.buyers.length, "potential buyer", "potential buyers")} found, ${selected} selected for emails.`
          : "Claude writes the seller story, then the app searches the trade register for companies that could buy it.",
        go("buyers", c.buyers.length ? "Open the buyers" : "Find buyers"));
    case "buyers":
      return selected ? next(`Write to ${plural(selected, "buyer", "buyers")}`, "Claude drafts a personal first email to each selected buyer, for you to review and send.", go("outreach", "Write the emails"))
        : next("Choose who to contact", c.buyers.length ? "Tick the buyers you want to email." : "Find buyers first.", html`<span></span>`);
    default: {
      const interested = emails.filter((e) => e.status === "interested").length;
      const due = emails.filter(followUpDue).length;
      if (interested) return next(`${plural(interested, "buyer is", "buyers are")} interested`, "Send your NDA; once it's signed, share the company's name and full profile and set up a call.", html`<a class="btn" href="#/">All companies</a>`);
      if (due) return next(`Follow up with ${plural(due, "buyer", "buyers")}`, "A week has passed without an answer. Claude can write a short follow-up to each; use the button above.", html`<span></span>`);
      return emails.length && sent === emails.length
        ? next("Waiting for answers", "Every email is sent. Record each answer with its status; after a week without one, a follow-up is suggested.", html`<a class="btn primary" href="#/">All companies →</a>`)
        : next("Send and track", emails.length ? `${sent} of ${emails.length} sent. Set each email's status to keep track.` : "Write the emails, review them, then send them from your own email.", html`<a class="btn" href="#/">All companies</a>`);
    }
  }
}

// ---------- step 1: research ----------

function renderResearch(p) {
  const r = p.registry;
  const givenSite = p.website && p.website.url_source === "given" ? p.website.url : "";
  const sources = [
    extLink(r.register_page || r.source, "PRH trade register"),
    p.financials && p.financials.source ? extLink(p.financials.source, "financial statement") : "",
    p.website && p.website.available ? extLink(p.website.url, "company website") : "",
  ].filter(Boolean);
  const old = (p.financials && p.financials.available && !p.financials.evidence)
    || (p.website && p.website.available && !p.website.evidence);
  const a = p.ai_analysis && p.ai_analysis.analysis;
  return html`<article class="profile ${state.showEvidence ? "" : "hide-evidence"}">
    <div class="tab-bar">
      <p class="tab-intro">Public facts from the PRH trade register, filed financial statements and the company's own website.</p>
      <label class="btn small ev-toggle" title="Show where each fact comes from"><input type="checkbox" data-action="toggle-evidence" ${state.showEvidence ? "checked" : ""}> Show evidence</label>
    </div>
    ${old ? html`<div class="ev ev-banner ev-old"><span class="ev-label">Evidence</span><div>This profile was saved before the app recorded evidence, so quotes and filed facts are missing.
      <button type="button" class="chip-btn" data-action="refresh" data-query="${r.business_id}" data-website="${givenSite}">Refresh to add them</button></div></div>` : ""}
    ${a ? html`<a class="take card" href="${tabHref("analysis")}"><span class="ai-mark" aria-hidden="true">✦</span>
      <span><span class="eyebrow">Claude's take</span><span class="take-text">${noCitations(a.headline)}</span></span><span class="take-go">Analysis →</span></a>` : ""}
    ${renderFacts(r, p)}
    ${p.financials ? renderFinancials(p.financials, p) : ""}
    ${p.website ? renderWebsite(p.website, p) : ""}
    ${p.other_matches && p.other_matches.length ? renderOthers(p) : ""}
    <p class="provenance">Fetched ${fmtDateTime(p.scraped_at)} for “${p.query}”. Sources: ${sources.map((s, i) => html`${i ? " · " : ""}${s}`)}.</p>
  </article>`;
}

function renderFacts(r, p) {
  const names = [...(r.previous_names || []), ...(r.parallel_names || []), ...(r.auxiliary_names || [])];
  const age = r.company_age_years != null ? html` <span class="muted">· ${Math.floor(r.company_age_years)} years</span>` : "";
  const registers = r.registers || [];
  const period = (e) => (e.until ? `${fmtDate(e.since)} – ${fmtDate(e.until)}` : `since ${fmtDate(e.since)}`);
  const regEv = (name) => {
    const e = registers.find((x) => x.register === name);
    return e ? html`<div class="ev">${name} entry ${period(e)}${e.status && e.status !== "Registered" ? ` · ${e.status}` : ""}</div>` : "";
  };
  const rows = [
    ["Industry", r.industry ? html`${r.industry} <span class="muted">(${r.industry_code})</span>` : "–"],
    ["Company form", r.company_form || "–"],
    ["Address", r.street_address || r.postal_address || "–"],
    r.postal_address && r.street_address && r.postal_address !== r.street_address ? ["Postal address", r.postal_address] : null,
    ["Registered", r.registered_on ? html`${fmtDate(r.registered_on)}${age}` : "–",
      r.business_id_granted_on ? html`<div class="ev">Business ID granted ${fmtDate(r.business_id_granted_on)}</div>` : ""],
    ["Trade register", r.trade_register_status || "–", regEv("Trade register")],
    ["Employer register", r.in_employer_register ? "Yes"
      : r.left_employer_register_on ? html`No <span class="muted">· left ${fmtDate(r.left_employer_register_on)}</span>` : "No",
      regEv("Employer register")],
    ["VAT register", r.vat_registered ? "Yes" : "No", regEv("VAT register")],
    ["Website in registry", r.website ? extLink(r.website) : html`<span class="muted">Not in the registry</span>`],
    names.length ? ["Other names", names.join(", ")] : null,
  ].filter(Boolean);
  const banner = evBanner(html`Official PRH trade register record${r.registry_last_modified ? `, last changed ${fmtDate(r.registry_last_modified)}` : ""}.
    ${fetched(p.scraped_at)} ${extLink(r.register_page || `https://tietopalvelu.ytj.fi/yritys/${r.business_id}`, "Open the record in YTJ")} · ${extLink(r.source, "raw data")}`);
  const entries = registers.length ? html`<details class="ev ev-registers"><summary>All register entries (${registers.length})</summary>
    <div class="table-wrap"><table><thead><tr><th>Register</th><th>Status</th><th>From</th><th>Until</th></tr></thead>
    <tbody>${registers.map((e) => html`<tr><td>${e.register}</td><td>${e.status || "–"}</td><td>${fmtDate(e.since)}</td><td>${e.until ? fmtDate(e.until) : "still valid"}</td></tr>`)}</tbody></table></div></details>` : "";
  return card("Company", html`${banner}<dl class="facts">${rows.map(([k, v, ev]) => html`<div><dt>${k}</dt><dd>${v}${ev || ""}</dd></div>`)}</dl>${entries}`);
}

function delta(v, unit, vs) {
  if (v == null || !Number.isFinite(v)) return "";
  const dir = Math.abs(v) < 0.05 ? "flat" : v > 0 ? "good" : "bad"; // up is good for every tile
  const arrow = dir === "flat" ? "→" : v > 0 ? "▲" : "▼";
  return html`<div class="delta ${dir}"><span aria-hidden="true">${arrow}</span> ${signed(v, unit)} <span class="vs">${vs}</span></div>`;
}
const change = (cur, prev) => (cur == null || prev == null || prev === 0 ? null : ((cur - prev) / Math.abs(prev)) * 100);
const tile = (label, value, extra) => html`<div class="tile"><div class="tile-label">${label}</div><div class="tile-value">${value}</div>${extra}</div>`;

const FIN_ROWS = [
  ["Revenue", "revenue", eur, true],
  ["Revenue growth", "revenue_growth_pct", (v) => signed(v)],
  ["Other operating income", "other_operating_income", eur],
  ["Materials and services", "materials_and_services", eur],
  ["Personnel costs", "personnel_costs", eur],
  ["Other operating expenses", "other_operating_expenses", eur],
  ["EBITDA", "ebitda", eur, true],
  ["EBITDA margin", "ebitda_margin_pct", pct],
  ["Depreciation", "depreciation", eur],
  ["Operating profit", "operating_profit", eur, true],
  ["Operating margin", "operating_margin_pct", pct],
  ["Profit before taxes", "profit_before_taxes", eur],
  ["Income taxes", "income_taxes", eur],
  ["Net profit", "net_profit", eur, true],
  ["Net margin", "net_margin_pct", pct],
  ["Total assets", "total_assets", eur, true],
  ["Equity", "equity", eur, true],
  ["Equity ratio", "equity_ratio_pct", pct],
  ["Total liabilities", "total_liabilities", eur],
];

function renderFinancials(f, p) {
  const when = f.retrieved_at || p.scraped_at;
  if (!f.available) {
    const filed = f.periods_filed && f.periods_filed.length ? html` Statements filed: ${f.periods_filed.map((d) => d.slice(0, 4)).join(", ")}.` : "";
    return card("Financials", html`<p class="empty-note">${f.note || "No financial data."}${filed}</p>
      ${evBanner(html`Checked PRH's digital financial statements. ${fetched(when)}`)}`);
  }
  const years = Object.keys(f.years).sort().reverse();
  const cur = f.years[years[0]];
  const prev = years[1] ? f.years[years[1]] : null;
  const vs = prev ? `vs ${years[1].slice(0, 4)}` : "";
  const eqDelta = prev && cur.equity_ratio_pct != null && prev.equity_ratio_pct != null
    ? cur.equity_ratio_pct - prev.equity_ratio_pct : null;
  const tiles = html`<div class="tiles">
    ${tile("Revenue", eurCompact(cur.revenue), delta(cur.revenue_growth_pct, "%", vs))}
    ${tile("EBITDA", eurCompact(cur.ebitda), cur.ebitda_margin_pct != null ? html`<div class="tile-note">${pct(cur.ebitda_margin_pct)} margin</div>` : "")}
    ${tile("Net profit", eurCompact(cur.net_profit), prev ? delta(change(cur.net_profit, prev.net_profit), "%", vs) : "")}
    ${tile("Equity ratio", pct(cur.equity_ratio_pct), delta(eqDelta, " pp", vs))}
  </div>`;
  const facts = f.evidence || {};
  const calc = f.calculated || {};
  const evCell = (key) => {
    if (calc[key]) return html`<span class="muted">Calculated: ${calc[key]}</span>`;
    const filed = years.map((y) => [y, facts[y] && facts[y][key]]).filter(([, x]) => x);
    if (!filed.length) return html`<span class="muted">–</span>`;
    const detail = filed.map(([y, x]) => `${fmtDate(y)}: element ${x.element}, context ${x.context}, filed value ${x.filed_value}`).join("\n");
    return html`<span title="${detail}">Filed <span class="mono">${filed[0][1].code}</span> <span class="muted">· ${filed.map(([, x]) => x.context).join(", ")}</span></span>`;
  };
  const rows = FIN_ROWS.filter(([, key]) => years.some((y) => f.years[y][key] != null));
  const table = html`<div class="table-wrap"><table class="fin-table">
    <thead><tr><th>€, financial year ending</th>${years.map((y) => html`<th class="num">${fmtDate(y)}</th>`)}<th class="ev-col">Evidence</th></tr></thead>
    <tbody>${rows.map(([label, key, fmt, strong]) => html`<tr class="${strong ? "key" : ""}"><td>${label}</td>${years.map((y) => html`<td class="num">${fmt(f.years[y][key])}</td>`)}<td class="ev-col">${evCell(key)}</td></tr>`)}</tbody>
  </table></div>`;
  const filedYears = (f.periods_filed || []).map((d) => d.slice(0, 4));
  const period = f.latest_period && f.latest_period.start ? `${fmtDate(f.latest_period.start)} – ${fmtDate(f.latest_period.end)}` : "";
  const banner = evBanner(html`Values as filed in the digital financial statement for ${period || `the year ending ${fmtDate(years[0])}`}${prev ? `, which also reports the ${years[1].slice(0, 4)} comparison figures` : ""}.
    ${fetched(when)} ${extLink(f.source, "Open the filed statement (XBRL)")}.
    The evidence column gives each line item's code and the context IDs to search for in that file. EBITDA, growth and ratios are calculated.`);
  return card("Financials", html`${tiles}${banner}${table}
    <p class="fin-foot">Statements on file at PRH: ${filedYears.join(", ") || "–"}. ${f.note || ""}</p>`,
    `Latest year ${years[0].slice(0, 4)}`);
}

function renderWebsite(w, p) {
  const when = w.retrieved_at || p.scraped_at;
  if (!w.available) {
    return card("Website", html`<p class="empty-note">${w.note || "No website data."}</p>${evBanner(fetched(when))}`);
  }
  const e = w.evidence || {};
  const ue = w.url_evidence;
  const source = { registry: "from the trade register", given: "entered by you" }[w.url_source]
    || (w.url_source && w.url_source.startsWith("guessed") ? "guessed, verified on the page" : w.url_source);
  const how = w.url_source === "registry" ? html`Listed as the website in the ${extLink(p.registry.register_page, "PRH record")}.`
    : w.url_source === "given" ? "Website entered by you."
    : ue ? html`Not in the PRH record, so likely addresses were tried. This one was accepted because the page mentions the ${ue.verified_by}${ue.snippet ? ":" : "."}${quote(ue.snippet, ue.matched)}`
    : "Guessed from the company name and verified on the page.";
  const about = w.meta_description || w.about_text;
  const aboutEv = w.meta_description && e.meta_description ? html`<div class="ev">Meta description of ${pageLink(e.meta_description.page)}</div>`
    : e.about_text ? html`<div class="ev">Paragraphs on ${pageLinks(e.about_text.pages)}</div>` : "";
  const socials = (w.social_links || []).map((u) => {
    const href = safeUrl(u);
    return html`${extLink(u, href ? new URL(href).hostname.replace(/^www\./, "") : u)}${findingEv((e.social_links || {})[u])}`;
  });
  const block = (title, items) => html`<div><h3>${title}</h3>${items.length ? html`<ul>${items.map((x) => html`<li>${x}</li>`)}</ul>` : html`<span class="muted">None found</span>`}</div>`;
  const emails = (w.emails || []).map((x) => html`<a href="mailto:${x}">${x}</a>${findingEv((e.emails || {})[x])}`);
  const phones = (w.phones || []).map((x) => html`<a href="tel:${x.replace(/[^\d+]/g, "")}">${x}</a>${findingEv((e.phones || {})[x])}`);
  const signals = Object.entries(w.signals || {});
  const years = w.founding_years_mentioned || [];
  return card("Website", html`
    <div class="site-line">
      <span class="site-url">${extLink(w.url)}</span>
      ${source ? badge("", source) : ""}
      <span class="muted">· ${plural((w.pages_scraped || []).length, "page", "pages")} read</span>
    </div>
    ${evBanner(html`${how} ${fetched(when)} Pages read: ${pageLinks(w.pages_scraped)}.`)}
    ${w.title ? html`<p class="site-title">${w.title}</p>${e.title ? html`<div class="ev">Page title of ${pageLink(e.title.page)}</div>` : ""}` : ""}
    ${about ? html`<p class="site-about">${about.length > 320 ? about.slice(0, 320) + "…" : about}</p>${aboutEv}` : ""}
    ${w.about_text && w.about_text !== about || (about && about.length > 320)
      ? html`<details class="more"><summary>Text from the site</summary><p>${w.about_text || about}</p></details>` : ""}
    <div class="site-grid">
      ${block("Emails", emails)}
      ${block("Phones", phones)}
      ${block("Social", socials)}
    </div>
    ${(w.people_mentions || []).length ? html`<div class="site-block people"><h3>People and roles mentioned</h3><ul>${w.people_mentions.map((x) => html`<li>${x}${findingEv((e.people_mentions || {})[x])}</li>`)}</ul></div>` : ""}
    ${signals.length ? html`<div class="site-block signals"><h3>Signals</h3><ul>${signals.map(([k, snippet]) => {
      const se = (e.signals || {})[k];
      return html`<li>${badge("warn", SIGNALS[k] || k)}<div><q>${highlight(snippet.replace(/^…|…$/g, ""), se && se.matched)}</q>${se ? html`<div class="ev">Text on ${pageLink(se.page)}</div>` : ""}</div></li>`;
    })}</ul></div>` : ""}
    ${years.length ? html`<div class="site-block"><h3>Founding years mentioned</h3><ul>${years.map((y) => html`<li>${y}${findingEv((e.founding_years_mentioned || {})[y])}</li>`)}</ul></div>` : ""}
  `);
}

function renderOthers(p) {
  return card(`Other companies matching “${p.query}”`, html`<ul class="others">${p.other_matches.map((m) => html`<li>
      <div><strong>${m.name}</strong> <span class="muted">${m.business_id}</span> ${m.active ? "" : badge("bad", "Not active")}</div>
      <button type="button" class="btn small" data-action="add-company" data-query="${m.business_id}">Add this one</button>
    </li>`)}</ul>`, "The best match is shown above. Wrong company? Add another.");
}

// ---------- step 2: analysis (Claude) ----------

function renderAICard(p) {
  return html`<section class="card ai-card" id="ai-card">
    <div class="card-head">
      <h2><span class="ai-mark" aria-hidden="true">✦</span> Claude's analysis</h2>
      <div id="ai-actions" class="ai-actions">${renderAIActions(p)}</div>
    </div>
    <div id="ai-body">${renderAIBody(p)}</div>
    ${state.ai.configured ? html`<div class="ask">
      <h3>Ask Claude about this company</h3>
      <ol id="qa-log" class="qa">${renderQA(p.registry.business_id)}</ol>
      <form id="ask-form" class="ask-form" autocomplete="off">
        <input id="ask-input" type="text" maxlength="1000" placeholder="e.g. Why did revenue fall? Who runs the company?" aria-label="Question about this company">
        <button type="submit" class="btn primary">Ask</button>
      </form>
    </div>` : ""}
  </section>`;
}

function renderAIActions(p) {
  if (!state.ai.configured) return "";
  const a = p.ai_analysis;
  const bid = p.registry.business_id;
  const running = (state.analysis[bid] || {}).status === "running";
  const meta = a ? html`<span class="card-sub">${a.model} · ${fmtDateTime(a.created_at)}</span>` : "";
  if (!a) return html`<button type="button" class="btn small primary" data-action="analyze" data-bid="${bid}" data-detail="brief" ${running ? "disabled" : ""}>Analyze with Claude</button>`;
  const detailed = a.detail === "detailed";
  return html`${meta}
    <button type="button" class="btn small" data-action="analyze" data-bid="${bid}" data-detail="${detailed ? "brief" : "detailed"}" ${running ? "disabled" : ""}>${detailed ? "Shorter" : "More detail"}</button>
    <button type="button" class="btn small" data-action="analyze" data-bid="${bid}" data-detail="${a.detail || "brief"}" ${running ? "disabled" : ""}>Regenerate</button>`;
}

function renderAIBody(p) {
  if (!state.ai.configured) {
    return html`<p class="empty-note">To turn on Claude, put your Anthropic API key in the <code>.env</code> file next to <code>app.py</code> (<code>ANTHROPIC_API_KEY=…</code>) and restart the app.</p>`;
  }
  const slot = state.analysis[p.registry.business_id];
  if (slot && slot.status === "running") {
    return html`<div class="ai-progress" aria-live="polite">${ICON.spinner}<div><strong>Claude is reading the facts and writing the analysis…</strong>
      <div class="muted">Usually 30–90 seconds. ${fmtElapsed(slot.elapsed)}</div></div></div>`;
  }
  const error = slot && slot.status === "error" ? notice("error", "The analysis failed", slot.error || "Unknown error.") : "";
  const a = p.ai_analysis;
  if (!a) {
    return html`${error}<p class="empty-note">Claude reads the company's facts and writes a short summary, a financial health rating, the sale and succession signals, risks and questions to ask. Every statement cites the facts it's based on.</p>`;
  }
  return html`${error}${renderAnalysis(a, p)}`;
}

function renderAnalysis(a, p) {
  const x = a.analysis || {};
  const facts = factMap(a.facts);
  const c = (t) => cited(t, "analysis", facts);
  const list = (items) => (items && items.length ? html`<ul>${items.map((t) => html`<li>${c(t)}</li>`)}</ul>` : html`<p class="muted">None.</p>`);
  const plain = (items) => (items && items.length ? html`<ul>${items.map((t) => html`<li>${t}</li>`)}</ul>` : html`<p class="muted">None.</p>`);
  const fh = x.financial_health || {};
  const ss = x.sale_signals || {};
  const stale = a.based_on && a.based_on !== p.scraped_at;
  const detailed = a.detail === "detailed";
  return html`
    ${stale ? html`<div class="ev-banner ai-stale"><span class="ev-label">Note</span><div>Written from data fetched ${fmtDateTime(a.based_on)}. The data has been refreshed since; regenerate to update the analysis.</div></div>` : ""}
    <p class="ai-headline">${c(x.headline)}</p>
    <p class="ai-summary">${c(x.summary)}</p>
    <div class="badges ai-ratings">
      ${badge(HEALTH[fh.rating] ?? "", `Financial health: ${cap(fh.rating || "unknown")}`)}
      ${badge(SALE[ss.rating] ?? "", `Sale / succession signals: ${cap(ss.rating || "unknown")}`)}
    </div>
    <details class="ai-details" ${detailed ? "open" : ""}>
    <summary>${detailed ? "Detailed analysis" : "Details"}: business, finances, sale signals, risks, questions</summary>
    <div class="ai-grid">
      <div><h3>Business</h3>${list(x.business)}</div>
      <div><h3>Financial health</h3>${list(fh.points)}</div>
      <div><h3>Sale and succession signals</h3>${list(ss.points)}</div>
      <div><h3>Strengths</h3>${list(x.strengths)}</div>
      <div><h3>Risks</h3>${list(x.risks)}</div>
      <div><h3>Questions to ask</h3>${plain(x.questions)}</div>
      <div><h3>Missing data</h3>${plain(x.data_gaps)}</div>
    </div>
    </details>
    <p class="ai-foot">Written by Claude from the facts in Research only. Click a number to see the fact and its source, and check what matters before relying on it.</p>`;
}

function renderQA(bid) {
  const chat = state.chats[bid] || [];
  if (!chat.length) {
    const ideas = ["What does the company do?", "Is the company financially healthy?", "Any signs the owner wants to sell?", "Who could buy this company?"];
    return html`<li class="qa-ideas">${ideas.map((q) => html`<button type="button" class="chip-btn" data-action="ask" data-question="${q}">${q}</button>`)}</li>`;
  }
  return chat.map((t, i) => html`<li>
    <div class="qa-q">${t.q}</div>
    <div class="qa-a">${t.status === "error" ? html`<span class="qa-error">${t.error}</span>`
      : t.a ? richText(t.a, `ask-${i}`, t.status === "done" ? t.facts || {} : null)
      : html`<span class="muted qa-wait">${ICON.spinner} Thinking…</span>`}</div>
  </li>`);
}

function refreshAIParts() {
  const p = state.profile;
  if (p && state.route.view === "company" && document.getElementById("ai-card")) {
    setHtml("ai-actions", renderAIActions(p));
    setHtml("ai-body", renderAIBody(p));
  }
  refreshSteps();
}

async function startAnalysis(bid, detail = "brief") {
  const slot = (state.analysis[bid] = { jobId: null, timer: null, status: "running", elapsed: 0 });
  if (state.bid === bid) refreshAIParts();
  let job;
  try {
    job = await api(`/api/companies/${bid}/analysis`, { method: "POST", body: JSON.stringify({ detail }) });
  } catch (e) {
    Object.assign(slot, { status: "error", error: e.message });
    if (state.bid === bid) refreshAIParts();
    return;
  }
  slot.jobId = job.id;
  refreshActivity();
  poll(slot, job.id, (j) => onAnalysisUpdate(bid, j));
}

async function onAnalysisUpdate(bid, job) {
  const slot = state.analysis[bid];
  if (!job) {
    Object.assign(slot, { status: "error", error: "The app was restarted while Claude was working. Try again." });
  } else if (job.status === "running") {
    slot.elapsed = job.elapsed;
  } else {
    const item = job.items[0];
    slot.jobId = null;
    Object.assign(slot, item.status === "done" ? { status: "done" } : { status: "error", error: item.note });
  }
  if (slot.status === "done") {
    delete state.analysis[bid];
    await loadCompanies();
    if (state.route.view === "pipeline") redrawPipeline();
    if (state.bid !== bid || state.route.view !== "company") return;
    try {
      state.profile = await api(`/api/companies/${bid}`);
    } catch { /* keep the old view */ }
    setHtml("ws-head", renderWsHead());
  }
  if (state.bid === bid) refreshAIParts();
  else if (state.route.view === "pipeline") redrawPipeline();
}

async function askQuestion(bid, question) {
  const chat = (state.chats[bid] = state.chats[bid] || []);
  const history = chat.filter((t) => t.status === "done").map((t) => ({ q: t.q, a: t.a }));
  const turn = { q: question, a: "", status: "running", jobId: null, timer: null };
  chat.push(turn);
  const redraw = () => { if (state.bid === bid) setHtml("qa-log", renderQA(bid)); };
  redraw();
  let job;
  try {
    job = await api(`/api/companies/${bid}/ask`, { method: "POST", body: JSON.stringify({ question, history }) });
  } catch (e) {
    Object.assign(turn, { status: "error", error: e.message });
    redraw();
    return;
  }
  turn.jobId = job.id;
  poll(turn, job.id, (j) => {
    if (!j) Object.assign(turn, { status: "error", error: "The app was restarted. Ask again." });
    else {
      const item = j.items[0];
      turn.a = item.answer || "";
      if (j.status !== "running") {
        turn.jobId = null;
        Object.assign(turn, item.status === "done" ? { status: "done", facts: item.facts || {} } : { status: "error", error: item.note });
      }
    }
    redraw();
  });
}

// ---------- events ----------

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  switch (el.dataset.action) {
    case "analyze":
      startAnalysis(el.dataset.bid, el.dataset.detail || "brief");
      if (el.dataset.goto && state.bid === el.dataset.bid) location.hash = tabHref(el.dataset.goto);
      break;
    case "ask":
      if (state.bid) askQuestion(state.bid, el.dataset.question);
      break;
    case "refresh": {
      const bid = el.dataset.query;
      if (state.ai.configured && addOptions().ai) state.autoAnalyze.add(bid);
      startAdd([bid], { website: el.dataset.website || "", from: state.from });
      break;
    }
    case "add-company":
      startAdd([el.dataset.query]);
      break;
    case "toggle-evidence": {
      state.showEvidence = el.checked;
      pref.set("evidence", el.checked);
      const profile = el.closest(".profile");
      if (profile) profile.classList.toggle("hide-evidence", !el.checked);
      break;
    }
    default:
  }
});

document.addEventListener("submit", (e) => {
  if (e.target.id !== "ask-form") return;
  e.preventDefault();
  const input = $("#ask-input");
  const q = input.value.trim();
  if (!q || !state.bid) return;
  input.value = "";
  askQuestion(state.bid, q);
});
