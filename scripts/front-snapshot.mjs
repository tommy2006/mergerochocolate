// Bakes public/front/snapshot.json from a running engine, so the front door never shows an empty screen on stage.
// Usage: node scripts/front-snapshot.mjs [base-url]   (default http://localhost:3000; the Verda instance works too)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const base = String(process.argv[2] || process.env.MERGERO_API_URL || "http://localhost:3000").replace(/\/+$/, "");
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "front", "snapshot.json");
const get = async (p) => { const r = await fetch(base + p, { signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json(); };

// Only what the front door renders: keeps the file small and free of settings or keys.
export function slim(c) {
  const facts = (c.research?.facts || []).filter((f) => f.url && f.claim).slice(0, 40).map((f) => ({ id: f.id, category: f.category, claim: f.claim, url: f.url, as_of: f.as_of || null }));
  return {
    id: c.id, name: c.name, country: c.country, city: c.city || null, industry: c.industry || null, website: c.website || null,
    founded: c.founded || null, employees: c.employees ?? null, revenue_eur: c.revenue_eur ?? null, ebitda_eur: c.ebitda_eur ?? null,
    ownership_type: c.ownership_type || null, stage: c.stage,
    enrichment: c.enrichment ? { products: (c.enrichment.products || []).slice(0, 3), summary: c.enrichment.summary || "" } : null,
    owner: c.owner ? { name: c.owner.name || "", title: c.owner.title || "", age: c.owner.age ?? null, age_source: c.owner.age_source || null } : null,
    score: c.score ? { readiness: c.score.readiness, attractiveness: c.score.attractiveness, recommended_timing: c.score.recommended_timing, why_now: c.score.why_now, signals: c.score.signals || [], risks: c.score.risks || [], valuation_band_eur: c.score.valuation_band_eur || null, history: c.score.history || [] } : null,
    matches: (c.matches || []).map((m) => ({ buyer_id: m.buyer_id, buyer_name: m.buyer_name, buyer_type: m.buyer_type, fit: m.fit, reason: m.reason })),
    research: c.research ? { facts, financials: c.research.financials || null } : null,
    messages: (c.messages || []).filter((m) => m.step >= 0).map((m) => ({ id: m.id, step: m.step, channel: m.channel, subject: m.subject, body: m.body, status: m.status, send_after_days: m.send_after_days, lint: m.lint?.after ? { score: m.lint.after.score, blocks_send: m.lint.after.blocks_send } : null, in_reply_to: m.in_reply_to || null })),
    conversation: (c.conversation || []).map((e) => ({ id: e.id, direction: e.direction, channel: e.channel, text: e.text, at: e.at, triage: e.triage ? { intent: e.triage.intent, sentiment: e.triage.sentiment, next_step: e.triage.next_step } : null, score_update: e.score_update || null })),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [companies, settings, capacity, reach, stats] = await Promise.all([
    get("/api/engine/companies"), get("/api/engine/settings"), get("/api/engine/advisors/capacity"),
    get("/api/engine/registry/reach").catch(() => null), get("/api/engine/stats").catch(() => null),
  ]);
  const snap = {
    baked_at: new Date().toISOString(), source: base,
    companies: companies.filter((c) => c.score).map(slim),
    settings: { funnel_assumptions: settings.funnel_assumptions, advisors: (settings.advisors || []).map((a) => ({ id: a.id, name: a.name, title: a.title, markets: a.markets, daily_cap: a.daily_cap })), sender: { name: settings.sender?.name, title: settings.sender?.title, firm: settings.sender?.firm } },
    capacity, reach, scale: stats?.scale || null, total: companies.length,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(snap, null, 1));
  console.log(`snapshot: ${snap.companies.length} scored companies from ${base} → ${path.relative(process.cwd(), out)}`);
}
