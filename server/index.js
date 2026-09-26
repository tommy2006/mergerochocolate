import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as db from "./db.js";
import * as agents from "./agents.js";
import * as registry from "./registry.js";
import * as mail from "./mail.js";
import * as playbook from "./playbook.js";
import * as suggest from "./suggest.js";
import * as integrations from "./integrations.js";
import * as humanlint from "./humanlint.js";
import * as learning from "./learning.js";
import * as publicDemand from "./public_demand.js";
import * as buyside from "./buyside.js";
import * as desk from "./desk/routes.js";
import * as llmProvider from "./llm.js";
import * as mgx from "./mgx.js";

// Loaded on first use so the server still starts if a research dependency (cheerio, puppeteer-core) is missing.
// A failed load is not cached: the next call retries with a fresh module URL.
let researchMod = null;
const researcher = async () => researchMod || (researchMod = await import(`./research/index.js?v=${Date.now()}`));

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
// The raw body is kept for webhook signature checks (server/mail.js verifySvix).
app.use(express.json({ limit: "5mb", verify: (req, _res, buf) => { req.rawBody = buf.toString("utf8"); } }));
// Amir's Origination Desk is the front door ("/"); our own console lives at /engine and talks to /api/engine/… .
desk.register(app, { baseUrl: process.env.BASE_URL || `http://localhost:${Number(process.env.PORT || 3000)}` });
app.get("/engine", (req, res) => res.sendFile(path.join(here, "..", "public", "index.html")));
app.use(express.static(path.join(here, "..", "public")));

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Async route wrapper → consistent JSON errors.
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(`[${req.method} ${req.path}]`, err?.message || err);
  res.status(err.status || 500).json({ error: err?.message || String(err) });
});
const notFound = (what) => Object.assign(new Error(`${what} not found`), { status: 404 });
const company = (id) => db.findCompany(id) || (() => { throw notFound("Company"); })();
// Lists return full Company objects (API.md); the frontend derives its own summaries (score rings, pending drafts).
const summary = (c) => c;

// ---------------- state & stats ----------------
app.get("/api/state", (req, res) => {
  const s = db.load();
  res.json({ settings: db.publicSettings(), stats: db.stats(), companies: s.companies.map(summary), buyers: s.buyers });
});
app.get("/api/stats", (req, res) => res.json(db.stats()));

// ---------------- companies ----------------
app.get("/api/companies", (req, res) => res.json(db.load().companies.map(summary)));
app.get("/api/companies/:id", wrap(async (req, res) => res.json(company(req.params.id))));
app.post("/api/companies", wrap(async (req, res) => {
  if (!req.body?.name) throw Object.assign(new Error("name is required"), { status: 400 });
  const c = db.normalizeCompany({ ...req.body, source: req.body.source || "Manual" });
  db.load().companies.unshift(c);
  db.save();
  res.json(c);
}));
app.put("/api/companies/:id", wrap(async (req, res) => {
  const c = company(req.params.id);
  const allowed = ["name", "country", "city", "website", "industry", "revenue_eur", "ebitda_eur", "employees", "founded", "ownership_type", "owner", "notes", "source", "referrer", "registry_id", "advisor_id"];
  for (const k of allowed) if (k in req.body) c[k] = req.body[k];
  if ("country" in req.body) c.channel = db.channelFor(c.country);
  res.json(db.touch(c));
}));
app.delete("/api/companies/:id", wrap(async (req, res) => {
  const s = db.load();
  const i = s.companies.findIndex((c) => c.id === req.params.id);
  if (i < 0) throw notFound("Company");
  s.companies.splice(i, 1);
  db.save();
  res.json({ ok: true });
}));
app.post("/api/companies/:id/stage", wrap(async (req, res) => {
  const c = company(req.params.id);
  if (!db.STAGES.includes(req.body?.stage)) throw Object.assign(new Error("invalid stage"), { status: 400 });
  c.stage = req.body.stage;
  if (c.stage === "disqualified" || c.stage === "mandate_signed") cancelFollowUps(c, `stage ${c.stage}`);
  res.json(db.touch(c));
}));

// CSV import (prospect-database export). Handles quoted fields.
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === "," || ch === ";") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((x) => x.trim()));
  const keys = header.map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}
app.post("/api/companies/import", wrap(async (req, res) => {
  const rows = parseCsv(req.body?.csv || "");
  const created = rows.filter((r) => r.name).map((r) => db.normalizeCompany({
    name: r.name, country: r.country, city: r.city, website: r.website, industry: r.industry,
    revenue_eur: r.revenue_eur, ebitda_eur: r.ebitda_eur, employees: r.employees, founded: r.founded,
    ownership_type: r.ownership_type || "unknown",
    owner: { name: r.owner_name, title: r.owner_title, age: r.owner_age || undefined, email: r.owner_email, linkedin: r.owner_linkedin },
    source: "Prospect database import",
  }));
  db.load().companies.unshift(...created);
  db.save();
  res.json({ imported: created.length, companies: created });
}));

// Registry lookup: pull candidates straight from official open-data registers (FI/NO/DK).
app.get("/api/registry/search", wrap(async (req, res) => {
  const { country, q, industry_code, city, founded_before, employees_min, page } = req.query;
  const out = await registry.search({ country, q, industry_code, city, founded_before, employees_min, page: Number(page) || 1 });
  const known = new Set(db.load().companies.map((c) => c.registry_id).filter(Boolean));
  out.results = out.results.map((r) => ({ ...r, already_imported: known.has(r.registry_id) }));
  res.json(out);
}));
app.post("/api/companies/bulk", wrap(async (req, res) => {
  const rows = Array.isArray(req.body?.companies) ? req.body.companies : [];
  const s = db.load();
  const known = new Set(s.companies.map((c) => c.registry_id).filter(Boolean));
  const created = rows.filter((r) => r?.name && !(r.registry_id && known.has(r.registry_id)))
    .map((r) => db.normalizeCompany({ ...r, owner: r.owner || {}, source: r.source || "Registry import" }));
  s.companies.unshift(...created);
  db.save();
  // Norwegian imports: fetch CEO/chair with birth dates right away (best-effort, 4 at a time), so owner age is real from the start.
  const norwegians = created.filter((c) => c.country === "NO" && c.registry_id);
  for (let i = 0; i < norwegians.length; i += 4) {
    await Promise.all(norwegians.slice(i, i + 4).map((c) => stepPeople(c).catch((err) => console.warn(`[people] ${c.name}: ${err.message}`))));
  }
  res.json({ imported: created.length, companies: created, people_looked_up: norwegians.filter((c) => c.people?.length).length });
}));

// ---------------- agent steps ----------------
const RESEARCH_MAX_AGE_MS = Number(process.env.RESEARCH_MAX_AGE_DAYS || 7) * 864e5;
const logFor = (c) => (msg) => console.log(`[research] ${c.name}: ${msg}`);

