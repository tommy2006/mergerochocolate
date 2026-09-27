// All Claude calls live here. Each exported function is one "agent" step with a typed (Zod) result.
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { icpForPrompt, MESSAGING_PRINCIPLES, READINESS_SIGNALS } from "./playbook.js";
import * as llm from "./llm.js";
import {
  EnrichmentSchema, ScoreSchema, MatchRerankSchema, OutreachSchema,
  HumanizerSchema, TriageSchema, ReplyScoreSchema, IntakeTurnSchema,
  PageFactsSchema, WebFactsSchema, ReportFinancialsSchema, TeaserSchema,
} from "./schemas.js";

// ---------- usage & cost tracking (every Claude call in the app goes through this file or reports here) ----------
import { AsyncLocalStorage } from "node:async_hooks";
const als = new AsyncLocalStorage();
// USD per million tokens (Anthropic list prices); cache writes ≈ 1.25× input, cache reads ≈ 0.1× input.
const PRICES = { "claude-opus-5": [5, 25], "claude-opus-5-5": [4, 20], "claude-opus-4-8": [5, 25], "claude-opus-4-7": [5, 25], "claude-opus-4-6": [5, 25], "claude-sonnet-5": [2, 10], "claude-sonnet-4-6": [3, 15], "claude-haiku-4-5": [1, 5], "claude-fable-5": [10, 50], "claude-fable-5-1": [10, 50] };
export const usage = { total: { calls: 0, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, usd: 0 }, by_company: {}, by_agent: {} };
export function costOf(u = {}, model = "claude-opus-5") {
  const [pin, pout] = PRICES[model] || (/mistral/i.test(model) ? llm.verdaConfig().price : PRICES["claude-opus-5"]);
  return ((u.input_tokens || 0) * pin + (u.output_tokens || 0) * pout + (u.cache_creation_input_tokens || 0) * pin * 1.25 + (u.cache_read_input_tokens || 0) * pin * 0.1) / 1e6;
}
export function track(u, model, agent = "other") {
  if (!u) return;
  const ctx = als.getStore() || {};
  const usd = costOf(u, model);
  const bump = (t) => { t.calls++; t.input_tokens += u.input_tokens || 0; t.output_tokens += u.output_tokens || 0; t.cache_read += u.cache_read_input_tokens || 0; t.cache_write += u.cache_creation_input_tokens || 0; t.usd += usd; };
  bump(usage.total);
  if (ctx.company_id) bump(usage.by_company[ctx.company_id] ||= { calls: 0, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, usd: 0, seconds: 0 });
  bump(usage.by_agent[ctx.agent || agent] ||= { calls: 0, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, usd: 0 });
  for (const fn of usageListeners) { try { fn(usage); } catch { /* listener errors never break a call */ } }
}
const usageListeners = [];
export function onUsage(fn) { usageListeners.push(fn); }
// Run fn with usage attributed to a company (and optionally an agent name); nested calls inherit the company.
export function runTracked(company_id, fn, agent) {
  const parent = als.getStore() || {};
  return als.run({ company_id: company_id ?? parent.company_id, agent: agent ?? parent.agent }, fn);
}
export function addSeconds(company_id, seconds) { const t = usage.by_company[company_id] ||= { calls: 0, input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, usd: 0, seconds: 0 }; t.seconds += seconds; t.runs = (t.runs || 0) + 1; }
export function hydrateUsage(saved) { if (saved?.total) Object.assign(usage.total, saved.total); if (saved?.by_company) Object.assign(usage.by_company, saved.by_company); if (saved?.by_agent) Object.assign(usage.by_agent, saved.by_agent); }

const clients = new Map();
function client(settings) {
  const key = settings.api_key || process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("No Anthropic API key configured. Add it in Settings (or set ANTHROPIC_API_KEY).");
  // Org-level (non-workspace-scoped) keys must name the workspace on every request.
  const workspace = settings.workspace_id || process.env.ANTHROPIC_WORKSPACE_ID || "";
  const cacheKey = `${key}|${workspace}`;
  if (!clients.has(cacheKey)) {
    clients.set(cacheKey, new Anthropic({
      apiKey: key,
      timeout: 10 * 60 * 1000,
      defaultHeaders: workspace ? { "anthropic-workspace-id": workspace } : undefined,
    }));
  }
  return clients.get(cacheKey);
}

