# Mergero Origination Engine — API contract (v1)

Sell-side deal origination copilot. Node/Express backend on `http://localhost:3000`, static frontend in `public/`.
All endpoints return JSON. Errors: `{ error: string }` with 4xx/5xx.

## Core objects

### Company (prospect)
```json
{
  "id": "c_ab12cd",
  "name": "Nordic Pump Oy",
  "country": "FI",                 // FI SE NO DK DE AT CH
  "city": "Tampere",
  "website": "https://nordicpump.fi",
  "industry": "Industrial equipment",
  "revenue_eur": 8400000,
  "ebitda_eur": 1100000,
  "employees": 46,
  "founded": 1998,
  "ownership_type": "founder-owned",   // founder-owned | family-owned | pe-backed | management-owned | unknown
  "owner": { "name": "Jari Lehtinen", "title": "CEO & Owner", "age": 61, "tenure_years": 26,
             "email": "jari@nordicpump.fi", "linkedin": "https://linkedin.com/in/..." },
  "source": "Prospect database import",
  "stage": "new",   // new | enriched | outreach_ready | contacted | replied | warming | meeting_booked | mandate_signed | disqualified
  "channel": "email",               // derived: FI/SE/NO/DK -> email ; DE/AT/CH -> linkedin
  "enrichment": null | {
    "summary": "…what the company does in 2-3 sentences…",
    "products": ["…"],
    "customers": ["…named or described customers…"],
    "positioning": "…",
    "recent_news": ["…"],
    "leadership": "…",
    "signals": ["Owner 61, founder since 1998", "No successor named", "Flat revenue 2023-2025"],
    "data_gaps": ["Revenue split by product unknown", "Top-10 client concentration unknown"],
    "sources": ["https://…"],
    "confidence": "high|medium|low",
    "enriched_at": "ISO"
  },
  "score": null | {
    "readiness": 78,                     // 0-100 likelihood owner is open to a transaction in 6-18 months
    "attractiveness": 71,                // 0-100 how attractive to buyers in network
    "valuation_band_eur": { "low": 6000000, "high": 9000000 },
    "meets_minimum": true,               // valuation >= 3-5M EUR floor
    "why_now": "…one paragraph…",
    "signals": [ { "signal": "Owner age 61", "direction": "positive", "weight": "high", "note": "…" } ],
    "risks": ["…"],
    "recommended_timing": "now | 3-6 months | 6-12 months | not yet",
    "scored_at": "ISO"
  },
  "matches": [ { "buyer_id": "b_01", "buyer_name": "Nordic industrial PE fund", "fit": 86, "reason": "…" } ],
  "messages": [ /* Message */ ],
  "conversation": [ /* ConversationEntry */ ],
  "intake": null | { "token": "…", "status": "pending|in_progress|complete", "summary": {…}, "transcript": [ {role, text, at} ] },
  "notes": "",
  "created_at": "ISO", "updated_at": "ISO"
}
```

### Message (outreach draft)
```json
{
  "id": "m_xyz", "company_id": "c_ab12cd",
  "channel": "email" | "linkedin" | "call_script",
  "step": 1,                    // 1,2,3 for sequence; 0 = reply draft
  "send_after_days": 0,         // 0, 6, 14 typical
  "language": "en",             // en | fi | sv | de …
  "subject": "…",               // email only
  "body": "…",
  "status": "draft" | "approved" | "sent" | "rejected",
  "humanizer": { "ai_tell_score_before": 62, "ai_tell_score_after": 9, "flags": ["…phrase…: reason"], "changes": ["…"] },
  "created_at": "ISO", "sent_at": null
}
```

### ConversationEntry
```json
{ "id": "e_1", "direction": "inbound" | "outbound", "channel": "email", "text": "…", "at": "ISO",
  "triage": null | {
    "intent": "interested" | "curious" | "not_now" | "info_request" | "not_interested" | "referral" | "other",
    "sentiment": "warm" | "neutral" | "cold",
    "extracted_facts": [ { "field": "revenue_split", "value": "…", "confidence": "high" } ],
    "recommended_stage": "warming",
    "next_step": "…",
    "reply_message_id": "m_reply1"     // draft reply created in messages
  } }
```

