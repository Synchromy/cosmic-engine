/** C-72 finding 6 — remote writes cannot create visible twins of restricted pages. */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  resetGateway();
});

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: true,
    sourceId: 'default',
    ...overrides,
  };
}

const putPage = operations.find(o => o.name === 'put_page')!;
const capture = operations.find(o => o.name === 'capture')!;

async function addSource(id: string): Promise<void> {
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $2)', [id, id]);
}

async function seedRestricted(slug = 'deals/acme', body = 'restricted original'): Promise<void> {
  await addSource('restricted');
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body }, { sourceId: 'restricted' });
}

async function expectDenied(call: Promise<unknown>): Promise<OperationError> {
  try {
    await call;
  } catch (error) {
    expect(error).toBeInstanceOf(OperationError);
    return error as OperationError;
  }
  throw new Error('expected permission_denied');
}

describe('restricted write guard', () => {
  test('refuses a remote put_page twin and leaves the restricted page unchanged', async () => {
    await seedRestricted();
    const error = await expectDenied(putPage.handler(makeCtx(), { slug: 'deals/acme', content: '# visible copy' }));
    expect(error.code).toBe('permission_denied');
    expect(error.message).toContain('deals/acme');
    expect(error.message).toContain('restricted');
    expect(error.suggestion).toContain("source_id 'restricted'");
    expect(await engine.getPage('deals/acme', { sourceId: 'default' })).toBeNull();
    expect((await engine.getPage('deals/acme', { sourceId: 'restricted' }))!.compiled_truth).toContain('restricted original');
  });

  test('refuses capture with an explicit restricted slug', async () => {
    await seedRestricted();
    const error = await expectDenied(capture.handler(makeCtx(), { slug: 'deals/acme', content: 'visible capture' }));
    expect(error.code).toBe('permission_denied');
    expect(error.message).toContain('restricted');
    expect(await engine.getPage('deals/acme', { sourceId: 'default' })).toBeNull();
  });

  test('a dry run touches no engine, as upstream requires; the real write is still refused', async () => {
    await seedRestricted();
    expect(await putPage.handler(makeCtx({ dryRun: true }), { slug: 'deals/acme', content: '# copy' }))
      .toMatchObject({ dry_run: true });
    const error = await expectDenied(putPage.handler(makeCtx(), { slug: 'deals/acme', content: '# copy' }));
    expect(error.code).toBe('permission_denied');
    expect(await engine.getPage('deals/acme', { sourceId: 'default' })).toBeNull();
  });

  test('allows remote writes targeting restricted itself', async () => {
    await seedRestricted();
    await putPage.handler(makeCtx({ sourceId: 'restricted' }), { slug: 'deals/acme', content: '# updated restricted' });
    expect((await engine.getPage('deals/acme', { sourceId: 'restricted' }))!.compiled_truth).toContain('updated restricted');
  });

  test('allows trusted local hub writes to create a twin', async () => {
    await seedRestricted();
    await putPage.handler(makeCtx({ remote: false }), { slug: 'deals/acme', content: '# hub ingest' });
    expect((await engine.getPage('deals/acme', { sourceId: 'default' }))!.compiled_truth).toContain('hub ingest');
    expect(await engine.getPage('deals/acme', { sourceId: 'restricted' })).not.toBeNull();
  });

  test('preserves same-slug imports across visible sources', async () => {
    await addSource('team-x');
    await engine.putPage('notes/shared', { type: 'note', title: 'shared', compiled_truth: 'default original' });
    await engine.putPage('notes/shared', { type: 'note', title: 'shared', compiled_truth: 'team original' }, { sourceId: 'team-x' });
    await putPage.handler(makeCtx(), { slug: 'notes/shared', content: '# default updated' });
    await putPage.handler(makeCtx({ sourceId: 'team-x' }), { slug: 'notes/shared', content: '# team updated' });
    expect((await engine.getPage('notes/shared', { sourceId: 'default' }))!.compiled_truth).toContain('default updated');
    expect((await engine.getPage('notes/shared', { sourceId: 'team-x' }))!.compiled_truth).toContain('team updated');
  });

  test('allows a remote write to a new slug', async () => {
    await putPage.handler(makeCtx(), { slug: 'notes/new-page', content: '# new page' });
    expect(await engine.getPage('notes/new-page', { sourceId: 'default' })).not.toBeNull();
  });

  test('does not let a soft-deleted restricted page block a remote write', async () => {
    await seedRestricted();
    await engine.softDeletePage('deals/acme', { sourceId: 'restricted' });
    await putPage.handler(makeCtx(), { slug: 'deals/acme', content: '# visible replacement' });
    expect((await engine.getPage('deals/acme', { sourceId: 'default' }))!.compiled_truth).toContain('visible replacement');
  });

  test('allows a remote write when the restricted source does not exist', async () => {
    await putPage.handler(makeCtx(), { slug: 'notes/no-restricted-source', content: '# allowed' });
    expect(await engine.getPage('notes/no-restricted-source', { sourceId: 'default' })).not.toBeNull();
  });
});
