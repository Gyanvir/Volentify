"""API acceptance tests (PRD §14). Run from frontend/: python -m pytest tests -q"""

import json
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from api._lib.core import db  # noqa: E402
from api._lib.core.config import get_settings  # noqa: E402
from api._lib.engines import dispatch, surge, triage  # noqa: E402
from api._lib.routers import auth, entities, mesh  # noqa: E402
from api.index import app  # noqa: E402
import fixtures  # noqa: E402


@pytest.fixture(autouse=True)
def clean_state(monkeypatch):
    from api._lib.core.config import DATABASE_URL_VARS
    for name in DATABASE_URL_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("VOLENTIFY_ENV", "test")
    monkeypatch.setenv("NEXTAUTH_SECRET", "test-secret-that-is-at-least-32-bytes-long")
    monkeypatch.setenv("VOLENTIFY_ADMIN_EMAILS", "chief@ndrf.gov.in")
    monkeypatch.setenv("VOLENTIFY_OFFLINE", "1")  # no outbound feed calls from tests
    get_settings.cache_clear()
    db.MEMORY.reset()
    db.MEMORY.load(fixtures.DATASET)  # fictional test dataset — the app itself ships none
    db._state["down_until"] = 0.0
    db._pg = None
    for limiter in (auth._login_limiter, entities._report_limiter, mesh._ingest_limiter, mesh._public_ingest_limiter):
        limiter._hits.clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def client():
    return TestClient(app)


def signup(client, email, role="VOLUNTEER", skills=("Boat Rescue",)):
    r = client.post("/api/auth/register", json={"name": "Test User", "email": email, "password": "s3cure-pass!"})
    assert r.status_code == 201, r.text
    assert r.json()["requiresOnboarding"] is True
    r = client.post("/api/auth/onboard", json={
        "phone": "+91 98765 43210", "role": role, "state_district": "Puri, Odisha", "lat": 19.81, "lng": 85.83,
        "skills": list(skills), "profile": {"blood_group": "O+"}})
    assert r.status_code == 200, r.text
    return r.json()["user"]


def mesh_event(**over):
    base = {"event_id": str(uuid.uuid4()), "origin_node_id": str(uuid.uuid4()), "disaster_id": "dis_remal_puri",
            "type": "PERSON_TRAPPED", "priority": "CRITICAL", "payload": {"count": 4},
            "lat": 19.81, "lng": 85.83, "observed_at": datetime.now(timezone.utc).isoformat(),
            "hop_count": 2, "ttl": 3}
    base.update(over)
    return base


# ─── health & entities ──────────────────────────────────────────────────────