// One structured call. Thinking is adaptive on every current model; effort tunes depth vs. latency.
export async function parse(settings, { schema, system, user, effort = "medium", max_tokens = 16000, claudeOnly = false }) {
  // Provider switch: Verda's Mistral (EU-hosted) takes every structured call when selected; Claude remains the
  // fallback unless the operator turned it off (strict data sovereignty). claudeOnly: the prompt carries a document
  // block (a scanned PDF), which only Claude reads; in strict mode that is an error the caller reports.
  let verdaFailure = null;
  if (claudeOnly && llm.provider(settings) === "verda" && !llm.fallbackAllowed(settings)) throw new Error("this step needs Claude's document reader, which strict EU-only mode disables");
  if (llm.provider(settings) === "verda" && !claudeOnly) {
    try {
      return await llm.verdaParse(settings, { schema, system, user, max_tokens: Math.min(max_tokens, 16000), name: "agent_output", onUsage: (u, model) => track(u, model) });
    } catch (err) {
      if (!llm.fallbackAllowed(settings) || !(settings.api_key || process.env.ANTHROPIC_API_KEY)) throw err;
      console.warn(`[llm] Verda failed (${err.message}); falling back to Claude`);
      verdaFailure = err.message;
    }
  }
  let res;
  try {
    res = await client(settings).messages.parse({
      model: settings.model || "claude-opus-5",
      max_tokens,
      thinking: { type: "adaptive" },
      output_config: { effort, format: zodOutputFormat(schema) },
      system,
      messages: [{ role: "user", content: user }],
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      if (/anthropic-workspace-id/i.test(err.message)) {
        throw new Error("Your API key is org-level, so Anthropic requires a workspace ID. Paste it under Settings → Anthropic workspace ID (Console → Settings → Workspaces, looks like wrkspc_…).");
      }
      throw new Error(`${verdaFailure ? `Verda failed (${verdaFailure}) and the Claude fallback failed too: ` : ""}Claude API ${err.status}: ${err.message}`);
    }
    if (err?.name === "ZodError" || err?.issues) throw new Error("Model output did not match the expected schema; please retry.");
    throw err;
  }
  track(res.usage, settings.model || "claude-opus-5");
  if (res.stop_reason === "refusal") throw new Error(`Model declined the request (${res.stop_details?.category || "refusal"}).`);
  if (!res.parsed_output) throw new Error("Model returned no structured output (stop_reason=" + res.stop_reason + ").");
  return res.parsed_output;
}

const eur = (n) => (n == null ? "unknown" : `€${(n / 1e6).toFixed(1)}M`);

function companyFacts(c) {
  const o = c.owner || {};
  return [
    `Company: ${c.name} (${c.country}${c.city ? ", " + c.city : ""})`,
    `Website: ${c.website || "unknown"}`,
    `Industry: ${c.industry || "unknown"}`,
    `Revenue: ${eur(c.revenue_eur)} | EBITDA: ${eur(c.ebitda_eur)} | Employees: ${c.employees ?? "unknown"} | Founded: ${c.founded ?? "unknown"}`,
    `Ownership: ${c.ownership_type || "unknown"}`,
    `Owner/CEO: ${o.name || "unknown"}${o.title ? ", " + o.title : ""}${o.age ? ", age " + o.age : ""}${o.tenure_years ? ", " + o.tenure_years + " years at the helm" : ""}`,
    `Source of lead: ${c.source || "unknown"}`,
    c.notes ? `Advisor notes: ${c.notes}` : null,
  ].filter(Boolean).join("\n");
}

const MERGERO_CONTEXT = `Mergero is an institutional M&A advisory firm (Zürich, Lugano, Frankfurt, Helsinki) building the first off-market deal network in Europe (MGX Deal Engine): 2,000+ verified buyers, €52B+ aggregate buyer appetite, €500M+ closed, 18 transactions in H1 2026. Sell-side clients are typically founders/owners of companies valued €3M+ (hard floor €3-5M) who are open to a transaction within 6-18 months. Deal origination is the bottleneck; everything must be scalable across Europe yet feel personal.`;

// ---------- 0. Research agents (facts from the company's web presence; every fact keeps its source) ----------
const hostOf = (u) => { try { return new URL(/^https?:/i.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, ""); } catch { return ""; } };
// Quote checks ignore case, punctuation and whitespace; small edits at the ends are tolerated via 8-word runs.
export const norm = (s) => String(s || "").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
function quoteFound(quote, haystack) {
  const q = norm(quote), h = norm(haystack);
  if (q.length < 12 || !h) return false;
  if (h.includes(q)) return true;
  const w = q.split(" ");
  for (let i = 0; i + 8 <= w.length; i += 4) if (h.includes(w.slice(i, i + 8).join(" "))) return true;
  return false;
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

const FACT_RULES = `Categories: offering (products, services, how they make money), customers (named customers, customer industries/segments, references), footprint (headquarters, offices, plants, subsidiaries, countries they sell into, export share), direction (vision, mission, strategy, stated goals and plans), financials (revenue, profit, growth or headcount figures with their year), ownership (owners, founder/family/PE ownership, group structure), people (founders, CEO, management, board: name and role only), events (dated happenings: acquisitions, new sites, launches, certifications, big contracts, leadership changes, anniversaries). Skip cookie/legal boilerplate and generic marketing claims ("high quality", "customer-focused"). Prefer specific, checkable statements with numbers, names, places and dates.`;

// Site pages → facts. A fact survives only if its quote is really on the page it cites.
export async function extractPageFacts(company, pages, settings) {
  if (!pages.length) return { facts: [], dropped: 0 };
  const batches = [];
  let cur = [], size = 0;
  pages.forEach((p, i) => {
    if (cur.length && size + p.text.length > 40000) { batches.push(cur); cur = []; size = 0; }
    cur.push(i); size += p.text.length;
  });
  if (cur.length) batches.push(cur);
  const results = await mapLimit(batches, 3, (idxs) => parse(settings, {
    schema: PageFactsSchema,
    effort: "low",
    system: `You extract facts about one company from pages of its own website, for an M&A advisor. Only extract what a page states; no inference, no outside knowledge. Every fact carries a quote copied character-for-character from the same page, in the page's language. ${FACT_RULES} Return at most 40 facts, most useful first.`,
    user: `Company: ${company.name} (${company.country || "?"}), website ${company.website || "?"}\n\n` +
      idxs.map((i) => `=== PAGE ${i} | ${pages[i].category} | ${pages[i].url} ===\n${pages[i].text}`).join("\n\n"),
  }).catch((err) => ({ facts: [], error: err.message })));
  const facts = [], errors = [];
  let dropped = 0;
  for (const r of results) {
    if (r.error) errors.push(r.error);
    for (const f of r.facts) {
      const page = pages[f.page];
      if (!page || !quoteFound(f.quote, page.text)) { dropped++; continue; }
      facts.push({ category: f.category, claim: f.claim, quote: f.quote, as_of: f.as_of, confidence: f.confidence, url: page.url, source_title: page.title || page.category, origin: "site", verified: "quote" });
    }
  }
  if (errors.length && errors.length === results.length) throw new Error(errors[0]);
  return { facts, dropped };
}

const FIN_TERMS = {
  FI: "liikevaihto, liikevoitto, käyttökate, tilinpäätös", SE: "omsättning, rörelseresultat, årsredovisning", NO: "omsetning, driftsresultat, årsregnskap",
  DK: "omsætning, bruttofortjeneste, årsrapport", DE: "Umsatz, Jahresüberschuss, EBITDA, Jahresabschluss", AT: "Umsatz, Jahresüberschuss, Jahresabschluss", CH: "Umsatz, Gewinn, Geschäftsbericht",
};

// Third-party web presence (press, directories, registries) via Claude web search, localised to the company's country.
export async function researchOffsite(company, crawl, settings) {
  // Web search and fetch are Claude server tools. Strict EU-only mode keeps research on the server: site crawl,
  // open registers, statement OCR and the Finnish profiler.
  if (!llm.webToolsAvailable(settings)) throw new Error("web search is a Claude tool, off in strict EU-only mode");
  const c = client(settings);
  const country = String(company.country || "").toUpperCase();
  const domain = hostOf(crawl?.root || company.website || "");
  // The crawler already covers the company's own site, so search is pointed at third-party sources.
  const search = { type: "web_search_20260209", name: "web_search", max_uses: 5, blocked_domains: ["linkedin.com", ...(domain ? [domain] : [])] };
  if (/^[A-Z]{2}$/.test(country)) search.user_location = { type: "approximate", country };
  const params = {
    model: settings.model || "claude-opus-5",
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
    system: "You are a research analyst for an M&A advisor. Use web search (and fetch where useful) to find what third-party sources say about one private company: press, business directories, registries, trade media. Be factual and specific; every finding must come from a source you found. Do not use LinkedIn.",
    tools: [search, { type: "web_fetch_20260209", name: "web_fetch", max_uses: 3, max_content_tokens: 10000, blocked_domains: ["linkedin.com"] }],
    messages: [{ role: "user", content: `Company: ${company.name} (${country}${company.city ? ", " + company.city : ""}), website ${domain || "unknown"}, industry ${company.industry || "unknown"}.
Search in the local language as well as English and find:
1. News and press from the last 24 months: acquisitions, investments, expansions, new sites, product launches, big contracts, ownership or leadership changes, awards.
2. Financial figures published anywhere (revenue/turnover, operating profit, EBITDA, employees) with their year. Local terms: ${FIN_TERMS[country] || "revenue, operating profit, annual report"}.
3. Annual report or financial statement PDFs.
4. Where they operate: sites, subsidiaries, export markets.
Write findings as short bullets, each with its source. Say so plainly when nothing reliable is found.` }],
  };
  const messages = params.messages;
  const seen = new Map(), texts = new Map(), notes = [];
  const addText = (u, t) => { if (t) texts.set(u, `${texts.get(u) || ""}\n${t}`); };
  const collect = (content) => {
    for (const b of content) {
      if (b.type === "web_search_tool_result" && Array.isArray(b.content)) for (const r of b.content) if (r.url) seen.set(r.url, r.title || "");
      if (b.type === "web_fetch_tool_result" && b.content?.type === "web_fetch_result") {
        const doc = b.content.content;
        seen.set(b.content.url, doc?.title || seen.get(b.content.url) || "");
        if (doc?.source?.type === "text") addText(b.content.url, doc.source.data);
      }
      if (b.type === "text") {
        const cites = (b.citations || []).filter((x) => x.url);
        for (const x of cites) { seen.set(x.url, x.title || seen.get(x.url) || ""); addText(x.url, x.cited_text); }
        notes.push(b.text + (cites.length ? ` [sources: ${[...new Set(cites.map((x) => x.url))].join(" ; ")}]` : ""));
      }
    }
  };
  const call = async () => {
    for (;;) {
      try { const r = await c.messages.create({ ...params, messages }); track(r.usage, params.model); return r; }
      catch (err) {
        // The search provider rejects some locations/domains; retry without that option rather than fail.
        const msg = err?.message || "";
        if (search.user_location && /location|country/i.test(msg)) { delete search.user_location; continue; }
        if (search.blocked_domains.length > 1 && /domain/i.test(msg)) { search.blocked_domains = ["linkedin.com"]; continue; }
        throw err;
      }
    }
  };
  let last = null;
  for (let i = 0; i < 5; i++) {
    last = await call();
    collect(last.content);
    if (last.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: last.content }); continue; }
    if (last.stop_reason === "refusal") throw new Error("web research declined");
    break;
  }
  // At low effort the model sometimes stops after searching without writing findings up; ask once.
  if (seen.size && notes.join("").trim().length < 300 && last?.stop_reason === "end_turn") {
    messages.push({ role: "assistant", content: last.content }, { role: "user", content: "Write up your findings now as short bullets, each with its source URL. Do not search further." });
    collect((await call()).content);
  }
  const notesChars = notes.join("\n").length;
  if (process.env.DEBUG_RESEARCH) console.log("[researchOffsite] notes:\n" + notes.join("\n").slice(0, 3000));
  if (!seen.size) return { facts: [], financial_mentions: [], report_pdfs: [], dropped: 0, sources: 0, notes_chars: notesChars };
  const sourceList = [...seen].map(([u, t], i) => `[S${i + 1}] ${t || "(untitled)"} | ${u}` +
    (texts.get(u) ? `\n   excerpts: ${texts.get(u).replace(/\s+/g, " ").slice(0, 1500)}` : "")).join("\n");
  const out = await parse(settings, {
    schema: WebFactsSchema,
    effort: "low",
    system: `You turn web research notes about one company into structured facts for an M&A advisor. Use only what the notes and source excerpts state; drop anything about a different company with a similar name. Every fact and figure needs the URL of its source exactly as listed. ${FACT_RULES}`,
    user: `Company: ${company.name} (${country}), website ${domain || "unknown"}.\n\nRESEARCH NOTES:\n${notes.join("\n") || "(none)"}\n\nSOURCES:\n${sourceList}`,
  });
  const key = (u) => String(u || "").replace(/\/$/, "");
  const known = new Set([...seen.keys()].map(key));
  let dropped = 0;
  const facts = out.facts.filter((f) => known.has(key(f.url)) || (dropped++, false)).map((f) => ({
    category: f.category, claim: f.claim, quote: f.quote, as_of: f.as_of, confidence: f.confidence, url: f.url,
    source_title: f.source_title || seen.get(f.url) || hostOf(f.url), origin: "web",
    verified: f.quote && quoteFound(f.quote, texts.get(f.url) || texts.get(`${key(f.url)}/`) || texts.get(key(f.url)) || "") ? "quote" : "source",
  }));
  return {
    facts,
    financial_mentions: out.financial_mentions.filter((m) => known.has(key(m.url))),
    report_pdfs: [...seen.keys()].filter((u) => /\.pdf($|[?#])/i.test(u)),
    dropped,
    sources: seen.size,
    notes_chars: notesChars,
  };
}

// Annual-report PDF → income-statement figures (Claude reads the PDF directly).
const REPORT_SYSTEM = "You read financial statements for an M&A advisor. Report only figures printed in the document, as absolute amounts (multiply out 'in thousands', 'EUR 1,000', 'MEUR' etc.). Use null for anything not reported. Do not compute EBITDA unless the document states it.";
export async function readAnnualReport(company, pdf, url, settings) {
  return parse(settings, {
    schema: ReportFinancialsSchema,
    effort: "low",
    claudeOnly: true,
    system: REPORT_SYSTEM,
    user: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.toString("base64") } },
      { type: "text", text: `Company: ${company.name} (${company.country}). Source: ${url}\nExtract the income-statement figures for every financial year shown (current and comparative).` },
    ],
  });
}

