/**
 * list_pages_with_frontmatter, a carried Synchromy patch (cosmic-hub C-137).
 * Kept beside pages.ts rather than in it so the size-ratcheted page cluster
 * does not grow; pages.ts lists it in pagesOperations right after list_pages.
 */

import { clampSearchLimit } from '../engine.ts';
import type { PageType } from '../types.ts';
import { coerceFrontmatterString, parseMarkdown } from '../markdown.ts';
import { readCanonicalPage } from '../canonical-page-mutations.ts';
import { resolveExcludePrivatePages, isPrivatePage } from '../search/private-visibility.ts';
import { MEMORY_VERBS_VERSION } from '../verbs.ts';
import { verbError } from './contract.ts';
import type { Operation } from './contract.ts';
import { assertExplicitSourceLive, federatedSearchScope, parseSourceIdParam } from './context.ts';

/**
 * list_pages_with_frontmatter (Synchromy carried patch, cosmic-hub C-137):
 * the newest pages of one type whose frontmatter holds given text values,
 * each with its frontmatter and its exact canonical revision. A reader that
 * must act on a page's frontmatter (a handoff's addressee and status) and
 * then patch it with patch_page's base_revision needs both values from ONE
 * snapshot: the frontmatter answered here is parsed from the same canonical
 * bytes the revision is taken from, and a row whose canonical bytes no
 * longer match the filter is dropped rather than answered from a stale
 * index row. When the canonical bytes cannot be read, the row carries the
 * index frontmatter and `canonical_revision: null`, never a content hash.
 *
 * Read scope is list_pages' exactly: the caller's source grant
 * (federatedSearchScope), an explicit source_id must be live, untrusted
 * callers never see `visibility: private` pages (checked on the index row and
 * again on the canonical frontmatter), and a remote caller is capped at 100.
 */
const LIST_PAGES_WITH_FRONTMATTER_MAX_KEYS = 8;
const LIST_PAGES_WITH_FRONTMATTER_MAX_VALUE = 500;
/** Index rows one call may read while skipping rows the canonical bytes no longer match. */
const LIST_PAGES_WITH_FRONTMATTER_MAX_SCAN = 1000;

function frontmatterMatches(fm: Record<string, unknown>, where: Record<string, string>): boolean {
  for (const [key, value] of Object.entries(where)) {
    const actual = fm[key];
    if (actual === undefined || actual === null || typeof actual === 'object' && !(actual instanceof Date)) return false;
    // A YAML date is a Date here and a full ISO timestamp in the index row
    // (`frontmatter->>key`), so a filter that matched the index matches here.
    if (actual instanceof Date) {
      if (value !== actual.toISOString() && value !== coerceFrontmatterString(actual)) return false;
      continue;
    }
    if (coerceFrontmatterString(actual) !== value) return false;
  }
  return true;
}

function parseFrontmatterWhere(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw verbError(
      'invalid_params',
      'list_pages_with_frontmatter: where must be an object of frontmatter keys to text values',
      'Pass where as an object, e.g. where: { "status": "open" }.',
    );
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > LIST_PAGES_WITH_FRONTMATTER_MAX_KEYS) {
    throw verbError(
      'invalid_params',
      `list_pages_with_frontmatter: where has ${entries.length} keys; at most ${LIST_PAGES_WITH_FRONTMATTER_MAX_KEYS}`,
      `Filter on at most ${LIST_PAGES_WITH_FRONTMATTER_MAX_KEYS} frontmatter keys.`,
    );
  }
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (key.trim() === '' || key !== key.trim()) {
      throw verbError(
        'invalid_params',
        'list_pages_with_frontmatter: a where key is empty or padded',
        'Use the frontmatter key exactly as the page writes it, e.g. "status".',
      );
    }
    if (typeof value !== 'string' || value.length > LIST_PAGES_WITH_FRONTMATTER_MAX_VALUE) {
      throw verbError(
        'invalid_params',
        `list_pages_with_frontmatter: where.${key.slice(0, 60)} must be text of at most ${LIST_PAGES_WITH_FRONTMATTER_MAX_VALUE} characters`,
        'Each where value is matched as text for equality; pass one string per key.',
      );
    }
    out[key] = value;
  }
  return out;
}

/** One index row as the canonical bytes say it is, or null when they no
 *  longer carry this type or these values, or the page is now private to an
 *  untrusted reader. Unreadable canonical bytes answer the index row with
 *  canonical_revision null. */
