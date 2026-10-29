/**
 * Spec-fixed value sets and thresholds. Sections refer to docs/spec/robot-record-spec.md.
 * Lists that can grow as data (products, part types) are DB rows, NOT constants here.
 */

/** Current robot message format version (spec §6 `v`). Older versions stay accepted. */
export const MESSAGE_FORMAT_VERSION = 1;
export const SUPPORTED_MESSAGE_VERSIONS = [1] as const;

export const MESSAGE_TYPES = ['hello', 'live', 'telemetry', 'event', 'mission', 'detection'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** What kind of robot a product is: ground (UGV) or aerial (UAV). Every product is one of the two (0025). */
export const ROBOT_CATEGORIES = ['ugv', 'uav'] as const;
export type RobotCategory = (typeof ROBOT_CATEGORIES)[number];
export const ROBOT_CATEGORY_LABEL: Record<RobotCategory, string> = { ugv: 'UGV', uav: 'UAV' };

/** Spec §7: computed from last-seen time, never stored. */
export const STATUS_THRESHOLDS = {
  /** last seen < 60 s → online */
  onlineMs: 60_000,
  /** 60 s … 5 min → stale; more → offline */
  staleMs: 5 * 60_000,
} as const;
export const ROBOT_STATUSES = ['online', 'stale', 'offline'] as const;
export type RobotStatus = (typeof ROBOT_STATUSES)[number];

/** Spec §7 reporting cadence. */
export const REPORT_INTERVAL_MS = 30_000;

export const HEALTH_LEVELS = ['ok', 'warning', 'fault'] as const;
export type HealthLevel = (typeof HEALTH_LEVELS)[number];
/** Spec §3 row 10: device health is reported for these devices. */
export const HEALTH_DEVICES = ['controller', 'lidar', 'cameras', 'gps'] as const;
export type HealthDevice = (typeof HEALTH_DEVICES)[number];

/** Known GNSS fix qualities. Unknown strings are accepted and stored as-is. */
export const KNOWN_FIX_QUALITIES = ['none', '2d', '3d', 'dgps', 'rtk_float', 'rtk_fixed'] as const;

/** Spec §3 row 13. */
export const EVENT_TYPES = ['abort', 'rth', 'alert', 'fault', 'update'] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export const EVENT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type EventSeverity = (typeof EVENT_SEVERITIES)[number];

/** Spec §5 view 1 counts completed / failed / aborted. `in_progress` = started, no end yet. */
export const MISSION_RESULTS = ['completed', 'failed', 'aborted'] as const;
export type MissionResult = (typeof MISSION_RESULTS)[number];
export const MISSION_STATES = [...MISSION_RESULTS, 'in_progress'] as const;
export type MissionState = (typeof MISSION_STATES)[number];
export const MISSION_FILE_KINDS = ['video', 'mcap', 'image', 'lidar', 'other'] as const;
export type MissionFileKind = (typeof MISSION_FILE_KINDS)[number];

/** Spec §3 row 6: kinds of secret stored in robot_credentials. */
export const CREDENTIAL_KINDS = [
  'cloudflare',
  'camera_admin',
  'camera_operator',
  'camera_rtsp_url',
  'ssh',
  'ssh_public_key',
  'omni',
  'wifi_router',
  'gcs_login',
  'gcs_api_token',
] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];
/** How an SSH credential's secret is used (0025). */
export const SSH_AUTH_METHODS = ['password', 'private_key'] as const;
export type SshAuthMethod = (typeof SSH_AUTH_METHODS)[number];
/** Kinds that exist once per camera slot (1–4). */
export const PER_CAMERA_CREDENTIAL_KINDS: readonly CredentialKind[] = ['camera_admin', 'camera_operator', 'camera_rtsp_url'];