// Same reader for statements already turned into text (PDF text layer): works on every provider, including Mistral on Verda.
export async function readAnnualReportText(company, text, url, settings, { ocr = false } = {}) {
  const ocrNote = ocr ? " The text comes from OCR of a scanned statement: digits may carry stray spaces or misreads (an 'O' for a 0, 'l' for 1), thousands are separated by spaces in Nordic statements, and negative numbers may show as -1 234 or (1 234). Read the income-statement lines carefully and use the current-year column (the first numeric column)." : "";
  return parse(settings, {
    schema: ReportFinancialsSchema,
    effort: "low",
    max_tokens: 6000,
    system: REPORT_SYSTEM + ocrNote,
    user: `Company: ${company.name} (${company.country}). Source: ${url}\nBelow is the text of the filed financial statements (page markers included). Extract the income-statement figures for every financial year shown (current and comparative). Depreciation = the depreciation/amortisation line of the income statement (avskrivninger, poistot, avskrivningar, Abschreibungen), as a positive number; EBITDA only if printed.\n\n${text}`,
  });
}

// Compact, citable view of the research for downstream prompts.
function financialLines(r) {
  return (r?.financials?.rows || []).map((x) => `${x.year}: revenue ${eur(x.revenue_eur)} | EBIT ${eur(x.ebit_eur)} | EBITDA ${x.ebitda_eur == null ? "n/a" : eur(x.ebitda_eur) + (x.ebitda_basis === "derived" ? " (derived: EBIT + D&A)" : "")} | net ${eur(x.net_income_eur)}${x.employees != null ? ` | ${x.employees} employees` : ""} (${x.source})`);
}
const byAsOfDesc = (a, b) => (b.as_of || "").localeCompare(a.as_of || "");
function researchBrief(company, { facts = 12, categories = ["events", "direction", "ownership", "people", "financials"] } = {}) {
  const r = company.research;
  if (!r) return "";
  const fl = financialLines(r);
  const fs = (r.facts || []).filter((f) => categories.includes(f.category)).sort(byAsOfDesc).slice(0, facts)
    .map((f) => `- [${f.as_of || "undated"}] ${f.claim} (${hostOf(f.url)})`);
  return [
    fl.length ? `Filed/published financials:\n${fl.join("\n")}` : "",
    (r.financials?.conflicts || []).length ? `Conflicts with our database: ${r.financials.conflicts.join("; ")}` : "",
    fs.length ? `Research facts:\n${fs.join("\n")}` : "",
  ].filter(Boolean).join("\n");
}
export function dossierText(company, maxFacts = 160) {
  const r = company.research;
  if (!r) return "";
  const s = r.site || {}, org = s.jsonld_org || {};
  const order = ["offering", "customers", "footprint", "direction", "events", "financials", "ownership", "people", "other"];
  const facts = [...(r.facts || [])].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category)).slice(0, maxFacts);
  const fl = financialLines(r);
  return [
    s.root ? `Website ${s.root}: read ${s.pages_read} of ${s.pages_found} pages found; languages ${(s.languages || []).join(", ") || "unknown"}.` : "Website: not crawled.",
    org.name ? `Structured data on the site: ${[org.legalName || org.name, org.foundingDate && `founded ${org.foundingDate}`, org.numberOfEmployees && `${org.numberOfEmployees} employees`, (org.address || []).join(" / ")].filter(Boolean).join("; ")}` : null,
    s.business_ids?.length ? `Business IDs: ${s.business_ids.map((b) => `${b.type} ${b.value}`).join(", ")}` : null,
    "", "RESEARCH FACTS (id | category | as of | claim | source):",
    ...(facts.length ? facts.map((f) => `${f.id} | ${f.category} | ${f.as_of || "-"} | ${f.claim} | ${f.url}`) : ["none"]),
    "", "FILED / PUBLISHED FINANCIALS:",
    ...(fl.length ? fl : ["none found"]),
    ...(r.financials?.notes || []).map((n) => `note: ${n}`),
    ...(r.financials?.conflicts || []).map((n) => `CONFLICT WITH DATABASE: ${n}`),
  ].filter((x) => x != null).join("\n");
}
// Drop evidence ids the model made up.
function scrubEvidence(node, ids) {
  if (Array.isArray(node)) { node.forEach((x) => scrubEvidence(x, ids)); return; }
  if (!node || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    if (k === "evidence" && Array.isArray(v)) node[k] = v.filter((id) => ids.has(id));
    else scrubEvidence(v, ids);
  }
}

