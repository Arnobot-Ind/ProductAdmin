import type { Paginated } from '@arnobot/message-schema';
import type { Queryable } from '@arnobot/db';

/** Tiny helper to build parameterised WHERE clauses without string-concatenating values. */
export class Where {
  readonly parts: string[] = [];
  readonly params: unknown[];

  constructor(params: unknown[] = []) {
    this.params = params;
  }

  /** Adds a condition; `?` placeholders are replaced by $n in order. */
  add(condition: string, ...values: unknown[]): this {
    let sql = condition;
    for (const v of values) {
      this.params.push(v);
      sql = sql.replace('?', `$${this.params.length}`);
    }
    this.parts.push(sql);
    return this;
  }

  /** Adds a positional param without a condition and returns its placeholder. */
  param(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  toSql(prefix = 'WHERE'): string {
    return this.parts.length ? `${prefix} ${this.parts.join(' AND ')}` : '';
  }
}

export async function paginate<T extends Record<string, unknown>>(
  db: Queryable,
  baseSql: string,
  where: Where,
  orderBy: string,
  page: number,
  limit: number,
  map: (row: T) => unknown = (r) => r,
): Promise<Paginated<never>> {
  const countRes = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${baseSql} ${where.toSql()}) q`, where.params);
  const params = [...where.params, limit, (page - 1) * limit];
  const rows = await db.query<T>(`${baseSql} ${where.toSql()} ORDER BY ${orderBy} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { items: rows.rows.map(map) as never[], total: countRes.rows[0].n, page, limit };
}

/** ISO string (UTC, Z) or null. pg returns Date for timestamptz. */
export function iso(v: Date | string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}
