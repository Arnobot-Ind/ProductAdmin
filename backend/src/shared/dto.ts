/**
 * Response shapes of the admin REST API (`backend/`, `/api/v1`), shared with the admin panel.
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
  /** The organization this login belongs to (Arnobot = internal, customers = customer). */
  organization: { id: string; name: string; kind: OrganizationKind };
  /** Permission keys the user holds at platform scope (drives UI visibility; the API still enforces). */
  permissions: string[];
  /** Permission keys the user holds in ANY scope (platform, organization or robot). A customer user's view. */
  scoped_permissions: string[];
  /** Signed in with a temporary password: the panel sends them to change it first. */
  must_change_password: boolean;
  grants: GrantDto[];
}
export interface UserDto {
  id: string;
  email: string;
  name: string;
  company_id: string;
  company_name: string;
  company_kind: OrganizationKind;
  is_active: boolean;
  /** Invited and has not set a password yet. */
  invite_pending: boolean;
  invite_expires_at: string | null;
  must_change_password: boolean;
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
  /** staff = Arnobot only (Admin); any = Arnobot or a customer organization (Manager, Viewer). */
  audience: 'staff' | 'customer' | 'any';
  permissions: string[];
}
export interface PermissionDto {
  key: string;
  description: string;
}
/** GET /access-model: every role, every permission, and which role holds which (the permission matrix). */
export interface AccessModelDto {
  roles: RoleDto[];
  permissions: PermissionDto[];
}
/** Returned once when a user is created or re-invited. The token is never stored or shown again. */
export interface UserCredentialsDto {
  user: UserDto;
  /** Invitation link (the user sets their own password). */
  invite_url: string | null;
  invite_expires_at: string | null;
  /** Generated temporary password (the user must change it at first sign-in). */
  temporary_password: string | null;
}
export interface InviteInfoDto {
  email: string;
  name: string;
  organization: string;
  expires_at: string;
}

// ── organizations ───────────────────────────────────────────────────────────
export type OrganizationKind = 'internal' | 'customer';
export interface OrganizationDto {
  id: string;
  name: string;
  kind: OrganizationKind;
  contact_name: string | null;
  contact_email: string | null;
  notes: string | null;
  robot_count: number;
  user_count: number;
  created_at: string;
  deleted_at: string | null;
}
export interface OrganizationRobotDto {
  robot_id: string;
  serial_number: string;
  product_name: string;
  assigned_since: string;
  status: RobotStatus;
}
export interface OrganizationDetailDto extends OrganizationDto {
  robots: OrganizationRobotDto[];
  users: UserDto[];
}

