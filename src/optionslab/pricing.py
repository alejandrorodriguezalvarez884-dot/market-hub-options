"""Black-Scholes-Merton for one option: its price, its greeks, the volatility its price implies and
the risk-neutral odds of where the underlying ends.

Every function takes the same arguments: ``kind`` ("call" or "put"), spot ``S``, strike ``K``,
years to expiry ``T``, the risk-free rate ``r`` and the dividend yield ``q`` (both continuous, per
year) and the volatility ``v`` (per year). US equity options are American; the formula is the
European one, which is the usual reading of a chain and the one that gives an implied volatility.
"""

from __future__ import annotations

import math

SQRT2 = math.sqrt(2.0)
SQRT2PI = math.sqrt(2.0 * math.pi)
VOL_LOW, VOL_HIGH = 1e-4, 5.0


def ncdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / SQRT2))


def npdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / SQRT2PI


def intrinsic(kind: str, S: float, K: float) -> float:
    return max(S - K, 0.0) if kind == "call" else max(K - S, 0.0)


def _d1d2(S: float, K: float, T: float, r: float, q: float, v: float) -> tuple[float, float]:
    st = v * math.sqrt(T)
    d1 = (math.log(S / K) + (r - q + 0.5 * v * v) * T) / st
    return d1, d1 - st


def price(kind: str, S: float, K: float, T: float, r: float, q: float, v: float) -> float:
    """The option's value. At or after expiry, or with no volatility, what exercising pays."""
    if T <= 0 or v <= 0 or S <= 0:
        return intrinsic(kind, S, K)
    d1, d2 = _d1d2(S, K, T, r, q, v)
    if kind == "call":
        return S * math.exp(-q * T) * ncdf(d1) - K * math.exp(-r * T) * ncdf(d2)
    return K * math.exp(-r * T) * ncdf(-d2) - S * math.exp(-q * T) * ncdf(-d1)


def greeks(kind: str, S: float, K: float, T: float, r: float, q: float, v: float) -> dict[str, float]:
    """Per share: delta, gamma (per $1), theta (per calendar day), vega (per volatility point)
    and rho (per percentage point of the rate)."""
    if T <= 0 or v <= 0 or S <= 0:
        itm = intrinsic(kind, S, K) > 0
        delta = (1.0 if kind == "call" else -1.0) if itm else 0.0
        return {"delta": delta, "gamma": 0.0, "theta": 0.0, "vega": 0.0, "rho": 0.0}
    d1, d2 = _d1d2(S, K, T, r, q, v)
    eq, er, sq = math.exp(-q * T), math.exp(-r * T), math.sqrt(T)
    decay = -S * eq * npdf(d1) * v / (2 * sq)
    if kind == "call":
        delta = eq * ncdf(d1)
        theta = decay - r * K * er * ncdf(d2) + q * S * eq * ncdf(d1)
        rho = K * T * er * ncdf(d2)
    else:
        delta = -eq * ncdf(-d1)
        theta = decay + r * K * er * ncdf(-d2) - q * S * eq * ncdf(-d1)
        rho = -K * T * er * ncdf(-d2)
    return {
        "delta": delta,
        "gamma": eq * npdf(d1) / (S * v * sq),
        "theta": theta / 365.0,
        "vega": S * eq * npdf(d1) * sq / 100.0,
        "rho": rho / 100.0,
    }


def implied_vol(kind: str, target: float, S: float, K: float, T: float, r: float, q: float) -> float | None:
    """The volatility at which the formula gives ``target``, or None when no volatility does (a
    price under what the option is worth at no volatility, or no time left)."""
    if T <= 0 or S <= 0 or K <= 0 or not target or target <= 0:
        return None
    low, high = price(kind, S, K, T, r, q, VOL_LOW), price(kind, S, K, T, r, q, VOL_HIGH)
    if target < low - 1e-9 or target > high:
        return None
    a, b = VOL_LOW, VOL_HIGH
    for _ in range(100):
        mid = 0.5 * (a + b)
        if price(kind, S, K, T, r, q, mid) < target:
            a = mid
        else:
            b = mid
        if b - a < 1e-7:
            break
    v = 0.5 * (a + b)
    # A price that sits on the floor says nothing about volatility.
    return None if v <= VOL_LOW * 2 else v


def prob_itm(kind: str, S: float, K: float, T: float, r: float, q: float, v: float) -> float:
    """Risk-neutral chance that the option ends in the money: what its price implies, not a forecast."""
    if T <= 0 or v <= 0:
        return 1.0 if intrinsic(kind, S, K) > 0 else 0.0
    _, d2 = _d1d2(S, K, T, r, q, v)
    return ncdf(d2) if kind == "call" else ncdf(-d2)


def prob_touch(kind: str, S: float, K: float, T: float, r: float, q: float, v: float) -> float:
    """Chance that the underlying reaches the strike at some point before expiry, by the usual
    approximation (twice the chance of ending past it). 1 when it is already past it."""
    if intrinsic(kind, S, K) > 0:
        return 1.0
    return min(1.0, 2.0 * prob_itm(kind, S, K, T, r, q, v))


def cdf_at(x: float, S: float, T: float, r: float, q: float, v: float) -> float:
    """Risk-neutral chance that the underlying ends below ``x`` after ``T`` years (lognormal)."""
    if x <= 0:
        return 0.0
    if T <= 0 or v <= 0:
        return 1.0 if x >= S else 0.0
    return ncdf((math.log(x / S) - (r - q - 0.5 * v * v) * T) / (v * math.sqrt(T)))


def quantile(p: float, S: float, T: float, r: float, q: float, v: float) -> float:
    """The price the underlying ends below with risk-neutral chance ``p`` (``p`` strictly in (0, 1))."""
    # Inverse normal by bisection: plenty for the few points a page asks for.
    a, b = -10.0, 10.0
    for _ in range(80):
        m = 0.5 * (a + b)
        a, b = (m, b) if ncdf(m) < p else (a, m)
    z = 0.5 * (a + b)
    return S * math.exp((r - q - 0.5 * v * v) * T + z * v * math.sqrt(T))
