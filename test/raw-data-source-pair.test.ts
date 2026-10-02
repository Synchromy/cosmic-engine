/** C-72 finding 3 — raw data follows the exact (source_id, slug) page pair. */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function makeCtx(sourceId: string): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: true,
    sourceId,
  };
}

const putRawData = operations.find(o => o.name === 'put_raw_data')!;
const getRawData = operations.find(o => o.name === 'get_raw_data')!;

async function addRestrictedSource(): Promise<void> {
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('restricted', 'restricted')");
}

describe('raw data source pair', () => {
  test('attaches raw data to restricted/<slug> and never returns it to default', async () => {
    await addRestrictedSource();
    await engine.putPage('people/jane', { type: 'person', title: 'Visible Jane', compiled_truth: 'visible body' });
    await engine.putPage('people/jane', { type: 'person', title: 'Restricted Jane', compiled_truth: 'restricted body' }, { sourceId: 'restricted' });

    await putRawData.handler(makeCtx('restricted'), {
      slug: 'people/jane', source: 'gmail', data: { mailbox: 'restricted' },
    });

    const rows = await engine.executeRaw<{ page_id: number; source_id: string }>(
      "SELECT rd.page_id, p.source_id FROM raw_data rd JOIN pages p ON p.id = rd.page_id WHERE p.slug = 'people/jane' AND rd.source = 'gmail'",
    );
    expect(rows).toEqual([{ page_id: (await engine.getPage('people/jane', { sourceId: 'restricted' }))!.id, source_id: 'restricted' }]);
    expect(await getRawData.handler(makeCtx('default'), { slug: 'people/jane', source: 'gmail' })).toEqual([]);
    expect(await getRawData.handler(makeCtx('restricted'), { slug: 'people/jane', source: 'gmail' })).toHaveLength(1);
  });

  test('does not attach restricted raw data to a default-only page', async () => {
    await addRestrictedSource();
    await engine.putPage('people/default-only', { type: 'person', title: 'Default', compiled_truth: 'body' });
    await expect(putRawData.handler(makeCtx('restricted'), {
      slug: 'people/default-only', source: 'gmail', data: { mailbox: 'restricted' },
    })).rejects.toThrow('source=restricted');
    expect(await engine.getRawData('people/default-only', 'gmail', { sourceId: 'default' })).toEqual([]);
  });

  test('does not attach default raw data to a restricted-only page', async () => {
    await addRestrictedSource();
    await engine.putPage('people/restricted-only', { type: 'person', title: 'Restricted', compiled_truth: 'body' }, { sourceId: 'restricted' });
    await expect(putRawData.handler(makeCtx('default'), {
      slug: 'people/restricted-only', source: 'gmail', data: { mailbox: 'default' },
    })).rejects.toThrow('source=default');
    expect(await engine.getRawData('people/restricted-only', 'gmail', { sourceId: 'restricted' })).toEqual([]);
  });
});
