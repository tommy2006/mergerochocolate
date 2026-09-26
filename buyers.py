"""
Find potential buyers for a company and prepare outreach emails to them.

Claude's seller brief (ai.seller_brief) names the kinds of buyers to look for, with industry
codes and nearby towns. This module searches the PRH trade register for matching companies,
checks their financial statements and websites, and keeps the most plausible ones for Claude
to score. A campaign – the brief, the buyers and the email drafts – is saved in
output/campaigns/<seller Business ID>.json.
"""

from __future__ import annotations

import csv
import io
import json
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Callable

import company_scraper as cs

BUYER_FORMS = {"Limited company", "Public limited company", "Cooperative"}
MAX_CODES = 8
MAX_AREAS = 8
MAX_WITH_FINANCIALS = 40
MAX_SHORTLIST = 15
AUTO_SELECT = (60, 10)  # select buyers scoring at least 60, at most 10
WORKERS = 4
SENDER_FIELDS = ("name", "title", "company", "email", "phone")
OPT_OUT = {
    "en": "If this isn't relevant for you, just reply and I won't contact you about it again.",
    "fi": "Jos tämä ei ole teille ajankohtainen, vastatkaa tähän viestiin, niin en ole asiasta enää yhteydessä.",
}
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$")

_lock = threading.Lock()


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


# --------------------------------------------------------------------------
# Campaign file
# --------------------------------------------------------------------------

def campaign_path(out_dir: Path, bid: str) -> Path:
    return Path(out_dir) / "campaigns" / f"{bid}.json"


def load_campaign(out_dir: Path, bid: str) -> dict:
    path = campaign_path(out_dir, bid)
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"seller_id": bid, "created_at": _now(), "brief": None, "teaser": "", "buyers": [],
            "search": None, "sender": {}, "language": "en", "anonymous": True, "emails": {}}


def update_campaign(out_dir: Path, bid: str, change: Callable[[dict], None]) -> dict:
    """Read, change and save a campaign, one writer at a time."""
    with _lock:
        c = load_campaign(out_dir, bid)
        change(c)
        c["updated_at"] = _now()
        path = campaign_path(out_dir, bid)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(c, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)
        return c


def list_campaigns(out_dir: Path) -> list[dict]:
    rows = []
    for path in sorted((Path(out_dir) / "campaigns").glob("*.json")):
        try:
            c = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        emails = c.get("emails") or {}
        rows.append({"business_id": path.stem, "buyers": len(c.get("buyers") or []), "has_brief": bool(c.get("brief")),
                     "selected": sum(1 for b in c.get("buyers") or [] if b.get("selected")),
                     "emails": len(emails), "sent": sum(1 for e in emails.values() if e.get("status") == "sent"),
                     "updated_at": c.get("updated_at")})
    return sorted(rows, key=lambda r: r.get("updated_at") or "", reverse=True)


def buyer_index(out_dir: Path) -> dict[str, list[dict]]:
    """For each company that is a candidate buyer somewhere: the sellers and its fit for each."""
    index: dict[str, list[dict]] = {}
    for path in (Path(out_dir) / "campaigns").glob("*.json"):
        try:
            c = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        for b in c.get("buyers") or []:
            index.setdefault(b["business_id"], []).append({"seller": path.stem, "fit": b.get("fit")})
    return index


# --------------------------------------------------------------------------
# Finding candidates
# --------------------------------------------------------------------------

def search_register(code: str, town: str) -> list[dict]:
    """Companies whose main line of business starts with code, located in town (first 100)."""
    resp = cs.http_get(f"{cs.YTJ_API}/companies", params={"mainBusinessLine": code, "location": town}, retries=2)
    if resp is None or resp.status_code != 200:
        return []
    return resp.json().get("companies", [])


def _latest(financials: dict | None) -> tuple[str | None, dict]:
    years = (financials or {}).get("years") or {}
    keys = sorted(years, reverse=True)
    return (keys[0], years[keys[0]]) if keys else (None, {})


def _capacity(cand: dict, seller_revenue: float | None) -> float:
    """Can this buyer afford and absorb the seller? Unknown (no digital statements) counts as 0."""
    _, cur = _latest(cand.get("financials"))
    score = 0.0
    rev = cur.get("revenue")
    if rev and seller_revenue:
        ratio = rev / seller_revenue
        score += 25 if ratio >= 3 else 15 if ratio >= 1 else 0 if ratio >= 0.5 else -10
    if (cur.get("net_profit") or 0) > 0:
        score += 10
    if (cur.get("equity_ratio_pct") or 0) >= 30:
        score += 5
    return score


