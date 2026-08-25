"""The dashboard server: serves the page, and writes saves to BigQuery.

Why a server exists at all, given the rest of this is a static page:

A browser cannot write to BigQuery. Doing so needs Google credentials, and any
credential shipped to a browser is a credential you have published — on a public
page it is readable by anyone, and even on a private one it leaves your machine.
So the Save button posts here instead, and this process talks to BigQuery using
whatever credentials the machine already has (``gcloud auth
application-default login``). Nothing secret is ever sent to the page.

Locally that means: run this, open the page, work, hit Save. There is nothing to
deploy and nothing to pay for. The same app runs on Cloud Run unchanged if you
ever want it hosted — set ``API_TOKEN`` and ``HOST=0.0.0.0`` and it will demand
that token on every write.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import auth, bigquery_store
from .config import settings

logger = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parents[2]
WEB_DIR = ROOT / "web"
DATA_DIR = ROOT / "data"

app = FastAPI(title="NFL 2026 Projections", docs_url=None, redoc_url=None)


def require_identity(authorization: str | None) -> str:
    """Identify a caller allowed to write, or refuse with a reason they can act on."""
    try:
        return auth.authorize(authorization)
    except auth.AuthError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


@app.get("/api/healthz")
def healthz() -> dict[str, Any]:
    return {
        "ok": True,
        "bigquery_enabled": settings.bigquery_enabled,
        "table": settings.table_id if settings.bigquery_enabled else None,
    }


@app.get("/api/config")
def client_config() -> dict[str, Any]:
    """What the page needs to know before it can offer to sign anyone in.

    The client id is deliberately public — it names the app to Google and is
    useless without a matching account on the allow list. The allow list itself
    is never served: who may write is the server's business.
    """
    return {
        "google_client_id": settings.google_client_id,
        "auth_required": auth.auth_required(),
        "bigquery_enabled": settings.bigquery_enabled,
    }


@app.get("/api/baseline")
def baseline() -> FileResponse:
    path = DATA_DIR / "baseline.json"
    if not path.exists():
        raise HTTPException(
            status_code=503,
            detail="baseline.json has not been built — run "
            "`python -m projections.build_baseline`",
        )
    return FileResponse(path, media_type="application/json")


@app.post("/api/projections")
def save_projections(
    payload: dict[str, Any] = Body(...),
    authorization: str | None = Header(default=None),
) -> JSONResponse:
    identity = require_identity(authorization)
    if not settings.bigquery_enabled:
        raise HTTPException(
            status_code=503,
            detail="BigQuery saving is turned off (BIGQUERY_ENABLED=false).",
        )
    try:
        result = bigquery_store.save(payload)
    except bigquery_store.StoreError as exc:
        # The browser has the projection in local storage either way, so a failed
        # save is recoverable — say what went wrong rather than returning a 500.
        logger.warning("save failed: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    logger.info(
        "saved %s rows as %s for %s", result["rows"], result["save_id"], identity
    )
    return JSONResponse(result)


@app.get("/api/projections/saves")
def saves(
    limit: int = 25, authorization: str | None = Header(default=None)
) -> dict[str, Any]:
    require_identity(authorization)
    if not settings.bigquery_enabled:
        return {"saves": [], "bigquery_enabled": False}
    try:
        return {"saves": bigquery_store.list_saves(limit=limit), "bigquery_enabled": True}
    except bigquery_store.StoreError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/projections/latest")
def latest(
    save_id: str | None = None, authorization: str | None = Header(default=None)
) -> dict[str, Any]:
    require_identity(authorization)
    if not settings.bigquery_enabled:
        return {"rows": [], "bigquery_enabled": False}
    try:
        return {"rows": bigquery_store.load(save_id), "bigquery_enabled": True}
    except bigquery_store.StoreError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/")
def index() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")


# Mounted last so the API routes above win. The baseline is served from /data so
# the page works when opened directly off the filesystem too, without the server.
app.mount("/data", StaticFiles(directory=DATA_DIR), name="data")
app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")


def main() -> int:
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    if not (DATA_DIR / "baseline.json").exists():
        logger.warning(
            "data/baseline.json is missing — run `python -m projections.build_baseline`"
        )
    logger.info("dashboard on http://%s:%s", settings.host, settings.port)
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
