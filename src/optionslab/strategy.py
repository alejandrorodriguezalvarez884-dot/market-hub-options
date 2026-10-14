"""A strategy: a few legs (calls, puts, shares; bought or sold) on one underlying, read as a whole.

What it pays at the first expiration and what it would be worth before then, at today's implied
volatilities; where it breaks even; its most and least; its greeks; and the chance, by the
volatility the market prices in, that it ends with a profit. A description of the position the
visitor built, never a suggestion of which one to build.
"""

from __future__ import annotations

import math
from datetime import datetime

from . import pricing
from .chain import Chains
from .config import MAX_LEGS, MAX_QTY, MULTIPLIER
from .market import DATE, NotFound, days_to, expiry_close, years_between

KINDS = ("call", "put", "stock")
SIDES = ("long", "short")
GRID_POINTS = 240
MIN_VOL = 0.01


class InvalidStrategy(ValueError):
    pass


def clean_legs(raw) -> list[dict]:
    """Validate what the visitor sent: up to MAX_LEGS legs, each a call, a put or shares, bought
    or sold, with a quantity and, for an option, a strike and an expiration. ``price`` is what was
    paid or received per share; without it the leg is opened at today's price."""
    if not isinstance(raw, list) or not raw:
        raise InvalidStrategy("Add at least one leg.")
    if len(raw) > MAX_LEGS:
        raise InvalidStrategy(f"Up to {MAX_LEGS} legs.")
    legs = []
    for i, leg in enumerate(raw, 1):
        if not isinstance(leg, dict):
            raise InvalidStrategy(f"Leg {i} is not a leg.")
        kind, side = leg.get("kind"), leg.get("side")
        if kind not in KINDS or side not in SIDES:
            raise InvalidStrategy(f"Leg {i}: a call, a put or shares, long or short.")
        try:
            qty = int(leg.get("qty", 1))
            price = float(leg["price"]) if leg.get("price") not in (None, "") else None
        except (TypeError, ValueError):
            raise InvalidStrategy(f"Leg {i}: the quantity and the price must be numbers.") from None
        if not 1 <= qty <= MAX_QTY:
            raise InvalidStrategy(f"Leg {i}: the quantity goes from 1 to {MAX_QTY:,}.")
        if price is not None and not (0 <= price < 1e6 and math.isfinite(price)):
            raise InvalidStrategy(f"Leg {i}: the price must be zero or positive.")
        clean = {"kind": kind, "side": side, "qty": qty, "price": price}
        if kind != "stock":
            try:
                strike = float(leg.get("strike"))
            except (TypeError, ValueError):
                raise InvalidStrategy(f"Leg {i}: an option needs a strike.") from None
            expiry = str(leg.get("expiry") or "")
            if not (0 < strike < 1e6) or not DATE.match(expiry):
                raise InvalidStrategy(f"Leg {i}: an option needs a strike and an expiration.")
            clean |= {"strike": strike, "expiry": expiry}
        legs.append(clean)
    if all(leg["kind"] == "stock" for leg in legs):
        raise InvalidStrategy("Add at least one option.")
    return legs


def _sign(leg: dict) -> int:
    return 1 if leg["side"] == "long" else -1


def _size(leg: dict) -> int:
    """Signed number of shares the leg stands for."""
    return _sign(leg) * leg["qty"] * (1 if leg["kind"] == "stock" else MULTIPLIER)


