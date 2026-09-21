import { describe, expect, test } from 'bun:test';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const query = 'orchard telemetry notes explain rainfall across seasons this week';
function fixture(fail: boolean) {
  return {
    kind: 'pglite', getConfig: async () => null, executeRaw: async () => [],
    resolveAliases: async () => new Map(), getPage: async () => null,
    getContentFlagsByPageIds: async () => new Map(), getUnverifiedExtractionPageIds: async () => new Map(),
    relationalFanout: async () => [], searchVector: async () => [],
    searchKeyword: async () => { if (fail) throw new Error('synthetic schema failure'); return []; },
    searchTitles: async () => { if (fail) throw new Error('synthetic schema failure'); return []; },
  } as unknown as BrainEngine;
}
describe('accepted hybrid retrieval completion', () => {
  for (const fail of [false, true]) test(fail ? 'swallowed all-failed paths have no completion' : 'actual completed empty paths have completion', async () => {
    let completed = false;
    const completion = { accept: (snapshot: { completed: boolean }) => { completed ||= snapshot.completed; } };
    const rows = await hybridSearch(fixture(fail), query, { limit: 5, completion } as any);
    expect(rows).toEqual([]);
    expect(completed).toBe(!fail);
  });
});

import { RetrievalCompletion } from '../src/core/retrieval-completion.ts';
import { applyAliasHop } from '../src/core/search/hybrid.ts';
import { structuralExactLookup } from '../src/core/search/exact-lookup.ts';
import { buildRelationalArm } from '../src/core/search/relational-recall.ts';
import { resolveEntitySlugWithSource } from '../src/core/entities/resolve.ts';

test('applicable alias empty completes, generic skipped query and failed hydration do not', async () => {
  const e = fixture(true);
  for (const text of ['', query]) {
    const c = new RetrievalCompletion();
    await applyAliasHop(e, [], text, { sourceId: 'fixture', completion: c });
    expect(c.seal().completed).toBe(false);
  }
  const empty = new RetrievalCompletion();
  await applyAliasHop(e, [], 'Orchard', { sourceId: 'fixture', completion: empty });
  expect(empty.seal().completed).toBe(true);
  e.resolveAliases = async () => new Map([['orchard', [{ slug: 'notes/one', source_id: 'fixture' }]]]);
  e.getPage = async () => { throw new Error('synthetic hydration failure'); };
  const failed = new RetrievalCompletion();
  await applyAliasHop(e, [], 'Orchard', { sourceId: 'fixture', completion: failed });
  expect(failed.seal().completed).toBe(false);
  let scope: unknown;
  e.getPage = async (_slug, opts) => { scope = opts?.sourceId; return null; };
  const missing = new RetrievalCompletion();
  await applyAliasHop(e, [], 'Orchard', { sourceId: 'fixture', completion: missing });
  expect(missing.seal().completed).toBe(true);
  expect(scope).toBe('fixture');
});

test('actual scoped exact misses complete; failed or non-applicable probes do not', async () => {
  const e = fixture(true);
  let source: unknown;
  e.getPage = async (_slug, opts) => { source = opts?.sourceId; return null; };
  const missing = new RetrievalCompletion();
  await structuralExactLookup(e, 'notes/one', { sourceId: 'fixture', completion: missing });
  expect(missing.seal().completed).toBe(true);
  expect(source).toBe('fixture');
  e.getPage = async () => { throw new Error('synthetic exact failure'); };
  const failed = new RetrievalCompletion();
  await structuralExactLookup(e, 'notes/one', { sourceId: 'fixture', completion: failed });
  expect(failed.seal().completed).toBe(false);
  const skipped = new RetrievalCompletion();
  await structuralExactLookup(e, query, { sourceId: 'fixture', completion: skipped });
  expect(skipped.seal().completed).toBe(false);
});

