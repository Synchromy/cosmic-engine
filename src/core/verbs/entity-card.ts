/**
 * MEMORY_VERBS v1 — `entity(name)` card builder (zero LLM, p99 < 100ms).
 *
 * Resolves a free-text name to ONE brain page via the Retrieval Reflex's
 * precision-biased arms (alias-first, then exact-title / exact-slug /
 * slug-suffix), then assembles a compact self-describing card from parallel
 * depth-1 indexed reads. Deliberately NOT the recursive-CTE traversal
 * (traversePaths) — the card is a latency contract, not a graph walk.
 *
 * Resolution precedence (frozen): alias > exact slug > exact title >
 * slug-suffix. Exact-title collisions prefer entity-shaped pages over
 * transcript/note containers; otherwise ties break on GREATEST(updated_at,
 * last_retrieved_at) — "last_touched" is the card's OUTPUT name, not a
 * column. Multi-hit → best match wins, runners-up land in `suggestions`.
 * Miss → `found: false` + keyword near-misses with create_safety hints. NEVER
 * throws for data reasons; each arm is guarded so a pre-page_aliases brain
 * still resolves via arm 2 (same posture as the shipped reflex).
 *
 * Privacy: `summary` runs through safeSynopsis (the get_page fence boundary);
 * facts respect visibility for remote callers (world-only).
 */

import type { BrainEngine, FactRow } from '../engine.ts';
import { normalizeAlias } from '../search/alias-normalize.ts';
import { slugify } from '../entities/resolve.ts';
import { safeSynopsis } from '../context/retrieval-reflex.ts';
import { stampEvidence, markKeywordHits } from '../search/evidence.ts';
import type { SearchResult } from '../types.ts';

const EDGE_CAP = 10;
const OPEN_THREADS_CAP = 3;
const OPEN_THREAD_TIMELINE_WINDOW_DAYS = 90;
const SUGGESTION_CAP = 3;
/** A miss offers more than a hit's runners-up: name matches plus content matches. */
const NEAR_MISS_CAP = 5;
const FACT_FETCH_CAP = 100;
const ENTITY_PAGE_TYPES = new Set(['person', 'company', 'organization', 'entity']);

export interface EntityCardEdge {
  type: string;
  direction: 'out' | 'in';
  slug: string;
  context: string | null;
}

export interface EntityOpenThread {
  kind: 'commitment' | 'recent_event';
  text: string;
  date: string | null;
  /**
   * v0.47 open-loop engine — ADDITIVE OPTIONAL fields (legal under the
   * MEMORY_VERBS v1 freeze; absent on threads not backed by an open_loops
   * row). direction is from the account owner's perspective.
   */
  direction?: 'owed_by_me' | 'owed_to_me' | 'their_turn' | 'my_turn';
  due?: string | null;
  counterparty?: string | null;
  status?: string;
  loop_id?: number;
}

export interface EntityCard {
  entity: { slug: string; title: string; type: string | null };
  /** page_aliases reverse lookup (normalized forms). Empty on pre-migration brains. */
  aka: string[];
  /** Privacy-safe synopsis — same fence boundary as get_page. */
  summary: string;
  last_touched: {
    updated_at: string | null;
    last_retrieved_at: string | null;
    last_timeline_date: string | null;
  };
  /** Best-effort in v1: active commitment-kind facts + recent timeline entries. */
  open_threads: EntityOpenThread[];
  /** Top typed edges, mentions excluded, out-edges first. */
  edges: EntityCardEdge[];
  backlink_count: number;
  /** Exact active-fact count (indexed COUNT, not payload length); visibility-filtered for remote. */
  active_fact_count: number;
}

export interface EntitySuggestion {
  slug: string;
  title: string;
  create_safety: string;
}

export interface EntityCardResult {
  found: boolean;
  card?: EntityCard;
  suggestions?: EntitySuggestion[];
}

