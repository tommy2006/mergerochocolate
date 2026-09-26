"use strict";

/* The pipeline: every company and where it is in the workflow, with the next step as a button.
   Adding companies (one or many) happens here too, and one company's lookup has its own page. */

const STAGES = [
  { id: "all", label: "All" },
  { id: "new", label: "Researched", hint: "Facts collected; no analysis yet" },
  { id: "analyzed", label: "Analyzed", hint: "Claude's analysis done; no buyers yet" },
  { id: "buyers", label: "Buyers found", hint: "Buyers found; no emails yet" },
  { id: "outreach", label: "In outreach", hint: "Emails drafted or sent" },
];
const STAGE_LABEL = Object.fromEntries(STAGES.map((s) => [s.id, s.label]));
// Not a step: companies found as buyers for another company in the pipeline
const CANDIDATES = { id: "candidates", label: "Buyer candidates", hint: "Companies researched as potential buyers for another" };
const inFilter = (r, f) => (f === "all" ? true : f === "candidates" ? (r.buyer_for || []).length > 0 : r.stage === f);
const HEADER_CELL = /^(name|company|company name|nimi|yritys|yrityksen nimi|business ?id|y-?tunnus)$/i;

function addOptions() {
  return { financials: true, website: true, ai: true, ...pref.get("add", {}) };
}

function parseLines(text, isCsv) {
  const out = [];
  for (let line of text.split(/\r?\n/)) {
    if (isCsv) line = (line.split(/[;,\t]/)[0] || "").replace(/^"|"$/g, "");
    line = line.trim();
    if (!line || line.startsWith("#") || (isCsv && !out.length && HEADER_CELL.test(line))) continue;
    out.push(line);
  }
  return out;
}

// Look up one company (opens its lookup page) or several (they appear in the pipeline as they're found).
async function startAdd(queries, { website = "", from = null } = {}) {
  const o = addOptions();
  const one = queries.length === 1;
  let job;
  try {
    job = await api("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ kind: one ? "lookup" : "batch", queries, website: one ? website : "",
        with_financials: o.financials, with_website: o.website, with_ai: o.ai && state.ai.configured }),
    });
  } catch (e) {
    if (state.route.view === "pipeline") setHtml("add-msg", notice("error", "Could not start", e.message));
    return null;
  }
  refreshActivity();
  if (one) location.hash = `#/add/${job.id}${from ? `?from=${from}` : ""}`;
  else if (state.route.view === "pipeline") redrawPipeline();
  return job;
}

// ---------- the pipeline page ----------

async function showPipeline(filter) {
  state.filter = STAGE_LABEL[filter] || filter === CANDIDATES.id ? filter : "all";
  document.title = "Companies – Company Scraper";
  renderPipeline();
  await loadCompanies();
  if (state.route.view === "pipeline") redrawPipeline();
}

function renderPipeline() {
  const o = addOptions();
  mount($("#main"), html`
    <section class="pipe-head">
      <div>
        <h1>Companies</h1>
        <p class="lede">Every company moves through four steps: <strong>research</strong> the public facts, get <strong>Claude's analysis</strong>, find <strong>buyers</strong>, and write the <strong>outreach</strong> emails.</p>
      </div>
      <div class="pipe-exports" id="pipe-exports"></div>
    </section>
    <section class="card add-card">
      <form id="add-form" autocomplete="off">
        <label for="add-input" class="search-label">Add companies</label>
        <div class="add-row">
          <textarea id="add-input" rows="1" spellcheck="false" placeholder="Company name or Business ID. Paste several, one per line."></textarea>
          <button type="submit" class="btn primary" id="add-btn">Add</button>
        </div>
        <div class="add-foot">
          <label class="btn small file-btn">Load a list…<input type="file" id="add-file" accept=".txt,.csv,text/plain,text/csv" hidden></label>
          <span class="muted" id="add-count">Enter adds one company; Shift+Enter starts a new line.</span>
          <span class="spacer"></span>
          <label class="check"><input type="checkbox" data-opt="financials" ${o.financials ? "checked" : ""}> Financial statements</label>
          <label class="check"><input type="checkbox" data-opt="website" ${o.website ? "checked" : ""}> Website</label>
          <label class="check" title="${state.ai.configured ? "Claude writes a short analysis of each company added" : "Needs the Anthropic API key"}"><input type="checkbox" data-opt="ai" ${o.ai && state.ai.configured ? "checked" : ""} ${state.ai.configured ? "" : "disabled"}> Claude's analysis</label>
        </div>
      </form>
      <div id="add-msg"></div>
    </section>
    <div id="import-status"></div>
    <div id="pipe-body"></div>`);
  redrawPipeline();
}

