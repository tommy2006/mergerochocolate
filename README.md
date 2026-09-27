# Mergero Origination Desk

One app, three builds merged: **Amir's Origination Desk** is the front door (the UI, the workflow and the guided demo are his, untouched), **our Node engine** supplies every number behind it (open registers with real owner ages, sourced web research, Claude scoring, humanised outreach with a human-language gate and per-advisor caps, real email, triage that re-scores the prospect), and **Son's Finnish company profiler** adds per-fact evidence for Finnish companies.

## Launch (2 minutes)

```bash
npm install
npm start
```

Open http://localhost:3000 — the guided front door (the pitch). The Origination Desk is at http://localhost:3000/desk. The advanced console (inbox, buyer notes, learning loop, settings) is at http://localhost:3000/engine. Put your keys in `.env` (copy `.env.example`): `ANTHROPIC_API_KEY` (+ `ANTHROPIC_WORKSPACE_ID` for org keys), optional `RESEND_API_KEY`/`RESEND_FROM` for real email and `DEMO_EMAIL` to redirect every send to yourself.

Optional Python parts (Finnish profiler, Amir's engine tests): see `docs/python-setup.md`. The app runs without them.

## What is whose

| Layer | From | Notes |
|---|---|---|
| UI, workflow, guided demo (`public/desk/index.html`) | Amir | served at `/desk` (the front door `public/front` is at `/`); his API contract is implemented by `server/desk/routes.js` |
| Rule engines: trigger decay, scoring parts, buyer-fit checks and charts, hypothesis, CRM rules, templates (`server/desk/engine.js`) | Amir | faithful JS port; used for the desk's numbers and as the no-API-key fallback |
| Data: registries (FI/NO/DK, owner ages), research dossiers, Claude enrichment/scoring/matching, humanised outreach + linter, Resend email, advisor caps, triage + re-score, intake, learning loop (`server/*.js`) | Dang (+ two helper sessions) | replaces Amir's CSV/mock data and simulated sending |
| Finnish per-fact profiles from PRH + XBRL + website (`python/company-scraper`, `server/adapters/son_scraper.js`) | Son | optional source for Finnish companies |

## Demo (Amir's guided demo, real data behind it)

Click **Start demo** on the Desk. The engine drafts four personal messages (Claude + humanizer, linter-checked), "sends" the first one for real through Resend to `DEMO_EMAIL`, triages the owner's reply with Claude and re-scores, then walks through first call and engagement letter. Pre-run *Enrich* on the demo companies beforehand so research is already there.

The guided tour (18 steps, **Watch the demo** on the desk at `/desk`) now visits every page and every essential feature, in the order an advisor would use them:

1. The ranked pipeline · 2. **Data tab: find companies in the open registers** (live Brønnøysund search: "50 of 123 machinery makers founded before 2005", 35,113 Norwegian companies in reach, one click adds them with the CEO's real age) · 3. match statistics across the buyer book · 4. signals · 5. scoring · 6. matching · 7. **screen any website** (`https://www.aerfaber.no`) · 8. **Dig deeper** (10 pages, filed accounts, OCR'd statement, customers) · 9. add it to the pipeline · 10. AI hypothesis · 11. four personal messages · 12. send (Resend demo mode) · 13. the owner's reply, qualified · 14. **the owner's private intake link** (the external touchpoint) · 15. **Sell-side owners: warm-up in one click** · 16. first call with an advisor · 17. engagement letter · 18. the numbers: capacity per advisor, Mergero's 1,000 → 450–500 benchmark, EU-only compute, the advanced console at `/engine`.

Two things the tour relies on were added for it: the **Find companies** card (Data tab, step 1 of the flow; `GET /api/registry/search` + `POST /api/companies/bulk`, Norway/Finland/Denmark) and the **owner intake link** in the qualification step (`POST /api/companies/:id/intake-link`; six questions on a phone, summary lands on the record). The "How it works" box on the pipeline now reads as the five-step flow: find → rank → match → Today list → intake and first call.

**Dig deeper** (`POST /api/analyze`) is what the `Pending Analysis` / `Pending Audit` placeholders link to, on the screen result and in the deal drawer. It reads up to 10 pages of the site (30 s budget), pulls the filed accounts from the open registers (PRH iXBRL, Brønnøysund, CVR), reads the statement PDF when the register has EBIT but no depreciation line (Norway: free copies from Brønnøysund; text layer → any model, scans → Claude's document reader), and names customers and the offering from the sourced facts. EBITDA shows with its year, basis (reported or EBIT + depreciation) and source; when it cannot be derived the screen says why and shows EBIT and revenue instead. Research is reused for a week, so the demo company answers instantly after the first run; **Re-analyze** forces a fresh pass. Sector labels are derived from the enrichment when the register's NACE text is not one of the desk's sectors, and the "Found on the site" line is plain text (fixes the `[object Object]` rendering).

---


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
4. **Approve / Send** a message. With Resend configured it goes out for real and the approved follow-ups are put on the clock; without it, your mail client opens with the message. Either way it is logged and the stage moves to contacted.
5. **Inbox** – the owner's reply arrives by email (Resend webhook) and shows up already triaged: intent, sentiment, extracted facts, the owner's open questions, next step, and a reply draft to approve. No email set up? Paste the reply on the prospect's Conversation tab instead.
6. **Owner intake** – generate a link, open it in a new tab as the owner, answer a few questions → structured summary lands back on the company.
7. **Dashboard → Run pipeline on all NEW prospects** – the scale story; bounded concurrency, live progress.

### Sourcing at scale: registry lookup

The floating **🔎 Registry lookup** button queries official open-data company registers directly — Finland (PRH/YTJ, filter by TOL industry code, city, founded-before), Norway (Brønnøysund, NACE code, min. employees, founded-before), Denmark (CVR name lookup) — and imports the selected companies as `new` prospects. Then *Run pipeline on all NEW prospects* researches, scores, matches and drafts outreach for every one of them. No scraping of commercial databases, no ToS issues: these are public APIs.

### Built on Mergero's answers: the playbook

`server/playbook.js` holds what Mergero told us and feeds the agents: the ideal profile (€2–50M revenue, €3–5M valuation floor, majority owner 55+ or facing succession), the mandate path (first touch → owner replied → warm-up → first call booked → engagement letter — the pipeline stages use these names), readiness signals for owners who have *not yet* considered selling, and messaging principles (never "sell" in a first touch, lead with buyer demand, small ask). Next to **Draft outreach** you choose the **conversation framing** — Open conversation (default), Growth capital, Partial / minority stake, or Full sale — and the sequence is written and humanized for that door. The dashboard's **Analyst hours saved** KPI counts the research and first-touch work the agents replaced.

### Seller emails that read as one person writing to one owner

Every seller email goes through a **writer → linter → humanizer → linter** loop. The linter (`server/humanlint.js`) is deterministic and explainable: stock openers and closers, AI vocabulary, em dashes, exclamation marks, lists and formatting, uniform sentence rhythm, over-hedging, flattery, placeholders, mentions of AI or automation, quoting the owner's own financials, "sell" in a first touch, mixed *du/Sie* in German, plus two things only a system can check: a **personalisation audit** (which sourced facts about this company actually appear in the text) and a **reuse check** (wording shared with emails to other prospects). The humanizer receives the findings and rewrites; the card shows a *Human check* score (0 = fully human), the facts used, and what changed. Drafts that still fail cannot be sent, scheduled or used as replies unless the advisor overrides on the card. Paste two or three of your own past emails under **Settings → Your voice** and both agents imitate that voice.

### Both sides, one click

The dashboard suggests **owners to contact next** and **buyers to contact next** (anonymised opportunities from warm owner conversations). **⚡ Pair** pairs a seller with its best-fitting buyer (or a buyer with its best seller) and spells out why: sector/thesis, size, geography, timing, owner situation, deal structure. Accepting a pairing drafts an anonymised buyer note (no name, city, products or figures) that goes through the same approve → send flow. External components (scraper, matcher, mailer) plug in via `docs/integration.md`; mock adapters under **Settings → Integrations** demo the merge.

### Numbers, not adjectives

The dashboard's **Scale numbers** card is measured, not assumed: every Claude call is metered and attributed to the prospect being processed, so it shows API cost per prospect, minutes per prospect and prospects per hour at the current concurrency, plus how many companies each open register can supply (Norway live: ~35,000 AS with 10–250 staff). **What's working** tracks reply, meeting and mandate rates by framing, source and country and feeds them back into the scoring agent and the framing suggestion; until real history exists it blends a clearly labelled sample. For Norwegian companies the owner's age is read from the **Brønnøysund roles register** (CEO and chair with birth dates) instead of guessed from the founding year — automatically on import and before enrichment. Every prospect carries a **source** (prospect database, registry, referral partner, inbound, event) so channels and partnerships can be compared on the same funnel; the owner-facing **/demand** page shows what buyers are looking for in companies like theirs and brings owners in on their own.

### Winning buy-side mandates

**Buy-side mandates** turns a buyer's investment thesis into a mandate pitch in about a minute: the thesis is parsed into criteria and NACE codes, the open registers (Finland, Norway) are scanned, Norwegian owner ages are read from the roles register, every target is scored against the thesis with a one-line reason, and the pitch is written — "we found N unlisted companies matching your thesis, M score 70+, K owners in these sectors are already in confidential conversations with us" — as an email plus a one-pager with anonymised highlights and the proposed exclusive search mandate. The best targets go into the sell-side pipeline with one click, so both sides feed each other.

### Demo mode for real email

Set **Settings → Demo mode: send everything to** (or `DEMO_EMAIL` in `.env`) and every real email the app sends — owner sequences, follow-ups, reply drafts, buyer notes, pitches — goes to that address instead, one per action, with the intended recipient in the subject. Resend's `onboarding@resend.dev` sender needs no domain and delivers only to the account owner, which is what a demo needs.

## Running on Verda's Mistral (EU-hosted; Mistral Small 3 self-hosted on the instance)

The model provider is switchable. Set in `.env` (or under `/engine` → Settings → Model provider):

```
LLM_PROVIDER=verda
VERDA_BASE_URL=https://containers.datacrunch.io/<deployment>/v1
VERDA_API_KEY=dc_...
VERDA_MODEL=mistral-large-3
LLM_FALLBACK=anthropic        # or none for strict EU-only processing
```

Every agent (enrichment, scoring, matching, outreach, humanizer, triage, intake, buyer notes, pitch) then runs on Mistral through the OpenAI-compatible chat-completions endpoint with JSON-schema structured output and Zod validation (one corrective retry). Claude's web search/fetch tools are Anthropic-only: with `LLM_FALLBACK=none` research stays local (registers, site crawler, Finnish profiler). `GET /api/llm/status` pings the endpoint; the Desk's Data sources tab shows the active model.

### Strict EU-only mode (no call leaves Verda)

`LLM_FALLBACK=none` (or Settings → model provider → fallback off) means no request is ever sent to Anthropic: every structured call (enrichment, scoring, matching, outreach, humanizer, triage, statement reading) goes to the Verda endpoint, and the startup line says `strict: no call leaves Verda`. What changes: Claude's web search is off, so research is the site crawl, the open registers, the Finnish profiler and the statement PDF; scanned statements (all of Brønnøysund's free copies are scans) are read with tesseract on the server (`apt-get install tesseract-ocr tesseract-ocr-nor tesseract-ocr-fin tesseract-ocr-swe tesseract-ocr-dan poppler-utils`), then the Verda model extracts EBIT, depreciation and EBITDA; a statement year whose EBIT does not match the register within 5% is ignored. The instance and the laptop copy both run this way since 27 Sep.

### If no model is reachable

The Desk keeps working on Amir's rule engines: scoring, triggers, hypothesis, template outreach and rule-based reply qualification all run without a model; sending still goes through Resend. Two things to check first: on Verda, that the container deployment named in `VERDA_BASE_URL` is running (a 404 "no such container deployment" means it is stopped or renamed); on Anthropic, the usage limit in the Console (a 400 "reached your specified API usage limits" means the key is capped until the reset date). `GET /api/llm/status` shows both.

### Proving the API calls

`scripts/prove-apis.sh [base-url] [--send]` makes real calls and prints what came back: model provider status, a Claude scoring call with its metered cost, the Norwegian and Finnish registers, registry reach, owner ages from the roles register, Resend status (and one demo email with `--send`), Son's Finnish profiler through the Desk's enrich, the live source list, and the learning loop. Example: `bash scripts/prove-apis.sh http://95.133.253.84:3000`.

## Web research: the company's whole web presence, with sources

**▶ Run full pipeline** (or **0 · Research web** on a company) now starts with a research step that goes well beyond the prospect database:

- **Own website:** crawls it within robots.txt, using the sitemap and menu links. Picks product, customer, location, about/strategy, news and report pages in six languages. Also reads JSON-LD, business IDs from footers and imprints, and language versions. JavaScript-only sites are rendered in the local Chrome/Edge.
- **Filed accounts:** pulled from open registries. Norway (Brønnøysund), Finland (PRH iXBRL) and Denmark (Virk XBRL) are covered, converted to EUR.
- **The wider web:** localised Claude web search for press, events, published figures and annual-report PDFs. One PDF per run is read directly.
- **Only sourced facts:** a fact is kept only if its quote is really on the page it cites, or its URL came back from the search tools.
- **Downstream use:** the profile, scoring, buyer matching, outreach, reply triage and intake all use these facts.

The **Web dossier** tab shows everything with source links. **Watch mode** re-crawls researched sites on demand (dashboard → *Check sites*) or every `WATCH_INTERVAL_HOURS`. It flags a new CEO, new sites, acquisitions and hiring spikes as timing alerts. After a mandate is signed, **Buyer demand → Draft teaser** writes an anonymised one-pager for matched buyers.

> Demo tip: the seed prospects use fictional `*-demo.*` domains, so research on them falls back to web search only. For the full effect, import real companies with **🔎 Registry lookup**. Norway works best, because its registry has the website and the org number that unlocks filed accounts.

## Real email, follow-ups on the clock, and an inbox

Ported from our HMD CRM's email gateway (`email-io/`, comparison in `docs/email-io-repurpose.md`) and moved inside the Express server, so nothing depends on a browser tab being open.

- **Sending.** `Send` delivers through [Resend](https://resend.com) when `RESEND_API_KEY` and `RESEND_FROM` are set (or filled in under Settings → Email delivery). Each email carries its own `Message-ID`; replies are threaded with `In-Reply-To`/`References`. Without Resend, `Send` still opens your mail client with the message and logs it.
- **Receiving.** Point a Resend webhook at `POST /api/mail/inbound/resend` (events `email.received`, `email.delivered`, `email.bounced`, `email.complained`; paste its signing secret into Settings). Every outbound email uses `owners+<prospect id>@<inbound domain>` as its reply-to, so an owner's reply routes itself; the fallbacks are our own Message-ID in `In-Reply-To` and the sender's address. Anything else lands in the inbox's *Unmatched* queue with suggestions; one click assigns it, triages it and remembers the address.
- **Triage on arrival.** The reply is logged at once, quoted history and signatures stripped, and the triage agent runs in the background: intent, sentiment (with the trend since the previous reply), extracted facts, the owner's open questions, recommended stage, next step and a drafted reply. The stage moves to *Owner replied* and scheduled follow-ups are cancelled.
- **Replies move the score.** A reply-understanding agent then reads the owner's own words, in any language, and updates readiness, timing and attractiveness. It shows the exact phrases that moved them ("I turn 63 in spring and none of my children want to take over" → readiness 64 → 84, timing now). Quotes are checked against the email. The Score tab keeps the history of changes.
- **Follow-ups on the clock.** Approving steps 2 and 3 after step 1 went out schedules them on their day (`send_after_days` from the first send). A sweep every `SEND_SWEEP_MINUTES` (default 1) sends due emails, marks LinkedIn steps and unsendable ones *due* for the advisor, and drops anything the owner has answered. Bounces and complaints stop a sequence and flag the owner's address.
- **Inbox** (`#/inbox`). One thread per prospect: *Needs reply* (the owner spoke last or a reply is drafted), *Waiting*, *Done*. A reading pane with the conversation, the triage card and the editable reply draft; it refreshes itself. Message statuses run `draft → approved → scheduled → sent → replied | bounced`, plus `rejected` and `cancelled`.
- **Demo without a domain.** `POST /api/mail/inbound/simulate` (or the MCP tool `mergero_simulate_inbound_email`) feeds an email through the same routing and triage. `POST /api/mail/sweep {"now": "<ISO>"}` pretends it is later and sends the due follow-ups. For a live demo from a phone, run `ngrok http 3000` and paste the ngrok URL into the Resend webhook.

## Advisors send under their own name, within a daily cap

First touches come from the advisor who owns the prospect, not from a shared mailbox. **Settings → Advisors** lists each advisor with their markets and an emails-per-day cap (default 75; Mergero's comfort zone is 50–100 per sender). A prospect is routed to its advisor by country, or picked by hand on the prospect page. The outreach is written, signed and sent as that advisor. Over the cap, an email waits for the next working morning instead of hurting deliverability.

**Dashboard → Outreach capacity** shows each advisor's sends today against their cap and what the team can reach: emails per day, new owners per month and owner conversations per month at Mergero's own benchmark (1,000 contacts → 450–500 conversations). **Queue approved first touches** spreads every approved first email over the advisors' working days, best prospects first.

**Buyers → Sync from MGX** pulls live buyer mandates (sector, size, deal type, geography) from the MGX Deal Engine API when `MGX_API_URL` is set, and a labelled sample otherwise.

## MCP server

`mcp/` exposes the engine to Claude Desktop, Claude Code or any MCP client over stdio: 30 `mergero_*` tools (prospects, registry sourcing, pipeline runs, the approval gate, the inbox, buyers), resources (`mergero://playbook`, `mergero://inbox`, `mergero://prospect/{id}`, …) and prompts (`review_pending_drafts`, `work_the_inbox`, `source_prospects`). Mergero already works Claude → MCP → database; this plugs the engine into that flow. `cd mcp && npm install && npm test`, then `claude mcp add mergero -- node <path>/mcp/index.js`. Details in `mcp/README.md`.

## Agents (all Claude, `claude-opus-5` by default, structured outputs via Zod)

| Agent | Input | Tools | Output |
|---|---|---|---|
| Research | website + registry id | own crawler (robots.txt-aware) + open registries + `web_search`/`web_fetch` + PDF input | sourced facts, filed financials, site map, watch snapshot |
| Enrichment | prospect row + research dossier | (falls back to `web_search` + `web_fetch` when no dossier) | profile incl. offering, customer groups, footprint, direction, financial view (each citing fact ids) |
| Sale-readiness scoring | profile + buyer network | – | readiness, attractiveness, valuation band, €3–5M floor check, why-now |
| Buyer matching | profile + mandates | deterministic prefilter → LLM rerank | ranked buyers with reasons |
| Outreach writer | profile + score + matches + house style + playbook + framing | – | 3-touch sequence, channel by market (Nordics email, DACH LinkedIn), framed as open / growth / minority / full sale |
| Humanizer critic | each draft | – | AI-tell flags, rewrite, before/after score |
| Reply triage | inbound reply (pasted, or received by email) + history | – | intent, sentiment and trend, facts, the owner's open questions, stage, next step, reply draft |
| Owner intake | chat transcript | – | next question / completed structured summary |

## Config

`.env`: `ANTHROPIC_API_KEY`, `ANTHROPIC_WORKSPACE_ID` (only for org-level keys that are not scoped to a workspace), `CLAUDE_MODEL` (default `claude-opus-5`), `PORT` (3000), `BASE_URL` (use an ngrok URL to open intake links from a phone). The key and workspace ID can also be entered under Settings.

Research settings, all optional:
- `RESEARCH_MAX_AGE_DAYS` (default 7): how long a company's research is reused.
- `WATCH_INTERVAL_HOURS` (default 0 = on demand only): how often researched sites are re-crawled.
- `BROWSER_PATH`: the Chrome/Edge used for JavaScript-only sites (auto-detected when unset).

Real email, all optional and also editable under Settings → Email delivery:
- `RESEND_API_KEY` and `RESEND_FROM` (a sender on a domain verified in Resend): with both set, `Send` delivers the email itself.
- `MAIL_INBOUND_DOMAIN`: a domain with receiving enabled in Resend; owner replies go to `owners+<prospect id>@` it and route themselves.
- `RESEND_WEBHOOK_SECRET`: signing secret of the Resend webhook pointed at `<BASE_URL>/api/mail/inbound/resend`.
- `SEND_SWEEP_MINUTES` (default 1): how often scheduled follow-ups are sent; 0 leaves it to `POST /api/mail/sweep`.

Data lives in `data/db.json`. Set `DATABASE_URL` to use Postgres instead: the first start migrates the JSON file in, and each save writes only changed rows. `DATA_DIR` points the JSON store elsewhere. API contract: `API.md`.