export interface CardPageRow {
  slug: string;
  // v0.43 merge: retrieval-reflex's exported PageRow (safeSynopsis's param)
  // now requires source_id (federated push-context wave #2095). The card row
  // carries it too so it remains assignable.
  source_id: string;
  title: string;
  type: string | null;
  frontmatter: Record<string, unknown> | null;
  compiled_truth: string | null;
  updated_at: Date | string | null;
  last_retrieved_at: Date | string | null;
}

/** Resolution arm rank: lower = higher confidence (frozen precedence ladder). */
const ARM_ALIAS = 0;
const ARM_EXACT = 1;
const ARM_SUFFIX = 2;

/** How the winning page matched the name, strongest first. */
export type EntityMatchedBy = 'alias' | 'slug' | 'title' | 'slug_suffix';

/** Page types an inferred match (title or slug suffix) may file a fact under. */
export const ENTITY_SHAPED_TYPES: ReadonlySet<string> = new Set([...ENTITY_PAGE_TYPES, 'project']);

export interface EntityResolution {
  /** The page the name resolves to, or null on a miss. */
  best: { slug: string; title: string; type: string | null; matched_by: EntityMatchedBy } | null;
  /** Other pages the precision arms matched (create_safety 'exists'). */
  runnersUp: EntitySuggestion[];
  /** On a miss: the nearest pages, slug and title matches before content matches. */
  suggestions?: EntitySuggestion[];
  /** Internal: the winning row, so the card is built without a second read. */
  row?: CardPageRow;
}

/**
 * The entity verb's resolution, on its own so `remember` files a fact under
 * the same page `entity` would show for the same name. Precedence (frozen):
 * alias > exact slug > exact title > slug-suffix.
 */
