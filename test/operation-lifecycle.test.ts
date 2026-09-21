import { describe, expect, test } from 'bun:test';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const auth = { token: 'synthetic-do-not-forward', clientId: 'fixture-client', scopes: ['read'], sourceId: 'fixture' };
const engine = { getConfig: async () => null, getTags: async () => ['synthetic-tag'] } as unknown as BrainEngine;

describe('native lifecycle transport boundary', () => {
  test('plain objects cannot attach lifecycle authority to HTTP dispatch', async () => {
    const result = await dispatchToolCall(engine, 'get_tags', { slug: 'fixture/page' }, {
      remote: true, transport: 'http', sourceId: 'fixture', auth,
      operationRequest: { begin: async () => undefined },
    } as any);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('synthetic-tag');
  });

  test('direct local callers cannot enable lifecycle through request options', async () => {
    const result = await dispatchToolCall(engine, 'get_tags', { slug: 'fixture/page' }, {
      remote: false, sourceId: 'fixture', auth,
      operationRequest: { begin: async () => undefined },
    } as any);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('synthetic-tag');
  });
});

import { EventEmitter } from 'node:events';
import { runOperationRequest, projectLifecyclePrincipal } from '../src/core/operation-lifecycle-runner.ts';
import type { LoadedLifecycle } from '../src/core/operation-lifecycle-loader.ts';
import type { LifecycleInvocation, OperationAdmission } from '../src/core/operation-lifecycle.ts';
import { OperationError } from '../src/core/operations.ts';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(r => setTimeout(r, 0));
function fixture(overrides: {
  begin?: (i: LifecycleInvocation) => Promise<any>;
  admission?: Partial<OperationAdmission>;
  ms?: number; bytes?: number;
} = {}) {
  const events: string[] = [];
  const invocations: LifecycleInvocation[] = [];
  const controller = new AbortController();
  const loaded: LoadedLifecycle = {
    host: { version: 1, limits: { operationTimeoutMs: overrides.ms ?? 1000, maxResponseBytes: overrides.bytes ?? 65536, shutdownTimeoutMs: 30 },
      begin: async i => {
        invocations.push(i); events.push('begin');
        if (overrides.begin) return overrides.begin(i);
        return { kind: 'admitted', admission: { expiresAt: i.deadlineAt, allowOptionalEnrichment: false,
          authorize: async () => { events.push('authorize'); return { kind: 'deliver' }; },
          release: async reason => { events.push('release:' + reason); },
          ...overrides.admission,
        } };
      }, shutdown: async () => {},
    },
    signal: controller.signal, reportFailure: () => { events.push('report'); }, shutdown: async () => { controller.abort(); },
  };
  return { loaded, events, invocations, controller };
}
function invoke(f: ReturnType<typeof fixture>, options: {
  name?: string; params?: Record<string, unknown>; request?: EventEmitter; response?: EventEmitter;
  beforePageRead?: (p: any) => Promise<void>; db?: BrainEngine; audit?: () => Promise<void>; metaHook?: () => Promise<any>;
} = {}) {
  const request = options.request ?? new EventEmitter();
  const response = options.response ?? new EventEmitter();
  return runOperationRequest(f.loaded, 'https://synthetic.invalid/mcp', auth, request, response, async scope => {
    const result = await dispatchToolCall(options.db ?? engine, options.name ?? 'get_tags', options.params ?? { slug: 'fixture/page' }, {
      remote: true, transport: 'http', sourceId: 'fixture', auth,
      operationRequest: scope, beforePageRead: options.beforePageRead, metaHook: options.metaHook,
    });
    if (options.audit) await options.audit();
    return result;
  });
}

