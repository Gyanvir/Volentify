/** API contracts — mirror api/_lib/schemas.py. */

export type Role = 'CITIZEN' | 'VOLUNTEER' | 'NGO_MEMBER' | 'RESEARCHER' | 'INCIDENT_ADMIN';
export type Severity = 'CRITICAL' | 'HIGH' | 'MODERATE' | 'LOW';
export type TaskStatus = 'OPEN' | 'ASSIGNED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';
export type Availability = 'AVAILABLE' | 'BUSY' | 'OFFLINE';
export type SourceType = 'OFFICIAL' | 'NEWS' | 'SOCIAL' | 'SENSOR' | 'CITIZEN';
export type MeshPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type MeshEventType =
  | 'PERSON_RESCUED' | 'PERSON_MISSING' | 'PERSON_TRAPPED' | 'MEDICAL_EMERGENCY' | 'FIRE' | 'FLOOD'
  | 'RESOURCE_REQUEST' | 'VOLUNTEER_STATUS' | 'DISASTER_STATUS';
export type ReviewStatus = 'UNREVIEWED' | 'REVIEWED' | 'PROMOTED';
export type DataSource = 'database' | 'fallback' | 'memory' | 'request';

export interface Disaster {
  id: string; code: string; title: string; category: string; severity: Severity;
  lat: number; lng: number; location: string; state: string; radius_km: number;
  polygon_geojson: GeoJSON.Polygon | GeoJSON.MultiPolygon | null; status: string;
  affected_pop: string | null; summary: string; wind_speed_kmh: number | null;
  rainfall_mm: number | null; surge_meters: number | null; org_id: string | null;
  created_at: string; updated_at: string;
  /** Live feed the incident came from (GDACS, USGS, NASA EONET) and the source's own page. */
  source: string | null; source_url: string | null; external_id: string | null;
}

export interface Evidence {
  id: string; disaster_id: string; author_id: string | null; source: string; source_type: SourceType;
  claim_text: string; relation: string; confidence: number; language: string; created_at: string;
}

export interface Task {
  id: string; code: string; title: string; description: string | null; urgency: Severity;
  required_skill: string; lat: number; lng: number; location_name: string; quantity_needed: number;
  status: TaskStatus; disaster_id: string; created_by_id: string; assigned_to_id: string | null;
  created_at: string; updated_at: string;
}

export interface Alert {
  id: string; code: string; title: string; category: string; level: Severity; location: string;
  state: string; description: string; advisory: string; disaster_id: string | null;
  sender_id: string | null; created_at: string;
}

export interface Volunteer {
  id: string; user_id: string | null; name: string; skills: string[]; lat: number; lng: number;
  location_name: string; availability: Availability; verified: boolean; missions_done: number;
  total_hours: number; equipment: string[]; badge_level: string; response_rate: number; active_missions: number;
}

export interface Organization {
  id: string; name: string; category: string; state: string; district: string;
  contact_email: string; contact_phone: string; registration_no: string | null; verified: boolean;
}

export interface MusterPass {
  code: string; title: string; role: Role; holder: string; issued_at: string; signature: string;
}

export interface User {
  id: string; name: string; email: string; phone: string; role: Role; state_district: string | null;
  lat: number | null; lng: number | null; provider: string; avatar_url: string | null;
  blood_group: string | null; emergency_contact: string | null; is_verified: boolean; onboarded: boolean;
  org_id: string | null; profile_data: Record<string, unknown>; muster: MusterPass | null; created_at: string;
}

export interface AuthResponse { user: User; requiresOnboarding: boolean }

export interface MeshEvent {
  id: string; event_id: string; origin_node_id: string; disaster_id: string | null; type: MeshEventType;
  priority: MeshPriority; payload: Record<string, unknown>; lat: number | null; lng: number | null;
  observed_at: string; hop_count: number; ttl: number; received_at: string; review_status: ReviewStatus;
  promoted_task_id: string | null;
}

export interface MeshNode {
  id: string; node_uuid: string; volunteer_id: string | null; last_lat: number | null; last_lng: number | null;
  battery_level: number | null; last_seen_at: string; active: boolean; created_at: string;
}

export interface Prediction {
  hazard_probability: number; risk_level: 'CRITICAL' | 'HIGH' | 'MODERATE'; predicted_surge_m: number;
  confidence_score: number; model: string; latency_ms: number; features: Record<string, number>;
  wind_24h_kmh: number | null; severe_probability: number | null;
}

