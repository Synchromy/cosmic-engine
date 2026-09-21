import type { GetPageOpts } from './types.ts';
import { privatePagesFilterFragment } from './search/private-visibility.ts';

/** Internal selection metadata. Never serialized as a page response. */
export interface PageReadIdentity {
  id: number;
  source_id: string;
  slug: string;
  private: boolean;
}
export type PageReadTarget = Readonly<{
  operation: 'get_page' | 'fetch';
  id: number;
  source_id: string;
  slug: string;
}>;
type ReadQuery = (sql: string, params: (string | number | string[])[]) => Promise<Record<string, unknown>[]>;

/** Same winner as getPage, without selecting body/frontmatter/tags. The PG
 * caller supplies its scoped-read transaction, retaining the RLS boundary. */
export async function readPageIdentity(
  query: ReadQuery, slug: string, opts: GetPageOpts = {},
): Promise<PageReadIdentity | null> {
  const where = ['slug = $1'];
  const params: (string | number | string[])[] = [slug];
  if (opts.sourceIds?.length) {
    params.push(opts.sourceIds);
    where.push(`source_id = ANY($${params.length}::text[])`);
  } else if (opts.sourceId) {
    params.push(opts.sourceId);
    where.push(`source_id = $${params.length}`);
  }
  if (!opts.includeDeleted) where.push('deleted_at IS NULL');
  if (opts.excludePrivate) where.push(privatePagesFilterFragment('pages'));
  if (opts.expectedPageId !== undefined) {
    params.push(opts.expectedPageId);
    where.push(`id = $${params.length}`);
  }
  params.push(opts.sourceIds?.length ? opts.sourceIds[0] : 'default');
  const rows = await query(`SELECT id, source_id, slug,
      COALESCE(frontmatter->>'visibility', 'world') = 'private' AS private
    FROM pages WHERE ${where.join(' AND ')}
    ORDER BY (source_id = $${params.length}) DESC, source_id ASC LIMIT 1`, params);
  if (!rows.length) return null;
  const row = rows[0];
  return { id: Number(row.id), source_id: String(row.source_id), slug: String(row.slug), private: row.private === true };
}
