import { describe, expect, test, afterAll } from 'bun:test';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalOriginal, parseOriginalEnvelope, readOriginalEnvelope, credentialBinding, internalDeadline, COMPOSITE_PATH, PROOF_HEADER, DEADLINE_HEADER, CAPABILITY_HEADER } from '../src/core/operation-original-envelope.ts';
import { validateCompositeHost } from '../src/core/operation-composite.ts';
import { executeCompositeHttp, markCompositeAdmission, prepareCompositeChild, compositeDeadlines } from '../src/core/operation-composite-http.ts';
import { loadOperationLifecycle } from '../src/core/operation-lifecycle-loader.ts';
import type { LoadedLifecycle } from '../src/core/operation-lifecycle-loader.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const call = (name = 'fixture_composite') => ({ jsonrpc: '2.0' as const, id: 'original-id', method: 'tools/call' as const,
  extension: { keep: true }, params: { name, _meta: { keep: 'metadata' }, arguments: { extra: 'original' } } });
const token = 'Bearer synthetic-composite-only';
function request(body: unknown = call(), headers: Record<string, string> = {}, path = COMPOSITE_PATH) {
  const req = Object.assign(new PassThrough(), { method: 'POST', originalUrl: path,
    headers: { authorization: token, [PROOF_HEADER]: 'synthetic-proof', [DEADLINE_HEADER]: String(Date.now() + 1800), ...headers },
    auth: { token: token.slice(7), clientId: 'synthetic', scopes: ['read'] } });
  markCompositeAdmission(req);
  queueMicrotask(() => req.end(JSON.stringify(body)));
  return req as any;
}
function response() {
  const res = Object.assign(new EventEmitter(), { destroyed: false, headersSent: false, writableFinished: false,
    statusCode: 200, body: undefined as any,
    status(n: number) { this.statusCode = n; return this; },
    set(_k: string, _v: string) { return this; },
    json(v: any) { this.body = v; this.headersSent = true; this.writableFinished = true; return this; },
  });
  return res as any;
}
function fixture(change: Record<string, any> = {}) {
  const events: string[] = [];
  let seen: any;
  const controller = new AbortController();
  const admission = (i: any) => ({ expiresAt: i.deadlineAt, allowOptionalEnrichment: false,
    authorize: async () => { events.push('authorize'); return { kind: 'deliver' }; },
    release: async (reason: string) => { events.push('release:' + reason); } });
  const composite: any = { version: 1, operations: [{ name: 'fixture_composite', scope: 'read', mutating: false }],
    execute: async (i: any, dispatch: any) => { seen = i; events.push('setup');
      return { kind: 'admitted', admission: admission(i), run: async () => {
        events.push('run'); return { content: [{ type: 'text', text: 'synthetic-private-result' }] };
      } }; },
    admitChild: async (i: any) => { seen = i; events.push('child'); return { kind: 'admitted', admission: admission(i) }; },
    ...change,
  };
  const loaded: LoadedLifecycle = { signal: controller.signal, shutdown: async () => controller.abort(), reportFailure: () => events.push('failure'),
    host: { version: 1, limits: { operationTimeoutMs: 2000, maxResponseBytes: 65536, shutdownTimeoutMs: 20 },
      begin: async () => { events.push('ordinary'); return { kind: 'refused', failure: { code: 'unavailable' } }; },
      shutdown: async () => {}, composite } };
  return { loaded, events, admission, controller, seen: () => seen };
}

