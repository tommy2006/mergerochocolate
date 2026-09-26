// Research step: map the company's own site, pull filed accounts from open registries, sweep the wider web,
// read one annual-report PDF, and keep only facts that carry a source. Also: watch mode (re-crawl + diff → alerts).
import crypto from "node:crypto";
import { crawlSite, readPages, categorize, USER_AGENT } from "./crawl.js";
import { fetchFinancials, fxToEur } from "../financials.js";
import * as agents from "../agents.js";
import * as llm from "../llm.js";
import { pdfText, statementWindow } from "./pdf.js";
import { ocrPdf, ocrAvailable } from "./ocr.js";

const MAX_PDF_BYTES = 15 * 1024 * 1024;
const MAX_PDF_PAGES = 80;
const SNAPSHOT_URLS = 800;
const now = () => new Date().toISOString();
const uid = () => `a_${crypto.randomBytes(4).toString("hex")}`;
const yearIn = (s) => Number((String(s || "").match(/20\d{2}/g) || []).pop()) || null;

async function downloadPdf(url, timeoutMs = 30000) {
  // Brønnøysund answers 406 to a bare "application/pdf" Accept header; the q-ranked form is accepted everywhere.
  // Its PDF service also answers 503 now and then: three attempts, 4 s apart.
  let res;
  for (let attempt = 1; ; attempt++) {
    res = await fetch(url, { headers: { "user-agent": USER_AGENT, accept: "application/pdf, */*;q=0.8" }, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    if (res.ok || attempt >= 3 || !(res.status >= 500 || res.status === 429)) break;
    await new Promise((r) => setTimeout(r, 4000));
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (Number(res.headers.get("content-length") || 0) > MAX_PDF_BYTES) throw new Error("larger than 15 MB");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_PDF_BYTES) throw new Error("larger than 15 MB");
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("not a PDF");
  const pages = (buf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
  if (pages > MAX_PDF_PAGES) throw new Error(`${pages} pages, limit ${MAX_PDF_PAGES}`);
  return buf;
}

// ---- financial rows from the PDF reader and from published mentions, in the registry row shape ----
async function toRow(year, currency, v, source, url, confidence) {
  const cur = (currency || "EUR").toUpperCase();
  const fx = await fxToEur(cur); // null for a currency with no ECB rate → leave EUR fields empty
  const e = (n) => (n == null || fx == null ? null : Math.round(n * fx));
  const ebitda = v.ebitda ?? (v.ebit != null && v.depreciation != null ? v.ebit + Math.abs(v.depreciation) : null);
  return {
    year, period_start: null, period_end: null, currency: cur,
    revenue: v.revenue ?? null, gross_profit: null, ebit: v.ebit ?? null, depreciation: v.depreciation ?? null, ebitda, net_income: v.net_income ?? null,
    total_assets: null, equity: null, employees: v.employees ?? null,
    revenue_eur: e(v.revenue), gross_profit_eur: null, ebit_eur: e(v.ebit), ebitda_eur: e(ebitda), net_income_eur: e(v.net_income), fx_to_eur: fx,
    ebitda_basis: v.ebitda != null ? "reported" : ebitda != null ? "derived" : null,
    source, url, confidence,
  };
}
const reportRows = (rep, url) => Promise.all(rep.years.map((y) => toRow(y.year, rep.currency, y, "Annual report PDF", url, "high")));
async function mentionRows(mentions) {
  const byYear = new Map();
  for (const m of mentions) {
    const k = `${m.year}|${m.url}`;
    const r = byYear.get(k) || { year: m.year, url: m.url, currency: m.currency || "EUR", v: {} };
    if (m.metric === "employees") r.v.employees = m.value; else { r.v[m.metric] = m.value; if (m.currency) r.currency = m.currency; }
    byYear.set(k, r);
  }
  return Promise.all([...byYear.values()].map((r) => toRow(r.year, r.currency, r.v, "Published figure (press/directory)", r.url, "medium")));
}
// One row per year: registry beats report PDF beats published mentions; later sources only fill gaps.
function mergeRows(...lists) {
  const byYear = new Map();
  for (const list of lists) for (const r of list) {
    const cur = byYear.get(r.year);
    if (!cur) { byYear.set(r.year, { ...r }); continue; }
    for (const k of ["revenue", "ebit", "ebitda", "net_income", "employees", "revenue_eur", "ebit_eur", "ebitda_eur", "net_income_eur"]) {
      if (cur[k] == null && r[k] != null) { cur[k] = r[k]; cur.also_from = [...new Set([...(cur.also_from || []), r.source])]; }
    }
    if (!cur.ebitda_basis && r.ebitda_basis) cur.ebitda_basis = r.ebitda_basis;
  }
  return [...byYear.values()].sort((a, b) => b.year - a.year);
}
const fmtM = (n) => `€${(n / 1e6).toFixed(1)}M`;
function dbConflicts(company, rows) {
  const out = [];
  const pick = (k) => rows.find((r) => r[k] != null && r.confidence === "high") || rows.find((r) => r[k] != null);
  const cmp = (label, db, row, k, fmt = fmtM) => {
    if (db == null || !row) return;
    const diff = Math.abs(row[k] - db) / Math.max(Math.abs(db), 1);
    if (diff > 0.25) out.push(`${label}: database ${fmt(db)} vs ${fmt(row[k])} in ${row.year} (${row.source}), ${Math.round(diff * 100)}% apart`);
  };
  cmp("Revenue", company.revenue_eur, pick("revenue_eur"), "revenue_eur");
  cmp("EBITDA", company.ebitda_eur, pick("ebitda_eur"), "ebitda_eur");
  cmp("Employees", company.employees, pick("employees"), "employees", (n) => String(n));
  return out;
}
const slimOrg = (o) => (o ? Object.fromEntries(["name", "legalName", "url", "description", "foundingDate", "founders", "numberOfEmployees", "address", "areaServed", "sameAs", "vatID", "taxID"]
  .filter((k) => o[k] != null && o[k] !== "" && !(Array.isArray(o[k]) && !o[k].length)).map((k) => [k, o[k]])) : null);

// ---- the research step ----
// quick: the buy-side screen's "dig deeper" (10 pages, 30 s crawl budget, no web sweep), about a minute end to end.
// On Vercel a function gets 60 s in total, so the crawl is shorter there and the statement PDF is left out.
const ON_VERCEL = Boolean(process.env.VERCEL);
const QUICK_CRAWL = ON_VERCEL ? { maxPages: 6, budgetMs: 14000, delayMs: 150, render: "off" } : { maxPages: 10, budgetMs: 30000, delayMs: 250, render: "off" };
export async function research(company, settings, { log = () => {}, quick = false } = {}) {
  const t0 = Date.now();
  const warnings = [];
  const crawl = company.website ? await crawlSite(company.website, { log, ...(quick ? QUICK_CRAWL : {}) }) : null;
  if (!crawl) warnings.push("No website on record, so the site crawl was skipped.");
  else if (!crawl.ok) warnings.push(`Site crawl failed: ${crawl.error}`);
  const pages = crawl?.ok ? crawl.pages : [];

  const [fin, site, web] = await Promise.all([
    fetchFinancials(company, { businessIds: crawl?.business_ids || [], log })
      .catch((e) => ({ identifier: null, rows: [], documents: [], notes: [`Registry lookup failed: ${e.message}`], checked: [] })),
    agents.extractPageFacts(company, pages, settings)
      .catch((e) => { warnings.push(`Fact extraction from site pages failed: ${e.message}`); return { facts: [], dropped: 0 }; }),
    quick ? Promise.resolve({ facts: [], financial_mentions: [], report_pdfs: [], dropped: 0, sources: 0, skipped: true }) : agents.researchOffsite(company, crawl, settings)
      .catch((e) => { warnings.push(`Web search step failed: ${e.message}`); return { facts: [], financial_mentions: [], report_pdfs: [], dropped: 0, sources: 0 }; }),
  ]);

  // At most one statement/annual-report PDF per run. First choice: the statement of the latest filed year when the
  // open register has EBIT but no depreciation line (Norway), because that is the only free path to EBITDA.
  // Otherwise (full mode only): a report that adds a year the registries do not cover.
  let fromReport = [], reportDoc = null;
  const have = new Set(fin.rows.map((r) => r.year));
  const latest = fin.rows.find((r) => r.ebit != null) || null;
  const needEbitda = Boolean(latest && latest.ebitda == null);
  const candidates = [
    ...fin.documents.filter((d) => d.format === "pdf"),
    ...(crawl?.documents || []).filter((d) => d.category === "reports").sort((a, b) => (b.year || 0) - (a.year || 0)),
    ...web.report_pdfs.map((url) => ({ url, year: yearIn(url) })),
  ].filter((d) => !d.year || d.year >= new Date().getFullYear() - 4);
  const pick = quick && ON_VERCEL ? null : (needEbitda && candidates.find((d) => d.year === latest.year)) || (quick ? null : candidates.find((d) => !d.year || !have.has(d.year)));
  if (pick) {
    try {
      const rep = await readReport(company, pick.url, settings, { log });
      if (rep.is_this_company) {
        fromReport = reconcileRows(await reportRows(rep, pick.url), fin.rows, warnings);
        reportDoc = { type: "annual_report", year: pick.year || fromReport[0]?.year || null, format: "pdf", url: pick.url, source: `Read from PDF (${rep.how})` };
      } else warnings.push(`Report PDF ${pick.url} is for ${rep.entity_name}, so it was ignored.`);
    } catch (e) { warnings.push(`Statement PDF skipped (${e.message}): ${pick.url}`); }
  }
  const rows = mergeRows(fin.rows, fromReport, await mentionRows(web.financial_mentions));
  const facts = [...site.facts, ...web.facts].map((f, i) => ({ id: `f${i + 1}`, ...f }));

  return {
    status: "done",
    mode: quick ? "quick" : "full",
    ran_at: now(),
    duration_ms: Date.now() - t0,
    site: crawl ? {
      ok: crawl.ok, error: crawl.error, root: crawl.root, languages: crawl.languages || [],
      pages_found: crawl.inventory?.total || 0, pages_read: pages.length, by_category: crawl.inventory?.by_category || {},
      js_only: crawl.js_only, rendered_with: crawl.rendered_with, robots_blocked: Boolean(crawl.robots?.blocked),
      jsonld_org: slimOrg(crawl.jsonld?.organization), social: crawl.social || {}, business_ids: crawl.business_ids || [],
    } : null,
    pages: pages.map(({ url, category, title, lang, words, hash, rendered }) => ({ url, category, title, lang, words, hash, rendered })),
    facts,
    financials: {
      identifier: fin.identifier, rows, notes: fin.notes, checked: fin.checked,
      documents: [...fin.documents, ...(reportDoc ? [reportDoc] : [])],
      conflicts: dbConflicts(company, rows),
    },
    stats: { facts: facts.length, site_facts: site.facts.length, web_facts: web.facts.length, dropped_unverified: (site.dropped || 0) + (web.dropped || 0), web_sources: web.sources || 0 },
    warnings: [...(crawl?.warnings || []), ...warnings],
    snapshot: { at: now(), urls: (crawl?.inventory?.urls || []).slice(0, SNAPSHOT_URLS), hashes: Object.fromEntries(pages.map((p) => [p.url, p.hash])) },
  };
}

// Reads one statement/report PDF: the text layer first (works on every model provider), Claude's document reader for scans.
async function readReport(company, url, settings, { log = () => {} } = {}) {
  const buf = await downloadPdf(url);
  let text = "", how = "text";
  try { text = statementWindow((await pdfText(buf)).text); } catch (e) { log(`pdf text layer failed (${e.message})`); }
  if (text.length < 600 && ocrAvailable().ok) {
    // A scan: OCR on this machine, then the same text reader on the Verda model. Nothing leaves the server.
    try { const o = await ocrPdf(buf, { country: company.country, log }); text = statementWindow(o.text); how = "ocr"; }
    catch (e) { log(`ocr failed (${e.message})`); text = ""; }
  }
  if (text.length >= 600) {
    log(`statement PDF ${url}: ${text.length} chars (${how}) → model`);
    return { ...(await agents.readAnnualReportText(company, text, url, settings, { ocr: how === "ocr" })), how };
  }
  if (llm.provider(settings) === "verda" && !llm.fallbackAllowed(settings)) {
    throw new Error(`scanned PDF: ${ocrAvailable().ok ? "OCR found no readable text" : ocrAvailable().reason}; Claude's document reader is off in strict EU-only mode`);
  }
  log(`statement PDF ${url}: no text layer → document reader`);
  return { ...(await agents.readAnnualReport(company, buf, url, settings)), how: "document" };
}

// Statement readers (text layer, OCR, vision) get two things wrong: the unit ("tall i 1000") and a column. The
// register's high-confidence row for a shared year anchors the unit (whole units, thousands, millions); after that,
// every year the register also covers must agree on EBIT, or the whole reading is discarded.
const fmtInt = (n) => (n == null ? "n/a" : Math.round(n).toLocaleString("en"));
export function reconcileRows(rows, registryRows, warnings, label = "Statement PDF") {
  const reg = (y) => registryRows.find((x) => x.year === y && x.confidence === "high" && !/Read from PDF/.test(x.source || ""));
  const anchor = rows.map((r) => ({ r, g: reg(r.year) })).find(({ r, g }) => g && ((r.revenue && g.revenue) || (r.ebit && g.ebit)));
  const UNITS = [1, 1000, 1e6, 0.001, 1e-6];
  const unitOf = (mine, theirs) => (mine && theirs ? UNITS.find((k) => Math.abs(theirs / mine / k - 1) <= 0.05) ?? null : null);
  let scale = 1, dropRevenue = false;
  if (anchor) {
    const { r, g } = anchor;
    // Revenue anchors the unit; when a digit was misread there, EBIT may still anchor it (the misread revenue is then dropped).
    scale = unitOf(r.revenue, g.revenue);
    if (scale == null && unitOf(r.ebit, g.ebit) != null) { scale = unitOf(r.ebit, g.ebit); dropRevenue = Boolean(r.revenue && g.revenue); }
    if (scale == null) {
      const byRevenue = Boolean(r.revenue && g.revenue);
      warnings.push(`${label} ${r.year}: ${byRevenue ? "revenue" : "EBIT"} ${fmtInt(byRevenue ? r.revenue : r.ebit)} does not match the register's ${fmtInt(byRevenue ? g.revenue : g.ebit)} at any unit, so the reading was ignored`);
      return [];
    }
    if (dropRevenue) warnings.push(`${label} ${r.year}: revenue ${fmtInt(r.revenue)} was misread (register: ${fmtInt(g.revenue)}); EBIT and depreciation kept, revenue taken from the register`);
  }
  const out = rows.map((r) => {
    if (scale === 1 && !dropRevenue) return r;
    const x = { ...r, unit_scale: scale };
    if (dropRevenue) { x.revenue = null; x.revenue_eur = null; }
    for (const k of ["revenue", "gross_profit", "ebit", "depreciation", "ebitda", "net_income", "total_assets", "equity"]) if (x[k] != null) x[k] = Math.round(x[k] * scale);
    for (const k of ["revenue", "gross_profit", "ebit", "ebitda", "net_income"]) x[`${k}_eur`] = x[k] == null || x.fx_to_eur == null ? null : Math.round(x[k] * x.fx_to_eur);
    return x;
  });
  for (const r of out) {
    const g = reg(r.year);
    if (!g || r.ebit == null || g.ebit == null) continue;
    const tolerance = Math.max(0.05 * Math.abs(g.ebit), 0.002 * Math.abs(g.revenue || 0), 1);
    if (Math.abs(r.ebit - g.ebit) > tolerance) {
      warnings.push(`${label} ${r.year}: EBIT ${fmtInt(r.ebit)} does not match the register's ${fmtInt(g.ebit)}, so the reading was ignored`);
      return [];
    }
  }
  return out;
}

// Filed accounts fill blanks in the prospect record; they never overwrite database figures (conflicts are flagged instead).
export function applyFinancials(c) {
  const r = c.research || {};
  const row = (r.financials?.rows || []).find((x) => x.confidence === "high");
  const filled = [];
  if (row) {
    if (c.revenue_eur == null && row.revenue_eur != null) { c.revenue_eur = row.revenue_eur; filled.push(`revenue ${row.year} (${row.source})`); }
    if (c.ebitda_eur == null && row.ebitda_eur != null) { c.ebitda_eur = row.ebitda_eur; filled.push(`EBITDA ${row.year} (${row.ebitda_basis || "reported"})`); }
    if (c.employees == null && row.employees != null) { c.employees = row.employees; filled.push(`employees ${row.year}`); }
  }
  const id = r.financials?.identifier;
  if (!c.registry_id && id?.id && id.country === c.country) { c.registry_id = id.id; filled.push(`registry id ${id.id}`); }
  if (c.research) r.filled_fields = filled;
  return filled;
}

// The statement PDF for a filed year: the one the registry listed, else (Norway) the register's free copy by
// organisation number, which exists for every filed year even when an earlier lookup stored no document list.
function statementDoc(company, fin, year) {
  const listed = (fin.documents || []).find((d) => d.format === "pdf" && d.year === year);
  if (listed) return listed;
  const org = String(company.registry_id || fin.identifier?.id || "").replace(/\s/g, "");
  if (String(company.country || "").toUpperCase() === "NO" && /^\d{9}$/.test(org)) {
    return { type: "annual_report", year, format: "pdf", url: `https://data.brreg.no/regnskapsregisteret/regnskap/aarsregnskap/kopi/${org}/${year}`, source: "Brønnøysund Regnskapsregisteret (NO)" };
  }
  return null;
}
// Research already done, but the latest filed year still lacks EBITDA and its statement PDF is available and unread.
// The latest year with an operating result (a newer row may hold only a headcount from a directory).
const latestOperating = (fin) => (fin?.rows || []).find((x) => x.ebit != null) || null;
export function needsStatement(c) {
  const fin = c.research?.financials; const latest = latestOperating(fin);
  if (!latest || latest.ebitda_eur != null) return false;
  return Boolean(statementDoc(c, fin, latest.year)) && !(fin.documents || []).some((d) => d.year === latest.year && /Read from PDF/.test(d.source || ""));
}
export async function addStatement(company, settings, { log = () => {} } = {}) {
  const fin = company.research?.financials; const latest = latestOperating(fin);
  const doc = latest && statementDoc(company, fin, latest.year);
  if (!doc) return null;
  const rep = await readReport(company, doc.url, settings, { log });
  if (!rep.is_this_company) throw new Error(`PDF belongs to ${rep.entity_name || "another entity"}`);
  const warnings = [];
  const rows = reconcileRows(await reportRows(rep, doc.url), fin.rows, warnings);
  if (!rows.length) throw new Error(warnings[0] || "the statement had no usable income-statement figures");
  fin.rows = mergeRows(fin.rows, rows);
  fin.documents = [...(fin.documents || []), { type: "annual_report", year: doc.year, format: "pdf", url: doc.url, source: `Read from PDF (${rep.how})` }];
  fin.conflicts = dbConflicts(company, fin.rows);
  const filled = applyFinancials(company);
  return { year: doc.year, how: rep.how, rows: rows.length, filled: filled.join(", ") || "no new figures", warnings };
}
// The registry lookup failed earlier (a 503, a timeout): fetch the filed accounts again and merge them in front.
export async function refreshFinancials(company, { log = () => {} } = {}) {
  const r = company.research; if (!r) return null;
  const fin = await fetchFinancials(company, { businessIds: r.site?.business_ids || [], log });
  const prev = r.financials || { rows: [], documents: [], notes: [], checked: [] };
  r.financials = {
    ...prev, identifier: fin.identifier || prev.identifier, rows: mergeRows(fin.rows, prev.rows || []), notes: fin.notes, checked: fin.checked,
    documents: [...fin.documents, ...(prev.documents || []).filter((d) => !fin.documents.some((x) => x.url === d.url))],
  };
  r.financials.conflicts = dbConflicts(company, r.financials.rows);
  return { rows: fin.rows.length, filled: applyFinancials(company) };
}

// ---- watch mode: what changed on the site since the last snapshot? ----
const SIGNALS = [
  ["leadership_change", /\b(ceo|managing director|toimitusjohtaja|verkställande direktör|vd\b|administrerende direktør|daglig leder|geschäftsführer|new (chief|head))/i],
  ["acquisition", /(acqui|merger|yrityskaup|förvärv|oppkjøp|opkøb|übernahme|fusion)/i],
  ["ownership", /(ownership|private equity|investor|pääomasijoit|omistaj|ägar|eier|ejer|eigentümer|beteiligung)/i],
  ["expansion", /(new (office|site|plant|factory|location)|expan|laajen|utvid|udvid|erweiter|eröffn|opens? )/i],
  ["financial_report", /(annual report|results|tilinpäätös|vuosikertomus|liikevaihto|årsredovisning|årsrapport|geschäftsbericht|umsatz)/i],
  ["hiring", /(recruit|hiring|vacanc|rekry|työpaik|lediga jobb|stilling|stellenangebot|careers?\/)/i],
];
const signalOf = (text) => (SIGNALS.find(([, re]) => re.test(text)) || [null])[0];
const WATCHED = new Set(["news", "careers", "reports", "direction", "offering", "footprint", "people", "customers"]);
const ALERT_CATEGORIES = new Set(["events", "direction", "people", "ownership", "footprint", "financials", "customers"]);

export async function watch(company, settings, { log = () => {} } = {}) {
  const r = company.research;
  if (!r?.snapshot || !company.website) throw Object.assign(new Error("Run research on this company first."), { status: 400 });
  const crawl = await crawlSite(company.website, { log });
  const at = now();
  if (!crawl.ok) return { checked_at: at, error: crawl.error, alerts: [] };
  const prevUrls = new Set(r.snapshot.urls || []);
  const prevHashes = r.snapshot.hashes || {};
  const newUrls = crawl.inventory.urls.filter((u) => !prevUrls.has(u)).map((u) => ({ url: u, category: categorize(u) })).filter((x) => WATCHED.has(x.category));
  const changed = crawl.pages.filter((p) => prevHashes[p.url] && prevHashes[p.url] !== p.hash && p.category !== "home");
  // The crawl's quotas may not pick the new URLs, so read up to 6 of them directly.
  const unread = newUrls.map((x) => x.url).filter((u) => !crawl.pages.some((p) => p.url === u)).slice(0, 6);
  const extra = unread.length ? await readPages(crawl.root, unread, { log }) : [];
  const fresh = [...crawl.pages.filter((p) => newUrls.some((x) => x.url === p.url)), ...extra];
  const toRead = [...fresh, ...changed].slice(0, 8);
  const { facts } = toRead.length ? await agents.extractPageFacts(company, toRead, settings) : { facts: [] };
  const known = new Set((r.facts || []).map((f) => agents.norm(f.quote)));
  const newFacts = facts.filter((f) => !known.has(agents.norm(f.quote)));

  const alerts = [
    ...newFacts.filter((f) => ALERT_CATEGORIES.has(f.category)).map((f) => ({ id: uid(), at, kind: "new_fact", category: f.category, signal: signalOf(`${f.claim} ${f.quote}`), title: f.claim, url: f.url })),
    ...newUrls.filter((x) => !newFacts.some((f) => f.url === x.url)).slice(0, 10).map((x) => ({ id: uid(), at, kind: "new_page", category: x.category, signal: signalOf(x.url), title: `New ${x.category} page`, url: x.url })),
    ...changed.filter((p) => !newFacts.some((f) => f.url === p.url)).slice(0, 5).map((p) => ({ id: uid(), at, kind: "changed_page", category: p.category, signal: signalOf(`${p.title} ${p.url}`), title: `${p.title || "Page"} changed`, url: p.url })),
  ];
  const newJobs = newUrls.filter((x) => x.category === "careers").length;
  if (newJobs >= 3) alerts.unshift({ id: uid(), at, kind: "hiring_spike", category: "careers", signal: "hiring", title: `${newJobs} new job pages since ${String(r.snapshot.at).slice(0, 10)}`, url: crawl.root });

  // Fold new facts into the dossier and move the baseline forward.
  const base = (r.facts || []).length;
  r.facts = [...(r.facts || []), ...newFacts.map((f, i) => ({ id: `f${base + i + 1}`, ...f, detected_at: at }))];
  r.snapshot = { at, urls: crawl.inventory.urls.slice(0, SNAPSHOT_URLS), hashes: { ...prevHashes, ...Object.fromEntries([...crawl.pages, ...extra].map((p) => [p.url, p.hash])) } };
  return { checked_at: at, new_urls: newUrls.length, changed_pages: changed.length, new_facts: newFacts.length, alerts };
}
