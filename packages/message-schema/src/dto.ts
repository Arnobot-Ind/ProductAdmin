/**
 * Response shapes of the admin REST API (`apps/backend`, `/api/v1`), shared with the admin panel.
 * All timestamps are ISO-8601 UTC strings ending in `Z`. Units are in the field name.
 * Secrets NEVER appear in any of these types (CLAUDE.md rule 11).
 */
import type {
  CredentialKind,
  DocumentType,
  EventSeverity,
  EventType,
  HealthLevel,
  MissionFileKind,
  MissionState,
  ReleaseComponent,
  RobotStatus,
  ScopeType,
} from './constants';
import type { GeoLineString } from './messages';

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

// ── auth / users ────────────────────────────────────────────────────────────
export interface GrantDto {
  id: string;
  role_key: string;
  role_name: string;
  scope_type: ScopeType;
  scope_id: string | null;
  created_at: string;
  revoked_at: string | null;
}
export interface MeDto {
  id: string;
  email: string;
  name: string;
  /** Permission keys the user holds at platform scope (drives UI visibility; the API still enforces). */
  permissions: string[];
  grants: GrantDto[];
}
export interface UserDto {
  id: string;
  email: string;
  name: string;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  deleted_at: string | null;
  grants: GrantDto[];
}
export interface RoleDto {
  id: string;
  key: string;
  name: string;
  description: string | null;
  permissions: string[];
}

// ── catalogue ───────────────────────────────────────────────────────────────
export interface ProductDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  next_running_number: number;
  robot_count: number;
  revision_count: number;
  created_at: string;
  deleted_at: string | null;
}
export interface RevisionComponentDto {
  id: string;
  part_type_key: string;
  part_type_name: string;
  slot: number | null;
  model: string | null;
}
export interface HardwareRevisionDto {
  id: string;
  product_id: string;
  name: string;
  description: string | null;
  components: RevisionComponentDto[];
  robot_count: number;
  created_at: string;
  deleted_at: string | null;
}
export interface PartTypeDto {
  id: string;
  key: string;
  name: string;
  max_per_robot: number | null;
}
export interface CompanyDto {
  id: string;
  name: string;
  created_at: string;
}

// ── robots ──────────────────────────────────────────────────────────────────
export interface DeviceHealthDto {
  controller: HealthLevel | null;
  lidar: HealthLevel | null;
  cameras: HealthLevel | null;
  gps: HealthLevel | null;
}
export interface MissionSummaryDto {
  total_missions: number;
  completed: number;
  failed: number;
  aborted: number;
  in_progress: number;
  total_distance_m: number;
  total_duration_s: number;
  avg_duration_s: number | null;
}
/** Spec §5 view 1 (robot summary) + status columns. */
export interface RobotListItemDto extends MissionSummaryDto {
  robot_id: string;
  serial_number: string;
  product_code: string;
  product_name: string;
  hardware_revision: string | null;
  owner_company: string | null;
  status: RobotStatus;
  last_seen_at: string | null;
  battery_pct: number | null;
  health: DeviceHealthDto;
  current_mission_id: string | null;
  sw_ver: string | null;
  fw_ver: string | null;
  /** Critical events on this robot nobody has acknowledged yet. */
  unacked_critical_events: number;
  created_at: string;
  deleted_at: string | null;
}
export interface RobotDetailDto extends RobotListItemDto {
  product_id: string;
  hardware_revision_id: string | null;
  running_number: number;
  notes: string | null;
  updated_at: string;
  owner_company_id: string | null;
  owner_since: string | null;
}
export interface RobotRegisteredDto {
  robot: RobotDetailDto;
  /** Plaintext ingest key, shown exactly ONCE. Store it on the robot / GCS server. */
  ingest_key: string;
  ingest_client_id: string;
}

export interface LiveStateDto {
  robot_id: string;
  status: RobotStatus;
  last_seen_at: string | null;
  state_ts: string | null;
  position: {
    lat: number;
    lon: number;
    alt_m: number | null;
    fix: string | null;
    hdop: number | null;
    sats: number | null;
    heading_deg: number | null;
    speed_mps: number | null;
  } | null;
  battery: { pct: number | null; voltage_v: number | null; charging: boolean | null };
  signal_dbm: number | null;
  temps_c: { controller: number | null; battery: number | null; motors: Record<string, number> | null };
  armed: boolean | null;
  mode: string | null;
  health: DeviceHealthDto;
  current_mission_id: string | null;
}