// Filed accounts fill blanks in the prospect record (shared with the desk's deep analysis).
async function fillBlanksFromResearch(c) { return (await researcher()).applyFinancials(c); }
async function stepResearch(c, opts = {}) {
  const fresh = c.research?.ran_at && Date.now() - Date.parse(c.research.ran_at) < RESEARCH_MAX_AGE_MS;
  if (fresh && !opts.refresh) return c;
  c.research = await (await researcher()).research(c, db.load().settings, { log: logFor(c) });
  await fillBlanksFromResearch(c);
  return db.touch(c);
}
async function stepWatch(c) {
  const out = await (await researcher()).watch(c, db.load().settings, { log: logFor(c) });
  c.watch = { last_run_at: out.checked_at, last_error: out.error || null, last_summary: out.error ? null : { new_urls: out.new_urls, changed_pages: out.changed_pages, new_facts: out.new_facts },
    alerts: [...out.alerts, ...(c.watch?.alerts || [])].slice(0, 100) };
  return db.touch(c);
}
// Real people from the register (Norway today): CEO / chair with birth dates → owner age becomes a fact, not a proxy.
async function stepPeople(c, { force = false } = {}) {
  if (c.country !== "NO" || !c.registry_id) throw Object.assign(new Error("Register roles are available for Norwegian companies with an organisation number."), { status: 400 });
  if (c.people?.length && !force) return c;
  const r = await registry.rolesNO(c.registry_id);
  c.people = r.people; c.people_source = r.source; c.people_fetched_at = r.fetched_at;
  const lead = r.ceo || r.chair;
  c.owner = c.owner || {};
  if (lead) {
    if (!c.owner.name) { c.owner.name = lead.name; c.owner.title = lead.role; }
    if (lead.age && (c.owner.age == null || c.owner.age_source)) { c.owner.age = lead.age; c.owner.age_source = r.source; c.owner.birth_year = lead.birth_year; }
  }
  return db.touch(c);
}
async function stepEnrich(c) {
  if (c.country === "NO" && c.registry_id && !c.people?.length) { try { await stepPeople(c); } catch (err) { console.warn(`[people] ${c.name}: ${err.message}`); } }
  c.enrichment = await agents.runTracked(c.id, () => agents.enrich(c, db.load().settings), "enrich");
  db.advance(c, "enriched");
  return db.touch(c);
}
async function stepScore(c) {
  const s = db.load();
  c.score = await agents.runTracked(c.id, () => agents.score(c, s.buyers, s.settings, { learning: learning.summaryFor(c) }), "score");
  if (c.score.readiness < 25 && c.stage === "enriched") { /* leave for advisor; UI shows low score */ }
  return db.touch(c);
}
async function stepMatch(c) {
  const s = db.load();
  c.matches = await agents.runTracked(c.id, () => agents.match(c, s.buyers, s.settings), "match");
  return db.touch(c);
}
// Deterministic human-language check for one draft (see server/humanlint.js): tells, personalisation, reuse across prospects.
function lintMessage(c, m) {
  const s = db.load();
  return humanlint.lint(m.body, {
    subject: m.subject, language: m.language === "auto" ? "en" : m.language, channel: m.channel, step: m.step, company: c,
    facts: humanlint.factsFor(c), previous: humanlint.previousDrafts(s.companies, c.id), threshold: s.settings.lint_threshold ?? 35,
  });
}
// Draft → lint → humanizer (told exactly what to fix) → lint again; a second editing pass only if it still fails.
async function humanizeUntilHuman(c, draft, settings, { maxPasses = 2 } = {}) {
  let m = { ...draft };
  const before = lintMessage(c, m);
  let lint = before, h = null, passes = 0;
  while (passes < maxPasses && (passes === 0 || lint.blocks_send)) {
    const next = await agents.humanize(m, c, settings, { lint });
    if (next.body) { m = { ...m, subject: next.subject || m.subject, body: next.body }; h = h ? { ...next, flags: [...(h.flags || []), ...(next.flags || [])], changes: [...(h.changes || []), ...(next.changes || [])], ai_tell_score_before: h.ai_tell_score_before } : next; }
    lint = lintMessage(c, m);
    passes++;
  }
  return { subject: m.subject, body: m.body, humanizer: h, lint: { before, after: lint, passes } };
}
async function stepOutreach(c, opts = {}) { return agents.runTracked(c.id, () => stepOutreachInner(c, opts), "outreach"); }
async function stepOutreachInner(c, opts = {}) {
  const settings = db.settingsFor(c); // written and signed by the prospect's own advisor
  const drafts = await agents.outreach(c, settings, opts);
  // Humanizer + linter pass on each touch, in parallel.
  const humanized = await Promise.all(drafts.map(async (d) => {
    const r = await humanizeUntilHuman(c, d, settings);
    const h = r.humanizer || {};
    return {
      id: db.uid("m"), company_id: c.id, channel: d.channel, step: d.step, send_after_days: d.send_after_days,
      language: d.language, framing: d.framing || "open", subject: r.subject || d.subject, body: r.body || d.body, status: "draft",
      humanizer: { ai_tell_score_before: h.ai_tell_score_before, ai_tell_score_after: h.ai_tell_score_after, flags: h.flags || [], changes: h.changes || [], original_body: d.body, original_subject: d.subject },
      lint: r.lint,
      created_at: db.now(), sent_at: null,
    };
  }));
  // Replace any previous unsent sequence drafts.
  c.messages = c.messages.filter((m) => !(m.step > 0 && m.status === "draft"));
  c.messages.push(...humanized.sort((a, b) => a.step - b.step));
  db.advance(c, "outreach_ready");
  return db.touch(c);
}
async function runAll(c, opts = {}) {
  const t0 = Date.now();
  await agents.runTracked(c.id, async () => {
    // Research is best-effort inside the pipeline: if it fails, enrichment falls back to its own web research.
    if (opts.research !== false) {
      try { await agents.runTracked(c.id, () => stepResearch(c), "research"); }
      catch (err) { console.warn(`[research] ${c.name}: skipped (${err.message})`); }
    }
    await stepEnrich(c); await stepScore(c); await stepMatch(c); await stepOutreach(c, opts);
  });
  agents.addSeconds(c.id, (Date.now() - t0) / 1000);
  return c;
}
app.post("/api/companies/:id/people", wrap(async (req, res) => res.json(await stepPeople(company(req.params.id), { force: true }))));
let reachCache = null;
app.get("/api/registry/reach", wrap(async (req, res) => {
  if (!reachCache || Date.now() - reachCache.at > 10 * 60 * 1000) reachCache = { at: Date.now(), data: await registry.reach() };
  res.json(reachCache.data);
}));

app.post("/api/companies/:id/research", wrap(async (req, res) => res.json(await stepResearch(company(req.params.id), { refresh: true }))));
app.post("/api/companies/:id/watch", wrap(async (req, res) => res.json(await stepWatch(company(req.params.id)))));
app.post("/api/companies/:id/enrich", wrap(async (req, res) => res.json(await stepEnrich(company(req.params.id)))));
app.post("/api/companies/:id/score", wrap(async (req, res) => res.json(await stepScore(company(req.params.id)))));
app.post("/api/companies/:id/match", wrap(async (req, res) => res.json(await stepMatch(company(req.params.id)))));
app.post("/api/companies/:id/outreach", wrap(async (req, res) => res.json(await stepOutreach(company(req.params.id), req.body || {}))));
app.post("/api/companies/:id/run", wrap(async (req, res) => res.json(await runAll(company(req.params.id), req.body || {}))));

// Bulk jobs (the "scale" story): run a step for many companies with bounded concurrency.
const jobs = new Map();
function startJob(kind, ids, fn, concurrency = 3) {
  const job = { id: db.uid("job"), kind, total: ids.length, done: 0, current_company: null, errors: [], finished: ids.length === 0, started_at: db.now() };
  jobs.set(job.id, job);
  const queue = [...ids];
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      const c = db.findCompany(id);
      if (!c) { job.done++; continue; }
      job.current_company = c.name;
      try { await fn(c); }
      catch (err) { job.errors.push({ id, name: c.name, error: err.message }); }
      job.done++;
    }
  };
  Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker)).then(() => { job.finished = true; job.current_company = null; });
  return job;
}
app.post("/api/pipeline/run", wrap(async (req, res) => {
  const s = db.load();
  const stage = req.body?.stage;
  const ids = req.body?.ids?.length ? req.body.ids : s.companies.filter((c) => (stage ? c.stage === stage : c.stage === "new")).map((c) => c.id);
  res.json({ job_id: startJob("pipeline", ids, (c) => runAll(c, { language: req.body?.language })).id });
}));

