import type { Db, Queryable } from '@arnobot/db';
import type { DocumentDto, DocumentType, DocumentVersionDto } from '@arnobot/message-schema';
import { notFound } from '../lib/errors';
import { iso } from '../lib/sql';
import { FILE_COLUMNS, toFileDto, type FileRow } from './files.service';

interface DocRow {
  id: string;
  doc_type: DocumentType;
  title: string;
  product_id: string | null;
  hardware_revision_id: string | null;
  robot_id: string | null;
  source_label: string;
  created_at: Date;
  deleted_at: Date | null;
}

const DOC_SELECT = `
SELECT d.id, d.doc_type, d.title, d.product_id, d.hardware_revision_id, d.robot_id, d.created_at, d.deleted_at,
       coalesce(p.name, rp.name || ' ' || hr.name, d.robot_id) AS source_label
FROM documents d
LEFT JOIN products p ON p.id = d.product_id
LEFT JOIN hardware_revisions hr ON hr.id = d.hardware_revision_id
LEFT JOIN products rp ON rp.id = hr.product_id`;

/**
 * Spec §4 / §3 row 7: documents live once on the product or hardware revision; a robot may also
 * have its own (one-off builds). Every upload is a new version; the latest is shown, older kept.
 */
export class DocumentsService {
  constructor(private readonly db: Db) {}

  private async withVersions(rows: DocRow[], db: Queryable): Promise<DocumentDto[]> {
    if (!rows.length) return [];
    const versions = await db.query<{ id: string; document_id: string; version_no: number; note: string | null; uploaded_at: Date; uploaded_by_name: string | null } & { file: FileRow }>(
      `SELECT v.id, v.document_id, v.version_no, v.note, v.uploaded_at, u.name AS uploaded_by_name,
              (SELECT row_to_json(x) FROM (SELECT ${FILE_COLUMNS} FROM files f WHERE f.id = v.file_id) x) AS file
       FROM document_versions v LEFT JOIN users u ON u.id = v.uploaded_by
       WHERE v.document_id = ANY($1::uuid[])
       ORDER BY v.version_no DESC`,
      [rows.map((r) => r.id)],
    );
    const byDoc = new Map<string, DocumentVersionDto[]>();
    for (const v of versions.rows) {
      const list = byDoc.get(v.document_id) ?? [];
      list.push({
        id: v.id,
        version_no: v.version_no,
        note: v.note,
        uploaded_at: iso(v.uploaded_at)!,
        uploaded_by_name: v.uploaded_by_name,
        file: toFileDto({ ...v.file, uploaded_at: new Date(v.file.uploaded_at) }),
      });
      byDoc.set(v.document_id, list);
    }
    return rows.map((r) => {
      const vs = byDoc.get(r.id) ?? [];
      return {
        id: r.id,
        doc_type: r.doc_type,
        title: r.title,
        source: r.robot_id ? 'robot' : r.hardware_revision_id ? 'revision' : 'product',
        product_id: r.product_id,
        hardware_revision_id: r.hardware_revision_id,
        robot_id: r.robot_id,
        source_label: r.source_label,
        latest: vs[0] ?? null,
        versions: vs,
        created_at: iso(r.created_at)!,
        deleted_at: iso(r.deleted_at),
      };
    });
  }

  async getDto(id: string, db: Queryable = this.db): Promise<DocumentDto> {
    const rows = (await db.query<DocRow>(`${DOC_SELECT} WHERE d.id = $1`, [id])).rows;
    if (!rows.length) throw notFound('document');
    return (await this.withVersions(rows, db))[0];
  }

  /** Effective documents of a robot = its own ∪ its hardware revision's ∪ its product's. */
  async effectiveForRobot(robotId: string, db: Queryable = this.db, includeDeleted = false): Promise<DocumentDto[]> {
    const rows = await db.query<DocRow>(
      `${DOC_SELECT}
       JOIN robots r ON r.robot_id = $1
       WHERE (d.robot_id = r.robot_id OR d.hardware_revision_id = r.hardware_revision_id OR d.product_id = r.product_id)
         ${includeDeleted ? '' : 'AND d.deleted_at IS NULL'}
       ORDER BY (d.robot_id IS NULL), (d.hardware_revision_id IS NULL), d.doc_type, d.title`,
      [robotId],
    );
    return this.withVersions(rows.rows, db);
  }

  /** Documents on a product and on all of its hardware revisions. */
  async forProduct(productId: string, db: Queryable = this.db, includeDeleted = false): Promise<DocumentDto[]> {
    const rows = await db.query<DocRow>(
      `${DOC_SELECT}
       WHERE (d.product_id = $1 OR hr.product_id = $1) ${includeDeleted ? '' : 'AND d.deleted_at IS NULL'}
       ORDER BY (d.hardware_revision_id IS NOT NULL), hr.name, d.doc_type, d.title`,
      [productId],
    );
    return this.withVersions(rows.rows, db);
  }

  /** The robot a document belongs to, or null for product/revision documents (platform level). */
  async ownerRobot(documentId: string, db: Queryable = this.db): Promise<string | null> {
    const r = (await db.query<{ robot_id: string | null }>('SELECT robot_id FROM documents WHERE id = $1', [documentId])).rows[0];
    if (!r) throw notFound('document');
    return r.robot_id;
  }
}
