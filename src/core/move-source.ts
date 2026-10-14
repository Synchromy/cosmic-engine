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
  /** Polymorphic ownership resolves through the page id rather than a direct column. */
  pageKey?: 'id';
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
  { table: 'chronicle_page_state', action: 'move', why: 'chronicle extraction state belongs to its page', pageColumns: ['page_id'] },
  { table: 'core_edit_notices', action: 'move', why: 'pending edit notices belong to the page slug', pageColumns: ['slug'] },
  { table: 'link_edge_proposals', action: 'move', why: 'edge proposals belong to their subject page', pageColumns: ['from_page_id'] },
  { table: 'link_relationships', action: 'move', why: 'relationship projection belongs to its subject page', pageColumns: ['from_page_id'] },
  { table: 'link_transitions', action: 'move', why: 'transitions belong to their origin page, or their subject when no origin is recorded', pageColumns: ['origin_page_id'] },
  { table: 'page_mention_state', action: 'move', why: 'mention scan state belongs to its page', pageColumns: ['page_id'] },
  { table: 'mention_gazetteer_entries', action: 'move', why: 'mention names identify this page', pageColumns: ['target_slug'] },
  { table: 'wanted_links', action: 'move', why: 'unresolved references belong to the originating page', pageColumns: ['origin_page_id'] },
  { table: 'write_gate_holds', action: 'move', why: 'held page-local writes belong to the page slug', pageColumns: ['slug'] },
  { table: 'fact_purges', action: 'move', why: 'page-subject purge tombstones follow the page; source-wide tombstones stay', pageColumns: ['subject'] },
  { table: 'take_purges', action: 'move', why: 'page-subject take tombstones follow the page; source-wide tombstones stay', pageColumns: ['subject'] },
  { table: 'fact_withdrawals', action: 'move', why: 'page-subject withdrawal tombstones follow the page; source-wide tombstones stay', pageColumns: ['subject'] },
  { table: 'access_tokens', action: 'leave', why: 'token write-source configuration, not page content' },
  { table: 'chronicle_judge_reservations', action: 'leave', why: 'spend reservation records where judging was charged' },
  { table: 'decide_proposals', action: 'leave', why: 'cross-fact decision history records its original source' },
  { table: 'decide_review_proposals', action: 'leave', why: 'cross-entity review history records its original source' },
  { table: 'decide_review_queue', action: 'leave', why: 'source-scoped review inputs may reference multiple pages' },
  { table: 'decide_spend', action: 'leave', why: 'spend audit records the source charged' },
  { table: 'decide_sweep_deferred', action: 'move', why: 'deferred fact work follows facts fenced on the page', pageColumns: ['fact_id'], pageKey: 'id' },
  { table: 'decision_receipts', action: 'leave', why: 'decision audit records its original source and policy' },
  { table: 'derivation_inputs', action: 'move', why: 'derivation edges follow their page-owned derived row', pageColumns: ['derived_table', 'derived_id'], pageKey: 'id' },
  { table: 'dream_synthesis_completions', action: 'leave', why: 'source-level synthesis idempotency checkpoint' },
  { table: 'fact_relink_attempts', action: 'leave', why: 'attempt audit records its original source' },
  { table: 'mention_index_status', action: 'leave', why: 'source-wide mention index progress' },
  { table: 'needs_rederive', action: 'move', why: 'purge rederivation markers follow their page-owned derived row', pageColumns: ['derived_table', 'derived_id'], pageKey: 'id' },
  { table: 'page_purges', action: 'leave', why: 'source-wide content-hash ban applies under any slug, not just its recorded slug' },
  { table: 'persistence_effects', action: 'leave', why: 'journal effects retain their admitted source and incarnation' },
  { table: 'persistence_requests', action: 'leave', why: 'immutable write journal retains its admitted source and authority' },
  { table: 'persistence_source_bindings', action: 'leave', why: 'source-to-worktree topology configuration' },
  { table: 'persistence_topology_changes', action: 'leave', why: 'source topology administration journal' },
  { table: 'retrieval_event_links', action: 'leave', why: 'retrieval audit records the source seen at query time' },
  { table: 'retrieval_event_pages', action: 'leave', why: 'retrieval audit records the source seen at query time' },
  { table: 'retrieval_feedback', action: 'leave', why: 'feedback audit records the original retrieval scope' },
  { table: 'retrieval_weights', action: 'leave', why: 'source-specific learned ranking policy, not page content' },
  { table: 'shared_skill_heads', action: 'leave', why: 'skillpack publication belongs to a source incarnation' },
  { table: 'shared_skill_packs', action: 'leave', why: 'source-wide skillpack manifest' },
  { table: 'shared_skill_policies', action: 'leave', why: 'source-wide skillpack access policy' },
  { table: 'shared_skill_policy_audit', action: 'leave', why: 'skillpack policy change audit' },
  { table: 'shared_skill_revision_leases', action: 'leave', why: 'source-incarnation-bound delivery and pin leases' },
  { table: 'shared_skill_revisions', action: 'leave', why: 'immutable source-incarnation-bound skillpack revisions' },
  { table: 'source_ingestion_receipts', action: 'leave', why: 'source-incarnation ingestion audit and checkpoint' },
  { table: 'trust_allow_rules', action: 'leave', why: 'source-wide trust policy' },
  { table: 'trust_proposals', action: 'move', why: 'trust reviews follow their page-owned target', pageColumns: ['target_table', 'target_id'], pageKey: 'id' },
  { table: 'write_gate_receipts', action: 'leave', why: 'write inspection audit retains the source inspected' },
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


