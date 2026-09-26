"""Offline test of finding buyers and writing outreach emails. The PRH register search and
Claude are simulated: nothing is sent to Anthropic.

Run:  python tests/test_buyers.py
"""
import csv
import io
import sys
import tempfile
from pathlib import Path
from unittest import mock

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import ai  # noqa: E402
import app as webapp  # noqa: E402
import buyers  # noqa: E402
import company_scraper as cs  # noqa: E402
from test_app import wait  # noqa: E402
from test_offline import FakeResp, fake_get  # noqa: E402

SELLER = "0180611-0"
A, B, TMI = "1111111-1", "2222222-2", "3333333-3"


def fake_company(bid, name, town, form="Limited company", employer=True, website=None):
    return {
        "businessId": {"value": bid, "registrationDate": "1990-01-01"},
        "names": [{"name": name, "type": "1", "version": 1}],
        "companyForms": [{"type": "16", "descriptions": [{"languageCode": "3", "description": form}]}],
        "mainBusinessLine": {"type": "49410", "descriptions": [{"languageCode": "3", "description": "Freight transport by road"}]},
        "addresses": [{"type": 1, "street": "Rahtitie", "buildingNumber": "1", "postCode": "60100",
                       "postOffices": [{"city": town.upper(), "languageCode": "1"}]}],
        "registeredEntries": [{"register": "7", "registrationDate": "1995-01-01"}] if employer else [],
        "registrationDate": "1990-01-01", "tradeRegisterStatus": "1", "companySituations": [],
        **({"website": {"url": website}} if website else {}),
    }


def fake_get_with_search(url, params=None, retries=3, **kw):
    params = params or {}
    if url.endswith("/companies") and "mainBusinessLine" in params:
        if params["mainBusinessLine"] == "4941" and params["location"] == "Seinäjoki":
            companies = [
                fake_company(A, "Seinäjoen Rahti Oy", "Seinäjoki", website="https://www.lapuankuljetus.fi"),
                fake_company(B, "Pohjan Kuljetus Oy", "Seinäjoki", employer=False),
                fake_company(TMI, "Rahtimies Tmi", "Seinäjoki", form="Private trader"),
            ]
            # the seller itself shows up in searches too and must be skipped
            companies.append(fake_company(SELLER, "Lapuan Kuljetus Oy", "Lapua"))
            return FakeResp(text=__import__("json").dumps({"companies": companies}), ctype="application/json")
        return FakeResp(text='{"companies": []}', ctype="application/json")
    return fake_get(url, params, retries, **kw)


seen = {}


def fake_brief(facts, name, business_id):
    seen["brief_facts"] = facts
    return {"brief": {
        "background": ["Haulier since 1970 [F6]."], "potential": ["Local customer base [F50]."],
        "deal_notes": ["Revenue fell 41% [F31]."],
        "teaser": "An established aggregates haulier in South Ostrobothnia with revenue of €1-2M.",
        "buyer_types": [{"label": "Regional road freight companies", "relation": "competitor",
                         "reason": "Adds volume in the same area.", "industry_codes": ["4941", "abc"]}],
        "search_areas": ["Seinäjoki"]}, "model": "claude-opus-5", "usage": {}}


def fake_score(seller, buyers_block):
    seen["score_input"] = buyers_block
    return {"buyers": [
        {"id": A, "fit": 82, "relation": "competitor", "why": "Same region and trade.", "concerns": "",
         "contact_email": "INFO@lapuankuljetus.fi", "contact_name": "Matti Esimerkki"},
        {"id": B, "fit": -5, "relation": "adjacent", "why": "Nearby.", "concerns": "No staff.",
         "contact_email": "made.up@example.com", "contact_name": "Invented Person"},
    ], "model": "claude-opus-5", "usage": {}}


def fake_follow_up(seller, buyer, sender, first, language="en", anonymous=True):
    seen["follow_up_first"] = first
    return {"subject": "anything", "body": "Hei,\n\nJust following up on my note last week.\n\nYstävällisin terveisin,",
            "model": "claude-opus-5", "usage": {}}