test('tagged resolution distinguishes verified absence from swallowed query failures', async () => {
  const e = fixture(true);
  for (const fail of [false, true]) {
    e.executeRaw = async () => { if (fail) throw new Error('synthetic resolver failure'); return []; };
    const c = new RetrievalCompletion();
    const r = await resolveEntitySlugWithSource(e, 'fixture', 'Missing Example', c);
    expect(r?.source).toBe('fallback_slugify');
    expect(c.seal().completed).toBe(!fail);
  }
  // Empty alias lookup cannot prove absence after the required fuzzy lookup failed.
});

test('relational parser no-op and unavailable seeds cannot claim completed relation lookup', async () => {
  const e = fixture(true);
  e.executeRaw = async () => { throw new Error('synthetic seed failure'); };
  for (const text of [query, 'who invested in missing-example']) {
    const c = new RetrievalCompletion();
    await buildRelationalArm(e, text, { sourceId: 'fixture', completion: c });
    expect(c.seal().completed).toBe(false);
  }
});

test('actual PGLite scoped identity and relation completion includes required visibility and hydration', async () => {
  const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
  const engine = new PGLiteEngine();
  await engine.connect({});
  try {
    await engine.initSchema();
    await engine.putPage('companies/widget-co', { type: 'company', title: 'Widget Co', compiled_truth: 'Synthetic company.' });
    await engine.putPage('people/public-investor', { type: 'person', title: 'Public Investor', compiled_truth: 'Synthetic public memory.' });
    await engine.putPage('people/private-investor', { type: 'person', title: 'Private Investor', compiled_truth: 'Synthetic restricted memory.', frontmatter: { visibility: 'private' } });
    await engine.addLink('people/public-investor', 'companies/widget-co', '', 'invested_in', 'manual');
    await engine.addLink('people/private-investor', 'companies/widget-co', '', 'invested_in', 'manual');
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('team-b', 'team-b')");
    await engine.putPage('shared/page', { type: 'note', title: 'Foreign', compiled_truth: 'Synthetic foreign memory.' }, { sourceId: 'team-b' });
    for (const sourceId of ['default', 'team-b']) {
      const c = new RetrievalCompletion();
      const rows = await structuralExactLookup(engine, 'shared/page', { sourceId, excludePrivate: true, completion: c });
      expect(c.seal().completed).toBe(true);
      expect(rows.length).toBe(sourceId === 'default' ? 0 : 1);
      if (rows.length) expect(rows[0].source_id).toBe('team-b');
    }
    const privateProbe = new RetrievalCompletion();
    expect(await structuralExactLookup(engine, 'people/private-investor', { sourceId: 'default', excludePrivate: true, completion: privateProbe })).toEqual([]);
    expect(privateProbe.seal().completed).toBe(true);
    const c = new RetrievalCompletion();
    const rows = await buildRelationalArm(engine, 'who invested in widget-co', { sourceId: 'default', excludePrivate: true, completion: c });
    expect(c.seal().completed).toBe(true);
    expect(rows.map(r => r.slug)).toContain('people/public-investor');
    expect(JSON.stringify(rows)).not.toContain('restricted');
    expect(rows.map(r => r.slug)).not.toContain('people/private-investor');
    const failed = new RetrievalCompletion();
    const failing = new Proxy(engine, { get(target, property) {
      if (property === 'executeRaw') return async (sql: string, params: unknown[]) => {
        if (sql.includes('AS synopsis')) throw new Error('synthetic required hydrate failure');
        return target.executeRaw(sql, params);
      };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
    expect(await buildRelationalArm(failing, 'who invested in widget-co', { sourceId: 'default', excludePrivate: true, completion: failed })).toEqual([]);
    expect(failed.seal().completed).toBe(false);
  } finally { await engine.disconnect(); }
}, 60000);

test('selected vector groups, image and unified fallback own completion in isolated provider fixture', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = await mkdtemp(join(tmpdir(), 'completion-vectors-'));
  try {
    const script = `
      import { mock } from 'bun:test';
      import * as gateway from './src/core/ai/gateway.ts';
      mock.module('./src/core/ai/gateway.ts', () => ({ ...gateway, isAvailable: () => true,
        embedQueryMultimodal: async () => new Float32Array([99, 0]) }));
      const { hybridSearch } = await import('./src/core/search/hybrid.ts');
      const { RetrievalCompletion } = await import('./src/core/retrieval-completion.ts');
      const query = 'orchard telemetry notes explain rainfall across seasons this week';
      const answer = {};
      for (const scenario of ['salvage', 'discard-group', 'all-vector-failed', 'embed-only', 'image-empty', 'image-failed', 'unified-fallback', 'unified-strict', 'adaptive-discard']) {
        process.env.GBRAIN_SEARCH_SALVAGE = scenario === 'discard-group' ? 'off' : 'on';
        const unified = scenario.startsWith('unified');
        const config = { 'search.reranker.enabled': 'false', 'search.unified_multimodal': String(unified),
          'search.unified_multimodal_only': String(scenario === 'unified-strict') };
        let vectorCalls = 0;
        const e = {
          kind: 'pglite', getConfig: async key => config[key] ?? null, executeRaw: async () => [],
          resolveAliases: async () => new Map(), getPage: async () => null,
          getContentFlagsByPageIds: async () => new Map(), getUnverifiedExtractionPageIds: async () => new Map(),
          relationalFanout: async () => [],
          searchKeyword: async () => { throw new Error('synthetic lexical failure'); },
          searchTitles: async () => { throw new Error('synthetic lexical failure'); },
          searchVector: async vector => {
            vectorCalls++;
            if (scenario === 'adaptive-discard' && vectorCalls === 1) return [];
            if ((vector[0] === 99 && scenario !== 'image-failed') ||
              (vector[0] === 1 && ['salvage','discard-group'].includes(scenario))) return [];
            throw new Error('synthetic vector failure');
          },
        };
        const completion = new RetrievalCompletion();
        await hybridSearch(e, query, { completion, limit: 5, detail: scenario === 'adaptive-discard' ? 'low' : 'high',
          crossModal: scenario.startsWith('image') ? 'image' : 'text', expansion: true,
          expandFn: async q => [q, 'variant'],
          queryEmbedFn: async q => {
            if (scenario === 'embed-only') throw new Error('synthetic embedding failure');
            return new Float32Array([q === query ? 1 : 2, 0]);
          } });
        answer[scenario] = { completed: completion.seal().completed, vectorCalls };
      }
      console.log(JSON.stringify(answer));
    `;
    const proc = Bun.spawn([process.execPath, '-e', script], { cwd: process.cwd(),
      env: { ...process.env, GBRAIN_HOME: home }, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(code, stderr).toBe(0);
    const out = JSON.parse(stdout.trim());
    for (const name of ['salvage', 'image-empty', 'unified-strict']) expect(out[name].completed, name).toBe(true);
    for (const name of ['discard-group', 'all-vector-failed', 'embed-only', 'image-failed', 'unified-fallback', 'adaptive-discard']) expect(out[name].completed, name).toBe(false);
    expect(out['embed-only'].vectorCalls).toBe(0);
    expect(out.salvage.vectorCalls).toBeGreaterThan(1);
    expect(out['adaptive-discard'].vectorCalls).toBeGreaterThan(2);
  } finally { await rm(home, { recursive: true, force: true }); }
}, 30000);

test('hard-disabled semantic cache remains unavailable and its wrapper publishes actual retrieval only', async () => {
  const { hybridSearchCached } = await import('../src/core/search/hybrid.ts');
  const { semanticResultCacheAvailable } = await import('../src/core/search/query-cache.ts');
  expect(semanticResultCacheAvailable()).toBe(false);
  const e = fixture(false);
  let persisted = 0;
  e.executeRaw = async (sql: string) => { if (sql.includes('query_cache')) persisted++; return []; };
  const completion = new RetrievalCompletion();
  expect(await hybridSearchCached(e, query, { useCache: true, completion })).toEqual([]);
  expect(completion.seal().completed).toBe(true);
  expect(persisted).toBe(0);
});