def _prescore(cand: dict, seller_code: str | None) -> float:
    r = cand["registry"]
    score = 30 - 5 * min(cand["type_rank"], 5)             # buyer types Claude listed first
    score += 10 if seller_code and r.get("industry_code") == seller_code else 0
    score += 15 if r.get("in_employer_register") else 0    # has staff: more capacity to integrate
    score += min(r.get("company_age_years") or 0, 20) / 2
    score += 10 if cand["area_rank"] == 0 else 5 if cand["area_rank"] <= 2 else 0
    return score


def _website(reg: dict) -> dict:
    site = reg.get("website")
    if not site:
        guess = cs.guess_website(reg.get("name") or "", reg["business_id"])
        site = guess[0] if guess else None
    if not site:
        return {"available": False}
    return cs.scrape_website(site, max_pages=3)


def find_candidates(seller: dict, brief: dict, log: Callable[[str], None]) -> tuple[list[dict], dict]:
    """Search the register for the buyer types in the brief; return the shortlist and search stats."""
    r = seller["registry"]
    _, seller_cur = _latest(seller.get("financials"))
    areas = list(dict.fromkeys(a.strip().title() for a in [r.get("municipality") or ""] + brief["search_areas"]
                               if a and a.strip()))[:MAX_AREAS]
    code_info: dict[str, tuple[int, str]] = {}
    for rank, t in enumerate(brief["buyer_types"]):
        for code in t["industry_codes"]:
            code = re.sub(r"\D", "", code)
            if 2 <= len(code) <= 5 and code not in code_info:
                code_info[code] = (rank, t["label"])
    codes = list(code_info)[:MAX_CODES]
    queries = [(code, area) for code in codes for area in areas]
    log(f"→ Searching the trade register: {len(codes)} industries in {len(areas)} towns…")
    with ThreadPoolExecutor(WORKERS) as pool:
        results = list(pool.map(lambda q: search_register(*q), queries))

    candidates: dict[str, dict] = {}
    found = 0
    for (code, area), companies in zip(queries, results):
        rank, label = code_info[code]
        for c in companies:
            found += 1
            bid = c["businessId"]["value"]
            if bid == r["business_id"]:
                continue
            if bid in candidates:
                cand = candidates[bid]
                if label not in cand["matched_types"]:
                    cand["matched_types"].append(label)
                cand["type_rank"] = min(cand["type_rank"], rank)
                cand["area_rank"] = min(cand["area_rank"], areas.index(area))
                continue
            if not cs._is_active(c):
                continue
            reg = cs.parse_registry(c)
            if reg.get("company_form") not in BUYER_FORMS:
                continue
            candidates[bid] = {"registry": reg, "matched_types": [label], "type_rank": rank,
                               "area_rank": areas.index(area), "search_town": area}
    log(f"  {len(candidates)} active companies match")

    ranked = sorted(candidates.values(), key=lambda c: _prescore(c, r.get("industry_code")), reverse=True)
    pool_ = ranked[:MAX_WITH_FINANCIALS]
    log(f"→ Checking financial statements of {len(pool_)} companies…")
    with ThreadPoolExecutor(WORKERS) as pool:
        for cand, fin in zip(pool_, pool.map(lambda c: cs.fetch_financials(c["registry"]["business_id"]), pool_)):
            cand["financials"] = fin
    with_fin = sum(1 for c in pool_ if (c.get("financials") or {}).get("available"))

    seller_rev = seller_cur.get("revenue")
    pool_.sort(key=lambda c: _prescore(c, r.get("industry_code")) + _capacity(c, seller_rev), reverse=True)
    shortlist = pool_[:MAX_SHORTLIST]
    log(f"→ Reading the websites of the best {len(shortlist)}…")
    with ThreadPoolExecutor(WORKERS) as pool:
        for cand, web in zip(shortlist, pool.map(lambda c: _website(c["registry"]), shortlist)):
            cand["website"] = web
    stats = {"areas": areas, "codes": codes, "found": found, "matching": len(candidates),
             "with_financials": with_fin, "shortlisted": len(shortlist), "ran_at": _now()}
    return [buyer_record(c) for c in shortlist], stats


