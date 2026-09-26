# Company scraper (Mergero hackathon)

Looks up a Finnish company by name or Business ID and builds one profile from public sources:

| Source | What you get |
|---|---|
| PRH / YTJ trade register (official open API) | Name, Business ID, company form, industry (TOL code), address, founding date, age, status (bankruptcy/liquidation), employer & VAT register, website |
| PRH digital financial statements (XBRL) | Revenue, revenue growth, EBITDA, operating profit, net profit, personnel costs, total assets, equity, equity ratio – latest year + year before |
| Company website | Description, emails, phones, social links, people mentioned with roles (CEO, owner…), founding year, signals: family business, multi-generation, hiring, growth, succession/sale, certifications |

## Start the app
Double-click **Start Company Scraper.command** in Finder. The first start sets everything up (needs Python 3 and internet, about a minute). Then the app opens in your browser at http://127.0.0.1:8765. Keep the Terminal window that opens while you use the app; close it or press Ctrl+C to stop.

From a terminal instead:
```
pip install -r requirements.txt
python app.py                 # --port 9000, --no-browser, --out FOLDER
```

In the app you can:
- **Look up** one company by name or Business ID and see its profile: registry facts, financial key figures, what its website says, and other companies that matched the search.
- **Run a batch**: paste a list or load a .txt / .csv file (first column is used) and follow the progress row by row. Lines that turn out to be a company already done in the batch are skipped.
- **Browse saved companies**: every profile is saved in `output/` and listed in the sidebar.
- **Check the evidence** for every fact (the Evidence switch on a profile), see below.
- **Get an AI analysis** from Claude and ask it questions about a company, see below.
- **Find buyers** for a company and write outreach emails to them (the Find buyers tab), see below.
- **Download** one company, a batch, or everything as Excel, CSV or JSON. The Excel file has an Evidence sheet with one row per fact.

If macOS says the launcher "can't be opened because it is from an unidentified developer" (this happens after the folder was downloaded or unzipped), right-click it, choose Open, then Open again.

## Evidence
Every fact in a profile records where it came from:

| Section | Evidence |
|---|---|
| Company (trade register) | Link to the company's official record in YTJ, the date PRH last changed it, and the start and end dates of each register entry (employer, VAT, trade register…) |
| Financials | For each figure, the fact filed in the XBRL statement: line-item code, element, context ID and value exactly as filed. Search the statement file for the context ID to find it. Calculated figures (EBITDA, margins, growth, equity ratio) show their formula |
| Website | For each email, phone, social link, person, founding year and signal: the page it was found on and the text around it. For a guessed website, the text that verified it (the page mentions the Business ID or name) |

Each section also records when it was fetched. In the JSON these are `registry.register_page`, `financials.evidence`, `financials.calculated`, `website.evidence`, `website.url_evidence` and `retrieved_at`. Profiles saved before evidence was added get it when you refresh them.

If a run skips a section (for example a batch with "Company website" unchecked, or `--no-website`), the section from the previously saved profile is kept, with its own fetch time, not deleted.

## AI analysis (Claude)
With an Anthropic API key, each company page gets an **AI analysis** card:

- A headline, summary, what the business does, a **financial health** rating, **sale and succession signals**, strengths, risks, questions to ask the owner, and missing data.
- **Brief by default:** the headline, summary and ratings sit right above the chat box, and the rest is folded under "Details". **More detail** writes a longer version; **Shorter** switches back.
- **Every statement cites the facts it's based on.** Click a number to see the fact, its evidence and a link to its source. Claude only sees the facts on the page, and is told to ignore any instructions hidden in website text.
- **Ask Claude**: a question box for follow-ups ("Why did revenue fall?"), answered from the same facts, with citations.
- The analysis is saved in the profile and appears in the Excel export (AI headline, ratings, summary). After a refresh, the card shows that the analysis was written from older data; regenerate to update it.
- **Options:** *AI analysis* under Look up → Options runs it automatically after each lookup (on by default). In Batch it's off by default because it adds about a minute per company.

