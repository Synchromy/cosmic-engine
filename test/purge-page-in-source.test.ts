import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 20_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
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
  return page;
}

async function count(table: 'pages' | 'content_chunks' | 'page_versions', pageId: number): Promise<number> {
  const rows = await engine.executeRaw<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${table} WHERE ${table === 'pages' ? 'id' : 'page_id'} = $1`, [pageId]);
  return Number(rows[0]!.count);
}

describe('purge_page in one source', () => {
  it('removes a soft-deleted row together with its chunks and versions', async () => {
    await addSource('source-a');
    const page = await seed('notes/soft-deleted', 'source-a');
    // Upstream requires the current revision to soft-delete an existing page.
    const snapshot = await engine.readPageSnapshot(page.slug, { sourceId: 'source-a' });
    await deletePage.handler(localCtx('source-a'), { slug: page.slug, source_id: 'source-a', expected_revision: snapshot!.revision });

    expect(await engine.getPage(page.slug, { sourceId: 'source-a', includeDeleted: true })).not.toBeNull();
    expect(await count('content_chunks', page.id)).toBeGreaterThan(0);
    expect(await count('page_versions', page.id)).toBeGreaterThan(0);
    expect(await purgePage.handler(localCtx(), { slug: page.slug, source_id: 'source-a' })).toEqual({ removed: 1 });
    expect(await engine.getPage(page.slug, { sourceId: 'source-a', includeDeleted: true })).toBeNull();
    expect(await count('pages', page.id)).toBe(0);
    expect(await count('content_chunks', page.id)).toBe(0);
    expect(await count('page_versions', page.id)).toBe(0);
  });

  it('removes a live row and its chunks', async () => {
    await addSource('source-a');
    const page = await seed('notes/live', 'source-a');

    expect(await purgePage.handler(localCtx(), { slug: page.slug, source_id: 'source-a' })).toEqual({ removed: 1 });
    expect(await engine.getPage(page.slug, { sourceId: 'source-a', includeDeleted: true })).toBeNull();
    expect(await count('content_chunks', page.id)).toBe(0);
  });

  it('dry run answers without deleting a live row, its chunks, or its versions', async () => {
    await addSource('source-a');
    const page = await seed('notes/dry-run', 'source-a');

    await expect(purgePage.handler({ ...localCtx('source-a'), dryRun: true }, {
      slug: page.slug,
      source_id: 'source-a',
    })).resolves.toEqual({ dry_run: true, action: 'purge_page', slug: page.slug, source_id: 'source-a' });
    expect(await engine.getPage(page.slug, { sourceId: 'source-a', includeDeleted: true })).not.toBeNull();
    expect(await count('pages', page.id)).toBe(1);
    expect(await count('content_chunks', page.id)).toBeGreaterThan(0);
    expect(await count('page_versions', page.id)).toBeGreaterThan(0);
  });

  it('leaves the same slug in another source untouched', async () => {
    await addSource('source-a');
    await addSource('source-b');
    const pageA = await seed('notes/shared', 'source-a');
    const pageB = await seed('notes/shared', 'source-b');

    expect(await purgePage.handler(localCtx(), { slug: 'notes/shared', source_id: 'source-a' })).toEqual({ removed: 1 });
    expect(await engine.getPage('notes/shared', { sourceId: 'source-a', includeDeleted: true })).toBeNull();
    expect((await engine.getPage('notes/shared', { sourceId: 'source-b' }))!.compiled_truth).toBe('rewritten version');
    expect(await count('content_chunks', pageB.id)).toBe(1);
    expect(await count('page_versions', pageB.id)).toBe(1);
    expect(await count('pages', pageA.id)).toBe(0);
  });

  it('answers removed: 0 for a missing row', async () => {
    await addSource('source-a');
    await expect(purgePage.handler(localCtx(), { slug: 'notes/missing', source_id: 'source-a' })).resolves.toEqual({ removed: 0 });
  });

  it('requires source_id without falling back to default and is admin local-only mutating', async () => {
    await engine.putPage('notes/default-copy', { type: 'note', title: 'default', compiled_truth: 'must remain' });

    await expect(purgePage.handler(localCtx(), { slug: 'notes/default-copy' })).rejects.toMatchObject({ code: 'invalid_params' });
    expect(await engine.getPage('notes/default-copy', { sourceId: 'default' })).not.toBeNull();
    expect(purgePage.params.source_id?.required).toBe(true);
    expect(purgePage.scope).toBe('admin');
    expect(purgePage.localOnly).toBe(true);
    expect(purgePage.mutating).toBe(true);
  });
});
