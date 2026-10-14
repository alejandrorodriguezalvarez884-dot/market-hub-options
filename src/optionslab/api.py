"""The service: the site and the API, from one origin.

    GET    /api/health
    GET    /api/me                      who is signed in to Market Hub, and the hub's address
    GET    /api/search?q=               tickers that match a name or a symbol
    GET    /api/underlying/{ticker}     price, rate, realised volatility and the expirations
    GET    /api/chain/{ticker}?expiry=  one expiration's chain, every contract read in detail
    GET    /api/terms/{ticker}          every expiration side by side
    POST   /api/strategy                a strategy read as a whole: payoff, greeks, odds
    GET    /api/strategies              the strategies the user keeps
    POST   /api/strategies              keep one
    PUT    /api/strategies/{id}         change one
    DELETE /api/strategies/{id}         delete one

Everything else is the static site, when OPTIONSLAB_STATIC_DIR points at its build.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.requests import Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .chain import Chains
from .hubauth import HubGate
from .hubauth import settings as hub_settings
from .market import Market, NotFound, Unavailable, normalise_ticker
from .saved import Docs, Saved, default_docs
from .strategy import InvalidStrategy, analyse

log = logging.getLogger("optionslab.api")

UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}
# Without Market Hub's sign-in (a local run) everything saved belongs to one local user.
LOCAL_USER = {"id": "local", "email": "", "name": "Local", "picture": ""}


def create_app(market: Market | None = None, docs: Docs | None = None, static_dir: str | None = None,
               hub: tuple[str, str] | None | bool = True) -> FastAPI:
    """App factory. Tests pass their own market and documents, so they need no network.

    ``hub`` is (hub URL, hub session secret) to admit only people signed in to Market Hub; by
    default it comes from HUB_URL and HUB_SESSION_SECRET, and None leaves the service open."""
    logging.basicConfig(level=logging.INFO)
    # yfinance prints what Yahoo answers for a symbol it does not know; httpx logs every address.
    for noisy in ("httpx", "httpcore", "yfinance"):
        logging.getLogger(noisy).setLevel(logging.CRITICAL if noisy == "yfinance" else logging.WARNING)
    app = FastAPI(title="Options Lab", docs_url=None, redoc_url=None, openapi_url=None)

    origins = [o.strip() for o in os.environ.get("OPTIONSLAB_ALLOWED_ORIGINS", "").split(",") if o.strip()]

    @app.middleware("http")
    async def same_site_writes(request: Request, call_next):
        """Writes must come from this site: a foreign page can neither send the hub's cookie on a
        POST (SameSite=Lax) nor pass this check."""
        if request.method in UNSAFE and request.url.path.startswith("/api/"):
            origin = request.headers.get("origin")
            host = request.headers.get("x-forwarded-host") or request.headers.get("host", "")
            if origin not in {f"{request.url.scheme}://{request.url.netloc}", f"https://{host}", *origins}:
                return JSONResponse({"detail": "Cross-site request refused."}, status_code=403)
        response = await call_next(request)
        if request.url.path.startswith("/api/") and "cache-control" not in response.headers:
            response.headers["Cache-Control"] = "no-store"
        return response

    if origins:
        app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST", "PUT", "DELETE"],
                           allow_headers=["*"], allow_credentials=True)
    hub = hub_settings() if hub is True else hub or None
    if hub:
        app.add_middleware(HubGate, hub_url=hub[0], secret=hub[1])

    market = market or Market()
    chains = Chains(market)
    saved = Saved(docs or default_docs())

    def user_of(request: Request) -> dict:
        user = getattr(request.state, "user", None)
        if user:
            return user
        if hub:
            raise HTTPException(401, "Sign in to Market Hub to use this tool.")
        return LOCAL_USER

    def ticker_of(raw: str) -> str:
        try:
            return normalise_ticker(raw)
        except NotFound as exc:
            raise HTTPException(404, str(exc)) from None

    def answer(read):
        try:
            return read()
        except NotFound as exc:
            raise HTTPException(404, str(exc)) from None
        except Unavailable as exc:
            raise HTTPException(503, str(exc)) from None
        except InvalidStrategy as exc:
            raise HTTPException(400, str(exc)) from None

    @app.get("/api/health")
    def health() -> dict:
        return {"ok": True}

    @app.get("/api/me")
    def me(request: Request) -> dict:
        return {"user": getattr(request.state, "user", None), "hub": hub[0] if hub else None}

    @app.get("/api/search")
    def search(q: str = Query(min_length=1, max_length=40)) -> dict:
        return {"results": market.search(q.strip())}

    @app.get("/api/underlying/{ticker}")
    def underlying(ticker: str) -> dict:
        return answer(lambda: chains.underlying(ticker_of(ticker)))

    @app.get("/api/chain/{ticker}")
    def chain(ticker: str, expiry: str = Query(pattern=r"^\d{4}-\d{2}-\d{2}$")) -> dict:
        return answer(lambda: chains.chain(ticker_of(ticker), expiry))

    @app.get("/api/terms/{ticker}")
    def terms(ticker: str) -> dict:
        return answer(lambda: chains.terms(ticker_of(ticker)))

    @app.post("/api/strategy")
    def strategy(ticker: str = Body(), legs: list = Body(), at: str | None = Body(default=None),
                 iv_shift: float = Body(default=0.0)) -> dict:
        return answer(lambda: analyse(chains, ticker_of(ticker), legs, at=at, iv_shift=iv_shift))

    @app.get("/api/strategies")
    def strategies(request: Request) -> dict:
        return answer(lambda: {"strategies": saved.list(user_of(request)["id"])})

    @app.post("/api/strategies")
    def keep(request: Request, body: dict = Body()) -> dict:
        return answer(lambda: saved.create(user_of(request)["id"], body))

    @app.put("/api/strategies/{strategy_id}")
    def change(request: Request, strategy_id: str, body: dict = Body()) -> dict:
        found = answer(lambda: saved.update(user_of(request)["id"], strategy_id, body))
        if not found:
            raise HTTPException(404, "There is no such strategy.")
        return found

    @app.delete("/api/strategies/{strategy_id}")
    def delete(request: Request, strategy_id: str) -> dict:
        if not answer(lambda: saved.delete(user_of(request)["id"], strategy_id)):
            raise HTTPException(404, "There is no such strategy.")
        return {"deleted": True}

    static_dir = static_dir or os.environ.get("OPTIONSLAB_STATIC_DIR", "")
    if static_dir and Path(static_dir).is_dir():
        app.mount("/", StaticFiles(directory=static_dir, html=True), name="site")
    return app