export async function resolveEntityPage(
  engine: BrainEngine,
  sourceId: string,
  name: string,
  opts: { remote: boolean },
): Promise<EntityResolution> {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return { best: null, runnersUp: [], suggestions: [] };

  // #4352 — untrusted callers never resolve a `visibility: private` page into
  // a card (or a near-miss suggestion). Trust + config gate resolve through
  // the shared helper; local (remote:false) callers are unchanged. Covers
  // entity, context_pack, delta and remember (all route through here).
  const { resolveExcludePrivatePages, privatePagesFilterFragment } = await import('../search/private-visibility.ts');
  const excludePrivate = await resolveExcludePrivatePages(engine, opts.remote ? undefined : false);
  // Predicate text lives ONCE (private-visibility.ts) — both card queries
  // below select `FROM pages` unaliased, so qualify with the table name.
  const privatePredicate = excludePrivate ? ` AND ${privatePagesFilterFragment('pages')}` : '';

  const norm = normalizeAlias(trimmed);
  const titleLc = trimmed.toLowerCase();
  // Two exact-slug candidates: the slugified form for free-text names AND the
  // raw input — a caller passing an already-namespaced slug
  // ("people/alice-example") must hit exactly (slugify flattens the slash).
  const slug = slugify(trimmed);
  const exactSlugs = [...new Set([slug, trimmed].filter(Boolean))];

  // Candidate slugs with their best arm rank.
  const rankBySlug = new Map<string, number>();
  const consider = (s: string, rank: number) => {
    if (!s) return;
    const prev = rankBySlug.get(s);
    if (prev === undefined || rank < prev) rankBySlug.set(s, rank);
  };

  // Arm 1 — alias-first. Guarded: pre-migration brains lack page_aliases.
  if (norm) {
    try {
      const aliasMap = await engine.resolveAliases([norm], { sourceId });
      for (const hit of aliasMap.get(norm) ?? []) consider(hit.slug, ARM_ALIAS);
    } catch {
      /* no page_aliases table — degrade to arm 2 [E3] */
    }
  }

  // Arm 2 — exact title / exact slug / slug-suffix, with the columns the
  // card's tie-break needs. Guarded like the reflex.
  let rows: CardPageRow[] = [];
  try {
    rows = await engine.executeRaw<CardPageRow>(
      `SELECT slug, source_id, title, type, frontmatter, compiled_truth, updated_at, last_retrieved_at
         FROM pages
        WHERE deleted_at IS NULL
          AND source_id = $1
          AND ( lower(title) = $2
             OR slug = ANY($3::text[])
             OR slug LIKE $4 )${privatePredicate}`,
      [sourceId, titleLc, exactSlugs, `%/${slug || trimmed}`],
    );
  } catch {
    rows = [];
  }
  const rowBySlug = new Map<string, CardPageRow>();
  for (const r of rows) {
    rowBySlug.set(r.slug, r);
    const isExact = (r.title ?? '').toLowerCase() === titleLc || exactSlugs.includes(r.slug);
    consider(r.slug, isExact ? ARM_EXACT : ARM_SUFFIX);
  }

  // Hydrate alias-resolved slugs that arm 2 didn't fetch.
  const missing = [...rankBySlug.keys()].filter(s => !rowBySlug.has(s));
  if (missing.length) {
    try {
      const extra = await engine.executeRaw<CardPageRow>(
        `SELECT slug, source_id, title, type, frontmatter, compiled_truth, updated_at, last_retrieved_at
           FROM pages
          WHERE deleted_at IS NULL AND source_id = $1 AND slug = ANY($2::text[])${privatePredicate}`,
        [sourceId, missing],
      );
      for (const r of extra) rowBySlug.set(r.slug, r);
    } catch {
      /* stale alias rows — drop */
    }
  }

  // Rank candidates: arm rank asc. Inside the precision arm an explicit slug
  // stays stronger than title inference; otherwise exact-title collisions
  // prefer an entity page over transcript/note containers. Recency remains
  // the final tie-break within the same match shape.
  const candidates = [...rankBySlug.entries()]
    .map(([s, rank]) => ({ slug: s, rank, row: rowBySlug.get(s) }))
    .filter((c): c is { slug: string; rank: number; row: CardPageRow } => c.row !== undefined)
    .sort((a, b) =>
      a.rank - b.rank
      || (a.rank === ARM_EXACT
        ? exactMatchPreference(a.row, exactSlugs) - exactMatchPreference(b.row, exactSlugs)
        : 0)
      || lastTouchedMs(b.row) - lastTouchedMs(a.row));

  if (candidates.length === 0) {
    return { best: null, runnersUp: [], suggestions: await nearMissSuggestions(engine, sourceId, trimmed, excludePrivate) };
  }

  const top = candidates[0];
  const runnersUp: EntitySuggestion[] = candidates.slice(1, 1 + SUGGESTION_CAP).map(c => ({
    slug: c.slug,
    title: c.row.title ?? c.slug,
    // A page that resolved through the precision arms exists by definition.
    create_safety: 'exists',
  }));
  const matchedBy: EntityMatchedBy =
    top.rank === ARM_ALIAS ? 'alias'
      : top.rank === ARM_SUFFIX ? 'slug_suffix'
        : exactSlugs.includes(top.slug) ? 'slug' : 'title';
  return {
    best: { slug: top.slug, title: top.row.title ?? top.slug, type: top.row.type, matched_by: matchedBy },
    runnersUp,
    row: top.row,
  };
}

export async function buildEntityCard(
  engine: BrainEngine,
  sourceId: string,
  name: string,
  opts: { remote: boolean },
): Promise<EntityCardResult> {
  const resolution = await resolveEntityPage(engine, sourceId, name, opts);
  if (!resolution.best || !resolution.row) {
    return { found: false, suggestions: resolution.suggestions ?? [] };
  }
  const card = await assembleCard(engine, sourceId, resolution.row, opts.remote);
  return {
    found: true,
    card,
    ...(resolution.runnersUp.length ? { suggestions: resolution.runnersUp } : {}),
  };
}

function exactMatchPreference(row: CardPageRow, exactSlugs: string[]): number {
  if (exactSlugs.includes(row.slug)) return 0;
  return ENTITY_PAGE_TYPES.has(row.type ?? '') ? 1 : 2;
}

