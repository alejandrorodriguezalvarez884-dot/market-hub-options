"""The formula: parity, greeks against finite differences, implied volatility read back."""

import math

import pytest

from optionslab import pricing

S, K, T, R, Q, V = 100.0, 105.0, 0.5, 0.04, 0.01, 0.3


def test_put_call_parity():
    call, put = pricing.price("call", S, K, T, R, Q, V), pricing.price("put", S, K, T, R, Q, V)
    assert call - put == pytest.approx(S * math.exp(-Q * T) - K * math.exp(-R * T), abs=1e-9)


def test_at_expiry_an_option_is_worth_what_exercising_pays():
    assert pricing.price("call", 110, 100, 0, R, Q, V) == 10
    assert pricing.price("put", 110, 100, 0, R, Q, V) == 0
    assert pricing.greeks("put", 90, 100, 0, R, Q, V)["delta"] == -1


@pytest.mark.parametrize("kind", ["call", "put"])
def test_greeks_match_finite_differences(kind):
    g = pricing.greeks(kind, S, K, T, R, Q, V)
    p = lambda **kw: pricing.price(kind, kw.get("S", S), K, kw.get("T", T), kw.get("r", R), Q, kw.get("v", V))
    h = 1e-4
    assert g["delta"] == pytest.approx((p(S=S + h) - p(S=S - h)) / (2 * h), rel=1e-5)
    assert g["gamma"] == pytest.approx((p(S=S + 0.01) - 2 * p() + p(S=S - 0.01)) / 0.0001, rel=1e-3)
    assert g["vega"] == pytest.approx((p(v=V + h) - p(v=V - h)) / (2 * h) / 100, rel=1e-5)
    assert g["rho"] == pytest.approx((p(r=R + h) - p(r=R - h)) / (2 * h) / 100, rel=1e-5)
    assert g["theta"] == pytest.approx(-(p(T=T + h) - p(T=T - h)) / (2 * h) / 365, rel=1e-5)


@pytest.mark.parametrize("kind,strike", [("call", 80), ("call", 120), ("put", 90), ("put", 130)])
def test_implied_volatility_reads_back_the_volatility(kind, strike):
    target = pricing.price(kind, S, strike, T, R, Q, 0.42)
    assert pricing.implied_vol(kind, target, S, strike, T, R, Q) == pytest.approx(0.42, abs=1e-5)


def test_no_volatility_explains_a_price_under_its_floor():
    assert pricing.implied_vol("call", 0.5, 120, 100, T, R, Q) is None  # worth at least ~20
    assert pricing.implied_vol("call", 5.0, S, K, 0, R, Q) is None
    assert pricing.implied_vol("call", 0.0, S, K, T, R, Q) is None


def test_odds_and_the_distribution_agree():
    itm = pricing.prob_itm("call", S, K, T, R, Q, V)
    assert itm == pytest.approx(1 - pricing.cdf_at(K, S, T, R, Q, V), abs=1e-12)
    assert pricing.prob_touch("call", S, K, T, R, Q, V) == pytest.approx(min(1, 2 * itm))
    assert pricing.prob_touch("put", S, K, T, R, Q, V) == 1  # already past the strike
    x = pricing.quantile(0.3, S, T, R, Q, V)
    assert pricing.cdf_at(x, S, T, R, Q, V) == pytest.approx(0.3, abs=1e-9)