// ---------- 1. Enrichment agent (research dossier or live web research → structured profile) ----------
export async function enrich(company, settings) {
  const facts = companyFacts(company);
  const r = company.research;
  const hasResearch = Boolean((r?.facts || []).length || (r?.financials?.rows || []).length);
  let researchNote = "";
  let usedWeb = false;
  if (hasResearch) {
    researchNote = dossierText(company);
    usedWeb = true;
  } else {
    try {
      researchNote = await researchWithWeb(company, facts, settings);
      usedWeb = true;
    } catch (err) {
      // Web tools may be unavailable for this org/model; degrade to knowledge-only enrichment.
      researchNote = `(Web research unavailable: ${err.message}). Work from the facts below and general sector knowledge; mark unknowns explicitly.`;
    }
  }
  const evidenceRules = hasResearch
    ? "The research below comes from Mergero's crawl of the company's own website, third-party web sources and official registries; each fact has an id like f12. Base the profile on these facts and cite fact ids in every evidence field. Do not add facts that are not in the research or the prospect data; leave fields empty when unknown. financial_view uses only the FILED / PUBLISHED FINANCIALS lines and says plainly what is not public. sources = URLs of the facts you relied on."
    : "No structured research is available: leave every evidence array empty, fill offering/customer_segments/footprint/direction only as far as the notes support, and prefer empty strings/arrays over guesses. financial_view: only the database figures above, labelled as database figures.";
  const out = await parse(settings, {
    schema: EnrichmentSchema,
    effort: "medium",
    system: `${MERGERO_CONTEXT}\nYou are Mergero's company-enrichment analyst. Turn raw prospect-database rows into a profile an M&A advisor can act on. Be specific and honest: if something is unknown, say so in data_gaps rather than inventing it. Never fabricate customer names or news. Only list sources that were actually consulted.\n${evidenceRules}`,
    user: `Prospect facts:\n${facts}\n\n${hasResearch ? "Research dossier" : `Research notes${usedWeb ? " (from live web research)" : ""}`}:\n${researchNote}\n\nProduce the structured enrichment profile. Signals must focus on sale-readiness (owner age/tenure, succession, growth trajectory, sector consolidation, PE activity). data_gaps must include what Mergero still needs for a mandate (revenue split by product, top-10 client concentration, normalized EBITDA) unless already known.`,
  });
  scrubEvidence(out, new Set((r?.facts || []).map((f) => f.id)));
  return { ...out, enriched_at: new Date().toISOString(), web_research: usedWeb, research_based: hasResearch };
}