def fake_email(seller, buyer, sender, language="en", anonymous=True):
    seen.setdefault("email_calls", []).append((seller, buyer, sender, language, anonymous))
    body = "Hei,\n\nWe represent a haulage company. Lapuan Kuljetus is for sale." if "Seinäjoen" in buyer \
        else "Hei,\n\nWe represent an established haulier in your region."
    return {"subject": "Acquisition opportunity in South Ostrobothnia", "body": body + "\n\nYstävällisin terveisin,",
            "model": "claude-opus-5", "usage": {}}


def run():
    with tempfile.TemporaryDirectory() as tmp, \
            mock.patch.object(cs, "http_get", side_effect=fake_get_with_search), mock.patch.object(cs.time, "sleep"), \
            mock.patch.object(ai, "is_configured", return_value=True), \
            mock.patch.object(ai, "seller_brief", side_effect=fake_brief), \
            mock.patch.object(ai, "score_buyers", side_effect=fake_score), \
            mock.patch.object(ai, "write_email", side_effect=fake_email), \
            mock.patch.object(ai, "write_follow_up", side_effect=fake_follow_up):
        client = webapp.create_app(Path(tmp)).test_client()
        wait(client, client.post("/api/jobs", json={"kind": "lookup", "queries": [SELLER]}).get_json()["id"])

        # a fresh campaign
        r = client.get(f"/api/campaigns/{SELLER}").get_json()
        assert r["seller"]["name"] == "Lapuan Kuljetus Oy" and r["campaign"]["buyers"] == []
        assert client.get("/api/campaigns/9999999-9").status_code == 404

        # 1. seller story: cited background and potential, anonymous teaser, buyer search plan
        job = wait(client, client.post(f"/api/campaigns/{SELLER}/brief", json={}).get_json()["id"])
        assert job["items"][0]["status"] == "done", job
        c = client.get(f"/api/campaigns/{SELLER}").get_json()["campaign"]
        assert c["brief"]["background"] == ["Haulier since 1970 [F6]."] and c["brief"]["facts"] == seen["brief_facts"]
        assert c["teaser"].startswith("An established aggregates haulier")

        # 2. buyers: register search -> filters -> financials -> websites -> Claude's scores
        job = wait(client, client.post(f"/api/campaigns/{SELLER}/find", json={}).get_json()["id"], timeout=60)
        item = job["items"][0]
        assert item["status"] == "done", job
        assert any("Searching the trade register" in line for line in item["log"])
        c = client.get(f"/api/campaigns/{SELLER}").get_json()["campaign"]
        ids = [b["business_id"] for b in c["buyers"]]
        assert ids == [A, B], ids                          # seller and sole trader left out, best first
        a, b = c["buyers"]
        assert a["fit"] == 82 and a["selected"] and a["contact_email"] == "info@lapuankuljetus.fi"
        assert a["contact_name"] == "Matti Esimerkki" and a["revenue"] == 1204342.08
        assert a["sources"]["registry"] == f"https://tietopalvelu.ytj.fi/yritys/{A}"
        assert b["fit"] == 0                                # clamped to 0-100
        assert b["contact_email"] == "" and b["contact_name"] == ""   # invented address dropped
        assert c["search"]["areas"] == ["Lapua", "Seinäjoki"] and c["search"]["codes"] == ["4941"]
        assert "Emails found: info@lapuankuljetus.fi" in seen["score_input"]

        # 3. emails: sender details and language, then one tailored email per buyer
        sender = {"name": "Son Nguyen", "title": "M&A advisor", "company": "Mergero", "email": "son@example.com",
                  "phone": "+358 40 000 0000"}
        c = client.post(f"/api/campaigns/{SELLER}/edit",
                        json={"sender": sender, "language": "fi", "selected": {B: True}}).get_json()["campaign"]
        assert c["sender"]["name"] == "Son Nguyen" and c["language"] == "fi" and c["buyers"][1]["selected"]
        job = wait(client, client.post(f"/api/campaigns/{SELLER}/emails", json={"buyer_ids": [A, B]}).get_json()["id"])
        assert [i["status"] for i in job["items"]] == ["done", "done"], job
        assert all(call[3] == "fi" and call[4] is True for call in seen["email_calls"])
        assert "An established aggregates haulier" in seen["email_calls"][0][0]    # the approved teaser
        assert "name: Son Nguyen" in seen["email_calls"][0][2]
        c = client.get(f"/api/campaigns/{SELLER}").get_json()["campaign"]
        ea, eb = c["emails"][A], c["emails"][B]
        assert ea["to"] == "info@lapuankuljetus.fi" and ea["body"].endswith(buyers.OPT_OUT["fi"])
        assert "Son Nguyen\nM&A advisor, Mergero\n+358 40 000 0000\nson@example.com" in ea["body"]
        assert any("reveals the seller" in w for w in ea["warnings"])       # anonymity check
        assert any("recipient" in w for w in eb["warnings"]) and not any("reveals" in w for w in eb["warnings"])

        # researching a buyer fills in its contact in the campaign, and the recipient of its draft
        prof_b = {"registry": cs.parse_registry(fake_company(B, "Pohjan Kuljetus Oy", "Seinäjoki", employer=False)),
                  "website": {"available": True, "url": "https://www.pohjan.fi", "emails": ["info@pohjan.fi", "pekka@pohjan.fi"],
                              "people_mentions": ["Pekka Virtanen, toimitusjohtaja, pekka@pohjan.fi"]}}
        assert buyers.sync_from_profile(Path(tmp), prof_b) == [SELLER]
        c = client.get(f"/api/campaigns/{SELLER}").get_json()["campaign"]
        synced = next(x for x in c["buyers"] if x["business_id"] == B)
        assert synced["contact_email"] == "pekka@pohjan.fi" and synced["contact_name"] == "Pekka Virtanen"
        assert c["emails"][B]["to"] == "pekka@pohjan.fi" and not any("recipient" in w for w in c["emails"][B]["warnings"])
        rows = {r["business_id"]: r for r in client.get("/api/companies").get_json()}
        assert rows[SELLER]["stage"] == "outreach" and rows[SELLER]["buyers"] == 2

        # edits re-check the warnings; status can be tracked
        c = client.post(f"/api/campaigns/{SELLER}/edit",
                        json={"email": {"buyer": B, "to": "ceo@pohjan.fi"}}).get_json()["campaign"]
        assert c["emails"][B]["warnings"] == []
        c = client.post(f"/api/campaigns/{SELLER}/edit",
                        json={"email": {"buyer": A, "status": "sent"}}).get_json()["campaign"]
        assert c["emails"][A]["status"] == "sent" and c["emails"][A]["sent_at"]

        # answers: an interested buyer shows in the pipeline; an answer implies the email was sent
        c = client.post(f"/api/campaigns/{SELLER}/edit",
                        json={"email": {"buyer": B, "status": "interested"}}).get_json()["campaign"]
        assert c["emails"][B]["status"] == "interested" and c["emails"][B]["sent_at"] and c["emails"][B]["answered_at"]
        row = {r["business_id"]: r for r in client.get("/api/companies").get_json()}[SELLER]
        assert row["interested"] == 1 and row["sent"] == 2
        client.post(f"/api/campaigns/{SELLER}/edit", json={"email": {"buyer": B, "status": "sent"}})

        # follow-ups: only for sent emails; same thread subject, signature and opt-out added
        assert client.post(f"/api/campaigns/{SELLER}/followup", json={"buyer_ids": ["9999999-9"]}).status_code == 400
        job = wait(client, client.post(f"/api/campaigns/{SELLER}/followup", json={"buyer_ids": [A]}).get_json()["id"])
        assert job["items"][0]["status"] == "done", job
        c = client.get(f"/api/campaigns/{SELLER}").get_json()["campaign"]
        follow = c["emails"][A]["follow_up"]
        assert follow["subject"] == "Re: Acquisition opportunity in South Ostrobothnia" and follow["status"] == "draft"
        assert follow["body"].endswith(buyers.OPT_OUT["fi"]) and "Son Nguyen" in follow["body"]
        assert "Subject: Acquisition opportunity" in seen["follow_up_first"]
        c = client.post(f"/api/campaigns/{SELLER}/edit",
                        json={"follow_up": {"buyer": A, "status": "sent", "body": "Short note."}}).get_json()["campaign"]
        assert c["emails"][A]["follow_up"]["status"] == "sent" and c["emails"][A]["follow_up"]["body"] == "Short note."

        # a follow-up is due a week after sending, unless one was sent already
        from datetime import datetime, timedelta
        week_ago = (datetime.now() - timedelta(days=8)).isoformat(timespec="seconds")
        assert buyers.follow_up_due({"status": "sent", "sent_at": week_ago})
        assert not buyers.follow_up_due({"status": "sent", "sent_at": week_ago, "follow_up": {"status": "sent"}})
        assert not buyers.follow_up_due({"status": "interested", "sent_at": week_ago})

        # Claude named no contact: the leader's address from the website is used
        rec = {"business_id": "5555555-5", "emails": ["info@x.fi", "anna@x.fi"], "website": "https://x.fi",
               "people": ["Anna Korhonen – toimitusjohtaja – anna@x.fi"]}
        scored = buyers.apply_scores([rec], [{"id": "5555555-5", "fit": 50, "relation": "competitor", "why": "",
                                              "concerns": "", "contact_email": "", "contact_name": ""}])[0]
        assert scored["contact_email"] == "anna@x.fi" and scored["contact_name"] == "Anna Korhonen"

        # a task started for a seller (finding its buyers' contacts) carries its title and the seller
        r = client.post("/api/jobs", json={"kind": "batch", "queries": ["Nonexistent Firma Oy"], "with_website": False,
                                           "title": "Finding contacts for 1 buyer", "seller": SELLER}).get_json()
        assert r["meta"] == {"title": "Finding contacts for 1 buyer", "bid": SELLER}
        wait(client, r["id"])

        # mail-merge CSV and the campaign list
        rows = list(csv.DictReader(io.StringIO(client.get(f"/api/campaigns/{SELLER}/emails.csv").data.decode("utf-8-sig"))))
        assert [r["to"] for r in rows] == ["info@lapuankuljetus.fi", "ceo@pohjan.fi"]
        listed = client.get("/api/campaigns").get_json()
        assert listed[0]["business_id"] == SELLER and listed[0]["emails"] == 2 and listed[0]["sent"] == 2

        # adding the seller itself as a buyer is refused; removing a buyer drops its email
        item = wait(client, client.post(f"/api/campaigns/{SELLER}/buyers",
                                        json={"query": "Lapuan Kuljetus"}).get_json()["id"])["items"][0]
        assert item["status"] == "error" and "being sold" in item["note"]
        c = client.post(f"/api/campaigns/{SELLER}/edit", json={"remove_buyer": B}).get_json()["campaign"]
        assert [b["business_id"] for b in c["buyers"]] == [A] and B not in c["emails"]
        assert client.post(f"/api/campaigns/{SELLER}/emails", json={"buyer_ids": [B]}).status_code == 400

    with tempfile.TemporaryDirectory() as tmp, mock.patch.object(cs, "http_get", side_effect=fake_get), \
            mock.patch.object(cs.time, "sleep"), mock.patch.object(ai, "is_configured", return_value=False):
        client = webapp.create_app(Path(tmp)).test_client()
        wait(client, client.post("/api/jobs", json={"kind": "lookup", "queries": [SELLER]}).get_json()["id"])
        assert client.post(f"/api/campaigns/{SELLER}/brief", json={}).status_code == 400

    print("ALL BUYER CHECKS PASSED")


if __name__ == "__main__":
    run()
