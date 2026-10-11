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

function frontmatterMatches(fm: Record<string, unknown>, where: Record<string, string>): boolean {
  for (const [key, value] of Object.entries(where)) {
    const actual = fm[key];
    if (actual === undefined || actual === null || typeof actual === 'object' && !(actual instanceof Date)) return false;
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
    const rows = await ctx.engine.listPages({
      type: type as PageType,
      frontmatterEquals: where,
      limit,
      sort: 'updated_desc',
      excludePrivate,
      ...scope,
    });
    const pages: Array<Record<string, unknown>> = [];
    for (const pg of rows) {
      let frontmatter: Record<string, unknown> = (pg.frontmatter ?? {}) as Record<string, unknown>;
      let title = pg.title;
      let canonicalRevision: string | null = null;
      let snapshot: Awaited<ReturnType<typeof readCanonicalPage>> | null = null;
      try {
        snapshot = await readCanonicalPage(ctx.engine, pg.slug, pg.source_id);
      } catch {
        snapshot = null;
      }
      if (snapshot && snapshot.exists && snapshot.content !== null && snapshot.revision) {
        const parsed = parseMarkdown(snapshot.content, `${pg.slug}.md`);
        // The canonical bytes are the truth: a row whose canonical file no
        // longer carries this type or these values is not answered from the
        // index, and a page made private since the index row was written is
        // hidden from an untrusted reader.
        if (parsed.type !== pg.type) continue;
        if (!frontmatterMatches(parsed.frontmatter, where)) continue;
        if (excludePrivate && isPrivatePage(parsed.frontmatter)) continue;
        frontmatter = parsed.frontmatter;
        title = parsed.title || pg.title;
        canonicalRevision = snapshot.revision;
      }
      pages.push({
        slug: pg.slug,
        source_id: pg.source_id,
        title,
        type: pg.type,
        frontmatter,
        canonical_revision: canonicalRevision,
        updated_at: pg.updated_at,
      });
    }
    return { protocol_version: MEMORY_VERBS_VERSION, pages };
  },
};
