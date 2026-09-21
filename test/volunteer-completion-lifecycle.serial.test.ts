import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { runOperationRequest } from '../src/core/operation-lifecycle-runner.ts';
import type { LoadedLifecycle } from '../src/core/operation-lifecycle-loader.ts';
import type { BrainEngine } from '../src/core/engine.ts';

async function invoke(mode: string, fail: boolean, configured: boolean) {
  let writes = 0;
  const rows = async () => { if (fail) throw new Error('PRIVATE-SYNTHETIC-ERROR'); return []; };
  const e = {
    kind: 'pglite', getConfig: async () => null,
    executeRaw: async (sql: string) => { if (/INSERT|UPDATE/.test(sql)) writes++; return rows(); },
    resolveAliases: async () => { await rows(); return new Map(); },
  } as unknown as BrainEngine;
  if (mode === 'weak') {
    e.resolveAliases = async (_norms, opts) => {
      if (opts?.sourceId === 'b' && fail) throw new Error('PRIVATE-SYNTHETIC-SOURCE');
      return new Map();
    };
    e.executeRaw = async () => [];
  }
  const auth = { token: 'synthetic-token', clientId: 'fixture', scopes: ['read'], sourceId: 'a', allowedSources: ['a', 'b'] };
  const events: string[] = [];
  const loaded: LoadedLifecycle = {
    host: { version: 1, limits: { operationTimeoutMs: 3000, maxResponseBytes: 65536, shutdownTimeoutMs: 30 },
      begin: async i => { events.push('begin'); return { kind: 'admitted', admission: {
        expiresAt: i.deadlineAt, allowOptionalEnrichment: true,
        authorize: async () => { events.push('authorize'); return { kind: 'deliver' }; },
        release: async () => { events.push('release'); },
      } }; }, shutdown: async () => {},
    }, signal: new AbortController().signal, reportFailure: () => events.push('report'), shutdown: async () => {},
  };
  const params = mode === 'stats' ? { stats: true } : {
    window: mode === 'empty' ? 'user: 12345' : mode === 'weak' ? 'user: orchard' : 'user: Ask Synthetic Example',
  };
  const dispatch = (scope?: any) => dispatchToolCall(e, 'volunteer_context', params, {
    remote: true, transport: 'http', auth, sourceId: 'a', operationRequest: scope,
    metaHook: async () => { events.push('meta'); return { private_memory: 'PROTECTED-SYNTHETIC-METADATA' }; },
  });
  const result = configured
    ? await runOperationRequest(loaded, 'https://synthetic.invalid/mcp', auth, new EventEmitter(), new EventEmitter(), dispatch)
    : await dispatch();
  return { result, events, writes };
}
for (const mode of ['stats', 'normal', 'weak', 'empty']) test('volunteer lifecycle ' + mode + ' preserves actual success and refuses unavailable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'volunteer-lifecycle-'));
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      for (const configured of [true, false]) for (const fail of [false, true]) {
        const { result, events, writes } = await invoke(mode, fail, configured);
        const refused = configured && fail && mode !== 'empty';
        expect(result.isError === true).toBe(refused);
        expect(events).toEqual(configured ? refused ? ['begin', 'release'] : ['begin', 'meta', 'authorize'] : ['meta']);
        if (refused) {
          expect(JSON.stringify(result)).not.toContain('PROTECTED');
          expect(JSON.stringify(result)).not.toContain('PRIVATE-SYNTHETIC');
          expect(JSON.stringify(result)).toContain('unavailable');
          expect(writes).toBe(0);
        }
      }
    });
  } finally { await rm(home, { recursive: true, force: true }); }
});
