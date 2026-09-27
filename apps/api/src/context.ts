import { createPool, CredentialCipher, type Db } from '@arnobot/db';
import type { ApiConfig } from './lib/config';
import { AuthService } from './services/auth.service';
import { DocumentsService } from './services/documents.service';
import { FilesService } from './services/files.service';
import { PermissionsService } from './services/permissions.service';
import { RobotsService } from './services/robots.service';
import { StorageService } from './services/storage.service';

/** Everything a route needs, wired once at start-up (plain constructor injection, no DI container). */
export interface AppContext {
  cfg: ApiConfig;
  db: Db;
  cipher: CredentialCipher;
  auth: AuthService;
  perms: PermissionsService;
  storage: StorageService;
  files: FilesService;
  robots: RobotsService;
  documents: DocumentsService;
}

export function createContext(cfg: ApiConfig, db: Db = createPool(cfg.databaseUrl, { application_name: 'pms-api', max: 20 })): AppContext {
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
  };
}
