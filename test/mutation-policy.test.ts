import { OperationError } from '../src/core/ops/contract.ts';
import { RemoteMcpError } from '../src/core/mcp-client.ts';
import { afterEach, beforeEach, describe, expect, test, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { operations, operationsByName, type OperationContext } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { guardOperations, requiresMutationAdmission } from '../src/core/mutation-policy.ts';
import { runCapture, captureMutationDenial } from '../src/commands/capture.ts';
import type { Operation } from '../src/core/operations.ts';
import { handleToolCall } from '../src/mcp/server.ts';

let root: string;
let policy: string;
let oldPolicy: string | undefined;
let oldHome: string | undefined;
const ctx = {
  engine: { kind: 'postgres' },
  config: { engine: 'postgres' },
  logger: { info() {}, warn() {}, error() {} },
  remote: false, dryRun: true, sourceId: 'default',
} as unknown as OperationContext;
const page = { slug: 'test/policy', content: '# Synthetic fixture' };
function setPolicy(value: unknown) { writeFileSync(policy, JSON.stringify(value)); }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-policy-'));
  policy = join(root, 'policy.json');
  oldPolicy = process.env.GBRAIN_MUTATION_POLICY_FILE;
  oldHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = root;
  process.env.GBRAIN_MUTATION_POLICY_FILE = policy;
  mkdirSync(join(root, '.gbrain'));
  writeFileSync(join(root, '.gbrain/config.json'), JSON.stringify({ engine: 'postgres' }));
  setPolicy({ version: 1, mutations: 'deny' });
});
afterEach(() => {
  if (oldPolicy === undefined) delete process.env.GBRAIN_MUTATION_POLICY_FILE;
  else process.env.GBRAIN_MUTATION_POLICY_FILE = oldPolicy;
  if (oldHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = oldHome;
  rmSync(root, { recursive: true, force: true });
});

describe('registered operation mutation admission', () => {
  test('denies the actual page handler even for trusted dry-run callers', async () => {
    await expect(operationsByName.put_page!.handler(ctx, page)).rejects.toMatchObject({ code: 'read_only' });
  });
  test('local call cannot bypass the registry guard', async () => {
    await expect(handleToolCall(ctx.engine, 'put_page', { ...page, dry_run: true }))
      .rejects.toMatchObject({ code: 'read_only' });
  });
  test('HTTP and stdio dispatch return the same structured refusal', async () => {
    for (const transport of ['http', 'stdio'] as const) {
      const result = await dispatchToolCall(ctx.engine, 'put_page', { ...page, dry_run: true }, {
        remote: true, transport, sourceId: 'default',
      });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]!.text).error).toBe('read_only');
    }
  });
  test('all explicitly mutating registered handlers refuse before params or storage', async () => {
    const mutators = operations.filter(op => op.mutating === true);
    expect(mutators.length).toBeGreaterThan(20);
    for (const op of mutators) {
      await expect(op.handler(ctx, {})).rejects.toMatchObject({ code: 'read_only' });
    }
  });
  test('invalid configured policy refuses without leaking its path', async () => {
    for (const input of ['', '{}', '{"version":2,"mutations":"allow"}', 'private bad input', ' '.repeat(4097)]) {
      writeFileSync(policy, input);
      try { await operationsByName.put_page!.handler(ctx, page); throw new Error('unexpected admission'); }
      catch (e) {
        expect(e).toMatchObject({ code: 'read_only' });
        expect(String(e)).not.toContain(root);
        expect(String(e)).not.toContain('private bad input');
      }
    }
    rmSync(policy);
    await expect(operationsByName.put_page!.handler(ctx, page)).rejects.toMatchObject({ code: 'read_only' });
  });
  test('reads policy again after atomic replacement', async () => {
    setPolicy({ version: 1, mutations: 'allow' });
    expect(await operationsByName.put_page!.handler(ctx, page)).toMatchObject({ dry_run: true });
    writeFileSync(policy + '.next', JSON.stringify({ version: 1, mutations: 'deny' }));
    renameSync(policy + '.next', policy);
    await expect(operationsByName.put_page!.handler(ctx, page)).rejects.toMatchObject({ code: 'read_only' });
  });
});


