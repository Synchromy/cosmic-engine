/**
 * cosmic patch link-sources-both-endpoints (C-72, finding 8).
 *
 * list_link_sources scoped only the FROM page, so a scoped caller's counts
 * included edges INTO a source it cannot read. On a company Cosmic that is a
 * member counting links from a visible page into `restricted`. Scoped, both
 * endpoints must be in scope; unscoped (trusted local) is unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as any,
    dryRun: false,
    remote: true,
    transport: 'stdio',
    ...overrides,
  } as OperationContext;
}
const op = operations.find(o => o.name === 'list_link_sources')!;
const countOf = (rows: Array<{ link_source: string | null; count: number }>, kind: string) =>
  rows.find(r => r.link_source === kind)?.count ?? 0;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('restricted', 'restricted', '/tmp/restricted')`);
  for (const slug of ['notes/visible-a', 'notes/visible-b']) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: slug, frontmatter: {} });
  }
  await engine.putPage('notes/hidden', { type: 'note', title: 'hidden', compiled_truth: 'hidden', frontmatter: {} }, { sourceId: 'restricted' });
  const link = (from: string, fromSrc: string, to: string, toSrc: string, kind: string) =>
    engine.addLink(from, to, '', 'mentions', kind, undefined, undefined, { fromSourceId: fromSrc, toSourceId: toSrc });
  await link('notes/visible-a', 'default', 'notes/visible-b', 'default', 'manual');
  await link('notes/visible-a', 'default', 'notes/hidden', 'restricted', 'manual');
  await link('notes/visible-b', 'default', 'notes/hidden', 'restricted', 'into-hidden');
  await link('notes/hidden', 'restricted', 'notes/visible-a', 'default', 'out-of-hidden');
}, 120_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

describe('list_link_sources counts an edge only when both endpoints are in scope', () => {
  test('federated grant: edges into or out of an unread source are not counted', async () => {
    const rows = await op.handler(ctxOf({ sourceId: 'default', auth: { allowedSources: ['default'] } as any }), {}) as any[];
    expect(countOf(rows, 'manual')).toBe(1);
    expect(countOf(rows, 'into-hidden')).toBe(0);
    expect(countOf(rows, 'out-of-hidden')).toBe(0);
    expect(rows.map(r => r.link_source)).toEqual(['manual']);
  });

  test('scalar scope: the same', async () => {
    const rows = await engine.listLinkSources({ sourceId: 'default' });
    expect(rows).toEqual([{ link_source: 'manual', count: 1 }]);
  });

  test('a grant that reads both sources counts every edge', async () => {
    const rows = await op.handler(ctxOf({ sourceId: 'default', auth: { allowedSources: ['default', 'restricted'] } as any }), {}) as any[];
    expect(countOf(rows, 'manual')).toBe(2);
    expect(countOf(rows, 'into-hidden')).toBe(1);
    expect(countOf(rows, 'out-of-hidden')).toBe(1);
  });

  test('unscoped trusted local is unchanged: every edge', async () => {
    const rows = await engine.listLinkSources();
    expect(countOf(rows, 'manual')).toBe(2);
    expect(countOf(rows, 'into-hidden')).toBe(1);
    expect(countOf(rows, 'out-of-hidden')).toBe(1);
  });
});
