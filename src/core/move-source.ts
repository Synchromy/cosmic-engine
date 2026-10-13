/**
 * Cosmic carried patch `move-source` (C-72, add-restricted-content, finding
 * 6). See cosmic/patches.json.
 *
 * A page's page_id-owned children (content_chunks, page_versions, links,
 * raw_data and timeline_entries) need no update: retaining the page id carries
 * them with the page.  SOURCE_ID_TABLES is deliberately exhaustive for the
 * initialized schema; the schema-walk test makes a new source_id column an
 * explicit move-or-leave decision.
 */

import type { BrainEngine } from './engine.ts';

type SourceIdTable = {
  table: string;
  action: 'move' | 'leave';
  why: string;
  /** The page-local columns used by a move entry. */
  pageColumns?: string[];
};

export const SOURCE_ID_TABLES: SourceIdTable[] = [
  { table: 'pages', action: 'move', why: 'the page itself', pageColumns: ['id'] },
  { table: 'files', action: 'move', why: 'file metadata belongs to its page_id', pageColumns: ['page_id'] },
  { table: 'code_edges_chunk', action: 'move', why: 'resolved edge belongs to its from_chunk_id page', pageColumns: ['from_chunk_id'] },
  { table: 'code_edges_symbol', action: 'move', why: 'symbol edge belongs to its from_chunk_id page', pageColumns: ['from_chunk_id'] },
  { table: 'entity_identities', action: 'move', why: 'identity membership is keyed by page_id', pageColumns: ['page_id'] },
  { table: 'context_volunteer_events', action: 'move', why: 'event records the page slug', pageColumns: ['slug'] },
  { table: 'take_proposals', action: 'move', why: 'proposal records page_slug', pageColumns: ['page_slug'] },
  { table: 'slug_aliases', action: 'move', why: 'redirect belongs to its canonical_slug; a destination duplicate deliberately errors', pageColumns: ['canonical_slug'] },
  { table: 'page_aliases', action: 'move', why: 'search alias belongs to its slug; a destination duplicate deliberately errors', pageColumns: ['slug'] },
  { table: 'facts', action: 'move', why: 'only facts fenced on this page have source_markdown_slug', pageColumns: ['source_markdown_slug'] },
  { table: 'calibration_profiles', action: 'leave', why: 'source-level calibration configuration, not one page' },
  { table: 'code_traversal_cache', action: 'leave', why: 'source-wide derived cache, not one page' },
  { table: 'extract_rollup_7d', action: 'leave', why: 'source-wide operational rollup, not one page' },
  { table: 'ingest_log', action: 'leave', why: 'log records what happened in its original source' },
  { table: 'migration_impact_log', action: 'leave', why: 'migration audit log is not keyed to a page' },
  { table: 'oauth_clients', action: 'leave', why: 'per-client write source configuration' },
  { table: 'query_cache', action: 'leave', why: 'source-wide derived query cache, not one page' },
  { table: 'session_context_state', action: 'leave', why: 'per-client session state, not page state' },
  { table: 'extract_atoms_transcript_state', action: 'leave', why: 'file transcript state has no page key' },
  { table: 'open_loops', action: 'leave', why: 'loop facts may concern other entities and have no page key' },
  { table: 'loop_suppressions', action: 'leave', why: 'source-wide user suppression state' },
  { table: 'think_ab_results', action: 'leave', why: 'source-level experiment log, not one page' },
  { table: 'take_nudge_log', action: 'leave', why: 'take/proposal history has no stable page key' },
  { table: 'fact_withdrawals', action: 'leave', why: 'source-level withdrawal tombstones, not one page' },
];

/** Dynamic outage table (embed-outage-defer): created on first use, not by initSchema. */
export const EMBED_WAITING_TABLE: SourceIdTable = {
  table: 'cosmic_embed_waiting', action: 'move',
  why: 'waiting embedding work is keyed by (source_id, slug)', pageColumns: ['slug'],
};