// ── audit log ───────────────────────────────────────────────────────────────
export type AuditOutcome = 'success' | 'denied' | 'failure';
export interface AuditEntryDto {
  id: string;
  at: string;
  actor_id: string | null;
  actor_email: string | null;
  actor_name: string | null;
  action: string;
  outcome: AuditOutcome;
  target_type: string | null;
  target_id: string | null;
  robot_id: string | null;
  company_id: string | null;
  company_name: string | null;
  detail: Record<string, unknown>;
  ip: string | null;
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
/** Short organization reference (pickers). */
export interface CompanyDto {
  id: string;
  name: string;
  kind: OrganizationKind;
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
  /** Lifetime odometer (m) reported by the robot. total_distance_m is mission driving only. */
  odometer_m: number | null;
  sw_ver: string | null;
  fw_ver: string | null;
  /** Critical events on this robot nobody has acknowledged yet. */
  unacked_critical_events: number;
  /** Last video / sensor file stored for this robot. */
  last_upload_at: string | null;
  /** A file was stored in the last 2 minutes: the robot is sending data now. */
  sending_data: boolean;
  /** Its cloud_sync heartbeat (under 5 min old) names a recording session. */
  recording: boolean;
  /** Recorded sessions in the archive. */
  video_sessions: number;
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
  /** Lifetime odometer (m) from the robot: all driving, missions or not. */
  odometer_m: number | null;
  odometer_ts: string | null;
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
  /** Product page / datasheet of the part. */
  product_url: string | null;
  created_at: string;
  /** Last correction made in the panel. */
  updated_at: string | null;
  updated_by_name: string | null;
}

export interface SoftwareHistoryDto {
  id: string;
  sw_ver: string | null;
  fw_ver: string | null;
  enabled_features: string[] | null;
  reported_at: string;
  boot_id: string | null;
  /** robot = reported at boot; manual = recorded in the panel by `entered_by_name`. */
  source: 'robot' | 'manual';
  entered_by_name: string | null;
  note: string | null;
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
  distance_planned_m: number | null;
  waypoints_total: number | null;
  waypoints_reached: number | null;
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
/** One waypoint of a mission, from the GCS report (null when the GCS did not send them). */
export interface MissionWaypointDto {
  sequence: number;
  label: string | null;
  lat: number;
  lng: number;
  reached: boolean;
  reached_at: string | null;
}
export interface MissionDetailDto extends MissionListItemDto {
  waypoints: MissionWaypointDto[] | null;
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
export interface DashboardDto {
  robots_total: number;
  by_status: Record<RobotStatus, number>;
  unacked_critical_events: number;
  unacked_events: number;
  robots_with_fault: { robot_id: string; devices: string[] }[];
  missions_last_7d: { completed: number; failed: number; aborted: number; in_progress: number };
  recent_missions: MissionListItemDto[];
  recent_events: EventDto[];
  messages_last_24h: number;
  warranty_expiring: { robot_id: string; warranty_end: string }[];
  /** Every robot the user may see, with its last position (fleet map). */
  fleet: {
    robot_id: string;
    product_name: string;
    status: RobotStatus;
    lat: number | null;
    lon: number | null;
    battery_pct: number | null;
    last_seen_at: string | null;
    faults: string[];
  }[];
}

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

// ── video / sensor archive (merged from Saibya Archive) ────────────────────
/**
 * active      — recording now (heartbeat names it, or uploads within the interrupted window)
 * closed      — session.json marked ended
 * interrupted — never ended and nothing uploaded for ARCHIVE_INTERRUPTED_AFTER_MINUTES (power / network lost)
 */
export type ArchiveSessionStatus = 'active' | 'closed' | 'interrupted';
/** complete = _COMPLETE.json stored (every file uploaded); uploading = stopped, upload still running; unknown = older cloud_sync. */
export type ArchiveUploadState = 'complete' | 'uploading' | 'unknown';

export interface ArchiveSessionDto {
  /** Stable id used in admin URLs. */
  id: string;
  robot_id: string;
  product_code: string;
  product_name: string;
  /** Stored under <robot>/sim/sessions/ (bench simulation). */
  sim: boolean;
  session_id: string;
  trip: string | null;
  status: ArchiveSessionStatus;
  upload: ArchiveUploadState;
  started_at: string | null;
  ended_at: string | null;
  duration_s: number | null;
  /** Nominal camera segment length (s). */
  video_segment_s: number;
  /** Manifest says the data is synthetic. */
  simulated: boolean;
  cameras: string[];
  has_lidar: boolean;
  has_imu: boolean;
  has_gps: boolean;
  has_encoder: boolean;
  file_count: number;
  bytes: { camera: number; sensors: number; meta: number; total: number };
  /** Bytes per sensor stream (for download size estimates). */
  sensor_bytes: { lidar: number; imu: number; gps: number; encoder: number };
  last_upload_at: string | null;
  /** Deleted (hidden) recordings are listed only for users who may restore them. */
  deleted_at: string | null;
}

export interface ArchiveCameraDto {
  name: string;
  /** Segments in time order: start epoch ms, duration seconds (for the synced player). */
  segments: { start_ms: number; duration_s: number }[];
  bytes: number;
  seconds: number;
  /** HLS VOD playlist over the .ts segments. */
  playlist_url: string;
  /** The whole camera as one MP4 (plays on Windows, macOS, phones). Built on first request. */
  mp4_url: string;
  mp4_download_url: string;
}

export interface ArchiveFileDto {
  name: string;
  kind: 'camera' | 'sensors' | 'meta';
  camera: string | null;
  sensor: 'lidar' | 'imu' | 'gps' | 'encoder' | null;
  chunk_start: string | null;
  size_bytes: number;
  uploaded_at: string;
  url: string;
  download_url: string;
}

/** What the signed-in user may do with one recording (the API enforces the same rules). */
export interface ArchiveAccessDto {
  /** LiDAR / IMU are shown at all (Admin). Without it the lidar / imu streams come back as not available. */
  sensors: boolean;
  /** Camera video (MP4 / .ts), session.json, upload log. */
  download: boolean;
  /** Raw LiDAR / IMU chunks (restricted sensor data). */
  download_restricted: boolean;
  delete: boolean;
}

/**
 * Availability of one data stream. The shape is always present, whatever was uploaded:
 *   available   — files exist
 *   missing     — the robot did not upload this stream (placeholder in the panel)
 */
export interface ArchiveStreamDto {
  available: boolean;
  files: number;
  bytes: number;
  /** Why it is missing, in words for the placeholder. null when available. */
  reason: string | null;
}

export interface ArchiveSessionDetailDto {
  session: ArchiveSessionDto;
  manifest: Record<string, unknown> | null;
  cameras: ArchiveCameraDto[];
  files: ArchiveFileDto[];
  /** One entry per stream, always all four keys (missing streams included). */
  streams: { video: ArchiveStreamDto; lidar: ArchiveStreamDto; imu: ArchiveStreamDto; gps: ArchiveStreamDto; encoder: ArchiveStreamDto; metadata: ArchiveStreamDto };
  /** This recording as one zip (add &include=video,imu,gps,lidar,encoder,meta and &cameras=cam1 to narrow it). */
  zip_url: string;
  access: ArchiveAccessDto;
  /** MP4 export needs ffmpeg on the backend host. */
  mp4_available: boolean;
  interrupted_after_min: number;
  deleted_at: string | null;
  delete_reason: string | null;
}

/** Why a sensor preview could not be drawn (stable codes for the panel's placeholder). */
export type SensorPreviewProblem = 'missing' | 'unreadable' | 'storage_unavailable' | 'too_large';

/** IMU preview: every chunk read, merged and down-sampled for charts. */
export interface ImuPreviewDto {
  status: 'ok' | 'partial' | 'unavailable';
  problem: SensorPreviewProblem | null;
  message: string | null;
  chunks_total: number;
  chunks_read: number;
  chunks_failed: { name: string; error: string }[];
  samples_total: number;
  /** Down-sampled rows: t_ms (epoch), accel m/s², gyro °/s, attitude °. Columns missing from the CSV are null. */
  columns: string[];
  rows: (number | null)[][];
}

/** LiDAR preview of one chunk: a few scans spread over its time span, down-sampled for a polar plot. */
export interface LidarPreviewDto {
  status: 'ok' | 'unavailable';
  problem: SensorPreviewProblem | null;
  message: string | null;
  chunk: string | null;
  chunks: string[];
  scans_total: number;
  points_total: number;
  /** Each scan: t_ms and points as [angle_deg (body frame, 0 = front, clockwise), range_m]. */
  scans: { t_ms: number; points: [number, number][] }[];
  max_range_m: number;
}

export interface ArchiveAlertDto {
  code: string | null;
  severity: string | null;
  message: string | null;
}

/** The robot's upload link, from cloud_sync's heartbeat and the last stored file. */
export interface ArchiveRobotLinkDto {
  robot_id: string;
  last_seen_at: string | null;
  last_upload_at: string | null;
  /** Session the heartbeat says is recording (null when idle or the heartbeat is stale). */
  recording_session_id: string | null;
  pending_files: number;
  pending_bytes: number;
  alerts: ArchiveAlertDto[];
  /** A file was stored in the last 2 minutes. */
  sending_data: boolean;
}

export interface RobotArchiveDto {
  link: ArchiveRobotLinkDto | null;
  sessions: ArchiveSessionDto[];
}

export interface ArchiveSessionListDto extends Paginated<ArchiveSessionDto> {
  totals: { sessions: number; active: number; bytes: number; video_bytes: number };
}

export interface ArchiveReindexDto {
  robots: { robot_id: string; sessions: number; skipped: number; files: number; rejected: number }[];
  ignored_prefixes: string[];
}

// ── system status (Settings page) ──────────────────────────────────────────
export interface SystemStatusDto {
  checked_at: string;
  server: { ok: true; version: string; node: string; started_at: string; uptime_s: number; port: number; environment: string };
  database: {
    ok: boolean;
    latency_ms: number | null;
    version: string | null;
    name: string | null;
    size_bytes: number | null;
    migrations: { applied: number; pending: number; latest: string | null };
    error: string | null;
  };
  storage: {
    documents: { ok: boolean; driver: string; detail: string | null };
    archive: { ok: boolean; driver: string; location: string; detail: string | null };
  };
  ffmpeg: { available: boolean; version: string | null };
  mqtt: { configured: boolean; connected: boolean | null };
  robots: { total: number; online: number; stale: number; offline: number; sending_data: number; recording: number };
  archive: { sessions: number; files: number; bytes: number; last_upload_at: string | null };
}

/** Payloads pushed over Socket.IO (event name `change`). */
export type RealtimeChange =
  | { kind: 'live'; robot_id: string }
  | { kind: 'seen'; robot_id: string }
  | { kind: 'event'; robot_id: string; id: string; severity: EventSeverity }
  | { kind: 'mission'; robot_id: string; mission_id: string }
  | { kind: 'software'; robot_id: string }
  | { kind: 'telemetry'; robot_id: string }
  | { kind: 'archive'; robot_id: string; session_id: string };
