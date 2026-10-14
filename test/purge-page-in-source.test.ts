// purge_page must clear its fact/take suppression while preserving earlier upstream purges.
// Page-only tombstone checks miss this regression; seeded claims expose it without a new production seam.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { readPagePurgeTombstones } from '../src/core/persistence/page-purge.ts';
import { managedPersistenceEnabled } from '../src/core/persistence/ownership.ts';
import { withEnv } from './helpers/with-env.ts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-purge-source-'));
const callPurge = (ctx: OperationContext, params: Record<string, unknown>) =>
  withEnv({ GBRAIN_HOME: home }, () => purgePage.handler(ctx, params));

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 20_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
});

function localCtx(sourceId = 'default'): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId,
  } as OperationContext;
}

const purgePage = operations.find(op => op.name === 'purge_page')!;
const deletePage = operations.find(op => op.name === 'delete_page')!;

async function addSource(id: string): Promise<void> {
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $2)', [id, id]);
}

async function seed(slug: string, sourceId: string) {
  const page = await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'first version' }, { sourceId });
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'rewritten version' }, { sourceId });
  await engine.createVersion(slug, { sourceId });
  await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: 'page text', chunk_source: 'compiled_truth' }], { sourceId });
  await engine.executeRaw('INSERT INTO links (from_page_id, to_page_id) VALUES ($1, $1)', [page.id]);
  return page;
}