export type MoveResult = {
  slug: string;
  page_id: number;
  from: string;
  to: string;
  moved: Record<string, number>;
  dry_run: boolean;
};

export type MovePageSourceOptions = {
  slug: string;
  to: string;
  from?: string;
  dryRun?: boolean;
  /** Test seam: a thrown error proves every preceding update rolls back. */
  beforeMoveTable?: (table: string) => void | Promise<void>;
};

type PageRow = { id: number; source_id: string; origin_source: string | null };
type Row = Record<string, unknown>;

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value as Row[] : [];
}

async function tableExists(engine: BrainEngine, table: string): Promise<boolean> {
  const found = rows(await engine.executeRaw(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1 AND table_type = 'BASE TABLE'",
    [table],
  ));
  return found.length > 0;
}

function moveSql(table: string): string {
  switch (table) {
    case 'pages': return 'UPDATE pages SET source_id = $1, updated_at = now() WHERE id = $2 RETURNING id';
    case 'files': return 'UPDATE files SET source_id = $1 WHERE source_id = $2 AND page_id = $3 RETURNING id';
    case 'code_edges_chunk': return 'UPDATE code_edges_chunk SET source_id = $1 WHERE source_id = $2 AND from_chunk_id IN (SELECT id FROM content_chunks WHERE page_id = $3) RETURNING id';
    case 'code_edges_symbol': return 'UPDATE code_edges_symbol SET source_id = $1 WHERE source_id = $2 AND from_chunk_id IN (SELECT id FROM content_chunks WHERE page_id = $3) RETURNING id';
    case 'entity_identities': return 'UPDATE entity_identities SET source_id = $1 WHERE source_id = $2 AND page_id = $3 RETURNING id';
    case 'context_volunteer_events': return 'UPDATE context_volunteer_events SET source_id = $1 WHERE source_id = $2 AND slug = $3 RETURNING id';
    case 'take_proposals': return 'UPDATE take_proposals SET source_id = $1 WHERE source_id = $2 AND page_slug = $3 RETURNING id';
    case 'slug_aliases': return 'UPDATE slug_aliases SET source_id = $1 WHERE source_id = $2 AND canonical_slug = $3 RETURNING id';
    case 'page_aliases': return 'UPDATE page_aliases SET source_id = $1 WHERE source_id = $2 AND slug = $3 RETURNING id';
    case 'facts': return 'UPDATE facts SET source_id = $1 WHERE source_id = $2 AND source_markdown_slug = $3 RETURNING id';
    case 'cosmic_embed_waiting': return 'UPDATE cosmic_embed_waiting SET source_id = $1 WHERE source_id = $2 AND slug = $3 RETURNING slug';
    default: throw new Error(`move-source has no SQL for move table '${table}'`);
  }
}

function countSql(table: string): string {
  switch (table) {
    case 'pages': return 'SELECT 1 FROM pages WHERE id = $1';
    case 'files': return 'SELECT 1 FROM files WHERE source_id = $1 AND page_id = $2';
    case 'code_edges_chunk': return 'SELECT 1 FROM code_edges_chunk WHERE source_id = $1 AND from_chunk_id IN (SELECT id FROM content_chunks WHERE page_id = $2)';
    case 'code_edges_symbol': return 'SELECT 1 FROM code_edges_symbol WHERE source_id = $1 AND from_chunk_id IN (SELECT id FROM content_chunks WHERE page_id = $2)';
    case 'entity_identities': return 'SELECT 1 FROM entity_identities WHERE source_id = $1 AND page_id = $2';
    case 'context_volunteer_events': return 'SELECT 1 FROM context_volunteer_events WHERE source_id = $1 AND slug = $2';
    case 'take_proposals': return 'SELECT 1 FROM take_proposals WHERE source_id = $1 AND page_slug = $2';
    case 'slug_aliases': return 'SELECT 1 FROM slug_aliases WHERE source_id = $1 AND canonical_slug = $2';
    case 'page_aliases': return 'SELECT 1 FROM page_aliases WHERE source_id = $1 AND slug = $2';
    case 'facts': return 'SELECT 1 FROM facts WHERE source_id = $1 AND source_markdown_slug = $2';
    case 'cosmic_embed_waiting': return 'SELECT 1 FROM cosmic_embed_waiting WHERE source_id = $1 AND slug = $2';
    default: throw new Error(`move-source has no count SQL for move table '${table}'`);
  }
}

