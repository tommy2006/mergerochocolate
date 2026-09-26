// "Dig deeper" on a screened company: read more of its website, pull the filed accounts (and the statement PDF when the
// open register has no depreciation line), name the customers. EBITDA, customers and offering then replace the
// "Pending" placeholders on the buy-side screen, each with its source. Bounded to about a minute for a new company.
import * as db from "../db.js";
import * as agents from "../agents.js";
import { research, applyFinancials, addStatement, needsStatement, refreshFinancials } from "../research/index.js";

// Sector words on a website or in a register's industry text → one of the desk's sector labels. Stems match
// "manufactures", "machinery", "recycling"; Norwegian, Swedish, Danish and Finnish words count too (Nordic sites).
export const SECTOR_RULES = [
  ["B2B SaaS & Digital Services", /\b(saas|software|cloud|platform|api|digital|programvar\w*|ohjelmisto\w*|mjukvar\w*|pilvipalvelu\w*)\b/i],
  ["Manufacturing & Industrial Automation", /\b(manufactur\w*|automation|machin\w*|factory|industrial|production|produksjon|produktion|tuotanto|valmist\w*|tillverk\w*|fabrikk\w*|maskin\w*|kone\w*|automasjon|automaatio)\b/i],
  ["Healthcare & Facility services", /\b(health\w*|clinic\w*|care|medical|rehab\w*|helse\w*|hälso\w*|terveys\w*|hoiva\w*|omsorg\w*|pleie\w*)\b/i],
  ["Circular economy / Waste logistics", /\b(recycl\w*|waste|circular|logistic\w*|gjenvinning|återvinning|kierrätys|avfall\w*|jäte\w*|logistikk?|logistiikka)\b/i],
  ["Industrial construction", /\b(construction|building|contractor\w*|steel|bygg\w*|rakenn\w*|entreprenør\w*|urakoi\w*|stål\w*|teräs\w*)\b/i],
  ["Food & Beverage", /\b(food|bakery|beverage\w*|drink\w*|næringsmiddel\w*|elintarvike\w*|livsmedel\w*|bakeri|leipomo|meieri|drikke\w*)\b/i],
];
export function sectorHint(text) {
  const t = String(text || "");
  return SECTOR_RULES.find(([, re]) => re.test(t))?.[0] || "";
}

const MAX_AGE_MS = Number(process.env.RESEARCH_MAX_AGE_DAYS || 7) * 864e5;
const fresh = (r) => Boolean(r?.ran_at && Date.now() - Date.parse(r.ran_at) < MAX_AGE_MS && ((r.facts || []).length || (r.financials?.rows || []).length));
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => { const t = setTimeout(() => rej(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms); t.unref?.(); })]);
const fmtM = (n) => `€${(Number(n) / 1e6).toFixed(1)}M`;
const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
const clipList = (items, n) => { const a = items.map((x) => clip(x, 80)).filter(Boolean); return a.slice(0, n).join(", ") + (a.length > n ? ` (+${a.length - n} more)` : ""); };
// Enrichment text cites fact ids "(f2, f6)"; the screen does not need them.
const uncite = (s) => String(s || "").replace(/\s*\((?:f\d+[,\s]*)+\)/g, "");
// Model and register errors, in words an advisor can act on.
function friendly(e) {
  const m = String(e?.message || e || "");
  if (/credit balance/i.test(m)) return "the statement is a scan and reading it needs Claude, whose account is out of credits";
  if (/document reader|strict EU-only/i.test(m)) return "the statement is a scan and reading it needs Claude's document reader (off in strict EU-only mode)";
  if (/No Anthropic API key/i.test(m)) return "the statement is a scan and reading it needs Claude (no Anthropic key configured)";
  if (/HTTP 5\d\d/.test(m)) return `the register's PDF service answered ${m.match(/HTTP 5\d\d/)[0]}, try again in a minute`;
  if (/HTTP 404/.test(m)) return "the register has no PDF copy for that year";
  return clip(m, 140);
}