def test_health_reports_fallback_without_database(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ONLINE" and body["database"] == "FALLBACK"


def test_entity_lists_serve_fallback_dataset(client):
    for path in ("/api/disasters", "/api/tasks", "/api/alerts", "/api/volunteers", "/api/organizations"):
        r = client.get(path)
        assert r.status_code == 200 and len(r.json()) > 0, path
        assert r.headers["X-Data-Source"] == "memory"


def test_disaster_dossier_and_briefing(client):
    dossier = client.get("/api/disasters/CYC-2026-REMAL").json()
    assert dossier["disaster"]["id"] == "dis_remal_puri" and dossier["evidence"] and dossier["tasks"]
    brief = client.get("/api/disasters/dis_remal_puri/briefing").json()
    assert brief["conflicting_count"] >= 1 and brief["supporting_count"] >= 3
    assert len(brief["brief"].split()) <= 151


# ─── auth & onboarding ──────────────────────────────────────────────────────

def test_register_onboard_issues_muster_pass(client):
    user = signup(client, "asha@example.org")
    assert user["onboarded"] and user["phone"] == "9876543210"
    assert user["muster"]["code"].startswith("TAC-VOL-")
    me = client.get("/api/auth/me").json()
    assert me["requiresOnboarding"] is False
    assert client.get("/api/volunteers/me").json()["skills"] == ["Boat Rescue"]


def test_onboarding_rejects_invalid_phone(client):
    client.post("/api/auth/register", json={"name": "X Y", "email": "x@example.org", "password": "s3cure-pass!"})
    r = client.post("/api/auth/onboard", json={"phone": "12345", "role": "CITIZEN", "state_district": "Delhi"})
    assert r.status_code == 422 and "10-digit" in r.json()["detail"]


def test_login_wrong_password(client):
    signup(client, "b@example.org")
    assert client.post("/api/auth/login", json={"email": "b@example.org", "password": "nope-nope"}).status_code == 401
    assert client.post("/api/auth/login", json={"email": "b@example.org", "password": "s3cure-pass!"}).status_code == 200


def test_elevated_roles_need_verification(client):
    signup(client, "ngo@example.org", role="NGO_MEMBER")
    r = client.post("/api/tasks", json={"title": "Pack kits", "required_skill": "Manual Packing", "lat": 20.2,
                                        "lng": 86.6, "disaster_id": "dis_remal_puri"})
    assert r.status_code == 403 and "verification" in r.json()["detail"]


def test_rbac_blocks_citizen_broadcast(client):
    signup(client, "c@example.org", role="CITIZEN")
    r = client.post("/api/alerts", json={"title": "Test alert", "category": "Flood", "location": "Puri",
                                         "state": "Odisha", "description": "Testing broadcast", "advisory": "Stay safe now"})
    assert r.status_code == 403


def test_admin_allowlist_can_broadcast(client):
    signup(client, "chief@ndrf.gov.in", role="INCIDENT_ADMIN")
    r = client.post("/api/alerts", json={"title": "Evacuate now", "category": "Cyclone", "level": "CRITICAL",
                                         "location": "Puri", "state": "Odisha", "description": "Surge expected",
                                         "advisory": "Move to shelters"})
    assert r.status_code == 201 and r.json()["code"].startswith("ALT-")


# ─── mesh (AT-06 … AT-09) ───────────────────────────────────────────────────

def gateway(client):
    signup(client, f"gw-{uuid.uuid4().hex[:6]}@example.org")
    return {"Authorization": f"Bearer {client.post('/api/mesh/token').json()['token']}"}


def test_ingest_accepts_phones_without_token_but_rejects_bad_tokens(client):
    """Any phone that reaches the internet uploads; a token is optional, but a bad one is refused."""
    batch = {"gateway_node_id": str(uuid.uuid4()), "events": [mesh_event(disaster_id=None)]}
    r = client.post("/api/mesh/ingest", json=batch)
    assert r.status_code == 200 and r.json()["accepted_count"] == 1
    bad = client.post("/api/mesh/ingest", json=batch, headers={"Authorization": "Bearer nope"})
    assert bad.status_code == 401


def test_ingested_reports_become_incident_evidence(client):
    """A report without an incident is linked to the active incident it falls inside and joins its timeline."""
    ev = mesh_event(disaster_id=None, type="FLOOD", priority="HIGH", lat=19.85, lng=85.8,
                    payload={"notes": "Water entering houses near the embankment", "needs": ["boats"]})
    r = client.post("/api/mesh/ingest", json={"gateway_node_id": str(uuid.uuid4()), "events": [ev]})
    assert r.status_code == 200
    stored = next(e for e in client.get("/api/mesh/events").json() if e["event_id"] == ev["event_id"])
    assert stored["disaster_id"] == "dis_remal_puri"
    evidence = client.get("/api/disasters/dis_remal_puri").json()["evidence"]
    mesh = [e for e in evidence if e["source"] == "Volentify Mesh"]
    assert mesh and "Water entering houses" in mesh[0]["claim_text"] and mesh[0]["source_type"] == "CITIZEN"
    trapped = mesh_event(disaster_id=None, lat=19.85, lng=85.8, payload={"count": 4, "notes": "Ravi's family, 2nd floor"})
    client.post("/api/mesh/ingest", json={"gateway_node_id": str(uuid.uuid4()), "events": [trapped]})
    texts = [e["claim_text"] for e in client.get("/api/disasters/dis_remal_puri").json()["evidence"]]
    assert not any("Ravi" in t for t in texts) and any("1–5 people" in t for t in texts)


def test_ingest_is_idempotent(client):
    headers = gateway(client)
    batch = {"gateway_node_id": str(uuid.uuid4()), "events": [mesh_event(), mesh_event(priority="LOW")]}
    first = client.post("/api/mesh/ingest", json=batch, headers=headers).json()
    assert first["accepted_count"] == 2 and first["duplicate_count"] == 0 and first["persistence"] == "volatile"
    replay = client.post("/api/mesh/ingest", json=batch, headers=headers).json()
    assert replay["accepted_count"] == 0 and replay["duplicate_count"] == 2


@pytest.mark.parametrize("override", [
    {"payload": {"blob": "x" * 5000}}, {"ttl": 6}, {"lat": 19.8, "lng": None}, {"lat": 120.0},
    {"type": "ALIEN_INVASION"}, {"priority": "URGENT"},
])
def test_ingest_validation(client, override):
    headers = gateway(client)
    r = client.post("/api/mesh/ingest", json={"gateway_node_id": str(uuid.uuid4()),
                                              "events": [mesh_event(**override)]}, headers=headers)
    assert r.status_code == 422


def test_ingest_batch_limit(client):
    headers = gateway(client)
    r = client.post("/api/mesh/ingest", json={"gateway_node_id": str(uuid.uuid4()),
                                              "events": [mesh_event() for _ in range(101)]}, headers=headers)
    assert r.status_code == 422


def test_null_gps_is_accepted(client):
    headers = gateway(client)
    r = client.post("/api/mesh/ingest", json={"gateway_node_id": str(uuid.uuid4()),
                                              "events": [mesh_event(lat=None, lng=None)]}, headers=headers)
    assert r.status_code == 200 and r.json()["accepted_count"] == 1


def test_events_redacted_for_public(client):
    events = client.get("/api/mesh/events").json()
    trapped = next(e for e in events if e["type"] == "PERSON_TRAPPED")
    assert trapped["payload"].get("redacted") is True


def test_events_filters_and_nodes(client):
    crit = client.get("/api/mesh/events", params={"priority": "CRITICAL"}).json()
    assert crit and all(e["priority"] == "CRITICAL" for e in crit)
    nodes = client.get("/api/mesh/nodes").json()
    assert any(n["active"] for n in nodes) and any(not n["active"] for n in nodes)
    incidents = client.get("/api/mesh/incidents").json()
    assert incidents and len(incidents[0]["bbox"]) == 4


def test_admin_promotes_mesh_report(client):
    signup(client, "chief@ndrf.gov.in", role="INCIDENT_ADMIN")
    event_id = "d4a1b8c2-3e5f-4a7b-9c1d-2e4f6a8b0c2e"
    r = client.patch(f"/api/mesh/events/{event_id}", json={"action": "PROMOTE"})
    assert r.status_code == 200 and r.json()["review_status"] == "PROMOTED"
    task_id = r.json()["promoted_task_id"]
    assert any(t["id"] == task_id for t in client.get("/api/tasks").json())


def test_ingest_refuses_volatile_ack_when_database_down(client, monkeypatch):
    headers = gateway(client)
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@127.0.0.1:1/none?pgbouncer=true")
    get_settings.cache_clear()
    db._pg = None
    r = client.post("/api/mesh/ingest", json={"gateway_node_id": str(uuid.uuid4()), "events": [mesh_event()]},
                    headers=headers)
    assert r.status_code == 503 and r.headers["Retry-After"] == "30"
    reads = client.get("/api/disasters")
    assert reads.status_code == 200 and reads.headers["X-Data-Source"] == "fallback"
    assert client.get("/api/health").json()["database"] == "DEGRADED"


# ─── engines ────────────────────────────────────────────────────────────────

def test_dispatch_protects_rare_specialists(client):
    result = client.post("/api/match/dispatch-batch").json()
    assert result["latency_ms"] < 50 and result["tasks_evaluated"] > 0
    by_task = {}
    for a in result["assignments"]:
        by_task.setdefault(a["task_code"], []).append(a)
    # Critical boat rescue goes to boat specialists, and specialists are never spent on kit packing
    # while generic responders are available.
    packing = by_task.get("TSK-003", [])
    assert packing and all(a["volunteer_name"] in {"Anita Patel", "Manoj Nayak"} for a in packing[:2])
    order = [a["urgency"] for a in result["assignments"]]
    assert order == sorted(order, key=dispatch.URGENCY_RANK.get)
    assert any(b["task_code"] == "TSK-003" for b in result["bottlenecks"]) or len(packing) == 4


def test_specialist_tasks_never_get_untrained_responders():
    task = {"id": "t", "code": "T", "title": "Triage", "urgency": "CRITICAL", "required_skill": "Paramedic",
            "lat": 20.0, "lng": 85.0, "quantity_needed": 1, "status": "OPEN"}
    vols = [{"id": "v", "name": "Packer", "skills": ["Manual Packing"], "lat": 20.0, "lng": 85.0,
             "availability": "AVAILABLE"}]
    result = dispatch.dispatch_batch([task], vols)
    assert result["assignments"] == [] and result["bottlenecks"][0]["deficit"] == 1


def test_squander_penalty_applied():
    pool = dispatch.skill_pool([{"skills": ["Paramedic"]}, {"skills": ["Manual Packing"]}])
    task = {"urgency": "LOW", "required_skill": "Manual Packing", "lat": 0, "lng": 0}
    medic = dispatch.score(task, {"skills": ["Paramedic"], "lat": 0, "lng": 0}, pool, 0)
    packer = dispatch.score(task, {"skills": ["Manual Packing"], "lat": 0, "lng": 0}, pool, 0)
    assert medic.squander and not packer.squander and packer.score > medic.score * 50


def test_laya_hindi_flood():
    r = triage.triage("बाढ़ से लोग फंसे हैं, नाव चाहिए", "Assam", "hi")
    assert r["disaster_type"] == "Flood" and r["severity"] == "CRITICAL" and r["urgency_score"] == 5
    assert r["flags"]["trapped_civilians"] and "Boats" in r["needs"] and r["language"] == "hi"
    assert r["tier"] == "deterministic" and r["latency_ms"] < 35


def test_laya_english_and_counts():
    r = triage.triage("Building collapse in Kangra, 12 people trapped, two injured, need ambulance")
    assert r["disaster_type"] == "Collapse" and r["trapped_count"] == 12 and r["flags"]["medical_emergency"]


def test_laya_api_endpoint(client):
    r = client.post("/api/triage/laya", json={"text": "Heavy flood, villagers need drinking water and food"})
    body = r.json()
    assert r.status_code == 200 and body["flags"]["food_water_needed"] and body["severity"] == "HIGH"


def test_surge_model_thresholds(client):
    remal = client.post("/api/predict", json={"lat": 19.8135, "lng": 85.8312, "district": "Puri",
                                              "state": "Odisha", "wind_speed": 142.0, "rainfall_mm": 285.0}).json()
    assert remal["risk_level"] == "CRITICAL" and remal["predicted_surge_m"] > 2.5
    inland = surge.predict({"lat": 28.61, "lng": 77.21, "wind_speed": 18.0, "rainfall_mm": 0.0})
    assert inland["risk_level"] == "MODERATE" and inland["predicted_surge_m"] < 0.05
    assert inland["features"]["x6_coast_distance_km"] > 500


def test_event_dedup_clusters(client):
    now = datetime.now(timezone.utc)
    reports = [
        {"id": "r1", "text": "Heavy flooding in Guwahati, water above danger mark", "source": "NDMA",
         "timestamp": (now - timedelta(minutes=50)).isoformat()},
        {"id": "r2", "text": "Guwahati villages submerged after flood, SDRF deployed", "source": "News",
         "timestamp": (now - timedelta(minutes=10)).isoformat()},
        {"id": "r3", "text": "Cyclone approaching Puri coast at 145 km/h", "source": "IMD",
         "timestamp": now.isoformat()},
    ]
    events = client.post("/api/events/ingest", json=reports).json()
    assert len(events) == 2
    flood = next(e for e in events if e["disaster_type"] == "Flood")
    assert sorted(flood["report_ids"]) == ["r1", "r2"] and flood["location"] == "Guwahati"


def test_citizen_report_links_to_incident(client):
    r = client.post("/api/reports", json={"text": "Family of 5 trapped on roof, water rising fast",
                                          "location": "Paradip", "lat": 20.26, "lng": 86.67})
    body = r.json()
    assert r.status_code == 201 and body["linked_disaster_id"] == "dis_remal_puri" and body["stored"]
    assert body["triage"]["severity"] == "CRITICAL"


def test_validation_errors_are_readable(client):
    r = client.post("/api/predict", json={"lat": 999, "lng": 0, "wind_speed": 1, "rainfall_mm": 1})
    assert r.status_code == 422 and r.json()["detail"].startswith("lat:")
    json.dumps(r.json())


def test_database_url_aliases_and_derived_session_key(client, monkeypatch):
    """Vercel's Neon integration may name the variable DB_URL; sessions must survive a missing NEXTAUTH_SECRET."""
    monkeypatch.setenv("VOLENTIFY_ENV", "production")
    monkeypatch.delenv("NEXTAUTH_SECRET", raising=False)
    monkeypatch.setenv("DB_URL", "postgresql://u:p@127.0.0.1:1/neondb?sslmode=require")
    get_settings.cache_clear()
    settings = get_settings()
    assert settings.database_url_var == "DB_URL"
    assert settings.session_secret_source == "derived" and len(settings.session_secret) == 64
    body = client.get("/api/health").json()
    assert body["configuration"]["database_variable"] == "DB_URL"
    assert body["configuration"]["session_key"] == "derived"
    assert "p@" not in str(body)


def test_missing_secret_breaks_only_sign_in(client, monkeypatch):
    monkeypatch.setenv("VOLENTIFY_ENV", "production")
    monkeypatch.delenv("NEXTAUTH_SECRET", raising=False)
    get_settings.cache_clear()
    assert client.get("/api/health").status_code == 200
    assert client.get("/api/disasters").status_code == 200
    r = client.post("/api/auth/register", json={"name": "A B", "email": "a@b.co", "password": "longpassword1"})
    assert r.status_code == 503


def test_research_archive_records_forecasts_and_snapshots(client, monkeypatch):
    from api._lib.core import research
    from api._lib.engines import intel
    from api._lib.routers import research as research_router
    research._memory.clear()
    research_router._collect_limiter._hits.clear()

    async def fake_feed(limit=40):
        items = [{"title": "Heavy rain warning", "description": "Orange alert", "link": "x", "source": "IMD",
                  "severity": "HIGH", "published_at": "2026-11-01T00:00:00+00:00"}]
        research.record_many("cap_alert", "NDMA SACHET", [(research.fingerprint("a"), i) for i in items])
        return {"source": "NDMA SACHET CAP feed", "mode": "LIVE", "items": items}

    monkeypatch.setattr(intel, "sachet_bulletins", fake_feed)
    client.post("/api/predict", json={"lat": 19.8, "lng": 85.8, "wind_speed": 150, "rainfall_mm": 200})
    r = client.post("/api/research/collect")
    assert r.status_code == 200 and r.json()["cap_feed_mode"] == "LIVE"
    client.post("/api/research/collect")  # same alert again is not archived twice
    kinds = client.get("/api/research/summary").json()["kinds"]
    assert kinds["forecast"]["count"] == 1 and kinds["cap_alert"]["count"] == 1
    assert kinds["platform_snapshot"]["count"] == 2
    assert client.get("/api/research/export").status_code == 401


def test_localhost_public_url_ignored_in_production(client, monkeypatch):
    monkeypatch.setenv("VOLENTIFY_ENV", "production")
    monkeypatch.setenv("NEXTAUTH_URL", "http://localhost:3000")
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "abc.apps.googleusercontent.com")
    get_settings.cache_clear()
    r = client.get("/api/auth/google/start", headers={"x-forwarded-host": "volentify.vercel.app",
                                                      "x-forwarded-proto": "https"}, follow_redirects=False)
    assert r.status_code == 302
    assert "redirect_uri=https%3A%2F%2Fvolentify.vercel.app%2Fauth%2Fcallback" in r.headers["location"]