Setup: put the key in a file named `.env` next to `app.py`, then restart the app:
```
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_WORKSPACE_ID=wrkspc_...   # only for keys that aren't scoped to a workspace
CLAUDE_MODEL=claude-opus-5          # optional
```
The key stays on this computer: only the app's server uses it, never the browser page. `.env` holds a secret, so don't share it or send it with the folder.

Good to know:
- The facts sent to Anthropic's API are the public data the scraper collected, including website text and names mentioned there.
- The model is Claude Opus 5. If Claude's safety system declines a request, the API automatically retries it on a fallback model ("server-side fallbacks").
- Cost at Opus 5 prices is roughly 5–15 cents per analysis and a few cents per question.

## Find buyers and outreach emails
The **Find buyers** tab (or **Find buyers** on a company page) takes one company that could be sold through three steps. Everything is saved in `output/campaigns/<Business ID>.json`.

1. **Seller story.** Claude writes the company's background, its potential for a buyer and what buyers will ask about, citing the facts. It also writes an **anonymous teaser** and suggests which kinds of companies could buy it (competitors, customers, suppliers, adjacent businesses, consolidators), with industry codes and nearby towns.
2. **Buyers.** The app searches the PRH trade register for those industries in those towns and keeps active limited companies. It checks the financial statements of the 40 most promising (can they afford it?) and reads the websites of the best 15 (what they do, contact addresses). Claude then gives each a fit score from 0 to 100, a reason based on both companies' backgrounds, and any concerns. The best ones (score 60+, at most 10) are pre-selected. You can add a buyer you know by name or Business ID. A search takes 2–4 minutes.
3. **Emails.** Enter your details, choose English or Finnish, and keep the seller anonymous (recommended: buyers learn the name after signing an NDA). Claude writes one first-contact email per selected buyer, built around why owning the seller makes sense for *that* buyer. Your signature and an opt-out line are added automatically. Each email can be edited, copied, opened in your email app, rewritten or marked as sent, and all of them can be downloaded as a CSV for mail merge.

Good to know:
- **Nothing is sent by the app.** Read every email before sending it from your own address.
- **Warnings:** the app flags an email with no recipient, one that reveals the seller while it should be anonymous, or one missing your details.
- **Few addresses:** many small companies have no findable website, so contact addresses are often missing. Add them by hand.
- **Unknown size:** many small companies file only PDF statements, so their size shows as unknown.
- **Cost:** roughly 10–15 cents for the seller story, 15–25 cents for a buyer search, and a few cents per email.

## Command line
```
python company_scraper.py 0180611-0
python company_scraper.py "Lapuan Kuljetus"
python company_scraper.py "Firma Oy" --website https://firma.fi
python company_scraper.py --batch example_batch.txt
python company_scraper.py 0180611-0 --json        # JSON to stdout, for piping into the next step
```
Each company is saved as `output/<BusinessID>.json`; batch runs also write `output/all_companies.json` (a company listed twice, e.g. by name and by Business ID, is included once).

Flags: `--no-website`, `--no-financials`, `--out FOLDER`.

In Python:
```python
from company_scraper import build_profile
profile = build_profile("0180611-0")
```

## Test (offline)
```
python tests/test_offline.py
python tests/test_app.py        # the web app's API, jobs and exports
python tests/test_ai.py         # AI features, with Claude's replies simulated (no API calls)
python tests/test_buyers.py     # finding buyers and outreach emails, with the register search and Claude simulated
```
Uses real PRH responses for Lapuan Kuljetus Oy saved in `tests/fixtures/`. The website pages in the fixtures are invented test content.

## Limits to know
- **Financials only exist for companies that file digital (XBRL) statements.** Many small companies still file PDF only; they show "No digital financial statements filed".
- Financial line items are read by taxonomy code (Finnish SBR/FAS). The codes were identified from real filings and checked so that the income statement adds up. IFRS filers (e.g. listed groups) show up as "not mapped".
- If the registry has no website, the scraper tries `<name>.fi` / `.com` and keeps it only if the page mentions the company name or Business ID.
- **Owner names, ages and shareholdings are not in the free open data.** People come only from what the company publishes on its own site. Paid sources (e.g. Asiakastieto, Vainu) have board members and owners.
- robots.txt is respected; the scraper reads at most 5 pages per site.
