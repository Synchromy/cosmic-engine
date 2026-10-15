/**
 * Host-only link and timeline backfill held to the original writer's grant
 * (cosmic-hub #610). Upstream can publish plain remote mention links, but
 * does not expose this writer-scoped typed reconciliation operation.
 *
 * The page must be inside its writer's slug fence and write source, and that
 * source must be readable by the writer. Only existing, same-source targets
 * visible to remote readers participate. Incoming edges and withheld targets'
 * existing edges are left alone. Timeline entries belong to this page only.
 * Both publication paths reject a page changed since the host read it.
 * Dry runs count candidates and leave no committed writes.
 */

import type { Operation } from './contract.ts';
import { OperationError } from './contract.ts';
import { slugUnderBoundPrefixes } from './context.ts';
import { reconcileLinksForWriter, type WithheldTargets } from './reconcile-writer-links.ts';
import { isAutoLinkEnabled, isAutoTimelineEnabled, parseTimelineEntries } from '../link-extraction.ts';
import { privatePagesFilterFragment, resolveExcludePrivatePages } from '../search/private-visibility.ts';

function stringList(v: unknown, name: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new OperationError('invalid_params', `reconcile_page_links: ${name} must be an array of strings.`);
  }
  return v as string[];
}

const reconcile_page_links: Operation = {
  name: 'reconcile_page_links',
  description: 'Local only. Run link and timeline reconciliation for one page a remote writer wrote, held to that writer\'s grant: outbound edges only, only to existing pages it may read, timeline entries on this page only. Called by the host after a remote put_page, never by the writer.',
  params: {
    slug: { type: 'string', required: true, description: 'The page the remote writer wrote.' },
    source_id: { type: 'string', required: true, description: "The writer's write source, which holds the page." },
    read_sources: { type: 'array', required: true, items: { type: 'string' }, description: 'The sources the writer may read (its federated read grant). Nothing is linked unless source_id is one of them.' },
    bound_slug_prefixes: { type: 'array', items: { type: 'string' }, description: "The writer's slug fence, when it has one. The page must sit inside it." },
  },
  mutating: true,
  scope: 'admin',
  localOnly: true,
  handler: async (ctx, p) => {
    if (ctx.remote !== false) {
      throw new OperationError(
        'permission_denied',
        'reconcile_page_links runs on the host only: it decides from a writer\'s grant which of its links become edges.',
      );
    }
    const slug = p.slug as string;
    const sourceId = p.source_id as string;
    if (typeof slug !== 'string' || slug.length === 0) throw new OperationError('invalid_params', 'reconcile_page_links: slug is required.');
    if (typeof sourceId !== 'string' || sourceId.length === 0) throw new OperationError('invalid_params', 'reconcile_page_links: source_id is required.');
    const readSources = stringList(p.read_sources, 'read_sources');
    const fence = p.bound_slug_prefixes === undefined || p.bound_slug_prefixes === null
      ? null : stringList(p.bound_slug_prefixes, 'bound_slug_prefixes');

    const base = { slug, source_id: sourceId, ...(ctx.dryRun ? { dry_run: true } : {}) };
    if (!readSources.includes(sourceId)) return { ...base, skipped: 'write_source_not_readable' };
    // An empty fence admits nothing, as the client fence does (fail closed).
    if (fence !== null && !slugUnderBoundPrefixes(fence, slug)) return { ...base, skipped: 'outside_writer_fence' };

    const page = await ctx.engine.getPage(slug, { sourceId });
    if (!page) return { ...base, skipped: 'page_not_found' };
    const parsed = {
      type: page.type,
      compiled_truth: page.compiled_truth ?? '',
      timeline: page.timeline ?? '',
      frontmatter: (page.frontmatter ?? {}) as Record<string, unknown>,
    };

    const excludePrivate = await resolveExcludePrivatePages(ctx.engine, true);
    // Inside the reconcile's transaction, after its per-page lock:
    //  - the page must still be the revision read above, so a reconcile that
    //    waited behind a newer write never puts back the older text's edges
    //    (it fails, and the caller retries on the current text);
    //  - every target row is locked FOR SHARE before its visibility is read,
    //    so none can turn private before this commits.
    const withheldTargets: WithheldTargets = async (slugs, exec) => {
      const now = await exec(
        `SELECT p.id, p.content_hash, p.knowledge_revision FROM pages p WHERE p.source_id = $1 AND p.slug = $2 FOR SHARE`,
        [sourceId, slug],
      );
      if (now.length === 0 || String(now[0].id) !== String(page.id) || (now[0].content_hash ?? null) !== (page.content_hash ?? null)
        || (now[0].knowledge_revision ?? null) !== (page.knowledge_revision ?? null)) {
        throw new OperationError('unavailable', `reconcile_page_links: ${slug} changed while it was being reconciled; run it again.`);
      }
      if (!excludePrivate || slugs.length === 0) return new Set();
      const rows = await exec(
        `SELECT p.slug, NOT (${privatePagesFilterFragment('p')}) AS private
           FROM pages p
          WHERE p.source_id = $1 AND p.slug = ANY($2::text[])
          FOR SHARE`,
        [sourceId, slugs],
      );
      return new Set(rows.filter((r) => r.private === true).map((r) => String(r.slug)));
    };

    let autoLinks: Record<string, unknown>;
    try {
      if (!(await isAutoLinkEnabled(ctx.engine))) {
        autoLinks = { skipped: 'disabled' };
      } else {
        const r = await reconcileLinksForWriter(ctx.engine, slug, parsed, { sourceId, withheldTargets, dryRun: ctx.dryRun });
        autoLinks = {
          created: r.created, removed: r.removed, errors: r.errors, unresolved: r.unresolved,
          withheld: r.withheld, left_as_text: r.leftAsText,
        };
      }
    } catch (e) {
      autoLinks = { error: e instanceof Error ? e.message : String(e) };
    }

    let autoTimeline: Record<string, unknown>;
    try {
      if (!(await isAutoTimelineEnabled(ctx.engine))) {
        autoTimeline = { skipped: 'disabled' };
      } else {
        // The same rows put_page's trusted path writes, on this page only.
        // ON CONFLICT DO NOTHING keeps a rerun from duplicating them.
        const entries = parseTimelineEntries(parsed.compiled_truth + '\n' + parsed.timeline);
        if (entries.length === 0 || ctx.dryRun) {
          autoTimeline = ctx.dryRun ? { entries: entries.length } : { created: 0 };
        } else {
          const created = await ctx.engine.transaction(async tx => {
            await tx.lockPageKeys([{ sourceId, slug }]);
            await withheldTargets([], (sql, params) => tx.executeRaw(sql, params));
            return tx.addTimelineEntriesBatch(entries.map((e) => ({
              slug, date: e.date, source: e.source, summary: e.summary, detail: e.detail || '', source_id: sourceId,
            })), { auditSite: 'mcp.put_page.autolink' });
          });
          autoTimeline = { created };
        }
      }
    } catch (e) {
      autoTimeline = { error: e instanceof Error ? e.message : String(e) };
    }

    return { ...base, auto_links: autoLinks, auto_timeline: autoTimeline };
  },
  cliHints: { name: 'reconcile-page-links', hidden: true },
};

export const reconcilePageLinksOperations: Operation[] = [reconcile_page_links];
