import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import type { PageReadIdentity } from '../page-read-identity.ts';
import { OperationError, type OperationContext } from './contract.ts';
import { resolveExcludePrivatePages, findPrivateOnlySlugs } from '../search/private-visibility.ts';
import { assertExplicitSourceLive, federatedSearchScope, parseSourceIdParam } from './context.ts';

type ResolvedRead = { page: Page; resolved_slug?: string };
type AmbiguousRead = { error: string; candidates: string[] };

/**
 * #4352 remediation — filter fuzzy-resolution candidates so get_page's
 * ambiguous_slug candidate list can't enumerate private slugs to an
 * untrusted caller. Probe SQL lives ONCE in findPrivateOnlySlugs (a slug
 * with at least one non-private in-scope page stays visible; candidates
 * come from resolveSlugs, so every slug has a live page row).
 * Order-preserving (resolveSlugs returns ranked candidates). Read-only,
 * scope-threaded — not a getPage/putPage pair (no unscoped-check/scoped-write
 * hazard).
 */
async function dropPrivateSlugs(
  engine: BrainEngine,
  candidates: string[],
  scope: { sourceId?: string; sourceIds?: string[] },
  includeDeleted: boolean,
): Promise<string[]> {
  const hidden = await findPrivateOnlySlugs(engine, candidates, scope, { includeDeleted });
  return candidates.filter(c => !hidden.has(c));
}

/** The callback receives a frozen copy, never the mutable resolver state. */
async function admittedBody(
  ctx: OperationContext, identity: PageReadIdentity, operation: 'get_page' | 'fetch',
  includeDeleted: boolean, sourceIdParam?: string,
): Promise<Page> {
  await ctx.beforePageRead?.(Object.freeze({
    operation, id: identity.id, source_id: identity.source_id, slug: identity.slug,
  }));
  // Recheck the caller's current grant and the existing explicit-source liveness
  // rule. Implicit/restore reads retain their existing archived-source behavior.
  const scope = federatedSearchScope(ctx, sourceIdParam);
  if (scope.sourceIds?.length ? !scope.sourceIds.includes(identity.source_id)
    : scope.sourceId !== undefined && scope.sourceId !== identity.source_id) {
    throw new OperationError('page_not_found', 'Page is no longer available');
  }
  await assertExplicitSourceLive(ctx, sourceIdParam);
  const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
  const page = await ctx.engine.getPage(identity.slug, {
    sourceId: identity.source_id, expectedPageId: identity.id, includeDeleted, excludePrivate,
  });
  if (!page) throw new OperationError('page_not_found', 'Page is no longer available');
  return page;
}

