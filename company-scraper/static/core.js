"use strict";

/* Company Scraper UI – shared helpers, state and building blocks.
   Everything scraped from websites is untrusted: it is only ever inserted
   through html`` (escaped) and safeUrl(). */

// ---------- DOM and safe HTML ----------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

class Html { constructor(s) { this.s = s; } toString() { return this.s; } }
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ESC[c]);
function part(v) {
  if (v instanceof Html) return v.s;
  if (Array.isArray(v)) return v.map(part).join("");
  if (v === null || v === undefined || v === false) return "";
  return esc(v);
}
function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += part(v) + strings[i + 1]; });
  return new Html(out);
}
const mount = (el, content) => { el.innerHTML = part(content); };
const setHtml = (id, content) => {
  const el = document.getElementById(id);
  if (el) mount(el, content);
};

function safeUrl(u, schemes = ["http:", "https:"]) {
  if (!u) return null;
  for (const candidate of [u, `https://${u}`]) {
    try {
      const x = new URL(candidate);
      if (schemes.includes(x.protocol) && (x.protocol !== "https:" && x.protocol !== "http:" || x.hostname.includes("."))) return x.href;
    } catch { /* try next */ }
  }
  return null;
}
function extLink(u, text) {
  const href = safeUrl(u);
  return href ? html`<a href="${href}" target="_blank" rel="noopener noreferrer">${text ?? u}</a>` : html`${text ?? u}`;
}

const ICON = {
  check: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  copy: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M10.5 5V3.5A1.5 1.5 0 009 2H3.5A1.5 1.5 0 002 3.5V9a1.5 1.5 0 001.5 1.5H5"/></svg>`,
  spinner: html`<span class="spinner" aria-hidden="true"></span>`,
};

// ---------- formatting ----------

const nf0 = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
const MINUS = "−";
const sign = (v) => (v < 0 ? MINUS : "");
const eur = (v) => (v == null ? "–" : `${sign(v)}€${nf0.format(Math.abs(v))}`);
function eurCompact(v) {
  if (v == null) return "–";
  const a = Math.abs(v);
  if (a >= 1e6) return `${sign(v)}€${(a / 1e6).toFixed(a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e3) return `${sign(v)}€${Math.round(a / 1e3)}k`;
  return `${sign(v)}€${Math.round(a)}`;
}
const pct = (v) => (v == null ? "–" : `${sign(v)}${Math.abs(v).toFixed(1)}%`);
const signed = (v, unit = "%") => (v == null ? "–" : `${v > 0 ? "+" : v < 0 ? MINUS : "±"}${Math.abs(v).toFixed(1)}${unit}`);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  return m ? `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}` : "–";
}
function fmtDateTime(iso) {
  const m = /T(\d{2}:\d{2})/.exec(iso || "");
  return iso ? `${fmtDate(iso)}${m ? ` at ${m[1]}` : ""}` : "–";
}
function fmtElapsed(s) {
  s = Math.round(s || 0);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}
const titleCase = (s) => (s || "").toLowerCase().replace(/(^|[\s-])\p{L}/gu, (c) => c.toUpperCase());
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");
const noCitations = (t) => (t || "").replace(/\s*\[F\d+\]/g, "");

// ---------- state ----------

const state = {
  ai: { configured: false },
  companies: [],          // every saved company, with its place in the workflow
  activity: [],           // tasks running on the server
  route: { view: "pipeline" },
  showEvidence: true,
  bid: null,              // the open company
  tab: "research",        // the open step of the workflow
  from: null,             // the seller this company was opened from, as a buyer
  profile: null,          // the open company's profile
  analysis: {},           // business ID -> analysis job in progress
  chats: {},              // business ID -> questions and answers
  autoAnalyze: new Set(), // business IDs to analyze once they open
  lastImport: null,       // the last finished import, for its summary
};

const pref = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`cs.${key}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`cs.${key}`, JSON.stringify(value)); } catch { /* storage blocked */ }
  },
};

// ---------- server ----------

