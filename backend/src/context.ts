import { createPool, CredentialCipher, type Db } from './db';
import type { ApiConfig } from './lib/config';
import { ArchiveService } from './services/archive/archive.service';
import { AuthService } from './services/auth.service';
import { DocumentsService } from './services/documents.service';
import { FilesService } from './services/files.service';
import { PermissionsService } from './services/permissions.service';
import { RobotsService } from './services/robots.service';
import { StorageService } from './services/storage.service';

/** Process facts for the system status page; main.ts fills in what exists only after start-up. */
export interface RuntimeInfo {
  startedAt: Date;
  /** null = MQTT not configured. */
  mqttConnected: () => boolean | null;
}

/** Everything a route needs, wired once at start-up (plain constructor injection, no DI container). */
export interface AppContext {
  cfg: ApiConfig;
  db: Db;
  cipher: CredentialCipher;
  auth: AuthService;
  perms: PermissionsService;
  /** Documents / release packages. */
  storage: StorageService;
  files: FilesService;
  robots: RobotsService;
  documents: DocumentsService;
  /** Video / sensor archive: its own object store + Postgres index. */
  archive: ArchiveService;
  runtime: RuntimeInfo;
}

export function createContext(cfg: ApiConfig, db: Db = createPool(cfg.databaseUrl, { application_name: 'pms-backend', max: 30 })): AppContext {
  const storage = new StorageService(cfg);
  return {
    cfg,
    db,
    cipher: CredentialCipher.fromEnv(),
    auth: new AuthService(db, cfg.sessionSecret, cfg.sessionTtlHours),
    perms: new PermissionsService(db),
    storage,
    files: new FilesService(db, storage),
    robots: new RobotsService(db),
    documents: new DocumentsService(db),
    archive: new ArchiveService(db, cfg.archive),
    runtime: { startedAt: new Date(), mqttConnected: () => null },
  };
}