def test_gemini_switches_from_retired_model(monkeypatch):
    import httpx
    from api._lib.engines import gemini
    monkeypatch.setenv("GEMINI_API_KEY", "AIzaTest")
    monkeypatch.setenv("GEMINI_MODEL", "gemini-2.5-flash")
    get_settings.cache_clear()
    gemini._state.update(model=None, last_error=None)
    calls = []

    def fake_post(url, **kw):
        calls.append(url)
        if "gemini-2.5-flash" in url:
            return httpx.Response(404, json={"error": {"message": "no longer available"}})
        return httpx.Response(200, json={"candidates": [{"content": {"parts": [{"text": "ready"}]}}]})

    def fake_get(url, **kw):
        return httpx.Response(200, request=httpx.Request("GET", url), json={"models": [
            {"name": "models/gemini-3.8-flash", "supportedGenerationMethods": ["generateContent"]},
            {"name": "models/gemini-3.8-flash-lite", "supportedGenerationMethods": ["generateContent"]},
            {"name": "models/gemini-3.1-flash", "supportedGenerationMethods": ["generateContent"]},
            {"name": "models/gemini-4.0-flash-preview", "supportedGenerationMethods": ["generateContent"]},
            {"name": "models/text-embedding-9", "supportedGenerationMethods": ["embedContent"]}]})

    monkeypatch.setattr(gemini.httpx, "post", fake_post)
    monkeypatch.setattr(gemini.httpx, "get", fake_get)
    assert gemini.generate_text("hi") == "ready"
    assert gemini._state["model"] == "gemini-3.8-flash"
    assert gemini.probe()["ok"] and gemini.probe()["model"] == "gemini-3.8-flash"
    gemini._state.update(model=None)


