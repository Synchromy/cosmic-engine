import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { runOperationRequest } from '../src/core/operation-lifecycle-runner.ts';
import { OperationDeliveryEffects } from '../src/core/operation-delivery-effects.ts';
import type { LoadedLifecycle } from '../src/core/operation-lifecycle-loader.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { readSessionContextStateForDelivery } from '../src/core/context/session-state.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const auth = { token: 'synthetic', clientId: 'fixture', scopes: ['read'], sourceId: 'default' };
let engine: PGLiteEngine;
beforeAll(async()=>{engine=new PGLiteEngine();await engine.connect({});await engine.initSchema();},120000);
beforeEach(async()=>{await engine.executeRaw('DELETE FROM session_context_state');});
afterAll(async()=>{await engine.disconnect();});
type Options={outage?:boolean;malformed?:boolean;since?:string;standalone?:boolean;authorize?:'refuse'|'throw'|'timeout'|'disconnect';maxBytes?:number;pendingWrite?:Promise<void>;rejectWrite?:boolean;failRead?:boolean;postHandlerThrow?:boolean;page?:boolean;budget?:number;finalRenderFailure?:boolean};
async function invoke(opts:Options={}) {
  const count={writes:0,writesAtAuthorize:-1};
  const events:string[]=[];
  const response=new EventEmitter();
  const e = new Proxy(engine,{get(target,key){
    if(key==='executeRaw')return async(sql:string,params?:unknown[])=>{
      if(/INSERT|UPDATE|DELETE/.test(sql)){count.writes++;if(opts.pendingWrite)await opts.pendingWrite;if(opts.rejectWrite)throw new Error('PRIVATE-WRITE');}
      if(/SELECT.*|FROM session_context_state/s.test(sql)&&sql.includes('FROM session_context_state')&&!/DELETE/.test(sql)){
        if(opts.outage)throw new Error('PRIVATE-READ');
        if(opts.malformed)return [{standing_entities:[],surfaced_slugs:[],last_wake_at:undefined,cursor_slug:null}];
      }
      return target.executeRaw(sql,params);
    };
    if(opts.page&&key==='listPages')return async()=>[{slug:'notes/synthetic',title:'Synthetic page',updated_at_iso:'2026-09-20T00:00:00.123456Z'}];
    if(opts.finalRenderFailure&&key==='listFactsSince')return async()=>{let reads=0;return [{get fact(){if(++reads===4)throw new Error('PRIVATE-RENDER');return 'Synthetic';},created_at:new Date('2026-09-20T01:00:00Z'),valid_from:new Date('2026-09-20T01:00:00Z')}];};
    if(opts.failRead&&['listPages','listFactsSince','getFacts','getOpenThreads','getEntityAliases','getBrainHotMemoryMeta'].includes(String(key)))return async()=>{throw new Error('PRIVATE-ASSEMBLER');};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }}) as BrainEngine;
  const effects=new OperationDeliveryEffects(200,()=>events.push('effect-failed'));
  const loaded:LoadedLifecycle={
    effects,host:{version:1,limits:{operationTimeoutMs:opts.authorize==='timeout'?20:1000,maxResponseBytes:opts.maxBytes??65536,shutdownTimeoutMs:200},
      begin:async i=>({kind:'admitted',admission:{expiresAt:i.deadlineAt,allowOptionalEnrichment:false,
        authorize:async()=>{
          count.writesAtAuthorize=count.writes;events.push('authorize');
          if(opts.authorize==='refuse')return {kind:'refused',failure:{code:'resource_exhausted',message:'Synthetic unavailable'}};
          if(opts.authorize==='throw')throw new Error('PRIVATE-AUTHORIZE');
          if(opts.authorize==='timeout')await new Promise(resolve=>setTimeout(resolve,50));
          if(opts.authorize==='disconnect')response.emit('close');
          return {kind:'deliver'};
        },release:async()=>{events.push('release');}}}),shutdown:async()=>{}},
    signal:new AbortController().signal,reportFailure:()=>{},shutdown:async()=>{},
  };
  const params={session_id:'synthetic',...(opts.budget?{budget_tokens:opts.budget}:{}),...(opts.since?{since:opts.since}:{})};
  const result=opts.standalone
    ?await dispatchToolCall(e,'delta',params,{remote:true,transport:'http',auth,sourceId:'default'})
    :await runOperationRequest(loaded,'https://synthetic.invalid/mcp',auth,new EventEmitter(),response,
      async scope=>{const result=await dispatchToolCall(e,'delta',params,{remote:true,transport:'http',auth,sourceId:'default',operationRequest:scope});if(opts.postHandlerThrow)throw new Error('PRIVATE-AUDIT');return result;});
  return {result,count,events,effects};
}
test('state outage or malformed projection without since is not first wake',async()=>{
  for(const opts of [{outage:true},{malformed:true}]){
    const r=await invoke(opts);await r.effects.drain();
    expect(r.result.isError).toBe(true);expect(r.events).toEqual(['release']);expect(r.count.writes).toBe(0);
    expect(JSON.stringify(r.result)).not.toContain('PRIVATE');
  }
});
test('confirmed first wake writes only after definitive authorization',async()=>{
  const r=await invoke();await r.effects.drain();
  expect(r.result.isError).toBeUndefined();expect(r.count.writesAtAuthorize).toBe(0);expect(r.count.writes).toBe(3);
  expect(r.events).toEqual(['authorize']);
  const rows=await engine.executeRaw('SELECT * FROM session_context_state');expect(rows).toHaveLength(1);
});
test('present null-wake preserves standing entities and slug on first wake',async()=>{
  await engine.executeRaw(`INSERT INTO session_context_state(source_id,client_id,session_id,standing_entities,surfaced_slugs) VALUES ('default','fixture','synthetic','["keep"]','["keep-slug"]')`);
  const r=await invoke();await r.effects.drain();
  expect(r.result.isError).toBeUndefined();expect(r.count.writesAtAuthorize).toBe(0);
  expect((await engine.executeRaw('SELECT standing_entities,surfaced_slugs FROM session_context_state'))[0]).toEqual({standing_entities:['keep'],surfaced_slugs:['keep-slug']});
});
test('explicit since allows completed stateless read during state outage with no write',async()=>{
  const r=await invoke({outage:true,since:'2026-09-20T00:00:00Z'});await r.effects.drain();
  expect(r.result.isError).toBeUndefined();expect(r.events).toEqual(['authorize']);expect(r.count.writes).toBe(0);
});
test('standalone retains fail-open first wake and awaited writes',async()=>{
  const r=await invoke({outage:true,standalone:true});
  expect(r.result.isError).toBeUndefined();expect(r.count.writes).toBe(3);expect(r.events).toEqual([]);
});
for(const mode of ['refuse','throw','timeout','disconnect'] as const)test('authorization '+mode+' never launches cursor effect',async()=>{
  const r=await invoke({authorize:mode});await r.effects.drain();
  expect(r.result.isError).toBe(true);expect(r.count.writes).toBe(0);expect(r.events.filter(x=>x==='release')).toHaveLength(1);
});
test('oversized response and post-handler audit failure discard registered effect',async()=>{
  for(const opts of [{maxBytes:1},{postHandlerThrow:true}]){
    const r=await invoke(opts);await r.effects.drain();expect(r.result.isError).toBe(true);expect(r.count.writes).toBe(0);expect(r.events).toEqual(['release']);
  }
});
test('failed required assembly neither authorizes nor advances cursor',async()=>{
  const r=await invoke({since:'2026-09-20T00:00:00Z',failRead:true});await r.effects.drain();
  expect(r.result.isError).toBe(true);expect(r.count.writes).toBe(0);expect(r.events).toEqual(['release']);
});
test('pending CAS is off handoff path, failure is static and cannot retract result',async()=>{
  let resolve!:()=>void;let resolved=false;const pendingWrite=new Promise<void>(done=>resolve=()=>{resolved=true;done();});
  let r:Awaited<ReturnType<typeof invoke>>|undefined;
  const timer=setTimeout(resolve,1000);
  try{
    r=await invoke({pendingWrite,rejectWrite:true});
    expect(r.result.isError).toBeUndefined();expect(r.count.writesAtAuthorize).toBe(0);
    expect(resolved).toBe(false);expect(r.effects.pendingCount).toBe(1);expect(r.events).toEqual(['authorize']);
  }finally{clearTimeout(timer);resolve();await r?.effects.drain();}
  expect(r!.result.isError).toBeUndefined();expect(r!.events).toEqual(['authorize','effect-failed']);
});

