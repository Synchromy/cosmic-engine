import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundedWait, loadOperationLifecycle } from '../src/core/operation-lifecycle-loader.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const root = await mkdtemp(join(tmpdir(), 'gbrain-lifecycle-modules-'));
afterAll(() => rm(root, { recursive: true, force: true }));
let seq = 0;
const ports = { engine: {} as BrainEngine, resource: 'https://synthetic.invalid/mcp', operations: [], report: () => {} };
async function moduleFile(source: string) {
  const path = join(root, 'module-' + seq++ + '.mjs');
  await writeFile(path, source);
  return path;
}
const hostSource = `
export const protocolVersion = 1;
export async function createOperationLifecycleHost() {
 return {version:1, limits:{operationTimeoutMs:1000,maxResponseBytes:65536,shutdownTimeoutMs:30},
 begin:async()=>({kind:'refused',failure:{code:'admission_refused'}}),
 shutdown:async()=>{}};
}`;

describe('trusted lifecycle module loader', () => {
  test('unset performs no initialization', async () => {
    expect(await loadOperationLifecycle(undefined, ports)).toBeUndefined();
  });
  test('rejects relative paths, URLs, directories, missing files and absent resource', async () => {
    for (const path of ['./relative.mjs', 'https://synthetic.invalid/module.mjs', root, join(root, 'missing.mjs')]) {
      await expect(loadOperationLifecycle(path, ports)).rejects.toThrow('Configured operation lifecycle could not initialize');
    }
    await expect(loadOperationLifecycle(await moduleFile(hostSource), { ...ports, resource: '' })).rejects.toThrow('could not initialize');
  });
  test('external relative dependency imports and shutdown runs once', async () => {
    await writeFile(join(root, 'dependency.mjs'), 'export const version=1;');
    const marker = join(root, 'closed.txt');
    const source = hostSource.replace('export const protocolVersion = 1;', "import {version} from './dependency.mjs'; export const protocolVersion=version;")
      .replace('shutdown:async()=>{}', 'shutdown:async()=>{await (await import("node:fs/promises")).appendFile(' + JSON.stringify(marker) + ',"closed\\n")}');
    const loaded = await loadOperationLifecycle(await moduleFile(source), ports);
    expect(loaded?.host.version).toBe(1);
    expect(Object.isFrozen(loaded?.host.limits)).toBe(true);
    await Promise.all([loaded!.shutdown(), loaded!.shutdown()]);
    expect(await readFile(marker, 'utf8')).toBe('closed\n');
    expect(loaded!.signal.aborted).toBe(true);
  });
  test('invalid contracts and exception text never escape initialization', async () => {
    for (const source of [
      'throw new Error("fixture-secret");',
      hostSource.replace('protocolVersion = 1', 'protocolVersion = 2'),
      hostSource.replace('version:1, limits', 'version:2, limits'),
      hostSource.replace('operationTimeoutMs:1000', 'operationTimeoutMs:Infinity'),
      hostSource.replace('maxResponseBytes:65536', 'maxResponseBytes:0'),
      hostSource.replace('shutdownTimeoutMs:30', 'shutdownTimeoutMs:NaN'),
      hostSource.replace('begin:async()', 'beginMissing:async()'),
    ]) {
      const result = await loadOperationLifecycle(await moduleFile(source), ports).catch(e => e);
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe('Configured operation lifecycle could not initialize');
      expect(result.message).not.toContain('fixture-secret');
    }
  });
  test('invalid host still closes acquired resources', async () => {
    const marker = join(root, 'invalid-closed.txt');
    const source = hostSource.replace('version:1, limits', 'version:2, limits')
      .replace('shutdown:async()=>{}', 'shutdown:async()=>{await (await import("node:fs/promises")).appendFile(' + JSON.stringify(marker) + ',"closed")}');
    await expect(loadOperationLifecycle(await moduleFile(source), ports)).rejects.toThrow('could not initialize');
    expect(await readFile(marker, 'utf8')).toBe('closed');
  });
  test('asynchronous shutdown failure is bounded and once-only', async () => {
    let failures = 0;
    const source = hostSource.replace('shutdown:async()=>{}', 'shutdown:async()=>new Promise(()=>{})');
    const loaded = await loadOperationLifecycle(await moduleFile(source), { ...ports, report: e => { if (e === 'cleanup_failure') failures++; } });
    await loaded!.shutdown();
    await loaded!.shutdown();
    expect(failures).toBe(1);
  });
  test('factory resolving after initialization timeout is closed once and never loaded', async () => {
    const path = await moduleFile(`
export const protocolVersion=1;
globalThis.__gbrainLifecycleLateCloseCount=0;
let release;
globalThis.__gbrainLifecycleComplete=()=>release({
 version:1, limits:{operationTimeoutMs:1000,maxResponseBytes:1000,shutdownTimeoutMs:30},
 begin:async()=>({kind:'refused',failure:{code:'admission_refused'}}),
 shutdown:async()=>{globalThis.__gbrainLifecycleLateCloseCount++;}
});
export async function createOperationLifecycleHost(){return new Promise(r=>{release=r;});}
`);
    await expect(loadOperationLifecycle(path, ports)).rejects.toThrow('could not initialize');
    (globalThis as any).__gbrainLifecycleComplete();
    await new Promise(r => setTimeout(r, 20));
    expect((globalThis as any).__gbrainLifecycleLateCloseCount).toBe(1);
    delete (globalThis as any).__gbrainLifecycleComplete;
    delete (globalThis as any).__gbrainLifecycleLateCloseCount;
  }, 15_000);
});