async function canonicalRow(
  engine: Parameters<typeof readCanonicalPage>[0],
  pg: { slug: string; source_id: string; title: string; type: string; frontmatter?: unknown; updated_at: unknown },
  where: Record<string, string>,
  excludePrivate: boolean,
): Promise<Record<string, unknown> | null> {
  let frontmatter: Record<string, unknown> = (pg.frontmatter ?? {}) as Record<string, unknown>;
  let title = pg.title;
  let canonicalRevision: string | null = null;
  let snapshot: Awaited<ReturnType<typeof readCanonicalPage>> | null = null;
  try {
    snapshot = await readCanonicalPage(engine, pg.slug, pg.source_id);
  } catch {
    snapshot = null;
  }
  if (snapshot && snapshot.exists && snapshot.content !== null && snapshot.revision) {
    const parsed = parseMarkdown(snapshot.content, `${pg.slug}.md`);
    if (parsed.type !== pg.type) return null;
    if (!frontmatterMatches(parsed.frontmatter, where)) return null;
    if (excludePrivate && isPrivatePage(parsed.frontmatter)) return null;
    frontmatter = parsed.frontmatter;
    title = parsed.title || pg.title;
    canonicalRevision = snapshot.revision;
  }
  return {
    slug: pg.slug,
    source_id: pg.source_id,
    title,
    type: pg.type,
    frontmatter,
    canonical_revision: canonicalRevision,
    updated_at: pg.updated_at,
  };
}

export const listPagesWithFrontmatterOperation: Operation = {
  name: 'list_pages_with_frontmatter',
  description:
    'MEMORY VERB (v1, additive): list the newest pages of one type whose frontmatter holds the given text values, ' +
    'each with its frontmatter and its canonical_revision (pass that to patch_page as base_revision). ' +
    'The frontmatter and the revision describe the same canonical snapshot. canonical_revision is null when the canonical ' +
    'bytes cannot be read; such a row cannot be patched until they can. Same source scope and private-page rules as list_pages. ' +
    'Default 50 rows; remote callers are capped at 100. protocol_version rides every response.',
  params: {
    type: { type: 'string', required: true, description: 'Page type to list, e.g. "handoff".' },
    where: {
      type: 'object',
      description: 'Frontmatter keys to text values, matched for equality, one value per key, all must match (at most 8 keys). Example: { "status": "open" }.',
    },
    limit: { type: 'number', description: 'Max results (default 50; remote callers are capped at 100)' },
    source_id: {
      type: 'string',
      description: "Scope to one source. Defaults to the caller's scope, as list_pages. '__all__' spans every source for trusted local callers; for remote callers '__all__' spans only your granted sources.",
    },
  },
  scope: 'read',
  mutating: false,
  idempotent: true,
  verb: true,
  cliHints: { name: 'list-frontmatter', hidden: true },
  annotations: { title: 'list pages with frontmatter', readOnlyHint: true },
  handler: async (ctx, p) => {
    const type = typeof p.type === 'string' ? p.type.trim() : '';
    if (!type) {
      throw verbError(
        'invalid_params',
        'list_pages_with_frontmatter: type is required',
        'Pass the page type to list, e.g. type: "handoff".',
      );
    }
    const where = parseFrontmatterWhere(p.where);
    const sourceIdParam = parseSourceIdParam(p.source_id, 'list_pages_with_frontmatter', { allowAll: true });
    const scope = federatedSearchScope(ctx, sourceIdParam);
    await assertExplicitSourceLive(ctx, sourceIdParam);
    const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
    const requestedLimit = p.limit as number | undefined;
    const isLocal = ctx.remote === false;
    const limit = isLocal
      ? clampSearchLimit(requestedLimit, 50, Number.MAX_SAFE_INTEGER)
      : clampSearchLimit(requestedLimit, 50, 100);
    // The index rows are the candidates; the canonical bytes decide. A
    // candidate the canonical bytes no longer match is skipped and the next
    // one is read, until `limit` rows are answered or the candidates run out.
    // The candidates come from ONE query (no OFFSET paging, whose batches can
    // overlap or skip rows that share an updated_at), bounded at
    // LIST_PAGES_WITH_FRONTMATTER_MAX_SCAN index rows (a trusted local caller
    // asking for more gets its limit). Canonical bytes are read only until
    // `limit` rows match. A page whose canonical bytes match but whose index
    // row has not caught up (a patch_page that answered projection_state:
    // pending) is not a candidate until its projection lands; that is the one
    // lag this read has.
    const scan = Math.max(limit, LIST_PAGES_WITH_FRONTMATTER_MAX_SCAN);
    const candidates = await ctx.engine.listPages({
      type: type as PageType,
      frontmatterEquals: where,
      limit: isLocal ? scan : LIST_PAGES_WITH_FRONTMATTER_MAX_SCAN,
      sort: 'updated_desc',
      excludePrivate,
      ...scope,
    });
    const pages: Array<Record<string, unknown>> = [];
    for (const pg of candidates) {
      if (pages.length >= limit) break;
      const row = await canonicalRow(ctx.engine, pg, where, excludePrivate);
      if (row) pages.push(row);
    }
    return { protocol_version: MEMORY_VERBS_VERSION, pages };
  },
};
