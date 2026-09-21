import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { runOperationRequest } from '../src/core/operation-lifecycle-runner.ts';
import type { LoadedLifecycle } from '../src/core/operation-lifecycle-loader.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const query = 'orchard telemetry notes explain rainfall across seasons this week';
const auth = { token: 'synthetic-token', clientId: 'fixture-client', scopes: ['read'], sourceId: 'default' };
function fixture(fail: boolean) {
  return {
    kind: 'pglite', getConfig: async () => null, executeRaw: async () => [],
    resolveAliases: async () => new Map(), getPage: async () => null,
    getContentFlagsByPageIds: async () => new Map(), getUnverifiedExtractionPageIds: async () => new Map(),
    relationalFanout: async () => [], searchVector: async () => [],
    searchKeyword: async () => { if (fail) throw new Error('synthetic private schema error'); return []; },
    searchTitles: async () => { if (fail) throw new Error('synthetic private schema error'); return []; },
  } as unknown as BrainEngine;
}
async function invoke(name: string, fail: boolean, configured = true) {
  const events: string[] = [];
  const loaded: LoadedLifecycle = {
    host: { version: 1, limits: { operationTimeoutMs: 3000, maxResponseBytes: 65536, shutdownTimeoutMs: 30 },
      begin: async i => { events.push('begin'); return { kind: 'admitted', admission: {
        expiresAt: i.deadlineAt, allowOptionalEnrichment: true,
        authorize: async () => { events.push('authorize'); return { kind: 'deliver' }; },
        release: async () => { events.push('release'); },
      } }; }, shutdown: async () => {},
    }, signal: new AbortController().signal, reportFailure: () => { events.push('report'); }, shutdown: async () => {},
  };
  const dispatch = (scope?: any) => dispatchToolCall(fixture(fail), name, { query }, {
    remote: true, transport: 'http', auth, sourceId: 'default', operationRequest: scope,
    metaHook: async () => { events.push('meta'); return { fixture_memory: 'synthetic enrichment' }; },
  });
  const result = configured
    ? await runOperationRequest(loaded, 'https://synthetic.invalid/mcp', auth, new EventEmitter(), new EventEmitter(), dispatch)
    : await dispatch();
  return { result, events };
}
for (const name of ['search', 'query']) {
  test(name + ' admits genuine empty and refuses swallowed all-failed paths without delivery', async () => {
    for (const fail of [false, true]) {
      const { result, events } = await invoke(name, fail);
      expect(result.isError === true).toBe(fail);
      expect(events).toEqual(fail ? ['begin', 'release'] : ['begin', 'meta', 'authorize']);
      if (fail) {
        expect(JSON.stringify(result)).not.toContain('synthetic');
        expect(JSON.stringify(result)).toContain('unavailable');
      }
    }
  });
  test(name + ' preserves unconfigured swallowed-failure behavior', async () => {
    const { result, events } = await invoke(name, true, false);
    expect(result.isError).toBeUndefined();
    expect(events).toEqual(['meta']);
  });
}

test('actual query CRAG selects completion together with adopted or rejected results', async () => {
  const script = `
    import { mock } from 'bun:test';
    import * as real from './src/core/search/hybrid.ts';
    let current, calls = 0;
    const strong = [{ slug: 'notes/synthetic', page_id: 1, source_id: 'default', title: 'Synthetic',
      type: 'note', chunk_text: 'Synthetic stored memory', chunk_id: 1, chunk_index: 0, score: 1, exact_lookup: 'slug' }];
    mock.module('./src/core/search/hybrid.ts', () => ({ ...real,
      hybridSearchCached: async (_e, _q, opts) => {
        const rerun = calls++ > 0;
        if (rerun ? current.escalated : current.base) opts.completion?.complete();
        return rerun && current.strong ? strong.map(x => ({...x})) : [];
      } }));
    const { searchOperations } = await import('./src/core/ops/search.ts');
    const op = searchOperations.find(x => x.name === 'query');
    const output = [];
    for (current of [
      {base:false, escalated:true, strong:false},
      {base:false, escalated:true, strong:true},
      {base:true, escalated:false, strong:false},
      {base:true, escalated:false, strong:true},
    ]) {
      calls = 0;
      const failures = [], meta = [];
      const engine = {
        kind: 'pglite', getConfig: async k => k === 'search.crag_escalation' ? 'true' : null,
        executeRaw: async () => [], getContentFlagsByPageIds: async () => new Map(),
        getUnverifiedExtractionPageIds: async () => new Map(),
      };
      const rows = await op.handler({ engine, remote: true, sourceId: 'default',
        auth: { token: 'synthetic', clientId: 'fixture', scopes:['read'], sourceId:'default' },
        reportFailure: f => failures.push(f.code), emitResponseMeta: (...x) => meta.push(x),
      }, { query:'orchard telemetry notes explain rainfall across seasons this week', expand:false });
      output.push({failures,calls,rows:rows.length,meta:meta.length});
    }
    console.log(JSON.stringify(output));
  `;
  const proc = Bun.spawn([process.execPath, '-e', script], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(code, stderr).toBe(0);
  const rows = JSON.parse(stdout.trim());
  expect(rows.map((r: any) => r.failures)).toEqual([['unavailable'], [], [], ['unavailable']]);
  expect(rows.map((r: any) => r.calls)).toEqual([2,2,2,2]);
  expect(rows.map((r: any) => r.rows)).toEqual([0,1,0,0]);
  expect(rows[0].meta).toBe(0);
  expect(rows[3].meta).toBe(0);
}, 30000);
