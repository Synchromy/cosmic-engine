/**
 * `remember`'s entity resolution: the fact is filed under the page `entity`
 * shows for the same name, or it is not filed at all.
 *
 * Before this, an entity that matched no page fell back to its own slugified
 * form ("orgs/acme-example") and the fact was stored there with status
 * `inserted`: no page renders it, entity lookups never reach it, and the
 * caller was never told. A wrong directory prefix, or a product name whose
 * only title match is an unrelated file, lost facts silently.
 *
 * Order:
 *   1. The entity verb's resolution (alias > exact slug > exact title >
 *      slug-suffix). An alias or exact-slug hit is accepted whatever the
 *      page type: the caller named it. A title or slug-suffix hit is accepted
 *      only on an entity-shaped page (person, company, organization, entity,
 *      project), so a bare product name does not attach to a spreadsheet or
 *      a transcript that happens to share its title.
 *   2. The facts resolver's name arms (bare-name prefix expansion, fuzzy
 *      title match), which `remember` used before and which still reach
 *      `people/alice-example` from "Alice". Only a live page is accepted.
 *   3. Otherwise refuse: `not_found`, message `entity_not_found: ...`, with
 *      the nearest pages in the suggestion text and as JSON in `detail`.
 *
 * Refusing (rather than warning, or creating a stub page) is deliberate: a
 * warning still leaves the fact where nobody finds it, and a stub duplicates
 * the real page under the wrong slug. The caller retries with a suggested
 * slug, creates the page first, or omits the entity.
 */

import type { BrainEngine } from '../engine.ts';
import {
  ENTITY_SHAPED_TYPES,
  entityNearMisses,
  resolveEntityPage,
  type EntityMatchedBy,
  type EntitySuggestion,
} from './entity-card.ts';

export type RememberMatchedBy = EntityMatchedBy | 'name';

export interface RememberEntityTarget {
  slug: string;
  matched_by: RememberMatchedBy;
}

export async function resolveRememberEntity(
  engine: BrainEngine,
  sourceId: string,
  entity: string,
  opts: { remote: boolean },
): Promise<RememberEntityTarget> {
  const resolution = await resolveEntityPage(engine, sourceId, entity, opts);
  const best = resolution.best;
  if (best) {
    const named = best.matched_by === 'alias' || best.matched_by === 'slug';
    if (named || ENTITY_SHAPED_TYPES.has(best.type ?? '')) {
      return { slug: best.slug, matched_by: best.matched_by };
    }
  } else {
    const { resolveEntitySlugWithSource } = await import('../entities/resolve.ts');
    const legacy = await resolveEntitySlugWithSource(engine, sourceId, entity);
    if (legacy && legacy.source !== 'fallback_slugify' && await isVisiblePage(engine, sourceId, legacy.slug, opts)) {
      return { slug: legacy.slug, matched_by: legacy.source === 'exact_page' ? 'slug' : legacy.source === 'alias_exact' ? 'alias' : 'name' };
    }
  }

  // Refuse. A non-entity match is offered first: the caller may have meant it.
  const offered: EntitySuggestion[] = [];
  const seen = new Set<string>();
  const add = (s: EntitySuggestion) => {
    if (!seen.has(s.slug)) { seen.add(s.slug); offered.push(s); }
  };
  if (best) add({ slug: best.slug, title: best.title, create_safety: 'exists' });
  for (const s of resolution.runnersUp) add(s);
  for (const s of resolution.suggestions ?? await entityNearMisses(engine, sourceId, entity, opts)) add(s);
  const suggestions = offered.slice(0, 5);

  const { verbError } = await import('../ops/contract.ts');
  const why = best
    ? `"${entity}" matches only ${best.slug} by ${best.matched_by === 'title' ? 'title' : 'slug suffix'}, and that page is a ${best.type ?? 'untyped'} page, not a person, company, organization or project.`
    : `"${entity}" is not a page in this brain, so a fact filed under it would be invisible to entity lookups.`;
  const next = suggestions.length
    ? `Nearest pages: ${suggestions.map(s => `${s.slug} ("${s.title}", ${s.create_safety})`).join('; ')}. Retry with one of these slugs as entity, create the page first, or omit entity.`
    : 'Retry with an existing page slug as entity, create the page first, or omit entity.';
  throw verbError('not_found', `entity_not_found: ${why} Nothing was saved.`, next,
    JSON.stringify({ entity, suggestions }));
}

/** A live page this caller may see (private pages are hidden from remote callers, as in `entity`). */
async function isVisiblePage(engine: BrainEngine, sourceId: string, slug: string, opts: { remote: boolean }): Promise<boolean> {
  try {
    const { resolveExcludePrivatePages, privatePagesFilterFragment } = await import('../search/private-visibility.ts');
    const excludePrivate = await resolveExcludePrivatePages(engine, opts.remote ? undefined : false);
    const rows = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE deleted_at IS NULL AND source_id = $1 AND slug = $2${excludePrivate ? ` AND ${privatePagesFilterFragment('pages')}` : ''} LIMIT 1`,
      [sourceId, slug],
    );
    return rows.length === 1;
  } catch {
    return false;
  }
}
