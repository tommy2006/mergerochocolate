#!/usr/bin/env python3
"""
Company profile scraper for Finnish companies (Mergero hackathon).

Give it a company name or Business ID (Y-tunnus) and it builds one profile from:
  1. PRH / YTJ open data API (official trade register): name, Business ID,
     industry, company form, address, registration dates, status, registers
     (employer / VAT), website.
  2. PRH digital financial statements (XBRL): revenue, operating profit,
     EBITDA, net profit, total assets, equity, for the latest year and the
     year before.
  3. The company's own website: description, contact emails and phones,
     social links, mentioned key people (CEO, owner...), founding year and a
     few simple signals (family business, hiring...).

Output: a JSON file per company plus a readable summary in the terminal.

Usage:
  python company_scraper.py 0180611-0
  python company_scraper.py "Lapuan Kuljetus"
  python company_scraper.py "Some Company Oy" --website https://example.fi
  python company_scraper.py --batch companies.txt
  python company_scraper.py 0180611-0 --json          # JSON only, to stdout

Only public, official or company-published data is used. robots.txt is
respected on company websites.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import unicodedata
import xml.etree.ElementTree as ET
from contextvars import ContextVar
from datetime import date, datetime
from html import unescape
from pathlib import Path
from urllib.parse import urljoin, urlparse
from urllib import robotparser
from typing import Callable

import requests

try:
    from bs4 import BeautifulSoup
except ImportError:  # website scraping is skipped without bs4
    BeautifulSoup = None

YTJ_API = "https://avoindata.prh.fi/opendata-ytj-api/v3"
YTJ_PAGE = "https://tietopalvelu.ytj.fi/yritys"  # public page per Business ID
XBRL_API = "https://avoindata.prh.fi/opendata-xbrl-api/v3"
USER_AGENT = "MergeroHackathonScraper/0.1 (company research prototype)"
TIMEOUT = 20

session = requests.Session()
session.headers.update({"User-Agent": USER_AGENT, "Accept-Language": "fi,en;q=0.8"})


# --------------------------------------------------------------------------
# HTTP helper
# --------------------------------------------------------------------------

def http_get(url: str, params: dict | None = None, retries: int = 3, quiet: bool = False,
             **kw) -> requests.Response | None:
    """GET with retry on 429/5xx. Returns None on failure instead of raising."""
    for attempt in range(retries):
        try:
            resp = session.get(url, params=params, timeout=TIMEOUT, **kw)
        except requests.RequestException as exc:
            if attempt == retries - 1:
                if not quiet:
                    log(f"  ! request failed: {url} ({exc.__class__.__name__})")
                return None
            time.sleep(1.5 * (attempt + 1))
            continue
        if resp.status_code == 429 or resp.status_code >= 500:
            time.sleep(2 * (attempt + 1))
            continue
        return resp
    return None


QUIET = False
# Set per thread by the web app to capture progress messages of one job.
LOG_HANDLER: ContextVar[Callable[[str], None] | None] = ContextVar("LOG_HANDLER", default=None)


def log(msg: str) -> None:
    handler = LOG_HANDLER.get()
    if handler is not None:
        handler(msg)
    elif not QUIET:
        print(msg, file=sys.stderr)


# --------------------------------------------------------------------------
# 1. Trade register (YTJ)
# --------------------------------------------------------------------------

BUSINESS_ID_RE = re.compile(r"^\d{7}-\d$")

REGISTERS = {
    "1": "Trade register",
    "2": "Foundation register",
    "3": "Register of associations",
    "4": "Tax administration",
    "5": "Prepayment register",
    "6": "VAT register",
    "7": "Employer register",
    "8": "Insurance premium tax register",
}

SITUATIONS = {"SANE": "Restructuring", "SELTILA": "Liquidation", "KONK": "Bankruptcy"}

TRADE_REGISTER_STATUS = {
    "0": "Unregistered",
    "1": "Registered",
    "2": "Removed from register",
    "3": "Start-up not registered",
    "4": "Ceased",
}


def normalise_business_id(text: str) -> str | None:
    t = text.strip().replace(" ", "")
    if re.fullmatch(r"\d{8}", t):
        t = f"{t[:7]}-{t[7]}"
    return t if BUSINESS_ID_RE.match(t) else None


def ytj_search(query: str) -> list[dict]:
    bid = normalise_business_id(query)
    params = {"businessId": bid} if bid else {"name": query.strip()}
    resp = http_get(f"{YTJ_API}/companies", params=params)
    if resp is None or resp.status_code != 200:
        code = resp.status_code if resp is not None else "no response"
        raise RuntimeError(f"PRH registry lookup failed ({code})")
    return resp.json().get("companies", [])


def _desc(descriptions: list | None, lang: str = "3") -> str | None:
    """Pick a description by language code: 1=fi, 2=sv, 3=en."""
    for d in descriptions or []:
        if d.get("languageCode") == lang and d.get("description"):
            return d["description"]
    return None


def _current_name(company: dict) -> str | None:
    for n in company.get("names", []):
        if n.get("type") == "1" and n.get("version") == 1 and not n.get("endDate"):
            return n["name"]
    names = company.get("names") or []
    return names[0]["name"] if names else None


def _is_active(company: dict) -> bool:
    if company.get("endDate"):
        return False
    if any(not s.get("endDate") for s in company.get("companySituations", [])):
        return False
    return company.get("tradeRegisterStatus") in ("1", None)


def _norm(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).lower()
    text = re.sub(r"\b(oy|oyj|ab|ky|ay|ltd|abp|tmi)\b", "", text)
    return re.sub(r"[^\w]+", " ", text).strip()


def pick_company(results: list[dict], query: str) -> tuple[dict | None, list[dict]]:
    """Choose the best match; return (chosen, other candidates)."""
    if not results:
        return None, []
    q = _norm(query)

    def score(c: dict) -> tuple:
        name = _norm(_current_name(c) or "")
        return (
            _is_active(c),
            name == q,
            name.startswith(q),
            q in name,
            -len(name),
        )

    ranked = sorted(results, key=score, reverse=True)
    return ranked[0], ranked[1:]


def _format_address(addr: dict) -> str:
    street = " ".join(
        x for x in [addr.get("street"), addr.get("buildingNumber"), addr.get("entrance"),
                    addr.get("apartmentNumber")] if x
    )
    if addr.get("postOfficeBox"):
        street = f"PL {addr['postOfficeBox']}" + (f", {street}" if street else "")
    city = None
    for po in addr.get("postOffices", []):
        if po.get("languageCode") == "1":
            city = po.get("city")
    if not city and addr.get("postOffices"):
        city = addr["postOffices"][0].get("city")
    parts = [p for p in [addr.get("co") and f"c/o {addr['co']}", street,
                         " ".join(x for x in [addr.get("postCode"), city] if x)] if p]
    if addr.get("freeAddressLine"):
        parts.append(addr["freeAddressLine"].replace("_", " "))
    return ", ".join(parts)


def _years_since(iso: str | None) -> float | None:
    if not iso:
        return None
    try:
        d = datetime.strptime(iso[:10], "%Y-%m-%d").date()
    except ValueError:
        return None
    return round((date.today() - d).days / 365.25, 1)


def parse_registry(c: dict) -> dict:
    names = c.get("names", [])
    municipality = postal_city = None
    addresses = {}
    for a in c.get("addresses", []):
        key = "street_address" if a.get("type") == 1 else "postal_address"
        addresses[key] = _format_address(a)
        for po in a.get("postOffices", []):
            if po.get("languageCode") == "1":
                if a.get("type") == 1:
                    municipality = po.get("city")
                else:
                    postal_city = po.get("city")
    municipality = municipality or postal_city  # some companies register only a postal address

    registers = []
    for e in c.get("registeredEntries", []):
        registers.append({
            "register": REGISTERS.get(e.get("register"), e.get("register")),
            "status": _desc(e.get("descriptions")),
            "since": e.get("registrationDate"),
            "until": e.get("endDate"),
        })

    def in_register(code: str) -> bool:
        return any(e.get("register") == code and not e.get("endDate")
                   for e in c.get("registeredEntries", []))

    employer_entries = [e for e in c.get("registeredEntries", []) if e.get("register") == "7"]
    left_employer_register = (
        employer_entries[0].get("endDate") if employer_entries and not in_register("7") else None
    )

    form = next((f for f in c.get("companyForms", []) if not f.get("endDate")), None)
    mbl = c.get("mainBusinessLine") or {}
    website = (c.get("website") or {}).get("url")

    return {
        "business_id": c["businessId"]["value"],
        "name": _current_name(c),
        "previous_names": [n["name"] for n in names if n.get("type") == "1" and n.get("version", 1) != 1],
        "parallel_names": [n["name"] for n in names if n.get("type") == "2" and not n.get("endDate")],
        "auxiliary_names": [n["name"] for n in names if n.get("type") == "3" and not n.get("endDate")],
        "company_form": _desc(form.get("descriptions")) if form else None,
        "company_form_fi": _desc(form.get("descriptions"), "1") if form else None,
        "industry_code": mbl.get("type"),
        "industry": _desc(mbl.get("descriptions")),
        "industry_fi": _desc(mbl.get("descriptions"), "1"),
        "municipality": municipality,
        **addresses,
        "website": website,
        "registered_on": c.get("registrationDate"),
        "business_id_granted_on": c["businessId"].get("registrationDate"),
        "company_age_years": _years_since(c.get("registrationDate") or c["businessId"].get("registrationDate")),
        "trade_register_status": TRADE_REGISTER_STATUS.get(c.get("tradeRegisterStatus"), c.get("tradeRegisterStatus")),
        "active": _is_active(c),
        "ended_on": c.get("endDate"),
        "situations": [
            {"type": SITUATIONS.get(s.get("type"), s.get("type")),
             "since": s.get("registrationDate"), "until": s.get("endDate")}
            for s in c.get("companySituations", [])
        ],
        "in_employer_register": in_register("7"),
        "left_employer_register_on": left_employer_register,
        "vat_registered": in_register("6"),
        "registers": registers,
        "registry_last_modified": c.get("lastModified"),
        "register_page": f"{YTJ_PAGE}/{c['businessId']['value']}",
        "source": f"{YTJ_API}/companies?businessId={c['businessId']['value']}",
    }


# --------------------------------------------------------------------------
# 2. Digital financial statements (XBRL)
# --------------------------------------------------------------------------

# Line-item codes of the Finnish SBR taxonomy (dimension MCY), identified from
# real filings of small Finnish limited companies (FAS). Costs are reported as
# positive numbers. IFRS filers and some other statement types use different
# codes and will show up as "not mapped".
FIN_CODES = {
    "x673": "revenue",
    "x49": "other_operating_income",
    "x758": "materials_and_services",
    "x5": "personnel_costs",
    "x6": "wages_and_salaries",
    "x448": "depreciation",
    "x1869": "other_operating_expenses",
    "x689": "operating_profit",
    "x738": "profit_before_taxes",
    "x541": "income_taxes",
    "x740": "net_profit",
    "x360": "total_assets",
    "x376": "equity",
    "x424": "total_liabilities",
}


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag.split(":")[-1]


def parse_xbrl(xml_text: str) -> dict:
    """Return {"years": {YYYY-MM-DD: {item: value}}, "evidence": {YYYY-MM-DD: {item: fact}},
    "company_name":..., "period":...}. A fact is the filed element, its context and value."""
    root = ET.fromstring(xml_text.encode("utf-8") if isinstance(xml_text, str) else xml_text)

    contexts: dict[str, dict] = {}
    for ctx in root.iter():
        if _local(ctx.tag) != "context":
            continue
        end = None
        dims = {}
        for el in ctx.iter():
            name = _local(el.tag)
            if name in ("instant", "endDate") and el.text:
                end = el.text.strip()
            elif name == "explicitMember":
                dim = (el.get("dimension") or "").split(":")[-1]
                dims[dim] = (el.text or "").strip().split(":")[-1]
        contexts[ctx.get("id")] = {"end": end, "dims": dims}

    years: dict[str, dict] = {}
    evidence: dict[str, dict] = {}
    text_facts = {}
    mapped = unmapped = 0
    for el in root:
        ctx_id = el.get("contextRef")
        if not ctx_id:
            continue
        ctx = contexts.get(ctx_id, {})
        raw = (el.text or "").strip()
        if el.get("unitRef") is None:
            text_facts[_local(el.tag)] = raw
            continue
        dims = ctx.get("dims", {})
        member = dims.get("MCY")
        if not member or set(dims) - {"MCY", "REF"}:
            continue
        item = FIN_CODES.get(member)
        if not item:
            unmapped += 1
            continue
        try:
            value = float(raw)
        except ValueError:
            continue
        year = years.setdefault(ctx["end"], {})
        if item not in year:
            year[item] = value
            evidence.setdefault(ctx["end"], {})[item] = {
                "code": member, "element": _local(el.tag), "context": ctx_id, "filed_value": raw}
            mapped += 1

    return {
        "company_name": text_facts.get("si168"),
        "period_start": text_facts.get("di120"),
        "period_end": text_facts.get("di121"),
        "years": dict(sorted(years.items(), reverse=True)),
        "evidence": evidence,
        "mapped_facts": mapped,
        "unmapped_facts": unmapped,
    }


def _ratio(a, b):
    return round(a / b * 100, 1) if a is not None and b not in (None, 0) else None


# How the derived figures are calculated (their evidence is the formula)
CALCULATED = {
    "ebitda": "Operating profit + depreciation",
    "ebitda_margin_pct": "EBITDA ÷ revenue",
    "operating_margin_pct": "Operating profit ÷ revenue",
    "net_margin_pct": "Net profit ÷ revenue",
    "equity_ratio_pct": "Equity ÷ total assets",
    "revenue_growth_pct": "Change in revenue from the year before",
}


def derive_metrics(year: dict, prev: dict | None) -> dict:
    out = dict(year)
    op, dep = year.get("operating_profit"), year.get("depreciation")
    if op is not None:
        out["ebitda"] = round(op + (dep or 0), 2)
    rev = year.get("revenue")
    out["ebitda_margin_pct"] = _ratio(out.get("ebitda"), rev)
    out["operating_margin_pct"] = _ratio(op, rev)
    out["net_margin_pct"] = _ratio(year.get("net_profit"), rev)
    out["equity_ratio_pct"] = _ratio(year.get("equity"), year.get("total_assets"))
    if prev and rev is not None and prev.get("revenue"):
        out["revenue_growth_pct"] = _ratio(rev - prev["revenue"], abs(prev["revenue"]))
    return out


def fetch_financials(business_id: str) -> dict:
    resp = http_get(f"{XBRL_API}/financials", params={"businessId": business_id})
    if resp is None or resp.status_code != 200:
        return {"available": False, "note": "Financial statement service did not respond."}
    periods = sorted(resp.json().get("financials", []), key=lambda f: f["financialDate"], reverse=True)
    if not periods:
        return {"available": False,
                "note": "No digital (XBRL) financial statements filed. Many companies still file PDF only."}

    latest = periods[0]["financialDate"]
    xml_resp = http_get(f"{XBRL_API}/financial",
                        params={"businessId": business_id, "financialDate": latest})
    if xml_resp is None or xml_resp.status_code != 200:
        return {"available": False, "periods_filed": [p["financialDate"] for p in periods],
                "note": "Could not download the latest statement."}
    try:
        parsed = parse_xbrl(xml_resp.text)
    except ET.ParseError:
        return {"available": False, "periods_filed": [p["financialDate"] for p in periods],
                "note": "Latest statement could not be parsed."}

    year_keys = list(parsed["years"])
    yearly = {}
    for i, k in enumerate(year_keys):
        prev = parsed["years"][year_keys[i + 1]] if i + 1 < len(year_keys) else None
        yearly[k] = derive_metrics(parsed["years"][k], prev)

    result = {
        "available": bool(yearly),
        "currency": "EUR",
        "latest_period": {"start": parsed["period_start"], "end": parsed["period_end"] or latest},
        "periods_filed": [p["financialDate"] for p in periods],
        "years": yearly,
        "evidence": {k: parsed["evidence"].get(k, {}) for k in yearly},
        "calculated": CALCULATED,
        "source": f"{XBRL_API}/financial?businessId={business_id}&financialDate={latest}",
    }
    if not yearly:
        result["note"] = ("Statement found but its line items use an unmapped taxonomy "
                          "(e.g. IFRS). See the source link.")
    return result


# --------------------------------------------------------------------------
# 3. Company website
# --------------------------------------------------------------------------

PAGE_KEYWORDS = [
    "yhteystiedot", "yhteys", "contact", "meista", "meistä", "tietoa", "about",
    "yritys", "company", "historia", "history", "henkilosto", "henkilöstö",
    "team", "tiimi", "ihmiset", "people", "johto", "management",
]
ROLE_WORDS = [
    "toimitusjohtaja", "omistaja", "perustaja", "yrittäjä", "hallituksen puheenjohtaja",
    "talousjohtaja", "myyntijohtaja", "osakas", "ceo", "owner", "founder", "co-founder",
    "managing director", "chairman", "cfo", "partner", "vd", "ägare",
]
SIGNAL_PATTERNS = {
    "family_business": r"perheyritys|perheyhtiö|family[- ]owned|family business|familjeföretag",
    "multi_generation": r"(toisen|kolmannen|neljännen) (polven|sukupolven)|\b(2nd|3rd|second|third) generation",
    "hiring": r"avoimet työpaikat|rekrytointi|haemme|we are hiring|careers|join our team|lediga jobb",
    "growth_or_expansion": r"laajen|kasvu|expansion|new location|uusi toimipiste|kansainvälist",
    "succession_or_sale": r"sukupolvenvaihdo|omistajanvaihdo|yrityskauppa|jatkaja|succession|new owner",
    "certifications": r"iso ?9001|iso ?14001|iso ?45001|sertifi",
}
SOCIAL_DOMAINS = ["linkedin.com", "facebook.com", "instagram.com", "twitter.com", "x.com",
                  "youtube.com", "tiktok.com"]

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
# (?!-\d): digits followed by "-<digit>" are a Business ID (e.g. 0180611-0), not a phone
PHONE_RE = re.compile(r"(?:\+358|\b0)[\s\-]?\d{1,3}(?:[\s\-]?\d{2,4}){2,3}\b(?!-\d)")
YEAR_RE = re.compile(
    r"(perustettu|perustettiin|vuodesta|vuonna|since|founded|established|grundat)\D{0,25}((?:18|19|20)\d{2})",
    re.I,
)


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _robots(base: str) -> robotparser.RobotFileParser | None:
    rp = robotparser.RobotFileParser()
    resp = http_get(urljoin(base, "/robots.txt"), retries=1)
    if resp is None or resp.status_code != 200:
        return None
    rp.parse(resp.text.splitlines())
    return rp


def _fetch_html(url: str, rp, retries: int = 2, quiet: bool = False) -> tuple[str | None, str | None]:
    if rp is not None and not rp.can_fetch(USER_AGENT, url):
        return None, url
    resp = http_get(url, retries=retries, quiet=quiet, allow_redirects=True)
    if resp is None or resp.status_code != 200 or "html" not in resp.headers.get("Content-Type", "html"):
        return None, url
    resp.encoding = resp.encoding if resp.encoding and resp.encoding.lower() != "iso-8859-1" else resp.apparent_encoding
    return resp.text, resp.url


def _normalise_url(url: str) -> str:
    url = url.strip()
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    return url


def _snippet(text: str, start: int, end: int, width: int = 80) -> str:
    """The text around a match, quoted as evidence."""
    a, b = max(start - width, 0), min(end + width, len(text))
    return ("…" if a else "") + text[a:b].strip() + ("…" if b < len(text) else "")


def _mention(html: str, name: str, business_id: str) -> dict | None:
    """Quote where a page mentions the Business ID or the company name."""
    text = _clean(unescape(re.sub(r"(?is)<(script|style)\b.*?</\1>|<[^>]+>", " ", html)))
    checks = [("Business ID", re.escape(business_id))]
    words = _norm(name).split()
    if words:
        checks.append(("company name", r"\W+".join(map(re.escape, words))))
    for label, pattern in checks:
        m = re.search(pattern, text, re.I)
        if m:
            return {"verified_by": label, "matched": m.group(), "snippet": _snippet(text, m.start(), m.end())}
    return None


def guess_website(name: str, business_id: str) -> tuple[str, dict] | None:
    """Try <name>.fi / .com and accept only if the page mentions the name or Business ID.
    Returns (url, evidence); the evidence quotes the mention that verified the site."""
    base = _norm(name)
    base = unicodedata.normalize("NFKD", base).encode("ascii", "ignore").decode()
    slug_variants = dict.fromkeys([base.replace(" ", ""), base.replace(" ", "-")])  # ordered, unique
    for slug in slug_variants:
        if not slug:
            continue
        for tld in (".fi", ".com"):
            url = f"https://www.{slug}{tld}"
            # most guesses don't exist: no retries, no error message
            html, final = _fetch_html(url, None, retries=1, quiet=True)
            if html and (business_id in html or _norm(name) in _norm(html[:200000])):
                return final, _mention(html, name, business_id) or {"verified_by": "page source"}
    return None


def _page_links(soup, base_url: str) -> list[str]:
    host = urlparse(base_url).netloc.replace("www.", "")
    found = []
    for a in soup.find_all("a", href=True):
        href = urljoin(base_url, a["href"]).split("#")[0]
        p = urlparse(href)
        if p.scheme not in ("http", "https") or p.netloc.replace("www.", "") != host:
            continue
        label = (a.get_text(" ") + " " + p.path).lower()
        if any(k in label for k in PAGE_KEYWORDS) and href not in found and href.rstrip("/") != base_url.rstrip("/"):
            found.append(href)
    return found


def scrape_website(url: str, max_pages: int = 5) -> dict:
    if BeautifulSoup is None:
        return {"available": False, "note": "Install beautifulsoup4 to scrape websites."}
    url = _normalise_url(url)
    rp = _robots(url)
    html, final_url = _fetch_html(url, rp)
    if not html:
        return {"available": False, "url": url, "note": "Website not reachable or disallowed by robots.txt."}

    pages = [(final_url, html)]
    soup = BeautifulSoup(html, "html.parser")
    for link in _page_links(soup, final_url)[: max_pages - 1]:
        sub_html, sub_url = _fetch_html(link, rp)
        if sub_html:
            pages.append((sub_url, sub_html))
        time.sleep(0.3)

    emails, phones, socials, people, years = set(), set(), set(), [], set()
    paragraphs, paragraph_pages, headings, signals = [], [], [], {}
    page_texts = []
    home = BeautifulSoup(pages[0][1], "html.parser")

    # Evidence: the page each finding was first seen on and the text around it.
    ev: dict[str, dict] = {k: {} for k in ("emails", "phones", "social_links", "people_mentions",
                                           "founding_years_mentioned", "signals")}

    def note(kind: str, key: str, page: str, found_in: str, snippet: str | None = None,
             matched: str | None = None) -> None:
        if key not in ev[kind]:
            ev[kind][key] = {"page": page, "found_in": found_in,
                             **({"snippet": snippet} if snippet else {}), **({"matched": matched} if matched else {})}

    for page_url, page_html in pages:
        s = BeautifulSoup(page_html, "html.parser")
        links = []
        for a in s.find_all("a", href=True):
            h = a["href"]
            label = _clean(a.get_text(" ")) or None
            if h.startswith("mailto:"):
                links.append(("emails", h[7:].split("?")[0].strip(), "email link", label))
            elif h.startswith("tel:"):
                links.append(("phones", _clean(h[4:]), "phone link", label))
            elif any(d in h for d in SOCIAL_DOMAINS):
                links.append(("social_links", h.split("?")[0], "link", label))
        for tag in s(["script", "style", "noscript", "svg"]):
            tag.decompose()
        text = _clean(s.get_text(" "))
        page_texts.append((page_url, text))
        for m in EMAIL_RE.finditer(text):
            if not m.group().lower().endswith((".png", ".jpg", ".webp")):
                emails.add(m.group())
                note("emails", m.group(), page_url, "page text", _snippet(text, m.start(), m.end()), m.group())
        for m in PHONE_RE.finditer(text):
            phones.add(_clean(m.group()))
            note("phones", _phone_key(m.group()), page_url, "page text", _snippet(text, m.start(), m.end()), m.group())
        for m in YEAR_RE.finditer(text):
            years.add(m.group(2))
            note("founding_years_mentioned", m.group(2), page_url, "page text",
                 _snippet(text, m.start(), m.end()), m.group())
        # links after text, so a quote from the page text wins over a bare link
        for kind, value, found_in, label in links:
            {"emails": emails, "phones": phones, "social_links": socials}[kind].add(value)
            note(kind, _phone_key(value) if kind == "phones" else value, page_url, found_in,
                 f"Link text: {label}" if label else None)
        for h in s.find_all(["h1", "h2"]):
            t = _clean(h.get_text(" "))
            if t and t not in headings and len(t) < 120:
                headings.append(t)
        for p in s.find_all("p"):
            t = _clean(p.get_text(" "))
            if len(t) > 60 and t not in paragraphs:
                paragraphs.append(t)
                paragraph_pages.append(page_url)
        # people: short text blocks mentioning a role
        for el in s.find_all(["p", "li", "div", "span", "h3", "h4", "td"]):
            t = _clean(el.get_text(" "))
            if 4 < len(t) < 140 and any(re.search(rf"\b{re.escape(r)}\b", t, re.I) for r in ROLE_WORDS):
                if t not in people and not any(t in p or p in t for p in people):
                    people.append(t)
                    note("people_mentions", t, page_url, "page text")

    for key, pattern in SIGNAL_PATTERNS.items():
        for page_url, text in page_texts:
            m = re.search(pattern, text, re.I)
            if m:
                start = max(m.start() - 80, 0)
                signals[key] = "…" + text[start:m.end() + 80] + "…"
                ev["signals"][key] = {"page": page_url, "found_in": "page text",
                                      "snippet": signals[key], "matched": m.group()}
                break

    meta_desc = home.find("meta", attrs={"name": "description"}) or home.find("meta", attrs={"property": "og:description"})
    html_tag = home.find("html")
    about = " ".join(paragraphs)[:2000] or None
    about_pages, used = [], 0
    for t, page in zip(paragraphs, paragraph_pages):
        if used >= 2000:
            break
        used += len(t) + 1
        if page not in about_pages:
            about_pages.append(page)
    email_list = sorted(emails)[:20]
    phone_list = sorted({_phone_key(x): x for x in sorted(phones, key=len, reverse=True)}.values())[:10]
    people = people[:15]
    evidence = {
        "title": {"page": final_url, "found_in": "page title"} if home.title else None,
        "meta_description": ({"page": final_url, "found_in": "meta description"}
                             if meta_desc and meta_desc.get("content") else None),
        "about_text": {"pages": about_pages, "found_in": "paragraphs"} if about else None,
        "emails": {e: ev["emails"][e] for e in email_list if e in ev["emails"]},
        "phones": {p: ev["phones"][_phone_key(p)] for p in phone_list if _phone_key(p) in ev["phones"]},
        "social_links": {u: ev["social_links"][u] for u in sorted(socials) if u in ev["social_links"]},
        "people_mentions": {t: ev["people_mentions"][t] for t in people},
        "founding_years_mentioned": {y: ev["founding_years_mentioned"][y] for y in sorted(years)},
        "signals": ev["signals"],
    }
    return {
        "available": True,
        "url": final_url,
        "pages_scraped": [u for u, _ in pages],
        "title": _clean(home.title.get_text()) if home.title else None,
        "meta_description": _clean(meta_desc["content"]) if meta_desc and meta_desc.get("content") else None,
        "language": html_tag.get("lang") if html_tag else None,
        "headings": headings[:15],
        "about_text": about,
        "emails": email_list,
        "phones": phone_list,
        "social_links": sorted(socials),
        "people_mentions": people,
        "founding_years_mentioned": sorted(years),
        "signals": signals,
        "evidence": {k: v for k, v in evidence.items() if v},
    }


# --------------------------------------------------------------------------
# Profile assembly
# --------------------------------------------------------------------------

def build_profile(query: str, website: str | None = None, with_website: bool = True,
                  with_financials: bool = True, skip_ids: set[str] | None = None) -> dict:
    """Build a company profile. If the company's Business ID is in skip_ids (already
    processed in this batch), return a short "duplicate" result without scraping again."""
    log(f"→ Looking up '{query}' in the PRH trade register…")
    results = ytj_search(query)
    chosen, others = pick_company(results, query)
    if chosen is None:
        return {"query": query, "found": False, "note": "No company found in the PRH register."}

    registry = parse_registry(chosen)
    log(f"  found {registry['name']} ({registry['business_id']})")
    if skip_ids is not None and registry["business_id"] in skip_ids:
        log("  already processed earlier in this batch, skipping")
        return {"query": query, "found": False, "duplicate": True,
                "business_id": registry["business_id"], "name": registry["name"],
                "note": f"Same company as an earlier line: {registry['name']} ({registry['business_id']})."}
    profile = {
        "query": query,
        "found": True,
        "scraped_at": datetime.now().isoformat(timespec="seconds"),
        "registry": registry,
        "other_matches": [
            {"business_id": c["businessId"]["value"], "name": _current_name(c), "active": _is_active(c)}
            for c in others[:10]
        ],
    }

    if with_financials:
        log("→ Fetching digital financial statements…")
        profile["financials"] = fetch_financials(registry["business_id"])
        profile["financials"]["retrieved_at"] = datetime.now().isoformat(timespec="seconds")

    if with_website:
        site = website or registry.get("website")
        site_source = "given" if website else ("registry" if site else None)
        url_evidence = None
        if not site:
            log("→ No website in the registry, trying to guess the domain…")
            guess = guess_website(registry["name"] or query, registry["business_id"])
            if guess:
                site, url_evidence = guess
            site_source = "guessed (verified by name/Business ID on page)" if site else None
        if site:
            log(f"→ Scraping website {site}…")
            profile["website"] = scrape_website(site)
            profile["website"]["url_source"] = site_source
            if url_evidence:
                profile["website"]["url_evidence"] = url_evidence
        else:
            profile["website"] = {"available": False, "note": "No website found. Pass one with --website."}
        profile["website"]["retrieved_at"] = datetime.now().isoformat(timespec="seconds")

    return profile


# --------------------------------------------------------------------------
# Readable summary
# --------------------------------------------------------------------------

def _eur(v) -> str:
    if v is None:
        return "–"
    sign = "-" if v < 0 else ""
    v = abs(v)
    if v >= 1_000_000:
        return f"{sign}€{v / 1_000_000:.2f}M"
    if v >= 1_000:
        return f"{sign}€{v / 1_000:.0f}k"
    return f"{sign}€{v:.0f}"


def _pct(v) -> str:
    return "–" if v is None else f"{v:.1f}%"


def _growth(v) -> str:
    return "–" if v is None else f"{v:+.1f}%"


def _phone_key(p: str) -> str:
    digits = re.sub(r"\D", "", p)
    return "358" + digits[1:] if digits.startswith("0") else digits


def save_profile(p: dict, out_dir: Path) -> Path:
    """Save as <out_dir>/<BusinessID>.json. A section skipped this time (financials or website)
    is kept from the previously saved profile, with the time it was fetched."""
    path = Path(out_dir) / f"{p['registry']['business_id']}.json"
    if path.exists():
        try:
            old = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            old = {}
        for key in ("financials", "website"):
            if key not in p and old.get(key):
                p[key] = {**old[key], "retrieved_at": old[key].get("retrieved_at") or old.get("scraped_at")}
        if "ai_analysis" not in p and old.get("ai_analysis"):  # kept; it records which data it was based on
            p["ai_analysis"] = old["ai_analysis"]
    path.write_text(json.dumps(p, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def summary(p: dict) -> str:
    if p.get("duplicate"):
        return f"= {p['query']}: {p.get('note')} Skipped."
    if not p.get("found"):
        return f"✗ {p['query']}: {p.get('note')}"
    r = p["registry"]
    lines = [
        "=" * 70,
        f"{r['name']}  ({r['business_id']})",
        "=" * 70,
        f"Form:        {r['company_form'] or '–'}",
        f"Industry:    {r['industry'] or '–'} [{r['industry_code'] or '–'}]",
        f"Location:    {r.get('street_address') or r.get('postal_address') or '–'}",
        f"Founded:     {r['registered_on'] or '–'}  ({r['company_age_years'] or '–'} years)",
        f"Status:      {'Active' if r['active'] else 'NOT active'} · {r['trade_register_status']}"
        + ("".join(f" · {s['type']} since {s['since']}" for s in r["situations"] if not s["until"])),
        f"Employer:    {'Yes (in employer register)' if r['in_employer_register'] else 'No'}"
        + (f" – left register {r['left_employer_register_on']}" if r["left_employer_register_on"] else ""),
        f"Website:     {r['website'] or '–'}",
    ]
    if r["previous_names"] or r["auxiliary_names"]:
        lines.append(f"Other names: {', '.join(r['previous_names'] + r['auxiliary_names'])[:200]}")

    f = p.get("financials")
    if f is not None:
        lines.append("")
        lines.append("Financials (digital statements, PRH)")
        if f.get("available"):
            years = list(f["years"].items())
            header = f"  {'':22}" + "".join(f"{k[:4]:>12}" for k, _ in years)
            lines.append(header)
            rows = [("Revenue", "revenue", _eur), ("Revenue growth", "revenue_growth_pct", _growth),
                    ("EBITDA", "ebitda", _eur), ("EBITDA margin", "ebitda_margin_pct", _pct),
                    ("Operating profit", "operating_profit", _eur), ("Net profit", "net_profit", _eur),
                    ("Personnel costs", "personnel_costs", _eur), ("Total assets", "total_assets", _eur),
                    ("Equity", "equity", _eur), ("Equity ratio", "equity_ratio_pct", _pct)]
            for label, key, fmt in rows:
                if any(y.get(key) is not None for _, y in years):
                    lines.append(f"  {label:22}" + "".join(f"{fmt(y.get(key)):>12}" for _, y in years))
        else:
            lines.append(f"  {f.get('note')}")

    w = p.get("website")
    if w is not None:
        lines.append("")
        lines.append("Website")
        if w.get("available"):
            lines.append(f"  URL:        {w['url']} ({w.get('url_source')}, {len(w['pages_scraped'])} pages)")
            if w.get("meta_description"):
                lines.append(f"  About:      {w['meta_description'][:200]}")
            elif w.get("about_text"):
                lines.append(f"  About:      {w['about_text'][:200]}…")
            if w["emails"]:
                lines.append(f"  Emails:     {', '.join(w['emails'][:5])}")
            if w["phones"]:
                lines.append(f"  Phones:     {', '.join(w['phones'][:3])}")
            if w["people_mentions"]:
                lines.append("  People:     " + "\n              ".join(x[:100] for x in w["people_mentions"][:5]))
            if w["founding_years_mentioned"]:
                lines.append(f"  Years:      {', '.join(w['founding_years_mentioned'])}")
            if w["signals"]:
                lines.append(f"  Signals:    {', '.join(w['signals'])}")
            if w["social_links"]:
                lines.append(f"  Social:     {', '.join(w['social_links'][:4])}")
        else:
            lines.append(f"  {w.get('note')}")

    if p["other_matches"]:
        lines.append("")
        lines.append("Other matches for this search: " + "; ".join(
            f"{m['name']} ({m['business_id']})" for m in p["other_matches"][:5]))
    return "\n".join(lines)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def main(argv=None) -> int:
    global QUIET
    ap = argparse.ArgumentParser(description="Scrape a Finnish company profile from public sources.")
    ap.add_argument("query", nargs="*", help="Company name or Business ID (Y-tunnus)")
    ap.add_argument("--batch", help="Text file with one company name or Business ID per line")
    ap.add_argument("--website", help="Company website URL (overrides the registry)")
    ap.add_argument("--out", default="output", help="Folder for JSON files (default: output)")
    ap.add_argument("--no-website", action="store_true", help="Skip website scraping")
    ap.add_argument("--no-financials", action="store_true", help="Skip financial statements")
    ap.add_argument("--json", action="store_true", help="Print JSON to stdout instead of a summary")
    args = ap.parse_args(argv)

    queries = [" ".join(args.query)] if args.query else []
    if args.batch:
        queries += [l.strip() for l in Path(args.batch).read_text(encoding="utf-8").splitlines()
                    if l.strip() and not l.startswith("#")]
    if not queries:
        ap.print_help()
        return 1
    QUIET = args.json

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    profiles = []
    seen_ids: set[str] = set()
    for q in queries:
        try:
            p = build_profile(q, website=args.website if len(queries) == 1 else None,
                              with_website=not args.no_website, with_financials=not args.no_financials,
                              skip_ids=seen_ids)
        except RuntimeError as exc:
            p = {"query": q, "found": False, "note": str(exc)}
        if not p.get("duplicate"):
            profiles.append(p)
        if p.get("found"):
            seen_ids.add(p["registry"]["business_id"])
            log(f"  saved {save_profile(p, out_dir)}")
        if not args.json:
            print(summary(p))
            print()

    is_batch = len(queries) > 1
    if args.json:
        print(json.dumps(profiles if is_batch else profiles[0], ensure_ascii=False, indent=2))
    if is_batch:
        (out_dir / "all_companies.json").write_text(
            json.dumps(profiles, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0 if any(p.get("found") for p in profiles) else 2


if __name__ == "__main__":
    sys.exit(main())