describe('original composite envelope', () => {
  test('complete parsed value retains unknown members and identifiers', () => {
    const original = parseOriginalEnvelope(JSON.stringify(call()));
    expect(original.extension).toEqual({ keep: true });
    expect(original.params._meta).toEqual({ keep: 'metadata' });
    expect(Object.isFrozen(original.params.arguments)).toBe(true);
    const fingerprint = canonicalOriginal(original);
    for (const changed of [{ ...call(), id: 'changed' }, { ...call(), extension: false },
      { ...call(), params: { ...call().params, _meta: {} } },
      { ...call(), params: { ...call().params, arguments: { extra: 'changed' } } }]) {
      expect(canonicalOriginal(changed)).not.toBe(fingerprint);
    }
    expect(credentialBinding(token)).not.toContain('synthetic');
    expect(credentialBinding(token + 'x')).not.toBe(credentialBinding(token));
  });
  test('rejects batch, notification, depth, invalid UTF8 and oversized originals', async () => {
    for (const body of [[], { ...call(), id: null }, { ...call(), method: 'initialize' }, { ...call(), params: { name: 'bad-name' } }]) {
      expect(() => parseOriginalEnvelope(JSON.stringify(body))).toThrow();
    }
    expect(() => canonicalOriginal(Array.from({ length: 1 }, () => undefined))).toThrow();
    let deep: any = {}; for (let n = 0; n < 34; n++) deep = { deep };
    expect(() => canonicalOriginal(deep)).toThrow();
    for (const chunk of [Buffer.from([0xff]), Buffer.alloc(65537)]) {
      const req = new PassThrough(); const pending = readOriginalEnvelope(req as any, Date.now() + 100);
      req.end(chunk); await expect(pending).rejects.toThrow();
    }
  });
  test('stream deadline expires without waiting for another chunk', async () => {
    const req = new PassThrough();
    await expect(readOriginalEnvelope(req as any, Date.now() + 15)).rejects.toThrow();
    req.destroy();
    expect(() => internalDeadline(String(Date.now() - 1), Date.now())).toThrow();
  });
});

describe('optional generic composite admission', () => {
  test('validates separate registry, preserves native absence and rejects drift', () => {
    expect(validateCompositeHost(undefined, [])).toBeUndefined();
    const f = fixture();
    expect(validateCompositeHost(f.loaded.host.composite, [])?.version).toBe(1);
    for (const change of [{ version: 2 }, { execute: null }, { admitChild: null }, { operations: [] },
      { operations: [{ name: 'native_op', scope: 'read', mutating: false }] },
      { operations: [{ name: 'fixture_composite', scope: 'write', mutating: true }] }]) {
      expect(() => validateCompositeHost({ ...f.loaded.host.composite, ...change }, [{ name: 'native_op', scope: 'read', mutating: false }])).toThrow();
    }
  });
  test('deferred execution follows admission and B2 final authorization', async () => {
    const f = fixture(), req = request(), res = response();
    await executeCompositeHttp(req, res, f.loaded, 'https://synthetic.invalid/mcp', 'http://127.0.0.1:8790/mcp');
    expect(f.events).toEqual(['setup', 'run', 'authorize']);
    expect(res.body.id).toBe('original-id');
    expect(f.seen().original).toEqual(call());
    expect(JSON.stringify(f.seen())).not.toContain('Bearer ');
  });
  test('cannot dispatch before admission and does not run malformed admissions', async () => {
    const f = fixture();
    let early = false, ran = false;
    (f.loaded.host.composite as any).execute = async (i: any, dispatch: any) => {
      try { await dispatch(JSON.stringify(call('get_tags')), 'cap', i.signal); } catch { early = true; }
      return { kind: 'admitted', admission: { ...f.admission(i), expiresAt: NaN }, run: async () => { ran = true; return {}; } };
    };
    const res = response();
    await executeCompositeHttp(request(), res, f.loaded, 'https://synthetic.invalid/mcp', 'http://127.0.0.1:8790/mcp');
    expect(early).toBe(true); expect(ran).toBe(false);
    expect(res.body.result.isError).toBe(true);
    expect(f.events).toContain('release:authorization_uncertain');
  });
  test('trusted producer failure remains sticky despite a successful envelope', async () => {
    const f = fixture();
    (f.loaded.host.composite as any).execute = async (i: any) => ({ kind: 'admitted', admission: f.admission(i),
      run: async (ctx: any) => { ctx.reportFailure({ code: 'unavailable' }); return { isError: false, content: [{ type: 'text', text: 'protected' }] }; } });
    const res = response();
    await executeCompositeHttp(request(), res, f.loaded, 'https://synthetic.invalid/mcp', 'http://127.0.0.1:8790/mcp');
    expect(JSON.stringify(res.body)).not.toContain('protected');
    expect(f.events).not.toContain('authorize');
    expect(f.events).toContain('release:handler_error');
  });
  test('expired gateway deadline and missing host never enter setup', async () => {
    const f = fixture();
    for (const req of [request(call(), { [DEADLINE_HEADER]: String(Date.now() - 1) }), request(call(), {}, COMPOSITE_PATH + '?x=1')]) {
      const res = response(); await executeCompositeHttp(req, res, f.loaded, 'x', 'http://127.0.0.1:8790/mcp');
      expect(res.statusCode).toBe(403);
    }
    const res = response(); await executeCompositeHttp(request(), res, undefined, 'x', 'http://127.0.0.1:8790/mcp');
    expect(res.statusCode).toBe(403); expect(f.events).toEqual([]);
  });
  test('child capture is original value; absent extension never uses ordinary begin', async () => {
    const f = fixture(), body = call('get_tags');
    const req = request(body, { [CAPABILITY_HEADER]: 'child-cap' }, '/mcp'); delete req.headers[PROOF_HEADER];
    const child = await prepareCompositeChild(req, f.loaded);
    expect(child.original).toEqual(body); expect(Object.isFrozen(child.original)).toBe(true);
    await child.lifecycle.host.begin({ operation: { name: 'get_tags' } } as any);
    expect(f.seen().original).toBe(child.original); expect(f.events).toEqual(['child']);
    const absent = { ...f.loaded, host: { ...f.loaded.host, composite: undefined } };
    await expect(prepareCompositeChild(request(), absent)).rejects.toThrow();
    expect(f.events).not.toContain('ordinary');
  });
});