export interface OwnershipDto {
  id: string;
  company_id: string;
  company_name: string;
  valid_from: string;
  valid_to: string | null;
  reason: string | null;
  created_by_name: string | null;
  created_at: string;
}

export interface HardwarePartDto {
  id: string;
  part_type_key: string;
  part_type_name: string;
  slot: number | null;
  model: string | null;
  serial_number: string | null;
  fitted_at: string;
  removed_at: string | null;
  removal_reason: string | null;
  maintenance_log_id: string | null;
  notes: string | null;
  created_at: string;
}

export interface SoftwareHistoryDto {
  id: string;
  sw_ver: string | null;
  fw_ver: string | null;
  enabled_features: string[] | null;
  reported_at: string;
  boot_id: string | null;
}
export interface SoftwareDto {
  current: SoftwareHistoryDto | null;
  last_update_at: string | null;
  history: SoftwareHistoryDto[];
}

export interface CameraDto {
  slot: number;
  ip: string | null;
  /** Never contains user:password (enforced by a DB CHECK). */
  stream_url: string | null;
  model: string | null;
}
export interface ConnectivityDto {
  robot_id: string;
  network_address: string | null;
  ssh_ip: string | null;
  cloudflare_tunnel_hostname: string | null;
  omni_ip: string | null;
  wifi_router_ip: string | null;
  gcs_camera_domain: string | null;
  gcs_server_domain: string | null;
  reported_ips: Record<string, string> | null;
  reported_at: string | null;
  updated_at: string | null;
  cameras: CameraDto[];
}

/** Metadata only. The secret itself is returned only by the explicit reveal endpoint. */
export interface CredentialMetaDto {
  id: string;
  kind: CredentialKind;
  slot: number | null;
  label: string | null;
  username: string | null;
  key_version: number;
  created_at: string;
  created_by_name: string | null;
  rotated_from_id: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
}
export interface CredentialRevealDto {
  id: string;
  kind: CredentialKind;
  username: string | null;
  secret: string;
}
export interface IngestKeyDto {
  id: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}
export interface IngestClientDto {
  id: string;
  name: string;
  kind: 'robot' | 'gcs';
  notes: string | null;
  robot_ids: string[];
  keys: IngestKeyDto[];
  created_at: string;
  revoked_at: string | null;
}
/** Returned once when a client or key is created. */
export interface IngestKeyIssuedDto {
  client: IngestClientDto;
  key_id: string;
  /** Plaintext key, shown exactly ONCE. */
  key: string;
}

// ── files / documents ───────────────────────────────────────────────────────
export interface FileDto {
  id: string;
  filename: string;
  content_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  storage_driver: string;
  uploaded_at: string;
  uploaded_by_name: string | null;
}
export interface DocumentVersionDto {
  id: string;
  version_no: number;
  note: string | null;
  file: FileDto;
  uploaded_at: string;
  uploaded_by_name: string | null;
}
export interface DocumentDto {
  id: string;
  doc_type: DocumentType;
  title: string;
  /** Where the document is attached (spec §4: product, revision, or one-off robot). */
  source: 'product' | 'revision' | 'robot';
  product_id: string | null;
  hardware_revision_id: string | null;
  robot_id: string | null;
  source_label: string;
  latest: DocumentVersionDto | null;
  versions: DocumentVersionDto[];
  created_at: string;
  deleted_at: string | null;
}

export interface DispatchWarrantyDto {
  robot_id: string;
  dispatch_date: string | null;
  warranty_start: string | null;
  warranty_end: string | null;
  warranty_document_id: string | null;
  warranty_document: DocumentDto | null;
  warranty_status: 'none' | 'active' | 'expiring' | 'expired';
  notes: string | null;
  updated_at: string | null;
}