function redrawPipeline() {
  if (state.route.view !== "pipeline" || !document.getElementById("pipe-body")) return;
  setHtml("import-status", renderImports());
  setHtml("pipe-body", renderPipeBody());
  setHtml("pipe-exports", renderExports());
}

function visibleRows() {
  return state.companies.filter((r) => inFilter(r, state.filter));
}

function renderExports() {
  if (!state.companies.length) return "";
  const rows = visibleRows();
  const ids = state.filter === "all" ? "" : `&ids=${rows.map((r) => r.business_id).join(",")}`;
  return html`<span class="muted">Download ${state.filter === "all" ? "all" : "these"}:</span>
    <a class="btn small" href="/api/export?format=xlsx${ids}">Excel</a>
    <a class="btn small" href="/api/export?format=csv${ids}">CSV</a>`;
}

function renderPipeBody() {
  if (!state.companies.length) {
    return html`<section class="card welcome">
      <h2>How it works</h2>
      <ol class="flow">
        <li><span class="flow-no">1</span><strong>Research</strong><span>Official register data, filed financial statements and the company's website, with evidence for every fact.</span></li>
        <li><span class="flow-no">2</span><strong>Analysis</strong><span>Claude summarises the company and rates its financial health and how likely it is to be for sale.</span></li>
        <li><span class="flow-no">3</span><strong>Buyers</strong><span>The app finds competitors, customers and suppliers that could buy it, and Claude ranks them.</span></li>
        <li><span class="flow-no">4</span><strong>Outreach</strong><span>Claude drafts a personal first email to each buyer, for you to review and send.</span></li>
      </ol>
      <p class="try">Start by adding a company above, or try:
        <button type="button" class="chip-btn" data-action="add-company" data-query="0180611-0">0180611-0</button>
        <button type="button" class="chip-btn" data-action="add-company" data-query="Lapuan Kuljetus">Lapuan Kuljetus</button></p>
    </section>`;
  }
  const chips = [...STAGES, CANDIDATES];
  const counts = Object.fromEntries(chips.map((s) => [s.id, state.companies.filter((r) => inFilter(r, s.id)).length]));
  const rows = visibleRows();
  const unanalyzed = state.companies.filter((r) => !r.has_analysis && !analysisRunning(r.business_id));
  return html`
    <div class="pipe-tools">
      <nav class="stage-filter" aria-label="Filter by step">${chips.filter((s) => s.id !== CANDIDATES.id || counts[s.id]).map((s) => html`<a href="#/${s.id === "all" ? "" : `?stage=${s.id}`}" class="stage-chip ${state.filter === s.id ? "on" : ""}" title="${s.hint || ""}">${s.label} <span class="count">${counts[s.id]}</span></a>`)}</nav>
      ${state.ai.configured && unanalyzed.length ? html`<button type="button" class="btn small" data-action="bulk-analyze" title="About 10 cents each">✦ Analyze ${plural(unanalyzed.length, "company", "companies")} with Claude</button>` : ""}
    </div>
    <section class="card table-card">
      ${rows.length ? html`<div class="table-wrap"><table class="pipe-table">
        <thead><tr><th>Company</th><th class="num">Revenue</th><th>Claude's view</th><th>Progress</th><th class="c-next">Next step</th></tr></thead>
        <tbody>${rows.map(renderRow)}</tbody>
      </table></div>` : html`<p class="empty-note pad">No companies at this step.</p>`}
    </section>`;
}

