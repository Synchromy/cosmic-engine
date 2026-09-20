import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hashToken } from '../src/core/utils.ts';
import { boundedWait } from '../src/core/operation-lifecycle-loader.ts';
import { canonicalOriginal, COMPOSITE_PATH, PROOF_HEADER, CAPABILITY_HEADER, DEADLINE_HEADER } from '../src/core/operation-original-envelope.ts';

const root = await mkdtemp(join(tmpdir(), 'gbrain-composite-http-'));
afterAll(() => rm(root, { recursive: true, force: true }));
const binary = process.env.GBRAIN_TEST_COMPOSITE_BIN;
for (const mode of binary ? ['source', 'compiled'] : ['source']) describe(mode + ' composite HTTP', () => {
  const home = join(root, mode), token = 'synthetic-composite-http-only';
  beforeAll(async () => {
    await mkdir(home); await mkdir(join(home, '.gbrain'));
    const database = join(home, 'brain'), db = new PGLiteEngine();
    try {
      await db.connect({ database_path: database }); await db.initSchema();
      await db.executeRaw("INSERT INTO access_tokens(token_hash,name,scopes) VALUES($1,'synthetic-composite',ARRAY['read'])", [hashToken(token)]);
    } finally { await db.disconnect(); }
    await writeFile(join(home, '.gbrain/config.json'), JSON.stringify({
      engine: 'pglite', database_path: database, embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536,
    }));
  }, 30_000);
  test('actual legacy-bearer verification, original SDK body and composite pipeline', async () => {
    const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
    const port = probe.port!; await probe.stop(true);
    const base = 'http://127.0.0.1:' + port, marker = join(home, 'events.jsonl'), modulePath = join(home, 'host.mjs');
    await writeFile(modulePath, `
import {appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const record=x=>appendFile(${JSON.stringify(marker)},JSON.stringify(x)+'\\n');
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const digest=v=>createHash('sha256').update(canonical(v)).digest('hex');
export const protocolVersion=1;
export async function createOperationLifecycleHost(ports){
 const admission=i=>({expiresAt:i.deadlineAt,allowOptionalEnrichment:false,
   authorize:async()=>{await record({event:'authorize'});return {kind:'deliver'}},
   release:async reason=>record({event:'release',reason})});
 return {version:1,limits:{operationTimeoutMs:2000,maxResponseBytes:65536,shutdownTimeoutMs:100},
  begin:async i=>{await record({event:'ordinary'});return {kind:'admitted',admission:admission(i)}},
  shutdown:async()=>record({event:'shutdown'}),
  composite:{version:1,operations:[{name:'fixture_composite',scope:'read',mutating:false}],
   execute:async(i,dispatch)=>{
    await record({event:'setup'});
    if(i.proof!=='synthetic-valid-proof')return {kind:'refused',failure:{code:'admission_refused'}};
    return {kind:'admitted',admission:admission(i),run:async ctx=>{
      await record({event:'run'});
      if(i.params.fail){ctx.reportFailure({code:'unavailable'});return {content:[{type:'text',text:'synthetic-protected-failure'}]}}
      const body={jsonrpc:'2.0',id:51,method:'tools/call',params:{name:'get_tags',_meta:{kept:true},arguments:{slug:'synthetic/page',extra:'kept'}}};
      const r=await dispatch(JSON.stringify(body),digest(body),ctx.signal);
      let text=await r.text();
      let media=r.headers.get('content-type')||'';
      if(i.params.invalidChild){media='application/json';text=JSON.stringify(i.params.invalidChild==='error'
        ?{jsonrpc:'2.0',id:51,error:{code:-32000,message:'synthetic error containing51'}}
        :{jsonrpc:'2.0',id:51,result:{content:[{type:'text',text:'{\"message\":\"51\"}'}]}})}
      let accepted=false;
      try {
        const encoded=media.includes('application/json')?text:text.split(String.fromCharCode(10)).filter(line=>line.startsWith('data: ')).map(line=>line.slice(6)).join(String.fromCharCode(10));
        const message=JSON.parse(encoded), result=message.result;
        if(r.ok&&message.jsonrpc==='2.0'&&message.id===51&&!message.error&&result&&result.isError!==true
          &&Array.isArray(result.content)&&result.content.length>=1&&result.content.every(block=>block.type==='text'&&typeof block.text==='string')){
          const tags=JSON.parse(result.content[0].text);accepted=Array.isArray(tags)&&tags.length===0;
        }
      }catch{}
      await record({event:'child-response',status:r.status,accepted});
      if(!accepted)ctx.reportFailure({code:'unavailable'});
      return {content:[{type:'text',text:JSON.stringify({childReceived:accepted,completed:accepted})}]};
    }}
   },
   admitChild:async(i,cap)=>{
    await record({event:'child',original:i.original,principal:i.principal});
    if(cap!==digest(i.original))return {kind:'refused',failure:{code:'admission_refused'}};
    return {kind:'admitted',admission:admission(i)}
   }
  }};
}`);
    const env: Record<string, string> = { PATH: process.env.PATH!, HOME: home, GBRAIN_HOME: home,
      GBRAIN_OPERATION_LIFECYCLE_MODULE: modulePath,
      GBRAIN_OAUTH_RESOURCE_POLICY: JSON.stringify({ canonicalResource: base + '/mcp', aliases: [], allowLegacyUnboundConfidential: false, allowLegacyAccessTokens: true }),
      GBRAIN_ADMIN_BOOTSTRAP_TOKEN: 'synthetic-admin-bootstrap-token-000000000000' };
    const args = [...(mode === 'compiled' ? [binary!] : [process.execPath, 'src/cli.ts']), 'serve', '--http', '--port', String(port),
      '--bind', '127.0.0.1', '--public-url', base, '--suppress-bootstrap-token'];
    const child = Bun.spawn(args, { cwd: process.cwd(), env, stdout: 'pipe', stderr: 'pipe' });
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const stop = async () => {
      if (child.exitCode === null) child.kill('SIGTERM');
      await boundedWait(child.exited, 8000).catch(() => {});
      if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; throw new Error('Synthetic server required forced cleanup'); }
    };
    const events = async () => { try { return (await readFile(marker, 'utf8')).trim().split('\n').filter(Boolean).map(x => JSON.parse(x)); } catch { return []; } };
    const post = (path: string, body: unknown, extra: Record<string, string> = {}, auth = true) => fetch(base + path, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        ...(auth ? { authorization: 'Bearer ' + token } : {}), ...extra }, body: JSON.stringify(body), signal: AbortSignal.timeout(4000) });
    const outer = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'fixture_composite', arguments: {} } };
    const headers = () => ({ [PROOF_HEADER]: 'synthetic-valid-proof', [DEADLINE_HEADER]: String(Date.now() + 1800) });
    try {
      let ready = false;
      for (let n = 0; n < 150 && child.exitCode === null; n++) {
        try { if ((await fetch(base + '/health', { signal: AbortSignal.timeout(100) })).ok) { ready = true; break; } } catch {}
        await new Promise(r => setTimeout(r, 40));
      }
      if (!ready) { await stop(); throw new Error('Synthetic server failed startup: ' + (await output).join('\n')); }
      expect((await post(COMPOSITE_PATH, outer, headers(), false)).status).toBe(401);
      expect((await events()).some(x => x.event === 'setup')).toBe(false);
      const response = await post(COMPOSITE_PATH, outer, headers());
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      if(body.result.isError) throw new Error('Synthetic composite failed: '+JSON.stringify(await events()));
      expect(body.result.isError).not.toBe(true);
      expect(JSON.parse(body.result.content[0].text)).toEqual({ childReceived: true, completed: true });
      const observed = await events(), actual = observed.find(x => x.event === 'child');
      expect(observed.filter(x => x.event === 'ordinary')).toHaveLength(0);
      expect(actual).toBeDefined();
      expect(actual.original.id).toBe(51);
      expect(actual.original.params._meta).toEqual({ kept: true });
      expect(actual.original.params.arguments.extra).toBe('kept');
      expect(observed.filter(x => x.event === 'ordinary')).toHaveLength(0);
      expect(observed.filter(x => x.event === 'authorize')).toHaveLength(2);
      expect(JSON.stringify(observed)).not.toContain(token);
      const direct = { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'get_tags', arguments: { slug: 'synthetic/page' } } };
      const signature = createHash('sha256').update(canonicalOriginal(direct)).digest('hex');
      const tampered = await post('/mcp', { ...direct, id: 9 }, { [CAPABILITY_HEADER]: signature, [DEADLINE_HEADER]: String(Date.now() + 1500) });
      expect(await tampered.text()).toContain('isError');
      expect((await events()).filter(x => x.event === 'ordinary')).toHaveLength(0);
      const extra = { ...direct, extension: 'must-reach-sdk-unchanged' };
      const extraSignature = createHash('sha256').update(canonicalOriginal(extra)).digest('hex');
      const rejectedBySdk = await post('/mcp', extra, { [CAPABILITY_HEADER]: extraSignature, [DEADLINE_HEADER]: String(Date.now()+1500) });
      expect(rejectedBySdk.status).toBe(400);
      const failed = await post(COMPOSITE_PATH, { ...outer, params: { ...outer.params, arguments: { fail: true } } }, headers());
      expect(await failed.text()).not.toContain('synthetic-protected-failure');
      expect((await events()).filter(x => x.event === 'release').length).toBeGreaterThan(0);
      for (const invalidChild of ['error', 'shape']) {
        const invalid = await post(COMPOSITE_PATH, { ...outer, params: { ...outer.params, arguments: { invalidChild } } }, headers());
        const invalidBody = await invalid.json() as any;
        expect(invalidBody.result.isError).toBe(true);
        expect(JSON.stringify(invalidBody)).not.toContain('childReceived');
      }
      expect((await post(COMPOSITE_PATH + '?wrong=1', outer, headers())).status).toBe(403);
    } finally { await stop(); }
    const logs = (await output).join('\n'); expect(logs).not.toContain(token);
    expect([0, 143]).toContain(child.exitCode!);
  }, 30_000);
});