### Buyer mandate
```json
{ "id": "b_01", "name": "Nordic industrial PE fund", "buyer_type": "PE" | "family_office" | "strategic",
  "sectors": ["Industrial equipment", "Manufacturing"], "geographies": ["FI","SE","NO","DK"],
  "revenue_min_eur": 5000000, "revenue_max_eur": 50000000, "ebitda_min_eur": 800000, "ebitda_max_eur": 8000000,
  "deal_types": ["majority", "buyout"], "thesis": "…", "active": true }
```

### Settings
```json
{ "api_key_set": true, "api_key_masked": "sk-ant-…7f2a", "model": "claude-opus-5",
  "sender": { "name": "Timo Tontti", "title": "Managing Partner", "firm": "Mergero", "email": "timo.tontti@mergero.com", "phone": "+358 400 274491" },
  "style_rules": "Short. Plain words. One concrete reason we are writing. No em dashes, no 'I hope this finds you well', no bullet lists, no 'delve', no exclamation marks. Sound like a person who has done 50 deals, not a marketing team.",
  "value_props": ["2,000+ verified buyers", "€500M+ closed", "off-market process, no auction"],
  "funnel_assumptions": { "contact_to_reply": 0.18, "reply_to_meeting": 0.45, "meeting_to_mandate": 0.30 } }
```

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/state` | | `{ settings, stats, companies:[Company summary], buyers:[Buyer] }` |
| GET | `/api/stats` | | `{ by_stage:{stage:count}, total, avg_readiness, projected_mandates, messages_pending_approval, replies_unhandled }` |
| GET | `/api/companies` | | `[Company]` |
| GET | `/api/companies/:id` | | `Company` |
| POST | `/api/companies` | partial Company (name, country, website, …) | `Company` |
| PUT | `/api/companies/:id` | partial fields (notes, owner, stage…) | `Company` |
| DELETE | `/api/companies/:id` | | `{ ok:true }` |
| POST | `/api/companies/import` | `{ csv: "text" }` — columns: name,country,city,website,industry,revenue_eur,ebitda_eur,employees,founded,ownership_type,owner_name,owner_title,owner_age,owner_email,owner_linkedin | `{ imported: n, companies:[Company] }` |
| POST | `/api/companies/:id/enrich` | | `Company` (enrichment filled, stage>=enriched) |
| POST | `/api/companies/:id/score` | | `Company` |
| POST | `/api/companies/:id/match` | | `Company` |
| POST | `/api/companies/:id/outreach` | `{ language?: "en", channel?: "email" }` | `Company` (3 messages appended, stage outreach_ready) |
| POST | `/api/companies/:id/run` | `{ language? }` | `Company` — enrich → score → match → outreach in one go |
| POST | `/api/pipeline/run` | `{ ids?: [id], stage?: "new", language? }` | `{ job_id }` |
| GET | `/api/jobs/:id` | | `{ id, total, done, current_company, errors:[{id,name,error}], finished:bool, started_at }` |
| POST | `/api/companies/:id/stage` | `{ stage }` | `Company` |
| PUT | `/api/messages/:id` | `{ subject?, body? }` | `Message` |
| POST | `/api/messages/:id/approve` | | `Message` |
| POST | `/api/messages/:id/reject` | | `Message` |
| POST | `/api/messages/:id/send` | | `{ message, mailto }` — marks sent, appends outbound ConversationEntry, stage→contacted, `mailto:` link for email channel |
| POST | `/api/messages/:id/humanize` | | `Message` — re-run humanizer pass |
| POST | `/api/companies/:id/replies` | `{ text, channel? }` | `Company` — stores inbound, runs triage, creates reply draft, updates stage |
| GET | `/api/buyers` | | `[Buyer]` |
| POST | `/api/buyers` | Buyer without id | `Buyer` |
| PUT | `/api/buyers/:id` | partial | `Buyer` |
| DELETE | `/api/buyers/:id` | | `{ ok:true }` |
| GET | `/api/settings` | | `Settings` |
| PUT | `/api/settings` | `{ api_key?, model?, sender?, style_rules?, value_props?, funnel_assumptions? }` | `Settings` |
| POST | `/api/companies/:id/intake-link` | | `{ url: "http://localhost:3000/intake/<token>", token }` |
| GET | `/api/intake/:token` | | `{ company_name, firm, advisor_name, status, transcript:[{role:'assistant'|'owner', text}] }` — first call with empty transcript returns an opening assistant message |
| POST | `/api/intake/:token/message` | `{ text }` | `{ reply: string, status: "in_progress"|"complete", summary?: {…} }` |
| POST | `/api/reset-demo` | | `{ ok:true }` — reload seed data |

## Frontend routes (SPA, hash based)
- `#/dashboard` — KPIs, funnel by stage, "Run pipeline on all new" with progress, pending approvals, unhandled replies
- `#/prospects` — table (name, country flag, industry, revenue, readiness score pill, stage pill, channel icon), search/filter by stage/country, Import CSV modal, Add prospect modal
- `#/company/:id` — header (name, country, owner, stage selector, Run all / Enrich / Score / Match / Draft outreach buttons), tabs: **Profile & signals**, **Score & why now**, **Buyer demand**, **Outreach** (sequence cards with humanizer badge, edit/approve/reject/send/copy), **Conversation** (paste reply → triage card + reply draft), **Owner intake** (generate link, view summary)
- `#/buyers` — buyer mandate cards + add/edit
- `#/settings` — API key, sender identity, style rules, value props, funnel assumptions
- `/intake/:token` — separate public page `public/intake.html`: chat UI for the business owner