async function researchWithWeb(company, facts, settings) {
  // Web search/fetch are Claude server tools. In strict EU-only mode (Verda without fallback) research stays local:
  // registries, the site crawler and the Finnish profiler still run; enrichment then works from those facts.
  if (!llm.webToolsAvailable(settings)) throw new Error("web research tools are not available on the Verda provider in strict mode");
  const c = client(settings);
  const params = {
    model: settings.model || "claude-opus-5",
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    system: "You are a research analyst. Use web search and web fetch to learn what this company does, its products, customers, leadership, ownership and recent news. Prefer the company's own website and reputable business press. Be brief and factual; write a compact research note with the URLs you used. If the website does not resolve or nothing is found, say so plainly.",
    tools: [
      { type: "web_search_20260209", name: "web_search", max_uses: 4 },
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: 3, max_content_tokens: 20000 },
    ],
    messages: [{ role: "user", content: `Research this company for an M&A advisor. Start with its website ${company.website || "(no website given)"}.\n\n${facts}` }],
  };
  const messages = params.messages;
  let text = "";
  for (let i = 0; i < 4; i++) {
    const res = await c.messages.create({ ...params, messages });
    track(res.usage, params.model, "research");
    text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if (res.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: res.content }); continue; }
    if (res.stop_reason === "refusal") throw new Error("research declined");
    break;
  }
  return text || "No research text produced.";
}

// ---------- 2. Sale-readiness scoring agent ----------
export async function score(company, buyers, settings, { learning } = {}) {
  const activeBuyers = buyers.filter((b) => b.active !== false);
  const buyerSummary = activeBuyers.map((b) => `- ${b.name} (${b.buyer_type}): sectors ${b.sectors.join("/")}, geo ${b.geographies.join("/")}, revenue ${eur(b.revenue_min_eur)}-${eur(b.revenue_max_eur)}, EBITDA ${eur(b.ebitda_min_eur)}-${eur(b.ebitda_max_eur)}`).join("\n");
  const out = await parse(settings, {
      schema: ScoreSchema,
      effort: "medium",
      system: `${MERGERO_CONTEXT}\nYou are Mergero's origination analyst. Score prospects for sell-side outreach. Readiness = probability the owner is open to a transaction in 6-18 months (succession age 58+, long tenure, flat growth, no successor, PE consolidation in sector, recent inbound interest are positive; fresh PE ownership (holding period <3y), recent large investment, young founder in growth mode are negative). Attractiveness = fit with the buyer network below. Valuation: rule of thumb 5-8x EBITDA for profitable SMEs, 0.8-2x revenue for software; the hard minimum Mergero accepts is €3-5M valuation. Be calibrated: most prospects should land 30-70; reserve 80+ for strong, multi-signal cases.\n${icpForPrompt()}\nReadiness signals Mergero cares about — positive: ${READINESS_SIGNALS.positive.join("; ")}. Negative: ${READINESS_SIGNALS.negative.join("; ")}. Remember the owner usually has not considered selling yet: readiness measures openness to a first conversation, including growth capital or a minority stake, not a declared intent to sell. Write why_now as 3-5 short sentences on separate lines, not one long paragraph. Sentence 1 states the concrete reason in plain words from the facts: the owner's age and tenure when known, then the strongest dated or filed fact (flat or falling revenue, a contract, an expansion, a change of leadership). Mention a successor only when the facts say something about succession or ownership; never assume one is missing. State only what the prospect data and the research facts show, in your own words: never copy the readiness-signal list wording, never repeat a sentence, never open with "On paper", "This looks like" or a summary of the company.`,
      user: `Prospect:\n${companyFacts(company)}\n\nEnrichment profile:\n${JSON.stringify(company.enrichment || {}, null, 1)}\n\n${researchBrief(company) ? `Sourced research (filed accounts beat database figures; dated events matter for timing):\n${researchBrief(company)}\n\n` : ""}Buyer network (anonymised mandates):\n${buyerSummary}\n\n${learning ? `What has worked so far for prospects like this (observed outcomes; weigh them, do not copy them):\n${learning}\n\n` : ""}Score this prospect.`,
    });
  // The model sometimes repeats a why_now line; keep the first of each (the cards print these verbatim).
  const seen = new Set();
  out.why_now = String(out.why_now || "").split(/\n+/).map((l) => l.trim()).filter((l) => {
    const k = l.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  }).join("\n");
  return { ...out, scored_at: new Date().toISOString() };
}

// ---------- 3. Buyer-demand matching (deterministic prefilter + LLM rerank) ----------
const COUNTRY_CODES = {
  finland: "FI", sweden: "SE", norway: "NO", denmark: "DK", iceland: "IS", germany: "DE", austria: "AT", switzerland: "CH", netherlands: "NL", belgium: "BE",
  france: "FR", "united kingdom": "GB", uk: "GB", poland: "PL", estonia: "EE", latvia: "LV", lithuania: "LT", spain: "ES", italy: "IT", "united states": "US", usa: "US",
};
const toIso = (m) => { const s = String(m || "").trim(); return /^[A-Z]{2}$/.test(s) ? s : COUNTRY_CODES[s.toLowerCase()] || null; };