/** The value a table's page column is matched on: the page id, or its slug. */
function pageKey(table: string, page: PageRow, slug: string): number | string {
  return table === 'pages' || table === 'files' || table === 'entity_identities' || table.startsWith('code_edges')
    ? page.id : slug;
}

/** Move one live page and its page-local source-scoped rows without changing id. */
export async function movePageSource(engine: BrainEngine, opts: MovePageSourceOptions): Promise<MoveResult> {
  const target = rows(await engine.executeRaw('SELECT id FROM sources WHERE id = $1', [opts.to]));
  if (target.length === 0) throw new Error(`Cannot move '${opts.slug}': destination source '${opts.to}' does not exist.`);
  if (opts.from === opts.to) throw new Error(`Cannot move '${opts.slug}': source '${opts.to}' is already the destination.`);

  const candidates = opts.from
    ? rows(await engine.executeRaw("SELECT id, source_id, frontmatter->>'origin_source' AS origin_source FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL", [opts.from, opts.slug]))
    : rows(await engine.executeRaw("SELECT id, source_id, frontmatter->>'origin_source' AS origin_source FROM pages WHERE slug = $1 AND source_id <> $2 AND deleted_at IS NULL ORDER BY source_id", [opts.slug, opts.to]));
  if (candidates.length === 0) throw new Error(opts.from
    ? `Cannot move '${opts.slug}': no live page exists in source '${opts.from}'.`
    : `Cannot move '${opts.slug}': no live page outside destination '${opts.to}' exists.`);
  if (candidates.length > 1) throw new Error(`Cannot move '${opts.slug}' without --from: it is live in ${candidates.map(r => `'${r.source_id}'`).join(', ')}.`);
  const page = candidates[0] as unknown as PageRow;

  const twin = rows(await engine.executeRaw("SELECT frontmatter->>'origin_source' AS origin_source FROM pages WHERE source_id = $1 AND slug = $2 LIMIT 1", [opts.to, opts.slug]));
  if (twin.length) {
    const existingOrigin = twin[0]!.origin_source as string | null;
    if (opts.to === 'restricted' && existingOrigin !== page.origin_source) {
      throw new Error(`Cannot move '${opts.slug}': a restricted page from origin '${existingOrigin ?? 'unknown'}' already holds '${opts.slug}'; merge them by hand.`);
    }
    throw new Error(`Cannot move '${opts.slug}': source '${opts.to}' already has a page at that slug.`);
  }

  const tables = SOURCE_ID_TABLES.filter(x => x.action === 'move');
  if (await tableExists(engine, EMBED_WAITING_TABLE.table)) tables.push(EMBED_WAITING_TABLE);
  const moved: Record<string, number> = {};
  // Dry-run needs the same predicates but no writes; use cheap table-specific SELECTs.
  if (opts.dryRun) {
    for (const { table } of tables) {
      const key = pageKey(table, page, opts.slug);
      const params = table === 'pages' ? [key] : [page.source_id, key];
      moved[table] = rows(await engine.executeRaw(countSql(table), params)).length;
    }
    return { slug: opts.slug, page_id: page.id, from: page.source_id, to: opts.to, moved, dry_run: true };
  }

  await engine.transaction(async tx => {
    for (const { table } of tables) {
      await opts.beforeMoveTable?.(table);
      const key = pageKey(table, page, opts.slug);
      const params = table === 'pages' ? [opts.to, key] : [opts.to, page.source_id, key];
      moved[table] = rows(await tx.executeRaw(moveSql(table), params)).length;
    }
  });
  return { slug: opts.slug, page_id: page.id, from: page.source_id, to: opts.to, moved, dry_run: false };
}