describe('bounded native request runner', () => {
  test('projects seconds explicitly and never copies bearer or mutable grant arrays', () => {
    const input = { ...auth, expiresAt: 12345, allowedSources: ['fixture'] };
    const p = projectLifecyclePrincipal(input);
    expect(p.expiresAtMs).toBe(12345000);
    expect(JSON.stringify(p)).not.toContain(auth.token);
    expect(Object.isFrozen(p.allowedSources)).toBe(true);
    input.allowedSources.push('other');
    expect(p.allowedSources).toEqual(['fixture']);
  });
  test('final authorization follows full audit, and result remains withheld while authorizing', async () => {
    const audit = deferred<void>(), decision = deferred<any>();
    const f = fixture({ admission: { authorize: async () => { f.events.push('authorize'); return decision.promise; } } });
    let done = false;
    const call = invoke(f, { audit: async () => { f.events.push('audit'); await audit.promise; } }).then(r => { done = true; return r; });
    await tick();
    expect(f.events).toEqual(['begin', 'audit']);
    audit.resolve();
    await tick();
    expect(done).toBe(false);
    expect(f.events).toEqual(['begin', 'audit', 'authorize']);
    decision.resolve({ kind: 'deliver' });
    const result = await call;
    expect(result.isError).toBeUndefined();
    expect(Object.isFrozen(result.content)).toBe(true);
    expect(f.events.some(x => x.startsWith('release'))).toBe(false);
    expect(f.invocations[0].params).toEqual({ slug: 'fixture/page' });
    expect(JSON.stringify(f.invocations)).not.toContain(auth.token);
  });
  test('declared invalid params and hidden operations never begin', async () => {
    const f = fixture();
    expect((await invoke(f, { params: {} })).isError).toBe(true);
    expect((await invoke(f, { name: 'nonexistent' })).isError).toBe(true);
    expect(f.events).toEqual([]);
  });
  test('handler-local failure releases once without authorization', async () => {
    const f = fixture();
    const db = { ...engine, getTags: async () => { throw new OperationError('permission_denied', 'synthetic refusal'); } } as BrainEngine;
    const result = await invoke(f, { db });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('synthetic refusal');
    expect(f.events).toEqual(['begin', 'release:handler_error']);
  });
  test('host exceptions cannot leak their message into dispatch output', async () => {
    const f = fixture({ begin: async () => { throw new Error('synthetic-secret-must-not-escape'); } });
    const result = await invoke(f);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
    expect(f.events).toEqual(['begin', 'report']);
  });
  test('explicit public refusal is retained without running handler', async () => {
    const f = fixture({ begin: async () => ({ kind: 'refused', failure: { code: 'resource_exhausted', publicMessage: 'Synthetic allowance exhausted.' } }) });
    const result = await invoke(f);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('Synthetic allowance exhausted');
    expect(JSON.stringify(result)).not.toContain('synthetic-tag');
  });
  test('optional metadata is skipped before lookup, or included before authorization', async () => {
    let lookups = 0;
    const metaHook = async () => { lookups++; return { synthetic_memory: 'bounded' }; };
    await invoke(fixture(), { metaHook });
    expect(lookups).toBe(0);
    const f = fixture({ admission: { allowOptionalEnrichment: true } });
    expect((await invoke(f, { metaHook }))._meta).toEqual({ synthetic_memory: 'bounded' });
    expect(lookups).toBe(1);
  });
  test('oversized metadata is refused before authorization', async () => {
    const f = fixture({ bytes: 80, admission: { allowOptionalEnrichment: true } });
    const result = await invoke(f, { metaHook: async () => ({ large: 'x'.repeat(1000) }) });
    expect(result.isError).toBe(true);
    expect(f.events).toEqual(['begin', 'release:invalid_response']);
  });
  test('deadline during audit withholds and never authorizes', async () => {
    const audit = deferred<void>(), f = fixture({ ms: 25 });
    const result = await invoke(f, { audit: () => audit.promise });
    expect(result.isError).toBe(true);
    expect(f.events).toEqual(['begin', 'release:deadline']);
    audit.resolve();
    await tick();
    expect(f.events).toEqual(['begin', 'release:deadline']);
  });
  test('late authorization cannot deliver', async () => {
    const d = deferred<any>(), f = fixture({ ms: 25, admission: { authorize: () => d.promise } });
    const result = await invoke(f);
    expect(result.isError).toBe(true);
    d.resolve({ kind: 'deliver' });
    await tick();
    expect(f.events.filter(x => x.startsWith('release'))).toEqual(['release:deadline']);
  });
  test('late acquired admission is cleaned exactly once', async () => {
    const d = deferred<any>(), f = fixture({ ms: 25, begin: () => d.promise });
    expect((await invoke(f)).isError).toBe(true);
    let releases = 0;
    d.resolve({ kind: 'admitted', admission: { expiresAt: Date.now() + 1000, allowOptionalEnrichment: false,
      authorize: async () => ({ kind: 'deliver' }), release: async () => { releases++; } } });
    await tick(); await tick();
    expect(releases).toBe(1);
  });
  test('a normal consumed-body close does not abort, and sibling cleanup is independent', async () => {
    const request = new EventEmitter(), response = new EventEmitter();
    const a = deferred<void>(), b = deferred<void>(), f = fixture();
    const first = invoke(f, { request, response, audit: () => a.promise });
    const second = invoke(f, { request, response, audit: () => b.promise });
    await tick();
    request.emit('close');
    expect(response.listenerCount('close')).toBe(2);
    a.resolve();
    expect((await first).isError).toBeUndefined();
    expect(response.listenerCount('close')).toBe(1);
    response.emit('close');
    expect((await second).isError).toBe(true);
    b.resolve();
    expect(response.listenerCount('close')).toBe(0);
    expect(f.invocations[0].attemptId).not.toBe(f.invocations[1].attemptId);
    expect(f.events.filter(x => x === 'authorize')).toHaveLength(1);
  });
  test('shutdown aborts pending work and removes all listeners', async () => {
    const d = deferred<void>(), f = fixture(), request = new EventEmitter(), response = new EventEmitter();
    const call = invoke(f, { request, response, audit: () => d.promise });
    await tick(); f.controller.abort();
    expect((await call).isError).toBe(true);
    d.resolve();
    expect(request.listenerCount('aborted')).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
    expect(f.events).toContain('release:shutdown');
  });
  test('actual page handler preserves previous restriction before host page reserve or body', async () => {
    const calls: string[] = [], f = fixture({ admission: { beforePageRead: async () => { calls.push('host-page'); } } });
    const db = { ...engine, getPageIdentity: async () => ({ id: 7, source_id: 'fixture', slug: 'fixture/page', private: false }),
      getPage: async () => { calls.push('body'); return null; },
    } as unknown as BrainEngine;
    const result = await invoke(f, { name: 'get_page', db, beforePageRead: async target => {
      expect(Object.isFrozen(target)).toBe(true);
      calls.push('prior');
      throw new OperationError('permission_denied', 'synthetic prior refusal');
    } });
    expect(result.isError).toBe(true);
    expect(calls).toEqual(['prior']);
    expect(f.events).toEqual(['begin', 'release:handler_error']);
  });
  test('failed cleanup is bounded and never changes a refusal to success', async () => {
    const f = fixture({ admission: { authorize: async () => { throw new Error('private host detail'); }, release: async () => { throw new Error('private release detail'); } } });
    const result = await invoke(f);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private');
    expect(f.events).toEqual(['begin', 'report', 'report']);
  });
  test('malformed authorizer result is never deliver permission', async () => {
    for (const value of [undefined, true, {}, { kind: 'other' }]) {
      const f = fixture({ admission: { authorize: async () => value as any } });
      expect((await invoke(f)).isError).toBe(true);
      expect(f.events.filter(x => x.startsWith('release'))).toHaveLength(1);
    }
  });
});