export interface ModelCard {
  name: string; version: string; trained_at: string; evaluation: string; features: string[];
  data: { source: string; storms: number; fixes: number; first: string; last: string };
  targets: Record<string, string>;
  metrics: {
    folds: number;
    intensity_24h: { n: number; mae_kt_with_history: number; mae_kt_single_report: number; mae_kt_persistence: number; skill_vs_persistence: number | null };
    severe_24h: { n: number; base_rate: number; threshold_kt: number; auc_with_history: number | null; auc_single_report: number | null;
      brier_with_history: number; brier_climatology: number; brier_skill_score: number | null; auc_below_threshold: number | null; accuracy_at_0_5: number };
  };
}

export interface Triage {
  disaster_type: string; severity: Severity; urgency_score: number; confidence: number; latency_ms: number;
  language: string; tier: 'laya-local' | 'impossibl-hosted' | 'deterministic';
  flags: { trapped_civilians: boolean; medical_emergency: boolean; food_water_needed: boolean; road_blocked: boolean };
  needs: string[]; trapped_count: number | null;
}

export interface Briefing {
  event_id: string; event_label: string; severity: string; confidence: number; supporting_count: number;
  conflicting_count: number; duplicate_count: number; needs: string[]; checklist: string[]; brief: string;
  engine: 'gemini' | 'heuristic';
}

export interface RankedMatch {
  volunteer_id: string; name: string; score: number; distance_km: number; skill_match: number;
  scarcity: number; squander_penalised: boolean; reason: string;
}

export interface Assignment {
  task_id: string; task_code: string; task_title: string; urgency: Severity; slot: number;
  volunteer_id: string; volunteer_name: string; score: number; distance_km: number;
  tier: 'EXACT' | 'ADJACENT' | 'GENERIC'; reason: string;
}

export interface DispatchResult {
  assignments: Assignment[];
  bottlenecks: { task_id: string; task_code: string; skill: string; requested: number; filled: number; deficit: number }[];
  scarcity: Record<string, number>; tiers: Record<'EXACT' | 'ADJACENT' | 'GENERIC', number>;
  completeness: number; latency_ms: number; tasks_evaluated: number; volunteers_evaluated: number;
}

/** Facilities mapped in OpenStreetMap near an active incident. Capacity fields are null unless mapped. */
interface Facility_ {
  id: string; name: string; address: string; lat: number; lng: number; osm_url: string;
  incident_id: string; incident_title: string; distance_km: number;
}
export interface Hospital extends Facility_ {
  kind: string; beds: number | null; phone: string; emergency: boolean;
  icu_beds: number | null; icu_available: number | null; trauma_level: string | null;
}
export interface Shelter extends Facility_ {
  kind: string; capacity: number | null; occupancy: number | null; facilities: string[]; incharge: string | null;
}
export interface Resources {
  hotlines: { label: string; number: string }[]; hospitals: Hospital[]; shelters: Shelter[];
  mode: 'LIVE' | 'OFFLINE' | 'NO_INCIDENTS'; fetched_at: string | null; attribution: string;
}

export interface Dossier { disaster: Disaster; evidence: Evidence[]; tasks: Task[]; alerts: Alert[] }

export interface Facility {
  name: string; type: string; lat: number; lng: number; distance_km: number; status: string; osm_id: number | null;
}

export interface ImageryLayer {
  id: string; label: string; short?: string; provider: string; tiles: string[]; max_zoom: number; cadence: string;
  dynamic?: string; date?: string;
}

export interface Bulletin {
  title: string; description: string; link: string | null; source: string; severity: Severity; published_at: string;
  category?: string; event?: string | null; expires_at?: string | null; area?: string | null; instruction?: string | null;
}

/** NDMA SACHET feed: LIVE from SACHET, CACHED from Volentify's archive when SACHET is down, OFFLINE when neither. */
export interface BulletinFeed { source: string; mode: 'LIVE' | 'CACHED' | 'OFFLINE'; items: Bulletin[] }

export interface Health {
  status: string; system: string; version: string; database: 'ONLINE' | 'DEGRADED' | 'FALLBACK';
  ml_inference: string; inference_selftest_ms: number;
}