class Position:
    """The legs priced: what each one is worth at a price of the underlying and a moment in time."""

    def __init__(self, legs: list[dict], r: float, q: float, iv_shift: float = 0.0):
        self.legs, self.r, self.q, self.iv_shift = legs, r, q, iv_shift
        self.cost = sum(_size(leg) * leg["entry"] for leg in legs)

    def vol(self, leg: dict) -> float:
        return max(leg["iv"] + self.iv_shift, MIN_VOL)

    def value(self, S: float, when: datetime) -> float:
        total = 0.0
        for leg in self.legs:
            if leg["kind"] == "stock":
                total += _size(leg) * S
            else:
                T = years_between(when, leg["expiry"])
                total += _size(leg) * pricing.price(leg["kind"], S, leg["strike"], T, self.r, self.q, self.vol(leg))
        return total

    def pnl(self, S: float, when: datetime) -> float:
        return self.value(S, when) - self.cost

    def greeks(self, S: float, when: datetime) -> dict[str, float]:
        out = {"delta": 0.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0, "rho": 0.0}
        for leg in self.legs:
            if leg["kind"] == "stock":
                out["delta"] += _size(leg)
                continue
            T = years_between(when, leg["expiry"])
            g = pricing.greeks(leg["kind"], S, leg["strike"], T, self.r, self.q, self.vol(leg))
            for k in out:
                out[k] += _size(leg) * g[k]
        return out

    def right_slope(self) -> int:
        """Shares the position is long (positive) or short (negative) as the price runs up without
        limit: calls and shares count, puts go to zero."""
        return sum(_size(leg) for leg in self.legs if leg["kind"] != "put")


def breakevens(points: list[tuple[float, float]]) -> list[float]:
    found = []
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        if y0 == 0 and (not found or abs(found[-1] - x0) > 1e-9):
            found.append(x0)
        elif y0 * y1 < 0:
            found.append(x0 + (x1 - x0) * (-y0) / (y1 - y0))
    return [round(b, 4) for b in found]


def grid(lo: float, hi: float, n: int, extra: list[float]) -> list[float]:
    step = (hi - lo) / (n - 1)
    return sorted({round(lo + i * step, 6) for i in range(n)} | {round(x, 6) for x in extra if lo <= x <= hi})