export interface MaintenanceDto {
  id: string;
  robot_id: string;
  repaired_at: string;
  description: string;
  part_removed_serial: string | null;
  part_fitted_serial: string | null;
  repaired_by: string;
  hardware_removed_id: string | null;
  hardware_fitted_id: string | null;
  created_at: string;
  created_by_name: string | null;
  deleted_at: string | null;
}

// ── telemetry ───────────────────────────────────────────────────────────────
export interface TelemetrySeriesDto<T> {
  robot_id: string;
  from: string;
  to: string;
  /** Downsampling bucket in seconds; 0 = raw rows. */
  bucket_s: number;
  points: T[];
}
export interface GpsPointDto { ts: string; lat: number; lon: number; alt_m: number | null; speed_mps: number | null; heading_deg: number | null; fix: string | null }
export interface BatteryPointDto { ts: string; pct: number | null; voltage_v: number | null; current_a: number | null; temp_c: number | null }
export interface EncoderPointDto { ts: string; encoder: string; ticks: number | null; velocity_mps: number | null; rpm: number | null }
export interface HealthPointDto extends DeviceHealthDto { ts: string; temp_controller_c: number | null; temp_battery_c: number | null; temp_motors_max_c: number | null }

// ── missions ────────────────────────────────────────────────────────────────
/** Spec §5 view 2. */
export interface MissionListItemDto {
  mission_id: string;
  robot_id: string;
  name: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_s: number | null;
  distance_m: number | null;
  result: MissionState;
  end_reason: string | null;
  file_count: number;
  has_gcs_report: boolean;
}
export interface MissionFileDto {
  id: string;
  kind: MissionFileKind;
  s3_path: string;
  size_bytes: number | null;
  content_type: string | null;
  /** Short-lived link when the file is in PMS storage; null for external S3 paths. */
  download_url: string | null;
  created_at: string;
}
/** Spec §5 view 3. */
export interface MissionDetailDto extends MissionListItemDto {
  planned_path: GeoLineString | null;
  actual_path: GeoLineString | null;
  distance_planned_m: number | null;
  waypoints_total: number | null;
  waypoints_reached: number | null;
  files: MissionFileDto[];
  gcs_report_received_at: string | null;
  created_at: string;
  updated_at: string;
}

// ── events ──────────────────────────────────────────────────────────────────
export interface EventDto {
  id: string;
  msg_id: string | null;
  robot_id: string;
  ts: string;
  type: EventType;
  severity: EventSeverity;
  code: string | null;
  message: string;
  data: Record<string, unknown> | null;
  acknowledged_by_name: string | null;
  acknowledged_at: string | null;
  received_at: string;
}

// ── releases ────────────────────────────────────────────────────────────────
export interface ReleaseDto {
  id: string;
  product_id: string;
  product_code: string;
  component: ReleaseComponent;
  version: string;
  file: FileDto | null;
  sha256: string;
  signature: string;
  signature_algo: string | null;
  requires_component: ReleaseComponent | null;
  requires_min_version: string | null;
  notes: string | null;
  created_at: string;
  created_by_name: string | null;
  deleted_at: string | null;
}

// ── dashboard / realtime ────────────────────────────────────────────
export interface IngestLogItemDto {
  msg_id: string;
  robot_id: string;
  type: string;
  v: number;
  ts: string;
  received_at: string;
  transport: 'https' | 'mqtt';
  client_name: string | null;
  /** Only on GET /ingest/messages/:msgId */
  raw?: unknown;
}
export interface IngestRejectionDto {
  id: number;
  received_at: string;
  msg_id: string | null;
  robot_id: string | null;
  type: string | null;
  error: string;
  details: unknown;
  client_name: string | null;
  raw?: unknown;
}

/** Payloads pushed over Socket.IO (event name `change`). */
export type RealtimeChange =
  | { kind: 'live'; robot_id: string }
  | { kind: 'seen'; robot_id: string }
  | { kind: 'event'; robot_id: string; id: string; severity: EventSeverity }
  | { kind: 'mission'; robot_id: string; mission_id: string }
  | { kind: 'software'; robot_id: string }
  | { kind: 'telemetry'; robot_id: string };
