/**
 * Where every kind of data lives.
 *
 *   SQL      PostgreSQL tables: structured records, small, queried and joined (robots, missions, the video INDEX…)
 *   Non-SQL  Object storage (S3 buckets / a folder): large binary files, stored as-is and streamed
 *            (camera video, LiDAR/IMU chunks, documents). The SQL tables only point at them.
 *
 * `npm run status` checks every entry below.
 */

export interface SqlArea {
  area: string;
  what: string;
  tables: string[];
}

export const SQL_AREAS: SqlArea[] = [
  { area: 'Access', what: 'Organizations (companies), sites, users, roles, permissions, login sessions', tables: ['companies', 'sites', 'users', 'roles', 'permissions', 'role_permissions', 'role_grants', 'sessions'] },
  { area: 'Catalogue', what: 'Products, hardware revisions, part types', tables: ['products', 'hardware_revisions', 'part_types', 'hardware_revision_components'] },
  {
    area: 'Robots',
    what: 'Robot ID + 8-digit serial, ownership, hardware, software, connectivity, cameras, dispatch, maintenance',
    tables: ['robots', 'company_assignment_history', 'site_assignment_history', 'hardware_fitted', 'software_history', 'connectivity', 'robot_cameras', 'dispatch_warranty', 'maintenance_log'],
  },
  { area: 'Secrets', what: 'Device credentials (AES-256-GCM encrypted) and ingest keys (SHA-256 only)', tables: ['robot_credentials', 'ingest_clients', 'ingest_client_robots', 'ingest_keys'] },
  { area: 'Live data', what: 'Live state, events, missions, received messages', tables: ['live_state', 'events', 'missions', 'mission_files', 'ingested_messages', 'ingest_rejections'] },
  { area: 'Telemetry', what: 'GPS, encoder, battery and health time series', tables: ['telemetry_gps', 'telemetry_encoder', 'telemetry_battery', 'telemetry_health'] },
  { area: 'Documents', what: 'Document records and versions (the files themselves are in document storage)', tables: ['files', 'documents', 'document_versions', 'releases'] },
  { area: 'Video index', what: 'Recording sessions, trips and one row per stored file (the video itself is in the S3 bucket)', tables: ['archive_sessions', 'archive_trips', 'archive_files', 'archive_robot_link'] },
  { area: 'Audit', what: 'Append-only audit log: sign-ins, data access and downloads, robot assignments, permission changes', tables: ['audit_log'] },
  { area: 'Schema', what: 'Applied migrations', tables: ['schema_migrations'] },
];

export interface ObjectStore {
  name: string;
  what: string;
  /** env vars that configure it */
  env: string[];
}

export const OBJECT_STORES: ObjectStore[] = [
  {
    name: 'Video bucket (S3)',
    what: 'Camera video (.ts), LiDAR (.npz), IMU (.csv.gz), session.json: <robot_id>/sessions/<session>/…',
    env: ['ARCHIVE_S3_BUCKET', 'ARCHIVE_S3_REGION', 'ARCHIVE_S3_ENDPOINT', 'ARCHIVE_S3_ACCESS_KEY', 'ARCHIVE_S3_SECRET_KEY'],
  },
  {
    name: 'Document storage',
    what: 'Circuit diagrams, manuals, warranty files, release packages (local folder or S3, set on the backend)',
    env: ['STORAGE_DRIVER', 'STORAGE_LOCAL_DIR', 'S3_BUCKET'],
  },
];