describe('policy boundaries and continuity', () => {
  test('unset policy retains existing mutation behavior', async () => {
    delete process.env.GBRAIN_MUTATION_POLICY_FILE;
    expect(await operationsByName.put_page!.handler(ctx, page)).toMatchObject({ dry_run: true });
  });
  test('classification retains reads and explicit inspection, gates unknown and mixed ops', () => {
    expect(requiresMutationAdmission({ scope: 'read' })).toBe(false);
    expect(requiresMutationAdmission({ scope: 'read', mutating: true })).toBe(true);
    expect(requiresMutationAdmission({ scope: 'admin', mutating: false })).toBe(false);
    for (const scope of ['write', 'admin', 'agent', 'sources_admin', 'users_admin', undefined] as const)
      expect(requiresMutationAdmission({ scope })).toBe(true);
    for (const op of operations) {
      if (op.scope === 'write') expect(op.mutating).not.toBe(false);
    }
    for (const name of ['think', 'request_tools']) expect(requiresMutationAdmission(operationsByName[name]!)).toBe(true);
  });
  test('denial does not suppress normal reads or real admin diagnostic handlers', async () => {
    const fixture = { pages: 7 };
    const inspectionCtx = {
      ...ctx,
      engine: {
        kind: 'postgres',
        getStats: async () => fixture,
        getVersions: async () => [{ id: 3 }],
        executeRaw: async (sql: string) => {
          expect(sql.trim().startsWith('SELECT')).toBe(true);
          return [];
        },
      },
    } as unknown as OperationContext;
    expect(await operationsByName.get_stats!.handler(inspectionCtx, {})).toEqual(fixture);
    expect(await operationsByName.get_versions!.handler(inspectionCtx, { slug: page.slug })).toEqual([{ id: 3 }]);
    expect(await operationsByName.get_usage!.handler(inspectionCtx, {})).toBeDefined();
    for (const name of ['get_stats','get_health','run_doctor','quarantine_list','get_usage',
      'search_stats','search_tune','cache_stats','get_agent_job','get_job','list_jobs',
      'get_job_progress','get_job_stats','file_list','file_url','get_status_snapshot'])
      expect(operationsByName[name]!.mutating).toBe(false);
  });
  test('directory, unreadable, wrong types, extra keys and invalid UTF8 fail closed', async () => {
    rmSync(policy);
    mkdirSync(policy);
    await expect(operationsByName.put_page!.handler(ctx, page)).rejects.toMatchObject({ code: 'read_only' });
    rmSync(policy, { recursive: true });
    setPolicy({ version: 1, mutations: 'allow' });
    chmodSync(policy, 0);
    try {
      await expect(operationsByName.put_page!.handler(ctx, page)).rejects.toMatchObject({ code: 'read_only' });
    } finally { chmodSync(policy, 0o600); }
    for (const value of [null, [], true, { version: '1', mutations: 'allow' },
      { version: 1, mutations: true }, { version: 1, mutations: 'allow', bypass: true }]) {
      setPolicy(value);
      await expect(operationsByName.put_page!.handler(ctx, page)).rejects.toMatchObject({ code: 'read_only' });
    }
    writeFileSync(policy, Buffer.from([0xff]));
    await expect(operationsByName.put_page!.handler(ctx, page)).rejects.toMatchObject({ code: 'read_only' });
  });
  test('wrapping preserves object identity, is idempotent, and checks nested admissions', async () => {
    let writes = 0;
    const child: Operation = { name: 'synthetic_write', description: 'Synthetic mutation fixture', scope: 'write', params: {}, handler: async () => ++writes };
    const parent: Operation = { name: 'synthetic_parent', description: 'Synthetic nested fixture', scope: 'write', params: {}, handler: async (c, p) => {
      setPolicy({ version: 1, mutations: 'deny' });
      return child.handler(c, p);
    } };
    guardOperations([parent, child]);
    const wrappedChild = child.handler;
    guardOperations([parent, child]);
    expect(child.handler).toBe(wrappedChild);
    setPolicy({ version: 1, mutations: 'allow' });
    await expect(parent.handler(ctx, {})).rejects.toMatchObject({ code: 'read_only' });
    expect(writes).toBe(0);
    setPolicy({ version: 1, mutations: 'allow' });
    expect(await child.handler(ctx, {})).toBe(1);
    expect(writes).toBe(1);
  });
  test('actual capture CLI refuses before storage after read-only source preflight', async () => {
    const queries: string[] = [];
    const engine = new Proxy({
      kind: 'postgres',
      executeRaw: async (sql: string) => {
        queries.push(sql);
        expect(sql).toStartWith('SELECT id FROM sources');
        return [{ id: 'default' }];
      },
    }, {
      get(target, property) {
        if (property in target) return target[property as keyof typeof target];
        throw new Error('Unexpected engine access: ' + String(property));
      },
    }) as unknown as OperationContext['engine'];
    const exit = spyOn(process, 'exit').mockImplementation((code) => { throw new Error('fixture exit ' + code); });
    const errors: string[] = [];
    const stderr = spyOn(console, 'error').mockImplementation((message) => { errors.push(String(message)); });
    try {
      await expect(runCapture(engine, ['Synthetic capture fixture', '--source', 'default', '--slug', 'test/capture', '--json']))
        .rejects.toThrow('fixture exit 1');
      expect(errors).toEqual(['Error [read_only]: Mutations are currently disabled by the operator.']);
      expect(queries.length).toBe(1);
    } finally { exit.mockRestore(); stderr.mockRestore(); }
  });
});

