"""The strategies each user keeps: one document per user, keyed like the portal's own (the id of the
hub session), in the portal's Firestore database. A folder locally, memory in tests.

The portal deletes this document when its owner deletes the account (``market-hub-landing``,
``DELETE /api/me``). What is kept is only what the visitor saved: the legs, a name and the dates.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

from .config import DATA_DIR, FIRESTORE_COLLECTION, FIRESTORE_DATABASE, MAX_NAME, MAX_STRATEGIES
from .market import normalise_ticker
from .strategy import InvalidStrategy, clean_legs

USER_ID = re.compile(r"^[A-Za-z0-9_\-.:@]{1,128}$")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Docs(Protocol):
    def get(self, user_id: str) -> dict | None: ...
    def put(self, user_id: str, doc: dict) -> None: ...


class MemoryDocs:
    def __init__(self):
        self.docs: dict[str, dict] = {}

    def get(self, user_id: str) -> dict | None:
        doc = self.docs.get(user_id)
        return json.loads(json.dumps(doc)) if doc else None

    def put(self, user_id: str, doc: dict) -> None:
        self.docs[user_id] = json.loads(json.dumps(doc))


class FileDocs:
    """For local development only: one JSON file per user under data/strategies."""

    def __init__(self, root: Path | None = None):
        self.root = Path(root or DATA_DIR / "strategies")
        self._lock = threading.Lock()

    def _path(self, user_id: str) -> Path:
        return self.root / f"{re.sub(r'[^A-Za-z0-9_-]', '_', user_id)}.json"

    def get(self, user_id: str) -> dict | None:
        path = self._path(user_id)
        return json.loads(path.read_text()) if path.exists() else None

    def put(self, user_id: str, doc: dict) -> None:
        with self._lock:
            self.root.mkdir(parents=True, exist_ok=True)
            tmp = self._path(user_id).with_suffix(".tmp")
            tmp.write_text(json.dumps(doc))
            tmp.replace(self._path(user_id))


class FirestoreDocs:
    def __init__(self, collection: str = FIRESTORE_COLLECTION, database: str = FIRESTORE_DATABASE):
        from google.cloud import firestore

        self.collection = firestore.Client(database=database).collection(collection)

    def get(self, user_id: str) -> dict | None:
        snap = self.collection.document(user_id).get()
        return snap.to_dict() if snap.exists else None

    def put(self, user_id: str, doc: dict) -> None:
        self.collection.document(user_id).set(doc)


def default_docs() -> Docs:
    return FirestoreDocs() if os.environ.get("OPTIONSLAB_FIRESTORE") == "1" else FileDocs()


class Saved:
    """A user's strategies: list, save, rename or change, delete."""

    def __init__(self, docs: Docs):
        self.docs = docs
        self._lock = threading.Lock()

    @staticmethod
    def _check_user(user_id: str) -> str:
        if not USER_ID.match(str(user_id or "")):
            raise InvalidStrategy("Sign in to keep strategies.")
        return user_id

    def list(self, user_id: str) -> list[dict]:
        doc = self.docs.get(self._check_user(user_id)) or {}
        return sorted(doc.get("strategies", []), key=lambda s: s.get("updated_utc", ""), reverse=True)

    @staticmethod
    def clean(body: dict) -> dict:
        if not isinstance(body, dict):
            raise InvalidStrategy("Send a name, a ticker and the legs.")
        name = str(body.get("name") or "").strip()
        if not name:
            raise InvalidStrategy("Give the strategy a name.")
        if len(name) > MAX_NAME:
            raise InvalidStrategy(f"The name can be up to {MAX_NAME} characters.")
        try:
            ticker = normalise_ticker(body.get("ticker", ""))
        except Exception:
            raise InvalidStrategy("The strategy needs a ticker.") from None
        legs = clean_legs(body.get("legs"))
        if any(leg["price"] is None for leg in legs):
            raise InvalidStrategy("Every leg needs the price it was opened at.")
        return {"name": name, "ticker": ticker, "legs": legs}

    def create(self, user_id: str, body: dict) -> dict:
        strategy = self.clean(body)
        with self._lock:
            doc = self.docs.get(self._check_user(user_id)) or {"strategies": []}
            if len(doc["strategies"]) >= MAX_STRATEGIES:
                raise InvalidStrategy(f"Up to {MAX_STRATEGIES} strategies. Delete one to keep this one.")
            strategy |= {"id": secrets.token_hex(6), "created_utc": _now(), "updated_utc": _now()}
            doc["strategies"].append(strategy)
            doc["updated_utc"] = _now()
            self.docs.put(user_id, doc)
        return strategy

    def update(self, user_id: str, strategy_id: str, body: dict) -> dict | None:
        changes = self.clean(body)
        with self._lock:
            doc = self.docs.get(self._check_user(user_id)) or {"strategies": []}
            for s in doc["strategies"]:
                if s["id"] == strategy_id:
                    s |= changes | {"updated_utc": _now()}
                    doc["updated_utc"] = _now()
                    self.docs.put(user_id, doc)
                    return s
        return None

    def delete(self, user_id: str, strategy_id: str) -> bool:
        with self._lock:
            doc = self.docs.get(self._check_user(user_id)) or {"strategies": []}
            kept = [s for s in doc["strategies"] if s["id"] != strategy_id]
            if len(kept) == len(doc["strategies"]):
                return False
            doc["strategies"], doc["updated_utc"] = kept, _now()
            self.docs.put(user_id, doc)
        return True
