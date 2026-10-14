"""The strategies a user keeps."""

import pytest

from optionslab.saved import Saved
from optionslab.strategy import InvalidStrategy

LEGS = [{"kind": "call", "side": "long", "qty": 1, "strike": 100, "expiry": "2026-11-20", "price": 4.2}]


def test_keep_change_and_delete(docs):
    saved = Saved(docs)
    s = saved.create("u1", {"name": " Earnings call ", "ticker": "acme", "legs": LEGS})
    assert s["name"] == "Earnings call" and s["ticker"] == "ACME" and s["legs"][0]["strike"] == 100.0
    assert [x["id"] for x in saved.list("u1")] == [s["id"]] and saved.list("u2") == []
    changed = saved.update("u1", s["id"], {"name": "Renamed", "ticker": "ACME", "legs": LEGS})
    assert changed["name"] == "Renamed" and changed["created_utc"] == s["created_utc"]
    assert saved.update("u2", s["id"], {"name": "x", "ticker": "ACME", "legs": LEGS}) is None  # not theirs
    assert saved.delete("u2", s["id"]) is False
    assert saved.delete("u1", s["id"]) is True and saved.list("u1") == []


@pytest.mark.parametrize("body,message", [
    ({"name": "", "ticker": "ACME", "legs": LEGS}, "name"),
    ({"name": "x" * 81, "ticker": "ACME", "legs": LEGS}, "80"),
    ({"name": "x", "ticker": "", "legs": LEGS}, "ticker"),
    ({"name": "x", "ticker": "ACME", "legs": [LEGS[0] | {"price": None}]}, "price it was opened at"),
])
def test_what_is_refused(docs, body, message):
    with pytest.raises(InvalidStrategy, match=message):
        Saved(docs).create("u1", body)


def test_up_to_fifty(docs):
    saved = Saved(docs)
    for i in range(50):
        saved.create("u1", {"name": f"s{i}", "ticker": "ACME", "legs": LEGS})
    with pytest.raises(InvalidStrategy, match="Up to 50"):
        saved.create("u1", {"name": "one more", "ticker": "ACME", "legs": LEGS})