// Watch mode: re-crawl researched companies, diff against the last snapshot, raise alerts (new CEO, new site, hiring…).
const watchable = () => db.load().companies.filter((c) => c.research?.snapshot && c.website && !["disqualified", "mandate_signed"].includes(c.stage));
app.post("/api/watch/run", wrap(async (req, res) => {
  const ids = req.body?.ids?.length ? req.body.ids : watchable().map((c) => c.id);
  res.json({ job_id: startJob("watch", ids, stepWatch, 2).id, total: ids.length });
}));
app.get("/api/watch/alerts", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const all = db.load().companies.flatMap((c) => (c.watch?.alerts || []).map((a) => ({ ...a, company_id: c.id, company_name: c.name, country: c.country })));
  res.json({ watched: watchable().length, alerts: all.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit) });
});
const WATCH_HOURS = Number(process.env.WATCH_INTERVAL_HOURS || 0);
if (WATCH_HOURS > 0) setInterval(() => startJob("watch", watchable().map((c) => c.id), stepWatch, 2), WATCH_HOURS * 3600e3).unref();

// Buyer-side: blind teaser, only once the owner has signed the mandate.
app.post("/api/companies/:id/teaser", wrap(async (req, res) => {
  const c = company(req.params.id);
  if (c.stage !== "mandate_signed") throw Object.assign(new Error("Blind teasers are drafted only after the mandate is signed (set the stage to Mandate signed first)."), { status: 409 });
  c.teaser = { ...(await agents.teaser(c, db.load().settings)), drafted_at: db.now(), status: "draft" };
  res.json(db.touch(c));
}));
app.get("/api/jobs/:id", (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: "Job not found" });
  res.json(j);
});

// ---------------- messages ----------------
const message = (id) => db.findMessage(id) || (() => { throw notFound("Message"); })();
app.put("/api/messages/:id", wrap(async (req, res) => {
  const { company: c, message: m } = message(req.params.id);
  if ("subject" in req.body) m.subject = req.body.subject;
  if ("body" in req.body) m.body = req.body.body;
  if ("lint_override" in req.body) m.lint_override = Boolean(req.body.lint_override);
  // An edit is re-checked immediately so the advisor sees whether their wording passes.
  if ("subject" in req.body || "body" in req.body) m.lint = { ...(m.lint || {}), after: lintMessage(c, m), edited: true };
  db.touch(c); res.json(m);
}));
app.post("/api/messages/:id/lint", wrap(async (req, res) => {
  const { company: c, message: m } = message(req.params.id);
  m.lint = { ...(m.lint || {}), after: lintMessage(c, m) };
  db.touch(c); res.json(m);
}));
// Sequence lifecycle: draft → approved → (scheduled) → sent → replied | bounced; rejected and cancelled end a message.
const SEQUENCE_DONE = new Set(["sent", "replied", "bounced", "cancelled", "rejected"]);
const firstSent = (c) => c.messages.filter((m) => m.step > 0 && m.sent_at).sort((a, b) => a.step - b.step)[0];
const ownerRepliedSince = (c, first) => Boolean(first) && c.conversation.some((e) => e.direction === "inbound" && e.channel !== "intake" && String(e.at) > String(first.sent_at));
// A follow-up's send time is the sequence's first send plus its day offset, and never less than two minutes from now,
// so an advisor can still stop it. Once the owner has answered, nothing is scheduled: follow-ups become manual.
function scheduleFollowUps(c) {
  const first = firstSent(c);
  if (!first || ownerRepliedSince(c, first)) return 0;
  const base = Date.parse(first.sent_at);
  let n = 0;
  for (const m of c.messages) {
    if (!(m.step > first.step) || m.status !== "approved") continue;
    const at = Math.max(base + (m.send_after_days || 0) * 864e5, Date.now() + 2 * 60e3);
    m.status = "scheduled"; m.send_at = new Date(at).toISOString(); m.due = false; n++;
  }
  return n;
}
function cancelFollowUps(c, reason) {
  let n = 0;
  for (const m of c.messages) if (m.status === "scheduled") { m.status = "cancelled"; m.cancel_reason = reason; m.send_at = null; m.due = false; n++; }
  return n;
}

