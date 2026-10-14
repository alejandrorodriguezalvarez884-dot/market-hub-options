"""An option chain read in detail: every contract with its implied volatility, greeks and odds, and
for each expiration the figures that describe it as a whole (at-the-money volatility, the move the
straddle prices in, open interest, skew, max pain). All of it computed here from Yahoo's prices,
the same way for every ticker.
"""

from __future__ import annotations

import math
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from . import pricing
from .config import TERMS_MAX_EXPIRATIONS, TERMS_WORKERS
from .market import NY, Market, NotFound, Unavailable, days_to, years_between


def _num(v) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None


def market_price(row: dict) -> tuple[float | None, str | None]:
    """What a contract is marked at: the middle of bid and ask when there is a quote, the last
    trade when there is not."""
    bid, ask, last = _num(row.get("bid")), _num(row.get("ask")), _num(row.get("lastPrice"))
    if ask and ask > 0 and bid is not None and 0 <= bid <= ask:
        return (bid + ask) / 2, "mid"
    if last and last > 0:
        return last, "last"
    return None, None


def contract(kind: str, row: dict, S: float, T: float, r: float, q: float) -> dict:
    K = float(row["strike"])
    bid, ask = _num(row.get("bid")), _num(row.get("ask"))
    mark, source = market_price(row)
    iv = pricing.implied_vol(kind, mark, S, K, T, r, q) if mark else None
    g = pricing.greeks(kind, S, K, T, r, q, iv) if iv else {}
    intrinsic = pricing.intrinsic(kind, S, K)
    breakeven = (K + mark if kind == "call" else K - mark) if mark is not None else None
    spread = ask - bid if source == "mid" else None
    volume, oi = _num(row.get("volume")), _num(row.get("openInterest"))
    return {
        "symbol": row.get("contractSymbol"),
        "kind": kind,
        "strike": K,
        "bid": bid,
        "ask": ask,
        "last": _num(row.get("lastPrice")),
        "last_trade": row.get("lastTradeDate"),
        "volume": int(volume) if volume is not None else None,
        "oi": int(oi) if oi is not None else None,
        "mark": mark,
        "mark_source": source,
        "spread": spread,
        "spread_pct": spread / mark if spread is not None and mark else None,
        "iv": iv,
        "delta": g.get("delta"),
        "gamma": g.get("gamma"),
        "theta": g.get("theta"),
        "vega": g.get("vega"),
        "rho": g.get("rho"),
        "itm": intrinsic > 0,
        "intrinsic": intrinsic,
        "extrinsic": mark - intrinsic if mark is not None else None,
        "breakeven": breakeven,
        "to_breakeven": breakeven / S - 1 if breakeven is not None else None,
        "prob_itm": pricing.prob_itm(kind, S, K, T, r, q, iv) if iv else None,
        "prob_touch": pricing.prob_touch(kind, S, K, T, r, q, iv) if iv else None,
        "moneyness": K / S - 1,
    }


def _interp(points: list[tuple[float, float]], x: float) -> float | None:
    """Linear interpolation on sorted (x, y) points; the nearest end outside them."""
    if not points:
        return None
    if x <= points[0][0]:
        return points[0][1]
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        if x0 <= x <= x1:
            return y0 if x1 == x0 else y0 + (y1 - y0) * (x - x0) / (x1 - x0)
    return points[-1][1]


def iv_at_delta(contracts: list[dict], target: float) -> float | None:
    """The implied volatility of the out-of-the-money contract whose delta would be ``target``."""
    points = sorted((c["delta"], c["iv"]) for c in contracts
                    if c["iv"] and c["delta"] is not None and not c["itm"] and 0.02 < abs(c["delta"]) < 0.6)
    if len(points) < 2 or not points[0][0] <= target <= points[-1][0]:
        return None
    return _interp(points, target)


def max_pain(calls: list[dict], puts: list[dict]) -> float | None:
    """The expiry price at which the options open today would pay their holders least."""
    strikes = sorted({c["strike"] for c in calls + puts})
    if not strikes or not sum((c["oi"] or 0) for c in calls + puts):
        return None

    def payout(s: float) -> float:
        return (sum((c["oi"] or 0) * max(s - c["strike"], 0) for c in calls)
                + sum((p["oi"] or 0) * max(p["strike"] - s, 0) for p in puts))

    return min(strikes, key=payout)


