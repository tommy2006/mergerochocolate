# Mergero Origination Engine

Sell-side M&A deal-origination copilot. Turns a thin prospect-database row into a researched, scored, buyer-matched prospect with a humanized 3-touch outreach sequence, triages the owner's replies, and gathers the information Mergero needs through a conversational owner intake link — at pipeline scale, with a human approving every message before it leaves.

## Launch (2 minutes)

```bash
npm install
```

Add your Anthropic key either in `.env` (copy `.env.example`) **or** later in the app under Settings.

```bash
npm start
```

Open http://localhost:3000. Demo data (24 fictional prospects, 12 anonymised buyer mandates) loads on first start. `Settings → Reset demo data` restores it.

## Demo flow (3 minutes)

1. **Dashboard** – funnel, projected mandates, pending approvals, unhandled replies.
2. **Prospects** – open a `new` company (or `Import CSV` with `data/sample_prospects.csv`).
3. **Run full pipeline** – watch the four agents fill the tabs: Profile & signals → Score & why now → Buyer demand → Outreach (each message shows its humanizer score, e.g. "AI-tell 58 → 7").
4. **Approve / Send** a message (opens your mail client via `mailto:`, marks it sent, stage → contacted).
5. **Conversation** – paste an owner reply → triage card (intent, extracted facts, next step) + a ready reply draft.
6. **Owner intake** – generate a link, open it in a new tab as the owner, answer a few questions → structured summary lands back on the company.
7. **Dashboard → Run pipeline on all NEW prospects** – the scale story; bounded concurrency, live progress.

### Sourcing at scale: registry lookup

The floating **🔎 Registry lookup** button queries official open-data company registers directly — Finland (PRH/YTJ, filter by TOL industry code, city, founded-before), Norway (Brønnøysund, NACE code, min. employees, founded-before), Denmark (CVR name lookup) — and imports the selected companies as `new` prospects. Then *Run pipeline on all NEW prospects* researches, scores, matches and drafts outreach for every one of them. No scraping of commercial databases, no ToS issues: these are public APIs.

### Built on Mergero's answers: the playbook

`server/playbook.js` holds what Mergero told us and feeds the agents: the ideal profile (€2–50M revenue, €3–5M valuation floor, majority owner 55+ or facing succession), the mandate path (first touch → owner replied → warm-up → first call booked → engagement letter — the pipeline stages use these names), readiness signals for owners who have *not yet* considered selling, and messaging principles (never "sell" in a first touch, lead with buyer demand, small ask). Next to **Draft outreach** you choose the **conversation framing** — Open conversation (default), Growth capital, Partial / minority stake, or Full sale — and the sequence is written and humanized for that door. The dashboard's **Analyst hours saved** KPI counts the research and first-touch work the agents replaced.

## Web research: the company's whole web presence, with sources

**▶ Run full pipeline** (or **0 · Research web** on a company) now starts with a research step that goes well beyond the prospect database:

- **Own website:** crawls it within robots.txt, using the sitemap and menu links. Picks product, customer, location, about/strategy, news and report pages in six languages. Also reads JSON-LD, business IDs from footers and imprints, and language versions. JavaScript-only sites are rendered in the local Chrome/Edge.
- **Filed accounts:** pulled from open registries. Norway (Brønnøysund), Finland (PRH iXBRL) and Denmark (Virk XBRL) are covered, converted to EUR.
- **The wider web:** localised Claude web search for press, events, published figures and annual-report PDFs. One PDF per run is read directly.
- **Only sourced facts:** a fact is kept only if its quote is really on the page it cites, or its URL came back from the search tools.
- **Downstream use:** the profile, scoring, buyer matching, outreach, reply triage and intake all use these facts.

The **Web dossier** tab shows everything with source links. **Watch mode** re-crawls researched sites on demand (dashboard → *Check sites*) or every `WATCH_INTERVAL_HOURS`. It flags a new CEO, new sites, acquisitions and hiring spikes as timing alerts. After a mandate is signed, **Buyer demand → Draft teaser** writes an anonymised one-pager for matched buyers.

> Demo tip: the seed prospects use fictional `*-demo.*` domains, so research on them falls back to web search only. For the full effect, import real companies with **🔎 Registry lookup**. Norway works best, because its registry has the website and the org number that unlocks filed accounts.

## Agents (all Claude, `claude-opus-5` by default, structured outputs via Zod)

| Agent | Input | Tools | Output |
|---|---|---|---|
| Research | website + registry id | own crawler (robots.txt-aware) + open registries + `web_search`/`web_fetch` + PDF input | sourced facts, filed financials, site map, watch snapshot |
| Enrichment | prospect row + research dossier | (falls back to `web_search` + `web_fetch` when no dossier) | profile incl. offering, customer groups, footprint, direction, financial view (each citing fact ids) |
| Sale-readiness scoring | profile + buyer network | – | readiness, attractiveness, valuation band, €3–5M floor check, why-now |
| Buyer matching | profile + mandates | deterministic prefilter → LLM rerank | ranked buyers with reasons |
| Outreach writer | profile + score + matches + house style + playbook + framing | – | 3-touch sequence, channel by market (Nordics email, DACH LinkedIn), framed as open / growth / minority / full sale |
| Humanizer critic | each draft | – | AI-tell flags, rewrite, before/after score |
| Reply triage | inbound reply + history | – | intent, facts, stage, next step, reply draft |
| Owner intake | chat transcript | – | next question / completed structured summary |

## Config

`.env`: `ANTHROPIC_API_KEY`, `ANTHROPIC_WORKSPACE_ID` (only for org-level keys that are not scoped to a workspace), `CLAUDE_MODEL` (default `claude-opus-5`), `PORT` (3000), `BASE_URL` (use an ngrok URL to open intake links from a phone). The key and workspace ID can also be entered under Settings.

Research settings, all optional:
- `RESEARCH_MAX_AGE_DAYS` (default 7): how long a company's research is reused.
- `WATCH_INTERVAL_HOURS` (default 0 = on demand only): how often researched sites are re-crawled.
- `BROWSER_PATH`: the Chrome/Edge used for JavaScript-only sites (auto-detected when unset).

Data lives in `data/db.json`. Set `DATABASE_URL` to use Postgres instead: the first start migrates the JSON file in, and each save writes only changed rows. `DATA_DIR` points the JSON store elsewhere. API contract: `API.md`.