const analysisRunning = (bid) => (state.analysis[bid] || {}).status === "running" || jobsFor(bid).some((j) => j.kind === "analysis");

function renderRow(r) {
  const bid = r.business_id;
  const running = jobsFor(bid);
  const aBusy = analysisRunning(bid);
  const sub = [bid, r.municipality && titleCase(r.municipality), r.industry].filter(Boolean).join(" · ");
  const view = aBusy ? html`<span class="muted">${ICON.spinner} Claude is analyzing…</span>`
    : r.has_analysis ? html`<div class="mini-badges">
        ${badge(`mini ${HEALTH[r.ai_financial_health] ?? ""}`, `Health: ${cap(r.ai_financial_health || "unknown")}`)}
        ${badge(`mini ${SALE[r.ai_sale_signals] ?? ""}`, `Sale: ${cap(r.ai_sale_signals || "unknown")}`)}
      </div><div class="c-headline" title="${r.ai_headline || ""}">${r.ai_headline || ""}</div>`
    : html`<span class="muted">Not analyzed yet</span>`;
  const dots = [true, r.has_analysis, r.buyers > 0, r.emails > 0 && r.sent === r.emails];
  const answered = [r.interested ? `${r.interested} interested` : "", r.follow_ups_due ? `${r.follow_ups_due} follow-ups due` : ""].filter(Boolean).join(" · ");
  const half = [false, false, !r.buyers && r.has_brief, r.emails > 0 && r.sent < r.emails];
  const progressText = r.emails ? `${r.sent} of ${plural(r.emails, "email", "emails")} sent${answered ? ` · ${answered}` : ""}`
    : r.buyers ? `${plural(r.buyers, "buyer", "buyers")} · ${r.selected} selected`
    : r.has_analysis ? "Ready to find buyers" : "Facts collected";
  return html`<tr class="pipe-row" data-open="${bid}">
    <td class="c-company"><a class="c-name" href="#/c/${bid}">${r.name}</a><div class="c-sub">${sub}</div>
      ${(r.buyer_for || []).length ? html`<div class="c-sub c-buyerfor">Potential buyer for ${r.buyer_for.map((x, i) => html`${i ? ", " : ""}<a href="#/c/${x.seller}/buyers">${x.name}</a> (fit ${x.fit})`)}</div>` : ""}
      <div class="narrow-only c-stage"><div class="mini-steps">${dots.map((d, i) => html`<span class="ms ${d ? "done" : half[i] ? "half" : ""}"></span>`)}</div>
        <span class="c-sub">${STAGE_LABEL[r.stage]} · ${progressText}${r.has_analysis ? ` · health ${r.ai_financial_health || "unknown"}, sale ${r.ai_sale_signals || "unknown"}` : ""}</span></div></td>
    <td class="num c-rev">${r.revenue != null ? html`${eurCompact(r.revenue)}${r.revenue_growth_pct != null ? html`<div class="c-sub ${r.revenue_growth_pct < 0 ? "neg" : "pos"}">${signed(r.revenue_growth_pct)}</div>` : ""}` : html`<span class="muted">–</span>`}</td>
    <td class="c-view">${view}</td>
    <td class="c-progress"><div class="mini-steps" title="Research · Analysis · Buyers · Outreach">${dots.map((d, i) => html`<span class="ms ${d ? "done" : half[i] ? "half" : ""}"></span>`)}</div><div class="c-sub">${progressText}</div></td>
    <td class="c-next">${renderNextAction(r, running, aBusy)}</td>
  </tr>`;
}

