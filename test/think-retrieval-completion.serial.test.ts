import { afterAll, beforeAll, expect, test } from 'bun:test';
import { runGather } from '../src/core/think/gather.ts';
import { runThink } from '../src/core/think/index.ts';
import { RetrievalCompletion } from '../src/core/retrieval-completion.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const query = 'orchard telemetry notes explain rainfall across seasons this week';
function fixture(fail = false): BrainEngine {
  const rows = async () => { if (fail) throw new Error('synthetic unavailable'); return []; };
  return {
    kind: 'pglite', getConfig: async () => null, executeRaw: rows,
    resolveAliases: async () => new Map(), getPage: async () => null,
    getContentFlagsByPageIds: async () => new Map(), getUnverifiedExtractionPageIds: async () => new Map(),
    relationalFanout: rows, searchVector: rows, searchKeyword: rows, searchTitles: rows,
    searchTakes: rows, searchTakesVector: rows, traversePaths: rows, listPages: rows,
  } as unknown as BrainEngine;
}
for (const mode of ['gather', 'think']) for (const fail of [false, true]) {
  test(mode + (fail ? ' all unavailable has no completion' : ' real empty retrieval completes'), async () => {
    const completion = new RetrievalCompletion();
    const e = fixture(fail);
    if (mode === 'gather') await runGather(e, { question: query, completion } as any);
    else await runThink(e, { question: query, completion, withTrajectory: false,
      stubResponse: { answer: 'Synthetic answer', citations: [], gaps: [] } } as any);
    expect(completion.seal().completed).toBe(!fail);
  });
}