// Send one approved message: through Resend when email is configured, otherwise hand back a mailto: link (email) or
// just log it (LinkedIn, call). Replies carry In-Reply-To/References so they thread in the owner's mail client.
async function deliver(c, m, via = "manual", { now = Date.now() } = {}) {
  const settings = db.load().settings;
  // Human-language gate: nothing that still reads as machine-written or templated leaves the building.
  const check = m.lint?.after || (m.body ? lintMessage(c, m) : null);
  if (check?.blocks_send && !m.lint_override) {
    const why = check.flags.filter((f) => f.severity === "high").slice(0, 3).map((f) => f.rule).join(", ") || `human-language score ${check.score}`;
    throw Object.assign(new Error(`Not sent: the draft still reads as templated or machine-written (${why}). Edit it, re-humanize, or override on the card.`), { status: 409 });
  }
  const adv = db.advisorFor(c);
  if (m.channel === "email" && adv) {
    const cap = db.capOf(adv), used = db.sentToday(adv.id, now);
    if (used >= cap) throw Object.assign(new Error(`${adv.name} has already sent ${used} of ${cap} emails today (the daily limit that protects deliverability). It goes out on the next working morning; raise the cap in Settings to send more.`), { status: 429, capped: true, next_at: new Date(db.nextSendWindow(now)).toISOString() });
  }
  const to = c.owner?.email;
  let mailto = null;
  const demoTo = String(settings.demo_email || process.env.DEMO_EMAIL || "").trim();
  if (m.channel === "email" && mail.configured(settings)) {
    if (!to && !demoTo) throw Object.assign(new Error(`${c.name} has no owner email address. Add one on the prospect before sending.`), { status: 409 });
    const headers = { "Message-ID": mail.messageIdFor(settings, m) };
    const parent = m.in_reply_to ? c.conversation.find((e) => e.id === m.in_reply_to) : null;
    if (parent?.rfc_message_id) {
      headers["In-Reply-To"] = parent.rfc_message_id;
      headers["References"] = [parent.references, parent.rfc_message_id].filter(Boolean).join(" ");
    }
    const out = await mail.send(sendAs(settings, adv), {
      to: to || demoTo, subject: m.subject, text: m.body, headers,
      reply_to: mail.inboundAddress(settings, c.id) || adv?.email || settings.sender?.email || undefined,
      tags: [{ name: "company_id", value: c.id }, { name: "message_id", value: m.id }],
    });
    m.delivery = { provider: "resend", id: out.id, status: "sent", message_id: headers["Message-ID"], via, events: [{ type: "email.sent", at: db.now() }] };
  } else if (m.channel === "email" && to) {
    mailto = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(m.subject || "")}&body=${encodeURIComponent(m.body)}`;
    m.delivery = { provider: "mailto", status: "handed_off", via };
  } else {
    m.delivery = { provider: "manual", status: "handed_off", via };
  }
  m.status = "sent"; m.sent_at = db.now(); m.send_at = null; m.due = false; m.sent_by = adv?.id || null; delete m.deferred_reason;
  c.conversation.push({
    id: db.uid("e"), direction: "outbound", channel: m.channel, text: m.subject ? `Subject: ${m.subject}\n\n${m.body}` : m.body, at: m.sent_at, triage: null,
    message_id: m.id, source: m.delivery.provider, provider_id: m.delivery.id || null, rfc_message_id: m.delivery.message_id || null,
  });
  if (m.step > 0) { db.advance(c, "contacted"); scheduleFollowUps(c); }
  db.touch(c);
  return { message: m, mailto, delivered: m.delivery.provider === "resend" };
}

// The email goes out under the advisor's own name. The address stays the verified sending address unless the advisor's
// own address is on the same domain (then it is used as is).
function sendAs(settings, adv) {
  if (!adv?.name) return settings;
  const from = mail.parseAddress(mail.config(settings).from);
  if (!from.email) return settings;
  const sameDomain = adv.email && adv.email.split("@")[1]?.toLowerCase() === from.email.split("@")[1]?.toLowerCase();
  return { ...settings, mail: { ...settings.mail, from: `${adv.name} <${sameDomain ? adv.email : from.email}>` } };
}

app.post("/api/messages/:id/approve", wrap(async (req, res) => {
  const { company: c, message: m } = message(req.params.id);
  if (SEQUENCE_DONE.has(m.status) && m.status !== "rejected" && m.status !== "cancelled") throw Object.assign(new Error(`Cannot approve a message that is ${m.status}.`), { status: 409 });
  m.status = "approved"; m.send_at = null; m.due = false; delete m.cancel_reason;
  scheduleFollowUps(c); // a follow-up approved after the first touch went out gets its send time right away
  db.touch(c); res.json(m);
}));
app.post("/api/messages/:id/reject", wrap(async (req, res) => {
  const { company: c, message: m } = message(req.params.id);
  if (SEQUENCE_DONE.has(m.status) && m.status !== "rejected") throw Object.assign(new Error(`Cannot reject a message that is ${m.status}.`), { status: 409 });
  m.status = "rejected"; m.send_at = null; m.due = false;
  db.touch(c); res.json(m);
}));
app.post("/api/messages/:id/unschedule", wrap(async (req, res) => {
  const { company: c, message: m } = message(req.params.id);
  if (m.status !== "scheduled") throw Object.assign(new Error(`Message is ${m.status}, not scheduled.`), { status: 409 });
  m.status = "approved"; m.send_at = null; m.due = false;
  db.touch(c); res.json(m);
}));
app.post("/api/messages/:id/send", wrap(async (req, res) => {
  const { company: c, message: m } = message(req.params.id);
  if (!["approved", "scheduled"].includes(m.status)) throw Object.assign(new Error(`Approve the message before sending (it is ${m.status}).`), { status: 409 });
  try { res.json(await deliver(c, m, "manual")); }
  catch (err) {
    if (!err.capped) throw err;
    // Over the advisor's daily cap: queue it for the next sending window instead of failing.
    m.status = "scheduled"; m.send_at = err.next_at; m.due = false; m.deferred_reason = "daily cap";
    db.touch(c);
    res.json({ message: m, mailto: null, delivered: false, deferred: true, note: err.message });
  }
}));
app.post("/api/messages/:id/humanize", wrap(async (req, res) => {
  const { company: c, message: m } = message(req.params.id);
  const r = await humanizeUntilHuman(c, m, db.settingsFor(c));
  const h = r.humanizer || {};
  m.humanizer = { ...(m.humanizer || {}), ai_tell_score_before: h.ai_tell_score_before, ai_tell_score_after: h.ai_tell_score_after, flags: h.flags || [], changes: h.changes || [], original_body: m.body, original_subject: m.subject };
  m.subject = r.subject || m.subject; m.body = r.body || m.body; m.lint = r.lint; m.lint_override = false;
  db.touch(c); res.json(m);
}));

// ---------------- inbound replies → triage ----------------
// One inbound owner message, whatever the channel and however it arrived: log it, stop the sequence, then triage it,
// draft the reply and move the stage. Logging is synchronous so the reply is visible even if the model call fails.
function logInbound(c, { text, text_full = null, channel, source = "paste", from = null, subject = null, provider_id = null, rfc_message_id = null, in_reply_to = null, references = null, routed_by = null, at = null }) {
  const entry = { id: db.uid("e"), direction: "inbound", channel: channel || c.channel || "email", text, at: at || db.now(), triage: null, source, from, subject, provider_id, rfc_message_id, in_reply_to, references, routed_by };
  if (text_full && text_full !== text) entry.text_full = text_full;
  c.conversation.push(entry);
  entry.cancelled_followups = cancelFollowUps(c, "owner replied");
  for (const m of c.messages) if (m.step > 0 && m.status === "sent") m.status = "replied";
  db.advance(c, "replied");
  db.touch(c);
  return entry;
}
async function triageEntry(c, entry) {
  const settings = db.settingsFor(c);
  let t;
  try { t = await agents.triage(c, entry.text, settings); }
  catch (err) { entry.triage_error = err.message; db.touch(c); console.warn(`[triage] ${c.name}: ${err.message}`); return c; }
  delete entry.triage_error;
  const prev = c.conversation.filter((e) => e.direction === "inbound" && e.triage && e.id !== entry.id).pop();
  const rank = { cold: -1, neutral: 0, warm: 1 };
  const delta = prev ? (rank[t.sentiment] ?? 0) - (rank[prev.triage.sentiment] ?? 0) : 0;
  // Re-triage reuses the unsent reply draft for this entry instead of stacking a second one.
  let reply = c.messages.find((m) => m.in_reply_to === entry.id && !SEQUENCE_DONE.has(m.status));
  if (!reply) {
    reply = { id: db.uid("m"), company_id: c.id, channel: entry.channel, step: 0, send_after_days: 0, language: "auto", status: "draft", humanizer: null, created_at: db.now(), sent_at: null, in_reply_to: entry.id };
    c.messages.push(reply);
  }
  reply.subject = entry.subject ? (/^re:/i.test(entry.subject) ? entry.subject : `Re: ${entry.subject}`) : t.reply_subject;
  reply.body = t.reply_body;
  // Replies get the same human-language treatment as first touches (best-effort: the triage result stands even if this fails).
  try {
    const r = await humanizeUntilHuman(c, reply, settings, { maxPasses: 1 });
    if (r.body) { reply.body = r.body; if (!entry.subject && r.subject) reply.subject = r.subject; }
    reply.humanizer = r.humanizer ? { ai_tell_score_before: r.humanizer.ai_tell_score_before, ai_tell_score_after: r.humanizer.ai_tell_score_after, flags: r.humanizer.flags || [], changes: r.humanizer.changes || [] } : null;
    reply.lint = r.lint;
  } catch (err) { console.warn(`[humanize reply] ${c.name}: ${err.message}`); reply.lint = { after: lintMessage(c, reply) }; }
  entry.triage = {
    intent: t.intent, sentiment: t.sentiment, sentiment_trend: delta > 0 ? "up" : delta < 0 ? "down" : "flat",
    extracted_facts: t.extracted_facts, open_questions: t.open_questions || [], recommended_stage: t.recommended_stage, next_step: t.next_step, reply_message_id: reply.id,
  };
  if (t.recommended_stage === "disqualified") c.stage = "disqualified"; else db.advance(c, t.recommended_stage === "contacted" ? "replied" : t.recommended_stage);
  // Fold extracted facts into notes so nothing is lost.
  if (t.extracted_facts.length) c.notes = [c.notes, ...t.extracted_facts.map((f) => `${f.field}: ${f.value} (${f.confidence})`)].filter(Boolean).join("\n");
  db.touch(c);
  await rescoreEntry(c, entry, t, settings);
  return c;
}
// Reply understanding → score update (best-effort: triage and the reply draft stand even if this fails).
// Re-analysing the same reply replaces its earlier update instead of stacking a second one.
async function rescoreEntry(c, entry, t, settings) {
  let u;
  try { u = await agents.runTracked(c.id, () => agents.rescoreFromReply(c, entry, t, settings), "rescore"); }
  catch (err) { entry.score_update_error = err.message; db.touch(c); console.warn(`[rescore] ${c.name}: ${err.message}`); return; }
  delete entry.score_update_error;
  const prevUpdate = (c.score?.history || []).find((h) => h.entry_id === entry.id);
  const base = prevUpdate?.from || (c.score ? { readiness: c.score.readiness, attractiveness: c.score.attractiveness, recommended_timing: c.score.recommended_timing } : null);
  const to = { readiness: u.readiness, attractiveness: u.attractiveness, recommended_timing: u.recommended_timing };
  const tag = (g) => ({ ...g, source: "reply", entry_id: entry.id });
  const s = c.score || { valuation_band_eur: null, meets_minimum: null, why_now: "", signals: [], risks: [], scored_at: db.now() };
  c.score = {
    ...s, ...to,
    signals: [...(u.signals || []).map(tag), ...(s.signals || []).filter((g) => g.entry_id !== entry.id)],
    risks: [...new Set([...(s.risks || []), ...(u.risks || [])])],
    rescored_at: db.now(),
    history: [...(s.history || []).filter((h) => h.entry_id !== entry.id), {
      at: db.now(), source: "reply", entry_id: entry.id, from: base, to, reason: u.reason, evidence: u.evidence, confidence: u.confidence,
    }],
  };
  entry.score_update = { from: base, to, delta: base?.readiness != null ? to.readiness - base.readiness : null, reason: u.reason, evidence: u.evidence, confidence: u.confidence, dropped_quotes: u.dropped_quotes };
  db.touch(c);
}
async function handleInboundReply(c, payload) {
  const entry = logInbound(c, payload);
  await triageEntry(c, entry);
  return { company: c, entry };
}
app.post("/api/companies/:id/replies", wrap(async (req, res) => {
  const c = company(req.params.id);
  const text = (req.body?.text || "").trim();
  if (!text) throw Object.assign(new Error("text is required"), { status: 400 });
  await handleInboundReply(c, { text, channel: req.body?.channel || c.channel, source: "paste", routed_by: "manual" });
  res.json(c);
}));
app.post("/api/companies/:id/replies/:entryId/triage", wrap(async (req, res) => {
  const c = company(req.params.id);
  const entry = c.conversation.find((e) => e.id === req.params.entryId && e.direction === "inbound");
  if (!entry) throw notFound("Conversation entry");
  res.json(await triageEntry(c, entry));
}));

// ---------------- real email: Resend webhook, inbox, scheduler ----------------
// Which prospect is an inbound email about? The plus-address it was sent to → our Message-ID in In-Reply-To or
// References → the sender's address against the owner's known addresses. Content matching is deliberately last-resort
// and only offered as a suggestion for the unmatched queue.
function routeInbound(msg) {
  const s = db.load();
  const byId = (id) => s.companies.find((c) => c.id === id);
  for (const a of msg.to) { const id = mail.companyIdFromAddress(a.email); if (id && byId(id)) return { company: byId(id), routed_by: "plus_address" }; }
  for (const h of [msg.in_reply_to, msg.references]) { const tok = mail.messageIdToken(h); if (tok && byId(tok.company_id)) return { company: byId(tok.company_id), routed_by: "in_reply_to" }; }
  const from = (msg.from.email || "").toLowerCase();
  if (from) {
    const c = s.companies.find((c) => [c.owner?.email, ...(c.owner?.alt_emails || [])].filter(Boolean).some((e) => String(e).toLowerCase() === from));
    if (c) return { company: c, routed_by: "sender" };
  }
  return null;
}
const LEGAL_FORMS = new Set(["gmbh", "aktiebolag", "aktieselskab", "osakeyhtiö", "holding", "group", "gruppe", "company", "limited"]);
function suggestCompanies(msg) {
  const s = db.load();
  const domain = (msg.from.email || "").split("@")[1] || "";
  const hay = agents.norm(`${msg.subject} ${msg.text}`);
  const out = [];
  for (const c of s.companies) {
    const ownerDomain = (c.owner?.email || "").split("@")[1] || "";
    let siteDomain = "";
    try { siteDomain = new URL(/^https?:/i.test(c.website || "") ? c.website : `https://${c.website}`).hostname.replace(/^www\./, ""); } catch { /* no usable website */ }
    // Name words of four letters or more, minus legal forms (Oy, AB, A/S, GmbH…): all of them must appear.
    const words = agents.norm(c.name).split(" ").filter((w) => w.length >= 4 && !LEGAL_FORMS.has(w));
    const surname = agents.norm(c.owner?.name || "").split(" ").pop();
    let score = 0;
    if (domain && (domain === ownerDomain || domain === siteDomain)) score += 5;
    if (words.length && words.every((w) => hay.includes(w))) score += 3;
    if (surname && surname.length >= 4 && hay.includes(surname)) score += 2;
    if (score) out.push({ company_id: c.id, name: c.name, country: c.country, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 5);
}
const seenProviderId = (id) => Boolean(id) && (db.load().inbox_unmatched.some((u) => u.provider_id === id) || db.load().companies.some((c) => c.conversation.some((e) => e.provider_id === id)));

// Store an inbound email: route it to a prospect and triage it, or park it in the unmatched queue.
async function ingestReceived(data, { fetch_body = true, wait = false } = {}) {
  const settings = db.load().settings;
  let msg = mail.normalizeReceived(data);
  if (msg.id && seenProviderId(msg.id)) return { ignored: "duplicate", id: msg.id };
  if (!msg.text && msg.id && fetch_body) {
    try {
      const full = await mail.fetchReceived(settings, msg.id);
      msg = { ...msg, ...full, id: msg.id, from: full.from.email ? full.from : msg.from, to: full.to.length ? full.to : msg.to };
    } catch (err) { console.warn(`[mail] could not fetch the body of ${msg.id}: ${err.message}`); }
  }
  if (!msg.from.email && !msg.text) return { ignored: "empty" };
  const payload = {
    text: mail.replyText(msg.text) || "(empty message)", text_full: msg.text, channel: "email", source: "resend",
    from: msg.from.name ? `${msg.from.name} <${msg.from.email}>` : msg.from.email, subject: msg.subject,
    provider_id: msg.id || null, rfc_message_id: msg.message_id || null, in_reply_to: msg.in_reply_to || null, references: msg.references || null,
  };
  const routed = routeInbound(msg);
  if (!routed) {
    const item = { id: db.uid("u"), at: db.now(), ...payload, to: msg.to.map((a) => a.email), suggestions: suggestCompanies(msg) };
    db.load().inbox_unmatched.unshift(item);
    db.save();
    console.log(`[mail] inbound from ${payload.from} matched no prospect → unmatched queue`);
    return { received: true, matched: false, unmatched_id: item.id, suggestions: item.suggestions };
  }
  const c = routed.company;
  console.log(`[mail] inbound from ${payload.from} → ${c.name} (${routed.routed_by})`);
  const entry = logInbound(c, { ...payload, routed_by: routed.routed_by });
  const triage = triageEntry(c, entry).catch((err) => console.error(`[triage] ${c.name}:`, err.message));
  if (wait) await triage;
  return { received: true, matched: true, company_id: c.id, company_name: c.name, entry_id: entry.id, routed_by: routed.routed_by };
}

// Resend delivery events land on the same webhook as received mail.
const DELIVERY_STATUS = { "email.sent": "sent", "email.delivered": "delivered", "email.delivery_delayed": "delayed", "email.bounced": "bounced", "email.complained": "complained", "email.opened": "opened", "email.clicked": "clicked", "email.failed": "failed" };
const DELIVERY_RANK = ["sent", "delayed", "delivered", "opened", "clicked"];
function recordDeliveryEvent(type, data) {
  const id = data.email_id || data.id;
  const found = db.findMessageByDeliveryId(id);
  if (!found) return { ignored: "unknown email id", type, id: id || null };
  const { company: c, message: m } = found;
  const next = DELIVERY_STATUS[type];
  m.delivery.events = [...(m.delivery.events || []), { type, at: data.created_at || db.now() }].slice(-20);
  if (next) {
    const terminal = ["bounced", "complained", "failed"].includes(next);
    if (terminal || DELIVERY_RANK.indexOf(next) > DELIVERY_RANK.indexOf(m.delivery.status)) m.delivery.status = next;
    if (next === "bounced" || next === "failed") {
      m.status = "bounced"; m.delivery.error = data.bounce?.message || data.failed?.reason || type;
      if (c.owner) c.owner.email_status = "bounced";
      cancelFollowUps(c, "email bounced");
    }
    if (next === "complained") { if (c.owner) c.owner.email_status = "complained"; cancelFollowUps(c, "recipient complained"); }
  }
  db.touch(c);
  return { ok: true, type, message_id: m.id, delivery: m.delivery.status };
}

// Point Resend's webhook (events: email.received plus the delivery events) at this URL; put the signing secret in Settings.
app.post("/api/mail/inbound/resend", wrap(async (req, res) => {
  const cfg = mail.config(db.load().settings);
  if (cfg.webhook_secret) {
    const v = mail.verifySvix(req.rawBody || "", req.headers, cfg.webhook_secret);
    if (!v.ok) { console.warn(`[mail] webhook rejected: ${v.reason}`); return res.status(401).json({ error: `Webhook signature rejected: ${v.reason}` }); }
  }
  const type = String(req.body?.type || "");
  const data = req.body?.data || req.body || {};
  if (type === "email.received" || (!type && (data.email_id || data.text || data.html))) return res.json(await ingestReceived(data, { fetch_body: true }));
  if (type.startsWith("email.")) return res.json(recordDeliveryEvent(type, data));
  res.json({ ignored: true, type });
}));
// Demo and test hook: an inbound email without Resend. Same routing and triage as the real webhook.
app.post("/api/mail/inbound/simulate", wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.text && !b.html) throw Object.assign(new Error("text is required"), { status: 400 });
  const data = { ...b, email_id: b.email_id || `sim${db.uid("")}` };
  if (b.company_id && !b.to) data.to = [mail.inboundAddress(db.load().settings, b.company_id) || `owners+${b.company_id}@simulated.local`];
  res.json(await ingestReceived(data, { fetch_body: false, wait: b.wait !== false }));
}));

