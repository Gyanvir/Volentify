"""Core entity endpoints (PRD §10.5) plus citizen incident reports."""

from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status

from ..core import db
from ..core.security import RateLimiter, client_key, current_claims, require_roles, require_session
from ..data.reference import HOTLINES
from ..engines import briefing, intel, live, triage
from ..engines.geo import haversine_km
from ..schemas import (
    Alert, AlertCreate, AvailabilityUpdate, CitizenReport, CitizenReportResponse, Disaster, Evidence,
    Organization, SituationBriefing, Task, TaskCreate, TaskStatusUpdate, Volunteer,
)
from .common import new_code, new_id, now, tag

router = APIRouter(prefix="/api", tags=["entities"])
_report_limiter = RateLimiter(limit=6, window_s=60)


# ─── Disasters ──────────────────────────────────────────────────────────────

@router.get("/disasters", response_model=list[Disaster])
def list_disasters(response: Response, include_closed: bool = False):
    """Incidents from the live hazard feeds (GDACS, USGS, NASA EONET), refreshed at most every 15 minutes."""
    live.ensure_fresh()
    rows, source = db.read(lambda s: s.list_disasters(include_closed))
    tag(response, source)
    return rows


@router.get("/disasters/{disaster_id}")
def disaster_dossier(disaster_id: str, response: Response):
    """Incident dossier: the disaster with its evidence timeline, missions and alerts."""
    def load(store):
        d = store.get_disaster(disaster_id)
        if not d:
            return None
        return {"disaster": d, "evidence": store.list_evidence(d["id"]),
                "tasks": store.list_tasks(disaster_id=d["id"]),
                "alerts": [a for a in store.list_alerts() if a.get("disaster_id") == d["id"]]}

    data, source = db.read(load)
    if not data:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Incident not found")
    tag(response, source)
    return {"disaster": Disaster.model_validate(data["disaster"]),
            "evidence": [Evidence.model_validate(e) for e in data["evidence"]],
            "tasks": [Task.model_validate(t) for t in data["tasks"]],
            "alerts": [Alert.model_validate(a) for a in data["alerts"]]}


@router.get("/disasters/{disaster_id}/briefing", response_model=SituationBriefing)
def disaster_briefing(disaster_id: str, response: Response):
    def load(store):
        d = store.get_disaster(disaster_id)
        return (d, store.list_evidence(d["id"])) if d else (None, [])

    (d, evidence), source = db.read(load)
    if not d:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Incident not found")
    if not evidence:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "No evidence recorded for this incident yet")
    tag(response, source)
    items = [{"id": e["id"], "source": e["source"], "source_type": e["source_type"],
              "timestamp": e["created_at"], "claim_text": e["claim_text"]} for e in evidence]
    return briefing.generate(d["code"], d["title"], d["location"], items)


# ─── Tasks / missions ───────────────────────────────────────────────────────

@router.get("/tasks", response_model=list[Task])
def list_tasks(request: Request, response: Response, status_: Optional[str] = Query(None, alias="status"),
               disaster_id: Optional[str] = None, mine: bool = False):
    assigned = None
    if mine:
        claims = current_claims(request)
        if not claims:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Sign in to see your missions")
        assigned = claims["sub"]
    rows, source = db.read(lambda s: s.list_tasks(status=status_, disaster_id=disaster_id, assigned_to=assigned))
    tag(response, source)
    return rows


@router.post("/tasks", response_model=Task, status_code=status.HTTP_201_CREATED)
def create_task(body: TaskCreate, response: Response,
                claims: dict = Depends(require_roles("INCIDENT_ADMIN", "NGO_MEMBER"))):
    ts = now()
    task = {**body.model_dump(), "id": new_id("tsk"), "code": new_code("TSK"), "status": "OPEN",
            "created_by_id": claims["sub"], "assigned_to_id": None, "created_at": ts, "updated_at": ts}

    def create(store):
        if not store.get_disaster(body.disaster_id):
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Unknown incident")
        return store.create_task(task)

    row, source = db.write(create)
    tag(response, source)
    return row


@router.post("/tasks/{task_id}/accept", response_model=Task)
def accept_task(task_id: str, response: Response, claims: dict = Depends(require_roles("VOLUNTEER"))):
    def accept(store):
        task = store.get_task(task_id)
        if not task:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Mission not found")
        if task["status"] != "OPEN":
            raise HTTPException(status.HTTP_409_CONFLICT, "This mission has already been taken")
        return store.update_task(task_id, {"status": "ASSIGNED", "assigned_to_id": claims["sub"]})

    row, source = db.write(accept)
    tag(response, source)
    return row


@router.patch("/tasks/{task_id}", response_model=Task)
def update_task_status(task_id: str, body: TaskStatusUpdate, response: Response,
                       claims: dict = Depends(require_session)):
    def update(store):
        task = store.get_task(task_id)
        if not task:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Mission not found")
        is_owner = task["assigned_to_id"] == claims["sub"]
        is_command = claims["role"] in {"INCIDENT_ADMIN", "NGO_MEMBER"} and claims.get("verified")
        if not (is_owner or is_command):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the assigned responder or command can update this")
        fields: dict = {"status": body.status}
        if body.status == "OPEN":
            fields["assigned_to_id"] = None
        return store.update_task(task_id, fields)

    row, source = db.write(update)
    tag(response, source)
    return row


