"use strict";

/* Routing, the find-or-add box in the top bar, the running-tasks indicator, and start-up.

   #/                          pipeline of all companies (#/?stage=analyzed filters it)
   #/c/<Business ID>/<step>    a company's workspace: research, analysis, buyers or outreach
   #/add/<job>                 a company being looked up */

function parseRoute() {
  const [path, query] = (location.hash.replace(/^#/, "") || "/").split("?");
  const params = new URLSearchParams(query || "");
  let m;
  if ((m = /^\/c\/(\d{7}-\d)(?:\/(research|analysis|buyers|outreach))?$/.exec(path))) {
    return { view: "company", bid: m[1], tab: m[2] || null, from: params.get("from") };
  }
  if ((m = /^\/add\/([a-f0-9]+)$/.exec(path))) return { view: "adding", job: m[1], from: params.get("from") };
  if ((m = /^\/company\/(\d{7}-\d)$/.exec(path))) return { redirect: `#/c/${m[1]}/research` }; // older links
  if ((m = /^\/buyers\/(\d{7}-\d)$/.exec(path))) return { redirect: `#/c/${m[1]}/buyers` };
  return { view: "pipeline", filter: params.get("stage") || "all" };
}

async function route() {
  const r = parseRoute();
  if (r.redirect) {
    location.replace(r.redirect);
    return;
  }
  state.route = r;
  state.adding = null;
  hidePop();
  closeMenus();
  if (r.view === "company") {
    await showCompany(r.bid, r.tab, r.from);
    if (state.pendingFind === r.bid && cmp.data && state.route.view === "company") {
      state.pendingFind = null;
      const running = cmp.jobs.find && cmp.jobs.find.status === "running";
      if (!running && state.ai.configured) startCampaignJob("find");
    }
    return;
  }
  state.bid = null;
  state.profile = null;
  if (r.view === "adding") return showAdding(r.job, r.from);
  return showPipeline(r.filter);
}
window.addEventListener("hashchange", route);

// ---------- running tasks ----------

let activityTimer = null;

async function refreshActivity() {
  clearTimeout(activityTimer);
  let jobs;
  try {
    jobs = await api("/api/jobs");
  } catch {
    activityTimer = setTimeout(refreshActivity, 5000);
    return;
  }
  const now = new Set(jobs.map((j) => j.id));
  const finished = state.activity.filter((j) => !now.has(j.id));
  const foundBefore = Object.fromEntries(state.activity.map((j) => [j.id, j.counts.found || 0]));
  const grew = jobs.some((j) => j.kind === "batch" && (j.counts.found || 0) > (foundBefore[j.id] || 0));
  state.activity = jobs;
  renderActivity();
  if (finished.length || grew) {
    for (const j of finished.filter((x) => x.kind === "batch")) {
      try { state.lastImport = await api(`/api/jobs/${j.id}`); } catch { /* summary not available */ }
    }
    await loadCompanies();
    if (state.route.view === "company" && state.profile) setHtml("ws-head", renderWsHead());
  }
  if (state.route.view === "pipeline") redrawPipeline();
  if (jobs.length) activityTimer = setTimeout(refreshActivity, 2500);
}

function renderActivity() {
  const jobs = state.activity;
  const btn = $("#activity-btn");
  btn.hidden = !jobs.length;
  if (!jobs.length) {
    $("#activity-menu").hidden = true;
    return;
  }
  mount(btn, html`${ICON.spinner}<span>${plural(jobs.length, "task", "tasks")} running</span>`);
  mount($("#activity-menu"), html`<div class="menu-title">Running now</div><ul>${jobs.map((j) => {
    const total = j.items.length;
    const done = total - (j.counts.queued || 0) - (j.counts.running || 0);
    const link = j.kind === "lookup" ? `#/add/${j.id}` : j.kind === "batch" && !j.meta.bid ? "#/" : `#/c/${j.meta.bid}/${KIND_TAB[j.kind] || "research"}`;
    const step = (j.items.find((i) => i.status === "running") || {}).step;
    const progress = total > 1 ? `${done} of ${total}` : step || "working";
    return html`<li><a href="${link}"><span class="act-title">${j.meta.title || j.kind}</span><span class="muted">${progress} · ${fmtElapsed(j.elapsed)}</span></a></li>`;
  })}</ul>`);
}

// ---------- find or add a company (top bar) ----------

const omni = { items: [], active: -1 };

function renderOmni() {
  const input = $("#omni-input");
  const q = input.value.trim();
  const lower = q.toLowerCase();
  const matches = q ? state.companies.filter((r) => `${r.name} ${r.business_id} ${r.municipality || ""}`.toLowerCase().includes(lower)).slice(0, 6) : [];
  omni.items = [...matches.map((r) => ({ open: r })), ...(q.length >= 2 ? [{ add: q }] : [])];
  omni.active = omni.items.length ? 0 : -1;
  const menu = $("#omni-menu");
  if (!omni.items.length) {
    menu.hidden = true;
    return;
  }
  mount(menu, omni.items.map((it, i) => (it.open
    ? html`<button type="button" class="omni-item ${i === omni.active ? "active" : ""}" data-omni="${i}" role="option">
        <span class="s-name">${it.open.name}</span>
        <span class="s-meta">${it.open.business_id}${it.open.municipality ? ` · ${titleCase(it.open.municipality)}` : ""} · ${STAGE_LABEL[it.open.stage] || ""}</span></button>`
    : html`<button type="button" class="omni-item add ${i === omni.active ? "active" : ""}" data-omni="${i}" role="option">
        <span class="s-name">+ Add “${it.add}”</span><span class="s-meta">Look it up in the trade register</span></button>`)));
  menu.hidden = false;
}

function chooseOmni(i) {
  const it = omni.items[i];
  if (!it) return;
  $("#omni-input").value = "";
  $("#omni-input").blur();
  closeMenus();
  if (it.open) location.hash = `#/c/${it.open.business_id}`;
  else startAdd([it.add]);
}