export async function readGetPage(ctx: OperationContext, p: Record<string, unknown>): Promise<ResolvedRead | AmbiguousRead> {
    const slug = p.slug as string;
    const fuzzy = (p.fuzzy as boolean) || false;
    const includeDeleted = (p.include_deleted as boolean) === true;
    // #4329: honor a per-call source_id (pre-fix it was silently dropped).
    // resolveRequestedScope (inside federatedSearchScope) enforces the remote
    // caller's grant on the explicit value.
    const sourceIdParam = parseSourceIdParam(p.source_id, 'get_page', { allowAll: true });
    // #1393: route BOTH the exact-match read and the fuzzy resolveSlugs through
    // the canonical precedence ladder (federated array > scalar > nothing). The
    // exact path previously used scalar `ctx.sourceId` only, so a remote client
    // with a federated `allowedSources` grant (and no single ctx.sourceId) got
    // an UNSCOPED exact lookup — a cross-source read of any page by slug. getPage
    // now honors sourceIds[] (both engines), so the same scope closes both paths.
    // #3242: federatedSearchScope (not bare sourceScopeOpts) so an unqualified
    // read sees pages in `federated: true` sources, matching search/query.
    const sourceOpts = federatedSearchScope(ctx, sourceIdParam);
    // #4620: an explicit source_id must name a live source (after the grant check).
    await assertExplicitSourceLive(ctx, sourceIdParam);
    const fuzzyScope = sourceOpts;

    // #4352 remediation: untrusted callers never read `visibility: private`
    // bodies — the same resolveExcludePrivatePages gate search/recall/entity
    // already apply (trusted local + the operator opt-outs resolve to false).
    // A gated private page behaves exactly like a missing one (no existence
    // oracle), composing with — not replacing — the source-grant scope above.
    const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);

    let page = await ctx.engine.getPageIdentity(slug, { includeDeleted, excludePrivate, ...sourceOpts });
    if (page && excludePrivate && page.private) page = null;
    let resolved_slug: string | undefined;

    // #4275: slug aliases are redirects — dedup/migration retires a slug and
    // registers alias → canonical. Search and the wikilink resolver already
    // follow them (resolveSlugWithAlias documents get_page as a consumer);
    // the direct exact read 404ing on a retired slug made the surfaces
    // disagree. Resolution runs ONLY on an exact-read miss, so a live page at
    // the requested slug (or, with include_deleted, its recoverable shell —
    // restore workflows need the shell, not a redirect) always wins, and it
    // runs BEFORE fuzzy (the alias table is authoritative; fuzzy is a guess).
    // Scope: federated grants consult only granted sources' alias rows, so an
    // out-of-grant alias behaves exactly like a missing page; a scalar scope
    // consults that source (the remote '__all__' literal matches no real
    // source and fail-closes); the trusted UNSCOPED read consults every LIVE
    // source (archived sources are excluded everywhere else in the ladder; their
    // alias rows count only when include_deleted asks for retired material).
    // The canonical is then read in the source that OWNS the alias row: a
    // federated getPage prefers the anchor source, so an unrelated live page at
    // the canonical slug in another granted source would otherwise shadow it.
    // No catch here: a pre-v104 brain (no slug_aliases table) is the ENGINE's
    // contract to absorb (resolveSlugWithAliasDetailed → null); anything else
    // (connection reset, timeout) must surface, not degrade to page_not_found.
    if (!page) {
      const aliasScope: string | readonly string[] = sourceOpts.sourceIds?.length
        ? sourceOpts.sourceIds
        : sourceOpts.sourceId !== undefined
          ? sourceOpts.sourceId
          : (await ctx.engine.listAllSources({ includeArchived: includeDeleted })).map(s => s.id);
      const hit = await ctx.engine.resolveSlugWithAliasDetailed(slug, aliasScope, { excludePrivate });
      if (hit) {
        const aliasPage = await ctx.engine.getPageIdentity(hit.canonical_slug, { includeDeleted, excludePrivate, sourceId: hit.source_id });
        if (aliasPage && !(excludePrivate && aliasPage.private)) {
          page = aliasPage;
          resolved_slug = hit.canonical_slug;
        }
      }
    }

    if (!page && fuzzy) {
      let candidates = await ctx.engine.resolveSlugs(slug, { ...fuzzyScope, excludePrivate });
      // #4352: the ambiguous_slug candidate list must not enumerate private slugs.
      if (excludePrivate && candidates.length > 0) {
        candidates = await dropPrivateSlugs(ctx.engine, candidates, fuzzyScope, includeDeleted);
      }
      if (candidates.length === 1) {
        const fuzzyPage = await ctx.engine.getPageIdentity(candidates[0], { includeDeleted, excludePrivate, ...sourceOpts });
        // Multi-source backstop: the slug may still resolve to a private
        // variant (same slug private in one source, world in another —
        // getPage returns the first in-scope match).
        if (fuzzyPage && !(excludePrivate && fuzzyPage.private)) {
          page = fuzzyPage;
          resolved_slug = candidates[0];
        }
      } else if (candidates.length > 1) {
        return { error: 'ambiguous_slug', candidates };
      }
    }

    if (!page) {
      let hint = includeDeleted ? 'Check the slug or use fuzzy: true' : 'Page may be soft-deleted; pass include_deleted: true to verify';
      // #4516: source scoping is by-design isolation, but the miss diagnostic
      // should say WHERE the slug actually lives. Trusted local callers only
      // (`ctx.remote === false`) — for a remote caller the probe would be a
      // cross-source existence oracle outside its grant. Only when the lookup
      // was actually scoped (an unscoped read already spanned every source).
      if (ctx.remote === false && (sourceOpts.sourceId !== undefined || sourceOpts.sourceIds !== undefined)) {
        try {
          // gbrain-allow-unscoped-getpage: read-only diagnostic existence probe —
          // deliberately spans all sources to name where the slug lives.
          const elsewhere = await ctx.engine.getPageIdentity(slug, { includeDeleted });
          if (elsewhere && !(excludePrivate && elsewhere.private)) {
            hint = `Page exists in source '${elsewhere.source_id}' — pass --source ${elsewhere.source_id} (source_id: '${elsewhere.source_id}' over MCP). ${hint}`;
          }
        } catch {
          // Diagnostic only — a probe failure must never mask the real error.
        }
      }
      throw new OperationError('page_not_found', `Page not found: ${slug}`, hint);
    }

    return { page: await admittedBody(ctx, page, 'get_page', includeDeleted, sourceIdParam), resolved_slug };
}

export async function readFetchPage(ctx: OperationContext, p: Record<string, unknown>): Promise<Page> {
  const id = p.id as string;
  if (typeof id !== 'string' || !id.trim()) {
    throw new OperationError('invalid_params', 'fetch requires a non-empty id', 'Pass the `id` field from a `search` result.');
  }
  const slug = id.trim();
  // Preserve fetch's selection-before-privacy precedence, distinct from get_page.
  const scope = federatedSearchScope(ctx);
  let identity = await ctx.engine.getPageIdentity(slug, scope);
  if (identity?.private && await resolveExcludePrivatePages(ctx.engine, ctx.remote)) identity = null;
  if (!identity) throw new OperationError('page_not_found', `Page not found: ${slug}`, 'Pass an id returned by a `search` call.');
  return admittedBody(ctx, identity, 'fetch', false);
}