# ─── real data only (no built-in demo dataset) ──────────────────────────────

def test_app_ships_no_sample_data(client):
    db.MEMORY.reset()
    for path in ("/api/disasters", "/api/tasks", "/api/alerts", "/api/volunteers", "/api/organizations",
                 "/api/mesh/events", "/api/mesh/nodes"):
        r = client.get(path)
        assert r.status_code == 200 and r.json() == [], path
    res = client.get("/api/resources").json()
    assert res["hospitals"] == [] and res["shelters"] == [] and res["hotlines"]
    feed = client.get("/api/bhuvan/bulletins").json()
    assert feed["items"] == [] and feed["mode"] == "OFFLINE"


GDACS_SAMPLE = {"type": "FeatureCollection", "features": [
    {"geometry": {"type": "Point", "coordinates": [81.8, 13.5]}, "properties": {
        "eventtype": "TC", "eventid": 1001346, "episodeid": 5, "eventname": "MURASU-26", "name": "Tropical Cyclone MURASU-26",
        "alertlevel": "Green", "episodealertlevel": "Green", "iscurrent": "true", "country": "India",
        "fromdate": "2026-11-01T00:00:00", "todate": "2026-11-02T00:00:00", "datemodified": "2026-11-02T01:00:00",
        "affectedcountries": [{"iso2": "IN", "iso3": "IND", "countryname": "India"}],
        "severitydata": {"severity": 111.1104, "severitytext": "Tropical Storm (maximum wind speed of 111 km/h)",
                         "severityunit": "km/h"},
        "url": {"report": "https://www.gdacs.org/report.aspx?eventid=1001346&episodeid=5&eventtype=TC"}}},
    {"geometry": {"type": "Point", "coordinates": [141.7, 22.3]}, "properties": {
        "eventtype": "TC", "eventid": 1001343, "eventname": "IN-FA-26", "alertlevel": "Green", "iscurrent": "true",
        "country": "Marshall Islands", "fromdate": "2026-10-25T06:00:00", "todate": "2026-11-02T00:00:00",
        "affectedcountries": [], "severitydata": {"severity": 240.7, "severityunit": "km/h"}, "url": {}}},
]}
USGS_SAMPLE = {"type": "FeatureCollection", "features": [
    {"id": "us7000tty7", "geometry": {"type": "Point", "coordinates": [91.6593, 13.3785, 10]}, "properties": {
        "mag": 5.1, "place": "218 km NNW of Bamboo Flat, India", "time": 1793263782448, "updated": 1793321469188,
        "url": "https://earthquake.usgs.gov/earthquakes/eventpage/us7000tty7", "felt": 1, "alert": None,
        "status": "reviewed", "tsunami": 0, "magType": "mb", "type": "earthquake"}}]}