def summary(calls: list[dict], puts: list[dict], S: float, T: float, r: float, q: float) -> dict:
    by_strike_call = {c["strike"]: c for c in calls}
    by_strike_put = {p["strike"]: p for p in puts}
    both = [k for k in by_strike_call if k in by_strike_put
            and by_strike_call[k]["mark"] is not None and by_strike_put[k]["mark"] is not None]
    atm = min(both, key=lambda k: abs(k - S)) if both else None
    # The smile read from the out-of-the-money side: puts below the price, calls above it.
    otm: dict[float, list[float]] = {}
    for c in calls:
        if c["iv"] and c["strike"] >= S:
            otm.setdefault(c["strike"], []).append(c["iv"])
    for p in puts:
        if p["iv"] and p["strike"] <= S:
            otm.setdefault(p["strike"], []).append(p["iv"])
    smile = sorted((k, sum(v) / len(v)) for k, v in otm.items())
    atm_iv = _interp(smile, S)
    straddle = by_strike_call[atm]["mark"] + by_strike_put[atm]["mark"] if atm is not None else None
    call_oi, put_oi = sum(c["oi"] or 0 for c in calls), sum(p["oi"] or 0 for p in puts)
    call_vol, put_vol = sum(c["volume"] or 0 for c in calls), sum(p["volume"] or 0 for p in puts)
    put25, call25 = iv_at_delta(puts, -0.25), iv_at_delta(calls, 0.25)
    one_sigma = None
    if atm_iv and T > 0:
        one_sigma = [pricing.quantile(0.158655, S, T, r, q, atm_iv), pricing.quantile(0.841345, S, T, r, q, atm_iv)]
    return {
        "atm_strike": atm,
        "atm_iv": atm_iv,
        "straddle": straddle,
        "expected_move_pct": straddle / S if straddle else None,
        "one_sigma": one_sigma,
        "call_oi": call_oi,
        "put_oi": put_oi,
        "call_volume": call_vol,
        "put_volume": put_vol,
        "put_call_oi": put_oi / call_oi if call_oi else None,
        "put_call_volume": put_vol / call_vol if call_vol else None,
        "max_pain": max_pain(calls, puts),
        "iv_put_25d": put25,
        "iv_call_25d": call25,
        "skew_25d": put25 - call25 if put25 and call25 else None,
    }


def realised_vol(closes: list[float], sessions: int) -> float | None:
    """Annualised standard deviation of the last ``sessions`` daily log returns."""
    if len(closes) < sessions + 1:
        return None
    returns = [math.log(b / a) for a, b in zip(closes[-sessions - 1:], closes[-sessions:])]
    mean = sum(returns) / len(returns)
    return math.sqrt(sum((x - mean) ** 2 for x in returns) / (len(returns) - 1) * 252)


