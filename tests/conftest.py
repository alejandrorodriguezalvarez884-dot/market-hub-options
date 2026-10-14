"""A Yahoo of our own: chains priced with the formula at a known volatility, so every figure the
service reads back can be checked, and no test needs the network."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from optionslab import pricing
from optionslab.market import Market, years_between
from optionslab.saved import MemoryDocs

NOW = datetime(2026, 10, 14, 14, 0, tzinfo=timezone.utc)  # 10 a.m. in New York, market open
SPOT, RATE, VOL = 100.0, 0.04, 0.25
EXPIRIES = ["2026-10-16", "2026-11-20", "2026-12-18"]
STRIKES = [80.0, 85.0, 90.0, 95.0, 100.0, 105.0, 110.0, 115.0, 120.0]


class FakeSource:
    def __init__(self, vol: float = VOL):
        self.vol = vol
        self.calls: list[tuple] = []

    def expirations(self, ticker):
        self.calls.append(("expirations", ticker))
        return EXPIRIES if ticker == "ACME" else []

    def chain(self, ticker, expiry):
        self.calls.append(("chain", ticker, expiry))
        T = years_between(NOW, expiry)

        def row(kind, k):
            p = round(pricing.price(kind, SPOT, k, T, RATE, 0.0, self.vol), 4)
            return {"contractSymbol": f"ACME{expiry}{kind[0].upper()}{k:g}", "strike": k, "lastPrice": p,
                    "bid": round(p - 0.05, 4) if p > 0.05 else 0.0, "ask": round(p + 0.05, 4) if p > 0.05 else round(p, 4) + 0.05,
                    "volume": 10, "openInterest": 100 if kind == "call" else 50, "lastTradeDate": "2026-10-14T13:59:00+00:00"}

        # The mid is the formula's price: a quote of ±5 cents around it.
        calls, puts = [row("call", k) for k in STRIKES], [row("put", k) for k in STRIKES]
        for r in calls + puts:
            if r["bid"] == 0.0:
                r["ask"] = round(2 * r["lastPrice"], 4) or 0.01
        return {"calls": calls, "puts": puts, "underlying": {
            "regularMarketPrice": SPOT, "regularMarketChange": 1.0, "regularMarketChangePercent": 1.01,
            "regularMarketPreviousClose": 99.0, "longName": "Acme Corp.", "currency": "USD", "quoteType": "EQUITY",
            "marketState": "REGULAR", "regularMarketTime": NOW.timestamp(), "earningsTimestamp": datetime(2026, 11, 5, 21, tzinfo=timezone.utc).timestamp()}}

    def closes(self, ticker):
        return [100.0 * (1.01 if i % 2 else 0.99) ** (i % 3) for i in range(260)]

    def rate(self):
        return RATE

    def search(self, query):
        return [{"symbol": "ACME", "name": "Acme Corp.", "exchange": "NYSE", "type": "EQUITY"}]


@pytest.fixture
def source():
    return FakeSource()


@pytest.fixture
def market(source):
    return Market(source, now=lambda: NOW)


@pytest.fixture
def docs():
    return MemoryDocs()