## Web research, watch mode and buyer teaser (added)

Pipeline is now **research → enrich → score → match → outreach**. `POST /api/companies/:id/run` and the bulk pipeline run research first (reused for `RESEARCH_MAX_AGE_DAYS`, default 7); pass `{ research: false }` to skip it.

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/companies/:id/research` | | `Company` with fresh `research` (crawl + registries + web + PDF). Fills blank `revenue_eur` / `ebitda_eur` / `employees` / `registry_id` from filed accounts; never overwrites database figures (differences go to `research.financials.conflicts`) |
| POST | `/api/companies/:id/watch` | | `Company` with `watch` updated: re-crawl, diff against `research.snapshot`, new facts appended to `research.facts` (with `detected_at`) |
| POST | `/api/watch/run` | `{ ids? }` | `{ job_id, total }`; job shape as `/api/jobs/:id` plus `kind: "watch"` (pipeline jobs have `kind: "pipeline"`) |
| GET | `/api/watch/alerts` | `?limit=50` | `{ watched, alerts:[{ id, at, kind, category, signal, title, url, company_id, company_name, country }] }`, newest first |
| POST | `/api/companies/:id/teaser` | | `Company` with `teaser`; **409 unless stage is `mandate_signed`** |

### Company additions
```json
"research": {
  "status": "done", "ran_at": "ISO", "duration_ms": 52000,
  "site": { "ok": true, "root": "https://…", "languages": ["fi","en"], "pages_found": 212, "pages_read": 24, "by_category": {"offering": 31},
            "js_only": false, "rendered_with": "none|browser", "robots_blocked": false, "jsonld_org": {…}, "social": {"linkedin": "…"},
            "business_ids": [{ "type": "FI_YTUNNUS", "value": "1234567-8", "raw": "…" }] },
  "pages": [{ "url", "category", "title", "lang", "words", "hash", "rendered" }],          // page text is not stored
  "facts": [{ "id": "f12", "category": "offering|customers|footprint|direction|financials|ownership|people|events|other",
              "claim": "…", "quote": "verbatim excerpt", "as_of": "2025", "confidence": "high|medium|low",
              "url": "https://…", "source_title": "…", "origin": "site|web", "verified": "quote|source", "detected_at": "ISO (watch only)" }],
  "financials": { "identifier": { "country": "NO", "id": "923609016", "source": "registry_id|website|name_search" },
                  "rows": [{ "year": 2025, "currency": "NOK", "revenue", "ebit", "ebitda", "net_income", "employees",
                             "revenue_eur", "ebit_eur", "ebitda_eur", "net_income_eur", "fx_to_eur", "ebitda_basis": "reported|derived|null",
                             "source": "Brønnøysund Regnskapsregisteret (NO)", "url", "confidence": "high|medium" }],
                  "documents": [{ "type": "annual_report", "year", "format": "pdf|xbrl", "url", "source" }],
                  "notes": ["…"], "checked": ["…"], "conflicts": ["Revenue: database €8.4M vs €11.2M in 2025 (…), 33% apart"] },
  "stats": { "facts", "site_facts", "web_facts", "dropped_unverified", "web_sources" },
  "filled_fields": ["revenue 2025 (…)"], "warnings": ["…"],
  "snapshot": { "at": "ISO", "urls": ["…"], "hashes": { "url": "sha1" } }
},
"watch": { "last_run_at": "ISO", "last_error": null, "last_summary": { "new_urls", "changed_pages", "new_facts" },
           "alerts": [{ "id", "at", "kind": "new_fact|new_page|changed_page|hiring_spike", "category", "signal": "leadership_change|acquisition|ownership|expansion|financial_report|hiring|null", "title", "url" }] },
