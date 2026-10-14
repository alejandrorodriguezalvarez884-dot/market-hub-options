"""Strategies whose answers are known: spreads, naked legs, a covered call, odds that add up."""

import pytest

from optionslab import pricing
from optionslab.chain import Chains
from optionslab.market import years_between
from optionslab.strategy import InvalidStrategy, analyse, breakevens, clean_legs

from .conftest import EXPIRIES, NOW, SPOT, VOL

E = EXPIRIES[1]


def leg(kind, side, strike=None, qty=1, price=None, expiry=E):
    out = {"kind": kind, "side": side, "qty": qty, "price": price}
    if kind != "stock":
        out |= {"strike": strike, "expiry": expiry}
    return out


def test_a_bull_call_spread(market):
    a = analyse(Chains(market), "ACME", [leg("call", "long", 100, price=4.0), leg("call", "short", 110, price=1.0)])
    assert a["cost"] == pytest.approx(300)  # a debit of $3 a share
    assert a["max_profit"] == pytest.approx(700) and a["max_loss"] == pytest.approx(-300)
    assert a["breakevens"] == [pytest.approx(103)]
    assert a["reward_risk"] == pytest.approx(700 / 300)
    # Profit above 103: the chance the price ends there.
    T = years_between(NOW, E)
    assert a["pop"] == pytest.approx(1 - pricing.cdf_at(103, SPOT, T, 0.04, 0.0, a["sigma"]), abs=1e-6)
    assert a["sigma"] == pytest.approx(VOL, abs=2e-3)
    assert a["greeks"]["delta"] > 0 and a["horizon"] == E and a["days"] == 37


def test_naked_legs_are_unbounded_on_their_side(market):
    long_call = analyse(Chains(market), "ACME", [leg("call", "long", 100)])
    assert long_call["max_profit"] is None and long_call["max_loss"] < 0
    short_call = analyse(Chains(market), "ACME", [leg("call", "short", 100)])
    assert short_call["max_loss"] is None and short_call["max_profit"] > 0
    short_put = analyse(Chains(market), "ACME", [leg("put", "short", 100, price=5.0)])
    assert short_put["max_profit"] == pytest.approx(500) and short_put["max_loss"] == pytest.approx(-9500, abs=2)


def test_a_covered_call_is_capped_above(market):
    a = analyse(Chains(market), "ACME", [leg("stock", "long", qty=100, price=100.0), leg("call", "short", 110, price=2.0)])
    assert a["max_profit"] == pytest.approx(1200) and a["breakevens"] == [pytest.approx(98)]
    assert a["legs"][0]["shares"] == 100 and a["legs"][1]["shares"] == -100


def test_without_prices_the_legs_open_at_today_s_marks(market):
    a = analyse(Chains(market), "ACME", [leg("put", "long", 95)])
    assert a["legs"][0]["entry"] == a["legs"][0]["mark"] and a["pnl_now"] == 0
    curve = dict(zip(a["curves"]["prices"], a["curves"]["now"]))
    assert curve[SPOT] == pytest.approx(0, abs=1.0)  # the model's value today is the mark, give or take the quote


def test_a_long_straddle_has_two_breakevens_and_its_odds_add_up(market):
    a = analyse(Chains(market), "ACME", [leg("call", "long", 100), leg("put", "long", 100)])
    lo, hi = a["breakevens"]
    T, s = years_between(NOW, E), a["sigma"]
    expected = pricing.cdf_at(lo, SPOT, T, 0.04, 0, s) + 1 - pricing.cdf_at(hi, SPOT, T, 0.04, 0, s)
    assert a["pop"] == pytest.approx(expected, abs=1e-6)


def test_a_calendar_is_read_at_the_first_expiration(market):
    a = analyse(Chains(market), "ACME", [leg("call", "short", 100, expiry=EXPIRIES[1]), leg("call", "long", 100, expiry=EXPIRIES[2])])
    assert a["horizon"] == EXPIRIES[1]
    assert a["max_loss"] is not None and a["max_profit"] is not None  # covered on both sides
    assert len(a["breakevens"]) == 2


def test_a_date_before_the_first_expiration_and_a_volatility_shift(market):
    a = analyse(Chains(market), "ACME", [leg("call", "long", 100)], at="2026-11-01", iv_shift=0.1)
    assert a["target"] == "2026-11-01" and len(a["curves"]["target"]) == len(a["curves"]["prices"])
    assert a["sigma"] == pytest.approx(VOL + 0.1, abs=2e-3)
    with pytest.raises(InvalidStrategy):
        analyse(Chains(market), "ACME", [leg("call", "long", 100)], at="2026-12-01")
    with pytest.raises(InvalidStrategy):
        analyse(Chains(market), "ACME", [leg("call", "long", 100)], iv_shift=3)


def test_legs_that_do_not_exist(market):
    with pytest.raises(InvalidStrategy, match="no 2026-11-20 call at 101"):
        analyse(Chains(market), "ACME", [leg("call", "long", 101)])
    with pytest.raises(InvalidStrategy, match="no options expiring"):
        analyse(Chains(market), "ACME", [leg("call", "long", 100, expiry="2026-10-09")])


@pytest.mark.parametrize("legs,message", [
    ([], "at least one leg"),
    ([leg("stock", "long", qty=100)], "at least one option"),
    ([leg("call", "long", 100)] * 9, "Up to 8"),
    ([leg("call", "sideways", 100)], "long or short"),
    ([leg("call", "long", 100, qty=0)], "quantity"),
    ([leg("call", "long", None)], "strike"),
    ([leg("call", "long", 100, price=-1)], "zero or positive"),
])
def test_what_is_refused(legs, message):
    with pytest.raises(InvalidStrategy, match=message):
        clean_legs(legs)


def test_breakevens_on_a_grid():
    assert breakevens([(0, -1), (1, 1), (2, 1), (3, -1)]) == [0.5, 2.5]
    assert breakevens([(0, 1), (1, 2)]) == []