// The unmatched queue: inbound mail no rule could place. Assigning it runs the normal reply flow and remembers the address.
app.get("/api/mail/unmatched", (req, res) => res.json(db.load().inbox_unmatched));
app.post("/api/mail/unmatched/:id/assign", wrap(async (req, res) => {
  const s = db.load();
  const i = s.inbox_unmatched.findIndex((u) => u.id === req.params.id);
  if (i < 0) throw notFound("Unmatched email");
  const c = company(req.body?.company_id);
  const [item] = s.inbox_unmatched.splice(i, 1);
  const { id, at, suggestions, to, ...payload } = item;
  const sender = mail.parseAddress(item.from).email;
  if (sender) {
    c.owner = c.owner || {};
    if (!c.owner.email) c.owner.email = sender;
    else if (c.owner.email.toLowerCase() !== sender && !(c.owner.alt_emails || []).includes(sender)) c.owner.alt_emails = [...(c.owner.alt_emails || []), sender];
  }
  await handleInboundReply(c, { ...payload, at, routed_by: "manual" });
  res.json(c);
}));
app.delete("/api/mail/unmatched/:id", (req, res) => {
  const s = db.load();
  const i = s.inbox_unmatched.findIndex((u) => u.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: "Unmatched email not found" });
  s.inbox_unmatched.splice(i, 1); db.save();
  res.json({ ok: true });
});