"teaser": { "project_name", "headline", "blind_profile", "key_figures": [], "investment_highlights": [], "transaction", "redactions": [], "drafted_at", "status": "draft" }
```
`enrichment` additionally has `offering {summary, product_lines[{name, description, evidence}], business_model, evidence}`, `customer_segments[{segment, named_customers, evidence}]`, `footprint {headquarters, sites, sales_markets, evidence}`, `direction {vision, stated_goals, recent_moves[{date, event, evidence}], evidence}`, `financial_view` and `research_based`. `evidence` arrays hold fact ids (`f12`) from `research.facts`; unknown ids are stripped server-side.

### How research works
1. **Own website** (`server/research/crawl.js`): robots.txt (obeyed, honest `MergeroResearchBot` user agent, ~2 req/s), sitemaps + homepage/footer links, multilingual page picker (EN/FI/SV/NO/DA/DE) with per-topic quotas (~24 pages), JSON-LD organisation data, business IDs from footer/imprint, hreflang languages, PDF report links. JavaScript-only sites are rendered with the local Chrome/Edge (`server/research/render.js`, `puppeteer-core`, `BROWSER_PATH` override).
2. **Filed accounts** (`server/financials.js`): NO Brønnøysund Regnskapsregisteret, FI PRH digital (iXBRL) financial statements, DK Virk annual-report XBRL; converted to EUR at ECB reference rates. SE/DE/AT/CH: no open API wired; published figures come from step 3.
3. **Wider web**: Claude `web_search` localised to the company's country (+ `web_fetch`, LinkedIn blocked): press, events, published figures, report PDFs.
4. **Facts**: Claude extracts facts per page; a site fact is kept only if its quote is found on the cited page, a web fact only if its URL came back from the search tools. One annual-report PDF per run is read directly by Claude when it adds a year the registries don't have.

## Registry lookup (added)
| Method | Path | Params / Body | Returns |
|---|---|---|---|
| GET | `/api/registry/search` | `country=FI|NO|DK`, `q`, `industry_code`, `city` (FI), `founded_before` (year), `employees_min` (NO), `page` | `{ total, results:[{ name,country,city,website,industry,industry_code,employees,founded,registry_id,source,already_imported }] }` |
| POST | `/api/companies/bulk` | `{ companies:[…rows from search…] }` | `{ imported, companies }` — skips registry_ids already in the pipeline |

## Playbook additions
- `POST /api/companies/:id/outreach` and `POST /api/companies/:id/run` accept `framing`: `open` (default) | `growth` | `minority` | `exit`. Each generated Message carries `framing`.
- `GET /api/stats` also returns `hours_saved` (analyst hours the agents replaced, from `server/playbook.js` TIME_SAVED_MINUTES).
- `Settings` has `workspace_id` (sent as the `anthropic-workspace-id` header for org-level API keys).
- `GET /api/playbook` returns the playbook itself: `{ icp, mandate_path, meetings_before_mandate, messaging_principles, readiness_signals, value_prop, time_saved_minutes, stages }`.

## Real email, inbox and scheduler (added)

Message `status` now runs `draft → approved → scheduled → sent → replied | bounced`, with `rejected` and `cancelled` as end states. New Message fields: `send_at` (ISO, while scheduled), `due` (true when the scheduler could not send it itself: LinkedIn or call script, no owner email, Resend not configured, or three failed attempts), `cancel_reason`, and `delivery { provider: "resend"|"mailto"|"manual", id, status: "sent"|"delivered"|"delayed"|"opened"|"clicked"|"bounced"|"complained"|"failed"|"handed_off"|"error", message_id, via: "manual"|"scheduler", error, attempts, events:[{ type, at }] }`.

ConversationEntry gains `source` (`paste`|`resend`|`mailto`|`manual`), `from`, `subject`, `provider_id` (Resend email id), `rfc_message_id`, `in_reply_to`, `references`, `routed_by` (`plus_address`|`in_reply_to`|`sender`|`manual`), `text_full` (before quoted history was stripped), `triage_error` and `cancelled_followups`. `triage` gains `open_questions[]` and `sentiment_trend` (`up`|`down`|`flat` against the previous reply). `owner` gains `email_status` (`bounced`|`complained`) and `alt_emails[]`.

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/messages/:id/approve` | | `Message` — `approved`; a follow-up whose first touch already went out becomes `scheduled` with `send_at` (never when the owner has replied since). Also accepts `rejected` and `cancelled` messages |
| POST | `/api/messages/:id/reject` | | `Message` — `rejected` (from draft, approved or scheduled) |
| POST | `/api/messages/:id/unschedule` | | `Message` — scheduled → approved (manual send only) |
| POST | `/api/messages/:id/send` | | `{ message, mailto, delivered }` — requires approved or scheduled. Email goes through Resend when configured (`delivered: true`), else `mailto` is returned; LinkedIn and call scripts are logged. Sending a first touch schedules the approved follow-ups |
| POST | `/api/companies/:id/replies` | `{ text, channel? }` | `Company` — logs the reply, cancels scheduled follow-ups, moves the stage to replied, triages (reply draft, recommended stage) |
| POST | `/api/companies/:id/replies/:entryId/triage` | | `Company` — re-runs triage for one inbound entry; reuses its unsent reply draft |
| POST | `/api/mail/inbound/resend` | Resend webhook envelope `{ type, data }` | `email.received` → `{ received, matched, company_id, entry_id, routed_by }` or `{ received, matched:false, unmatched_id, suggestions }`; delivery events → `{ ok, message_id, delivery }`. Verified with the Svix headers when a signing secret is set (401 otherwise); duplicate `email_id`s are ignored; triage runs after the response |
| POST | `/api/mail/inbound/simulate` | `{ from, subject?, text, company_id?, to?, wait? }` | same as a received email, without Resend; `wait` (default true) returns after triage |
| GET | `/api/mail/unmatched` | | `[{ id, at, from, to, subject, text, suggestions:[{ company_id, name, country, score }] }]` |
| POST | `/api/mail/unmatched/:id/assign` | `{ company_id }` | `Company` — runs the reply flow; the sender's address is remembered on the owner (`email` if empty, else `alt_emails`) |
| DELETE | `/api/mail/unmatched/:id` | | `{ ok }` |
| GET | `/api/inbox` | | `{ items:[{ company_id, name, country, stage, channel, owner, status: "needs_reply"\|"waiting"\|"done", last_at, last_direction, last_channel, last_text, last_subject, triage, triage_pending, triage_error, reply_draft:{id,status}, scheduled, due, readiness }], counts, unmatched, mail }` — owners waiting for an answer first |
| GET | `/api/mail/status` | | `{ configured, from, inbound_domain, inbound_example, webhook_url, webhook_signing, sweep_minutes, scheduled, due, unmatched }` |
| POST | `/api/mail/sweep` | `{ now? }` | `{ sent, due, cancelled, errors }` — runs the follow-up scheduler now; `now` (ISO) pretends it is later |

