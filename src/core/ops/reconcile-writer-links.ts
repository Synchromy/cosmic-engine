import type { BrainEngine } from '../engine.ts';
import type { PageType } from '../types.ts';
import { extractPageLinks, makeResolver, isGlobalBasenameEnabled, type UnresolvedFrontmatterRef } from '../link-extraction.ts';
import { loadActivePackForLocalEngine } from '../schema-pack/best-effort.ts';
import { readLineGrammarSettings } from '../line-grammar.ts';

/** Checked inside the publication transaction; failures roll the reconciliation back. */
export type WithheldTargets = (
  slugs: string[],
  exec: (sql: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>,
) => Promise<Set<string>>;

interface WriterLinkResult {
  created: number; removed: number; errors: number;
  unresolved: UnresolvedFrontmatterRef[]; withheld: number; leftAsText: number;
}

/** Reconcile only this writer's outbound, same-source, readable derived edges. */
export async function reconcileLinksForWriter(
  engine: BrainEngine,
  slug: string,
  page: { type: PageType; compiled_truth: string; timeline: string; frontmatter: Record<string, unknown> },
  opts: { sourceId: string; withheldTargets: WithheldTargets; dryRun?: boolean },
) {
  const { sourceId } = opts;
  const settings = await readLineGrammarSettings(engine);
  const pack = (await loadActivePackForLocalEngine(engine, { sourceId }))?.manifest ?? null;
  const { candidates, unresolved } = await extractPageLinks(
    slug, `${page.compiled_truth}\n${page.timeline}`, page.frontmatter, page.type,
    makeResolver(engine, { mode: 'live', sourceId }),
    { globalBasename: await isGlobalBasenameEnabled(engine), pack,
      lineGrammar: { enabled: settings.enabled, allowUndeclaredTypes: settings.allowUndeclaredTypes } },
  );
  // An incoming frontmatter edge belongs to another page. Explicit cross-source
  // references must never fall back to a same-slug page in the write source.
  const outbound = candidates.filter(c => (!c.fromSlug || c.fromSlug === slug)
    && (!c.targetSourceId || c.targetSourceId === sourceId));
  const named = [...new Set(outbound.map(c => c.targetSlug))];
  const previewRollback = new Error('Rollback reconciliation preview');
  let preview: WriterLinkResult | undefined;
  return engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId, slug }]);
    const existing = await tx.getLinks(slug, { sourceId });
    const targets = [...new Set([...named, ...existing.map(l => l.to_slug)])];
    // Lock before testing visibility or existence so a target cannot turn
    // private, disappear or be replaced between the check and publication.
    const rows = targets.length ? await tx.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE source_id=$1 AND slug=ANY($2::text[])
        AND deleted_at IS NULL ORDER BY slug FOR SHARE`, [sourceId, targets],
    ) : [];
    const live = new Set(rows.map(r => r.slug));
    const withheld = await opts.withheldTargets(targets, (sql, params) => tx.executeRaw(sql, params));
    const desired = outbound.filter(c => live.has(c.targetSlug) && !withheld.has(c.targetSlug));
    const reconcilable = existing.filter(l => l.to_source_id === sourceId && !withheld.has(l.to_slug)
      && (l.link_source === 'markdown' || l.link_source == null || l.link_source === 'wikilink-resolved'
        || (l.link_source === 'frontmatter' && l.origin_slug === slug && l.origin_source_id === sourceId)));
    const key = (target: string, type: string | null | undefined, producer: string | null | undefined) =>
      `${target}\0${type ?? ''}\0${producer ?? 'markdown'}`;
    const wantedKeys = new Set(desired.map(c => key(c.targetSlug, c.linkType, c.linkSource)));
    const existingKeys = new Set(reconcilable.map(l => key(l.to_slug, l.link_type, l.link_source)));
    let created = 0, removed = 0;
    for (const c of desired) {
      const k = key(c.targetSlug, c.linkType, c.linkSource);
      if (!opts.dryRun) await tx.addLink(slug, c.targetSlug, c.context, c.linkType,
        c.linkSource, c.originSlug ?? slug, c.originField,
        { fromSourceId: sourceId, toSourceId: sourceId, originSourceId: sourceId });
      if (!existingKeys.has(k)) { created++; existingKeys.add(k); }
    }
    for (const l of reconcilable) {
      if (wantedKeys.has(key(l.to_slug, l.link_type, l.link_source))) continue;
      if (!opts.dryRun) await tx.removeLink(slug, l.to_slug, l.link_type, l.link_source ?? undefined,
        { fromSourceId: sourceId, toSourceId: sourceId });
      removed++;
    }
    const result = { created, removed, errors: 0, unresolved,
      withheld: new Set(outbound.filter(c => live.has(c.targetSlug) && withheld.has(c.targetSlug)).map(c => c.targetSlug)).size,
      leftAsText: named.filter(target => !live.has(target)).length };
    // The canonical lock API may create a guard row for a legacy page. Even
    // that bookkeeping must roll back when the host asks for a dry run.
    if (opts.dryRun) { preview = result; throw previewRollback; }
    return result;
  }).catch(error => {
    if (error === previewRollback && preview) return preview;
    throw error;
  });
}