export function prefilterBuyers(company, buyers) {
  const e = company.enrichment || {};
  // Sector terms: the database industry plus what research says they actually sell and to whom.
  const sector = [company.industry, ...(e.offering?.product_lines || []).map((p) => p.name), ...(e.customer_segments || []).map((s) => s.segment)]
    .filter(Boolean).join(" / ").toLowerCase();
  const markets = new Set([company.country, ...(e.footprint?.sales_markets || []).map(toIso)].filter(Boolean));
  const rev = company.revenue_eur, ebitda = company.ebitda_eur;
  const scored = buyers.filter((b) => b.active !== false).map((b) => {
    let s = 0;
    const sectors = (b.sectors || []).map((x) => x.toLowerCase());
    if (sectors.some((x) => sector.includes(x) || x.includes(sector) || sector.split(/[\s/,&]+/).some((w) => w.length > 3 && x.includes(w)))) s += 3;
    const geo = (b.geographies || []).map((x) => x.toUpperCase());
    if (geo.includes("EU") || [...markets].some((m) => geo.includes(m))) s += 2;
    const within = (v, lo, hi) => v == null || ((lo == null || v >= lo * 0.7) && (hi == null || v <= hi * 1.3));
    if (within(rev, b.revenue_min_eur, b.revenue_max_eur)) s += 1;
    if (within(ebitda, b.ebitda_min_eur, b.ebitda_max_eur)) s += 1;
    return { buyer: b, s };
  });
  const good = scored.filter((x) => x.s >= 4).sort((a, b) => b.s - a.s).map((x) => x.buyer);
  return (good.length ? good : scored.sort((a, b) => b.s - a.s).map((x) => x.buyer)).slice(0, 8);
}

export async function match(company, buyers, settings) {
  const candidates = prefilterBuyers(company, buyers);
  if (!candidates.length) return [];
  const out = await parse(settings, {
    schema: MatchRerankSchema,
    effort: "low",
    system: `${MERGERO_CONTEXT}\nYou rank anonymised buyer mandates against a sell-side prospect. Fit 0-100. Only include buyers that are a genuine fit (fit >= 50); it is fine to return fewer. Reasons must cite the buyer's thesis and something specific about the company.`,
    user: `Prospect:\n${companyFacts(company)}\nEnrichment summary: ${company.enrichment?.summary || "n/a"}\nProducts: ${(company.enrichment?.products || []).join(", ") || "n/a"}\nOffering: ${company.enrichment?.offering?.summary || "n/a"}\nCustomer segments: ${(company.enrichment?.customer_segments || []).map((s) => s.segment).join("; ") || "n/a"}\nFootprint: ${[company.enrichment?.footprint?.headquarters, ...(company.enrichment?.footprint?.sites || [])].filter(Boolean).join("; ") || "n/a"} | sells into: ${(company.enrichment?.footprint?.sales_markets || []).join(", ") || "n/a"}\n\nCandidate buyers:\n${JSON.stringify(candidates, null, 1)}`,
  });
  const byId = Object.fromEntries(candidates.map((b) => [b.id, b]));
  return out.matches.filter((m) => byId[m.buyer_id]).sort((a, b) => b.fit - a.fit)
    .map((m) => ({ ...m, buyer_name: byId[m.buyer_id].name, buyer_type: byId[m.buyer_id].buyer_type }));
}

// ---------- 4. Outreach writer agent (3-touch sequence, channel by market) ----------
const LANG = { en: "English", fi: "Finnish", sv: "Swedish", no: "Norwegian", da: "Danish", de: "German" };

// Sourced observations the writer may use: recent dated events first, then direction, customers, footprint, offering.
function outreachFacts(company, n = 14) {
  const pri = { events: 0, direction: 1, customers: 2, footprint: 3, offering: 4 };
  return (company.research?.facts || []).filter((f) => f.category in pri && f.confidence !== "low")
    .sort((a, b) => pri[a.category] - pri[b.category] || byAsOfDesc(a, b)).slice(0, n)
    .map((f) => `- [${f.category}${f.as_of ? ", " + f.as_of : ""}] ${f.claim} (source: ${hostOf(f.url)})`).join("\n");
}

// How the conversation is framed (Mergero: owners rarely know they want to sell; growth capital / minority is the softer door).
const FRAMING_GUIDE = {
  open: "Open conversation: do not propose any transaction type. Ask about their plans for the next few years and offer to share, confidentially, what buyers in our network are looking for. A sale is never mentioned.",
  growth: "Growth capital: frame the interest as investors who back owners to grow (capacity, new markets, acquisitions) while the owner keeps control. Position a full sale as not on the table.",
  minority: "Partial or minority stake: frame it as taking some money off the table and bringing in a partner while staying in charge; keep the door to a larger transaction implicit, never explicit.",
  exit: "Full sale, handled gently: acknowledge that a succession or exit may be years away, offer a no-commitment conversation about options and what the buyers who want this kind of company value, without pushing timing.",
};

export async function outreach(company, settings, { language = "en", channel, framing = "open", touches = 3 } = {}) {
  channel = channel || company.channel || "email";
  framing = FRAMING_GUIDE[framing] ? framing : "open";
  touches = Math.max(1, Math.min(5, Number(touches) || 3));
  const cadence = touches >= 4 ? "step 1 day 0; step 2 day 4 (half the length, one new angle); step 3 day 10 (a short LinkedIn-style note or email offering a one-page anonymised view of what buyers want in their sector); step 4 day 21 (closes the loop politely, leaves the door open)" : null;
  const s = settings.sender;
  const matchLine = company.matches?.length
    ? `${company.matches.length} buyer${company.matches.length > 1 ? "s" : ""} in our network currently fit this profile: ${company.matches.slice(0, 3).map((m) => `${m.buyer_name} (fit ${m.fit})`).join("; ")}.`
    : "No specific buyer matches yet; speak about buyer demand in the sector in general terms.";
  const verified = outreachFacts(company);
  // Adaptive thinking shares max_tokens with the answer: at high effort on a research-heavy prompt the JSON can get cut
  // off ("Unterminated string"). Medium effort first; on truncation retry once at low effort before the caller falls back.
  const request = (effort) => parse(settings, {
    schema: OutreachSchema,
    effort,
    max_tokens: 32000,

    system: `${MERGERO_CONTEXT}\nYou write first-contact outreach for ${s.name}, ${s.title} at ${s.firm}, to the owner of a private company. Goal of touch 1: earn a 20-minute warm-up conversation, not a mandate. Style rules (non-negotiable): ${settings.style_rules}\nProof points you may use sparingly (max one per message): ${settings.value_props.join(" | ")}.\nChannel conventions: email = 90-140 words with a plain subject line that reads like a colleague wrote it (no clickbait); linkedin = 40-80 words, no subject, first-name friendly; call_script = a 60-second opener with one question.\nSequence: step 1 day 0 opens with one specific observation about their company and one concrete statement of buyer demand; step 2 (day 5-7) adds a new angle (a comparable transaction pattern, timing, or a data point) in half the length; step 3 (day 12-16) closes the loop politely and leaves the door open. Never mention AI, never mention that this is a sequence, never use placeholders like [Name]. Never invent Mergero's own activity or numbers (conversations held, buyers spoken to this month, prices paid, mandates won): refer to buyer demand only as what the matched mandates state, in the form "buyers in our network are looking for ...".\nSpecific observations must come from the verified research facts or the enrichment profile; prefer a recent, dated fact. Never quote the company's own financial figures (revenue, profit, margins) back to the owner.\nConversation framing for this sequence: ${FRAMING_GUIDE[framing]}\nMergero messaging principles:\n${MESSAGING_PRINCIPLES}\nWrite like a person: vary sentence length, use one or two contractions, one idea per paragraph, no lists, no headings, no bold, at most one question, and nothing that could be pasted unchanged into an email to a different company.${voiceBlock(settings)}`,
    user: `Write the ${touches}-message sequence in ${LANG[language] || language} on channel "${channel}" (for a call_script or linkedin channel, keep the ${touches} steps but adapt length).${cadence ? ` Cadence for this sequence: ${cadence}.` : ""}\n\nProspect:\n${companyFacts(company)}\n\nEnrichment:\n${JSON.stringify(company.enrichment || {}, null, 1)}\n\n${verified ? `Verified research facts (each has a source):\n${verified}\n\n` : ""}Why now (analyst view): ${company.score?.why_now || "n/a"}\nRecommended timing: ${company.score?.recommended_timing || "n/a"}\n\nBuyer demand: ${matchLine}\n\nSign as ${s.name}, ${s.title}, ${s.firm}${s.phone ? ", " + s.phone : ""}.`,
  });
  let out;
  try { out = await request("medium"); }
  catch (err) {
    if (!/Unterminated|structured output|schema/i.test(err.message)) throw err;
    console.warn(`[outreach] retrying at low effort after: ${err.message.slice(0, 120)}`);
    out = await request("low");
  }
  return out.messages.slice(0, touches).map((m, i) => ({ ...m, step: i + 1, language, framing }));
}