test('deadline crossed while cloning never schedules host begin', async () => {
  const f = fixture({ ms: 10 });
  const result = await runOperationRequest(f.loaded, 'https://synthetic.invalid/mcp', auth, new EventEmitter(), new EventEmitter(), async scope => {
    await scope!.begin({ name: 'synthetic', description: 'Synthetic deadline fixture', params: {}, scope: 'read', handler: async () => [] }, {
      toJSON() { const until = performance.now() + 25; while (performance.now() < until) {} return {}; },
    }, { engine, remote: true, transport: 'http', sourceId: 'fixture', auth } as any);
    return { content: [{ type: 'text', text: 'never' }] };
  });
  expect(result.isError).toBe(true);
  await tick();
  expect(f.events).toEqual([]);
});

test('invalid acquired expiry still releases exactly once', async () => {
  for (const expiresAt of [0, Infinity, Date.now() + 1_000_000]) {
    let releases = 0;
    const f = fixture({ admission: { expiresAt, release: async () => { releases++; } } });
    expect((await invoke(f)).isError).toBe(true);
    expect(releases).toBe(1);
  }
});

test('wall-clock rollback cannot extend monotonic invocation lifetime', async () => {
  const now = Date.now, d = deferred<void>(), f = fixture({ ms: 25 });
  const call = invoke(f, { audit: () => d.promise });
  await tick();
  Date.now = () => now() - 60_000;
  try {
    const result = await Promise.race([call, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('extended deadline')), 200))]);
    expect(result.isError).toBe(true);
    expect(f.events).toContain('release:deadline');
  } finally { Date.now = now; d.resolve(); }
});