async function count(table: 'pages' | 'content_chunks' | 'page_versions' | 'links', pageId: number): Promise<number> {
  const rows = await engine.executeRaw<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${table} WHERE ${table === 'pages' ? 'id' : table === 'links' ? 'from_page_id' : 'page_id'} = $1`, [pageId]);
  return Number(rows[0]!.count);
}

async function seedClaims(page: { id: number; slug: string }, sourceId: string): Promise<void> {
  await engine.executeRaw(`INSERT INTO facts(source_id,fact,kind,source,source_markdown_slug,row_num)
    VALUES ($1,$2,'fact','test',$3,1)`, [sourceId, `Fact for ${page.slug}`, page.slug]);
  await engine.executeRaw(`INSERT INTO takes(page_id,row_num,claim,kind,holder)
    VALUES ($1,1,$2,'take','brain')`, [page.id, `Take for ${page.slug}`]);
}

describe('purge_page in one source', () => {
  it('purges a managed soft-deleted row with its chunks, versions and links without leaving its tombstone', async () => {
    await addSource('source-a');
    const page = await seed('notes/soft-deleted', 'source-a');
    // Upstream requires the current revision to soft-delete an existing page.
    const snapshot = await engine.readPageSnapshot(page.slug, { sourceId: 'source-a' });
    await withEnv({ GBRAIN_HOME: home }, () => deletePage.handler(localCtx('source-a'), { slug: page.slug, source_id: 'source-a', expected_revision: snapshot!.revision }));
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    expect(await managedPersistenceEnabled(engine)).toBe(true);
    expect(await count('links', page.id)).toBe(1);

    expect(await engine.getPage(page.slug, { sourceId: 'source-a', includeDeleted: true })).not.toBeNull();
    expect(await count('content_chunks', page.id)).toBeGreaterThan(0);
    expect(await count('page_versions', page.id)).toBeGreaterThan(0);
    expect(await callPurge(localCtx(), { slug: page.slug, source_id: 'source-a' })).toMatchObject({ removed: 1, status: 'purged' });
    expect(await engine.getPage(page.slug, { sourceId: 'source-a', includeDeleted: true })).toBeNull();
    expect(await count('pages', page.id)).toBe(0);
    expect(await count('content_chunks', page.id)).toBe(0);
    expect(await count('links', page.id)).toBe(0);
    expect(await count('page_versions', page.id)).toBe(0);
    expect([...(await readPagePurgeTombstones(engine, 'source-a')).values()]).not.toContain(page.slug);
  });

  it('purges a managed live row with its chunks, versions and links without leaving its tombstone', async () => {
    await addSource('source-a');
    const page = await seed('notes/live', 'source-a');
    await seedClaims(page, 'source-a');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    expect(await managedPersistenceEnabled(engine)).toBe(true);
    expect(await count('links', page.id)).toBe(1);

    const result = await callPurge(localCtx(), { slug: page.slug, source_id: 'source-a' });
    expect(result).toMatchObject({ removed: 1, status: 'purged' });
    expect(result).toMatchObject({ purge: { removed: { facts: 1, takes: 1 } } });
    for (const table of ['fact_purges', 'take_purges']) {
      expect(await engine.executeRaw(`SELECT p.* FROM ${table} p JOIN persistence_requests r ON p.request_id=r.id
        WHERE p.source_id=$1 AND r.source_id=$1 AND r.slug=$2 AND r.request_id=$3::uuid`,
      ['source-a', page.slug, result.request_id])).toHaveLength(0);
    }
    expect(await engine.getPage(page.slug, { sourceId: 'source-a', includeDeleted: true })).toBeNull();
    expect(await count('content_chunks', page.id)).toBe(0);
    expect(await count('pages', page.id)).toBe(0);
    expect(await count('links', page.id)).toBe(0);
    expect(await count('page_versions', page.id)).toBe(0);
    expect([...(await readPagePurgeTombstones(engine, 'source-a')).values()]).not.toContain(page.slug);
  });

  it('still purges a row on an unmanaged brain', async () => {
    await addSource('source-a');
    const page = await seed('notes/unmanaged', 'source-a');
    expect(await managedPersistenceEnabled(engine)).toBe(false);
    expect(await callPurge(localCtx(), { slug: page.slug, source_id: 'source-a' })).toMatchObject({ removed: 1, status: 'purged' });
    expect(await count('pages', page.id)).toBe(0);
    expect(await count('content_chunks', page.id)).toBe(0);
    expect(await count('links', page.id)).toBe(0);
    expect(await count('page_versions', page.id)).toBe(0);
    expect([...(await readPagePurgeTombstones(engine, 'source-a')).values()]).not.toContain(page.slug);
  });

  it('allows placeCopy to rewrite identical content at the same slug and another slug on a managed brain', async () => {
    await addSource('source-a');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    expect(await managedPersistenceEnabled(engine)).toBe(true);
    const putPage = operations.find(op => op.name === 'put_page')!;
    const content = '---\ntype: note\ntitle: Beam copy\n---\n# Beam copy\n\nIdentical beam text.\n';
    const put = (slug: string) => withEnv({ GBRAIN_HOME: home }, () =>
      putPage.handler(localCtx('source-a'), { slug, source_id: 'source-a', content }));

    await put('beam/example');
    const original = await engine.getPage('beam/example', { sourceId: 'source-a' });
    expect(original).not.toBeNull();
    expect(await callPurge(localCtx(), { slug: 'beam/example', source_id: 'source-a' })).toMatchObject({ removed: 1, status: 'purged' });

    for (const slug of ['beam/example', 'beam/another-copy']) {
      expect(await put(slug)).toMatchObject({ state: 'committed', page_outcome: 'created' });
      const placed = await engine.getPage(slug, { sourceId: 'source-a' });
      expect(placed).not.toBeNull();
      expect(placed!.compiled_truth).toBe(original!.compiled_truth);
      expect(placed!.content_hash).toBe(original!.content_hash);
    }
    expect([...(await readPagePurgeTombstones(engine, 'source-a')).values()]).not.toContain('beam/example');
  });

  it('preserves an earlier upstream purge tombstone for another slug in the same source', async () => {
    await addSource('source-a');
    const upstreamPage = await engine.putPage('notes/upstream-purge', { type: 'note', title: 'Upstream purge', compiled_truth: 'Previously purged content.' }, { sourceId: 'source-a' });
    await seedClaims(upstreamPage, 'source-a');
    const page = await seed('beam/example', 'source-a');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const snapshot = await engine.readPageSnapshot('notes/upstream-purge', { sourceId: 'source-a' });
    expect(await withEnv({ GBRAIN_HOME: home }, () => deletePage.handler(localCtx('source-a'), {
      slug: 'notes/upstream-purge', source_id: 'source-a', purge: true, expected_revision: snapshot!.revision,
    }))).toMatchObject({ status: 'purged' });
    const earlier = await engine.executeRaw('SELECT * FROM page_purges WHERE source_id=$1 AND slug=$2', ['source-a', 'notes/upstream-purge']);
    expect(earlier.length).toBeGreaterThan(0);
    const earlierClaims = await Promise.all(['fact_purges', 'take_purges'].map(table =>
      engine.executeRaw(`SELECT * FROM ${table} WHERE source_id=$1 AND request_id IN
        (SELECT request_id FROM page_purges WHERE source_id=$1 AND slug=$2)`, ['source-a', 'notes/upstream-purge'])));
    for (const rows of earlierClaims) expect(rows).toHaveLength(1);

    expect(await callPurge(localCtx(), { slug: page.slug, source_id: 'source-a' })).toMatchObject({ removed: 1, status: 'purged' });
    expect([...(await readPagePurgeTombstones(engine, 'source-a')).values()]).not.toContain(page.slug);
    expect(await engine.executeRaw('SELECT * FROM page_purges WHERE source_id=$1 AND slug=$2', ['source-a', 'notes/upstream-purge'])).toEqual(earlier);
    for (const [index, table] of ['fact_purges', 'take_purges'].entries()) {
      expect(await engine.executeRaw(`SELECT * FROM ${table} WHERE source_id=$1 AND request_id IN
        (SELECT request_id FROM page_purges WHERE source_id=$1 AND slug=$2)`, ['source-a', 'notes/upstream-purge'])).toEqual(earlierClaims[index]);
    }
  });

  it('dry run answers without deleting a live row, its chunks, or its versions', async () => {
    await addSource('source-a');
    const page = await seed('notes/dry-run', 'source-a');

    await expect(callPurge({ ...localCtx('source-a'), dryRun: true }, {
      slug: page.slug,
      source_id: 'source-a',
    })).resolves.toEqual({ dry_run: true, action: 'purge_page', slug: page.slug, source_id: 'source-a' });
    expect(await engine.getPage(page.slug, { sourceId: 'source-a', includeDeleted: true })).not.toBeNull();
    expect(await count('pages', page.id)).toBe(1);
    expect(await count('content_chunks', page.id)).toBeGreaterThan(0);
    expect(await count('page_versions', page.id)).toBeGreaterThan(0);
    expect(await count('links', page.id)).toBe(1);
    expect((await readPagePurgeTombstones(engine, 'source-a')).size).toBe(0);
  });

  it('leaves the same slug in another source untouched', async () => {
    await addSource('source-a');
    await addSource('source-b');
    const pageA = await seed('notes/shared', 'source-a');
    const pageB = await seed('notes/shared', 'source-b');

    expect(await callPurge(localCtx(), { slug: 'notes/shared', source_id: 'source-a' })).toMatchObject({ removed: 1, status: 'purged' });
    expect(await engine.getPage('notes/shared', { sourceId: 'source-a', includeDeleted: true })).toBeNull();
    expect((await engine.getPage('notes/shared', { sourceId: 'source-b' }))!.compiled_truth).toBe('rewritten version');
    expect(await count('content_chunks', pageB.id)).toBe(1);
    expect(await count('page_versions', pageB.id)).toBe(1);
    expect(await count('pages', pageA.id)).toBe(0);
    expect(await count('links', pageB.id)).toBe(1);
    expect((await readPagePurgeTombstones(engine, 'source-b')).size).toBe(0);
  });

  it('answers removed: 0 for a missing row', async () => {
    await addSource('source-a');
    await expect(callPurge(localCtx(), { slug: 'notes/missing', source_id: 'source-a' })).resolves.toEqual({ removed: 0 });
  });

  it('refuses untrusted callers before validation or dry-run', async () => {
    for (const remote of [true, undefined]) {
      await expect(callPurge({ ...localCtx(), remote, dryRun: true } as OperationContext, {})).rejects.toMatchObject({ code: 'permission_denied' });
    }
  });

  it('validates slugs even on a dry-run or missing row', async () => {
    for (const dryRun of [true, false]) {
      await expect(callPurge({ ...localCtx(), dryRun }, { slug: '../invalid', source_id: 'default' })).rejects.toMatchObject({ code: 'invalid_params' });
    }
  });

  it('requires source_id without falling back to default and is admin local-only mutating', async () => {
    await engine.putPage('notes/default-copy', { type: 'note', title: 'default', compiled_truth: 'must remain' });

    await expect(callPurge(localCtx(), { slug: 'notes/default-copy' })).rejects.toMatchObject({ code: 'invalid_params' });
    expect(await engine.getPage('notes/default-copy', { sourceId: 'default' })).not.toBeNull();
    expect(purgePage.params.source_id?.required).toBe(true);
    expect(purgePage.scope).toBe('admin');
    expect(purgePage.localOnly).toBe(true);
    expect(purgePage.mutating).toBe(true);
  });
});