function renderNextAction(r, running, aBusy) {
  const bid = r.business_id;
  const other = running.find((j) => j.kind !== "analysis");
  if (aBusy || other) return html`<span class="muted busy">${ICON.spinner} ${aBusy ? "Analyzing" : other.kind === "find" ? "Finding buyers" : "Working"}…</span>`;
  // the step after the furthest one reached
  if (r.interested) return html`<a class="btn small primary good" href="#/c/${bid}/outreach">${plural(r.interested, "buyer", "buyers")} interested</a>`;
  if (r.follow_ups_due) return html`<a class="btn small primary" href="#/c/${bid}/outreach">Follow up (${r.follow_ups_due})</a>`;
  if (r.emails) {
    return r.sent < r.emails
      ? html`<a class="btn small primary" href="#/c/${bid}/outreach">Send ${r.emails - r.sent} ${r.emails - r.sent === 1 ? "email" : "emails"}</a>`
      : html`<a class="btn small" href="#/c/${bid}/outreach">Waiting for answers</a>`;
  }
  if (r.buyers) return html`<a class="btn small primary" href="#/c/${bid}/${r.selected ? "outreach" : "buyers"}">${r.selected ? "Write emails" : "Choose buyers"}</a>`;
  if (!r.has_analysis && state.ai.configured) return html`<button type="button" class="btn small primary" data-action="row-analyze" data-bid="${bid}">Analyze</button>`;
  return html`<button type="button" class="btn small primary" data-action="row-find" data-bid="${bid}">Find buyers</button>`;
}

// Imports: running batches, and a summary of the last one.
function renderImports() {
  const batches = state.activity.filter((j) => j.kind === "batch");
  const running = batches.map((j) => {
    const total = j.items.length;
    const done = total - (j.counts.queued || 0) - (j.counts.running || 0);
    const now = j.items.find((i) => i.status === "running");
    return html`<section class="card import-card" aria-live="polite">
      <div class="batch-line"><strong>${j.meta.title}: ${done} of ${total} done</strong><span class="muted">${fmtElapsed(j.elapsed)}</span>
        <span class="spacer"></span><button type="button" class="btn small" data-action="stop-import" data-job="${j.id}">Stop</button></div>
      <div class="bar"><span style="width:${total ? (done / total) * 100 : 0}%"></span></div>
      ${now ? html`<div class="c-sub">Now: ${now.query}${now.step ? ` · ${now.step}` : ""}</div>` : ""}
    </section>`;
  });
  const last = state.lastImport;
  let summary = "";
  if (last) {
    const miss = last.items.filter((i) => i.status === "not_found" || i.status === "error");
    const dup = last.items.filter((i) => i.status === "duplicate");
    summary = html`<section class="card import-card done">
      <div class="batch-line"><strong>${last.status === "stopped" ? "Import stopped" : "Import finished"}: ${plural(last.counts.found || 0, "company", "companies")} added</strong>
        <span class="spacer"></span><button type="button" class="btn small" data-action="dismiss-import">Dismiss</button></div>
      ${miss.length ? html`<div class="c-sub">Not found: ${miss.map((i) => i.query).join(", ")}</div>` : ""}
      ${dup.length ? html`<div class="c-sub">Listed twice, skipped: ${dup.map((i) => i.query).join(", ")}</div>` : ""}
    </section>`;
  }
  return html`${running}${summary}`;
}

// ---------- one company's lookup ----------

async function showAdding(jobId, from) {
  const slot = (state.adding = { jobId, timer: null });
  document.title = "Adding… – Company Scraper";
  mount($("#main"), html`<a class="backlink" href="#/">← All companies</a><div id="adding"><section class="card"><p class="muted">Starting…</p></section></div>`);
  poll(slot, jobId, (job) => {
    if (state.adding !== slot) return;
    if (!job) {
      setHtml("adding", notice("info", "This lookup has finished", html`It may already be in your companies. <a href="#/">Open the list</a>.`));
      return;
    }
    const item = job.items[0];
    if (job.status === "running") {
      setHtml("adding", html`<section class="card progress-card" aria-live="polite">
        <div class="card-head"><h2>Adding “${item.query}”</h2><span class="card-sub">${fmtElapsed(job.elapsed)}</span></div>
        ${renderSteps(item.log || [], true)}
        <p class="muted adding-next">When it's done, the company opens here${addOptions().ai && state.ai.configured ? " and Claude starts its analysis" : ""}.</p>
      </section>`);
      return;
    }
    if (item.status === "found") {
      if (addOptions().ai && state.ai.configured) state.autoAnalyze.add(item.business_id);
      loadCompanies().then(() => {
        if (state.adding === slot) location.replace(`#/c/${item.business_id}/research${from ? `?from=${from}` : ""}`);
      });
    } else if (item.status === "not_found") {
      setHtml("adding", notice("info", `No company found for “${item.query}”`,
        "Check the spelling, try the official name without “Oy”, or use the Business ID (Y-tunnus)."));
    } else {
      setHtml("adding", notice("error", "The lookup failed", item.note || "Unknown error."));
    }
  });
}