// The inbox: one thread per prospect with a conversation, owners waiting for an answer on top, newest first.
const INBOX_ORDER = { needs_reply: 0, waiting: 1, done: 2 };
app.get("/api/inbox", (req, res) => {
  const s = db.load();
  const items = s.companies.map(db.inboxItem).filter(Boolean)
    .sort((a, b) => (INBOX_ORDER[a.status] - INBOX_ORDER[b.status]) || String(b.last_at).localeCompare(String(a.last_at)));
  const counts = { needs_reply: 0, waiting: 0, done: 0, unmatched: s.inbox_unmatched.length };
  for (const it of items) counts[it.status]++;
  res.json({ items, counts, unmatched: s.inbox_unmatched, mail: mailStatus() });
});

const SWEEP_MINUTES = Number(process.env.SEND_SWEEP_MINUTES ?? 1);
function mailStatus() {
  const s = db.load();
  const cfg = mail.config(s.settings);
  let scheduled = 0, due = 0;
  for (const c of s.companies) for (const m of c.messages) if (m.status === "scheduled") { scheduled++; if (m.due) due++; }
  return {
    configured: mail.configured(s.settings), from: cfg.from || null, inbound_domain: cfg.inbound_domain || null,
    inbound_example: mail.inboundAddress(s.settings, "c_ab12cd"), webhook_url: `${BASE_URL}/api/mail/inbound/resend`, webhook_signing: Boolean(cfg.webhook_secret),
    sweep_minutes: SWEEP_MINUTES, scheduled, due, unmatched: s.inbox_unmatched.length,
  };
}
app.get("/api/mail/status", (req, res) => res.json(mailStatus()));