def enrich_one(query: str) -> dict | None:
    """A buyer the user names: look it up and gather the same data as for search results."""
    chosen, _ = cs.pick_company(cs.ytj_search(query), query)
    if chosen is None:
        return None
    reg = cs.parse_registry(chosen)
    cand = {"registry": reg, "matched_types": ["Added by you"], "type_rank": 0, "area_rank": 0,
            "financials": cs.fetch_financials(reg["business_id"]), "website": _website(reg), "added": "manual"}
    return buyer_record(cand)


def buyer_record(cand: dict) -> dict:
    """What the campaign keeps about a candidate buyer."""
    r, fin, web = cand["registry"], cand.get("financials") or {}, cand.get("website") or {}
    year, cur = _latest(fin)
    web_ok = web.get("available")
    return {
        "business_id": r["business_id"], "name": r.get("name"), "municipality": r.get("municipality"),
        "industry": r.get("industry"), "industry_code": r.get("industry_code"),
        "company_form": r.get("company_form"), "registered_on": r.get("registered_on"),
        "company_age_years": r.get("company_age_years"), "in_employer_register": r.get("in_employer_register"),
        "search_town": cand.get("search_town"),
        "website": (web.get("url") if web_ok else None) or r.get("website"),
        "about": ((web.get("meta_description") or web.get("about_text") or "") if web_ok else "")[:600],
        "emails": (web.get("emails") or [])[:6] if web_ok else [],
        "people": (web.get("people_mentions") or [])[:6] if web_ok else [],
        "fiscal_year_end": year, "revenue": cur.get("revenue"), "revenue_growth_pct": cur.get("revenue_growth_pct"),
        "net_profit": cur.get("net_profit"), "equity_ratio_pct": cur.get("equity_ratio_pct"),
        "sources": {"registry": r.get("register_page"), "financials": fin.get("source"),
                    "website": web.get("url") if web_ok else None},
        "matched_types": cand.get("matched_types", []), "added": cand.get("added", "search"),
    }


LEADER_RE = re.compile(r"toimitusjohtaja|\bceo\b|managing director|omistaja|\bowner\b|yrittäjä|founder|perustaja|\bvd\b", re.I)
REFRESHED = ("municipality", "industry", "industry_code", "company_form", "registered_on", "company_age_years",
             "in_employer_register", "website", "about", "emails", "people", "fiscal_year_end", "revenue",
             "revenue_growth_pct", "net_profit", "equity_ratio_pct", "sources")


def pick_contact(emails: list[str], people: list[str], website: str | None) -> tuple[str, str]:
    """The best address to write to: a leader named on the website, else one on the company's own domain."""
    found = {e.lower(): e for e in emails}
    for text in people:
        role = LEADER_RE.search(text)
        email = cs.EMAIL_RE.search(text)
        if role and email and email.group().lower() in found:
            words = re.findall(r"[^\W\d_][\w'-]*", text[:role.start()])
            name = " ".join(w for w in words if w[:1].isupper())[:60]
            return found[email.group().lower()], name
    host = re.sub(r"^https?://(www\.)?", "", website or "").split("/")[0].lower()
    for e in emails:
        if host and e.lower().endswith("@" + host):
            return e, ""
    return (emails[0], "") if emails else ("", "")


def sync_from_profile(out_dir: Path, p: dict) -> list[str]:
    """A researched company updates its entry in every campaign that lists it as a buyer: contact
    details, website and figures. Returns the sellers whose campaigns changed."""
    bid = p["registry"]["business_id"]
    fresh = buyer_record({"registry": p["registry"], "financials": p.get("financials"), "website": p.get("website")})
    changed = []
    for path in (Path(out_dir) / "campaigns").glob("*.json"):
        seller_id = path.stem
        try:
            listed = any(b["business_id"] == bid for b in json.loads(path.read_text(encoding="utf-8")).get("buyers") or [])
        except (OSError, ValueError):
            continue
        if not listed or seller_id == bid:
            continue
        seller_path = Path(out_dir) / f"{seller_id}.json"
        seller = json.loads(seller_path.read_text(encoding="utf-8")) if seller_path.exists() else None

        def change(c):
            for b in c.get("buyers") or []:
                if b["business_id"] != bid:
                    continue
                b.update({k: fresh[k] for k in REFRESHED if fresh.get(k) not in (None, "", [])})
                if not b.get("contact_email"):
                    b["contact_email"], name = pick_contact(b.get("emails") or [], b.get("people") or [], b.get("website"))
                    b["contact_name"] = name or b.get("contact_name") or ""
                email = (c.get("emails") or {}).get(bid)
                if email is not None and not email.get("to") and b.get("contact_email"):
                    email["to"], email["contact_name"] = b["contact_email"], b.get("contact_name", "")
                    if seller:
                        email["warnings"] = check_email(email, seller, email.get("anonymous", True))
        update_campaign(out_dir, seller_id, change)
        changed.append(seller_id)
    return changed