function closeMenus() {
  $("#omni-menu").hidden = true;
  $("#activity-menu").hidden = true;
  $("#activity-btn").setAttribute("aria-expanded", "false");
}

$("#omni-input").addEventListener("input", renderOmni);
$("#omni-input").addEventListener("focus", renderOmni);
$("#omni-input").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!omni.items.length) return;
    omni.active = (omni.active + (e.key === "ArrowDown" ? 1 : -1) + omni.items.length) % omni.items.length;
    $$(".omni-item").forEach((b, i) => b.classList.toggle("active", i === omni.active));
  } else if (e.key === "Enter") {
    e.preventDefault();
    chooseOmni(omni.active);
  } else if (e.key === "Escape") {
    closeMenus();
    e.target.blur();
  }
});
$("#omni").addEventListener("submit", (e) => e.preventDefault());

$("#activity-btn").addEventListener("click", () => {
  const menu = $("#activity-menu");
  menu.hidden = !menu.hidden;
  $("#activity-btn").setAttribute("aria-expanded", String(!menu.hidden));
});

// ---------- global events ----------

document.addEventListener("click", async (e) => {
  const omniItem = e.target.closest("[data-omni]");
  if (omniItem) {
    chooseOmni(Number(omniItem.dataset.omni));
    return;
  }
  if (!e.target.closest("#omni")) $("#omni-menu").hidden = true;
  if (!e.target.closest(".activity")) $("#activity-menu").hidden = true;
  if (e.target.closest("#activity-menu a")) closeMenus();
  const citeBtn = e.target.closest(".cite");
  if (citeBtn) {
    showFact(citeBtn);
    return;
  }
  if (!e.target.closest("#cite-pop")) hidePop();
  const copyBtn = e.target.closest("[data-copy]");
  if (copyBtn) {
    try {
      await navigator.clipboard.writeText(copyBtn.dataset.copy);
      copyBtn.classList.add("copied");
      setTimeout(() => copyBtn.classList.remove("copied"), 1200);
    } catch { /* clipboard blocked */ }
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    hidePop();
    closeMenus();
  }
  const typing = e.target.closest && e.target.closest("input, textarea, select, [contenteditable]");
  if (e.key === "/" && !typing) { // "/" jumps to the search box
    e.preventDefault();
    $("#omni-input").focus();
  }
});
window.addEventListener("scroll", hidePop, { passive: true });

// ---------- start ----------

(async function start() {
  state.showEvidence = pref.get("evidence", true);
  try { state.ai = await api("/api/ai/status"); } catch { state.ai = { configured: false }; }
  await Promise.all([loadCompanies(), refreshActivity()]);
  route();
})();
