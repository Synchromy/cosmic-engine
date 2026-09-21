import { expect, test } from 'bun:test';
import { resolveEntitiesToPointers } from '../src/core/context/retrieval-reflex.ts';
import { volunteerContext, volunteerUsageStats, parseWindow } from '../src/core/context/volunteer.ts';
import { assembleTurnContext } from '../src/core/context/turn-context.ts';
import { RetrievalCompletion } from '../src/core/retrieval-completion.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function fixture(fail = false): BrainEngine {
  const rows = async () => { if (fail) throw new Error('synthetic unavailable'); return []; };
  return { kind: 'pglite', getConfig: async () => null, executeRaw: rows,
    resolveAliases: async () => { if (fail) throw new Error('synthetic unavailable'); return new Map(); },
    listFactsSince: rows, listFactsBySession: rows,
  } as unknown as BrainEngine;
}
const candidate = { query: 'Synthetic Example', display: 'Synthetic Example' };
for (const mode of ['resolver', 'volunteer', 'stats', 'turn']) for (const fail of [false, true]) {
  test(mode + (fail ? ' unavailable has no completion' : ' actual empty completes'), async () => {
    const e = fixture(fail), c = new RetrievalCompletion();
    if (mode === 'resolver') await resolveEntitiesToPointers(e, 'fixture', [candidate] as any, { completion: c } as any);
    if (mode === 'volunteer') await volunteerContext(e, parseWindow('user: Ask Synthetic Example'), { sourceIds: ['fixture'], completion: c } as any);
    if (mode === 'stats') await (volunteerUsageStats as any)(e, ['fixture'], 30, c);
    if (mode === 'turn') await assembleTurnContext(e, { sourceId: 'fixture', window: parseWindow('user: Ask Synthetic Example'), completion: c });
    expect(c.seal().completed).toBe(!fail);
  });
}

const weak = { query: 'orchard', display: 'orchard', weak: true as const };
const row = { slug: 'people/orchard', source_id: 'a', title: 'Orchard Example', type: 'person', frontmatter: {}, compiled_truth: 'SYNTHETIC-POINTER-MEMORY' };
function aliasFixture(mode: string): BrainEngine {
  const e = fixture(true);
  e.resolveAliases = async (_norms, opts) => {
    if (mode === 'source-failed' && opts?.sourceId === 'b') throw new Error('synthetic source unavailable');
    if (mode === 'empty') return new Map();
    return new Map([['orchard', opts?.sourceId === 'a' || mode === 'ambiguous'
      ? [{ slug: row.slug, source_id: opts?.sourceId ?? 'a' }] : []]]);
  };
  e.executeRaw = async (sql: string) => {
    if (!sql.includes('compiled_truth')) {
      if (mode === 'live-failed') throw new Error('synthetic live check failure');
      return mode === 'stale' ? [] : [{ ...row }, ...(mode === 'ambiguous' ? [{ ...row, source_id: 'b' }] : [])] as any;
    }
    if (sql.includes('lower(title)')) return [];
    if (mode === 'hydrate-failed') throw new Error('synthetic body hydration failure');
    return mode === 'hydrate-missing' ? [] : [row] as any;
  };
  return e;
}
for (const mode of ['source-failed', 'live-failed', 'hydrate-failed', 'empty', 'ambiguous', 'stale', 'hydrate-missing', 'hydrated']) {
  test('weak global prerequisites and required hydration: ' + mode, async () => {
    const c = new RetrievalCompletion();
    const result = await resolveEntitiesToPointers(aliasFixture(mode), 'a', [weak] as any, { sourceIds: ['a', 'b'], completion: c });
    expect(c.seal().completed).toBe(!['source-failed', 'live-failed', 'hydrate-failed'].includes(mode));
    expect(result !== null).toBe(mode === 'hydrated');
  });
}
test('strong alias reference alone is unavailable, accepted hydration or independent empty source completes', async () => {
  for (const mode of ['failed', 'hydrated', 'empty-sibling']) {
    const e = aliasFixture('hydrate-failed'), c = new RetrievalCompletion();
    e.resolveAliases = async (_norms, opts) => new Map([['orchard', mode === 'empty-sibling' && opts?.sourceId === 'b' ? [] : [{ slug: row.slug, source_id: 'a' }]]]);
    e.executeRaw = async (sql: string) => {
      if (!sql.includes('compiled_truth')) return [row] as any;
      if (mode === 'hydrated' && !sql.includes('lower(title)')) return [row] as any;
      throw new Error('synthetic required query failure');
    };
    await resolveEntitiesToPointers(e, 'a', [{ query: weak.query, display: weak.display }], { sourceIds: ['a', 'b'], completion: c });
    expect(c.seal().completed).toBe(mode !== 'failed');
  }
});
test('CJK completion belongs to its applicable query, not empty generic title predicates', async () => {
  for (const fail of [false, true]) {
    const e = fixture(true), c = new RetrievalCompletion();
    e.executeRaw = async (_sql, params) => {
      if (params?.length === 3 && fail) throw new Error('synthetic CJK unavailable');
      return [];
    };
    await resolveEntitiesToPointers(e, 'a', [{ query: '東京', display: '東京', weak: true }], { completion: c });
    expect(c.seal().completed).toBe(!fail);
  }
});
test('successful normalization can complete policy-empty selection; malformed normalization cannot', async () => {
  const c = new RetrievalCompletion();
  expect(await resolveEntitiesToPointers(fixture(true), 'a', [weak], { completion: c, lexicalArms: false })).toBeNull();
  expect(c.seal().completed).toBe(true);
  const failed = new RetrievalCompletion();
  await expect(resolveEntitiesToPointers(fixture(), 'a', [{ get query() { throw new Error('synthetic normalization failure'); }, display: 'invalid' }] as any, { completion: failed })).rejects.toThrow();
  expect(failed.seal().completed).toBe(false);
  const noop = new RetrievalCompletion();
  await resolveEntitiesToPointers(fixture(), 'a', [], { completion: noop });
  expect(noop.seal().completed).toBe(false);
});
test('final pointer processing failure cannot publish earlier query completion', async () => {
  const e = fixture(), c = new RetrievalCompletion();
  e.executeRaw = async () => [{ ...row, title: 'Synthetic Example', get compiled_truth() { throw new Error('synthetic synopsis failure'); } }] as any;
  await expect(resolveEntitiesToPointers(e, 'a', [candidate], { completion: c })).rejects.toThrow();
  expect(c.seal().completed).toBe(false);
});
test('valid outer no-candidate selection succeeds without SQL, missing scope does not', async () => {
  const e = fixture(true);
  let calls = 0;
  e.executeRaw = async () => { calls++; throw new Error('must not query'); };
  e.resolveAliases = async () => { calls++; throw new Error('must not query'); };
  const c = new RetrievalCompletion();
  expect(await volunteerContext(e, parseWindow('user: 12345'), { sourceIds: ['a'], completion: c })).toEqual([]);
  expect(c.seal().completed).toBe(true);
  expect(calls).toBe(0);
  const missing = new RetrievalCompletion();
  await volunteerContext(e, [], { sourceIds: [], completion: missing });
  expect(missing.seal().completed).toBe(false);
});
test('stats query success with failed required mapping cannot publish completion', async () => {
  const e = fixture(), c = new RetrievalCompletion();
  e.executeRaw = async () => [{ get volunteered() { throw new Error('synthetic mapping failure'); } }] as any;
  await expect(volunteerUsageStats(e, ['a'], 30, c)).rejects.toThrow();
  expect(c.seal().completed).toBe(false);
});
test('ordinary turn accepts independent facts or valid pointer selection but not skipped absent window', async () => {
  for (const mode of ['facts', 'selection', 'absent']) {
    const e = fixture(true), c = new RetrievalCompletion();
    if (mode === 'facts') { e.listFactsSince = async () => []; e.listFactsBySession = async () => []; }
    await assembleTurnContext(e, { sourceId: 'a', completion: c,
      window: mode === 'absent' ? [] : parseWindow(mode === 'selection' ? 'user: 12345' : 'user: Ask Synthetic Example') });
    expect(c.seal().completed).toBe(mode !== 'absent');
  }
});
test('outer discarded turn collector cannot receive late helper authority', async () => {
  const e = fixture(true), c = new RetrievalCompletion();
  let resolve!: (rows: any[]) => void;
  const pending = new Promise<any[]>(r => { resolve = r; });
  e.listFactsSince = async () => pending;
  const result = assembleTurnContext(e, { sourceId: 'a', completion: c, window: [] });
  const snapshot = c.seal();
  expect(snapshot.completed).toBe(false);
  resolve([{ id: 1, fact: 'SYNTHETIC-LATE-FACT', kind: 'fact', confidence: 1, notability: 'normal',
    entity_slug: null, valid_from: new Date('2026-09-20'), created_at: new Date('2026-09-20'), valid_until: null }]);
  const late = await result;
  expect(late.text).toContain('SYNTHETIC-LATE-FACT');
  expect(c.seal()).toBe(snapshot);
  expect(c.seal().completed).toBe(false);
});

import { beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
let scoped: PGLiteEngine;
beforeAll(async () => {
  scoped = new PGLiteEngine();
  await scoped.connect({});
  await scoped.initSchema();
  await scoped.putPage('people/orchard', { type: 'person', title: 'Orchard Example', compiled_truth: 'SYNTHETIC-SCOPED-MEMORY' });
  await scoped.setPageAliases('people/orchard', 'default', ['orchard']);
  await scoped.executeRaw("INSERT INTO sources (id,name) VALUES ('foreign','foreign')");
  await scoped.putPage('people/foreign', { type: 'person', title: 'Foreign Example', compiled_truth: 'SYNTHETIC-FOREIGN-MEMORY' }, { sourceId: 'foreign' });
  await scoped.setPageAliases('people/foreign', 'foreign', ['orchard']);
}, 60000);
afterAll(async () => { await scoped?.disconnect(); });
test('actual PGLite scoped resolver and volunteer outputs stay identical with completion', async () => {
  for (const scope of [['default'], ['default', 'foreign']]) for (const prior of ['', 'people/orchard']) {
    const c = new RetrievalCompletion();
    const opts = { sourceIds: scope, priorContextText: prior };
    const expected = await resolveEntitiesToPointers(scoped, 'default', [weak], opts);
    const result = await resolveEntitiesToPointers(scoped, 'default', [weak], { ...opts, completion: c });
    expect(result).toEqual(expected);
    expect(c.seal().completed).toBe(true);
    expect(result !== null).toBe(scope.length === 1 && !prior);
  }
  for (const minConfidence of [0.7, 1]) {
    const c = new RetrievalCompletion(), turns = parseWindow('user: Ask Orchard Example');
    const opts = { sourceIds: ['default'], minConfidence };
    const expected = await volunteerContext(scoped, turns, opts);
    expect(await volunteerContext(scoped, turns, { ...opts, completion: c })).toEqual(expected);
    expect(c.seal().completed).toBe(true);
  }
  const stats = new RetrievalCompletion();
  const result = await volunteerUsageStats(scoped, ['default'], 30, stats);
  expect(result.total_volunteered).toBe(0);
  expect(stats.seal().completed).toBe(true);
});