# --------------------------------------------------------------------------
# Text for Claude
# --------------------------------------------------------------------------

def _money(v) -> str:
    if v is None:
        return "–"
    a = abs(v)
    s = f"€{a / 1e6:.1f}M" if a >= 1e6 else f"€{a / 1e3:.0f}k" if a >= 1e3 else f"€{a:.0f}"
    return ("-" if v < 0 else "") + s


def _finance_line(year, rev, growth, profit, equity) -> str:
    if rev is None and profit is None:
        return "no digital financial statements filed"
    parts = [f"revenue {_money(rev)}" + (f" ({growth:+.0f}% on the year before)" if growth is not None else "")]
    parts += [f"net profit {_money(profit)}"]
    if equity is not None:
        parts.append(f"equity ratio {equity:.0f}%")
    return f"year ending {year}: " + ", ".join(parts)


def seller_text(p: dict, brief: dict | None, teaser: str = "") -> str:
    r = p["registry"]
    year, cur = _latest(p.get("financials"))
    web = p.get("website") or {}
    lines = [
        f"Name: {r.get('name')} ({r['business_id']}), {r.get('company_form')}",
        f"Location: {r.get('municipality')}; address {r.get('street_address') or r.get('postal_address')}",
        f"Industry: {r.get('industry')} ({r.get('industry_code')})",
        f"Registered: {r.get('registered_on')} ({r.get('company_age_years')} years ago)",
        f"Employer register: {'yes' if r.get('in_employer_register') else 'no'}"
        + (f", left {r['left_employer_register_on']}" if r.get("left_employer_register_on") else ""),
        f"Financials, {_finance_line(year, cur.get('revenue'), cur.get('revenue_growth_pct'), cur.get('net_profit'), cur.get('equity_ratio_pct'))}",
    ]
    if web.get("available"):
        lines.append(f"Website: {web.get('url')}")
        about = web.get("meta_description") or web.get("about_text")
        if about:
            lines.append(f"From its website: {about[:600]}")
    if brief:
        from ai import strip_citations
        for key, title in (("background", "Background"), ("potential", "Potential for a buyer"),
                           ("deal_notes", "What buyers will ask")):
            lines.append(f"{title}:\n" + "\n".join(f"- {strip_citations(t)}" for t in brief.get(key) or []))
    if teaser:
        lines.append(f"Anonymous teaser (approved wording for describing it without its name):\n{teaser}")
    return "\n".join(lines)


def buyer_text(b: dict) -> str:
    lines = [
        f"Name: {b['name']} ({b['business_id']}), {b.get('company_form')}",
        f"Location: {b.get('municipality') or 'not in the register'}"
        + (f" (found by searching the register for companies in {b['search_town']})" if b.get("search_town") else ""),
        f"Industry: {b.get('industry')} ({b.get('industry_code')})",
        f"Registered: {b.get('registered_on')} ({b.get('company_age_years')} years ago); "
        f"employer register: {'yes' if b.get('in_employer_register') else 'no'}",
        f"Financials, {_finance_line(b.get('fiscal_year_end'), b.get('revenue'), b.get('revenue_growth_pct'), b.get('net_profit'), b.get('equity_ratio_pct'))}",
        f"Website: {b.get('website') or 'none found'}",
    ]
    if b.get("about"):
        lines.append(f"From its website: {b['about']}")
    lines.append(f"Emails found: {', '.join(b.get('emails') or []) or 'none'}")
    if b.get("people"):
        lines.append("People on its website: " + " | ".join(b["people"]))
    if b.get("matched_types"):
        lines.append(f"Found as: {', '.join(b['matched_types'])}")
    return "\n".join(lines)