async function assembleCard(
  engine: BrainEngine,
  sourceId: string,
  row: CardPageRow,
  remote: boolean,
): Promise<EntityCard> {
  const pageSlug = row.slug;
  const visibility = remote ? (['world'] as ('private' | 'world')[]) : undefined;

  // Parallel depth-1 reads — every arm individually fail-soft so a partial
  // brain (no aliases, no timeline) still returns a card.
  //
  // [ship P1.2] Incoming edges + backlink_count are SOURCE-SAFE on BOTH sides.
  // engine.getBacklinks(slug,{sourceId}) only scopes the TARGET page's source,
  // so a foreign-source page linking to a same-named entity would leak its
  // slug; engine.getBacklinkCounts counts inbound from ALL sources. We run
  // a both-sides-scoped query here (f.source_id = t.source_id = this source),
  // mentions excluded (matching the backlink-count convention). Outgoing edges
  // (getLinks) are the entity's OWN declared links — from-side scoped — so they
  // stay as-is.
  const [aka, outLinks, inEdges, backlinkCount, timeline, facts, activeFactCount] = await Promise.all([
    engine
      .executeRaw<{ alias_norm: string }>(
        `SELECT alias_norm FROM page_aliases WHERE source_id = $1 AND slug = $2 ORDER BY alias_norm`,
        [sourceId, pageSlug],
      )
      .then(rs => rs.map(r => r.alias_norm))
      .catch(() => [] as string[]),
    engine.getLinks(pageSlug, { sourceId }).catch(() => []),
    engine
      .executeRaw<{ from_slug: string; link_type: string; context: string | null }>(
        `SELECT f.slug AS from_slug, l.link_type, l.context
           FROM links l
           JOIN pages f ON f.id = l.from_page_id
           JOIN pages t ON t.id = l.to_page_id
          WHERE t.slug = $1 AND t.source_id = $2 AND f.source_id = $2
            AND COALESCE(l.link_source, '') <> 'mentions'`,
        [pageSlug, sourceId],
      )
      .catch(() => [] as Array<{ from_slug: string; link_type: string; context: string | null }>),
    engine
      .executeRaw<{ n: string | number }>(
        `SELECT COUNT(*) AS n
           FROM links l
           JOIN pages f ON f.id = l.from_page_id
           JOIN pages t ON t.id = l.to_page_id
          WHERE t.slug = $1 AND t.source_id = $2 AND f.source_id = $2
            AND COALESCE(l.link_source, '') <> 'mentions'`,
        [pageSlug, sourceId],
      )
      .then(rs => Number(rs[0]?.n ?? 0))
      .catch(() => 0),
    engine.getTimeline(pageSlug, { limit: 5, sourceId }).catch(() => []),
    engine
      .listFactsByEntity(sourceId, pageSlug, {
        activeOnly: true,
        limit: FACT_FETCH_CAP,
        ...(visibility ? { visibility } : {}),
      })
      .catch(() => [] as FactRow[]),
    // Exact active-fact count: the payload fetch above is capped at
    // FACT_FETCH_CAP, so facts.length silently reports the cap for bigger
    // entities. Same predicate as the fetch (active + source + caller
    // visibility), indexed COUNT instead of rows. Fail-soft to null so a
    // count failure degrades to the capped payload length, never to 0.
    engine
      .executeRaw<{ n: string | number }>(
        `SELECT COUNT(*) AS n
           FROM facts
          WHERE source_id = $1 AND entity_slug = $2
            AND expired_at IS NULL${remote ? ` AND visibility = 'world'` : ''}`,
        [sourceId, pageSlug],
      )
      .then(rs => Number(rs[0]?.n ?? 0))
      .catch(() => null),
  ]);

  const edges: EntityCardEdge[] = [];
  for (const l of outLinks) {
    if (l.link_source === 'mentions') continue;
    edges.push({ type: l.link_type, direction: 'out', slug: l.to_slug, context: l.context || null });
    if (edges.length >= EDGE_CAP) break;
  }
  if (edges.length < EDGE_CAP) {
    for (const l of inEdges) {
      edges.push({ type: l.link_type, direction: 'in', slug: l.from_slug, context: l.context || null });
      if (edges.length >= EDGE_CAP) break;
    }
  }

  // Open threads (best-effort v1): open-loop rows first (v0.47 — richest:
  // direction, due, loop_id), then active commitment facts NOT already
  // represented by a loop, then recent timeline entries; capped together.
  const openThreads: EntityOpenThread[] = [];
  const loopFactIds = new Set<number>();
  try {
    // Zero-LLM, indexed lookup — stays inside the p99<100ms budget.
    const loopRows = await engine.executeRaw<{
      id: number;
      loop_type: string;
      summary: string;
      due_at: string | null;
      last_activity_at: string;
      fact_id: number | null;
    }>(
      `SELECT id, loop_type, summary, due_at, last_activity_at, fact_id
       FROM open_loops
       WHERE status = 'open' AND counterparty_slug = $1 AND source_id = $2
       ORDER BY last_activity_at DESC
       LIMIT ${OPEN_THREADS_CAP}`,
      [pageSlug, sourceId],
    );
    for (const l of loopRows) {
      if (l.fact_id !== null) loopFactIds.add(Number(l.fact_id));
      const direction: EntityOpenThread['direction'] =
        l.loop_type === 'commitment_owed_by_me'
          ? 'owed_by_me'
          : l.loop_type === 'commitment_owed_to_me'
            ? 'owed_to_me'
            : l.loop_type === 'unanswered_inbound'
              ? 'my_turn'
              : 'their_turn';
      openThreads.push({
        kind: 'commitment',
        text: l.summary,
        date: typeof l.last_activity_at === 'string' ? l.last_activity_at : new Date(l.last_activity_at).toISOString(),
        direction,
        due: l.due_at ? (typeof l.due_at === 'string' ? l.due_at : new Date(l.due_at).toISOString()) : null,
        counterparty: pageSlug,
        status: 'open',
        loop_id: Number(l.id),
      });
      if (openThreads.length >= OPEN_THREADS_CAP) break;
    }
  } catch {
    /* pre-v144 brains have no open_loops table — facts path below covers it */
  }
  for (const f of facts) {
    if (openThreads.length >= OPEN_THREADS_CAP) break;
    if (f.kind !== 'commitment') continue;
    if (f.id !== undefined && loopFactIds.has(f.id)) continue; // already surfaced via its loop
    openThreads.push({ kind: 'commitment', text: f.fact, date: f.valid_from?.toISOString() ?? null });
  }
  if (openThreads.length < OPEN_THREADS_CAP) {
    const cutoff = Date.now() - OPEN_THREAD_TIMELINE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    for (const t of timeline) {
      // Both engines TYPE this as string, but PGLite returns a Date object at
      // runtime for the DATE column. Normalize at the public-card boundary so
      // the frozen string|null contract holds for in-process consumers too.
      const date = toIso(t.date);
      const ts = date === null ? NaN : Date.parse(date);
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      openThreads.push({ kind: 'recent_event', text: t.summary, date });
      if (openThreads.length >= OPEN_THREADS_CAP) break;
    }
  }

  return {
    entity: { slug: pageSlug, title: row.title ?? pageSlug, type: row.type ?? null },
    aka,
    // v0.45.7: summary widens in lockstep with the card's fact visibility —
    // remote (world-only) keeps ['world']; a local include_private card widens.
    summary: safeSynopsis(row, { keepVisibility: remote ? ['world'] : ['private', 'world'] }),
    last_touched: {
      updated_at: toIso(row.updated_at),
      last_retrieved_at: toIso(row.last_retrieved_at),
      last_timeline_date: timeline.length ? toIso(timeline[0].date) : null,
    },
    open_threads: openThreads,
    edges,
    backlink_count: backlinkCount,
    active_fact_count: activeFactCount ?? facts.length,
  };
}

