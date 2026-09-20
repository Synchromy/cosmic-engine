import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('actual think/synthesize lifecycle gates retrieval, compose failures and accepted fallback', async () => {
  const home = await mkdtemp(join(tmpdir(), 'think-lifecycle-'));
  let child: Bun.Subprocess | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = `
import {mock} from 'bun:test';
import * as thinkModule from './src/core/think/index.ts';
const realRunThink=thinkModule.runThink;
let mode='ok';
mock.module('./src/core/think/index.ts',()=>({...thinkModule,runThink:(engine,opts)=>realRunThink(engine,{...opts,embedQuestion:undefined,withTrajectory:false,
 ...(mode==='compose-failed'?{client:{create:async()=>{throw new Error('synthetic provider failure')}}}:{stubResponse:{answer:'PROTECTED-SYNTHETIC-ANSWER',citations:[],gaps:[]}})})}));
const {EventEmitter}=await import('node:events');
const {dispatchToolCall}=await import('./src/mcp/dispatch.ts');
const {runOperationRequest}=await import('./src/core/operation-lifecycle-runner.ts');
const auth={token:'synthetic',clientId:'fixture',scopes:['read'],sourceId:'default'};
const results=[];
for(const name of ['think','synthesize'])for(mode of ['ok','unavailable','compose-failed']){
 for(const configured of [true,false]){
  const events=[];
  const rows=async()=>{if(mode==='unavailable')throw new Error('PRIVATE-SYNTHETIC-ERROR');return [];};
  const engine={kind:'pglite',getConfig:async()=>null,executeRaw:rows,resolveAliases:async()=>new Map(),getPage:async()=>null,
   getContentFlagsByPageIds:async()=>new Map(),getUnverifiedExtractionPageIds:async()=>new Map(),relationalFanout:rows,
   searchVector:rows,searchKeyword:rows,searchTitles:rows,searchTakes:rows,searchTakesVector:rows,traversePaths:rows,
   listPages:async()=>{await rows();return mode==='compose-failed'?[{id:1,slug:'notes/synthetic',title:'Synthetic',type:'note',source_id:'default',compiled_truth:'PROTECTED-SYNTHETIC-EXTRACT',effective_date:new Date('2026-09-15')}]:[];}};
  const loaded={host:{version:1,limits:{operationTimeoutMs:3000,maxResponseBytes:65536,shutdownTimeoutMs:30},
   begin:async i=>{events.push('begin');return {kind:'admitted',admission:{expiresAt:i.deadlineAt,allowOptionalEnrichment:true,
    authorize:async()=>{events.push('authorize');return {kind:'deliver'};},release:async()=>{events.push('release');}}};},shutdown:async()=>{}},
   signal:new AbortController().signal,reportFailure:()=>events.push('report'),shutdown:async()=>{}};
  const dispatch=scope=>dispatchToolCall(engine,name,{question:'orchard telemetry notes explain rainfall across seasons this week',since:'2026-09-01'},
   {remote:true,transport:'http',auth,sourceId:'default',operationRequest:scope,metaHook:async()=>{events.push('meta');return {private_memory:'PROTECTED-METADATA'};}});
  const result=configured?await runOperationRequest(loaded,'https://synthetic.invalid/mcp',auth,new EventEmitter(),new EventEmitter(),dispatch):await dispatch();
  results.push({name,mode,configured,result,events});
 }
}
console.log(JSON.stringify(results));
`;
    const spawned = Bun.spawn([process.execPath, '--eval', code], {
      cwd: process.cwd(), env: { PATH: process.env.PATH!, HOME: home, GBRAIN_HOME: home },
      stdout: 'pipe', stderr: 'pipe',
    });
    child = spawned;
    const out = new Response(spawned.stdout).text().catch(() => ''), err = new Response(spawned.stderr).text().catch(() => '');
    const deadline = new Promise<never>((_, reject) => {
      watchdog = setTimeout(() => { spawned.kill('SIGKILL'); reject(new Error('Synthetic lifecycle fixture deadline')); }, 15000);
    });
    const exit = await Promise.race([spawned.exited, deadline]);
    await err;
    if (exit !== 0) throw new Error('Synthetic lifecycle fixture failed');
    const observations = JSON.parse(await out);
    expect(observations.length).toBe(12);
    for (const row of observations) {
      const fail = row.configured && (row.mode === 'unavailable' || (row.name === 'think' && row.mode === 'compose-failed'));
      expect(row.result.isError === true).toBe(fail);
      expect(row.events).toEqual(row.configured ? fail ? ['begin', 'release'] : ['begin', 'meta', 'authorize'] : ['meta']);
      if (fail) {
        expect(JSON.stringify(row.result)).not.toContain('PROTECTED');
        expect(JSON.stringify(row.result)).not.toContain('PRIVATE-SYNTHETIC');
        expect(JSON.stringify(row.result)).toContain('unavailable');
      } else if (row.name === 'synthesize' && row.mode === 'compose-failed') {
        expect(JSON.stringify(row.result)).toContain('extractive_fallback');
        expect(JSON.stringify(row.result)).toContain('PROTECTED-SYNTHETIC-EXTRACT');
      }
    }
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (child) {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
    }
    await rm(home, { recursive: true, force: true });
  }
}, 30000);