test('wall-clock advance cannot extend the admitted epoch expiry', async () => {
  const now = Date.now, d = deferred<void>(), f = fixture({ ms: 1000 });
  const call = invoke(f, { audit: () => d.promise });
  await tick();
  Date.now = () => now() + 60_000;
  try {
    d.resolve();
    expect((await call).isError).toBe(true);
    expect(f.events).not.toContain('authorize');
  } finally { Date.now = now; }
});

test('canonical page quota refusal keeps only public host guidance without body read', async () => {
  for (const value of [
    { kind: 'refused', failure: { code: 'resource_exhausted', publicMessage: 'Add synthetic credits or wait for the next period.' } },
    { kind: 'unexpected', private: 'do-not-return' },
  ]) {
    let bodies = 0;
    const f = fixture({ admission: { beforePageRead: async () => value as any } });
    const db = { ...engine, getPageIdentity: async () => ({ id: 7, source_id: 'fixture', slug: 'fixture/page', private: false }),
      getPage: async () => { bodies++; return null; } } as unknown as BrainEngine;
    const result = await invoke(f, { name: 'get_page', db });
    expect(result.isError).toBe(true);
    expect(bodies).toBe(0);
    expect(JSON.stringify(result)).not.toContain('do-not-return');
    if (value.kind === 'refused') expect(JSON.stringify(result)).toContain('Add synthetic credits');
    else expect(JSON.stringify(result)).toContain('unavailable');
    expect(f.events.filter(x => x.startsWith('release'))).toHaveLength(1);
  }
});

test('late malformed admission retains release authority after timeout', async () => {
  const d = deferred<any>();
  let releases = 0;
  const f = fixture({ ms: 15, begin: () => d.promise });
  expect((await invoke(f)).isError).toBe(true);
  d.resolve({ kind: 'admitted', admission: { expiresAt: Infinity, release: async () => { releases++; } } });
  await tick(); await tick();
  expect(releases).toBe(1);
});

test('swallowing a page callback failure cannot authorize fallback memory', async () => {
  for (const kind of ['refused', 'invalid', 'exception', 'prior'] as const) {
    let pageCalls = 0;
    const f = fixture({ admission: { beforePageRead: async () => {
      pageCalls++;
      if (kind === 'exception') throw new Error('private-host-detail');
      if (kind === 'invalid') return { kind: 'unknown' } as any;
      return { kind: 'refused', failure: { code: 'resource_exhausted', publicMessage: 'Synthetic page top-up guidance' } };
    } } });
    const result = await runOperationRequest(f.loaded, 'https://synthetic.invalid/mcp', auth, new EventEmitter(), new EventEmitter(), async scope => {
      const ctx = { engine, remote: true, transport: 'http', sourceId: 'fixture', auth,
        ...(kind === 'prior' ? { beforePageRead: async () => { throw new Error('prior-private-detail'); } } : {}) } as any;
      await scope!.begin({ name: 'synthetic', description: 'Synthetic swallowed callback', params: {}, scope: 'read', handler: async () => [] }, {}, ctx);
      try { await ctx.beforePageRead(Object.freeze({ operation: 'get_page', id: 7, source_id: 'fixture', slug: 'fixture/page' })); } catch {}
      try { await ctx.beforePageRead(Object.freeze({ operation: 'get_page', id: 8, source_id: 'fixture', slug: 'fixture/second' })); } catch {}
      return { content: [{ type: 'text', text: 'private-fallback-memory' }] };
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private');
    expect(f.events).not.toContain('authorize');
    expect(f.events.filter(x => x.startsWith('release'))).toHaveLength(1);
    expect(pageCalls).toBe(kind === 'prior' ? 0 : 1);
    if (kind === 'refused') expect(JSON.stringify(result)).toContain('Synthetic page top-up guidance');
    else expect(JSON.stringify(result)).toContain('unavailable');
  }
});