// ---------- 5. Humanizer critic (catches AI/template tells, rewrites) ----------
// The advisor's own past emails, when provided in Settings: the strongest anti-"AI voice" signal there is.
function voiceBlock(settings) {
  const v = String(settings.voice_samples || "").trim();
  if (!v) return "";
  return `\nVOICE SAMPLES (real emails written by ${settings.sender?.name || "the sender"}; match their rhythm, sentence length, word choice, greeting and sign-off; never copy sentences):\n"""\n${v.slice(0, 6000)}\n"""`;
}

// `lint` (optional) = findings from server/humanlint.js for this exact draft; the editor must resolve each one.
export async function humanize(message, company, settings, { lint } = {}) {
  const findings = lint?.flags?.length
    ? `\nSpecific findings from the human-language linter — resolve every one:\n${lint.flags.map((f) => `- ${f.rule}${f.excerpt ? ` ("${f.excerpt}")` : ""}: ${f.fix}`).join("\n")}` +
      (lint.personalization?.generic ? "\n- The draft uses no specific fact about this company: work in one concrete, sourced detail." : "") +
      (lint.similarity?.max >= 0.12 ? `\n- Passages are reused from an email to another prospect (${lint.similarity.with}): rewrite them in different words.` : "")
    : "";
  return parse(settings, {
    schema: HumanizerSchema,
    effort: "medium",
    system: `You are a ruthless editor who has read ten thousand cold emails and can spot machine-written or templated text instantly. Flag every tell: stock openers ("I hope this finds you well", "I came across"), em dashes, tricolons (lists of three adjectives), words like delve/leverage/synergies/landscape/unlock/streamline/robust/seamless, exclamation marks, generic flattery ("impressive growth"), mirrored sentence rhythm, over-hedging, marketing tone, and anything that could be sent to 500 companies unchanged. Then rewrite so it reads like one specific busy senior advisor wrote it to one specific owner, keeping every concrete fact and the same language, length band and channel. Keep the sign-off. Plain text only: no lists, no headings, no bold. House style: ${settings.style_rules}${voiceBlock(settings)}`,
    user: `Channel: ${message.channel}. Language: ${message.language || "en"}. Recipient: ${company.owner?.name || "the owner"} of ${company.name} (${company.industry}).${findings}\n\nSubject: ${message.subject || "(none)"}\n\nBody:\n${message.body}`,
  });
}

// ---------- 6. Reply triage agent (classify, extract facts, draft next reply) ----------
export async function triage(company, inboundText, settings) {
  const s = settings.sender;
  const history = (company.conversation || []).slice(-6).map((e) => `[${e.direction} ${e.channel} ${e.at?.slice(0, 10)}]\n${e.text}`).join("\n\n");
  return parse(settings, {
    schema: TriageSchema,
    effort: "low",
    system: `${MERGERO_CONTEXT}\nYou triage replies from business owners to ${s.name} (${s.title}, ${s.firm}). Classify intent and sentiment, extract every business fact the owner reveals (revenue split, client concentration, EBITDA, timing, succession intent, decision makers, valuation expectations, objections) as structured facts, list the owner's direct questions as open_questions, recommend the pipeline stage, state the single next step, and draft the reply ${s.name} should send (it must answer every open question): short, warm, specific, moving toward a 20-30 minute call; answer their questions honestly (buyer types yes, buyer names no; process = confidential, off-market, owner decides pace). Same language as the owner. Style: ${settings.style_rules}\nMergero messaging principles (also apply to replies; if the owner is hesitant, offer the softer options — growth capital or a partial stake — before any talk of a sale):\n${MESSAGING_PRINCIPLES}`,
    user: `Prospect:\n${companyFacts(company)}\nEnrichment summary: ${company.enrichment?.summary || "n/a"}\nOffering: ${company.enrichment?.offering?.summary || "n/a"} | Customer segments: ${(company.enrichment?.customer_segments || []).map((s) => s.segment).join("; ") || "n/a"} | Footprint: ${company.enrichment?.footprint?.headquarters || "n/a"}\n${researchBrief(company, { facts: 6 })}\nBuyer matches: ${(company.matches || []).map((m) => `${m.buyer_name} (${m.buyer_type})`).join(", ") || "none yet"}\n\nRecent conversation:\n${history || "(none)"}\n\nNEW INBOUND REPLY FROM OWNER:\n${inboundText}`,
  });
}

