import { expect, test } from 'bun:test';
import { buildEntityCard } from '../src/core/verbs/entity-card.ts';
import { assembleContextPack, assembleDeltaContext } from '../src/core/context/turn-context.ts';
import { RetrievalCompletion } from '../src/core/retrieval-completion.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function fixture(fail = false): BrainEngine {
  const rows = async () => { if (fail) throw new Error('synthetic unavailable'); return []; };
  return { kind: 'pglite', getConfig: async () => null, executeRaw: rows, searchKeyword: rows,
    listPages: rows, listFactsSince: rows, listFactsBySession: rows,
    resolveAliases: async () => { if (fail) throw new Error('synthetic unavailable'); return new Map(); },
  } as unknown as BrainEngine;
}
for (const name of ['entity', 'pack', 'delta']) {
  for (const fail of [false, true]) test(name + (fail ? ' unavailable is not completion' : ' genuine empty is completion'), async () => {
    const completion = new RetrievalCompletion();
    const e = fixture(fail);
    if (name === 'entity') await buildEntityCard(e, 'fixture', 'Missing Example', { remote: true, completion } as any);
    else if (name === 'pack') await assembleContextPack(e, { sourceId: 'fixture', completion } as any);
    else await assembleDeltaContext(e, { sourceId: 'fixture', since: '2026-09-01T00:00:00.000Z', completion } as any);
    expect(completion.seal().completed).toBe(!fail);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(r => setTimeout(r, 0));
const date = new Date('2026-09-20T00:00:00.000Z');
const lateFact = { id: 1, fact: 'SYNTHETIC-LATE-FACT', kind: 'fact', confidence: 1,
  notability: 'normal', entity_slug: null, valid_from: date, created_at: date, valid_until: null } as any;

test('alias success alone cannot survive failed required row hydration', async () => {
  const e = fixture(true);
  e.resolveAliases = async () => new Map([['missing example', [{ slug: 'people/synthetic', source_id: 'fixture' }]]]);
  const completion = new RetrievalCompletion();
  const result = await buildEntityCard(e, 'fixture', 'Missing Example', { remote: true, completion });
  expect(result.found).toBe(false);
  expect(completion.seal().completed).toBe(false);
});

for (const partial of [false, true]) test('pack seals late facts with ' + (partial ? 'an accepted empty entity' : 'no completed arm'), async () => {
  const e = fixture();
  const pending = deferred<any[]>();
  let factsCalls = 0;
  e.listFactsSince = async () => { factsCalls++; return pending.promise; };
  const completion = new RetrievalCompletion();
  const result = await assembleContextPack(e, { sourceId: 'fixture', completion, deadlineMs: 10,
    entities: partial ? ['Missing Example'] : [] });
  const frozenView = JSON.stringify(result);
  expect(result.degradedReason).toBe('deadline');
  expect(completion.seal().completed).toBe(partial);
  expect(factsCalls).toBe(1);
  pending.resolve([lateFact]);
  await tick();
  expect(JSON.stringify(result)).toBe(frozenView);
  expect(completion.seal().completed).toBe(partial);
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC-LATE');
  const next = await assembleContextPack(e, { sourceId: 'fixture', completion: new RetrievalCompletion() });
  expect(next.facts?.[0]?.fact).toBe('SYNTHETIC-LATE-FACT');
});

for (const partial of [false, true]) test('delta seals late ' + (partial ? 'facts after completed pages' : 'first page result'), async () => {
  const e = fixture();
  const pending = deferred<any[]>();
  let factsCalls = 0;
  e.listPages = async () => partial ? [{ slug: 'notes/accepted', title: 'SYNTHETIC-ACCEPTED-PAGE', updated_at: date } as any] : pending.promise;
  e.listFactsSince = async () => { factsCalls++; return partial ? pending.promise : []; };
  const completion = new RetrievalCompletion();
  const result = await assembleDeltaContext(e, { sourceId: 'fixture', since: '2026-09-01T00:00:00.000Z', completion, deadlineMs: 10 });
  const frozenView = JSON.stringify(result);
  expect(result.degradedReason).toBe('deadline');
  expect(completion.seal().completed).toBe(partial);
  pending.resolve(partial ? [lateFact] : [{ slug: 'notes/late', title: 'SYNTHETIC-LATE-PAGE', updated_at: date }]);
  await tick();
  expect(JSON.stringify(result)).toBe(frozenView);
  expect(completion.seal().completed).toBe(partial);
  expect(factsCalls).toBe(partial ? 1 : 0);
  expect(JSON.stringify(result).includes('SYNTHETIC-ACCEPTED-PAGE')).toBe(partial);
});

test('successful query with failed required fact mapping is not accepted completion', async () => {
  for (const mode of ['pack', 'delta']) {
    const e = fixture(true);
    e.listFactsSince = async () => [{ ...lateFact, valid_from: 'invalid', created_at: 'invalid' }];
    const completion = new RetrievalCompletion();
    if (mode === 'pack') await assembleContextPack(e, { sourceId: 'fixture', completion });
    else await assembleDeltaContext(e, { sourceId: 'fixture', since: date.toISOString(), completion });
    expect(completion.seal().completed).toBe(false);
  }
});

test('authorized cached empty hot facts remain completion without a repeated query', async () => {
  const e = fixture();
  let reads = 0;
  e.listFactsSince = async () => { reads++; return []; };
  for (let i = 0; i < 2; i++) {
    const completion = new RetrievalCompletion();
    await assembleContextPack(e, { sourceId: 'fixture', sessionId: 'synthetic-session', completion });
    expect(completion.seal().completed).toBe(true);
  }
  expect(reads).toBe(1);
});

test('actual scoped PGLite entity/pack/delta preserve private and foreign filtering', async () => {
  const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
  const e = new PGLiteEngine();
  await e.connect({});
  try {
    await e.initSchema();
    await e.putPage('people/public', { type: 'person', title: 'Public Synthetic', compiled_truth: 'PUBLIC-SYNTHETIC-MEMORY' });
    await e.putPage('people/private', { type: 'person', title: 'Private Synthetic', compiled_truth: 'PRIVATE-SYNTHETIC-MEMORY', frontmatter: { visibility: 'private' } });
    await e.executeRaw("INSERT INTO sources (id,name) VALUES ('foreign','foreign')");
    await e.putPage('people/foreign', { type: 'person', title: 'Foreign Synthetic', compiled_truth: 'FOREIGN-SYNTHETIC-MEMORY' }, { sourceId: 'foreign' });
    await e.insertFact({ fact: 'WORLD-SYNTHETIC-FACT', kind: 'fact', source: 'test', visibility: 'world' }, { source_id: 'default' });
    await e.insertFact({ fact: 'PRIVATE-SYNTHETIC-FACT', kind: 'fact', source: 'test', visibility: 'private' }, { source_id: 'default' });
    for (const name of ['Public Synthetic', 'Private Synthetic', 'Foreign Synthetic', 'Missing Synthetic']) {
      const completion = new RetrievalCompletion();
      const result = await buildEntityCard(e, 'default', name, { remote: true, completion });
      expect(completion.seal().completed).toBe(true);
      expect(result.found).toBe(name === 'Public Synthetic');
      expect(JSON.stringify(result)).not.toContain('PRIVATE-SYNTHETIC');
      expect(JSON.stringify(result)).not.toContain('FOREIGN-SYNTHETIC');
    }
    for (const mode of ['pack', 'delta']) {
      const completion = new RetrievalCompletion();
      const opts = { sourceId: 'default', entities: ['Public Synthetic', 'Private Synthetic', 'Foreign Synthetic'], completion };
      const result = mode === 'pack' ? await assembleContextPack(e, opts)
        : await assembleDeltaContext(e, { ...opts, since: '2000-01-01T00:00:00.000Z' });
      expect(completion.seal().completed).toBe(true);
      expect(result.text).toContain('WORLD-SYNTHETIC-FACT');
      expect(JSON.stringify(result)).not.toContain('PRIVATE-SYNTHETIC');
      expect(JSON.stringify(result)).not.toContain('FOREIGN-SYNTHETIC');
    }
    // Actual canonical card survives optional metadata SQL failures.
    const partial = new Proxy(e, { get(target, property) {
      if (property === 'executeRaw') return async (sql: string, params: unknown[]) => {
        if (!sql.includes('lower(title)')) throw new Error('synthetic optional metadata failure');
        return target.executeRaw(sql, params);
      };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const completion = new RetrievalCompletion();
    const result = await buildEntityCard(partial, 'default', 'Public Synthetic', { remote: true, completion });
    expect(result.found).toBe(true);
    expect(completion.seal().completed).toBe(true);
  } finally { await e.disconnect(); }
}, 60000);