class Chains:
    """The figures the pages show, from the market's raw chains."""

    def __init__(self, market: Market):
        self.market = market

    def inputs(self, ticker: str) -> dict:
        """Spot, rate and dividend yield: what every computation for this ticker needs."""
        expirations = self.market.expirations(ticker)
        u = self.market.chain(ticker, expirations[0])["underlying"]
        spot = _num(u.get("regularMarketPrice"))
        if not spot or spot <= 0:
            raise Unavailable(f"Yahoo Finance has no price for {ticker} right now.")
        dividend = _num(u.get("trailingAnnualDividendRate")) or 0.0
        rate, rate_is_bill = self.market.rate()
        return {"spot": spot, "rate": rate, "rate_is_bill": rate_is_bill,
                "dividend_yield": dividend / spot if dividend > 0 else 0.0, "expirations": expirations, "underlying": u}

    def underlying(self, ticker: str) -> dict:
        x = self.inputs(ticker)
        u, now = x["underlying"], self.market.now()
        closes = self.market.closes(ticker)
        earnings = _num(u.get("earningsTimestamp"))
        earnings_date = (datetime.fromtimestamp(earnings, NY).date().isoformat()
                         if earnings and earnings > now.timestamp() else None)
        quote_time = _num(u.get("regularMarketTime"))
        return {
            "ticker": ticker,
            "name": u.get("longName") or u.get("shortName") or ticker,
            "currency": u.get("currency") or "USD",
            "kind": u.get("quoteType") or "",
            "spot": x["spot"],
            "change": _num(u.get("regularMarketChange")),
            "change_pct": (_num(u.get("regularMarketChangePercent")) or 0) / 100 if u.get("regularMarketChangePercent") is not None else None,
            "previous_close": _num(u.get("regularMarketPreviousClose")),
            "market_state": u.get("marketState") or "",
            "quote_time": datetime.fromtimestamp(quote_time, timezone.utc).isoformat() if quote_time else None,
            "rate": x["rate"],
            "rate_is_bill": x["rate_is_bill"],
            "dividend_yield": x["dividend_yield"],
            "earnings_date": earnings_date,
            "realised_vol": {"20": realised_vol(closes, 20), "60": realised_vol(closes, 60), "250": realised_vol(closes, 250)},
            "expirations": [{"date": e, "days": days_to(e, now)} for e in x["expirations"]],
        }

    def chain(self, ticker: str, expiry: str) -> dict:
        x = self.inputs(ticker)
        raw = self.market.chain(ticker, expiry)
        now = self.market.now()
        S, r, q = x["spot"], x["rate"], x["dividend_yield"]
        T = years_between(now, expiry)
        calls = [contract("call", row, S, T, r, q) for row in raw["calls"] if _num(row.get("strike"))]
        puts = [contract("put", row, S, T, r, q) for row in raw["puts"] if _num(row.get("strike"))]
        calls_by, puts_by = {c["strike"]: c for c in calls}, {p["strike"]: p for p in puts}
        strikes = sorted(set(calls_by) | set(puts_by))
        return {
            "ticker": ticker,
            "expiry": expiry,
            "days": days_to(expiry, now),
            "years": T,
            "spot": S,
            "rate": r,
            "dividend_yield": q,
            "earnings_before": self._earnings_before(x["underlying"], expiry, now),
            "summary": summary(calls, puts, S, T, r, q),
            "strikes": [{"strike": k, "call": calls_by.get(k), "put": puts_by.get(k)} for k in strikes],
        }

    @staticmethod
    def _earnings_before(u: dict, expiry: str, now: datetime) -> bool:
        """Whether the next results release falls before this expiration."""
        ts = _num(u.get("earningsTimestamp"))
        return bool(ts and now.timestamp() < ts < years_between(now, expiry) * 365 * 86400 + now.timestamp())

    def terms(self, ticker: str) -> dict:
        """Every expiration side by side: at-the-money volatility, the move the straddle prices in,
        open interest and volume. Chains are read in parallel (and kept, like any other)."""
        x = self.inputs(ticker)
        expirations = x["expirations"][:TERMS_MAX_EXPIRATIONS]

        def one(expiry: str) -> dict | None:
            try:
                c = self.chain(ticker, expiry)
            except (NotFound, Unavailable):
                return None
            s = c["summary"]
            return {"expiry": expiry, "days": c["days"], "years": c["years"], "atm_iv": s["atm_iv"],
                    "straddle": s["straddle"], "expected_move_pct": s["expected_move_pct"],
                    "call_oi": s["call_oi"], "put_oi": s["put_oi"], "call_volume": s["call_volume"],
                    "put_volume": s["put_volume"], "skew_25d": s["skew_25d"], "max_pain": s["max_pain"],
                    "earnings_before": c["earnings_before"]}

        with ThreadPoolExecutor(TERMS_WORKERS) as pool:
            rows = [r for r in pool.map(one, expirations) if r]
        return {"ticker": ticker, "spot": x["spot"], "iv30": iv_at_days(rows, 30), "terms": rows}


def iv_at_days(rows: list[dict], days: int) -> float | None:
    """At-the-money volatility at a fixed horizon, interpolated in total variance between the two
    expirations around it."""
    points = sorted((r["years"], r["atm_iv"] ** 2 * r["years"]) for r in rows if r["atm_iv"] and r["years"] > 2 / 365)
    t = days / 365
    if len(points) < 2 or not points[0][0] <= t <= points[-1][0]:
        return None
    w = _interp(points, t)
    return math.sqrt(w / t) if w and w > 0 else None