/** Match only known page-owned rows; input edges to other pages stay with their owner. */
function ownedRowPredicate(tableColumn: string, idColumn: string): string {
  return `(${tableColumn} = 'pages' AND ${idColumn} = $KEY::integer::text)
    OR (${tableColumn} = 'facts' AND ${idColumn} IN
      (SELECT f.id::text FROM facts f JOIN pages p ON p.id = $KEY
        WHERE f.source_id = p.source_id AND f.source_markdown_slug = p.slug))
    OR (${tableColumn} = 'takes' AND ${idColumn} IN (SELECT id::text FROM takes WHERE page_id = $KEY))
    OR (${tableColumn} = 'timeline_entries' AND ${idColumn} IN (SELECT id::text FROM timeline_entries WHERE page_id = $KEY))
    OR (${tableColumn} = 'content_chunks' AND ${idColumn} IN (SELECT id::text FROM content_chunks WHERE page_id = $KEY))`;
}

const PAGE_LOCAL_PREDICATES: Record<string, string> = {
  derivation_inputs: ownedRowPredicate('derived_table', 'derived_id'),
  needs_rederive: ownedRowPredicate('derived_table', 'derived_id'),
  trust_proposals: ownedRowPredicate('target_table', 'target_id::text'),
  decide_sweep_deferred: "fact_id IN (SELECT f.id FROM facts f JOIN pages p ON p.id = $KEY WHERE f.source_id = p.source_id AND f.source_markdown_slug = p.slug)",
  chronicle_page_state: 'page_id = $KEY',
  core_edit_notices: 'slug = $KEY',
  link_edge_proposals: 'from_page_id = $KEY',
  link_relationships: 'from_page_id = $KEY',
  link_transitions: 'origin_page_id = $KEY OR (origin_page_id IS NULL AND from_page_id = $KEY)',
  page_mention_state: 'page_id = $KEY',
  mention_gazetteer_entries: 'target_slug = $KEY',
  wanted_links: 'origin_page_id = $KEY',
  write_gate_holds: 'slug = $KEY',
  fact_purges: 'subject = $KEY',
  take_purges: 'subject = $KEY',
  fact_withdrawals: 'subject = $KEY',
};

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
    default: {
      const predicate = PAGE_LOCAL_PREDICATES[table];
      if (!predicate) throw new Error(`move-source has no SQL for move table '${table}'`);
      return `UPDATE ${table} SET source_id = $1 WHERE source_id = $2 AND (${predicate.replaceAll('$KEY', '$3')}) RETURNING *`;
    }
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
    default: {
      const predicate = PAGE_LOCAL_PREDICATES[table];
      if (!predicate) throw new Error(`move-source has no count SQL for move table '${table}'`);
      return `SELECT 1 FROM ${table} WHERE source_id = $1 AND (${predicate.replaceAll('$KEY', '$2')})`;
    }
  }
}