EONET_SAMPLE = {"events": [
    {"id": "EONET_25729", "title": "Tropical Cyclone Murasu", "categories": [{"id": "severeStorms"}],
     "sources": [{"id": "JTWC", "url": "https://www.metoc.navy.mil/jtwc/products/io0226.tcw"}],
     "geometry": [{"magnitudeValue": 35.0, "magnitudeUnit": "kts", "date": "2026-10-31T18:00:00Z", "type": "Point",
                   "coordinates": [84.3, 12.6]},
                  {"magnitudeValue": 60.0, "magnitudeUnit": "kts", "date": "2026-11-01T18:00:00Z", "type": "Point",
                   "coordinates": [82.0, 13.4]}]},
    {"id": "EONET_9999", "title": "Wildfire in Uttarakhand", "categories": [{"id": "wildfires"}], "sources": [],
     "geometry": [{"date": "2026-11-01T06:00:00Z", "type": "Point", "coordinates": [79.0, 30.0]}]},
]}


def test_live_feed_parsers_keep_regional_recent_events():
    from api._lib.engines import live
    now = datetime(2026, 11, 2, 3, 0, tzinfo=timezone.utc)
    gdacs = live.parse_gdacs(GDACS_SAMPLE, now)
    assert [g["title"] for g in gdacs] == ["Cyclone Murasu"]  # the Pacific typhoon is outside the region
    murasu = gdacs[0]
    assert murasu["severity"] == "HIGH" and murasu["wind_speed_kmh"] == 111.1 and murasu["source"] == "GDACS"
    assert murasu["code"] == "GDACS-TC-1001346" and murasu["source_url"].startswith("https://www.gdacs.org/")
    quake = live.parse_usgs(USGS_SAMPLE, now)[0]
    assert quake["category"] == "Earthquake" and quake["severity"] == "MODERATE" and quake["state"] == "India"
    assert quake["created_at"].year == 2026
    eonet = live.parse_eonet(EONET_SAMPLE, now)
    assert {e["category"] for e in eonet} == {"Cyclone", "Wildfire"}
    merged = live.merge(gdacs + [quake] + eonet)  # EONET's copy of Murasu is dropped in favour of GDACS
    assert sorted(i["source"] for i in merged) == ["GDACS", "NASA EONET", "USGS"]
    assert all(i["category"] != "Cyclone" or i["source"] == "GDACS" for i in merged)