def analyse(chains: Chains, ticker: str, raw_legs, at: str | None = None, iv_shift: float = 0.0) -> dict:
    legs = clean_legs(raw_legs)
    if not -0.5 <= iv_shift <= 1.0:
        raise InvalidStrategy("The volatility shift goes from −50 to +100 points.")
    x = chains.inputs(ticker)
    S, r, q = x["spot"], x["rate"], x["dividend_yield"]
    now = chains.market.now()
    notes: list[str] = []
    priced = []
    horizon_chain = None
    horizon = min(leg["expiry"] for leg in legs if leg["kind"] != "stock")
    for i, leg in enumerate(legs, 1):
        leg = dict(leg)
        if leg["kind"] == "stock":
            leg |= {"mark": S, "mark_source": "spot", "iv": 0.0, "symbol": ticker}
        else:
            try:
                c = chains.chain(ticker, leg["expiry"])
            except NotFound:
                raise InvalidStrategy(f"Leg {i}: {ticker} has no options expiring on {leg['expiry']} "
                                      "(an expiration that has passed is no longer listed).") from None
            if leg["expiry"] == horizon:
                horizon_chain = c
            row = next((s for s in c["strikes"] if abs(s["strike"] - leg["strike"]) < 1e-6), None)
            found = row and row[leg["kind"]]
            if not found:
                raise InvalidStrategy(f"Leg {i}: there is no {leg['expiry']} {leg['kind']} at {leg['strike']:g}.")
            iv = found["iv"] or c["summary"]["atm_iv"]
            if not iv:
                raise InvalidStrategy(f"Leg {i}: the {leg['strike']:g} {leg['kind']} has no price to read a volatility from.")
            if not found["iv"]:
                notes.append(f"The {leg['strike']:g} {leg['kind']} has no usable price: it is valued at the at-the-money volatility.")
            leg |= {"mark": found["mark"] if found["mark"] is not None else pricing.price(
                        leg["kind"], S, leg["strike"], c["years"], r, q, iv),
                    "mark_source": found["mark_source"] or "model", "iv": iv, "symbol": found["symbol"]}
        leg["entry"] = leg["price"] if leg["price"] is not None else leg["mark"]
        priced.append(leg)

    position = Position(priced, r, q, iv_shift)
    end = expiry_close(horizon)
    T = years_between(now, horizon)
    sigma = max((horizon_chain["summary"]["atm_iv"] if horizon_chain else None)
                or sum(leg["iv"] for leg in priced if leg["kind"] != "stock") / sum(leg["kind"] != "stock" for leg in priced),
                MIN_VOL) + iv_shift
    sigma = max(sigma, MIN_VOL)
    strikes = [leg["strike"] for leg in priced if leg["kind"] != "stock"]
    spread = math.exp(3 * sigma * math.sqrt(max(T, 1 / 365)))
    lo = max(min(strikes + [S / spread]) * 0.92, 0.01)
    hi = max(strikes + [S * spread]) * 1.08
    prices = grid(lo, hi, GRID_POINTS, strikes + [S])

    target = None
    if at:
        if not DATE.match(at):
            raise InvalidStrategy("The date must be written as YYYY-MM-DD.")
        when = expiry_close(at)
        if not now < when < end:
            raise InvalidStrategy("The date must fall between today and the first expiration.")
        target = when

    at_end = [position.pnl(p, end) for p in prices]
    curves = {
        "prices": prices,
        "expiry": at_end,
        "now": [position.pnl(p, now) for p in prices],
        "target": [position.pnl(p, target) for p in prices] if target else None,
    }

    # Breakevens, most and least, on a wider sweep than the chart: from nearly nothing to three
    # times the highest strike.
    wide = grid(0.01, max(hi, 3 * max(strikes + [S])), 1200, strikes + [S])
    wide_points = [(p, position.pnl(p, end)) for p in wide]
    bes = breakevens(wide_points)
    values = [v for _, v in wide_points]
    slope = position.right_slope()
    max_profit = None if slope > 0 else max(values)
    max_loss = None if slope < 0 else min(values)

    # The chance of ending with a profit: the risk-neutral lognormal with the volatility at the
    # money for the first expiration, summed over the stretches where the payoff is positive.
    edges = [0.0] + bes + [math.inf]
    pop = 0.0
    for a, b in zip(edges, edges[1:]):
        probe = (a + b) / 2 if math.isfinite(b) else max(a * 1.25, a + 1, S * 2)
        if position.pnl(max(probe, 0.01), end) > 0:
            pop += pricing.cdf_at(b, S, T, r, q, sigma) if math.isfinite(b) else 1.0
            pop -= pricing.cdf_at(a, S, T, r, q, sigma)

    marked = sum(_size(leg) * leg["mark"] for leg in priced)
    greeks = position.greeks(S, now)
    return {
        "ticker": ticker,
        "spot": S,
        "rate": r,
        "dividend_yield": q,
        "horizon": horizon,
        "days": days_to(horizon, now),
        "target": at if target else None,
        "sigma": sigma,
        "iv_shift": iv_shift,
        "legs": [{
            "kind": leg["kind"], "side": leg["side"], "qty": leg["qty"], "strike": leg.get("strike"),
            "expiry": leg.get("expiry"), "symbol": leg["symbol"], "entry": leg["entry"], "mark": leg["mark"],
            "mark_source": leg["mark_source"], "iv": leg["iv"] or None, "shares": _size(leg),
        } for leg in priced],
        "cost": position.cost,
        "value": marked,
        "pnl_now": marked - position.cost,
        "max_profit": max_profit,
        "max_loss": max_loss,
        "reward_risk": max_profit / -max_loss if max_profit is not None and max_loss and max_loss < 0 else None,
        "breakevens": bes,
        "pop": min(max(pop, 0.0), 1.0),
        "one_sigma": [pricing.quantile(0.158655, S, T, r, q, sigma), pricing.quantile(0.841345, S, T, r, q, sigma)] if T > 0 else None,
        "greeks": greeks,
        "curves": curves,
        "notes": notes,
    }