test('capture protocol accepts only typed local and remote mutation denials', () => {
  const expected = 'Error [read_only]: Mutations are currently disabled by the operator.';
  expect(captureMutationDenial(new OperationError('read_only', 'sensitive body'))).toBe(expected);
  expect(captureMutationDenial(new RemoteMcpError('tool_error', 'sensitive upstream', { code: 'read_only' }))).toBe(expected);
  for (const error of [
    new Error(expected), { code: 'read_only' },
    new OperationError('not_found', 'read_only'),
    new RemoteMcpError('network', 'read_only', { code: 'read_only' }),
    new RemoteMcpError('tool_error', 'read_only'),
    new RemoteMcpError('tool_error', 'sensitive', { code: 'missing_scope' }),
  ]) expect(captureMutationDenial(error)).toBeNull();
});

test('actual remote capture catch emits the protocol line and exits nonzero without upstream content', async () => {
  const home = mkdtempSync(join(tmpdir(), 'capture-remote-denial-'));
  try {
    mkdirSync(join(home, '.gbrain'));
    writeFileSync(join(home, '.gbrain/config.json'), JSON.stringify({ remote_mcp: {
      issuer_url: 'https://fixture.invalid', mcp_url: 'https://fixture.invalid/mcp', oauth_client_id: 'fixture',
    } }));
    // Isolated process prevents this mocked transport boundary leaking to other tests.
    // Capture itself, config routing, typed error and process exit are real.
    const source = `
      import { mock } from 'bun:test';
      const transport = await import('./src/core/mcp-client.ts');
      mock.module('./src/core/mcp-client.ts', () => ({
        ...transport, callRemoteTool: async () => {
          throw new transport.RemoteMcpError('tool_error', 'private upstream body', {code:'read_only'});
        },
      }));
      const { runCapture } = await import('./src/commands/capture.ts');
      await runCapture(null, ['Synthetic remote capture', '--slug', 'fixture/page']);
    `;
    const child = Bun.spawn([process.execPath, '-e', source], {
      cwd: join(import.meta.dir, '..'),
      env: { PATH: '/usr/bin:/bin', HOME: home, GBRAIN_HOME: home },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr.trim()).toBe('Error [read_only]: Mutations are currently disabled by the operator.');
  } finally { rmSync(home, {recursive:true,force:true}); }
});
