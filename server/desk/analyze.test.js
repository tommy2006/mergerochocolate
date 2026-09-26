// Offline checks for the buy-side "dig deeper" analysis: field summaries, sector hints, evidence as text, route guards.
// Isolated DATA_DIR so this never touches the running app's data/db.json. No network, no model calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mergero-analyze-"));
process.env.DATA_DIR = dir;

const { default: express } = await import("express");
const desk = await import("./routes.js");
const A = await import("./analyze.js");
const db = await import("../db.js");
const { statementWindow } = await import("../research/pdf.js");
const { reconcileRows } = await import("../research/index.js");
const ocr = await import("../research/ocr.js");

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}
async function json(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
  return { status: r.status, body: await r.json() };
}

const researched = () => ({
  research: {
    ran_at: new Date().toISOString(), site: { pages_read: 12 },
    facts: [
      { category: "offering", claim: "Makes ventilation ducts in Spydeberg", url: "https://www.example.no/about", confidence: "high" },
      { category: "customers", claim: "Supplies ventilation contractors such as Askim & Mysen Rør", url: "https://www.example.no/customers", confidence: "medium" },
      { category: "events", claim: "Low-confidence rumour", url: "https://x.example", confidence: "low" },
    ],
    financials: {
      rows: [{ year: 2025, currency: "NOK", ebit: 12454251, ebit_eur: 1148916, revenue_eur: 6644515, ebitda_eur: null, source: "Brønnøysund Regnskapsregisteret (NO)", confidence: "high" }],
      documents: [{ type: "annual_report", year: 2025, format: "pdf", url: "https://data.brreg.no/regnskapsregisteret/regnskap/aarsregnskap/kopi/1/2025", source: "Brønnøysund" }],
    },
  },
});

test("summary: EBITDA placeholder explains what the register lacks, then the derived figure with its source", () => {
  const c = { name: "Example AS", country: "NO", ebitda_eur: null, revenue_eur: 6644515, ...researched(), enrichment: null };
  const s = A.summary(c);
  assert.equal(s.ebitda.label, "Pending Audit");
  assert.match(s.ebitda.detail, /EBIT €1\.1M, revenue €6\.6M \(2025, Brønnøysund Regnskapsregisteret \(NO\)\); depreciation is not in the open register/);
  assert.equal(s.customers.source, null);
  const row = c.research.financials.rows[0];
  row.ebitda_eur = 1400000; row.ebitda_basis = "derived"; row.also_from = ["Read from PDF (text)"]; c.ebitda_eur = 1400000;
  c.enrichment = { research_based: true, customers: ["Askim & Mysen Rør AS", "Sheet-metal workshops in Østfold"], customer_segments: [{ segment: "Ventilation contractors" }], products: ["Ducts"], offering: { summary: "Aer Faber manufactures ventilation ducts and sells them to contractors." } };
  const s2 = A.summary(c);
  assert.equal(s2.ebitda.label, "€1.4M");
  assert.equal(s2.ebitda.detail, "2025, EBIT + depreciation, Brønnøysund Regnskapsregisteret (NO) + Read from PDF (text)");
  assert.deepEqual(s2.sources, ["Brønnøysund Regnskapsregisteret (NO)", "Read from PDF (text)"]);
  const o = A.profileOverrides(c);
  assert.equal(o.customers, "Askim & Mysen Rør AS, Sheet-metal workshops in Østfold");
  assert.match(o.products, /^Aer Faber manufactures ventilation ducts/);
  assert.match(A.summaryLine(c), /^Example AS: EBITDA €1\.4M \(2025\) · 2 customers named · 12 pages read, 3 facts$/);
});

test("sector hint understands stems the quick screen used to miss", () => {
  assert.equal(A.sectorHint("Aer Faber manufactures ventilation ducts"), "Manufacturing & Industrial Automation");
  assert.equal(A.sectorHint("recycling and waste collection"), "Circular economy / Waste logistics");
  assert.equal(A.sectorHint("a cloud platform for workshops"), "B2B SaaS & Digital Services");
  assert.equal(A.sectorHint("nothing relevant here"), "");
});

test("statement window keeps the income-statement pages first and marks page numbers", () => {
  const text = ["Forside og styrets beretning", "RESULTATREGNSKAP\nDriftsinntekter 100\nAvskrivning 5\nDriftsresultat 12", "Noter uten tall"].join("\n\f\n");
  const w = statementWindow(text, { maxChars: 80 });
  assert.match(w, /--- page 2 ---/);
  assert.doesNotMatch(w, /--- page 1 ---/);
});