const root = await mkdtemp(join(tmpdir(), 'gbrain-composite-loader-'));
afterAll(() => rm(root, { recursive: true, force: true }));
test('loader preserves optional port and closes malformed advertised port', async () => {
  const base = `export const protocolVersion=1; export async function createOperationLifecycleHost(){return {
    version:1,limits:{operationTimeoutMs:100,maxResponseBytes:1000,shutdownTimeoutMs:20},
    begin:async()=>({kind:'refused',failure:{code:'unavailable'}}),shutdown:async()=>{},
    composite:{version:1,operations:[{name:'fixture_composite',scope:'read',mutating:false}],
      execute:async()=>({kind:'refused',failure:{code:'unavailable'}}),admitChild:async()=>({kind:'refused',failure:{code:'unavailable'}})}}}`;
  const ports = { engine: {} as BrainEngine, resource: 'https://synthetic.invalid/mcp', operations: [], report: () => {} };
  const path = join(root, 'host.mjs'); await writeFile(path, base);
  const loaded = await loadOperationLifecycle(path, ports);
  expect(loaded!.host.composite?.operations[0].name).toBe('fixture_composite');
  await loaded!.shutdown();
  const bad = join(root, 'bad.mjs'); await writeFile(bad, base.replace('composite:{version:1', 'composite:{version:2'));
  await expect(loadOperationLifecycle(bad, ports)).rejects.toThrow('could not initialize');
});

