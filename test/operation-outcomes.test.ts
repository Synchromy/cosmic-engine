import { OperationDeliveryEffects } from '../src/core/operation-delivery-effects.ts';
import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { operations } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { runOperationRequest } from '../src/core/operation-lifecycle-runner.ts';
import type { LoadedLifecycle } from '../src/core/operation-lifecycle-loader.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const auth = { token: 'synthetic-private-bearer', clientId: 'synthetic-client', scopes: ['read'], sourceId: 'fixture' };
const engine = { getConfig: async () => null } as unknown as BrainEngine;
function fixture(options: { ms?: number; authorize?: () => Promise<any> } = {}) {
  const events: string[] = [];
  const shutdown = new AbortController();
  const effects = new OperationDeliveryEffects(30, () => { events.push('report'); });
  const loaded: LoadedLifecycle = {
    effects,
    host: { version: 1, limits: { operationTimeoutMs: options.ms ?? 1000, maxResponseBytes: 65536, shutdownTimeoutMs: 30 },
      begin: async i => ({ kind: 'admitted', admission: { expiresAt: i.deadlineAt, allowOptionalEnrichment: true,
        authorize: async () => { events.push('authorize'); return options.authorize ? options.authorize() : { kind: 'deliver' }; },
        release: async () => { events.push('release'); },
      } }), shutdown: async () => {},
    }, signal: shutdown.signal, reportFailure: () => { events.push('report'); }, shutdown: async () => { shutdown.abort(); },
  };
  return { loaded, events, effects };
}
async function invoke(f: ReturnType<typeof fixture>, handler: (ctx: any) => Promise<any>, meta = true) {
  const op = operations.find(op => op.name === 'get_tags')!;
  const original = op.handler;
  op.handler = handler;
  try {
    return await runOperationRequest(f.loaded, 'https://synthetic.invalid/mcp', auth, new EventEmitter(), new EventEmitter(),
      scope => dispatchToolCall(engine, 'get_tags', { slug: 'fixture/page' }, {
        remote: true, transport: 'http', auth, sourceId: 'fixture', operationRequest: scope,
        ...(meta ? { metaHook: async () => { f.events.push('meta'); return { synthetic: 'private-enrichment' }; } } : {}),
      }));
  } finally { op.handler = original; }
}
describe('authoritative producer outcomes', () => {
  test('producer failure withholds content and skips enrichment before authorization', async () => {
    const f = fixture();
    const result = await invoke(f, async ctx => { ctx.reportFailure?.({ code: 'unavailable' }); return { body: 'private-extractive-memory' }; });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private');
    expect(f.events).toEqual(['release']);
  });
  test('restricted contradiction report is an authoritative refusal', async () => {
    const f = fixture();
    const result = await runOperationRequest(f.loaded, 'https://synthetic.invalid/mcp', auth, new EventEmitter(), new EventEmitter(),
      scope => dispatchToolCall(engine, 'find_contradictions', {}, {
        remote: true, transport: 'http', auth, sourceId: 'fixture', operationRequest: scope,
      }));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('admission_refused');
    expect(f.events).toEqual(['release']);
  });
});