// Sequence scheduler: send due follow-ups by email, hand LinkedIn and unconfigured ones to the advisor as "due", and
// drop anything the owner has already answered.
async function sweepScheduled({ now = Date.now() } = {}) {
  const s = db.load();
  const out = { sent: 0, due: 0, cancelled: 0, errors: [] };
  // Sends stamped on another calendar day than `now` (only when a demo fakes the clock) still count against today's cap.
  const extra = new Map();
  for (const c of s.companies) {
    for (const m of c.messages) {
      if (m.status !== "scheduled" || !m.send_at || Date.parse(m.send_at) > now) continue;
      const repliedSince = ownerRepliedSince(c, firstSent(c));
      if (repliedSince || c.stage === "disqualified" || c.stage === "mandate_signed") {
        m.status = "cancelled"; m.cancel_reason = repliedSince ? "owner replied" : `stage ${c.stage}`; m.send_at = null; m.due = false; out.cancelled++; db.touch(c);
        continue;
      }
      if (m.channel === "email" && mail.configured(s.settings) && c.owner?.email) {
        const adv = db.advisorFor(c);
        if (adv && db.sentToday(adv.id, now) + (extra.get(adv.id) || 0) >= db.capOf(adv)) {
          m.send_at = new Date(db.nextSendWindow(now)).toISOString(); m.deferred_reason = "daily cap"; out.deferred = (out.deferred || 0) + 1; db.touch(c);
          continue;
        }
        // Demo mode redirects every send to one inbox: let at most two queued first touches through per sweep.
        if (m.step === 1 && (s.settings.demo_email || process.env.DEMO_EMAIL) && (out.first_touches || 0) >= 2) continue;
        if (m.step === 1) out.first_touches = (out.first_touches || 0) + 1;
        try {
          await deliver(c, m, "scheduler", { now }); out.sent++;
          if (adv && new Date(m.sent_at).toDateString() !== new Date(now).toDateString()) extra.set(adv.id, (extra.get(adv.id) || 0) + 1);
        }
        catch (err) {
          if (err.capped) { m.send_at = err.next_at; m.deferred_reason = "daily cap"; out.deferred = (out.deferred || 0) + 1; db.touch(c); continue; }
          const attempts = (m.delivery?.attempts || 0) + 1;
          m.delivery = { ...(m.delivery || {}), provider: "resend", status: "error", error: err.message, attempts, last_attempt_at: db.now() };
          if (attempts >= 3) m.due = true; // stop retrying; the advisor sees "due" and sends by hand
          out.errors.push({ message_id: m.id, company: c.name, error: err.message });
          db.touch(c);
        }
      } else if (!m.due) { m.due = true; out.due++; db.touch(c); }
    }
  }
  return out;
}
// `now` (ISO) pretends it is later, to run a due follow-up on demand in a demo or test.
app.post("/api/mail/sweep", wrap(async (req, res) => {
  const now = req.body?.now ? Date.parse(req.body.now) : Date.now();
  if (!Number.isFinite(now)) throw Object.assign(new Error("now must be an ISO timestamp"), { status: 400 });
  res.json(await sweepScheduled({ now }));
}));
if (SWEEP_MINUTES > 0) setInterval(() => sweepScheduled().catch((err) => console.error("[mail] sweep failed:", err.message)), SWEEP_MINUTES * 60e3).unref();

// ---------------- advisor capacity and the first-touch send queue ----------------
app.get("/api/advisors/capacity", (req, res) => res.json(db.capacity()));
// Queue every approved first-touch email: best prospects first, spread over each advisor's working day (08:00-17:00) up to
// their daily cap, overflow to the following working days. The sweep sends them; follow-ups are scheduled after each send.
const WORKDAY_MS = 9 * 3600e3;
const dayStart = (t) => { const d = new Date(t); d.setHours(8, 0, 0, 0); return d.getTime(); };
app.post("/api/outreach/queue", wrap(async (req, res) => {
  const s = db.load();
  const now = Date.now();
  const items = [];
  for (const c of s.companies) for (const m of c.messages) {
    if (m.step === 1 && m.channel === "email" && m.status === "approved" && !["disqualified", "mandate_signed"].includes(c.stage)) items.push({ c, m });
  }
  items.sort((a, b) => (b.c.score?.readiness ?? 0) - (a.c.score?.readiness ?? 0));
  const limit = Math.max(1, Math.min(5000, Number(req.body?.limit) || 5000));
  let first = dayStart(now);
  if (now > first + WORKDAY_MS || [0, 6].includes(new Date(now).getDay())) first = dayStart(db.nextSendWindow(now));
  const load = new Map(); // `${advisor}|${day}` → emails already planned that day
  const used = (adv, day) => {
    const k = `${adv.id}|${day}`;
    if (!load.has(k)) load.set(k, scheduledOn(s, adv.id, day) + (day === dayStart(now) ? db.sentToday(adv.id, now) : 0));
    return load.get(k);
  };
  const summary = {};
  let queued = 0;
  for (const { c, m } of items.slice(0, limit)) {
    const adv = db.advisorFor(c);
    if (!adv) continue;
    const cap = db.capOf(adv);
    let day = first;
    while (used(adv, day) >= cap) day = dayStart(db.nextSendWindow(day));
    const n = used(adv, day);
    load.set(`${adv.id}|${day}`, n + 1);
    const slot = day + Math.floor((n * WORKDAY_MS) / cap); // evenly spaced across the working day
    m.status = "scheduled"; m.send_at = new Date(Math.max(slot, now + 2 * 60e3)).toISOString(); m.due = false; delete m.deferred_reason;
    db.touch(c);
    queued++;
    const row = (summary[adv.id] ||= { advisor: adv.name, daily_cap: cap, queued: 0, first_at: m.send_at, last_at: m.send_at, days: new Set() });
    row.queued++;
    if (m.send_at < row.first_at) row.first_at = m.send_at;
    if (m.send_at > row.last_at) row.last_at = m.send_at;
    row.days.add(day);
  }
  res.json({ queued, skipped: Math.max(0, items.length - limit), advisors: Object.values(summary).map((r) => ({ ...r, days: r.days.size })) });
}));
// Emails already scheduled for an advisor on the working day that starts at `day`.
function scheduledOn(s, advisorId, day) {
  let n = 0;
  for (const c of s.companies) for (const m of c.messages) {
    if (m.status !== "scheduled" || m.channel !== "email" || !m.send_at) continue;
    const t = Date.parse(m.send_at);
    if (t >= day && t < day + 24 * 3600e3 && db.advisorFor(c)?.id === advisorId) n++;
  }
  return n;
}

// What Mergero told us, for MCP clients and other agents that write their own messages.
app.get("/api/playbook", (req, res) => res.json({
  icp: playbook.ICP, mandate_path: playbook.MANDATE_PATH, meetings_before_mandate: playbook.MEETINGS_BEFORE_MANDATE,
  messaging_principles: playbook.MESSAGING_PRINCIPLES, readiness_signals: playbook.READINESS_SIGNALS, value_prop: playbook.VALUE_PROP,
  time_saved_minutes: playbook.TIME_SAVED_MINUTES, stages: db.STAGES,
}));

// ---------------- buyers ----------------
app.get("/api/buyers", (req, res) => { const buyers = db.load().buyers; buyers.forEach((b) => suggest.ensureBuyerContacts(b)); res.json(buyers); });
app.post("/api/buyers", wrap(async (req, res) => {
  const b = { id: db.uid("b"), active: true, sectors: [], geographies: [], deal_types: [], ...req.body };
  db.load().buyers.push(b); db.save(); res.json(b);
}));
app.put("/api/buyers/:id", wrap(async (req, res) => {
  const b = db.load().buyers.find((x) => x.id === req.params.id);
  if (!b) throw notFound("Buyer");
  Object.assign(b, req.body, { id: b.id }); db.save(); res.json(b);
}));
app.delete("/api/buyers/:id", wrap(async (req, res) => {
  const s = db.load(); const i = s.buyers.findIndex((x) => x.id === req.params.id);
  if (i < 0) throw notFound("Buyer");
  s.buyers.splice(i, 1); db.save(); res.json({ ok: true });
}));