/** Spec §3 row 7 + §8. */
export const DOCUMENT_TYPES = [
  'circuit_diagram',
  'pinout',
  'bom',
  'manual',
  'component_list',
  'warranty_clauses',
  'other',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** Sources merged into a robot's activity log (GET /robots/:robotId/log), in filter-chip order. */
export const ROBOT_LOG_KINDS = ['note', 'event', 'mission', 'hardware', 'maintenance', 'software', 'ownership', 'document', 'audit', 'rejection', 'message'] as const;
export type RobotLogKind = (typeof ROBOT_LOG_KINDS)[number];

/**
 * Product media (0025): photos shown on the robot page, one 3D model (.glb) of the product, and a 360° view:
 * a series of photos taken all around the robot, shown in order as you drag.
 */
export const PRODUCT_MEDIA_KINDS = ['photo', 'model_3d', 'spin'] as const;
export type ProductMediaKind = (typeof PRODUCT_MEDIA_KINDS)[number];

/** Robot log severity filter: what each choice matches in RobotLogEntryDto.level. */
export const LOG_LEVEL_GROUPS = { critical: ['critical', 'fault', 'error'], warning: ['warning'], info: ['info', 'ok'] } as const;
export type LogLevelGroup = keyof typeof LOG_LEVEL_GROUPS;

/** Spec §9. */
export const RELEASE_COMPONENTS = ['software', 'firmware'] as const;
export type ReleaseComponent = (typeof RELEASE_COMPONENTS)[number];

/** Spec §12. */
export const SCOPE_TYPES = ['platform', 'company', 'site', 'robot'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

/**
 * Ingest timestamp guard. A robot clock that is far ahead would freeze live_state
 * (rule 7: only newer ts overwrites), so such messages are rejected. The Jetson has no RTC,
 * so a clock before this floor means "NTP not synced yet".
 */
export const INGEST_MAX_FUTURE_SKEW_MS = 5 * 60_000;
export const INGEST_MIN_VALID_TS = '2024-01-01T00:00:00.000Z';
/** Max envelopes accepted in one HTTPS batch. */
export const INGEST_MAX_BATCH = 500;

/** Client admin (0021): a customer organization's status. Only these two may sign in to the client app. */
export const CLIENT_STATUSES = ['onboarding', 'active', 'suspended', 'ended'] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];
export const CLIENT_SIGN_IN_STATUSES: readonly ClientStatus[] = ['onboarding', 'active'];

/** Client app features (client_features rows). The client app's nav and the API both check these keys. */
export const CLIENT_FEATURES = {
  robotsView: 'portal.robots.view',
  robotsLocation: 'portal.robots.location',
  missionsView: 'portal.missions.view',
  reportsView: 'portal.reports.view',
  reportsDownload: 'portal.reports.download',
  telemetryView: 'portal.telemetry.view',
  eventsView: 'portal.events.view',
  softwareView: 'portal.software.view',
  detectionsView: 'portal.detections.view',
} as const;

/** What a camera detection is about (detections.kind, 0022). */
export const DETECTION_KINDS = ['human', 'wildlife', 'fire', 'vegetation'] as const;
export type DetectionKind = (typeof DETECTION_KINDS)[number];
/** What the robot itself reports (`detection` message); vegetation comes only from imports. */
export const ROBOT_DETECTION_KINDS = ['human', 'wildlife', 'fire'] as const;
/** Largest detection snapshot accepted (annotated JPEG, ~100–300 KB in practice). */
export const DETECTION_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const DETECTION_STATUSES = ['confirmed', 'rejected'] as const;
export type DetectionStatus = (typeof DETECTION_STATUSES)[number];

export const SOFTWARE_KINDS = ['desktop_app', 'web_app', 'robot_software', 'firmware', 'service'] as const;
export type SoftwareKind = (typeof SOFTWARE_KINDS)[number];

/** Kinds of secret Arnobot holds for a client (client_credentials). Robot secrets are CREDENTIAL_KINDS. */
export const CLIENT_CREDENTIAL_KINDS = ['gcs_login', 'gcs_api_token', 'portal', 'camera', 'wifi', 'vpn', 'cloud', 'email', 'other'] as const;
export type ClientCredentialKind = (typeof CLIENT_CREDENTIAL_KINDS)[number];