async function api(path, opts = {}) {
  let r;
  try {
    r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  } catch (e) {
    setConnected(false);
    throw new Error("The app server is not reachable.");
  }
  setConnected(true);
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    try { msg = (await r.json()).error || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
  return r.json();
}
const setConnected = (ok) => { $("#conn-banner").hidden = ok; };

function poll(slot, id, onUpdate) {
  let failures = 0;
  const tick = async () => {
    if (slot.jobId !== id) return;
    let job;
    try {
      job = await api(`/api/jobs/${id}`);
      failures = 0;
    } catch (e) {
      failures += 1;
      if (/404/.test(e.message)) { slot.jobId = null; onUpdate(null); return; } // server restarted
      slot.timer = setTimeout(tick, Math.min(5000, 1000 * failures));
      return;
    }
    if (slot.jobId !== id) return;
    onUpdate(job);
    if (job.status === "running") slot.timer = setTimeout(tick, 700);
  };
  slot.timer = setTimeout(tick, 300);
}

async function loadCompanies() {
  try { state.companies = await api("/api/companies"); } catch { /* keep the last list */ }
  return state.companies;
}
const companyRow = (bid) => state.companies.find((r) => r.business_id === bid);
const jobsFor = (bid) => state.activity.filter((j) => j.meta && j.meta.bid === bid);

// ---------- building blocks ----------

const badge = (kind, text) => html`<span class="badge ${kind}">${text}</span>`;
const card = (title, body, sub) => html`<section class="card">
  <div class="card-head"><h2>${title}</h2>${sub ? html`<span class="card-sub">${sub}</span>` : ""}</div>${body}</section>`;

function notice(kind, title, body) {
  return html`<section class="card notice ${kind}" role="status">
    <span class="notice-icon" aria-hidden="true">${kind === "error" ? "!" : "i"}</span>
    <div><h2>${title}</h2><p>${body}</p></div>
  </section>`;
}

function renderSteps(lines, running) {
  const steps = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("→")) steps.push({ title: t.slice(1).trim(), details: [] });
    else if (steps.length) steps[steps.length - 1].details.push(t);
  }
  if (!steps.length) steps.push({ title: "Starting…", details: [] });
  return html`<ol class="steps">${steps.map((s, i) => {
    const active = running && i === steps.length - 1;
    return html`<li class="${active ? "active" : "done"}">
      <span class="step-icon">${active ? ICON.spinner : ICON.check}</span>
      <div><div class="step-title">${s.title}</div>
        ${s.details.map((d) => html`<div class="step-detail ${d.startsWith("!") ? "warn" : ""}">${d.replace(/^!\s*/, "")}</div>`)}
      </div></li>`;
  })}</ol>`;
}

const HEALTH = { strong: "good", stable: "", weak: "warn", critical: "bad", unknown: "" };
const SALE = { high: "acc", medium: "", low: "", unknown: "" };
const RELATION = {
  competitor: "Competitor", customer: "Customer", supplier: "Supplier",
  adjacent: "Adjacent business", consolidator: "Consolidator",
};

// ---------- citations: [F12] in Claude's text -> a button that shows the fact ----------

function cited(text, scope, facts) {
  const out = [];
  let last = 0;
  for (const m of (text || "").matchAll(/\[(F\d+)\]/g)) {
    out.push(text.slice(last, m.index));
    const known = !facts || facts[m[1]];
    if (known) out.push(html`<button type="button" class="cite" data-scope="${scope}" data-fact="${m[1]}" aria-label="Source ${m[1]}" ${facts ? "" : "disabled"}>${m[1].slice(1)}</button>`);
    last = m.index + m[0].length;
  }
  out.push((text || "").slice(last));
  return out;
}

// Plain text from Claude: "- " lines become a list, other lines paragraphs.
function richText(text, scope, facts) {
  const blocks = [];
  for (const line of (text || "").split(/\n+/)) {
    const t = line.trim();
    if (!t) continue;
    const bullet = /^[-*•]\s+/.test(t);
    const body = cited(t.replace(/^[-*•]\s+/, ""), scope, facts);
    if (bullet) {
      if (!blocks.length || blocks[blocks.length - 1].list !== true) blocks.push({ list: true, items: [] });
      blocks[blocks.length - 1].items.push(body);
    } else {
      blocks.push({ list: false, body });
    }
  }
  return blocks.map((b) => (b.list ? html`<ul>${b.items.map((i) => html`<li>${i}</li>`)}</ul>` : html`<p>${b.body}</p>`));
}

