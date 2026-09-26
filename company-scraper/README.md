# Company Scraper: from a Finnish company to buyer outreach

A local web app for the Mergero challenge. It takes a Finnish company from public facts to a shortlist of buyers and personal first emails, in four steps:

1. **Research:** official register data, filed financial statements and the company's own website, with evidence for every fact.
2. **Analysis:** Claude summarises the company, rates its financial health and how likely it is to be for sale, and answers questions. Every statement cites its facts.
3. **Buyers:** Claude writes the seller story and an anonymous teaser. The app then searches the trade register for competitors, customers, suppliers and neighbours that could buy the company, checks their accounts and websites, and Claude ranks them by fit.
4. **Outreach:** Claude drafts a personal first email to each chosen buyer. You track sent emails and answers, and get a follow-up after a week of silence.

## Start

Double-click **Start Company Scraper.command** in Finder. The first start installs everything (needs Python 3.10+ and internet, about a minute), then the app opens at http://127.0.0.1:8765. Keep the Terminal window open while you use it.

From a terminal:
```
pip install -r requirements.txt
python app.py                 # --port 9000, --no-browser, --out FOLDER
```

For the Claude features, create a `.env` file next to `app.py` (see `.env.example`) and restart:
```
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_WORKSPACE_ID=wrkspc_...   # only for keys that aren't tied to one workspace
```
The key never leaves the app's server, and `.env` is git-ignored.

If macOS says the launcher "can't be opened because it is from an unidentified developer", right-click it, choose Open, then Open again.

## Using it

**Companies (home).** All your companies in one table, with the step each one has reached, Claude's ratings, buyers found and emails sent. Each row has a **Next step** button ("Analyze", "Find buyers", "Write emails", "Follow up", "2 buyers interested"). Filter by step, analyze all new companies at once, and download what you see as Excel or CSV.

**Adding companies.** Type a name or Business ID in the top bar (press `/`) or in the Add box. Paste or load a list to add many; they appear in the table as they're found. One company opens right away, and Claude starts its analysis.

**A company's workspace** has a step bar at the top (Research, Analysis, Buyers, Outreach) showing progress, and each step ends with the next one to take.
- *Research:* facts with a **Show evidence** switch, and Claude's take if there is one.
- *Analysis:* brief by default (headline, summary, two ratings), with **More detail** and a chat box underneath.
- *Buyers:* the seller story and the ranked buyers, each with fit score, reason, concerns and sources.
  - Tick who to contact.
  - **Find contacts** looks up each selected buyer in full to find who to write to (usually the managing director).
  - **Research this buyer** opens a buyer as a company of its own. What its research finds (contacts, website, figures) flows back into the seller's buyer list.
- *Outreach:* your details, English or Finnish, anonymous by default, then one email per buyer.
  - For each email: edit, copy, open in your email app, set its status (draft, sent, replied: interested / not interested), and write a follow-up.
  - Download everything as a mail-merge CSV. Nothing is sent by the app.

**Running tasks.** Analyses, buyer searches and email writing run in the background. The top bar shows what's running, and you can move between companies meanwhile.

## Evidence

| Section | Evidence |
|---|---|
| Company (trade register) | Link to the official record in YTJ, the date PRH last changed it, and the dates of each register entry |
| Financials | For each figure, the fact filed in the XBRL statement (line-item code, element, context ID, value as filed); calculated figures show their formula |
| Website | For each email, phone, person, founding year and signal: the page it was found on and the text around it; for a guessed website, the text that verified it |

Claude's statements cite these facts by number; click a number to see the fact and its source. The Excel download has an Evidence sheet with one row per fact.

## Good to know

- **Financials** exist only for companies that file digital (XBRL) statements; many small companies file PDF only, so their size shows as unknown.
- **Owners' names, ages and shareholdings** are not in the free open data. People come only from companies' own websites.
- **Email addresses** come from company websites. Companies without a website need an address added by hand.
- **The first email doesn't name the seller** (anonymous teaser). Standard practice is to share the name after the buyer signs an NDA. The app warns if a draft reveals the seller.
- **Claude** (Opus 5) sees only the collected facts and is told to ignore instructions hidden in website text. If its safety system declines a request, the API retries on a fallback model.
- **Cost at Opus 5 prices:** roughly 5–15 cents per analysis, 10–15 cents per seller story, 15–25 cents per buyer search, a few cents per email.
- **Politeness:** robots.txt is respected and at most 5 pages are read per website. Everything is saved locally in `output/` (git-ignored).

## Command line

```
python company_scraper.py 0180611-0
python company_scraper.py "Lapuan Kuljetus" --json
python company_scraper.py --batch example_batch.txt      # --no-website, --no-financials, --out FOLDER
```

## Files

| File | What it does |
|---|---|
| `company_scraper.py` | Register, financial statements and website scraping, with evidence; also the command line |
| `ai.py` | Claude calls: analysis, questions, seller story, buyer scoring, emails and follow-ups |
| `buyers.py` | Buyer search in the register, contacts, campaigns and email checks |
| `app.py` | The web server: pages, background jobs, exports |
| `static/` | The web app: `core.js` helpers, `pipeline.js` home, `company.js` workspace, `deal.js` buyers and outreach, `main.js` routing |
| `tests/` | Offline tests with saved PRH responses; Claude and the register search are simulated |

## Tests

```
python tests/test_offline.py    # scraping and evidence
python tests/test_app.py        # web API, jobs and exports
python tests/test_ai.py         # Claude features (simulated, no API calls)
python tests/test_buyers.py     # buyers, contacts, emails, answers and follow-ups (simulated)
```
