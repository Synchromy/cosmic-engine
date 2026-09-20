import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationDeliveryEffects } from '../src/core/operation-delivery-effects.ts';
import { loadOperationLifecycle } from '../src/core/operation-lifecycle-loader.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const tick = () => new Promise<void>(r => setTimeout(r, 0));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

test('timed-out work retains all64 capacity slots until actually settled', async () => {
  let reports = 0, calls = 0;
  const gate = deferred();
  const effects = new OperationDeliveryEffects(15, () => { reports++; });
  effects.enqueue(Array.from({ length: 65 }, () => async () => { calls++; await gate.promise; }));
  await tick();
  expect(calls).toBe(64);
  expect(effects.pendingCount).toBe(64);
  expect(reports).toBe(1);
  await new Promise(r => setTimeout(r, 25));
  expect(effects.pendingCount).toBe(64);
  expect(reports).toBe(65);
  effects.enqueue([async () => { calls++; }]);
  expect(calls).toBe(64);
  expect(reports).toBe(66);
  gate.resolve();
  await effects.drain();
  expect(effects.pendingCount).toBe(0);
});
test('stop aborts pending work and refuses new work without throwing', async () => {
  let reports = 0;
  const gate = deferred();
  let signal: AbortSignal | undefined;
  const effects = new OperationDeliveryEffects(1000, () => { reports++; });
  effects.enqueue([async s => { signal = s; await gate.promise; }]);
  await tick();
  effects.stop();
  expect(signal!.aborted).toBe(true);
  effects.enqueue([async () => { throw new Error('must not run'); }]);
  expect(reports).toBe(1);
  expect(effects.pendingCount).toBe(1);
  gate.resolve();
  await effects.drain();
  expect(effects.pendingCount).toBe(0);
});
test('throwing static reporter never changes effect cleanup', async () => {
  const effects = new OperationDeliveryEffects(20, () => { throw new Error('private reporter'); });
  expect(() => effects.enqueue([async () => { throw new Error('private effect'); }])).not.toThrow();
  await effects.drain();
  expect(effects.pendingCount).toBe(0);
});

const root = await mkdtemp(join(tmpdir(), 'gbrain-effects-'));
afterAll(() => rm(root, { recursive: true, force: true }));
test('host shutdown and effects share one bounded drain and close exactly once', async () => {
  const modulePath = join(root, 'host.mjs');
  await writeFile(modulePath, `
export const protocolVersion=1;
globalThis.__effectsCloseCount=0;
globalThis.__effectsCloseStarted=false;
export async function createOperationLifecycleHost() {return {
 version:1,limits:{operationTimeoutMs:1000,maxResponseBytes:1000,shutdownTimeoutMs:20},
 begin:async()=>({kind:'refused',failure:{code:'unavailable'}}),
 shutdown:async()=>{globalThis.__effectsCloseCount++;globalThis.__effectsCloseStarted=true;
  await new Promise(r=>{globalThis.__effectsCloseResolve=r;});}
};}`);
  const loaded = await loadOperationLifecycle(modulePath, { engine: {} as BrainEngine, resource: 'https://synthetic.invalid/mcp', operations: [], report: () => {} });
  const gate = deferred();
  loaded!.effects!.enqueue([async () => { await gate.promise; }]);
  await tick();
  const closing = loaded!.shutdown();
  await tick();
  expect((globalThis as any).__effectsCloseStarted).toBe(true);
  expect(loaded!.effects!.pendingCount).toBe(1);
  await closing; // resolves despite both underlying waits remaining unresolved
  await loaded!.shutdown();
  expect((globalThis as any).__effectsCloseCount).toBe(1);
  expect(loaded!.effects!.pendingCount).toBe(1);
  gate.resolve();
  (globalThis as any).__effectsCloseResolve();
  await loaded!.effects!.drain();
  for (const key of ['__effectsCloseCount', '__effectsCloseStarted', '__effectsCloseResolve']) delete (globalThis as any)[key];
}, 1000);
