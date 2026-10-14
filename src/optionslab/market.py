"""What is read from Yahoo Finance, and for how long it is kept.

Nothing is scheduled: a chain is read when a visitor asks for it, kept a few minutes in memory and
read again after that. The source is a small interface so the tests need no network.
"""

from __future__ import annotations

import logging
import math
import re
import threading
import time
from datetime import datetime, timezone
from typing import Callable, Protocol
from zoneinfo import ZoneInfo

from .config import CHAIN_TTL_SECONDS, DAILY_TTL_SECONDS, RATE_FALLBACK, RATE_SYMBOL

log = logging.getLogger("optionslab.market")

NY = ZoneInfo("America/New_York")
YEAR_SECONDS = 365 * 86400
TICKER = re.compile(r"^\^?[A-Z0-9][A-Z0-9.\-]{0,9}$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class NotFound(Exception):
    """The ticker has no listed options, or the expiration is not one of its own."""


class Unavailable(Exception):
    """Yahoo did not answer."""


def normalise_ticker(raw: str) -> str:
    t = str(raw or "").strip().upper().replace("/", "-").replace(".", "-")  # BRK.B -> BRK-B, as Yahoo writes it
    if not TICKER.match(t):
        raise NotFound(f"Not a ticker: {raw!r}")
    return t


def expiry_close(expiry: str) -> datetime:
    """Equity options stop trading at 4 p.m. in New York on their expiration day."""
    return datetime.fromisoformat(expiry).replace(hour=16, tzinfo=NY)


def years_between(start: datetime, expiry: str) -> float:
    return max((expiry_close(expiry) - start).total_seconds(), 0.0) / YEAR_SECONDS


def days_to(expiry: str, now: datetime) -> int:
    """Calendar days from today (in New York) to the expiration."""
    return (datetime.fromisoformat(expiry).date() - now.astimezone(NY).date()).days


class Source(Protocol):
    def expirations(self, ticker: str) -> list[str]: ...
    def chain(self, ticker: str, expiry: str) -> dict: ...
    def closes(self, ticker: str) -> list[float]: ...
    def rate(self) -> float | None: ...
    def search(self, query: str) -> list[dict]: ...


def _clean(value):
    """NaN and missing numbers as None; pandas timestamps as ISO text."""
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if isinstance(value, float) and math.isnan(value):
        return None
    if hasattr(value, "item"):  # numpy scalars
        return _clean(value.item())
    return value


class YahooSource:
    """Yahoo Finance through the yfinance library: no key, figures delayed about 15 minutes."""

    def _ticker(self, ticker: str):
        import yfinance as yf

        return yf.Ticker(ticker)

    def expirations(self, ticker: str) -> list[str]:
        return list(self._ticker(ticker).options or ())

    def chain(self, ticker: str, expiry: str) -> dict:
        found = self._ticker(ticker).option_chain(expiry)
        rows = lambda frame: [{k: _clean(v) for k, v in row.items()} for row in frame.to_dict("records")]
        return {"calls": rows(found.calls), "puts": rows(found.puts), "underlying": dict(found.underlying or {})}

    def closes(self, ticker: str) -> list[float]:
        history = self._ticker(ticker).history(period="1y", interval="1d", auto_adjust=True)
        return [float(c) for c in history["Close"].tolist() if c == c and c > 0]

    def rate(self) -> float | None:
        history = self._ticker(RATE_SYMBOL).history(period="10d", interval="1d")
        closes = [float(c) for c in history["Close"].tolist() if c == c and c > 0]
        return closes[-1] / 100.0 if closes else None

    def search(self, query: str) -> list[dict]:
        import yfinance as yf

        quotes = yf.Search(query, max_results=8, news_count=0, lists_count=0).quotes or []
        return [{"symbol": q.get("symbol"), "name": q.get("shortname") or q.get("longname") or "",
                 "exchange": q.get("exchDisp") or q.get("exchange") or "", "type": q.get("quoteType") or ""}
                for q in quotes if q.get("symbol") and q.get("quoteType") in ("EQUITY", "ETF", "INDEX")]


class Market:
    """The source behind a small cache. One read per key at a time: a second visitor asking for
    the same chain waits for the first answer instead of asking Yahoo again."""

    def __init__(self, source: Source | None = None, now: Callable[[], datetime] | None = None,
                 clock: Callable[[], float] = time.monotonic):
        self.source = source or YahooSource()
        self.now = now or (lambda: datetime.now(timezone.utc))
        self.clock = clock
        self._items: dict[tuple, tuple[float, object]] = {}
        self._locks: dict[tuple, threading.Lock] = {}
        self._guard = threading.Lock()

    def _cached(self, key: tuple, ttl: float, read: Callable[[], object]):
        with self._guard:
            lock = self._locks.setdefault(key, threading.Lock())
        with lock:
            hit = self._items.get(key)
            if hit and self.clock() - hit[0] < ttl:
                return hit[1]
            value = read()
            self._items[key] = (self.clock(), value)
            return value

    def expirations(self, ticker: str) -> list[str]:
        def read():
            try:
                return [e for e in self.source.expirations(ticker) if DATE.match(e)]
            except Exception as exc:
                log.warning("expirations failed for %s: %s", ticker, type(exc).__name__)
                raise Unavailable("Yahoo Finance is not answering right now. Try again in a minute.") from None

        found = self._cached(("expirations", ticker), CHAIN_TTL_SECONDS, read)
        if not found:
            raise NotFound(f"{ticker} has no listed options.")
        return found

    def chain(self, ticker: str, expiry: str) -> dict:
        if expiry not in self.expirations(ticker):
            raise NotFound(f"{ticker} has no options expiring on {expiry}.")

        def read():
            try:
                return self.source.chain(ticker, expiry)
            except Exception as exc:
                log.warning("chain failed for %s %s: %s", ticker, expiry, type(exc).__name__)
                raise Unavailable("Yahoo Finance is not answering right now. Try again in a minute.") from None

        return self._cached(("chain", ticker, expiry), CHAIN_TTL_SECONDS, read)

    def closes(self, ticker: str) -> list[float]:
        """A year of daily closes; empty when Yahoo has none (the page then shows no realised volatility)."""
        def read():
            try:
                return self.source.closes(ticker)
            except Exception as exc:
                log.warning("history failed for %s: %s", ticker, type(exc).__name__)
                return []

        return self._cached(("closes", ticker), DAILY_TTL_SECONDS, read)

    def rate(self) -> tuple[float, bool]:
        """The risk-free rate, and whether it is the bill's (False: the fallback)."""
        def read():
            try:
                value = self.source.rate()
            except Exception as exc:
                log.warning("rate failed: %s", type(exc).__name__)
                value = None
            return (value, True) if value is not None and 0 <= value < 0.3 else (RATE_FALLBACK, False)

        return self._cached(("rate",), DAILY_TTL_SECONDS, read)

    def search(self, query: str) -> list[dict]:
        def read():
            try:
                return self.source.search(query)
            except Exception as exc:
                log.warning("search failed: %s", type(exc).__name__)
                return []

        return self._cached(("search", query.lower()), DAILY_TTL_SECONDS, read)