export async function analyze(c, settings, { force = false, log = () => {} } = {}) {
  const t0 = Date.now();
  const steps = [], warnings = [];
  const had = fresh(c.research) && !force;
  if (!had) {
    c.research = await research(c, settings, { log, quick: true });
    steps.push(`website: ${c.research.site?.pages_read ?? 0} pages read, ${(c.research.facts || []).length} sourced facts`);
    steps.push(`registers: ${(c.research.financials?.rows || []).length} filed year(s)`);
    for (const d of c.research.financials?.documents || []) if (/Read from PDF/.test(d.source || "")) steps.push(`statement PDF ${d.year} read`);
    warnings.push(...(c.research.warnings || []));
  } else {
    steps.push(`website + registers: reused the research from ${String(c.research.ran_at).slice(0, 10)}`);
    if (!(c.research.financials?.rows || []).some((x) => x.confidence === "high")) {
      try { const r = await refreshFinancials(c, { log }); if (r) steps.push(`registers: looked up again, ${r.rows} filed year(s)`); }
      catch (e) { warnings.push(`Registers: ${e.message}`); }
    }
    // Statement PDFs (download + OCR + model) do not fit Vercel's 60 s function limit; the instance does them.
    if (!process.env.VERCEL && needsStatement(c)) {
      try { const r = await addStatement(c, settings, { log }); if (r) steps.push(`statement PDF ${r.year}: ${r.filled}`); }
      catch (e) { warnings.push(`Statement PDF not read: ${friendly(e)}`); }
    }
  }
  applyFinancials(c);
  // Finnish profiler (PRH register facts + XBRL line items) when the Python component is installed.
  if (c.country === "FI") {
    try {
      const son = await import("../adapters/son_scraper.js");
      if (son.available().ok) {
        const r = await withTimeout(son.enrichCompany(c, { timeoutMs: 60000 }), 70000, "Finnish profiler");
        if (r?.facts?.length) {
          c.research ||= { facts: [] }; c.research.facts ||= [];
          const known = new Set(c.research.facts.map((f) => f.claim)); let n = 0;
          for (const f of r.facts) if (!known.has(f.claim)) { c.research.facts.push(f); n++; }
          steps.push(`Finnish profiler: ${n} new facts`);
        } else if (r?.reason) steps.push(`Finnish profiler: ${r.reason}`);
        if (r?.financials) for (const k of ["revenue_eur", "ebitda_eur", "employees"]) if (c[k] == null && r.financials[k] != null) c[k] = r.financials[k];
      }
    } catch (e) { warnings.push(`Finnish profiler: ${e.message}`); }
  }
  // The profile step needs a model; when it is down the research above still stands and the screen says what is missing.
  if (force || !had || !c.enrichment?.research_based) {
    try {
      c.enrichment = await agents.runTracked(c.id, () => agents.enrich(c, settings), "enrich");
      db.advance(c, "enriched");
      steps.push(`profile: ${(c.enrichment.customers || []).length} customers named, ${(c.enrichment.products || []).length} product lines`);
    } catch (e) { warnings.unshift(`Customers and offering not extracted: ${friendly(e)}`); }
  } else steps.push("profile: reused");
  // What blocks EBITDA or customers comes first; crawl noise ("1 page not read") last.
  const weight = (w) => (/^Customers and offering/.test(w) ? 0 : /Statement PDF/.test(w) ? 1 : 2);
  warnings.sort((a, b) => weight(a) - weight(b));
  c.analysis = { ran_at: new Date().toISOString(), cached: had, duration_ms: Date.now() - t0, steps, warnings: warnings.slice(0, 6) };
  db.touch(c); db.save();
  return c.analysis;
}

// What the screen shows for EBITDA / customers / offering, with sources; safe on companies never analysed.
export function summary(c) {
  const r = c.research || {};
  const rows = r.financials?.rows || [];
  const e = c.enrichment || {};
  const latest = rows.find((x) => x.ebitda_eur != null) || rows.find((x) => x.ebit_eur != null) || rows[0] || null;
  const src = (row) => [row.source, ...(row.also_from || [])].filter(Boolean).join(" + ");
  const ebitda = c.ebitda_eur != null
    ? { value_eur: c.ebitda_eur, label: fmtM(c.ebitda_eur), detail: latest && latest.ebitda_eur != null ? `${latest.year}, ${latest.ebitda_basis === "derived" ? "EBIT + depreciation" : "as reported"}, ${src(latest)}` : "database figure" }
    : { value_eur: null, label: "Pending Audit", detail: latest?.ebit_eur != null
        ? `EBIT ${fmtM(latest.ebit_eur)}${latest.revenue_eur != null ? `, revenue ${fmtM(latest.revenue_eur)}` : ""} (${latest.year}, ${src(latest)}); depreciation is not in the open register, so EBITDA is not derivable yet`
        : rows.length ? `Latest figures ${rows[0].year} (${src(rows[0])}): no operating result published` : c.research ? "No filed accounts in the open registers (PRH iXBRL, Brønnøysund, CVR)" : "" };
  const customers = (e.customers || []).filter(Boolean);
  const segments = (e.customer_segments || []).map((s) => s.segment).filter(Boolean);
  const products = (e.products || []).filter(Boolean);
  return {
    ran_at: c.analysis?.ran_at || null, cached: Boolean(c.analysis?.cached), duration_ms: c.analysis?.duration_ms ?? null,
    steps: c.analysis?.steps || [], warnings: c.analysis?.warnings || [],
    pages_read: r.site?.pages_read ?? 0, facts: (r.facts || []).length,
    filed_years: rows.map((x) => x.year), sources: [...new Set(rows.flatMap((x) => [x.source, ...(x.also_from || [])]).filter(Boolean))],
    ebitda, revenue: c.revenue_eur != null ? { value_eur: c.revenue_eur, label: fmtM(c.revenue_eur) } : null, employees: c.employees ?? null,
    customers: { items: customers.slice(0, 6), segments: segments.slice(0, 4), source: customers.length || segments.length ? (e.research_based ? "company website + web research" : "model knowledge, unverified") : null },
    products: { items: products.slice(0, 6), summary: uncite(e.offering?.summary || "") },
  };
}

// Fields that replace the placeholders in a screen profile once something is known.
export function profileOverrides(c) {
  const s = summary(c);
  const out = { ebitda_detail: s.ebitda.detail || "", analysis: c.analysis ? s : null };
  if (s.customers.items.length) out.customers = clipList(s.customers.items, 4);
  else if (s.customers.segments.length) out.customers = clipList(s.customers.segments, 3);
  if (s.products.summary) out.products = clip(uncite(s.products.summary), 220);
  else if (s.products.items.length) out.products = clipList(s.products.items, 4);
  return out;
}

export function summaryLine(c) {
  const s = summary(c);
  const bits = [s.ebitda.value_eur != null ? `EBITDA ${s.ebitda.label} (${s.ebitda.detail.split(",")[0]})` : "EBITDA not public yet"];
  if (s.customers.items.length) bits.push(`${s.customers.items.length} customers named`);
  else if (s.customers.segments.length) bits.push(`${s.customers.segments.length} customer segments`);
  bits.push(`${s.pages_read} pages read, ${s.facts} facts`);
  return `${c.name}: ${bits.join(" · ")}`;
}