for (const stream of ['hybrid', 'keyword', 'vector', 'graph', 'anchor', 'floor']) {
  test('applicable empty ' + stream + ' survives other unavailable streams', async () => {
    const e = fixture(true);
    e.getPage = async () => { throw new Error('synthetic unavailable'); };
    const completion = new RetrievalCompletion();
    const opts: any = { question: query, completion };
    if (stream === 'hybrid') { e.searchKeyword = async () => []; e.searchTitles = async () => []; }
    if (stream === 'keyword') e.searchTakes = async () => [];
    if (stream === 'vector') { e.searchTakesVector = async () => []; opts.questionEmbedding = new Float32Array([1]); }
    if (stream === 'graph') { e.traversePaths = async () => []; opts.anchor = 'people/synthetic'; }
    if (stream === 'anchor') { e.getPage = async () => null; opts.anchor = 'people/synthetic'; }
    if (stream === 'floor') { e.listPages = async () => []; opts.window = { startMs: 0, endMs: null }; }
    await runGather(e, opts);
    expect(completion.seal().completed).toBe(true);
  });
}
test('required final processing failure never publishes earlier raw query success', async () => {
  for (const mode of ['takes', 'anchor']) {
    const e = fixture(true);
    const completion = new RetrievalCompletion();
    if (mode === 'takes') e.searchTakes = async () => [null] as any;
    else e.getPage = async () => ({ slug: 'people/synthetic', get compiled_truth() { throw new Error('synthetic mapping'); } }) as any;
    await expect(runGather(e, { question: query, completion, ...(mode === 'anchor' ? { anchor: 'people/synthetic' } : {}) })).rejects.toThrow();
    expect(completion.seal().completed).toBe(false);
  }
});
test('failed required temporal floor mapping is not completion', async () => {
  const e = fixture(true);
  e.listPages = async () => [{ effective_date: new Date('invalid') }] as any;
  const c = new RetrievalCompletion();
  await runGather(e, { question: query, completion: c, window: { startMs: 0, endMs: null } });
  expect(c.seal().completed).toBe(false);
});
test('think retrieval evidence remains separate from synthesis failure', async () => {
  const c = new RetrievalCompletion();
  const r = await runThink(fixture(), { question: query, completion: c, withTrajectory: false,
    client: { create: async () => { throw new Error('synthetic provider failure'); } } });
  expect(c.seal().completed).toBe(true);
  expect(r.synthesisOk).toBe(false);
  expect(r.synthesis_status).toBe('llm_error');
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
async function isolated(code: string, deadlineMs = 15000) {
  const home = await mkdtemp(join(tmpdir(), 'think-completion-'));
  let child: Bun.Subprocess | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const spawned = Bun.spawn([process.execPath, '--eval', code], {
      cwd: process.cwd(), env: { PATH: process.env.PATH!, HOME: home, GBRAIN_HOME: home },
      stdout: 'pipe', stderr: 'pipe',
    });
    child = spawned;
    const out = new Response(spawned.stdout).text().catch(() => '');
    const err = new Response(spawned.stderr).text().catch(() => '');
    const deadline = new Promise<never>((_, reject) => {
      watchdog = setTimeout(() => { spawned.kill('SIGKILL'); reject(new Error('Synthetic fixture deadline')); }, deadlineMs);
    });
    const status = await Promise.race([spawned.exited, deadline]);
    await err;
    if (status !== 0) throw new Error('Synthetic fixture failed');
    return JSON.parse(await out);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (child) {
      if (child.exitCode === null) child.kill('SIGKILL');
      await child.exited;
    }
    await rm(home, { recursive: true, force: true });
  }
}

test('owned fixture timeout kills and reaps before cleanup returns', async () => {
  await expect(isolated('setInterval(() => {}, 1000)', 50)).rejects.toThrow('Synthetic fixture deadline');
});

test('discarded temporal floor cannot lend completion after rejected hybrid', async () => {
  const r = await isolated(`
import {mock} from 'bun:test';
import * as hybrid from './src/core/search/hybrid.ts';
mock.module('./src/core/search/hybrid.ts',()=>({...hybrid,hybridSearch:async()=>{throw new Error('synthetic rejected hybrid')}}));
const {runGather}=await import('./src/core/think/gather.ts');
const {RetrievalCompletion}=await import('./src/core/retrieval-completion.ts');
const c=new RetrievalCompletion();
const r=await runGather({listPages:async()=>[],searchTakes:async()=>{throw new Error('synthetic takes')}},{question:'fixture',window:{startMs:0,endMs:null},completion:c});
console.log(JSON.stringify({completed:c.seal().completed,pages:r.pages}));
`);
  expect(r).toEqual({ completed: false, pages: [] });
});

test('actual trajectory race accepts only processed query winners and observes late results', async () => {
  const r = await isolated(`
import {mock} from 'bun:test';
import * as gather from './src/core/think/gather.ts';
mock.module('./src/core/think/gather.ts',()=>({...gather,runGather:async()=>({pages:[],takes:[],graphSlugs:[],warnings:[],diagnostics:{pagesFromHybrid:0,takesFromKeyword:0,takesFromVector:0,graphHits:0,questionSanitizedFor:'none'}})}));
let mode='empty';
mock.module('./src/core/entities/resolve.ts',()=>({resolveEntitySlugWithSource:async()=>mode==='unresolved'?null:{slug:'people/synthetic',source:mode==='fallback'?'fallback_slugify':'exact_page'}}));
mock.module('./src/core/think/entity-extract.ts',()=>({extractCandidateEntities:()=>[{raw:'synthetic'},{raw:'duplicate'}]}));
const {runThink}=await import('./src/core/think/index.ts');
const {RetrievalCompletion}=await import('./src/core/retrieval-completion.ts');
const realTimer=globalThis.setTimeout;
globalThis.setTimeout=((fn,ms,...args)=>realTimer(fn,ms===5000?5:ms,...args));
const point={fact_id:1,valid_from:new Date('2026-09-01'),metric:null,value:null,unit:null,period:null,event_type:'meeting',text:'SYNTHETIC-TRAJECTORY',source_session:null,source_markdown_slug:null,embedding:null};
const results=[];
try {
 for(mode of ['empty','points','filtered','format-empty','failed','malformed','timeout','unresolved','fallback']){
  let calls=0,resolveLate;
  const e={getConfig:async()=>null,findTrajectory:async()=>{calls++;if(mode==='failed')throw new Error('synthetic failure');if(mode==='timeout')return new Promise(r=>resolveLate=r);if(mode==='empty')return [];if(mode==='malformed')return [{...point,valid_from:'invalid'}];if(mode==='format-empty')return [{...point,event_type:null}];return [point];}};
  const c=new RetrievalCompletion(),captured=[];
  const client={create:async p=>{captured.push(p.messages[0].content);return {content:[{type:'text',text:JSON.stringify({answer:'synthetic answer',citations:[],gaps:[]})}],stop_reason:'end_turn',usage:{input_tokens:1,output_tokens:1}}}};
  const result=await runThink(e,{question:'When did Synthetic change?',completion:c,client,...(['filtered','malformed'].includes(mode)?{since:'2026-09-10'}:{})});
  const before=JSON.stringify(result),completed=c.seal().completed;
  if(resolveLate){resolveLate([point]);await new Promise(r=>realTimer(r,0));}
  results.push({mode,completed,after:c.seal().completed,stable:before===JSON.stringify(result),calls,hasMemory:captured.join('').includes('SYNTHETIC-TRAJECTORY')});
 }
}finally{globalThis.setTimeout=realTimer;}
console.log(JSON.stringify(results));
`);
  for (const row of r) {
    expect(row.completed).toBe(['empty', 'points', 'filtered', 'format-empty'].includes(row.mode));
    expect(row.after).toBe(row.completed);
    expect(row.stable).toBe(true);
    expect(row.calls).toBe(['unresolved', 'fallback'].includes(row.mode) ? 0 : 1);
    expect(row.hasMemory).toBe(row.mode === 'points');
  }
});

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
let scopedEngine: PGLiteEngine;
beforeAll(async () => {
  scopedEngine = new PGLiteEngine();
  await scopedEngine.connect({});
  await scopedEngine.initSchema();
  const e = scopedEngine;
    await e.putPage('people/public', { type: 'person', title: 'Public Synthetic', compiled_truth: 'PUBLIC-SYNTHETIC-MEMORY' });
    await e.putPage('people/private', { type: 'person', title: 'Private Synthetic', compiled_truth: 'PRIVATE-SYNTHETIC-MEMORY', frontmatter: { visibility: 'private' } });
    await e.executeRaw("INSERT INTO sources (id,name) VALUES ('foreign','foreign')");
    await e.putPage('people/foreign', { type: 'person', title: 'Foreign Synthetic', compiled_truth: 'FOREIGN-SYNTHETIC-MEMORY' }, { sourceId: 'foreign' });
}, 60000);
afterAll(async () => { await scopedEngine?.disconnect(); });
test('actual scoped PGLite gather and think preserve accepted visibility', async () => {
  const e = scopedEngine;
    for (const anchor of ['people/public', 'people/private', 'people/foreign', 'people/missing']) {
      const c = new RetrievalCompletion();
      const result = await runGather(e, { question: query, sourceId: 'default', anchor, excludePrivate: true, remote: true, completion: c });
      expect(c.seal().completed).toBe(true);
      expect(JSON.stringify(result)).not.toContain('PRIVATE-SYNTHETIC-MEMORY');
      expect(JSON.stringify(result)).not.toContain('FOREIGN-SYNTHETIC-MEMORY');
      expect(JSON.stringify(result).includes('PUBLIC-SYNTHETIC-MEMORY')).toBe(anchor === 'people/public');
    }
    const c = new RetrievalCompletion();
    const result = await runThink(e, { question: query, sourceId: 'default', anchor: 'people/public', completion: c, withTrajectory: false,
      stubResponse: { answer: 'Synthetic accepted answer', citations: [], gaps: [] } });
    expect(c.seal().completed).toBe(true);
    expect(result.synthesisOk).toBe(true);
}, 60000);
