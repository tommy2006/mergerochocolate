"""Offline end-to-end test: routes every HTTP call to saved fixtures.

Run:  python tests/test_offline.py
"""
import json
import re
import sys
from pathlib import Path
from unittest import mock

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
import company_scraper as cs  # noqa: E402

FX = HERE / "fixtures"


class FakeResp:
    def __init__(self, status=200, text="", ctype="text/html", url=""):
        self.status_code, self.text, self.url = status, text, url
        self.headers = {"Content-Type": ctype}
        self.encoding = "utf-8"
        self.apparent_encoding = "utf-8"

    def json(self):
        return json.loads(self.text)


def fake_get(url, params=None, retries=3, **kw):
    params = params or {}
    if url.endswith("/companies"):
        if params.get("businessId") == "0180611-0" or "lapuan" in params.get("name", "").lower():
            return FakeResp(text=(FX / "registry_0180611-0.json").read_text(), ctype="application/json")
        return FakeResp(text='{"totalResults":0,"companies":[]}', ctype="application/json")
    if url.endswith("/financials"):
        return FakeResp(text=(FX / "financials_0180611-0.json").read_text(), ctype="application/json")
    if url.endswith("/financial"):
        assert params["financialDate"] == "2025-12-31", "should pick the latest period"
        return FakeResp(text=(FX / "statement_0180611-0_2025-12-31.xml").read_text(), ctype="text/xml")
    if url.endswith("/robots.txt"):
        return FakeResp(text="User-agent: *\nDisallow: /admin\n", ctype="text/plain")
    pages = {"https://www.lapuankuljetus.fi": "site_home.html",
             "https://www.lapuankuljetus.fi/yhteystiedot": "site_yhteystiedot.html",
             "https://www.lapuankuljetus.fi/meista": "site_meista.html"}
    key = url.rstrip("/")
    if key in pages:
        return FakeResp(text=(FX / pages[key]).read_text(), url=url)
    return FakeResp(status=404, url=url)


def run():
    with mock.patch.object(cs, "http_get", side_effect=fake_get), mock.patch.object(cs.time, "sleep"):
        by_id = cs.build_profile("0180611-0")
        by_name = cs.build_profile("lapuan kuljetus", with_financials=False, with_website=False)
        missing = cs.build_profile("Nonexistent Firma Oy")
        dup = cs.build_profile("Lapuan Kuljetus", skip_ids={"0180611-0"})

    # a batch line that resolves to an already processed company is skipped, not scraped again
    assert dup["duplicate"] and dup["business_id"] == "0180611-0" and "registry" not in dup

    # Business IDs are not phone numbers (the real site prints its ID as "00180611-0")
    assert cs.PHONE_RE.findall("Y-tunnus 0180611-0 · 00180611-0 · puh. 050 5556 705") == ["050 5556 705"]

    r = by_id["registry"]
    assert r["name"] == "Lapuan Kuljetus Oy"
    assert r["industry_code"] == "52310"
    assert r["municipality"] == "LAPUA"
    assert r["street_address"] == "Kuusikontie 18, 62100 LAPUA"
    assert r["active"] is True
    assert r["in_employer_register"] is False and r["left_employer_register_on"] == "2023-02-28"
    assert r["vat_registered"] is True

    f = by_id["financials"]
    assert f["available"], f
    y25, y24 = f["years"]["2025-12-31"], f["years"]["2024-12-31"]
    assert y25["revenue"] == 1204342.08 and y24["revenue"] == 2043365.45
    assert y25["operating_profit"] == 21517.65 and y25["net_profit"] == 15770.38
    assert y25["ebitda"] == round(21517.65 + 6405.87, 2)
    assert y25["total_assets"] == 293916.79 and y25["equity"] == 142814.11
    assert y25["revenue_growth_pct"] == -41.1
    assert y25["equity_ratio_pct"] == 48.6
    # consistency: operating profit = revenue + other income - costs
    calc = y25["revenue"] + y25["other_operating_income"] - y25["materials_and_services"] \
        - y25["depreciation"] - y25["other_operating_expenses"]
    assert abs(calc - y25["operating_profit"]) < 0.02

    # the registry has no website for this company → guessed domain, verified on page
    w = by_id["website"]
    assert w["available"], w
    assert w["url_source"].startswith("guessed")
    assert "info@lapuankuljetus.fi" in w["emails"]
    assert "noise@example.com" not in w["emails"], "script contents must be ignored"
    assert any("Toimitusjohtaja" in p for p in w["people_mentions"])
    assert "1970" in w["founding_years_mentioned"]
    for sig in ("family_business", "multi_generation", "succession_or_sale", "certifications"):
        assert sig in w["signals"], sig
    assert len(w["pages_scraped"]) == 3

    # evidence: every finding points to the page it came from, with the text around it
    ev = w["evidence"]
    email_ev = ev["emails"]["info@lapuankuljetus.fi"]
    assert email_ev["page"].endswith("/yhteystiedot") and "info@lapuankuljetus.fi" in email_ev["snippet"]
    assert ev["phones"]["040 123 4567"]["page"].endswith("/yhteystiedot")
    assert ev["people_mentions"]["Matti Esimerkki Toimitusjohtaja, omistaja"]["page"].endswith("/yhteystiedot")
    assert ev["founding_years_mentioned"]["1970"]["matched"] == "vuodesta 1970"
    assert ev["signals"]["certifications"]["page"].endswith("/meista")
    assert ev["signals"]["certifications"]["matched"] in ev["signals"]["certifications"]["snippet"]
    assert ev["social_links"]["https://www.facebook.com/lapuankuljetus"]["found_in"] == "link"
    assert w["url_evidence"]["verified_by"] == "company name" and "Lapuan Kuljetus" in w["url_evidence"]["snippet"]
    assert r["register_page"] == "https://tietopalvelu.ytj.fi/yritys/0180611-0"

    # every reported figure points to the fact filed in the statement
    xml = (FX / "statement_0180611-0_2025-12-31.xml").read_text()
    for year, items in f["years"].items():
        for item in cs.FIN_CODES.values():
            if items.get(item) is not None:
                fact = f["evidence"][year][item]
                assert float(fact["filed_value"]) == items[item]
                assert re.search(rf':{fact["element"]} contextRef="{fact["context"]}"[^>]*>{re.escape(fact["filed_value"])}<', xml), fact
    assert f["evidence"]["2025-12-31"]["revenue"]["code"] == "x673"
    assert "ebitda" in f["calculated"]

    assert by_name["found"] and by_name["registry"]["business_id"] == "0180611-0"
    assert missing["found"] is False

    print(cs.summary(by_id))
    print("\nALL CHECKS PASSED")


if __name__ == "__main__":
    run()
