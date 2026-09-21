import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { compareAndSwapSessionContextCursor as cas, readSessionContextStateForDelivery as read, createSessionCursorDeliveryEffect as effect, getSessionContextState } from '../src/core/context/session-state.ts';

let lite: PGLiteEngine;
let pg: ReturnType<typeof postgres> | undefined;
const engines: Array<{name: string; engine: () => BrainEngine}> = [{name: 'PGLite', engine: () => lite}];
if (process.env.DELTA_TEST_PG) engines.push({name: 'PostgreSQL', engine: () => ({executeRaw: async (sql: string, params: unknown[]) => pg!.unsafe(sql, params as never)}) as unknown as BrainEngine});
beforeAll(async () => {
  lite = new PGLiteEngine();
  await lite.connect({});
  await lite.initSchema();
  if (process.env.DELTA_TEST_PG) {
    const url = new URL(process.env.DELTA_TEST_PG);
    if (url.hostname !== '127.0.0.1' || url.port !== '54338' || url.username !== 'delta_fixture') throw new Error('Synthetic local fixture required');
    pg = postgres(process.env.DELTA_TEST_PG, {max: 2});
    await pg.unsafe(`CREATE TABLE IF NOT EXISTS session_context_state (
      source_id text NOT NULL, client_id text NOT NULL, session_id text NOT NULL,
      standing_entities jsonb NOT NULL DEFAULT '[]', surfaced_slugs jsonb NOT NULL DEFAULT '[]',
      checkpoint_manifest jsonb NOT NULL DEFAULT '[]', last_wake_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(source_id,client_id,session_id))`);
  }
}, 120000);
afterAll(async () => { await lite?.disconnect(); await pg?.end(); });
const at = '2026-09-20T00:00:00.123456Z', later = '2026-09-20T00:00:00.123457Z';
for (const fixture of engines) describe(fixture.name, () => {
  beforeEach(async () => { await fixture.engine().executeRaw('DELETE FROM session_context_state'); });
  async function seed(slugs: string[] = [], time: string|null = at) {
    await fixture.engine().executeRaw(`INSERT INTO session_context_state(source_id,client_id,session_id,standing_entities,surfaced_slugs,last_wake_at,checkpoint_manifest)
      VALUES ('default','client','session','["keep"]'::jsonb,$1::text::jsonb,$2::text::timestamptz,'[{"slug":"synthetic"}]'::jsonb)`, [JSON.stringify(slugs),time]);
  }
  test('absence insert never overwrites concurrent creation', async () => {
    expect(await read(fixture.engine(),'default','client','session')).toEqual({status:'absent'});
    await seed(['other']);
    expect(await cas(fixture.engine(),'default','client','session',{status:'absent'},{lastWakeAt:later})).toBe('not_applied');
    expect((await read(fixture.engine(),'default','client','session'))).toMatchObject({status:'present', expected:{lastWakeAt:at,cursorSlug:'other'}});
  });
  test('same expected cursor allows only one concurrent winner', async () => {
    await seed(['a']);
    const observed = await read(fixture.engine(),'default','client','session');
    if(observed.status !== 'present') throw new Error('Fixture unavailable');
    const results = await Promise.all(['b','c'].map(cursorSlug => cas(fixture.engine(),'default','client','session',observed.expected,{lastWakeAt:later,cursorSlug})));
    expect(results.sort()).toEqual(['applied','not_applied']);
  });
  test('raw microseconds and first slot both constrain updates', async () => {
    await seed(['a']);
    expect(await cas(fixture.engine(),'default','client','session',{status:'present',lastWakeAt:later,cursorSlug:'a'},{lastWakeAt:later})).toBe('not_applied');
    expect(await cas(fixture.engine(),'default','client','session',{status:'present',lastWakeAt:at,cursorSlug:'b'},{lastWakeAt:later})).toBe('not_applied');
    expect(await cas(fixture.engine(),'default','client','session',{status:'present',lastWakeAt:at,cursorSlug:'a'},{lastWakeAt:later})).toBe('applied');
    expect(await read(fixture.engine(),'default','client','session')).toMatchObject({expected:{lastWakeAt:later,cursorSlug:'a'}});
  });
  test('null first slot differs from empty string, null timestamp matches', async () => {
    await seed([],null);
    expect(await read(fixture.engine(),'default','client','session')).toMatchObject({status:'present',expected:{lastWakeAt:null,cursorSlug:null}});
    expect(await cas(fixture.engine(),'default','client','session',{status:'present',lastWakeAt:null,cursorSlug:''},{lastWakeAt:at})).toBe('not_applied');
    expect(await cas(fixture.engine(),'default','client','session',{status:'present',lastWakeAt:null,cursorSlug:null},{lastWakeAt:at,cursorSlug:''})).toBe('applied');
    expect(await cas(fixture.engine(),'default','client','session',{status:'present',lastWakeAt:at,cursorSlug:null},{lastWakeAt:later})).toBe('not_applied');
  });
  test('omitted desired slug preserves metadata and normalized identity', async () => {
    await seed(['a','retained']);
    expect(await cas(fixture.engine(),'default',' client ','session',{status:'present',lastWakeAt:at,cursorSlug:'a'},{lastWakeAt:later})).toBe('applied');
    const rows = await fixture.engine().executeRaw<{standing_entities:unknown;surfaced_slugs:unknown;checkpoint_manifest:unknown}>('SELECT standing_entities,surfaced_slugs,checkpoint_manifest FROM session_context_state');
    expect(rows[0]).toEqual({standing_entities:['keep'],surfaced_slugs:['a','retained'],checkpoint_manifest:[{slug:'synthetic'}]});
    for (const [source,client,session] of [['other','client','session'],['default','other','session'],['default','client','other']]) {
      expect(await cas(fixture.engine(),source,client,session,{status:'present',lastWakeAt:later,cursorSlug:'a'},{lastWakeAt:at})).toBe('not_applied');
    }
  });
  test('new absent row uses defaults and bounded namespace', async () => {
    expect(await cas(fixture.engine(),'default',null,'x'.repeat(210),{status:'absent'},{lastWakeAt:at})).toBe('applied');
    expect(await read(fixture.engine(),'default','local','x'.repeat(200))).toMatchObject({status:'present',state:{standing_entities:[],surfaced_slugs:[]},expected:{lastWakeAt:at,cursorSlug:null}});
  });
});
test('malformed cursor projection cannot be interpreted as first wake', async () => {
  const valid = {standing_entities:[],surfaced_slugs:[],last_wake_at:null,cursor_slug:null};
  for(const patch of [{last_wake_at:undefined},{last_wake_at:'2026-02-31T00:00:00.000000Z'},{surfaced_slugs:[1]},{standing_entities:'bad'},{cursor_slug:''},{last_wake_at:'2026-09-20T00:00:00.123Z'}]) {
    const engine = {executeRaw:async()=>[{...valid,...patch}]} as unknown as BrainEngine;
    expect(await read(engine,'default','client','session')).toEqual({status:'unavailable'});
  }
  const outage = {executeRaw:async()=>{throw new Error('PRIVATE');}} as unknown as BrainEngine;
  expect(await read(outage,'default','client','session')).toEqual({status:'unavailable'});
  expect(await getSessionContextState(outage,'default','client','session')).toBeNull();
});
test('effect copies operands and guards cancellation and failed CAS', async () => {
  const calls: Array<{sql:string;params:unknown[]}> = [];
  const control = new AbortController();
  const engine = {executeRaw:async(sql:string,params:unknown[])=>{calls.push({sql,params});control.abort();return [{applied:1}];}} as unknown as BrainEngine;
  const expected = {status:'present' as const,lastWakeAt:at,cursorSlug:'a'};
  const desired = {lastWakeAt:later,cursorSlug:'b'};
  const work = effect(engine,'default',' client ','s'.repeat(210),expected,desired,true);
  expected.cursorSlug='changed'; desired.cursorSlug='changed';
  await work(control.signal);
  expect(calls).toHaveLength(1);
  expect(calls[0].params).toEqual(['default','client','s'.repeat(200),later,'["b"]',true,at,'a']);
  await work(control.signal);
  expect(calls).toHaveLength(1);
});
test('conflict skips GC; GC checks abort between statements; unavailable is static', async () => {
  let calls=0;const controller=new AbortController();
  const conflict={executeRaw:async()=>{calls++;return [];}} as unknown as BrainEngine;
  await effect(conflict,'default',null,'s',{status:'absent'},{lastWakeAt:at},true)(controller.signal);
  expect(calls).toBe(1);
  const gc={executeRaw:async()=>{calls++;if(calls===3)controller.abort();return [{applied:1}];}} as unknown as BrainEngine;
  await effect(gc,'default',null,'s',{status:'absent'},{lastWakeAt:at},true)(controller.signal);
  expect(calls).toBe(3);
  const bad={executeRaw:async()=>{throw new Error('PRIVATE');}} as unknown as BrainEngine;
  await expect(effect(bad,'default',null,'s',{status:'absent'},{lastWakeAt:at})(new AbortController().signal)).rejects.toThrow('Session cursor update unavailable');
});
