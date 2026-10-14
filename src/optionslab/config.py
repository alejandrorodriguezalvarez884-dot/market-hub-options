"""Constants of the service. Nothing here costs money: option chains, prices and the Treasury bill
rate come from Yahoo Finance, which takes no key."""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")

DATA_DIR = Path(os.environ.get("OPTIONSLAB_DATA_DIR", ROOT / "data"))

# --- Market data ----------------------------------------------------------------------------

# Nothing is scheduled: a chain is read from Yahoo when someone asks for it, and kept this long.
CHAIN_TTL_SECONDS = 5 * 60
# The price history (for realised volatility) and the Treasury bill rate change once a day.
DAILY_TTL_SECONDS = 6 * 3600
# The risk-free rate is the 13-week Treasury bill's yield (Yahoo's ^IRX, quoted in percent).
RATE_SYMBOL = "^IRX"
# Used only when Yahoo does not answer for the bill; the response says so.
RATE_FALLBACK = 0.04
# Expirations read for the term structure. Indices with daily expirations have many more.
TERMS_MAX_EXPIRATIONS = 40
# Chains read from Yahoo at the same time for the term structure.
TERMS_WORKERS = 8
# Equity options are for 100 shares.
MULTIPLIER = 100

# --- Strategies -----------------------------------------------------------------------------

MAX_LEGS = 8
MAX_STRATEGIES = 50
MAX_NAME = 80
MAX_QTY = 10_000

# One document per user, keyed like the portal's own ("users"), in the portal's database.
FIRESTORE_COLLECTION = "option_strategies"
FIRESTORE_DATABASE = os.environ.get("MARKETHUB_FIRESTORE_DATABASE", "market-hub").strip()