/**
 * Near-miss suggestions on a total miss (E5 delight), so a typo'd or
 * wrongly-prefixed name becomes a next move instead of a dead end. Zero LLM;
 * every arm fail-soft.
 *
 * Name matches come first: pages whose title or slug contains the name (the
 * resolve_slugs arm, entity-shaped pages ahead of the rest) and, for a
 * slug-shaped name, pages that share its last segment, so
 * "orgs/acme-example" offers "companies/acme-example". Keyword (content)
 * matches fill the rest. A name match is create_safety 'probable': the page
 * exists and is likely the one meant, so update it rather than create one.
 */
async function nearMissSuggestions(
  engine: BrainEngine,
  sourceId: string,
  name: string,
  excludePrivate = false,
): Promise<EntitySuggestion[]> {
  const out: EntitySuggestion[] = [];
  const seen = new Set<string>();
  const push = (s: EntitySuggestion) => {
    if (seen.has(s.slug) || out.length >= NEAR_MISS_CAP) return;
    seen.add(s.slug);
    out.push(s);
  };

  for (const s of await nameMatchSuggestions(engine, sourceId, name, excludePrivate)) push(s);

  try {
    const raw = await engine.searchKeyword(name, { limit: NEAR_MISS_CAP, sourceId, excludePrivate });
    const results = raw as SearchResult[];
    // #3783 — direct FTS path: every row is a keyword hit by construction.
    markKeywordHits(results);
    stampEvidence(results);
    for (const r of results) {
      push({ slug: r.slug, title: r.title ?? r.slug, create_safety: r.create_safety ?? 'unknown' });
    }
  } catch {
    /* keyword arm unavailable — name matches stand alone */
  }
  return out;
}