test('successful page delivery stores exact response cursor after authorize',async()=>{
  const r=await invoke({since:'2026-09-20T00:00:00Z',page:true});await r.effects.drain();
  const payload=JSON.parse((r.result.content[0] as {text:string}).text);
  expect(payload.next_cursor).toEqual({since:'2026-09-20T00:00:00.123456Z',slug:'notes/synthetic'});
  expect(r.count.writesAtAuthorize).toBe(0);expect(r.count.writes).toBe(1);
  expect(await readSessionContextStateForDelivery(engine,'default','fixture','synthetic')).toMatchObject({expected:{lastWakeAt:'2026-09-20T00:00:00.123456Z',cursorSlug:'notes/synthetic'}});
});
test('budget withheld pages do not advance; response rendering failure registers no effect',async()=>{
  const r=await invoke({since:'2026-09-20T00:00:00Z',page:true,budget:1});await r.effects.drain();
  const payload=JSON.parse((r.result.content[0] as {text:string}).text);
  expect(payload.pages).toEqual([]);expect(payload.has_more).toBe(true);expect(r.count.writes).toBe(0);
  const bad=await invoke({since:'2026-09-20T00:00:00Z',finalRenderFailure:true});await bad.effects.drain();
  expect(bad.result.isError).toBe(true);expect(bad.count.writes).toBe(0);expect(bad.events).toEqual(['release']);
});
