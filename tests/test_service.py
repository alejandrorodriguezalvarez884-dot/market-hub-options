"""The API, with the fake Yahoo of conftest and strategies kept in memory."""

from fastapi.testclient import TestClient

from optionslab.api import create_app

from .conftest import EXPIRIES

ORIGIN = "http://testserver"
LEGS = [{"kind": "call", "side": "long", "qty": 1, "strike": 100, "expiry": EXPIRIES[1], "price": 4.2}]


def client(market, docs) -> TestClient:
    return TestClient(create_app(market=market, docs=docs, hub=None), headers={"origin": ORIGIN})


def test_reading_a_ticker(market, docs):
    c = client(market, docs)
    assert c.get("/api/health").json() == {"ok": True}
    u = c.get("/api/underlying/acme").json()
    assert u["ticker"] == "ACME" and [e["date"] for e in u["expirations"]] == EXPIRIES
    chain = c.get("/api/chain/ACME", params={"expiry": EXPIRIES[1]}).json()
    assert chain["summary"]["atm_strike"] == 100.0 and len(chain["strikes"]) == 9
    assert len(c.get("/api/terms/ACME").json()["terms"]) == 3
    assert c.get("/api/search", params={"q": "acme"}).json()["results"][0]["symbol"] == "ACME"


def test_what_is_not_there(market, docs):
    c = client(market, docs)
    assert c.get("/api/underlying/NOPE").status_code == 404
    assert c.get("/api/underlying/not a ticker").status_code == 404
    assert c.get("/api/chain/ACME", params={"expiry": "2030-01-01"}).status_code == 404
    assert c.get("/api/chain/ACME", params={"expiry": "soon"}).status_code == 422


def test_a_strategy_and_keeping_it(market, docs):
    c = client(market, docs)
    a = c.post("/api/strategy", json={"ticker": "ACME", "legs": LEGS}).json()
    assert a["cost"] == 420 and a["max_profit"] is None
    bad = c.post("/api/strategy", json={"ticker": "ACME", "legs": []})
    assert bad.status_code == 400 and "at least one leg" in bad.json()["detail"]
    kept = c.post("/api/strategies", json={"name": "Long call", "ticker": "ACME", "legs": LEGS}).json()
    assert c.get("/api/strategies").json()["strategies"][0]["id"] == kept["id"]
    assert docs.get("local")["strategies"][0]["name"] == "Long call"  # one local user without the hub
    assert c.put(f"/api/strategies/{kept['id']}", json={"name": "Renamed", "ticker": "ACME", "legs": LEGS}).json()["name"] == "Renamed"
    assert c.put("/api/strategies/nope", json={"name": "x", "ticker": "ACME", "legs": LEGS}).status_code == 404
    assert c.delete(f"/api/strategies/{kept['id']}").json() == {"deleted": True}
    assert c.delete(f"/api/strategies/{kept['id']}").status_code == 404


def test_writes_from_another_site_are_refused(market, docs):
    c = client(market, docs)
    r = c.post("/api/strategies", json={"name": "x", "ticker": "ACME", "legs": LEGS}, headers={"origin": "https://evil.example"})
    assert r.status_code == 403 and docs.get("local") is None
    assert c.post("/api/strategy", json={"ticker": "ACME", "legs": LEGS}, headers={"origin": ""}).status_code == 403