def test_live_sync_upserts_then_closes_dropped_incidents(client, monkeypatch):
    from api._lib.engines import live
    db.MEMORY.reset()
    now = datetime.now(timezone.utc)
    incidents = live.merge(live.parse_gdacs(GDACS_SAMPLE, now) + live.parse_usgs(USGS_SAMPLE, now))
    feeds = {"rows": incidents}
    monkeypatch.setattr(live, "offline", lambda: False)
    monkeypatch.setattr(live, "fetch_all", lambda now=None: (feeds["rows"], {s: "ok" for s in live.SOURCES}))
    assert live.ensure_fresh(force=True)["refreshed"]
    rows = client.get("/api/disasters").json()
    assert {r["source"] for r in rows} == {"GDACS", "USGS"}
    dossier = client.get(f"/api/disasters/{rows[0]['id']}").json()
    assert dossier["evidence"] and dossier["evidence"][0]["source_type"] == "OFFICIAL"
    feeds["rows"] = [i for i in incidents if i["source"] == "GDACS"]  # USGS no longer lists the quake
    live.ensure_fresh(force=True)
    assert {r["source"] for r in client.get("/api/disasters").json()} == {"GDACS"}
    closed = client.get("/api/disasters", params={"include_closed": True}).json()
    assert any(r["status"] == "CLOSED" and r["source"] == "USGS" for r in closed)