def buyers_text(buyers: list[dict]) -> str:
    return "\n\n".join(f'<buyer id="{b["business_id"]}">\n{buyer_text(b)}\n</buyer>' for b in buyers)


def sender_text(sender: dict) -> str:
    s = {k: (sender or {}).get(k) or "" for k in SENDER_FIELDS}
    return "\n".join(f"{k}: {v or '(not given)'}" for k, v in s.items())


def apply_scores(buyers: list[dict], scores: list[dict]) -> list[dict]:
    """Merge Claude's scores into the buyer records; drop contact emails that weren't found."""
    by_id = {s.get("id"): s for s in scores}
    for b in buyers:
        s = by_id.get(b["business_id"]) or {}
        b["fit"] = max(0, min(100, int(s.get("fit") or 0)))
        b["relation"] = s.get("relation") or "adjacent"
        b["why"] = (s.get("why") or "").strip()
        b["concerns"] = (s.get("concerns") or "").strip()
        found = {e.lower(): e for e in b.get("emails") or []}
        email = (s.get("contact_email") or "").strip()
        b["contact_email"] = found.get(email.lower()) or (b["emails"][0] if b.get("emails") else "")
        b["contact_name"] = (s.get("contact_name") or "").strip() if email.lower() in found else ""
        b.setdefault("selected", False)
    return sorted(buyers, key=lambda b: b["fit"], reverse=True)


def auto_select(buyers: list[dict]) -> None:
    minimum, most = AUTO_SELECT
    for n, b in enumerate(buyers):
        b["selected"] = b["fit"] >= minimum and n < most


# --------------------------------------------------------------------------
# Emails
# --------------------------------------------------------------------------

def signature(sender: dict) -> str:
    s = sender or {}
    role = ", ".join(x for x in (s.get("title"), s.get("company")) if x)
    lines = [s.get("name") or "[Your name]", role, s.get("phone"), s.get("email") or "[Your email]"]
    return "\n".join(x for x in lines if x)


def seller_identifiers(p: dict) -> list[str]:
    """Words that would reveal the seller in an anonymous email."""
    r = p["registry"]
    ids = [r["business_id"]]
    core = cs._norm(r.get("name") or "")
    if len(core) >= 4:
        ids.append(core)
    for url in ((p.get("website") or {}).get("url"), r.get("website")):
        host = re.sub(r"^https?://(www\.)?", "", url or "").split("/")[0]
        if host:
            ids.append(host.split(".")[0])
    street = (r.get("street_address") or "").split(",")[0].strip()
    if street:
        ids.append(street.lower())
    return [i for i in dict.fromkeys(ids) if len(i) >= 4]


def check_email(email: dict, seller: dict, anonymous: bool) -> list[str]:
    warnings = []
    if not EMAIL_RE.match(email.get("to") or ""):
        warnings.append("No valid recipient address. Add one before sending.")
    text = cs._norm(f"{email.get('subject', '')} {email.get('body', '')}")
    raw = f"{email.get('subject', '')} {email.get('body', '')}".lower()
    if anonymous and any((i in text) or (i in raw) for i in seller_identifiers(seller)):
        warnings.append("It reveals the seller (name, website, Business ID or address) although it should be anonymous.")
    if "[your name]" in raw or "[your email]" in raw:
        warnings.append("Add your name and email under Your details, then rewrite.")
    return warnings


def finish_email(draft: dict, buyer: dict, sender: dict, language: str, anonymous: bool, seller: dict) -> dict:
    body = f"{draft['body'].rstrip()}\n\n{signature(sender)}\n\n{OPT_OUT.get(language, OPT_OUT['en'])}"
    email = {"to": buyer.get("contact_email") or "", "contact_name": buyer.get("contact_name") or "",
             "subject": draft["subject"], "body": body, "status": "draft", "language": language,
             "anonymous": anonymous, "created_at": _now(), "model": draft.get("model")}
    email["warnings"] = check_email(email, seller, anonymous)
    return email


def emails_csv(c: dict) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["to", "contact_name", "buyer", "business_id", "fit", "subject", "body", "status"])
    for b in c.get("buyers") or []:
        e = (c.get("emails") or {}).get(b["business_id"])
        if e:
            w.writerow([e.get("to"), e.get("contact_name"), b.get("name"), b["business_id"], b.get("fit"),
                        e.get("subject"), e.get("body"), e.get("status")])
    return ("﻿" + buf.getvalue()).encode("utf-8")
