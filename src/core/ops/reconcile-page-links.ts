/**
 * reconcile_page_links: the link and timeline reconciliation a page written
 * by a remote writer never got, run afterwards by the trusted host for that
 * writer, held to what the writer may read (cosmic-hub #610).
 *
 * put_page skips auto-link and auto-timeline for every remote caller
 * (ops/pages.ts, `auto_links: {skipped: 'remote'}`). The reason given there:
 * the bare-slug and wikilink extractor matches anything in the body, so an
 * untrusted page could plant outbound edges, and the backlink boost in search
 * would then lift whatever it pointed at. Every agent writing over MCP is such
 * a caller, so its wikilinks never become edges and the graph reads cannot
 * see them.
 *
 * This op lets the host (which knows the writer's grant) run the same
 * reconciliation for one page, with limits that keep the skip's purpose:
 *
 *   - local only. A remote caller never reaches it, so no writer can ask for
 *     its own edges; the host decides, per write, from the writer's grant.
 *   - the page must sit in the writer's write source, inside its slug fence
 *     when it has one, and the write source must be one it reads. Auto-link
 *     is same-source (runAutoLink), so every edge then lands on a page in a
 *     source the writer reads.
 *   - outbound only: no incoming frontmatter edge, which would originate on
 *     another page, is created or removed.
 *   - no edge to, or from the reconcile's removal side touching, a target the
 *     writer cannot read: a `visibility: private` page when remote readers do
 *     not see private pages (search/private-visibility.ts).
 *   - a target must already exist; a reference to a missing page stays text
 *     and is counted, never creates a page.
 *   - timeline entries go on this page only, exactly as put_page writes them.
 *
 * `dry_run: true` counts what would change and writes nothing.
 */

import type { Operation } from './contract.ts';
import { OperationError } from './contract.ts';
import { slugUnderBoundPrefixes } from './context.ts';
import { reconcileLinksForWriter } from './pages.ts';
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
    const withheldTargets = async (slugs: string[]): Promise<Set<string>> => {
      if (!excludePrivate || slugs.length === 0) return new Set();
      const rows = await ctx.engine.executeRaw<{ slug: string }>(
        `SELECT p.slug FROM pages p
          WHERE p.source_id = $1 AND p.slug = ANY($2::text[])
            AND NOT (${privatePagesFilterFragment('p')})`,
        [sourceId, slugs],
      );
      return new Set(rows.map((r) => r.slug));
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
          const created = await ctx.engine.addTimelineEntriesBatch(entries.map((e) => ({
            slug, date: e.date, source: e.source, summary: e.summary, detail: e.detail || '', source_id: sourceId,
          })), { auditSite: 'mcp.put_page.autolink' });
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