def test_cap_message_parsing_prefers_english():
    from api._lib.engines import intel
    xml = b"""<?xml version="1.0"?><alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">
      <identifier>IN-1</identifier><sender>Andhra-Pradesh-SDMA</sender>
      <info><language>TL</language><event>Cyclone</event><severity>Severe</severity><headline>x</headline></info>
      <info><language>en-IN</language><event>Cyclone</event><severity>Severe</severity>
        <expires>2026-11-03T07:20:00+05:30</expires><headline>Heavy rain due to Severe Cyclone Murasu</headline>
        <instruction>Please follow SDMA guidelines.</instruction><area><areaDesc>heavy_rainfall_2026-11-02</areaDesc></area>
      </info></alert>"""
    cap = intel.parse_cap(xml)
    assert cap["headline"].startswith("Heavy rain") and cap["severity"] == "HIGH" and cap["event"] == "Cyclone"
    assert cap["expires_at"].utcoffset().total_seconds() == 19800 and cap["area"] == "heavy rainfall 2026-11-02"


def test_health_explains_degraded_database(client, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:secretpw@127.0.0.1:1/none?sslmode=disable")
    get_settings.cache_clear()
    db._pg = None
    body = client.get("/api/health").json()
    assert body["database"] == "DEGRADED" and body["database_error"].startswith("OperationalError")
    assert "secretpw" not in str(body) and "127.0.0.1" not in str(body)