// ---------------- settings ----------------
app.get("/api/settings", (req, res) => res.json(db.publicSettings()));
// Model provider status: which provider is active and whether Verda's Mistral endpoint answers.
app.get("/api/llm/status", wrap(async (req, res) => {
  const s = db.load().settings;
  const active = llmProvider.provider(s);
  const verda = llmProvider.verdaConfigured(s) ? await llmProvider.verdaPing(s) : { ok: false, configured: false, reason: "not configured" };
  res.json({ provider: active, anthropic_configured: Boolean(s.api_key || process.env.ANTHROPIC_API_KEY), verda, fallback: llmProvider.fallbackAllowed(s), web_tools: llmProvider.webToolsAvailable(s), model: active === "verda" ? llmProvider.verdaConfig(s).model : s.model });
}));
app.put("/api/settings", wrap(async (req, res) => {
  const s = db.load().settings;
  const b = req.body || {};
  if (typeof b.api_key === "string" && b.api_key.trim()) s.api_key = b.api_key.trim();
  if (typeof b.workspace_id === "string") s.workspace_id = b.workspace_id.trim();
  if (typeof b.voice_samples === "string") s.voice_samples = b.voice_samples.trim().slice(0, 12000);
  if (typeof b.demo_email === "string") s.demo_email = b.demo_email.trim();
  if (typeof b.llm_provider === "string") s.llm_provider = b.llm_provider.trim().toLowerCase();
  if (typeof b.verda_base_url === "string") s.verda_base_url = b.verda_base_url.trim();
  if (typeof b.verda_api_key === "string" && b.verda_api_key.trim()) s.verda_api_key = b.verda_api_key.trim();
  if (typeof b.verda_model === "string") s.verda_model = b.verda_model.trim();
  if (b.llm_fallback === true || b.llm_fallback === false || b.llm_fallback === null) s.llm_fallback = b.llm_fallback;
  if (b.lint_threshold != null && !Number.isNaN(Number(b.lint_threshold))) s.lint_threshold = Math.max(0, Math.min(100, Number(b.lint_threshold)));
  if (b.model) s.model = b.model;
  if (b.sender) s.sender = { ...s.sender, ...b.sender };
  if (Array.isArray(b.advisors)) {
    s.advisors = b.advisors.filter((a) => a && String(a.name || "").trim()).map((a) => ({
      id: a.id || db.uid("adv"), name: String(a.name).trim(), title: String(a.title || "").trim(), email: String(a.email || "").trim(), phone: String(a.phone || "").trim(),
      markets: (Array.isArray(a.markets) ? a.markets : String(a.markets || "").split(/[,\s]+/)).map((x) => String(x).trim().toUpperCase()).filter(Boolean),
      daily_cap: db.capOf(a),
    }));
  } else if (b.sender && s.advisors?.[0]) {
    // Editing the sender identity edits the first advisor, so outreach keeps signing with the same name.
    s.advisors[0] = { ...s.advisors[0], ...Object.fromEntries(["name", "title", "email", "phone"].filter((k) => b.sender[k]).map((k) => [k, b.sender[k]])) };
  }
  if (typeof b.style_rules === "string") s.style_rules = b.style_rules;
  if (Array.isArray(b.value_props)) s.value_props = b.value_props.filter(Boolean);
  if (b.funnel_assumptions) s.funnel_assumptions = { ...s.funnel_assumptions, ...b.funnel_assumptions };
  if (b.mail && typeof b.mail === "object") {
    s.mail = { ...s.mail };
    for (const k of ["from", "inbound_domain"]) if (typeof b.mail[k] === "string") s.mail[k] = b.mail[k].trim();
    for (const k of ["resend_api_key", "webhook_secret"]) {
      if (typeof b.mail[k] === "string" && b.mail[k].trim()) s.mail[k] = b.mail[k].trim(); // blank keeps the current secret
      if (b.mail[`clear_${k}`] === true) s.mail[k] = "";
    }
  }
  db.save(); res.json(db.publicSettings());
}));
app.post("/api/reset-demo", (req, res) => { db.resetToSeed(); res.json({ ok: true }); });

// ---------------- owner intake (public chat) ----------------
const intakeByToken = (token) => db.load().companies.find((c) => c.intake?.token === token) || (() => { throw notFound("Intake link"); })();
app.post("/api/companies/:id/intake-link", wrap(async (req, res) => {
  const c = company(req.params.id);
  if (!c.intake || c.intake.status === "complete") c.intake = { token: db.uid("t") + db.uid(""), status: "pending", summary: null, transcript: [] };
  db.touch(c);
  res.json({ url: `${BASE_URL}/intake/${c.intake.token}`, token: c.intake.token });
}));
app.get("/intake/:token", (req, res) => res.sendFile(path.join(here, "..", "public", "intake.html")));
app.get("/api/intake/:token", wrap(async (req, res) => {
  const c = intakeByToken(req.params.token);
  const s = db.settingsFor(c);
  if (!c.intake.transcript.length && c.intake.status !== "complete") {
    const t = await agents.intakeTurn(c, [], s);
    c.intake.transcript.push({ role: "assistant", text: t.reply, at: db.now() });
    c.intake.status = "in_progress";
    db.touch(c);
  }
  res.json({ company_name: c.name, firm: s.sender.firm, advisor_name: s.sender.name, status: c.intake.status, transcript: c.intake.transcript });
}));
app.post("/api/intake/:token/message", wrap(async (req, res) => {
  const c = intakeByToken(req.params.token);
  const text = (req.body?.text || "").trim();
  if (!text) throw Object.assign(new Error("text is required"), { status: 400 });
  if (c.intake.status === "complete") return res.json({ reply: "Thank you, this conversation is complete.", status: "complete", summary: c.intake.summary });
  c.intake.transcript.push({ role: "owner", text, at: db.now() });
  const t = await agents.intakeTurn(c, c.intake.transcript, db.settingsFor(c));
  c.intake.transcript.push({ role: "assistant", text: t.reply, at: db.now() });
  c.intake.status = t.status;
  if (t.status === "complete" && t.summary) {
    c.intake.summary = t.summary;
    c.intake.completed_at = db.now();
    db.advance(c, "warming");
    c.conversation.push({ id: db.uid("e"), direction: "inbound", channel: "intake", text: `Owner completed intake questionnaire.\n${Object.entries(t.summary).filter(([k]) => k !== "open_questions").map(([k, v]) => `${k}: ${v}`).join("\n")}`, at: db.now(), triage: null });
  }
  db.touch(c);
  res.json({ reply: t.reply, status: t.status, summary: t.summary || undefined });
}));

// SPA fallback for hash routes is implicit (index.html is static). Start.
const store = await db.init();
// Both-sides outreach suggestions, buyer notes, and the integration surface for external scraper/matcher/mailer.
suggest.register(app);
integrations.register(app, { baseUrl: BASE_URL });
learning.register(app);
publicDemand.register(app); // owner-facing /demand page + intake demand snapshot + inbound leads
mgx.register(app);         // MGX Deal Engine buyer mandates over API (sample data until MGX_API_URL is set)
buyside.register(app);      // buy-side mandate generation: thesis → registry targets → scored list → pitch
// API usage/cost is attributed per company and persisted with the rest of the state.
agents.hydrateUsage(db.load().usage);
agents.onUsage((u) => { db.load().usage = u; db.save(); });

export default app;

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Mergero Origination Engine → ${BASE_URL} (storage: ${store}${WATCH_HOURS > 0 ? `, watch every ${WATCH_HOURS}h` : ""})`);
    {
      const s = db.load().settings, p = llmProvider.provider(s), v = llmProvider.verdaConfig(s);
      console.log(p === "verda"
        ? `Model: ${v.model || "?"} at ${v.base_url || "?"} (Verda, EU)${llmProvider.fallbackAllowed(s) ? " · falls back to Claude" : " · strict: no call leaves Verda"}`
        : `Model: Claude ${s.model || "claude-opus-5"}${s.api_key || process.env.ANTHROPIC_API_KEY ? "" : " (API key NOT set: add it in Settings or .env)"}`);
    }
    console.log(mail.configured(db.load().settings)
      ? `Email: Resend configured (from ${mail.config(db.load().settings).from}); webhook ${BASE_URL}/api/mail/inbound/resend`
      : "Email: not configured (Send opens a mailto: link; set RESEND_API_KEY + RESEND_FROM or fill in Settings → Email delivery)");
  });
}
