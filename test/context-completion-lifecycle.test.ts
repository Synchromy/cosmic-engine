import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { runOperationRequest } from '../src/core/operation-lifecycle-runner.ts';
import type { LoadedLifecycle } from '../src/core/operation-lifecycle-loader.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const auth = { token: 'synthetic-token', clientId: 'fixture-client', scopes: ['read'], sourceId: 'default' };
async function invoke(name: string, fail: boolean, configured = true) {
  let writes = 0;
  const rows = async () => { if (fail) throw new Error('synthetic private unavailable'); return []; };
  const engine = {
    kind: 'pglite', getConfig: async () => null,
    executeRaw: async (sql: string) => { if (sql.includes('INSERT INTO session_context_state')) writes++; return rows(); },
    searchKeyword: rows, listPages: rows, listFactsSince: rows, listFactsBySession: rows,
    resolveAliases: async () => { if (fail) throw new Error('synthetic private unavailable'); return new Map(); },
  } as unknown as BrainEngine;
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
  const params = name === 'entity' ? { name: 'Missing Synthetic' } : name === 'delta'
    ? { since: '2026-09-01T00:00:00.000Z', session_id: 'synthetic' } : { entities: 'Missing Synthetic' };
  const dispatch = (scope?: any) => dispatchToolCall(engine, name, params, {
    remote: true, transport: 'http', auth, sourceId: 'default', operationRequest: scope,
    metaHook: async () => { events.push('meta'); return { fixture_memory: 'synthetic enrichment' }; },
  });
  const result = configured
    ? await runOperationRequest(loaded, 'https://synthetic.invalid/mcp', auth, new EventEmitter(), new EventEmitter(), dispatch)
    : await dispatch();
  return { result, events, writes };
}
for (const name of ['entity', 'context_pack', 'delta']) {
  test(name + ' authorizes actual empty and releases unavailable without metadata/content', async () => {
    for (const fail of [false, true]) {
      const { result, events, writes } = await invoke(name, fail);
      expect(result.isError === true).toBe(fail);
      expect(events).toEqual(fail ? ['begin', 'release'] : ['begin', 'meta', 'authorize']);
      if (fail) {
        expect(JSON.stringify(result)).not.toContain('synthetic');
        expect(JSON.stringify(result)).toContain('unavailable');
        expect(writes).toBe(0);
      }
    }
  });
  test(name + ' keeps unconfigured legacy fallback', async () => {
    const { result, events } = await invoke(name, true, false);
    expect(result.isError).toBeUndefined();
    expect(events).toEqual(['meta']);
  });
}
