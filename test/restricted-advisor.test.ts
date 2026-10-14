import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';

let full: PGLiteEngine;
let defaultOnly: PGLiteEngine;

function ctx(engine: PGLiteEngine, allowedSources?: string[], remote = true): OperationContext {
  return {
    engine: engine as any, config: { engine: 'pglite' } as any,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as any,
    dryRun: false, remote, transport: 'stdio', sourceId: 'default',
    auth: allowedSources === undefined ? undefined : {
      clientId: 'gbrain_cl_c72', clientName: 'c72', scopes: [], allowedSources,
    } as any,
  } as OperationContext;
}

function advisor() { return operations.find(op => op.name === 'advisor')!; }

async function seed(engine: PGLiteEngine, sources: string[]): Promise<void> {
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('mcp.publish_advisor', 'true');
  for (const id of sources) {
    await engine.executeRaw('INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)', [id, `/tmp/${id}`]);
  }
}

beforeAll(async () => {
  full = new PGLiteEngine();
  defaultOnly = new PGLiteEngine();
  await seed(full, ['shared', 'restricted']);
  await seed(defaultOnly, []);
}, 120_000);

afterAll(async () => {
  await full?.disconnect();
  await defaultOnly?.disconnect();
});

describe('restricted advisor', () => {
  test('refuses a partial member grant without naming a source', async () => {
    const error = await advisor().handler(ctx(full, ['default', 'shared']), {}).then(() => null, error => error);
    expect(error).toBeInstanceOf(OperationError);
    expect(error).toMatchObject({ code: 'permission_denied', detail: 'reason=partial_read_grant' });
    expect((error as Error).message).not.toContain('default');
    expect((error as Error).message).not.toContain('shared');
    expect((error as Error).message).not.toContain('restricted');
  });

  test('serves a remote admin grant covering every source', async () => {
    await expect(advisor().handler(ctx(full, ['default', 'shared', 'restricted']), {})).resolves.toBeObject();
  });

  test('serves a trusted local caller', async () => {
    await expect(advisor().handler(ctx(full, undefined, false), {})).resolves.toBeObject();
  });

  test('serves a scalar caller on a single-source brain', async () => {
    await expect(advisor().handler(ctx(defaultOnly), {})).resolves.toBeObject();
  });

  test('refuses a scalar caller on a multi-source brain', async () => {
    await expect(advisor().handler(ctx(full), {})).rejects.toMatchObject({
      code: 'permission_denied', detail: 'reason=partial_read_grant',
    });
  });

  test('keeps the publish gate ahead of the restriction check', async () => {
    await full.setConfig('mcp.publish_advisor', 'false');
    try {
      await expect(advisor().handler(ctx(full, ['default', 'shared']), {})).rejects.toMatchObject({
        code: 'permission_denied', detail: 'config_key=mcp.publish_advisor',
      });
    } finally {
      await full.setConfig('mcp.publish_advisor', 'true');
    }
  });
});