test("desk profiles print evidence as text and the analyze route guards its inputs", async (t) => {
  await db.init();
  const s = db.load();
  const c = db.normalizeCompany({ name: "Example Evidence AS", country: "NO", website: "https://www.example.no", source: "test", ...researched() });
  s.companies.unshift(c); db.save();
  const app = express();
  app.use(express.json());
  desk.register(app, { baseUrl: "http://127.0.0.1:0" });
  const { server, url } = await listen(app);
  t.after(async () => { await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

  const list = await json(`${url}/api/companies`);
  const row = list.body.data.find((x) => x.company_name === "Example Evidence AS");
  assert.ok(row, "company listed");
  const one = await json(`${url}/api/companies/${row.company_id}`);
  const ev = one.body.profile.evidence;
  assert.ok(Array.isArray(ev) && ev.length === 2, "two usable facts");
  assert.ok(ev.every((e) => typeof e === "string"), "evidence entries are strings, never objects");
  assert.equal(ev[0], "Supplies ventilation contractors such as Askim & Mysen Rør (example.no)");
  assert.equal(one.body.profile.ebitda, "Pending Audit");
  assert.match(one.body.profile.ebitda_detail, /depreciation is not in the open register/);
  assert.equal(one.body.profile.analysis, null);

  const missing = await json(`${url}/api/analyze`, { method: "POST", body: JSON.stringify({ deal_id: 999999 }) });
  assert.equal(missing.status, 404);
  const empty = await json(`${url}/api/analyze`, { method: "POST", body: JSON.stringify({}) });
  assert.equal(empty.status, 400);
});

test("OCR module reports availability honestly and always yields a language string", () => {
  const a = ocr.ocrAvailable({ force: true });
  assert.equal(typeof a.ok, "boolean");
  assert.ok(Array.isArray(a.langs));
  if (!a.ok) assert.match(a.reason, /not installed/);
  assert.match(ocr.langsFor("NO"), /^[a-z_+]+$/);
});

test("statement figures are anchored to the register's unit and discarded when they still disagree", () => {
  const register = [{ year: 2025, revenue: 1279002000, ebit: 13102000, confidence: "high", source: "Brønnøysund Regnskapsregisteret (NO)" }];
  const fx = 0.0922;
  const thousands = [
    { year: 2025, revenue: 1279002, ebit: 13102, depreciation: 52090, ebitda: 65192, net_income: 9000, fx_to_eur: fx, source: "Annual report PDF" },
    { year: 2024, revenue: 1161996, ebit: -16989, depreciation: 52090, ebitda: 35101, net_income: null, fx_to_eur: fx, source: "Annual report PDF" },
  ];
  const w = [];
  const out = reconcileRows(thousands, register, w);
  assert.equal(w.length, 0);
  assert.equal(out.length, 2);
  assert.equal(out[0].ebit, 13102000);
  assert.equal(out[1].ebitda, 35101000);
  assert.equal(out[1].ebitda_eur, Math.round(35101000 * fx));
  assert.equal(out[1].unit_scale, 1000);
  const wrong = reconcileRows([{ year: 2025, revenue: 1279002000, ebit: 900000, depreciation: 1, fx_to_eur: fx, source: "Annual report PDF" }], register, w);
  assert.deepEqual(wrong, []);
  assert.match(w[0], /EBIT 900,000 does not match the register's 13,102,000/);
  const off = reconcileRows([{ year: 2025, revenue: 777, ebit: 5, fx_to_eur: fx, source: "Annual report PDF" }], register, w);
  assert.deepEqual(off, []);
  assert.match(w[1], /at any unit/);
  assert.deepEqual(reconcileRows([{ year: 2023, revenue: 5, ebit: 1, fx_to_eur: fx }], register, []), [{ year: 2023, revenue: 5, ebit: 1, fx_to_eur: fx }], "no register year to anchor on: kept as read");
});

test("a misread revenue digit does not lose the statement when EBIT still anchors the unit", () => {
  const register = [{ year: 2025, revenue: 1279002000, ebit: 13102000, confidence: "high", source: "Brønnøysund Regnskapsregisteret (NO)" }];
  const w = [];
  const out = reconcileRows([{ year: 2025, revenue: 279002, ebit: 13102, depreciation: 52090, ebitda: 65192, fx_to_eur: 0.0922, source: "Annual report PDF" }], register, w);
  assert.equal(out.length, 1);
  assert.equal(out[0].revenue, null, "the misread revenue is dropped; the register's stands");
  assert.equal(out[0].ebit, 13102000);
  assert.equal(out[0].ebitda, 65192000);
  assert.equal(out[0].unit_scale, 1000);
  assert.match(w[0], /revenue 279,002 was misread/);
});