# ─── Alerts ─────────────────────────────────────────────────────────────────

@router.get("/alerts", response_model=list[Alert])
def list_alerts(response: Response, limit: int = Query(100, ge=1, le=500)):
    rows, source = db.read(lambda s: s.list_alerts(limit))
    tag(response, source)
    return rows


@router.post("/alerts", response_model=Alert, status_code=status.HTTP_201_CREATED)
def broadcast_alert(body: AlertCreate, response: Response, claims: dict = Depends(require_roles("INCIDENT_ADMIN"))):
    alert = {**body.model_dump(), "id": new_id("alt"), "code": new_code("ALT"), "sender_id": claims["sub"],
             "created_at": now()}
    row, source = db.write(lambda s: s.create_alert(alert))
    tag(response, source)
    return row


# ─── Volunteers & organisations ─────────────────────────────────────────────

@router.get("/volunteers", response_model=list[Volunteer])
def list_volunteers(response: Response, availability: Literal["AVAILABLE", "BUSY", "OFFLINE", "ALL"] = "ALL"):
    rows, source = db.read(lambda s: s.list_volunteers(None if availability == "ALL" else availability))
    tag(response, source)
    return rows


@router.get("/volunteers/me", response_model=Volunteer)
def my_volunteer_profile(response: Response, claims: dict = Depends(require_session)):
    row, source = db.read(lambda s: s.get_volunteer_by_user(claims["sub"]))
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No volunteer profile — complete onboarding as a volunteer")
    tag(response, source)
    return row


@router.post("/volunteer/availability", response_model=Volunteer)
def set_availability(body: AvailabilityUpdate, response: Response, claims: dict = Depends(require_session)):
    def update(store):
        own = store.get_volunteer_by_user(claims["sub"])
        is_command = claims["role"] in {"INCIDENT_ADMIN", "NGO_MEMBER"} and claims.get("verified")
        if not is_command and (not own or own["id"] != body.volunteer_id):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "You can only change your own availability")
        return store.set_availability(body.volunteer_id, body.availability)

    row, source = db.write(update)
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Volunteer not found")
    tag(response, source)
    return row


@router.get("/organizations", response_model=list[Organization])
def list_organizations(response: Response):
    rows, source = db.read(lambda s: s.list_organizations())
    tag(response, source)
    return rows


def _cache_get(key: str, max_age_s):
    try:
        return db.read(lambda s: s.cache_get(key, max_age_s))[0]
    except Exception:  # noqa: BLE001 — a cache miss is never an error
        return None


def _cache_put(key: str, value) -> None:
    try:
        db.write(lambda s: s.cache_put(key, value))
    except Exception:  # noqa: BLE001
        pass


@router.get("/resources")
def emergency_resources(response: Response):
    """National helplines, plus hospitals and relief shelters mapped in OpenStreetMap around active incidents."""
    live.ensure_fresh()
    incidents, source = db.read(lambda s: s.list_disasters())
    tag(response, source)
    facilities = intel.relief_facilities(incidents, _cache_get, _cache_put)
    return {"hotlines": HOTLINES, "hospitals": facilities["hospitals"], "shelters": facilities["shelters"],
            "mode": facilities["mode"], "fetched_at": facilities.get("fetched_at"),
            "attribution": "Facility locations © OpenStreetMap contributors (ODbL)"}


# ─── Citizen incident reports (web counterpart of mesh field reports) ───────

@router.post("/reports", response_model=CitizenReportResponse, status_code=status.HTTP_201_CREATED)
def submit_report(body: CitizenReport, request: Request, response: Response):
    _report_limiter.check(client_key(request))
    result = triage.triage(body.text, body.location)
    claims = current_claims(request)

    def store_report(store):
        disaster = store.get_disaster(body.disaster_id) if body.disaster_id else None
        if disaster is None and body.lat is not None and body.lng is not None:
            nearest = min(store.list_disasters(), default=None,
                          key=lambda d: haversine_km(body.lat, body.lng, d["lat"], d["lng"]))
            if nearest and haversine_km(body.lat, body.lng, nearest["lat"], nearest["lng"]) <= nearest["radius_km"] * 2:
                disaster = nearest
        if disaster is None:
            return None
        store.add_evidence({
            "id": new_id("ev"), "disaster_id": disaster["id"], "author_id": claims["sub"] if claims else None,
            "source": "Citizen report", "source_type": "CITIZEN",
            "claim_text": f"{body.text.strip()} ({body.location.strip()})", "relation": "SUPPORTING",
            "confidence": result["confidence"], "language": result["language"], "created_at": now(),
        })
        return disaster["id"]

    linked, source = db.write(store_report)
    tag(response, source)
    return {"reference": new_code("REP"), "triage": result, "linked_disaster_id": linked, "stored": linked is not None}