// ---------- events ----------

function updateAddCount() {
  const input = $("#add-input");
  if (!input) return;
  const n = parseLines(input.value, false).length;
  input.rows = Math.min(8, Math.max(1, input.value.split("\n").length));
  setHtml("add-count", n > 1 ? `${plural(n, "company", "companies")}${n > 500 ? " – the limit is 500" : ""}` : "Enter adds one company; Shift+Enter starts a new line.");
  $("#add-btn").textContent = n > 1 ? `Add ${n}` : "Add";
}

async function submitAdd() {
  const input = $("#add-input");
  const queries = parseLines(input.value, false);
  if (!queries.length || queries.length > 500) return;
  setHtml("add-msg", "");
  const job = await startAdd(queries);
  if (job) {
    input.value = "";
    updateAddCount();
  }
}

async function loadAddFile(file) {
  $("#add-input").value = parseLines(await file.text(), /\.csv$/i.test(file.name)).join("\n");
  updateAddCount();
}

document.addEventListener("input", (e) => { if (e.target.id === "add-input") updateAddCount(); });

document.addEventListener("keydown", (e) => {
  if (e.target.id !== "add-input" || e.key !== "Enter" || e.shiftKey || e.isComposing) return;
  if (e.target.value.includes("\n") && !(e.metaKey || e.ctrlKey)) return; // a list: Ctrl/Cmd+Enter adds it
  e.preventDefault();
  submitAdd();
});

document.addEventListener("submit", (e) => {
  if (e.target.id !== "add-form") return;
  e.preventDefault();
  submitAdd();
});

document.addEventListener("change", (e) => {
  const el = e.target;
  if (el.id === "add-file" && el.files[0]) {
    loadAddFile(el.files[0]);
    el.value = "";
  } else if (el.dataset && el.dataset.opt) {
    pref.set("add", { ...addOptions(), [el.dataset.opt]: el.checked });
  }
});

document.addEventListener("dragover", (e) => { if (e.target.id === "add-input") e.preventDefault(); });
document.addEventListener("drop", (e) => {
  if (e.target.id !== "add-input" || !e.dataTransfer.files[0]) return;
  e.preventDefault();
  loadAddFile(e.dataTransfer.files[0]);
});

document.addEventListener("click", async (e) => {
  if (state.route.view !== "pipeline") return;
  const el = e.target.closest("[data-action]");
  if (el) {
    switch (el.dataset.action) {
      case "row-analyze":
        startAnalysis(el.dataset.bid);
        redrawPipeline();
        return;
      case "row-find":
        state.pendingFind = el.dataset.bid;
        location.hash = `#/c/${el.dataset.bid}/buyers`;
        return;
      case "bulk-analyze":
        for (const r of state.companies.filter((x) => !x.has_analysis && !analysisRunning(x.business_id))) startAnalysis(r.business_id);
        redrawPipeline();
        return;
      case "stop-import":
        el.disabled = true;
        el.textContent = "Stopping after this company…";
        try { await api(`/api/jobs/${el.dataset.job}/stop`, { method: "POST" }); } catch { el.disabled = false; }
        return;
      case "dismiss-import":
        state.lastImport = null;
        redrawPipeline();
        return;
      default:
        return;
    }
  }
  const row = e.target.closest("tr[data-open]");
  if (row && !e.target.closest("a, button")) location.hash = `#/c/${row.dataset.open}`;
});