// ---------- 6b. Reply understanding agent (reads the owner's words, re-scores readiness and timing) ----------
// Runs after triage on every owner reply. The first score came from outside data (age, tenure, filings); a reply is the
// owner speaking for himself, which is the strongest readiness evidence there is. Evidence quotes are checked against the
// reply text so a score never moves on words the owner did not write.
export async function rescoreFromReply(company, entry, triage, settings) {
  const cur = company.score || {};
  const history = (company.conversation || []).filter((e) => e.id !== entry.id).slice(-6).map((e) => `[${e.direction} ${e.channel} ${e.at?.slice(0, 10)}]\n${e.text}`).join("\n\n");
  const out = await parse(settings, {
    schema: ReplyScoreSchema,
    effort: "medium",
    max_tokens: 6000,
    system: `${MERGERO_CONTEXT}\nYou are Mergero's reply analyst. An owner has answered our outreach. Read what they actually wrote, in whatever language, and update the prospect's readiness score (probability the owner is open to a transaction, including growth capital or a minority stake, within 6-18 months), attractiveness and recommended timing.
How to read owner replies (calibrate; most replies move readiness by 5-20 points, only explicit statements move it more):
- Raises strongly: mentions succession, retirement, age, "next chapter", children not taking over, asks what the company is worth or what buyers pay, asks about the process, proposes a call, forwards to a co-owner to set one up.
- Raises moderately: curiosity about which buyers, asks for more information, open to growth capital or a partner, positive tone with a question.
- Timing, not readiness: "not now but maybe in two years", "after this season", "we are in the middle of an expansion" → keep readiness roughly where it is or slightly lower, move the timing.
- Lowers: "we are not interested", "the family will continue", recently took investment, irritation at being contacted, a firm no. An explicit request to stop means readiness near 0 and timing "not yet".
- Neutral: an out-of-office, a referral to someone else without comment, a one-line "thanks".
Politeness is not interest; brevity is not rejection. Weigh what the owner says about himself above tone. Quote the exact words that drove each change; never invent a quote.\n${icpForPrompt()}`,
    user: `Prospect:\n${companyFacts(company)}\n\nCurrent score: readiness ${cur.readiness ?? "not scored"}, attractiveness ${cur.attractiveness ?? "n/a"}, timing ${cur.recommended_timing || "n/a"}.\nWhy now (analyst view before the reply): ${cur.why_now || "n/a"}\nSignals so far: ${(cur.signals || []).slice(0, 8).map((g) => `${g.signal} (${g.direction})`).join("; ") || "none"}\n\nTriage of this reply: intent ${triage.intent}, sentiment ${triage.sentiment}; facts: ${(triage.extracted_facts || []).map((f) => `${f.field}=${f.value}`).join("; ") || "none"}.\n\nEarlier conversation:\n${history || "(none)"}\n\nTHE OWNER'S REPLY:\n"""\n${entry.text}\n"""\n\nUpdate the score.`,
  });
  // Keep only evidence the owner actually wrote.
  const reply = entry.text_full || entry.text;
  const evidence = (out.evidence || []).filter((e) => e.quote && (quoteFound(e.quote, reply) || (norm(e.quote).length >= 3 && norm(reply).includes(norm(e.quote)))));
  return { ...out, evidence, dropped_quotes: (out.evidence || []).length - evidence.length };
}

// ---------- 7. Owner intake agent (conversational data gathering at scale) ----------
export async function intakeTurn(company, transcript, settings) {
  const s = settings.sender;
  const gaps = company.enrichment?.data_gaps?.join("; ") || "revenue split by product, top-10 client concentration, normalized EBITDA, timing, motivation, deal-breakers";
  const known = financialLines(company.research).slice(0, 3).join("; ");
  const segments = (company.enrichment?.customer_segments || []).map((s) => s.segment).join("; ");
  const publicInfo = known || segments ? ` Already public (ask the owner to confirm or explain these rather than asking from scratch, and never read exact figures back as if you were auditing them): ${[known && `filed accounts ${known}`, segments && `customer segments ${segments}`].filter(Boolean).join(" | ")}.` : "";
  const convo = transcript.map((t) => `${t.role === "owner" ? "OWNER" : "ASSISTANT"}: ${t.text}`).join("\n");
  return parse(settings, {
    schema: IntakeTurnSchema,
    effort: "low",
    max_tokens: 4000,
    system: `You are a discreet intake assistant for ${s.firm}, working on behalf of ${s.name}. A business owner (${company.owner?.name || "the owner"} of ${company.name}) has agreed to share some information ahead of a conversation about a possible transaction. Collect, one question at a time, in plain conversational language, in the owner's language: (1) rough revenue split by product/service line, (2) top-10 client concentration (share of revenue), (3) normalized EBITDA or margin and any one-offs, (4) timing they have in mind, (5) motivation (succession, growth capital, de-risking), (6) deal-breakers (e.g. keeping staff, staying on, minimum price expectations). Known gaps to prioritise: ${gaps}.${publicInfo} Never push for exact figures if they hesitate; ranges are fine. Acknowledge each answer briefly. When you have all six (or the owner wants to stop), set status complete, thank them, tell them ${s.name} will follow up, and fill the summary. Keep each message under 60 words. If the transcript is empty, open by introducing yourself in one sentence and asking question 1.`,
    user: `Transcript so far:\n${convo || "(empty — produce the opening message)"}`,
  });
}

// ---------- 8. Blind teaser for buyers (only after a mandate is signed; never identifies the company) ----------
export async function teaser(company, settings) {
  const e = company.enrichment || {};
  const profile = { summary: e.summary, offering: e.offering, customer_segments: (e.customer_segments || []).map((s) => s.segment), footprint: e.footprint, direction: e.direction, financial_view: e.financial_view, signals: e.signals };
  return parse(settings, {
    schema: TeaserSchema,
    effort: "medium",
    system: `${MERGERO_CONTEXT}\nYou draft the blind teaser Mergero sends to matched buyers after a sell-side mandate is signed. The company must not be identifiable: no company, brand or product names, no named customers or people, no city (country or region only), no unique superlatives that point to one company, and figures only as ranges. Use only the facts provided below; leave out anything unknown.`,
    user: `Company (for your reference only, never name it): ${companyFacts(company)}\n\nProfile:\n${JSON.stringify(profile, null, 1)}\n\n${researchBrief(company, { facts: 10 })}\n\nOwner intake summary:\n${JSON.stringify(company.intake?.summary || {}, null, 1)}\n\nMatched buyer types: ${[...new Set((company.matches || []).map((m) => m.buyer_type))].join(", ") || "n/a"}`,
  });
}
