import type { Db } from '../db';

/** Files on their way to the shared bucket folder, for servers that cannot write there themselves. See migration 0033. */
export class FileHandoff {
  constructor(private readonly db: Db) {}

  async save(key: string, bytes: Buffer, contentType: string): Promise<void> {
    await this.db.query('INSERT INTO file_handoff (object_key, content_type, bytes) VALUES ($1, $2, $3) ON CONFLICT (object_key) DO NOTHING', [key, contentType, bytes]);
  }

  async read(key: string): Promise<Buffer | null> {
    return (await this.db.query<{ bytes: Buffer }>('SELECT bytes FROM file_handoff WHERE object_key = $1', [key])).rows[0]?.bytes ?? null;
  }

  async oldest(limit: number): Promise<{ object_key: string; content_type: string | null; bytes: Buffer }[]> {
    return (await this.db.query<{ object_key: string; content_type: string | null; bytes: Buffer }>('SELECT object_key, content_type, bytes FROM file_handoff ORDER BY created_at LIMIT $1', [limit])).rows;
  }

  async remove(key: string): Promise<void> {
    await this.db.query('DELETE FROM file_handoff WHERE object_key = $1', [key]);
  }
}
