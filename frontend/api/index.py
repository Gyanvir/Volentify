"""Volentify API — FastAPI application.

Local:      uvicorn api.index:app --reload --port 8000   (run from frontend/)
Production: Vercel Python serverless function; vercel.json rewrites /api/* here.
"""

import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import FastAPI, Request  # noqa: E402
from fastapi.exceptions import RequestValidationError  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402

from api._lib.core import db  # noqa: E402
from api._lib.core.config import get_settings  # noqa: E402
from api._lib.core.security import RateLimiter  # noqa: E402
from api._lib.engines import gemini, live, surge, triage  # noqa: E402
from api._lib.routers import auth, entities, intelligence, mesh, research  # noqa: E402

VERSION = "3.5.0"
_probe_limiter = RateLimiter(limit=20, window_s=3600)

app = FastAPI(title="Volentify Disaster Intelligence API", version=VERSION,
              docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)

for module in (auth, entities, mesh, intelligence, research):
    app.include_router(module.router)


@app.exception_handler(RequestValidationError)
async def validation_error(_: Request, exc: RequestValidationError):
    """Flatten pydantic errors into one readable sentence plus field details."""
    errors = exc.errors()
    first = errors[0] if errors else {}
    field = ".".join(str(p) for p in first.get("loc", [])[1:]) or "request"
    message = str(first.get("msg", "Invalid request")).removeprefix("Value error, ")
    return JSONResponse(status_code=422, content={"detail": f"{field}: {message}", "errors": [
        {"field": ".".join(str(p) for p in e.get("loc", [])[1:]), "message": e.get("msg")} for e in errors]})


@app.get("/api/health")
def health(deep: bool = False, gemini_model: str | None = None):
    started = time.perf_counter()
    surge.predict({"lat": 19.81, "lng": 85.83, "wind_speed": 140.0, "rainfall_mm": 250.0})
    triage.deterministic("flood people trapped need boat")
    inference_ms = round((time.perf_counter() - started) * 1000, 3)
    database = db.database_status()
    body = {
        "status": "ONLINE",
        "system": "VOLENTIFY DISASTER INTELLIGENCE PLATFORM",
        "version": VERSION,
        "database": database,
        "ml_inference": "ONLINE",
        "inference_selftest_ms": inference_ms,
    }
    if database == "DEGRADED":
        body["database_error"] = db.last_error()
    body["live_feeds"] = live.last_sync()
    settings = get_settings()
    # Which variables the deployment is actually using — names and sources only, never values.
    body["configuration"] = {
        "database_variable": settings.database_url_var or None,
        "session_key": settings.session_secret_source,
        "google_sign_in": bool(settings.google_client_id),
        "gemini": bool(settings.gemini_api_key),
        "public_url": settings.public_url or None,
    }
    if deep:
        if gemini_model:
            _probe_limiter.check("gemini-probe")
            if not re.fullmatch(r"[a-z0-9.\-]{3,60}", gemini_model):
                gemini_model = None
        body["gemini"] = gemini.probe(gemini_model)
    return body