/** The value a table's page column is matched on: the page id, or its slug. */
function pageKey(table: string, page: PageRow, slug: string): number | string {
  const entry = SOURCE_ID_TABLES.find(entry => entry.table === table);
  return entry?.pageKey === 'id' || entry?.pageColumns?.some(column => ['id', 'page_id', 'from_page_id', 'origin_page_id', 'from_chunk_id'].includes(column))
    ? page.id : slug;
}

/** Move one live page and its page-local source-scoped rows without changing id. */
export async function movePageSource(engine: BrainEngine, opts: MovePageSourceOptions): Promise<MoveResult> {
  return engine.transaction(async tx => {
    const target = rows(await tx.executeRaw('SELECT id FROM sources WHERE id = $1', [opts.to]));
    if (target.length === 0) throw new Error(`Cannot move '${opts.slug}': destination source '${opts.to}' does not exist.`);
    if (opts.from === opts.to) throw new Error(`Cannot move '${opts.slug}': source '${opts.to}' is already the destination.`);

    const candidates = opts.from
      ? rows(await tx.executeRaw("SELECT id, source_id, frontmatter->>'origin_source' AS origin_source FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL FOR UPDATE", [opts.from, opts.slug]))
      : rows(await tx.executeRaw("SELECT id, source_id, frontmatter->>'origin_source' AS origin_source FROM pages WHERE slug = $1 AND source_id <> $2 AND deleted_at IS NULL ORDER BY source_id FOR UPDATE", [opts.slug, opts.to]));
    if (candidates.length === 0) throw new Error(opts.from
      ? `Cannot move '${opts.slug}': no live page exists in source '${opts.from}'.`
      : `Cannot move '${opts.slug}': no live page outside destination '${opts.to}' exists.`);
    if (candidates.length > 1) throw new Error(`Cannot move '${opts.slug}' without --from: it is live in ${candidates.map(r => `'${r.source_id}'`).join(', ')}.`);
    const page = candidates[0] as unknown as PageRow;

    const twin = rows(await tx.executeRaw("SELECT frontmatter->>'origin_source' AS origin_source FROM pages WHERE source_id = $1 AND slug = $2 LIMIT 1", [opts.to, opts.slug]));
    if (twin.length) {
      const existingOrigin = twin[0]!.origin_source as string | null;
      if (opts.to === 'restricted' && existingOrigin !== page.origin_source) {
        throw new Error(`Cannot move '${opts.slug}': a restricted page from origin '${existingOrigin ?? 'unknown'}' already holds '${opts.slug}'; merge them by hand.`);
      }
      throw new Error(`Cannot move '${opts.slug}': source '${opts.to}' already has a page at that slug.`);
    }

    const tables = SOURCE_ID_TABLES.filter(x => x.action === 'move');
    if (await tableExists(tx, EMBED_WAITING_TABLE.table)) tables.push(EMBED_WAITING_TABLE);
    const moved: Record<string, number> = {};
    // Dry-run needs the same predicates but no writes; use cheap table-specific SELECTs.
    if (opts.dryRun) {
      for (const { table } of tables) {
        const key = pageKey(table, page, opts.slug);
        const params = table === 'pages' ? [key] : [page.source_id, key];
        moved[table] = rows(await tx.executeRaw(countSql(table), params)).length;
      }
      return { slug: opts.slug, page_id: page.id, from: page.source_id, to: opts.to, moved, dry_run: true };
    }

    for (const { table } of tables) {
      await opts.beforeMoveTable?.(table);
      const key = pageKey(table, page, opts.slug);
      const params = table === 'pages' ? [opts.to, key] : [opts.to, page.source_id, key];
      moved[table] = rows(await tx.executeRaw(moveSql(table), params)).length;
    }
    return { slug: opts.slug, page_id: page.id, from: page.source_id, to: opts.to, moved, dry_run: false };
  });
}