`GET /api/stats` adds `messages_scheduled`, `messages_due` and `inbox_unmatched`; `replies_unhandled` now counts inbox threads in `needs_reply`. `Settings` gains `mail { configured, api_key_set, api_key_masked, from, inbound_domain, webhook_secret_set }`; `PUT /api/settings` accepts `mail { resend_api_key?, from?, inbound_domain?, webhook_secret?, clear_resend_api_key?, clear_webhook_secret? }` (a blank secret keeps the current one; environment values fill blanks).

Inbox status per prospect: `needs_reply` when the owner spoke last (intake summaries excepted) or a reply draft is unsent; `waiting` when we spoke last or a follow-up is scheduled; `done` when disqualified or the mandate is signed. Routing of an inbound email: the plus-address it was sent to (`owners+<company id>@<inbound domain>`) → our `Message-ID` (`<message id>.<company id>@…`) in `In-Reply-To`/`References` → the sender against `owner.email` and `owner.alt_emails` → the unmatched queue.

## Human-language engine (seller emails)
- Every seller draft (sequence steps and reply drafts) carries `lint: { before, after, passes }` from `server/humanlint.js`: `score` (0 = fully human), `grade` (human | acceptable | robotic), `flags[{rule, severity, excerpt, fix}]`, `personalization { points, count, generic }`, `similarity { max, with, shared }`, `metrics`, `blocks_send`.
- Flow: writer → linter → humanizer (receives the findings) → linter again; a second editing pass only if the draft still fails.
- `PUT /api/messages/:id` re-lints edited text and accepts `lint_override: true|false`. `POST /api/messages/:id/lint` re-runs the linter. `POST /api/messages/:id/humanize` runs the full loop.
- Send gate: `deliver()` refuses (409) any draft whose latest lint has `blocks_send` unless `lint_override` is set — covers manual sends, scheduled follow-ups and reply drafts.
- Settings: `voice_samples` (the advisor's own past emails; writer and humanizer imitate the voice) and `lint_threshold` (default 35).
- Pairings: `GET /api/pairings`, `POST /api/pairings {company_id?|buyer_id?}` (best counterpart chosen automatically, rationale with six checks), `POST /api/pairings/:id/accept` (drafts the anonymised buyer note when the owner conversation is warm), `POST /api/pairings/:id/dismiss`. Suggestions: `GET /api/suggestions` (owners to contact next, buyers to contact next).

## Scale numbers, learning loop, register roles, sources
- `GET /api/stats` → `scale { api_spend_usd, cost_per_prospect_usd, minutes_per_prospect, prospects_per_hour_at_3, prospects_measured }` — measured from real token usage (every Claude call is attributed to the company being processed) and wall time of full pipeline runs.
- `GET /api/registry/reach` → how many companies each open register can supply for the €2–50M band (Norway live: AS with 10–250 staff; FI/DK/SE/DACH explained).
- `POST /api/companies/:id/people` (Norway) → CEO, chair and board with birth dates from Brønnøysund's roles register; fills `owner.age` (+ `owner.age_source`) and `company.people[]`. Runs automatically on Norwegian registry imports and before enrichment.
- `GET /api/learning` → reply / meeting / mandate rates by framing, country, sector, language and source, plus `best_framing_by_country`; blends a labelled sample history (`data/mock/outcomes_history.json`) while fewer than 8 real first touches exist. The scoring agent receives `summaryFor(company)`; the company page shows the best framing for its country.
- Prospects carry `source` (dropdown incl. referral partners, inbound, events) and `referrer`; the prospects list filters by source kind.

## Owner-facing demand page (public, anonymised)
- `GET /demand` — public page: country, sector and revenue band → "N buyers in the Mergero network are looking for companies like yours", buyer types, deal types (soft-entry line when minority/growth exist), three anonymised thesis quotes, owners already in conversation, and a "request a confidential conversation" form.
- `GET /api/public/options` → countries and sectors for the form.
- `GET /api/public/demand?country=&sector=&revenue_eur=` or `?token=<intake token>` → the anonymised snapshot (never buyer names, ids, emails or company names). Also rendered on the intake page once the owner finishes the questionnaire.
- `POST /api/public/leads { name, company, email, country, sector, revenue_eur, message }` → creates a prospect with source `Inbound: demand page` (20 leads/hour limit).

## Buy-side mandate generation
- `POST /api/buyside/mandates { thesis_text, buyer_name?, buyer_type?, countries? }` → parses the thesis into criteria (sectors, NACE codes, geographies, size, deal types, owner situation), scans the open registers (FI PRH, NO Brønnøysund) by NACE code and headcount proxy, looks up Norwegian owner ages, scores every target against the thesis, and returns the mandate with `targets[]` (fit, reason, owner signal, pipeline status) and `stats` (targets, score 70+, owners in conversation, countries, scan log). About one minute.
- `POST /api/buyside/mandates/:id/pitch` → writes the pitch (email + one-pager) and parks it as a buyer-side draft on a buyer record created from the criteria; send it with `POST /api/buyer-messages/:id/send`.
- `POST /api/buyside/mandates/:id/import { top }` → adds the best targets to the sell-side pipeline (source `Buy-side mandate: <buyer>`), with register owner ages where known.
- `GET /api/buyside/mandates`, `GET /api/buyside/mandates/:id`, `DELETE /api/buyside/mandates/:id`.

## Demo mode for real email
- `settings.demo_email` (or `DEMO_EMAIL` in `.env`): when set, `mail.send()` redirects **every** outbound email (owner sequences, scheduled follow-ups, reply drafts, buyer notes, pitches) to that address, prefixes the subject with `[DEMO → intended recipient]` and notes it in the body. One email per action; nothing reaches owners or buyers. Resend's `onboarding@resend.dev` sender works without a verified domain but only delivers to the account owner's address, which is exactly the demo case.

## Advisors, daily send caps and the first-touch queue
Mergero (Timo, 2026-09-26): first touches come from the individual advisor, about 50–100 emails per day per sender.
- `settings.advisors[]`: `{ id, name, title, email, phone, markets: ["FI", …], daily_cap }` (cap 1–200, default 75). Editable under Settings → Advisors or `PUT /api/settings { advisors }`. Editing `sender` without `advisors` updates the first advisor.
- `company.advisor_id` (optional, `PUT /api/companies/:id`): owner of the prospect. Unset → the first advisor whose `markets` include the country, else the first advisor.
- Outreach, humanizer, triage reply drafts and the owner intake are written and signed as that advisor. Real email goes out as `"<advisor name> <address>"`: the verified sending address, or the advisor's own address when it is on the same domain. `message.sent_by` records the advisor.
- Cap: `deliver()` refuses an email once the advisor has sent `daily_cap` emails today. `POST /api/messages/:id/send` then returns `{ deferred: true, note, message }` with the message scheduled for the next working morning (08:00, weekends skipped, `deferred_reason: "daily cap"`). The sweep defers the same way.
- `POST /api/outreach/queue { limit? }`: schedules every approved step-1 email, highest readiness first, evenly spaced over each advisor's 08:00–17:00 working day up to the cap, overflow to later working days. Returns `{ queued, skipped, advisors: [{ advisor, daily_cap, queued, days, first_at, last_at }] }`. Follow-ups are scheduled after each first touch goes out, as before.
- `GET /api/advisors/capacity`: per advisor `{ markets, daily_cap, sent_today, prospects, first_touches_queued }`, plus `emails_per_day`, `new_owners_per_month` (21 working days, a third of sends are first touches) and `conversations_per_month` at `funnel_assumptions.contact_to_reply`.
- Funnel default `contact_to_reply` is now 0.475 (Mergero: 1,000 contacts → 450–500 owner conversations); saved settings still on the old 0.18 are migrated. The projected-mandates formula caps each prospect's reply odds at 95% (readiness 50 = benchmark rate).

## MGX Deal Engine buyer sync
Mergero queries MGX over API/MCP rather than exporting it; the fields that matter are sector, financials/size, deal type and geography.
- `POST /api/mgx/sync`: `GET ${MGX_API_URL}${MGX_BUYERS_PATH || "/buyers"}` with `Authorization: Bearer ${MGX_API_KEY}` (optional); accepts an array or `{ mandates | buyers | items }`. Each record is normalised (`mandate_id|id`, `buyer_label|name`, `buyer_type`, `sector(s)`, `geography(ies)`, `size.{revenue,ebitda}_{min,max}_eur` or flat, `deal_type(s)`, `thesis`) and upserted by `mgx_id`; mandates MGX no longer lists become inactive. Without `MGX_API_URL` the labelled sample `data/mock/mgx_buyers.json` is used (`source: "mgx-sample"`).
- `GET /api/mgx/status`: `{ connected, mode: "api" | "sample", url, last_sync, mandates }`.
- MCP tools: `mergero_mgx_sync`, `mergero_advisor_capacity`, `mergero_queue_first_touches`.

## Advisor cap on buyer-side sends
`POST /api/buyer-messages/:id/send` sends as the advisor who owns the seller conversation (first advisor for a pitch), counts against that advisor's daily cap (429 with `capped` and `next_at` when reached), stamps `sent_by`, and its emails are included in `sentToday()` alongside owner emails. The Buy-side page remains at `#/buyside` (nav link hidden: sell-side only in the demo).

## Reply understanding → score update
After triage, every owner reply (pasted, received through the Resend webhook, or via `/api/integrations/inbound`) goes to `agents.rescoreFromReply` (schema `ReplyScoreSchema`). It reads the owner's own words in any language and returns the updated `readiness`, `attractiveness` and `recommended_timing`, a `reason`, `evidence[] { quote, reading, effect: raises|lowers|neutral, weight }`, new `signals[]`, `risks[]` and a `confidence`. Evidence quotes are checked against the reply text; unverifiable quotes are dropped (`dropped_quotes`).
- `company.score` is updated in place. Reply-derived signals carry `source: "reply", entry_id`. `score.rescored_at` is set, and `score.history[] { at, source: "reply", entry_id, from, to, reason, evidence, confidence }` keeps each change.
- The inbound `ConversationEntry` gets `score_update { from, to, delta, reason, evidence, confidence }`, or `score_update_error`. `POST /api/companies/:id/replies/:entryId/triage` re-runs triage and the re-score; the new update replaces that reply's earlier one and is measured from the same starting score.
- Best-effort: if the re-score fails, the triage, stage move and reply draft still stand.

## Origination Desk (Amir's UI, served at `/desk`; the guided front door `public/front` is at `/`)
`server/desk/routes.js` implements Amir's API contract over this engine so `public/desk/index.html` runs unchanged: `GET /api/buyers`, `POST /api/scrape`, `POST /api/match`, `/api/deals*`, `/api/targets`, `POST /api/generate-outreach/:id`, `GET /api/sources`, `GET /api/companies[/:id]`, `POST /api/companies/:id/enrich`, `POST /api/ingest`, `GET /api/ingest/runs`, `GET /api/prospects[/:id]`, `POST /api/prospects/:id/outreach`, `PATCH …/outreach/:step`, `POST …/outreach/:step/send`, `GET …/sample-replies`, `POST …/replies`, `POST …/handoff`, `POST …/mandate`, `GET /api/pipeline-summary`, `GET /api/funnel`, `GET /api/metrics`, `GET /api/dialogues`, `POST /api/demo/reset`. Companies and buyers carry a numeric `desk_id` for it. `POST /api/analyze` `{profile | company_id | deal_id, force?}` runs the deep analysis on a screened company (quick research: 10-page crawl, registry filed accounts, statement PDF for EBITDA, enrichment for customers/offering; reused for 7 days unless `force`) and returns `{profile, matches, stats, analysis, summary, deals}`; every desk profile now carries `ebitda_detail` (source or the reason EBITDA is missing), `analysis` (null until run) and `evidence` as short strings. Outreach planning calls our writer + humanizer + linter (four touches, days 0/4/10/21) and falls back to Amir's templates without an API key; sends go through `deliver()` (lint gate, advisor cap, Resend/demo mode); replies go through `handleInboundReply` (triage + re-score) and are mapped to Amir's categories.

Because four of these paths clash with the engine's own shapes, the engine console at `/engine` calls everything under `/api/engine/…`, which is rewritten to `/api/…` with `req.legacy = true` so the desk handlers fall through.