const factMap = (facts) => Object.fromEntries((facts || []).map((f) => [f.id, f]));

function factFor(el) {
  const scope = el.dataset.scope;
  if (scope === "analysis") return factMap(state.profile && state.profile.ai_analysis && state.profile.ai_analysis.facts)[el.dataset.fact];
  if (scope === "brief") return factMap(cmp.data && cmp.data.brief && cmp.data.brief.facts)[el.dataset.fact];
  const turn = (state.chats[state.bid] || [])[Number(scope.slice(4))];
  return turn && turn.facts ? turn.facts[el.dataset.fact] : null;
}

function factValue(f) {
  if (typeof f.value === "number") {
    if (/%/.test(f.field)) return pct(f.value);
    return f.section === "Financials" ? eur(f.value) : String(f.value);
  }
  const v = String(f.value ?? "–");
  return v.length > 400 ? `${v.slice(0, 400)}…` : v;
}

function showFact(btn) {
  const f = factFor(btn);
  const pop = $("#cite-pop");
  if (!f) return;
  mount(pop, html`<div class="pop-head"><span class="pop-id">${f.id}</span> ${f.section}</div>
    <div class="pop-field">${f.field}</div>
    <div class="pop-value">${factValue(f)}</div>
    ${f.evidence && f.evidence !== f.value ? html`<div class="pop-ev">${f.evidence}</div>` : ""}
    <div class="pop-src">${f.url ? extLink(f.url, f.source) : f.source}${f.retrieved_at ? html` <span class="muted">· fetched ${fmtDateTime(f.retrieved_at)}</span>` : ""}</div>`);
  pop.hidden = false;
  const r = btn.getBoundingClientRect();
  const w = Math.min(380, window.innerWidth - 24);
  pop.style.width = `${w}px`;
  pop.style.left = `${Math.min(Math.max(12, r.left - 24), window.innerWidth - w - 12)}px`;
  let top = r.bottom + 8;
  if (top + pop.offsetHeight > window.innerHeight - 12) top = r.top - pop.offsetHeight - 8;
  pop.style.top = `${Math.max(12, top)}px`;
}
const hidePop = () => { $("#cite-pop").hidden = true; };

// ---------- evidence: where each fact comes from ----------

function highlight(text, needle) {
  const i = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (i < 0) return text;
  return html`${text.slice(0, i)}<mark>${text.slice(i, i + needle.length)}</mark>${text.slice(i + needle.length)}`;
}
const quote = (snippet, needle) => (snippet ? html`<q class="ev-quote">${highlight(snippet, needle)}</q>` : "");

function pageLink(url) {
  const href = safeUrl(url);
  if (!href) return url || "";
  const u = new URL(href);
  let path = u.pathname;
  try { path = decodeURI(path); } catch { /* keep it encoded */ }
  const label = path === "/" || path === "" ? `${u.hostname.replace(/^www\./, "")} (home page)` : path.replace(/\/$/, "");
  return html`<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
}
const pageLinks = (urls) => (urls || []).map((u, i) => html`${i ? ", " : ""}${pageLink(u)}`);

const FOUND_IN = { "page text": "Text on", "email link": "Email link on", "phone link": "Phone link on", link: "Link on" };
function findingEv(e) {
  if (!e) return "";
  const body = e.found_in === "page text" ? quote(e.snippet, e.matched) : e.snippet ? html` · ${e.snippet}` : "";
  return html`<div class="ev">${FOUND_IN[e.found_in] || "Found on"} ${pageLink(e.page)}${body}</div>`;
}
const evBanner = (body) => html`<div class="ev ev-banner"><span class="ev-label">Evidence</span><div>${body}</div></div>`;
const fetched = (iso) => `Fetched ${fmtDateTime(iso)}.`;

const SIGNALS = {
  family_business: "Family business",
  multi_generation: "Multi-generation",
  hiring: "Hiring",
  growth_or_expansion: "Growth / expansion",
  succession_or_sale: "Succession / sale",
  certifications: "Certifications",
};
