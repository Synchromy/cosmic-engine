/**
 * Cosmic carried patch `reconcile-page-links` (cosmic-hub #610).
 *
 * put_page skips link and timeline reconciliation for every remote writer, so
 * an agent's wikilinks stay text. reconcile_page_links lets the host run that
 * reconciliation for one page afterwards, held to the writer's grant:
 * outbound only, to existing pages the writer may read, timeline entries on
 * the page itself, nothing when the write source is not readable or the page
 * is outside the writer's fence. Local only.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { __resetPrivateVisibilityCacheForTests, REMOTE_PRIVATE_PAGES_KEY } from '../src/core/search/private-visibility.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 240000);

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
}, 120000);

beforeEach(async () => {
  await resetPgliteState(engine);
  resetGateway();
  __resetPrivateVisibilityCacheForTests();
}, 120000);

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  };
}

const putPage = operations.find((o) => o.name === 'put_page')!;
const reconcile = operations.find((o) => o.name === 'reconcile_page_links')!;

async function putLocal(slug: string, content: string) {
  await putPage.handler(makeCtx(), { slug, content });
}

async function putRemote(slug: string, content: string, boundSlugPrefixes?: string[]) {
  return (await putPage.handler(makeCtx({
    remote: true,
    ...(boundSlugPrefixes ? { auth: { token: 't', clientId: 'c', scopes: ['read', 'write'], boundSlugPrefixes } as never } : {}),
  }), { slug, content })) as Record<string, any>;
}

async function run(params: Record<string, unknown>, ctx: Partial<OperationContext> = {}) {
  return (await reconcile.handler(makeCtx(ctx), params)) as Record<string, any>;
}

const outTargets = async (slug: string) => (await engine.getLinks(slug, { sourceId: 'default' })).map((l) => l.to_slug).sort();

async function seedTargets() {
  await putLocal('people/alice-example', '---\ntitle: Alice Example\ntype: person\n---\n\nA person.');
  await putLocal('people/charlie-example', '---\ntitle: Charlie Example\ntype: person\n---\n\nAnother person.');
  await putLocal('handoffs/2026-10-01-earlier', '---\ntitle: Earlier handoff\n---\n\nThe handoff before.');
  await putLocal('people/private-example', '---\ntitle: Private Example\ntype: person\nvisibility: private\n---\n\nKept from remote readers.');
}

const HANDOFF = [
  '---',
  'title: Handoff',
  '---',
  '',
  'Worked with [[people/alice-example]] and [[people/charlie-example]].',
  'Continues [[handoffs/2026-10-01-earlier]].',
  'Asked [[people/private-example]] too.',
  'Waiting on [[people/nobody-example]].',
  '',
  '## Timeline',
  '',
  '- **2026-10-13** | Handed the work over',
].join('\n');

describe('reconcile_page_links (cosmic-hub #610)', () => {
  test('a remote handoff page gets edges to the pages it links, and none to a page the writer cannot read', async () => {
    await seedTargets();
    const put = await putRemote('handoffs/2026-10-13-today', HANDOFF);
    expect(put.auto_links?.skipped).toBe('remote');
    expect(await outTargets('handoffs/2026-10-13-today')).toEqual([]);

    const r = await run({ slug: 'handoffs/2026-10-13-today', source_id: 'default', read_sources: ['default'] });
    expect(r.skipped).toBeUndefined();
    expect(r.auto_links).toMatchObject({ created: 3, removed: 0, errors: 0, withheld: 1, left_as_text: 1 });
    expect(await outTargets('handoffs/2026-10-13-today')).toEqual([
      'handoffs/2026-10-01-earlier', 'people/alice-example', 'people/charlie-example',
    ]);
    // The edges read from the target side, as backlinks and traverse do.
    const back = await engine.getBacklinks('people/alice-example', { sourceId: 'default' });
    expect(back.map((l) => l.from_slug)).toContain('handoffs/2026-10-13-today');
    // No edge to the private page, and no page made for the missing one.
    expect((await engine.getBacklinks('people/private-example', { sourceId: 'default' })).length).toBe(0);
    expect(await engine.getPage('people/nobody-example', { sourceId: 'default' })).toBeNull();
    // The timeline entry lands on the page itself.
    expect(r.auto_timeline).toMatchObject({ created: 1 });
    const tl = await engine.getTimeline('handoffs/2026-10-13-today', { sourceId: 'default' } as never);
    expect(tl.length).toBe(1);

    // A rerun changes nothing.
    const again = await run({ slug: 'handoffs/2026-10-13-today', source_id: 'default', read_sources: ['default'] });
    expect(again.auto_links).toMatchObject({ created: 0, removed: 0 });
    expect((await engine.getTimeline('handoffs/2026-10-13-today', { sourceId: 'default' } as never)).length).toBe(1);
  }, 120000);

  test('when remote readers may see private pages, the private target is linked too', async () => {
    await seedTargets();
    await engine.setConfig(REMOTE_PRIVATE_PAGES_KEY, 'visible');
    __resetPrivateVisibilityCacheForTests();
    await putRemote('handoffs/2026-10-13-today', HANDOFF);
    const r = await run({ slug: 'handoffs/2026-10-13-today', source_id: 'default', read_sources: ['default'] });
    expect(r.auto_links).toMatchObject({ created: 4, withheld: 0 });
    expect(await outTargets('handoffs/2026-10-13-today')).toContain('people/private-example');
  }, 120000);

  test('an edge a trusted write made to a page the writer cannot read is left alone', async () => {
    await seedTargets();
    await putLocal('notes/shared', '---\ntitle: Shared\n---\n\nSee [[people/private-example]] and [[people/alice-example]].');
    expect(await outTargets('notes/shared')).toEqual(['people/alice-example', 'people/private-example']);
    // A remote writer rewrites the page without either link.
    await putRemote('notes/shared', '---\ntitle: Shared\n---\n\nNo links any more, only [[people/charlie-example]].');
    const r = await run({ slug: 'notes/shared', source_id: 'default', read_sources: ['default'] });
    expect(r.auto_links).toMatchObject({ created: 1, removed: 1 });
    expect(await outTargets('notes/shared')).toEqual(['people/charlie-example', 'people/private-example']);
  }, 120000);

  test('nothing is linked when the write source is not one the writer reads', async () => {
    await seedTargets();
    await putRemote('handoffs/2026-10-13-today', HANDOFF);
    const r = await run({ slug: 'handoffs/2026-10-13-today', source_id: 'default', read_sources: ['other'] });
    expect(r.skipped).toBe('write_source_not_readable');
    expect(await outTargets('handoffs/2026-10-13-today')).toEqual([]);
  }, 120000);

  test('a fenced writer: its own page is linked, a page outside its fence is not', async () => {
    await seedTargets();
    const fence = ['inbox/agent-example/'];
    await putRemote('inbox/agent-example/note', HANDOFF, fence);
    const inside = await run({ slug: 'inbox/agent-example/note', source_id: 'default', read_sources: ['default'], bound_slug_prefixes: fence });
    expect(inside.auto_links).toMatchObject({ created: 3, withheld: 1 });

    await putLocal('notes/not-theirs', HANDOFF);
    const outside = await run({ slug: 'notes/not-theirs', source_id: 'default', read_sources: ['default'], bound_slug_prefixes: fence });
    expect(outside.skipped).toBe('outside_writer_fence');
    // An empty fence admits nothing.
    const empty = await run({ slug: 'inbox/agent-example/note', source_id: 'default', read_sources: ['default'], bound_slug_prefixes: [] });
    expect(empty.skipped).toBe('outside_writer_fence');
  }, 120000);

  test('outbound only: a frontmatter edge that would start on another page is not made', async () => {
    await seedTargets();
    await putLocal('companies/acme-example', '---\ntitle: Acme Example\ntype: company\n---\n\nA company.');
    const company = '---\ntitle: Acme Example\ntype: company\nkey_people:\n  - Alice Example\n---\n\nA company with people.';
    // Trusted control: the same write makes an edge that starts on alice's page.
    await putLocal('companies/acme-example', company);
    const trusted = (await engine.getBacklinks('companies/acme-example', { sourceId: 'default' }))
      .filter((l) => l.from_slug === 'people/alice-example');
    // Reset, then the remote write and the host reconcile.
    await engine.executeRaw(`DELETE FROM links`);
    await putRemote('companies/acme-example', company + '\n');
    await run({ slug: 'companies/acme-example', source_id: 'default', read_sources: ['default'] });
    const remote = (await engine.getBacklinks('companies/acme-example', { sourceId: 'default' }))
      .filter((l) => l.from_slug === 'people/alice-example');
    expect(remote.length).toBe(0);
    // The control shows the frontmatter field really does produce such an edge.
    expect(trusted.length).toBeGreaterThan(0);
  }, 120000);

  test('dry run counts and writes nothing', async () => {
    await seedTargets();
    await putRemote('handoffs/2026-10-13-today', HANDOFF);
    const r = await run({ slug: 'handoffs/2026-10-13-today', source_id: 'default', read_sources: ['default'] }, { dryRun: true });
    expect(r.dry_run).toBe(true);
    expect(r.auto_links).toMatchObject({ created: 3, withheld: 1, left_as_text: 1 });
    expect(r.auto_timeline).toMatchObject({ entries: 1 });
    expect(await outTargets('handoffs/2026-10-13-today')).toEqual([]);
  }, 120000);

  test('a missing page is reported, not an error', async () => {
    const r = await run({ slug: 'handoffs/none', source_id: 'default', read_sources: ['default'] });
    expect(r.skipped).toBe('page_not_found');
  }, 120000);

  test('local only: a remote caller is refused, and the op never enters a remote grant', async () => {
    expect(reconcile.localOnly).toBe(true);
    await expect(run({ slug: 'x', source_id: 'default', read_sources: ['default'] }, { remote: true })).rejects.toThrow(/host only/);
  }, 120000);
});