/** The near-miss list `entity` returns on a miss, for callers that refuse instead. */
export async function entityNearMisses(
  engine: BrainEngine,
  sourceId: string,
  name: string,
  opts: { remote: boolean },
): Promise<EntitySuggestion[]> {
  const { resolveExcludePrivatePages } = await import('../search/private-visibility.ts');
  const excludePrivate = await resolveExcludePrivatePages(engine, opts.remote ? undefined : false);
  return nearMissSuggestions(engine, sourceId, name.trim(), excludePrivate);
}

async function nameMatchSuggestions(
  engine: BrainEngine,
  sourceId: string,
  name: string,
  excludePrivate: boolean,
): Promise<EntitySuggestion[]> {
  // The name as typed, then (for a slug-shaped name) its last segment: the
  // part that survives a wrong directory prefix.
  const partials = [name];
  const tail = name.includes('/') ? name.split('/').filter(Boolean).pop() : undefined;
  if (tail && tail !== name) partials.push(tail);

  const ordered: string[] = [];
  for (const partial of partials) {
    try {
      for (const s of await engine.resolveSlugs(partial, { sourceId, excludePrivate })) {
        if (!ordered.includes(s)) ordered.push(s);
      }
    } catch {
      /* fail-soft */
    }
  }
  if (!ordered.length) return [];

  let rows: Array<{ slug: string; title: string | null; type: string | null }> = [];
  try {
    rows = await engine.executeRaw<{ slug: string; title: string | null; type: string | null }>(
      `SELECT slug, title, type FROM pages WHERE deleted_at IS NULL AND source_id = $1 AND slug = ANY($2::text[])`,
      [sourceId, ordered],
    );
  } catch {
    return [];
  }
  const bySlug = new Map(rows.map(r => [r.slug, r]));
  // Stable: resolve_slugs order inside each group, entity-shaped pages first.
  const live = ordered.map(s => bySlug.get(s)).filter((r): r is NonNullable<typeof r> => r !== undefined);
  const entityShaped = live.filter(r => ENTITY_SHAPED_TYPES.has(r.type ?? ''));
  const rest = live.filter(r => !ENTITY_SHAPED_TYPES.has(r.type ?? ''));
  return [...entityShaped, ...rest].map(r => ({ slug: r.slug, title: r.title ?? r.slug, create_safety: 'probable' }));
}

function lastTouchedMs(row: CardPageRow): number {
  const u = toMs(row.updated_at);
  const l = toMs(row.last_retrieved_at);
  return Math.max(u, l);
}

function toMs(v: Date | string | null): number {
  if (v == null) return 0;
  const ms = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(ms) ? ms : 0;
}

function toIso(v: Date | string | null): string | null {
  const ms = toMs(v);
  return ms > 0 ? new Date(ms).toISOString() : null;
}
