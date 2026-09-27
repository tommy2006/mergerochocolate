// Amir's Origination Desk API, served by our engine.
// His page (public/desk/index.html) is untouched: every route here returns exactly the shapes it reads, but the data
// behind them is ours — registries, research, Claude scoring, humanised outreach, real email, triage — instead of CSVs.
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import * as db from "../db.js";
import * as E from "./engine.js";
import * as llm from "../llm.js";
import * as agents from "../agents.js";
import * as A from "./analyze.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(here, "..", "..", "public", "desk", "index.html");
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => { console.error(`[desk ${req.method} ${req.path}]`, err?.message || err); res.status(err.status || 500).json({ status: "error", message: err?.message || String(err) }); });
const errorJson = (res, status, message) => res.status(status).json({ status: "error", message });
const today = () => new Date();
const iso = () => new Date().toISOString();

let BASE_URL = "http://localhost:3000";
// Loopback into our own routes: the same code paths (lint gate, advisor caps, triage + rescore) as our UI.
async function call(method, p, body) {
  const r = await fetch(`${BASE_URL}${p}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `${r.status} ${r.statusText}`), { status: r.status });
  return data;
}

// ---------- state, numeric ids (his page embeds ids unquoted in onclick handlers) ----------
function desk() {
  const s = db.load();
  s.desk = s.desk || { next_company_id: 1, next_buyer_id: 1, deals: [], next_deal_id: 1, dialogues: 0, runs: [], targets: [], next_target_id: 1 };
  return s.desk;
}
function ensureIds() {
  const s = db.load(); const d = desk(); let changed = false;
  for (const c of [...s.companies].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) if (!c.desk_id) { c.desk_id = d.next_company_id++; changed = true; }
  for (const b of s.buyers) if (!b.desk_id) { b.desk_id = d.next_buyer_id++; changed = true; }
  if (changed) db.save();
}
const companyByDesk = (id) => { ensureIds(); return db.load().companies.find((c) => c.desk_id === Number(id)) || null; };
const buyerByDesk = (id) => { ensureIds(); return db.load().buyers.find((b) => b.desk_id === Number(id)) || null; };
function log(event, payload) { const d = desk(); d.dialogues++; d.last_event = { ts: iso(), event, ...payload }; db.save(); }

// Screened companies used to live only on desk.deals. The Pipeline homepage lists
// /api/prospects (db.companies), so "Add to pipeline" then going home dropped them.
function countryFromProfile(p) {
  const hint = String(p?.geographic_hint || p?.source_url || "").toLowerCase();
  return /germany|dach|gmbh|\.de(?:\/|$)/.test(hint) ? "DE" : /sweden|\.se(?:\/|$)/.test(hint) ? "SE" : /norway|\.no(?:\/|$)/.test(hint) ? "NO" : /denmark|\.dk(?:\/|$)/.test(hint) ? "DK" : "FI";
}
function findCompanyFromProfile(p) {
  if (p?.engine_id) { const c = db.findCompany(p.engine_id); if (c) return c; }
  if (p?.company_id) { const c = companyByDesk(p.company_id); if (c) return c; }
  const s = db.load();
  const site = siteKey(p?.source_url);
  const name = String(p?.company_name || "").trim().toLowerCase();
  return s.companies.find((c) => (site && siteKey(c.website) === site) || (name && c.name.toLowerCase() === name)) || null;
}
function upsertCompanyFromProfile(p, extra = {}) {
  const name = extra.company || p?.company_name; if (!name) return null;
  let c = findCompanyFromProfile({ ...p, company_name: name });
  if (c) {
    if (!c.website && p?.source_url) c.website = p.source_url;
    if (!c.industry && p?.sector && p.sector !== "Unverified Sector") c.industry = p.sector;
    db.touch(c); ensureIds(); return c;
  }
  c = db.normalizeCompany({ name, country: extra.country || countryFromProfile(p), website: p?.source_url || "", industry: p?.sector && p.sector !== "Unverified Sector" ? p.sector : "", owner: { name: extra.ceo || p?.owner_name || "" }, source: extra.source || "Buy-side screen", notes: p?.products && p.products !== "Pending Analysis" ? `Website: ${p.products}` : "" });
  db.load().companies.unshift(c); ensureIds(); db.save(); return c;
}

// ---------- mapping our records → his shapes ----------
const COUNTRY_NAME = { FI: "Finland", SE: "Sweden", NO: "Norway", DK: "Denmark", DE: "Germany", AT: "Austria", CH: "Switzerland", IS: "Iceland" };
const REGION = { FI: "Nordics", SE: "Nordics", NO: "Nordics", DK: "Nordics", IS: "Nordics", DE: "DACH", AT: "DACH", CH: "DACH" };
const OWNERSHIP = { "founder-owned": "founder", "family-owned": "family", "pe-backed": "pe", "management-owned": "management" };
const geoWords = (c) => `${COUNTRY_NAME[c.country] || c.country || ""} ${REGION[c.country] || ""} ${c.city || ""} ${(c.enrichment?.footprint?.sales_markets || []).join(" ")}`.toLowerCase().trim();
const fmtEur = (n) => (n == null ? null : `€${(n / 1e6).toFixed(1)}M`);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function toDeskBuyer(b) {
  const geo = (b.geographies || []).map((g) => g === "EU" ? "Europe" : COUNTRY_NAME[g] || g);
  const region = (b.geographies || []).every((g) => REGION[g] === "Nordics") && geo.length ? "Nordics" : (b.geographies || []).every((g) => REGION[g] === "DACH") && geo.length ? "DACH" : "";
  return {
    id: b.desk_id, buyer_name: b.name, target_sector: (b.sectors || []).join(" / "), min_ebitda_eur: b.ebitda_min_eur ?? 0, max_ebitda_eur: b.ebitda_max_eur ?? 0,
    geographic_focus: [region, ...geo].filter(Boolean).join(" · ") || "Europe", buyer_type: b.buyer_type, deal_types: b.deal_types || [], thesis: b.thesis || "", active: b.active !== false, source: b.source || "mandate", contacts: b.contacts || [],
  };
}
const deskBuyers = () => { ensureIds(); return db.load().buyers.filter((b) => b.active !== false).map(toDeskBuyer); };

// Signals in his vocabulary, from everything we know: sourced research facts, enrichment, the scoring agent, register
// owner ages, intake answers and triaged replies. Each carries where it came from.
function classify(text) {
  const t = String(text || "").toLowerCase();
  if (/acqui|merger|joins forces|takeover|bought|purchase of/.test(t)) return "acquisition";
  if (/succession|successor|retire|next generation|second generation|handover|owner (is |aged )\d|aged \d\d|years at the helm|founder since|no successor/.test(t)) return "succession";
  if (/new ceo|appointed|named ceo|managing director|leadership change|steps down|resign/.test(t)) return "management_change";
  if (/owner(ship)? change|sold to|new owner|private equity|pe-backed|majority stake|renamed|name changed/.test(t)) return "ownership_change";
  if (/capital|financing|funding|investment round|loan|debt|partner needed|raise/.test(t)) return "capital_need";
  if (/hiring|record|growth|expan|new plant|opened|new site|doubl|contract|won|export/.test(t)) return "growth";
  return null;
}
function deskSignals(c) {
  const out = [], seen = new Set();
  const add = (signal_type, headline, { date = null, source = "", url = "", evidence = "" } = {}) => {
    if (!signal_type || !headline) return; const k = signal_type + "|" + headline.slice(0, 80); if (seen.has(k)) return; seen.add(k);
    out.push({ company_id: c.desk_id, signal_type, date, headline, source, url, evidence });
  };
  for (const f of c.research?.facts || []) if (f.confidence !== "low") add(classify(`${f.category} ${f.claim}`) || (f.category === "events" ? "growth" : null), f.claim, { date: f.as_of || null, source: f.source ? `Web research (${f.source})` : "Web research", url: f.url || "", evidence: f.quote || "" });
  const enrichedOn = c.enrichment?.enriched_at ? String(c.enrichment.enriched_at).slice(0, 10) : null;
  for (const n of c.enrichment?.recent_news || []) add(classify(n), n, { date: enrichedOn, source: "Enrichment agent" });
  for (const s of c.enrichment?.signals || []) add(classify(s), s, { date: null, source: "Enrichment agent" });
  for (const s of c.score?.signals || []) if (s.direction === "positive") add(classify(`${s.signal} ${s.note}`), s.signal, { date: s.source === "reply" ? (c.score.rescored_at || "").slice(0, 10) : null, source: s.source === "reply" ? "Owner reply" : "Scoring agent", evidence: s.note || "" });
  const o = c.owner || {};
  // Owner age: 60+ is an explicit succession trigger (dated today, full strength); 55–59 is covered by his derived
  // founder-generation rule so the whole book does not land in tier A.
  if (o.age && o.age >= 60) add("succession", `Owner ${o.name || ""} is ${o.age}${o.tenure_years ? ` and has led the company for ${o.tenure_years} years` : ""}`.trim(), { date: today().toISOString().slice(0, 10), source: o.age_source || "Prospect profile" });
  if (c.intake?.summary) { const s = c.intake.summary; if (s.motivation) add(classify(s.motivation) || "succession", `Owner intake: ${s.motivation}`, { date: (c.intake.completed_at || "").slice(0, 10), source: "Owner intake" }); if (s.timing) add("capital_need", `Owner intake timing: ${s.timing}`, { date: (c.intake.completed_at || "").slice(0, 10), source: "Owner intake" }); }
  for (const e of c.conversation || []) for (const f of e.triage?.extracted_facts || []) add(classify(`${f.field} ${f.value}`), `${cap(String(f.field).replace(/_/g, " "))}: ${f.value}`, { date: String(e.at || "").slice(0, 10), source: "Owner reply", evidence: e.text?.slice(0, 160) || "" });
  out.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  return out;
}
const isReal = (c) => Boolean(c.registry_id || c.research?.facts?.length || /registry|scraper|inbound|referral|buy-side/i.test(c.source || ""));
// The desk page prints evidence as text ("Found on the site: …"), so it is a list of short strings, never objects.
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
const siteKey = (u) => { if (!u) return ""; try { const x = new URL(/^https?:/i.test(u) ? u : `https://${u}`); return `${x.hostname.replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "")}`.toLowerCase(); } catch { return ""; } };
const EVIDENCE_ORDER = { customers: 0, offering: 1, financials: 2, footprint: 3, events: 4 };
function evidenceStrings(c) {
  const facts = (c.research?.facts || []).filter((f) => f.confidence !== "low");
  return [...facts].sort((a, b) => (EVIDENCE_ORDER[a.category] ?? 9) - (EVIDENCE_ORDER[b.category] ?? 9)).slice(0, 6)
    .map((f) => `${clip(f.claim, 90)}${hostOf(f.url) ? ` (${hostOf(f.url)})` : ""}`);
}
function toRecord(c) {
  const e = c.enrichment || {};
  const ceo = (c.people || []).find((p) => p.role_code === "DAGL")?.name || (/(ceo|managing|toimitusjohtaja|geschäftsführer)/i.test(c.owner?.title || "") ? c.owner?.name : "") || "";
  const provenance = {};
  const src = new Set(["seed"]);
  for (const k of ["company_name", "country", "website", "sector", "founded_year", "revenue_eur", "ebitda_eur", "employees", "ownership_type", "owner_name"]) provenance[k] = "seed";
  if (c.registry_id) { src.add("registry"); provenance.business_id = "registry"; provenance.founded_year = "registry"; }
  if (c.research?.financials) { provenance.revenue_eur = "registry"; provenance.ebitda_eur = "registry"; }
  if (c.people?.length) { provenance.owner_name = "registry"; provenance.ceo_name = "registry"; }
  if (c.research?.facts?.length) { src.add("website"); provenance.products = "website"; provenance.customers = "website"; }
  if (e.summary) { src.add("research"); provenance.sector = provenance.sector === "seed" && e.offering ? "research" : provenance.sector; }
  if (c.intake?.summary) src.add("intake");
  if ((c.conversation || []).some((x) => x.triage)) src.add("reply");
  const company = {
    company_id: c.desk_id, company_name: c.name, legal_name: c.name, country: c.country, country_name: COUNTRY_NAME[c.country] || c.country, region: REGION[c.country] || "",
    sector: c.industry || "", products: (e.products || []).join(", ") || e.offering?.summary || "", customers: (e.customers || []).join(", ") || (e.customer_segments || []).map((s) => s.segment).join(", ") || "",
    founded_year: c.founded || null, revenue_eur: c.revenue_eur ?? null, ebitda_eur: c.ebitda_eur ?? null, employees: c.employees ?? null,
    ownership_type: OWNERSHIP[c.ownership_type] || "", owner_name: c.owner?.name || "", ceo_name: ceo, owner_age: c.owner?.age || null, website: c.website || "", business_id: c.registry_id || "",
    city: c.city || "", geographic_hint: geoWords(c), evidence: evidenceStrings(c),
    data_origin: isReal(c) ? "real" : "illustrative", stage_ours: c.stage, readiness: c.score?.readiness ?? null, engine_id: c.id, source_label: c.source || "",
  };
  return {
    company, signals: deskSignals(c), provenance, sources_used: [...src],
    registry: c.registry_id ? { status: "ok", business_id: c.registry_id, legal_name: c.name, city: c.city || "", industry: c.industry || "", founded_year: c.founded || null, registered_on: c.founded ? `${c.founded}-01-01` : "", previous_names: [], people: c.people || [], source: c.people_source || (c.source || "").replace(/^Registry: /, "") } : null,
    website: c.research?.facts?.length ? { fetched: true, verified: Boolean(e.research_based || c.research.facts.length >= 5), source_url: c.website || "", sector: c.industry || "", products: company.products, customers: company.customers, pages_read: c.research.pages_read ?? null, evidence: company.evidence } : null,
    enriched_at: c.research?.researched_at || c.research?.fetched_at || e.enriched_at || null, new_signals: [],
  };
}

// CRM view of our pipeline stages and conversations.
const STAGE_MAP = { new: "Prospect", enriched: "Prospect", outreach_ready: "Prospect", contacted: "Contacted", replied: "Replied", warming: "Qualified", meeting_booked: "Advisor handoff", mandate_signed: "Mandate", disqualified: "Replied" };
const INTENT_MAP = { interested: "interested_now", curious: "interested_now", info_request: "interested_now", referral: "needs_advisor", not_now: "interested_later", not_interested: "not_interested", other: "needs_advisor" };
function qualificationFor(entry, c, scored, hypothesis) {
  if (entry.desk_q) return entry.desk_q; // rule-based qualification recorded when no model was available
  const t = entry.triage; if (!t) return null;
  const text = entry.text || "";
  const category = /unsubscribe|remove me|stop emailing|abmelden|älä lähetä|avregistrera/i.test(text) ? "unsubscribe" : INTENT_MAP[t.intent] || "needs_advisor";
  const cls = { category, timing: null, reason: t.next_step || `Owner intent: ${t.intent} (${t.sentiment})`, source: "model", confidence: 0.9 };
  return E.qualifyReply(text, { prospectScore: scored?.score ?? null, mandateType: hypothesis?.mandate_type || null, classification: cls });
}
// The engine drafts an answer (step-0 message) every time the owner writes; the desk shows the one for the last reply.
const REPLY_DONE = new Set(["sent", "replied", "bounced", "cancelled", "rejected"]);
function replyDraftOf(c) {
  const lastIn = [...(c.conversation || [])].reverse().find((e) => e.direction === "inbound" && e.channel !== "intake");
  if (!lastIn) return null;
  const m = (c.messages || []).find((x) => x.step === 0 && x.in_reply_to === lastIn.id && !REPLY_DONE.has(x.status));
  if (!m) return null;
  const l = m.lint?.after;
  return { id: m.id, subject: m.subject || "", body: m.body || "", status: m.status, human_check: l ? { score: l.score, grade: l.grade } : null };
}
function deskConversation(c, scored, hypothesis) {
  const thread = [];
  let last = null, lastCat = null;
  for (const e of c.conversation || []) {
    if (e.direction === "outbound") { const m = String(e.text || "").match(/^Subject: (.*)\n\n([\s\S]*)$/); thread.push({ direction: "out", at: e.at, channel: cap(e.channel || "email"), subject: m ? m[1] : null, text: m ? m[2] : e.text }); }
    else if (e.channel !== "intake") { const q = qualificationFor(e, c, scored, hypothesis); thread.push({ direction: "in", at: e.at, text: e.text, qualification: q }); if (q) { last = q; lastCat = q.category; } }
  }
  const closed = c.stage === "disqualified" || ["not_interested", "unsubscribe"].includes(lastCat || "");
  return { stage: STAGE_MAP[c.stage] || "Prospect", thread, follow_up_on: c.desk_follow_up_on || null, closed, outcome: c.stage === "mandate_signed" ? "mandate" : closed ? lastCat : null, last_category: lastCat, last_qualification: last, meetings: c.meetings || [], reply_draft: replyDraftOf(c), handoff: c.desk_handoff || null };
}
const TONE = { open: "Direct and short, buyer-demand-led, 20-minute ask", growth: "Growth-partner framing, owner keeps control", minority: "Partial stake framing, money off the table, owner stays in charge", exit: "Gentle full-sale framing, no pressure on timing" };
// The sequence as his page shows it: sent touches stay; unsent drafts that duplicate an already-sent step (a re-plan
// after the first touch went out) are hidden, so step numbers stay unique.
function sequenceMessages(c) {
  const all = (c.messages || []).filter((m) => m.step > 0);
  const sentSteps = new Set(all.filter((m) => m.sent_at).map((m) => m.step));
  return all.filter((m) => m.sent_at || !sentSteps.has(m.step)).sort((a, b) => a.step - b.step || String(b.created_at || "").localeCompare(String(a.created_at || "")));
}
function deskCampaign(c) {
  const msgs = sequenceMessages(c);
  if (!msgs.length) return null;
  const sequence = msgs.map((m, i) => ({ step: i, day: m.send_after_days ?? 0, channel: m.channel === "linkedin" ? "LinkedIn" : m.channel === "call_script" ? "Phone" : "Email", subject: m.subject || "", body: m.body || "", send_at: m.send_at || null, status: m.status === "sent" || m.status === "replied" ? "sent" : ["cancelled", "rejected", "bounced"].includes(m.status) ? "cancelled" : "drafted", sent_at: m.sent_at || null, source: m.template ? "template" : m.humanizer ? "model+humanizer" : "model", message_id: m.id, human_check: m.lint?.after ? { score: m.lint.after.score, grade: m.lint.after.grade, facts_used: m.lint.after.personalization?.count ?? null } : null, framing: m.framing || null }));
  const stopped = c.stage === "disqualified" || (sequence.some((s) => s.status === "cancelled") && !sequence.some((s) => s.status === "drafted"));
  return { channel: c.channel === "linkedin" ? "LinkedIn + phone" : "Email + LinkedIn", tone: TONE[msgs[0].framing] || TONE.open, contact_name: c.owner?.name || "", sequence, stopped, stop_reason: stopped ? (msgs.find((m) => m.cancel_reason)?.cancel_reason || "Owner replied or the prospect was closed") : null };
}

// One prospect, fully assembled in his vocabulary.
function bundle(c) {
  const record = toRecord(c);
  const triggers = E.detectTriggers(record);
  const scored = E.scoreProspect(record, triggers, deskBuyers());
  // Blend in the Claude readiness score where it exists: timing is half trigger strength, half readiness.
  if (c.score?.readiness != null) {
    const top = triggers[0]?.strength || 0;
    scored.timing = Math.round(40 * (0.5 * top + 0.5 * c.score.readiness / 100));
    scored.score = Math.min(100, scored.timing + scored.fit + scored.urgency);
    scored.tier = E.tierFor(scored.score);
    scored.explanation = [`Timing ${scored.timing}/40: strongest trigger ${triggers[0] ? `"${triggers[0].label}"` : "none yet"}, Mergero readiness ${c.score.readiness}/100`, ...scored.explanation.slice(1)];
    scored.readiness = c.score.readiness; scored.attractiveness = c.score.attractiveness ?? null; scored.why_now = c.score.why_now || null;
  }
  const hypothesis = E.buildHypothesis(record, triggers, scored);
  hypothesis.why_mergero = E.toPoints(hypothesis.why_mergero);
  hypothesis.why_now = hypothesis.why_now.flatMap((line) => E.toPoints(line, { max: 3, min: 6 }));
  if (c.score?.why_now) hypothesis.agent_notes = E.toPoints(c.score.why_now);
  if (c.enrichment?.data_gaps?.length) hypothesis.questions_for_owner = [...hypothesis.questions_for_owner, ...c.enrichment.data_gaps.slice(0, 2).map((g) => `Data gap: ${g}`)];
  const conversation = deskConversation(c, scored, hypothesis);
  const campaign = deskCampaign(c);
  let next_action = E.nextAction(conversation, campaign);
  // An owner wrote and the engine drafted the answer: replying is the next thing, before anything else.
  if (conversation.reply_draft && !conversation.closed && ["log_reply", "plan", "send", "wait", "follow_up"].includes(next_action.key)) next_action = { key: "reply", label: "Reply to the owner", step: 6 };
  return { record, triggers, scored, hypothesis, conversation, campaign, next_action };
}
function detail(c, b = bundle(c)) {
  return { company_id: c.desk_id, company: b.record.company, provenance: b.record.provenance, triggers: b.triggers, scored: b.scored, hypothesis: b.hypothesis, campaign: b.campaign, conversation: b.conversation, next_action: b.next_action, stage_labels: E.CRM_STAGES.map((s) => E.STAGE_LABELS[s]) };
}
function prospectRow(c, b = bundle(c)) {
  const q = b.conversation.last_qualification || {};
  return {
    company_id: c.desk_id, company_name: c.name, country: c.country, country_name: COUNTRY_NAME[c.country] || c.country, sector: c.industry || "", data_origin: b.record.company.data_origin,
    score: b.scored.score, tier: b.scored.tier, timing: b.scored.timing, fit: b.scored.fit, urgency: b.scored.urgency, top_trigger: b.triggers[0] || null, top_buyer: b.scored.best_buyers[0] || null,
    mandate_count: (b.scored.best_buyers || []).length,
    mandate_type: b.hypothesis.mandate_type, side: b.hypothesis.side, stage: b.conversation.stage, stage_label: E.STAGE_LABELS[b.conversation.stage], closed: b.conversation.closed,
    mandate_likelihood: q.mandate_likelihood ?? null, follow_up_on: b.conversation.follow_up_on, next_action: b.next_action, readiness: c.score?.readiness ?? null, engine_id: c.id,
    // His row sets "timing" twice; the page reads the second one (the owner's reply timing) in the likelihood tooltip.
    timing: q.timing != null ? q.timing : b.scored.timing, timing_points: b.scored.timing,
  };
}
const allProspects = () => { ensureIds(); return db.load().companies.map((c) => ({ c, b: bundle(c) })).sort((x, y) => y.b.scored.score - x.b.scored.score); };

// Quick profile of a company website for the buy-side screen (fast; the full research crawler is for prospects).
const SECTOR_RULES = A.SECTOR_RULES;
const SECTOR_NAMES = new Set(SECTOR_RULES.map(([name]) => name));
async function quickProfile(url) {
  const u = url.startsWith("http") ? url : `https://${url}`;
  let html = "";
  try { const r = await fetch(u, { headers: { "user-agent": "Mozilla/5.0 MergeroDesk/1.0" }, signal: AbortSignal.timeout(12000) }); html = await r.text(); } catch (e) { return { company_name: new URL(u).hostname.replace(/^www\./, ""), sector: "Unverified Sector", products: "Pending Analysis", customers: "Pending Analysis", ebitda: "Pending Audit", verified: false, fetched: false, evidence: [], source_url: u, geographic_hint: "", error: e.message }; }
  // A space before each closing block/inline tag so words in neighbouring elements do not glue together ("maskinpark" + "Vi").
  const $ = cheerio.load(html.replace(/<br\s*\/?>/gi, " ").replace(/<\/(?:p|div|li|h[1-6]|td|th|tr|section|article|span|a|header|footer|nav|button|label|strong|em)>/gi, " $&"));
  $("script,style,nav,footer").remove();
  const text = $("body").text().replace(/\s+/g, " ").slice(0, 20000);
  const name = ($('meta[property="og:site_name"]').attr("content") || $("title").text().split(/[|–-]/)[0] || new URL(u).hostname).trim();
  const desc = ($('meta[name="description"]').attr("content") || $('meta[property="og:description"]').attr("content") || "").trim();
  const head = desc + " " + text.slice(0, 4000);
  const rule = SECTOR_RULES.find(([, re]) => re.test(head));
  const sector = rule?.[0] || "";
  // The matched words, cleaned: letters only, glued tokens dropped, one entry per stem ("maskinpark", not "maskinpark2").
  const seen = new Set();
  const words = rule ? (head.match(new RegExp(rule[1].source, "gi")) || []).map((w) => w.toLowerCase().replace(/[^\p{L}]/gu, "")).filter((w) => w.length >= 3 && w.length <= 14 && !seen.has(w.slice(0, 8)) && seen.add(w.slice(0, 8))).slice(0, 4) : [];
  const geo = ["finland", "sweden", "norway", "denmark", "germany", "austria", "switzerland", "helsinki", "nordic", "europe"].filter((w) => text.toLowerCase().includes(w)).join(" ");
  const evidence = [words.length ? `Sector words on the site: ${words.join(", ")}` : "", desc ? `“${clip(desc, 140)}”` : ""].filter(Boolean);
  return { company_name: name, sector: sector || "Unverified Sector", products: desc || "Pending Analysis", customers: "Pending Analysis", ebitda: "Pending Audit", verified: Boolean(sector), fetched: true, evidence, source_url: u, geographic_hint: geo };
}

// A screen profile for a company we hold: the engine's mapping plus what the deep analysis knows (EBITDA with its
// source, named customers, the offering in one line) and a sector label the buyer matcher understands.
function profileOf(c, r = toRecord(c)) {
  const p = { ...E.toProfile(r), engine_id: c.id, company_id: c.desk_id, ...A.profileOverrides(c) };
  if (!SECTOR_NAMES.has(p.sector)) {
    const e = c.enrichment;
    const hint = A.sectorHint(e ? `${e.offering?.summary || ""} ${(e.products || []).join(" ")} ${e.summary || ""}` : `${c.industry || ""} ${c.notes || ""}`);
    if (hint) p.sector = hint;
  }
  return p;
}

// ---------- routes ----------
// Four paths exist in both APIs with different shapes (/api/buyers, /api/companies, /api/companies/:id, …/enrich).
// Our own UI reaches its versions through /api/engine/… (rewritten to /api/… with req.legacy set), so those fall through.
const unlessLegacy = (h) => (req, res, next) => (req.legacy ? next() : h(req, res, next));
export function legacyRewrite(req, res, next) {
  if (req.url.startsWith("/api/engine/")) { req.url = "/api/" + req.url.slice("/api/engine/".length); req.legacy = true; }
  next();
}
export function register(app, { baseUrl } = {}) {
  if (baseUrl) BASE_URL = baseUrl;
  app.use(legacyRewrite);
  // "/" is the classic desk with its guided tour. The pitch front door stays reachable at /front for reference.
  app.get("/", (req, res) => res.sendFile(PAGE));
  app.get("/front", (req, res) => res.sendFile(path.join(here, "..", "..", "public", "front", "index.html")));
  app.get("/desk", (req, res) => res.sendFile(PAGE));

  // Buyers, screening and deals (the Buy-side screen tab)
  app.get("/api/buyers", unlessLegacy((req, res) => { const b = deskBuyers(); res.json({ status: "success", count: b.length, data: b }); }));
  app.post("/api/scrape", wrap(async (req, res) => { if (!req.body?.url) return res.json({ status: "error", message: "No URL provided" }); const p = await quickProfile(req.body.url); log("scrape", { company: p.company_name }); res.json({ status: "success", data: p }); }));
  app.post("/api/match", wrap(async (req, res) => {
    let profile = req.body?.profile || {};
    if (req.body?.url && !profile.company_name) profile = await quickProfile(req.body.url);
    if (!profile || !Object.keys(profile).length) return errorJson(res, 400, "profile or url required");
    const ranked = E.rankBuyers(deskBuyers(), profile);
    // Our matching agent's reasons, where it has already looked at this company.
    const c = profile.engine_id ? db.findCompany(profile.engine_id) : profile.company_id ? companyByDesk(profile.company_id) : null;
    if (c?.matches?.length) for (const m of ranked) { const ours = c.matches.find((x) => db.load().buyers.find((b) => b.id === x.buyer_id)?.desk_id === m.buyer_id); if (ours) { m.reasons = [`Mergero matching agent (${ours.fit}% fit): ${ours.reason}`, ...m.reasons]; m.agent_fit = ours.fit; } }
    log("match", { company: profile.company_name, score: ranked[0]?.score ?? null, buyer: ranked[0]?.buyer_name ?? null });
    res.json({ status: "success", profile, matches: ranked, stats: E.summarizeMatches(ranked) });
  }));
  const serializeDeal = (d) => ({ id: d.id, buyer: d.buyer_name, buyer_id: d.buyer_id, target: d.profile?.company_name || d.target || "Target", mix: [d.profile?.products, d.profile?.customers].filter((x) => x && x !== "Pending Analysis").join(" / ") || "Not screened yet", sector: d.profile?.sector || "", ebitda: d.profile?.ebitda || "", stage: d.stage, score: d.match?.score ?? null, reasons: d.match?.reasons || [], gaps: d.match?.gaps || [], proposal: d.proposal || "", owner_name: d.owner_name || "", source_url: d.profile?.source_url || "", verified: Boolean(d.profile?.verified), evidence: d.profile?.evidence || [] });
  app.get("/api/deals", (req, res) => { const d = desk().deals; res.json({ status: "success", count: d.length, data: d.map(serializeDeal) }); });
  app.post("/api/deals", wrap(async (req, res) => {
    const buyerName = String(req.body?.buyer || req.body?.buyer_name || "").trim(), target = String(req.body?.target || "").trim();
    if (!buyerName || !target) return errorJson(res, 400, "buyer and target are required");
    const buyer = deskBuyers().find((b) => b.buyer_name.toLowerCase() === buyerName.toLowerCase());
    const profile = { company_name: target, sector: req.body.sector || buyer?.target_sector || "Unverified Sector", products: req.body.products || "Pending Analysis", customers: req.body.customers || "Pending Analysis", ebitda: req.body.ebitda || "Pending Audit", verified: false, source_url: req.body.source_url || "", geographic_hint: buyer?.geographic_focus || "" };
    const match = buyer ? E.rankBuyers([buyer], profile)[0] : {};
    const company = upsertCompanyFromProfile(profile, { source: "Buy-side screen" });
    const d = desk(); const deal = { id: d.next_deal_id++, buyer_id: buyer?.id ?? null, buyer_name: buyerName, profile, match, stage: E.STAGES[0], proposal: E.icNote(buyerName, profile, match), company_id: company?.id || null, desk_company_id: company?.desk_id || null };
    d.deals.unshift(deal); log("deal_created", { buyer: buyerName, company: target }); res.json({ status: "success", data: serializeDeal(deal) });
  }));
  app.post("/api/deals/from-match", wrap(async (req, res) => {
    const profile = req.body?.profile || {}; const buyer = deskBuyers().find((b) => b.id === Number(req.body?.buyer_id));
    if (!buyer) return errorJson(res, 404, "Unknown buyer_id");
    const match = E.rankBuyers([buyer], profile)[0] || {};
    const company = upsertCompanyFromProfile(profile, { source: "Buy-side screen" });
    const d = desk(); const deal = { id: d.next_deal_id++, buyer_id: buyer.id, buyer_name: buyer.buyer_name, profile, match, stage: E.STAGES[0], proposal: E.icNote(buyer.buyer_name, profile, match), company_id: company?.id || null, desk_company_id: company?.desk_id || null };
    d.deals.unshift(deal); log("deal_from_match", { buyer: buyer.buyer_name, company: profile.company_name }); res.json({ status: "success", data: serializeDeal(deal) });
  }));
  app.patch("/api/deals/:id", wrap(async (req, res) => {
    const deal = desk().deals.find((x) => x.id === Number(req.params.id)); if (!deal) return errorJson(res, 404, "Deal not found");
    const b = req.body || {};
    if (b.stage) { if (!E.STAGES.includes(b.stage)) return errorJson(res, 400, `Invalid stage. Use: ${E.STAGES.join(", ")}`); deal.stage = b.stage; }
    if ("proposal" in b) deal.proposal = b.proposal || "";
    if ("owner_name" in b) { deal.owner_name = String(b.owner_name || "").trim(); if (deal.owner_name && E.STAGES.indexOf("Owner identified") > E.STAGES.indexOf(deal.stage)) deal.stage = "Owner identified"; }
    db.save(); res.json({ status: "success", data: serializeDeal(deal) });
  }));
  app.delete("/api/deals/:id", (req, res) => { const d = desk(); const n = d.deals.length; d.deals = d.deals.filter((x) => x.id !== Number(req.params.id)); if (d.deals.length === n) return errorJson(res, 404, "Deal not found"); db.save(); res.json({ status: "success" }); });
  app.post("/api/deals/:id/outreach", wrap(async (req, res) => {
    const deal = desk().deals.find((x) => x.id === Number(req.params.id)); if (!deal) return errorJson(res, 404, "Deal not found");
    const kind = String(req.body?.kind || "ic").toLowerCase();
    if (req.body?.owner_name) { deal.owner_name = String(req.body.owner_name).trim(); if (E.STAGES.indexOf("Owner identified") > E.STAGES.indexOf(deal.stage)) deal.stage = "Owner identified"; }
    let message;
    if (kind === "owner") { message = E.ownerWarmup(deal.profile, deal.match, deal.owner_name || "there"); if (E.STAGES.indexOf("Warm-up drafted") > E.STAGES.indexOf(deal.stage)) deal.stage = "Warm-up drafted"; }
    else message = E.icNote(deal.buyer_name, deal.profile, deal.match);
    deal.proposal = message; db.save(); log("outreach", { buyer: deal.buyer_name, company: deal.profile?.company_name });
    res.json({ status: "success", kind, outreach_message: message, data: serializeDeal(deal) });
  }));

  // Sell-side targets: prospects whose owners have told us their numbers (intake) — real, not a hard-coded table.
  const targetRow = (c, i) => { const s = c.intake?.summary || {}; return { id: c.desk_id, company: c.name, region: REGION[c.country] || "Nordics", channel: c.channel === "linkedin" ? "LinkedIn / Call" : "Email", ceo: c.owner?.name || "Owner", revenue_split: s.revenue_split || (c.enrichment?.products || []).join(", ") || "Pending owner confirmation", top_clients: s.top_clients_concentration || "Pending owner confirmation", valuation_est: c.score?.valuation_band_eur ? `€${(c.score.valuation_band_eur.low / 1e6).toFixed(0)}–${(c.score.valuation_band_eur.high / 1e6).toFixed(0)}M` : "€3–5M band", status: (c.messages || []).some((m) => m.step > 0) ? "Warm-up drafted" : "Ready for Warm-Up", source_url: c.website || "", engine_id: c.id }; };
  app.get("/api/targets", (req, res) => { ensureIds(); const rows = db.load().companies.filter((c) => c.intake?.summary || ["warming", "meeting_booked", "mandate_signed"].includes(c.stage)).map(targetRow); res.json({ status: "success", data: rows }); });
  app.post("/api/targets", wrap(async (req, res) => {
    const p = req.body?.profile || {}; const name = req.body?.company || p.company_name; if (!name) return errorJson(res, 400, "company required");
    const c = upsertCompanyFromProfile({ ...p, company_name: name }, { ceo: req.body?.ceo, source: "Buy-side screen" });
    log("sell_side_target", { company: name });
    res.json({ status: "success", data: targetRow(c) });
  }));
  // Dig deeper on a screened company (or a pipeline deal): more pages, filed accounts + statement PDF, named customers.
  const PROFILE_KEYS = ["sector", "products", "customers", "ebitda", "ebitda_detail", "verified", "fetched", "evidence", "engine_id", "company_id", "source_url", "geographic_hint", "analysis"];
  app.post("/api/analyze", wrap(async (req, res) => {
    const b = req.body || {}; let c = null, deal = null;
    if (b.deal_id != null) {
      deal = desk().deals.find((x) => x.id === Number(b.deal_id)); if (!deal) return errorJson(res, 404, "Deal not found");
      c = (deal.company_id && db.findCompany(deal.company_id)) || upsertCompanyFromProfile(deal.profile || {}, { source: "Buy-side screen" });
    } else if (b.company_id != null) c = companyByDesk(b.company_id);
    else if (b.profile && Object.keys(b.profile).length) c = upsertCompanyFromProfile(b.profile, { source: "Buy-side screen" });
    if (!c) return errorJson(res, 400, "profile, company_id or deal_id required");
    if (!c.website && b.profile?.source_url) c.website = b.profile.source_url;
    const s = db.load();
    await agents.runTracked(c.id, () => A.analyze(c, s.settings, { force: Boolean(b.force), log: (m) => console.log(`[analyze] ${c.name}: ${m}`) }), "analyze");
    const profile = profileOf(c);
    const matches = E.rankBuyers(deskBuyers(), profile);
    // Deals already holding this company get the new facts and a fresh match.
    const touched = [];
    for (const d of desk().deals) {
      const same = d.company_id === c.id || (d.profile?.company_name || "").toLowerCase() === c.name.toLowerCase() || (siteKey(d.profile?.source_url) && siteKey(d.profile?.source_url) === siteKey(c.website));
      if (!same) continue;
      d.profile = { ...(d.profile || {}), ...Object.fromEntries(PROFILE_KEYS.map((k) => [k, profile[k]])), company_name: d.profile?.company_name || c.name };
      d.company_id = c.id; d.desk_company_id = c.desk_id;
      const buyer = deskBuyers().find((x) => x.id === d.buyer_id); if (buyer) d.match = E.rankBuyers([buyer], d.profile)[0] || d.match;
      touched.push(d);
    }
    db.save(); log("analyze", { company: c.name, ebitda: profile.ebitda, cached: Boolean(profile.analysis?.cached) });
    res.json({ status: "success", profile, matches, stats: E.summarizeMatches(matches), analysis: profile.analysis, summary: A.summaryLine(c), deals: touched.map(serializeDeal), deal: deal ? serializeDeal(deal) : null });
  }));
  app.post("/api/generate-outreach/:id", wrap(async (req, res) => {
    const c = companyByDesk(req.params.id); if (!c) return res.status(404).json({ error: "Target not found" });
    let message;
    try { const r = await call("POST", `/api/companies/${c.id}/outreach`, { language: c.channel === "linkedin" ? "de" : "en", framing: "open", touches: 4 }); message = (r.messages || []).filter((m) => m.step === 1).pop()?.body || ""; }
    catch { message = E.sellSideWarmup(targetRow(c)); }
    log("sell_side_outreach", { company: c.name });
    res.json({ status: "success", target: c.name, channel: c.channel === "linkedin" ? "LinkedIn / Call" : "Email", outreach_message: message });
  }));

  // Data sources tab
  app.get("/api/sources", wrap(async (req, res) => {
    ensureIds(); const s = db.load(); const comps = s.companies;
    const real = comps.filter(isReal).length, signals = comps.reduce((n, c) => n + deskSignals(c).length, 0);
    let son = { ok: false }; try { son = await (await import("../adapters/son_scraper.js")).available(); } catch { /* optional */ }
    const mailOn = Boolean((s.settings.mail?.resend_api_key || process.env.RESEND_API_KEY) && (s.settings.mail?.from || process.env.RESEND_FROM));
    const mgx = s.buyers.filter((b) => /mgx/i.test(b.source || "")).length;
    const entered = s.buyers.length - mgx;
    const fi = comps.filter((c) => c.country === "FI").length;
    const no = comps.filter((c) => c.country === "NO").length;
    const demo = comps.length - real;
    const succession = comps.reduce((n, c) => n + deskSignals(c).filter((x) => x.signal_type === "succession" || x.type === "succession").length, 0);
    const modelOn = llm.provider(s.settings) === "verda" ? llm.verdaConfigured(s.settings) : Boolean(s.settings.api_key || process.env.ANTHROPIC_API_KEY);
    const modelName = llm.provider(s.settings) === "verda" ? "Mistral" : "Claude";
    const verdaLabel = (id) => /small/i.test(id || "") ? "Mistral Small 3" : /large/i.test(id || "") ? "Mistral Large 3" : (id || "Mistral");
    const chip = (label, tone) => (label ? { label, tone } : null);
    res.json({ status: "success", data: [
      { key: "buyers", name: "Buyer mandates", type: "internal", count: s.buyers.filter((b) => b.active !== false).length, status: "loaded", tags: [chip("Internal", "slate"), chip("sector", "slate"), chip("geography", "sky"), chip("size", "amber"), chip(entered ? `${entered} entered` : null, "emerald")].filter(Boolean), detail: `${s.buyers.length} mandates (${mgx} from MGX sync, ${entered} entered); sector, geography, size and deal type` },
      { key: "companies", name: "Company universe", type: "internal", count: comps.length, status: "loaded", tags: [chip("Internal", "slate"), chip(real ? `${real} real` : null, "emerald"), chip(fi ? `${fi} FI` : null, "sky"), chip(no ? `${no} NO` : null, "sky"), chip(demo ? `${demo} illustrative` : null, "slate")].filter(Boolean), detail: `${real} real companies (registers, research, inbound), ${demo} illustrative` },
      { key: "signals", name: "Signals and triggers", type: "public", count: signals, status: "loaded", tags: [chip("Public", "sky"), chip(succession ? `${succession} succession` : "registers", "rose"), chip("owner age", "amber"), chip("12 months", "slate")].filter(Boolean), detail: "Sourced research facts, register facts, owner ages, intake answers and triaged replies, decayed over 12 months" },
      { key: "registry", name: "Finnish Trade Register (PRH)", type: "live", count: fi, status: "live", tags: [chip("Live", "emerald"), chip("Finland", "sky"), chip("industry", "slate"), chip("iXBRL", "amber")].filter(Boolean), detail: "Free open API: legal name, registration date, industry, filed accounts (iXBRL)" },
      { key: "brreg", name: "Norwegian register (Brønnøysund)", type: "live", count: no, status: "live", tags: [chip("Live", "emerald"), chip("Norway", "sky"), chip("roles", "slate"), chip("owner age", "amber")].filter(Boolean), detail: "Entities, filed accounts and the roles register: CEO and chair with birth dates = real owner age" },
      { key: "website", name: "Company websites", type: "live", count: comps.filter((c) => c.research?.facts?.length).length, status: "on demand", tags: [chip("Live", "emerald"), chip("on demand", "amber"), chip("crawl", "slate"), chip("quotes", "sky")].filter(Boolean), detail: "Robots-aware crawl of the company's own site plus localised web search; every fact keeps its quote and URL" },
      { key: "profiler", name: "Finnish company profiler (Son)", type: "live", count: comps.filter((c) => (c.research?.facts || []).some((f) => f.source === "son-scraper")).length, status: son.ok ? "live" : "not installed", tags: [chip("Live", "emerald"), chip("Finland", "sky"), chip(son.ok ? "PRH + XBRL" : "not installed", son.ok ? "amber" : "rose")].filter(Boolean), detail: son.ok ? "PRH + XBRL line items + website signals with per-fact evidence" : `Optional Python component (${son.reason || "see docs/python-setup.md"})` },
      { key: "intake", name: "Owner intake", type: "internal", count: comps.filter((c) => c.intake?.summary).length, status: "loaded", tags: [chip("Internal", "slate"), chip("EBITDA", "amber"), chip("timing", "sky"), chip("confidential", "violet")].filter(Boolean), detail: "Confidential owner questionnaire: revenue split, client concentration, EBITDA, timing, motivation" },
      { key: "email", name: "Email (Resend)", type: "live", count: comps.reduce((n, c) => n + (c.messages || []).filter((m) => m.sent_at).length, 0), status: mailOn ? (s.settings.demo_email ? `demo mode → ${s.settings.demo_email}` : "live") : "mailto only", tags: [chip("Live", "emerald"), chip(mailOn ? "Resend" : "mailto", mailOn ? "emerald" : "amber"), chip("follow-ups", "slate")].filter(Boolean), detail: "Real sending with per-advisor daily caps, scheduled follow-ups, replies triaged on arrival" },
      { key: "model", name: llm.provider(s.settings) === "verda" ? `Language model: ${verdaLabel(llm.verdaConfig(s.settings).model)} on Verda (EU)` : "Language model: Claude (Anthropic)", type: "live", count: comps.filter((c) => c.enrichment || c.score).length, status: llm.provider(s.settings) === "verda" ? (llm.verdaConfigured(s.settings) ? "configured" : "missing credentials") : (s.settings.api_key || process.env.ANTHROPIC_API_KEY ? "configured" : "missing key"), tags: [chip("Live", "emerald"), chip(modelName, "violet"), chip(modelOn ? "configured" : "no key", modelOn ? "emerald" : "rose"), chip("web search", "sky")].filter(Boolean), detail: llm.provider(s.settings) === "verda" ? `${llm.verdaConfig(s.settings).model} at ${llm.verdaConfig(s.settings).base_url || "?"}${llm.fallbackAllowed(s.settings) ? " · falls back to Claude" : " · strict EU-only"}` : `${s.settings.model} with web search, structured outputs` },
    ] });
  }));
  app.get("/api/companies", unlessLegacy((req, res) => {
    ensureIds();
    let rows = db.load().companies.map((c) => { const r = toRecord(c); const sig = r.signals; return { ...r.company, signal_count: sig.length, signal_types: [...new Set(sig.map((s) => s.signal_type))].sort(), latest_signal: sig[0] || null }; });
    const { country = "", sector = "", signal = "" } = req.query;
    if (country) rows = rows.filter((r) => String(r.country).toLowerCase() === String(country).toLowerCase());
    if (sector) rows = rows.filter((r) => String(r.sector || "").toLowerCase().includes(String(sector).toLowerCase()));
    if (signal) rows = rows.filter((r) => r.signal_types.includes(signal));
    res.json({ status: "success", count: rows.length, signal_types: E.SIGNAL_TYPES.map((k) => ({ key: k, label: E.SIGNAL_LABELS[k] })), data: rows });
  }));
  app.get("/api/companies/:id", unlessLegacy((req, res) => { const c = companyByDesk(req.params.id); if (!c) return errorJson(res, 404, "Company not found"); const r = toRecord(c); res.json({ status: "success", data: r, profile: profileOf(c, r) }); }));
  // Enrich = the fast, real sources now (register roles, Finnish profiler) and the full research in the background.
  app.post("/api/companies/:id/enrich", unlessLegacy(wrap(async (req, res) => {
    const c = companyByDesk(req.params.id); if (!c) return errorJson(res, 404, "Company not found");
    const before = deskSignals(c).length; const used = [];
    if (c.country === "NO" && c.registry_id && !c.people?.length) { try { await call("POST", `/api/companies/${c.id}/people`); used.push("registry"); } catch { /* optional */ } }
    if (c.country === "FI") { try { const son = await import("../adapters/son_scraper.js"); const r = await son.enrichCompany(c); if (r?.facts?.length) { c.research = c.research || { facts: [] }; const known = new Set((c.research.facts || []).map((f) => f.claim)); for (const f of r.facts) if (!known.has(f.claim)) c.research.facts.push(f); if (r.financials) { c.revenue_eur ??= r.financials.revenue_eur ?? null; c.ebitda_eur ??= r.financials.ebitda_eur ?? null; } if (!c.website && r.website) c.website = r.website; if (!c.registry_id && r.business_id) c.registry_id = r.business_id; if (r.people?.length && !c.owner?.name) c.owner = { ...(c.owner || {}), name: r.people[0].name, title: r.people[0].role }; db.touch(c); used.push("profiler"); } } catch (err) { console.warn(`[desk enrich] profiler: ${err.message}`); } }
    if (!c.research?.facts?.length || req.body?.deep) { call("POST", `/api/companies/${c.id}/research`).catch((err) => console.warn(`[desk enrich] research: ${err.message}`)); used.push("website (running)"); }
    const r = toRecord(c); r.new_signals = r.signals.slice(0, Math.max(0, r.signals.length - before)); r.sources_used = [...new Set([...r.sources_used, ...used])];
    log("enrich", { company: c.name, sources_used: r.sources_used });
    res.json({ status: "success", data: r, profile: profileOf(c, r) });
  })));

  // Ingestion: quick real-source pass now; the research crawler continues in the background job for the rest.
  app.post("/api/ingest", wrap(async (req, res) => {
    ensureIds(); const s = db.load(); const started = Date.now(); const live = Boolean(req.body?.live);
    const statuses = [];
    if (live) {
      const norwegians = s.companies.filter((c) => c.country === "NO" && c.registry_id && !c.people?.length).slice(0, 12);
      for (let i = 0; i < norwegians.length; i += 4) await Promise.all(norwegians.slice(i, i + 4).map((c) => call("POST", `/api/companies/${c.id}/people`).then(() => statuses.push({ company_id: c.desk_id, company_name: c.name, status: "enriched", sources_used: ["registry"], new_signals: 1 })).catch(() => statuses.push({ company_id: c.desk_id, company_name: c.name, status: "unavailable" }))));
      const pending = s.companies.filter((c) => !c.research?.facts?.length && c.website && !/-demo\./.test(c.website)).map((c) => c.id);
      if (pending.length) { call("POST", "/api/pipeline/run", { ids: pending.slice(0, 6), research: true }).catch(() => null); }
    }
    for (const c of s.companies) if (!statuses.some((x) => x.company_id === c.desk_id)) statuses.push({ company_id: c.desk_id, company_name: c.name, status: "ok", sources_used: toRecord(c).sources_used, new_signals: 0 });
    const run = { run_id: desk().runs.length + 1, mode: live ? "live" : "seed", started_at: new Date(started).toISOString(), finished_at: iso(), duration_s: Math.round((Date.now() - started) / 10) / 100, processed: statuses.length, enriched: statuses.filter((x) => x.status === "enriched").length, failed: statuses.filter((x) => ["failed", "unavailable"].includes(x.status)).length, new_signals: statuses.reduce((n, x) => n + (x.new_signals || 0), 0), companies: statuses };
    desk().runs.push(run); log("ingest", { run_id: run.run_id, mode: run.mode }); res.json({ status: "success", data: run });
  }));
  app.get("/api/ingest/runs", (req, res) => { const runs = [...desk().runs].reverse().map(({ companies, ...r }) => r); res.json({ status: "success", count: runs.length, data: runs }); });

  // Prospects (the main tab and the drawer)
  app.get("/api/prospects", (req, res) => {
    let rows = allProspects().map(({ c, b }) => prospectRow(c, b));
    if (req.query.tier) rows = rows.filter((r) => r.tier === String(req.query.tier).toUpperCase());
    if (req.query.side) rows = rows.filter((r) => r.side === String(req.query.side).toLowerCase());
    const st = db.load().settings;
    res.json({ status: "success", count: rows.length, llm: llm.provider(st) === "verda" ? llm.verdaConfigured(st) : Boolean(st.api_key || process.env.ANTHROPIC_API_KEY), provider: llm.provider(st), data: rows });
  });
  app.get("/api/prospects/:id", (req, res) => { const c = companyByDesk(req.params.id); if (!c) return errorJson(res, 404, "Prospect not found"); res.json({ status: "success", data: detail(c) }); });
  app.post("/api/prospects/:id/outreach", wrap(async (req, res) => {
    const c = companyByDesk(req.params.id); if (!c) return errorJson(res, 404, "Prospect not found");
    const b = bundle(c); if (b.conversation.closed) return errorJson(res, 409, "Conversation is closed");
    const framing = /Growth partner/.test(b.hypothesis.mandate_type) ? "growth" : "open";
    try { await call("POST", `/api/companies/${c.id}/outreach`, { language: c.channel === "linkedin" ? "de" : "en", framing, touches: 4 }); }
    catch (err) {
      // No API key or the model failed: Amir's templates, stored as our drafts so the rest of the flow is identical.
      const plan = E.planOutreach(b.record, b.hypothesis);
      c.messages = (c.messages || []).filter((m) => !(m.step > 0 && m.status === "draft"));
      plan.sequence.forEach((s, i) => c.messages.push({ id: db.uid("m"), company_id: c.id, channel: s.channel === "LinkedIn" ? "linkedin" : s.channel === "Phone" ? "call_script" : "email", step: i + 1, send_after_days: s.day, language: c.channel === "linkedin" ? "de" : "en", framing, subject: s.subject, body: s.body, status: "draft", humanizer: null, lint: null, created_at: iso(), sent_at: null, template: true }));
      db.advance(c, "outreach_ready"); db.touch(c); console.warn(`[desk outreach] template fallback: ${err.message}`);
    }
    c.desk_follow_up_on = null; log("outreach_plan", { company: c.name });
    res.json({ status: "success", data: detail(db.findCompany(c.id)) });
  }));
  const stepMessage = (c, step) => sequenceMessages(c)[Number(step)] || null;
  app.patch("/api/prospects/:id/outreach/:step", wrap(async (req, res) => {
    const c = companyByDesk(req.params.id); const m = c && stepMessage(c, req.params.step); if (!m) return errorJson(res, 404, "Prospect not found");
    const upd = await call("PUT", `/api/messages/${m.id}`, { body: req.body?.body || "" });
    const camp = deskCampaign(db.findCompany(c.id)); res.json({ status: "success", data: camp.sequence[Number(req.params.step)], lint: upd.lint?.after || null });
  }));
  app.post("/api/prospects/:id/outreach/:step/send", wrap(async (req, res) => {
    const c = companyByDesk(req.params.id); if (!c) return errorJson(res, 404, "Prospect not found");
    const m = stepMessage(c, req.params.step); if (!m) return errorJson(res, 404, "Unknown step");
    if (m.status === "draft") await call("POST", `/api/messages/${m.id}/approve`);
    try { await call("POST", `/api/messages/${m.id}/send`); }
    catch (err) { return errorJson(res, err.status === 429 ? 409 : err.status || 409, err.message); }
    // The first touch is out: approve the follow-ups so the engine schedules them on their days (they stop when the owner replies).
    if (Number(req.params.step) === 0) for (const f of sequenceMessages(c)) if (f.id !== m.id && f.status === "draft") { try { await call("POST", `/api/messages/${f.id}/approve`); } catch { /* best-effort */ } }
    log("outreach_sent", { company: c.name, step: Number(req.params.step) });
    res.json({ status: "success", data: detail(db.findCompany(c.id)) });
  }));
  app.get("/api/prospects/:id/sample-replies", (req, res) => { if (!companyByDesk(req.params.id)) return errorJson(res, 404, "Prospect not found"); res.json({ status: "success", data: Object.entries(E.SAMPLE_REPLIES).map(([k, v]) => ({ category: k, label: E.CATEGORY_LABELS[k], text: v })) }); });
  app.post("/api/prospects/:id/replies", wrap(async (req, res) => {
    const c = companyByDesk(req.params.id); if (!c) return errorJson(res, 404, "Prospect not found");
    const text = String(req.body?.text || "").trim(); if (!text) return errorJson(res, 400, "Reply text is required");
    try { await call("POST", `/api/companies/${c.id}/replies`, { text, channel: c.channel === "linkedin" ? "linkedin" : "email" }); }
    catch (err) {
      // No model available (Verda down, Claude at its limit): Amir's rule-based qualification keeps the flow working.
      console.warn(`[desk replies] model triage unavailable (${err.message}); using rule-based qualification`);
      const before = bundle(c);
      const q = E.qualifyReply(text, { prospectScore: before.scored.score, mandateType: before.hypothesis.mandate_type });
      c.conversation = c.conversation || [];
      c.conversation.push({ id: db.uid("e"), direction: "inbound", channel: c.channel === "linkedin" ? "linkedin" : "email", text, at: iso(), triage: null, source: "paste", desk_q: q });
      for (const m of c.messages || []) if (["draft", "approved", "scheduled"].includes(m.status) && m.step > 1) { m.status = "cancelled"; m.cancel_reason = "Owner replied"; }
      if (["interested_now", "needs_advisor"].includes(q.category)) db.advance(c, "warming");
      else if (q.category === "interested_later") db.advance(c, "replied");
      else { c.stage = "disqualified"; }
      db.touch(c);
    }
    let fresh = db.findCompany(c.id);
    // The engine logs the reply before triaging it; if the model could not triage (no provider reachable), the entry
    // has no triage — qualify it with Amir's rules so the flow (stage, next action, likelihood) continues.
    const lastIn = [...(fresh.conversation || [])].reverse().find((e) => e.direction === "inbound" && e.channel !== "intake");
    if (lastIn && !lastIn.triage && !lastIn.desk_q) {
      const before = bundle(fresh);
      lastIn.desk_q = E.qualifyReply(lastIn.text || text, { prospectScore: before.scored.score, mandateType: before.hypothesis.mandate_type });
      if (["interested_now", "needs_advisor"].includes(lastIn.desk_q.category)) db.advance(fresh, "warming");
      else if (lastIn.desk_q.category === "interested_later") db.advance(fresh, "replied");
      else fresh.stage = "disqualified";
      db.touch(fresh); fresh = db.findCompany(c.id);
    }
    const b = bundle(fresh);
    const q = b.conversation.last_qualification;
    if (q?.category === "interested_later") { const d = new Date(); d.setDate(d.getDate() + (E.FOLLOW_UP_DAYS[q.timing] || E.FOLLOW_UP_DAYS["6-12 months"])); fresh.desk_follow_up_on = d.toISOString().slice(0, 10); db.touch(fresh); }
    log("reply", { company: c.name, category: q?.category });
    res.json({ status: "success", qualification: q, data: detail(db.findCompany(c.id)) });
  }));
  app.post("/api/prospects/:id/handoff", wrap(async (req, res) => {
    const c = companyByDesk(req.params.id); if (!c) return errorJson(res, 404, "Prospect not found");
    const b = bundle(c); const advisor = String(req.body?.advisor || "").trim() || (db.advisorFor?.(c)?.name) || "Mergero advisor";
    const pkg = { company: b.record.company, triggers: b.triggers, score: { score: b.scored.score, tier: b.scored.tier, timing: b.scored.timing, fit: b.scored.fit, urgency: b.scored.urgency, explanation: b.scored.explanation }, hypothesis: b.hypothesis, advisor, thread: b.conversation.thread, suggested_next_action: E.NEXT_ACTION[b.conversation.last_category] || "Call the owner to open the conversation", handed_off_at: iso(), intake: c.intake?.summary || null, web_dossier_facts: (c.research?.facts || []).length };
    c.desk_handoff = pkg; db.advance(c, "meeting_booked"); db.touch(c); log("handoff", { company: c.name, advisor });
    res.json({ status: "success", handoff: pkg, data: detail(db.findCompany(c.id)) });
  }));
  // Back and forth: send the reply the engine drafted from the owner's last answer (approve, then deliver; demo mode aware).
  app.post("/api/prospects/:id/reply/send", wrap(async (req, res) => {
    const c = companyByDesk(req.params.id); if (!c) return errorJson(res, 404, "Company not found");
    const d = replyDraftOf(c); if (!d) return errorJson(res, 409, "No drafted reply is waiting: log the owner's reply first");
    const m = c.messages.find((x) => x.id === d.id);
    if (typeof req.body?.body === "string" && req.body.body.trim()) m.body = req.body.body.trim();
    if (typeof req.body?.subject === "string" && req.body.subject.trim()) m.subject = req.body.subject.trim();
    db.touch(c); db.save();
    await call("POST", `/api/messages/${m.id}/approve`);
    try { await call("POST", `/api/messages/${m.id}/send`); }
    catch (err) {
      // The human-language gate can refuse a draft; one humanizer pass, then try once more.
      if (!/lint|human|templated|AI|block/i.test(err.message || "")) throw err;
      await call("POST", `/api/messages/${m.id}/humanize`); await call("POST", `/api/messages/${m.id}/approve`); await call("POST", `/api/messages/${m.id}/send`);
    }
    log("reply_sent", { company: c.name });
    res.json({ status: "success", data: detail(db.findCompany(c.id)) });
  }));
  // Meetings between the first call and the engagement letter, logged on the record.
  app.post("/api/prospects/:id/meetings", wrap(async (req, res) => {
    const c = companyByDesk(req.params.id); if (!c) return errorJson(res, 404, "Company not found");
    c.meetings = c.meetings || []; const n = c.meetings.length + 1;
    c.meetings.push({ n, at: iso(), note: String(req.body?.note || "").trim() || `Meeting ${n}` });
    db.touch(c); db.save(); log("meeting", { company: c.name, n });
    res.json({ status: "success", data: detail(db.findCompany(c.id)) });
  }));
  app.post("/api/prospects/:id/mandate", wrap(async (req, res) => {
    const c = companyByDesk(req.params.id); if (!c) return errorJson(res, 404, "Prospect not found");
    c.stage = "mandate_signed"; db.touch(c); log("mandate", { company: c.name });
    res.json({ status: "success", data: detail(db.findCompany(c.id)) });
  }));

  // Pipeline summary, funnel, metrics, demo reset
  app.get("/api/pipeline-summary", (req, res) => {
    const rows = allProspects(); const tiers = { A: 0, B: 0, C: 0 }, sides = { sell: 0, buy: 0 };
    for (const { b } of rows) { tiers[b.scored.tier]++; sides[b.hypothesis.side]++; }
    const camps = rows.map(({ b }) => b.campaign).filter(Boolean);
    const quals = rows.map(({ b }) => b.conversation.last_qualification).filter(Boolean);
    const funnel = E.funnel(rows.map(({ b }) => b.conversation.stage));
    res.json({ status: "success", data: { data: { companies: rows.length, signals: rows.reduce((n, { b }) => n + b.record.signals.length, 0), runs: desk().runs.length }, signals: { with_triggers: rows.filter(({ b }) => b.triggers.length).length, triggers: rows.reduce((n, { b }) => n + b.triggers.length, 0) }, scoring: tiers, hypothesis: sides, outreach: { sequences: camps.length, sent: camps.reduce((n, cp) => n + cp.sequence.filter((s) => s.status === "sent").length, 0) }, qualification: { qualified: quals.length, potential_mandates: quals.filter((q) => q.potential_mandate).length }, handoff: { handed_off: funnel.handed_off, mandates: funnel.mandates } } });
  });
  app.get("/api/funnel", (req, res) => res.json({ status: "success", data: E.funnel(allProspects().map(({ b }) => b.conversation.stage)) }));
  app.get("/api/dialogues", (req, res) => res.json({ status: "success", count: desk().dialogues }));
  app.get("/api/metrics", (req, res) => { const d = desk(); res.json({ status: "success", buyers: deskBuyers().length, matches: d.deals.length, outreach_ready: d.deals.filter((x) => ["Warm-up drafted", "Outreach ready", "Mandate conversation"].includes(x.stage)).length, dialogues: d.dialogues }); });
  // Demo protection: companies listed in DEMO_PROTECT_IDS (engine ids, comma-separated) keep their emails, replies and
  // deals through a reset, so the stage owners survive anyone clicking "Watch the demo" minutes before the pitch.
  const protectedIds = () => new Set(String(process.env.DEMO_PROTECT_IDS || "").split(",").map((x) => x.trim()).filter(Boolean));
  app.get("/api/demo/mode", (req, res) => {
    ensureIds(); const keep = protectedIds();
    res.json({ status: "success", protected: db.load().companies.filter((c) => keep.has(c.id)).map((c) => c.desk_id), protected_count: keep.size });
  });
  app.post("/api/demo/reset", (req, res) => {
    // His reset: clear outreach and replies so the guided demo starts fresh; research, scores and register data stay.
    const s = db.load(); const keep = protectedIds();
    for (const c of s.companies) { if (keep.has(c.id)) continue; c.messages = []; c.conversation = []; c.desk_handoff = null; c.desk_follow_up_on = null; c.meetings = []; if (c.stage !== "disqualified") c.stage = c.enrichment ? "enriched" : "new"; }
    desk().deals = desk().deals.filter((d) => d.company_id && keep.has(d.company_id)); db.save(); log("demo_reset", { protected: keep.size }); res.json({ status: "success", protected: keep.size });
  });
}