test('child dispatcher retains original bearer and cancels a stalled body at parent deadline', async () => {
  const f = fixture();
  let canceled = false, sent: any;
  (f.loaded.host.composite as any).execute = async (i: any, dispatch: any) => ({
    kind: 'admitted', admission: f.admission(i),
    run: async (ctx: any) => {
      await dispatch(JSON.stringify(call('get_tags')), 'synthetic-cap', ctx.signal);
      return { content: [{ type: 'text', text: 'never-deliver' }] };
    },
  });
  const fetchFn = (async (_url: any, init: any) => {
    sent = init;
    return new Response(new ReadableStream({ cancel() { canceled = true; } }));
  }) as typeof fetch;
  const res = response(), req = request(call(), { [DEADLINE_HEADER]: String(Date.now() + 40) });
  await executeCompositeHttp(req, res, f.loaded, 'https://synthetic.invalid/mcp', 'http://127.0.0.1:8790/mcp', fetchFn);
  expect(sent.headers.authorization).toBe(token);
  expect(sent.redirect).toBe('manual');
  expect(sent.headers[CAPABILITY_HEADER]).toBe('synthetic-cap');
  expect(canceled).toBe(true);
  expect(JSON.stringify(res.body)).not.toContain('never-deliver');
  expect(f.events).not.toContain('authorize');
});
test('late composite setup releases its acquired admission and never invokes run', async () => {
  const f = fixture(); let ran = false, releaseSetup!: () => void;
  const wait = new Promise<void>(r => { releaseSetup = r; });
  (f.loaded.host.composite as any).execute = async (i: any) => {
    await wait;
    return { kind: 'admitted', admission: f.admission(i), run: async () => { ran = true; return { content: [] }; } };
  };
  const res = response();
  await executeCompositeHttp(request(call(), { [DEADLINE_HEADER]: String(Date.now()+20) }), res, f.loaded,
    'https://synthetic.invalid/mcp', 'http://127.0.0.1:8790/mcp');
  releaseSetup(); await new Promise(r => setTimeout(r, 5));
  expect(ran).toBe(false);
  expect(f.events).toEqual(['release:deadline']);
  expect(res.body.result.isError).toBe(true);
});

test('late factory with malformed composite closes resources exactly once', async () => {
  const path = join(root, 'late-bad-composite.mjs');
  await writeFile(path, `
export const protocolVersion=1;
globalThis.__compositeLateCloses=0;
let complete;
globalThis.__completeLateComposite=()=>complete({
 version:1,limits:{operationTimeoutMs:100,maxResponseBytes:1000,shutdownTimeoutMs:20},
 begin:async()=>({kind:'refused',failure:{code:'unavailable'}}),
 composite:{version:7},
 shutdown:async()=>{globalThis.__compositeLateCloses++;}
});
export async function createOperationLifecycleHost(){return new Promise(r=>{complete=r;});}
`);
  const ports = { engine: {} as BrainEngine, resource: 'https://synthetic.invalid/mcp', operations: [], report: () => {} };
  await expect(loadOperationLifecycle(path, ports)).rejects.toThrow('could not initialize');
  (globalThis as any).__completeLateComposite();
  await new Promise(r => setTimeout(r, 10));
  expect((globalThis as any).__compositeLateCloses).toBe(1);
  delete (globalThis as any).__completeLateComposite;
  delete (globalThis as any).__compositeLateCloses;
}, 15_000);

test('gateway admission clock rollback cannot restart its remaining body budget', async () => {
  const req = request(), declared = Number(req.headers[DEADLINE_HEADER]);
  await new Promise(r => setTimeout(r, 15));
  const clock = Date.now;
  try {
    const rolled = clock() - 60_000; Date.now = () => rolled;
    const bounds = compositeDeadlines(req);
    expect(bounds.requested).toBe(declared);
    expect(bounds.effective - rolled).toBeLessThan(1995);
    expect(bounds.effective).toBeLessThan(declared);
  } finally { Date.now = clock; }
  req.destroy();
});

test('short signed budget also expires monotonically across rollback', async () => {
  const req = request(call(), { [DEADLINE_HEADER]: String(Date.now()+10) });
  await new Promise(r => setTimeout(r, 20));
  const clock = Date.now;
  try { Date.now = () => clock()-60_000; expect(() => compositeDeadlines(req)).toThrow(); }
  finally { Date.now = clock; req.destroy(); }
});
test('positive short signed remainder is preserved across rollback', async () => {
  const req = request(call(), { [DEADLINE_HEADER]: String(Date.now()+200) });
  const declared = Number(req.headers[DEADLINE_HEADER]);
  await new Promise(r => setTimeout(r, 20));
  const clock = Date.now;
  try {
    const rolled = clock()-60_000; Date.now = () => rolled;
    const bounds = compositeDeadlines(req);
    expect(bounds.requested).toBe(declared);
    expect(bounds.effective-rolled).toBeGreaterThan(0);
    expect(bounds.effective-rolled).toBeLessThan(185);
  } finally { Date.now = clock; req.destroy(); }
});