const tick = () => new Promise<void>(r => setTimeout(r, 0));
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
test('error-like stored fields remain successful content', async () => {
  const f = fixture();
  const result = await invoke(f, async () => ({ error: 'stored quotation', unavailable: true }), false);
  expect(result.isError).toBeUndefined();
  expect(JSON.stringify(result)).toContain('stored quotation');
  expect(f.events).toEqual(['authorize']);
});
test('invalid failure reports stay terminal even when caught', async () => {
  for (const value of [null, {}, { code: 'unknown' }, { code: 'unavailable', private: 'secret' }, Object.defineProperty({}, 'code', { enumerable: true, get() { throw new Error('private getter'); } })]) {
    const f = fixture();
    const result = await invoke(f, async ctx => {
      try { ctx.reportFailure(value); } catch {}
      return { private: 'fallback' };
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private');
    expect(f.events).toEqual(['release']);
  }
});
test('first producer failure wins and later success cannot clear it', async () => {
  const f = fixture();
  const result = await invoke(f, async ctx => {
    ctx.reportFailure({ code: 'refused' });
    ctx.reportFailure({ code: 'unavailable' });
    return { success: true };
  });
  expect(JSON.stringify(result)).toContain('admission_refused');
  expect(f.events).toEqual(['release']);
});
test('ended callbacks cannot mutate delivered state or add effects', async () => {
  const f = fixture();
  let saved: any;
  const result = await invoke(f, async ctx => { saved = ctx; return { safe: true }; }, false);
  const snapshot = JSON.stringify(result);
  expect(() => saved.reportFailure({ code: 'unavailable' })).toThrow();
  expect(() => saved.deferAfterDelivery(async () => f.events.push('late'))).toThrow();
  await tick();
  expect(JSON.stringify(result)).toBe(snapshot);
  expect(f.events).toEqual(['authorize']);
});
test('effects wait for authorization but not for response delivery', async () => {
  const gate = deferred(), effect = deferred();
  const f = fixture({ authorize: async () => { await gate.promise; return { kind: 'deliver' }; } });
  const call = invoke(f, async ctx => {
    ctx.deferAfterDelivery(async () => { f.events.push('effect'); await effect.promise; });
    return { safe: true };
  }, false);
  await tick();
  expect(f.events).toEqual(['authorize']);
  expect(f.effects.pendingCount).toBe(0);
  gate.resolve();
  expect((await call).isError).toBeUndefined();
  await tick();
  expect(f.events).toEqual(['authorize', 'effect']);
  expect(f.effects.pendingCount).toBe(1);
  effect.resolve();
  await f.effects.drain();
  expect(f.effects.pendingCount).toBe(0);
});
test('registration seals at handler completion before authorization finishes', async () => {
  const gate = deferred();
  const f = fixture({ authorize: async () => { await gate.promise; return { kind: 'deliver' }; } });
  let saved: any;
  const call = invoke(f, async ctx => {
    saved = ctx;
    ctx.deferAfterDelivery(async () => { f.events.push('effect'); });
    return { private: 'withhold' };
  }, false);
  await tick();
  expect(() => saved.deferAfterDelivery(async () => {})).toThrow();
  gate.resolve();
  expect((await call).isError).toBe(true);
  expect(f.events).toEqual(['authorize', 'release']);
  expect(f.effects.pendingCount).toBe(0);
});
test('over-limit registration cannot be swallowed into a successful response', async () => {
  const f = fixture();
  const result = await invoke(f, async ctx => {
    for (let i = 0; i < 5; i++) {
      try { ctx.deferAfterDelivery(async () => { f.events.push('effect'); }); } catch {}
    }
    return { private: 'withhold' };
  });
  expect(result.isError).toBe(true);
  expect(f.events).toEqual(['release']);
  expect(f.effects.pendingCount).toBe(0);
});
test('refused and timed-out authorization schedule no effects', async () => {
  for (const timeout of [false, true]) {
    const f = fixture({ ms: 15, authorize: async () => timeout
      ? new Promise(() => {})
      : { kind: 'refused', failure: { code: 'unavailable' } } });
    const result = await invoke(f, async ctx => {
      ctx.deferAfterDelivery(async () => { f.events.push('effect'); });
      return { private: 'withhold' };
    }, false);
    expect(result.isError).toBe(true);
    expect(f.events).toEqual(['authorize', 'release']);
    expect(f.effects.pendingCount).toBe(0);
  }
});
test('effect exceptions do not reverse successful delivery or expose messages', async () => {
  const f = fixture();
  const result = await invoke(f, async ctx => {
    ctx.deferAfterDelivery(async () => { throw new Error('private-effect-message'); });
    return { safe: true };
  }, false);
  await f.effects.drain();
  expect(result.isError).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain('private-effect-message');
  expect(f.events).toEqual(['authorize', 'report']);
});
test('an effect cannot append to its finalized snapshot', async () => {
  const f = fixture();
  let rejected = false;
  const result = await invoke(f, async ctx => {
    ctx.deferAfterDelivery(async () => {
      try { ctx.deferAfterDelivery(async () => { f.events.push('late'); }); } catch { rejected = true; }
    });
    return { safe: true };
  }, false);
  await f.effects.drain();
  expect(result.isError).toBeUndefined();
  expect(rejected).toBe(true);
  expect(f.events).toEqual(['authorize']);
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('actual think failure reports while standalone and selected synthesize fallback retain semantics', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gbrain-producer-'));
  try {
    // Process-isolated module seam prevents mocks contaminating other suites.
    // runThink is synthetic, so this invokes no model or private corpus.
    const script = "\nimport {mock} from 'bun:test';\nconst result={answer:'synthetic failed answer',citations:[],warnings:[],gaps:[],modelUsed:'synthetic',\n synthesisOk:false,synthesis_status:'llm_error',pagesGathered:1,takesGathered:0,\n extractive:{answer:'synthetic selected extract',citations:[{page_slug:'fixture/page'}]}};\nmock.module('./src/core/think/index.ts',()=>({runThink:async(_engine,opts)=>{opts.completion?.complete();return structuredClone(result)},persistSynthesis:async()=>{throw new Error('must not persist')}}));\nconst {takesOperations}=await import('./src/core/ops/takes.ts'); const think=takesOperations.find(x=>x.name==='think');\nconst {verbOperations}=await import('./src/core/verbs.ts');\nconst reports=[];\nconst ctx={engine:{getConfig:async()=>null},config:{},logger:console,dryRun:false,remote:true,sourceId:'fixture',\n takesHoldersAllowList:['world'],reportFailure:f=>reports.push(f)};\nconst failed=await think.handler(ctx,{question:'synthetic question'});\nconst standalone=await think.handler({...ctx,reportFailure:undefined},{question:'synthetic question'});\nconst fallback=await verbOperations.find(x=>x.name==='synthesize').handler(ctx,{question:'synthetic question'});\nconsole.log(JSON.stringify({reports,failedStatus:failed.synthesis_status,standaloneStatus:standalone.synthesis_status,fallbackStatus:fallback.synthesis_status}));\n";
    const child = Bun.spawn([process.execPath, '--eval', script], {
      cwd: process.cwd(), env: { PATH: process.env.PATH!, HOME: home, GBRAIN_HOME: home },
      stdout: 'pipe', stderr: 'pipe',
    });
    const output = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    const code = await child.exited;
    if (code !== 0) throw new Error('Synthetic producer fixture failed: ' + await errors);
    expect(code).toBe(0);
    const observed = JSON.parse(await output);
    expect(observed.reports).toEqual([{ code: 'unavailable' }]);
    expect(observed.failedStatus).toBe('llm_error');
    expect(observed.standaloneStatus).toBe('llm_error');
    expect(observed.fallbackStatus).toBe('extractive_fallback');
    expect(await errors).not.toContain('must not persist');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('scheduler and reporting errors after authorization cannot withhold the result', async () => {
  const f = fixture();
  f.effects.enqueue = () => { throw new Error('private scheduler'); };
  f.loaded.reportFailure = () => { throw new Error('private reporter'); };
  const result = await invoke(f, async ctx => {
    ctx.deferAfterDelivery(async () => {});
    return { safe: true };
  }, false);
  expect(result.isError).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain('private');
  expect(f.events).toEqual(['authorize']);
});
