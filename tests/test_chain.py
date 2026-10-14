"""A chain read back: the volatility it was priced at, the expiration's figures, the cache."""

import pytest

from optionslab.chain import Chains, contract, iv_at_days, max_pain, realised_vol
from optionslab.market import Market, NotFound

from .conftest import EXPIRIES, NOW, SPOT, VOL, FakeSource


def test_every_contract_gives_back_the_volatility_it_was_priced_at(market):
    c = Chains(market).chain("ACME", EXPIRIES[1])
    assert c["days"] == 37 and c["spot"] == SPOT and c["rate"] == 0.04
    priced = [s[k] for s in c["strikes"] for k in ("call", "put") if s[k]["mark"] > 0.05]
    assert len(priced) > 10
    for x in priced:
        assert x["iv"] == pytest.approx(VOL, abs=2e-3)
        assert x["mark_source"] == "mid"
    atm = next(s for s in c["strikes"] if s["strike"] == 100.0)
    call, put = atm["call"], atm["put"]
    assert call["breakeven"] == pytest.approx(100 + call["mark"]) and put["breakeven"] == pytest.approx(100 - put["mark"])
    assert call["intrinsic"] == 0 and call["extrinsic"] == pytest.approx(call["mark"])
    assert 0.5 < call["delta"] < 0.6 and -0.5 < put["delta"] < -0.4
    assert call["prob_touch"] == pytest.approx(min(1, 2 * call["prob_itm"]))
    assert call["spread"] == pytest.approx(0.1) and call["oi"] == 100


def test_the_expiration_as_a_whole(market):
    s = Chains(market).chain("ACME", EXPIRIES[1])["summary"]
    assert s["atm_strike"] == 100.0 and s["atm_iv"] == pytest.approx(VOL, abs=2e-3)
    assert s["expected_move_pct"] == pytest.approx(s["straddle"] / SPOT)
    lo, hi = s["one_sigma"]
    assert lo < SPOT < hi
    assert s["put_call_oi"] == pytest.approx(0.5) and s["put_call_volume"] == pytest.approx(1.0)
    assert s["skew_25d"] == pytest.approx(0, abs=3e-3)  # one volatility for every strike: no skew


def test_the_earnings_date_and_whether_it_falls_before_each_expiration(market):
    chains = Chains(market)
    assert chains.underlying("ACME")["earnings_date"] == "2026-11-05"
    assert chains.chain("ACME", EXPIRIES[0])["earnings_before"] is False
    assert chains.chain("ACME", EXPIRIES[1])["earnings_before"] is True


def test_with_no_quote_the_contract_is_marked_at_its_last_trade():
    row = {"strike": 100.0, "bid": 0.0, "ask": 0.0, "lastPrice": 3.0, "volume": None, "openInterest": float("nan")}
    c = contract("call", row, 100.0, 0.1, 0.04, 0.0)
    assert c["mark"] == 3.0 and c["mark_source"] == "last" and c["spread"] is None and c["oi"] is None
    c = contract("call", {"strike": 100.0, "bid": None, "ask": None, "lastPrice": None}, 100.0, 0.1, 0.04, 0.0)
    assert c["mark"] is None and c["iv"] is None and c["delta"] is None


def test_max_pain_is_where_holders_are_paid_least():
    calls = [{"strike": 90.0, "oi": 10}, {"strike": 100.0, "oi": 100}, {"strike": 110.0, "oi": 10}]
    puts = [{"strike": 90.0, "oi": 100}, {"strike": 100.0, "oi": 10}, {"strike": 110.0, "oi": 10}]
    assert max_pain(calls, puts) == 100.0
    assert max_pain([{"strike": 1.0, "oi": 0}], []) is None


def test_terms_and_the_30_day_volatility(market):
    t = Chains(market).terms("ACME")
    assert [r["expiry"] for r in t["terms"]] == EXPIRIES
    assert t["iv30"] == pytest.approx(VOL, abs=3e-3)
    assert iv_at_days([{"years": 0.1, "atm_iv": 0.2}], 30) is None


def test_realised_volatility():
    flat = [100.0] * 30
    assert realised_vol(flat, 20) == 0
    assert realised_vol(flat, 60) is None


def test_unknown_tickers_and_expirations(market):
    chains = Chains(market)
    with pytest.raises(NotFound):
        chains.chain("NOPE", EXPIRIES[0])
    with pytest.raises(NotFound):
        chains.chain("ACME", "2027-01-15")


def test_a_chain_is_read_once_while_it_is_fresh():
    source, clock = FakeSource(), [0.0]
    market = Market(source, now=lambda: NOW, clock=lambda: clock[0])
    chains = Chains(market)
    chains.chain("ACME", EXPIRIES[1])
    chains.chain("ACME", EXPIRIES[1])
    assert source.calls.count(("chain", "ACME", EXPIRIES[1])) == 1
    clock[0] = 301
    chains.chain("ACME", EXPIRIES[1])
    assert source.calls.count(("chain", "ACME", EXPIRIES[1])) == 2