import { mkdir } from 'node:fs/promises';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hashToken } from '../src/core/utils.ts';

const compiledBinary = process.env.GBRAIN_TEST_LIFECYCLE_BIN;
const httpSuite = compiledBinary ? describe : describe.skip;
httpSuite('actual source and compiled native HTTP lifecycle', () => {
  for (const mode of ['source', 'compiled'] as const) {
    test(mode + ' external host admission, SSE batch handoff, refusal and cleanup', async () => {
      const home = await mkdtemp(join(root, mode + '-'));
      const database = join(home, 'brain');
      const db = new PGLiteEngine();
      await db.connect({ database_path: database });
      await db.initSchema();
      const token = 'synthetic-lifecycle-only-bearer';
      await db.executeRaw("INSERT INTO access_tokens(token_hash,name,scopes) VALUES($1,'synthetic-lifecycle',ARRAY['read'])", [hashToken(token)]);
      await db.disconnect();
      await mkdir(join(home, '.gbrain'));
      await writeFile(join(home, '.gbrain/config.json'), JSON.stringify({
        engine: 'pglite', database_path: database,
        embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536,
      }));
      const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('fixture') });
      const port = probe.port!;
      await probe.stop(true);
      const base = 'http://127.0.0.1:' + port;
      const marker = join(home, 'events.jsonl');
      await writeFile(join(home, 'dependency.mjs'), 'export const version=1;');
      const modulePath = join(home, 'host.mjs');
      await writeFile(modulePath, `
import {version} from './dependency.mjs';
import {appendFile} from 'node:fs/promises';
export const protocolVersion=version;
const marker=${JSON.stringify(marker)};
const record=x=>appendFile(marker,JSON.stringify(x)+'\\n');
export async function createOperationLifecycleHost(ports) {
 await record({event:'init',resource:ports.resource,operations:ports.operations.length});
 return {version:1,limits:{operationTimeoutMs:3000,maxResponseBytes:65536,shutdownTimeoutMs:200},
  begin:async i=>{
   await record({event:'begin',slug:i.params.slug,principal:i.principal,attempt:i.attemptId});
   if(i.params.slug==='refuse') return {kind:'refused',failure:{code:'resource_exhausted',publicMessage:'Synthetic top-up guidance'}};
   return {kind:'admitted',admission:{expiresAt:i.deadlineAt,allowOptionalEnrichment:false,
    authorize:async()=>{
     if(i.params.slug==='slow') await new Promise(r=>setTimeout(r,650));
     await record({event:'authorize',slug:i.params.slug});
     return {kind:'deliver'};
    },
    release:async reason=>record({event:'release',reason,slug:i.params.slug})}};
  },
  shutdown:async()=>record({event:'shutdown'})};
}`);
      const command = mode === 'source' ? [process.execPath, 'src/cli.ts'] : [compiledBinary!];
      const env: Record<string, string> = {
        PATH: process.env.PATH!, HOME: home, GBRAIN_HOME: home,
        GBRAIN_OPERATION_LIFECYCLE_MODULE: modulePath,
        GBRAIN_OAUTH_RESOURCE_POLICY: JSON.stringify({ canonicalResource: base + '/mcp', aliases: [], allowLegacyUnboundConfidential: false, allowLegacyAccessTokens: true }),
        GBRAIN_ADMIN_BOOTSTRAP_TOKEN: 'synthetic-admin-bootstrap-token-000000000000',
      };
      const args = [...command, 'serve', '--http', '--port', String(port), '--bind', '127.0.0.1', '--public-url', base, '--suppress-bootstrap-token'];
      const child = Bun.spawn(args, { cwd: process.cwd(), env, stdout: 'pipe', stderr: 'pipe' });
      const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      let forcedCleanup = false;
      const stop = async () => {
        if (child.exitCode === null) child.kill('SIGTERM');
        await boundedWait(child.exited, 8000).catch(() => {});
        if (child.exitCode === null) { forcedCleanup = true; child.kill('SIGKILL'); }
        await child.exited;
      };
      const events = async () => (await readFile(marker, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      const post = (body: unknown, authorized = true) => fetch(base + '/mcp', {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
          ...(authorized ? { authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
      });
      const call = (id: number, slug: unknown) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'get_tags', arguments: { slug } } });
      try {
        let ready = false;
        for (let i = 0; i < 150; i++) {
          if (child.exitCode !== null) break;
          try { const response = await fetch(base + '/health', { signal: AbortSignal.timeout(100) }); if (response.ok) { ready = true; break; } } catch {}
          await new Promise(r => setTimeout(r, 40));
        }
        if (!ready) { await stop(); throw new Error('Synthetic HTTP startup failed: ' + (await output).join('\n')); }
        expect((await post(call(1, 'unauthorized'), false)).status).toBe(401);
        const invalid = await post(call(2, 7));
        expect(await invalid.text()).toContain('isError');
        expect((await events()).filter(x => x.event === 'begin')).toHaveLength(0);
        const refused = await post(call(3, 'refuse'));
        expect(await refused.text()).toContain('Synthetic top-up guidance');
        const producerRefused = await post({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'find_contradictions', arguments: {} } });
        expect(await producerRefused.text()).toContain('admission_refused');
        const response = await post([call(4, 'slow'), call(5, 'fast')]);
        expect(response.headers.get('content-type')).toContain('text/event-stream');
        const reader = response.body!.getReader();
        let received = '';
        const decoder = new TextDecoder();
        while (!received.includes('"id":5')) {
          const part = await reader.read();
          if (part.done) throw new Error('Missing fast batch result: ' + received);
          received += decoder.decode(part.value, { stream: true });
        }
        expect(received).not.toContain('"id":4');
        expect((await events()).some(x => x.event === 'authorize' && x.slug === 'slow')).toBe(false);
        for (;;) { const part = await reader.read(); if (part.done) break; received += decoder.decode(part.value, { stream: true }); }
        expect(received).toContain('"id":4');
        expect(received).not.toContain('"isError":true');
        const observed = await events();
        expect(observed[0].resource).toBe(base + '/mcp');
        expect(observed[0].operations).toBeGreaterThan(100);
        const attempts = observed.filter(x => x.event === 'begin');
        expect(new Set(attempts.map(x => x.attempt)).size).toBe(4);
        expect(JSON.stringify(attempts)).not.toContain(token);
        expect(observed.filter(x => x.event === 'release')).toHaveLength(1);
      } finally { await stop(); }
      expect(forcedCleanup).toBe(false);
      // Natural serve teardown can exit0 before the shared SIGTERM handler exits143.
      expect([0, 143]).toContain(child.exitCode!);
      const logs = (await output).join('\n');
      expect(logs).not.toContain(token);
      expect((await events()).filter(x => x.event === 'shutdown')).toHaveLength(1);

      // Same real entry point: a configured bad module must fail before listen.
      await writeFile(modulePath, 'throw new Error("synthetic-private-module-error");');
      const bad = Bun.spawn(args, { cwd: process.cwd(), env, stdout: 'pipe', stderr: 'pipe' });
      const badOutput = Promise.all([new Response(bad.stdout).text(), new Response(bad.stderr).text()]);
      const code = await boundedWait(bad.exited, 8000).catch(async error => { bad.kill('SIGKILL'); await bad.exited; throw error; });
      const badLogs = (await badOutput).join('\n');
      expect(code).not.toBe(0);
      expect(badLogs).toContain('Configured operation lifecycle could not initialize');
      expect(badLogs).not.toContain('synthetic-private-module-error');
      await expect(fetch(base + '/health', { signal: AbortSignal.timeout(200) })).rejects.toThrow();
    }, 30_000);
  }
});
