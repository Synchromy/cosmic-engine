/**
 * cosmic patch list-pages-with-frontmatter (cosmic-hub C-137, add-agent-handoffs).
 *
 * The hub's handoffs_list reads, with the caller's own token, the newest pages
 * of type `handoff` whose frontmatter says `status: open`, and then patches one
 * with patch_page's base_revision. list_pages answers no frontmatter and no
 * revision, so it could not serve that read without a get_page per row, and a
 * Read-level client (the `verbs` surface) has no list_pages at all. This verb:
 *
 * - filters one type by frontmatter text values;
 * - answers newest first, each row with source_id, frontmatter and the exact
 *   canonical_revision get_page gives, from the same canonical snapshot;
 * - scopes by source exactly as list_pages (grant, explicit live source,
 *   private pages hidden from untrusted callers) and caps remote callers at 100;
 * - sits on the verbs, starter and full surfaces.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { allowedOpNames } from '../src/mcp/surface.ts';
import { VERB_NAMES, RESPONSE_SCHEMAS } from '../src/core/verbs.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
let root: string;
let brainDir: string;

const op = operations.find((o) => o.name === 'list_pages_with_frontmatter');
const putPage = operations.find((o) => o.name === 'put_page')!;
const getPage = operations.find((o) => o.name === 'get_page')!;

function localCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  } as OperationContext;
}

function remoteCtx(allowedSources: string[] = ['default']): OperationContext {
  return localCtx({
    remote: true,
    transport: 'http',
    sourceId: 'default',
    auth: { allowedSources } as never,
    takesHoldersAllowList: ['world'],
  } as Partial<OperationContext>);
}

type Row = {
  slug: string;
  source_id: string;
  title: string;
  type: string;
  frontmatter: Record<string, unknown>;
  canonical_revision: string | null;
  updated_at: unknown;
};

async function list(ctx: OperationContext, params: Record<string, unknown>): Promise<Row[]> {
  if (!op) throw new Error('list_pages_with_frontmatter is not an operation');
  const res = (await op.handler(ctx, params)) as { protocol_version: number; pages: Row[] };
  expect(res.protocol_version).toBe(1);
  return res.pages;
}

async function handoff(slug: string, fm: Record<string, string>, opts: { sourceId?: string; extra?: string } = {}) {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n');
  await putPage.handler(localCtx(opts.sourceId ? { sourceId: opts.sourceId } : {}), {
    slug,
    content: `---\ntype: handoff\ntitle: ${slug}\n${lines}\n${opts.extra ?? ''}---\n\nBody of ${slug}.\n`,
    ...(opts.sourceId ? { source_id: opts.sourceId } : {}),
  });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
  resetGateway();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  resetGateway();
  root = mkdtempSync(join(tmpdir(), 'list-fm-'));
  brainDir = join(root, 'brain');
  mkdirSync(brainDir, { recursive: true });
  await engine.setConfig('sync.repo_path', brainDir);
  await engine.setConfig('sync.write_through', 'true');
});

afterEach(() => {
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe('list_pages_with_frontmatter', () => {
  test('is an operation, a verb, and on the verbs, starter and full surfaces', () => {
    expect(op).toBeDefined();
    expect(op!.verb).toBe(true);
    expect(op!.scope).toBe('read');
    expect((VERB_NAMES as readonly string[]).includes('list_pages_with_frontmatter')).toBe(true);
    expect(RESPONSE_SCHEMAS).toHaveProperty('list_pages_with_frontmatter');
    for (const surface of ['verbs', 'starter', 'full'] as const) {
      expect(allowedOpNames(operations, surface).has('list_pages_with_frontmatter')).toBe(true);
    }
  });

  test('filters one type by frontmatter text values', async () => {
    await handoff('handoffs/open-for-claude', { to: 'Claude Code', status: 'open' });
    await handoff('handoffs/done-for-claude', { to: 'Claude Code', status: 'done' });
    await handoff('handoffs/session-record', { written_by: 'claude-code' });
    await putPage.handler(localCtx(), {
      slug: 'notes/open-note',
      content: '---\ntype: note\ntitle: open note\nstatus: open\n---\n\nA note.\n',
    });
    const open = await list(localCtx(), { type: 'handoff', where: { status: 'open' } });
    expect(open.map((r) => r.slug)).toEqual(['handoffs/open-for-claude']);
    const all = await list(localCtx(), { type: 'handoff' });
    expect(all.map((r) => r.slug).sort()).toEqual([
      'handoffs/done-for-claude',
      'handoffs/open-for-claude',
      'handoffs/session-record',
    ]);
    const two = await list(localCtx(), { type: 'handoff', where: { status: 'open', to: 'Claude Code' } });
    expect(two.map((r) => r.slug)).toEqual(['handoffs/open-for-claude']);
    const none = await list(localCtx(), { type: 'handoff', where: { status: 'open', to: 'Codex' } });
    expect(none).toEqual([]);
  });

  test('newest first', async () => {
    await handoff('handoffs/first', { status: 'open' });
    await handoff('handoffs/second', { status: 'open' });
    await handoff('handoffs/third', { status: 'open' });
    await engine.executeRaw(`UPDATE pages SET updated_at = now() - interval '2 days' WHERE slug = 'handoffs/third'`);
    await engine.executeRaw(`UPDATE pages SET updated_at = now() - interval '1 day' WHERE slug = 'handoffs/first'`);
    const rows = await list(localCtx(), { type: 'handoff', where: { status: 'open' } });
    expect(rows.map((r) => r.slug)).toEqual(['handoffs/second', 'handoffs/first', 'handoffs/third']);
  });

  test('each row carries source_id, frontmatter and the canonical_revision get_page gives', async () => {
    await handoff('handoffs/one', { from: 'grok-bot', to: 'Claude Code', status: 'open', result: 'null' });
    const [row] = await list(localCtx(), { type: 'handoff', where: { status: 'open' } });
    expect(row.source_id).toBe('default');
    expect(row.type).toBe('handoff');
    expect(row.frontmatter.to).toBe('Claude Code');
    expect(row.frontmatter.from).toBe('grok-bot');
    expect(row.canonical_revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    const page = (await getPage.handler(localCtx(), { slug: 'handoffs/one', source_id: 'default' })) as { canonical_revision: string };
    expect(row.canonical_revision).toBe(page.canonical_revision);
  });

  test('frontmatter and revision come from one canonical snapshot: a row the file no longer matches is dropped', async () => {
    await handoff('handoffs/moved-on', { to: 'Claude Code', status: 'open' });
    const file = join(brainDir, 'handoffs', 'moved-on.md');
    expect(existsSync(file)).toBe(true);
    // Another writer changed the canonical file; the index row still says open.
    writeFileSync(file, readFileSync(file, 'utf8').replace('status: open', 'status: done'));
    const open = await list(localCtx(), { type: 'handoff', where: { status: 'open' } });
    expect(open.map((r) => r.slug)).toEqual([]);
  });

  test('a row the canonical bytes drop does not use up the limit: the scan goes on to older rows', async () => {
    await handoff('handoffs/older-open', { status: 'open' });
    await handoff('handoffs/newest-closed', { status: 'open' });
    await engine.executeRaw(`UPDATE pages SET updated_at = now() - interval '1 day' WHERE slug = 'handoffs/older-open'`);
    const file = join(brainDir, 'handoffs', 'newest-closed.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('status: open', 'status: done'));
    const rows = await list(localCtx(), { type: 'handoff', where: { status: 'open' }, limit: 1 });
    expect(rows.map((r) => r.slug)).toEqual(['handoffs/older-open']);
  });

  test('canonical bytes unavailable: the row answers canonical_revision null, never a content hash', async () => {
    await handoff('handoffs/no-canonical', { status: 'open' });
    await engine.setConfig('sync.write_through', 'false');
    const [row] = await list(localCtx(), { type: 'handoff', where: { status: 'open' } });
    expect(row.slug).toBe('handoffs/no-canonical');
    expect(row.canonical_revision).toBeNull();
    expect(row.frontmatter.status).toBe('open');
  });

  test("a remote caller sees only its granted sources; an explicit ungranted source is refused", async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('other', 'other', '/tmp/other') ON CONFLICT DO NOTHING`);
    await handoff('handoffs/in-default', { status: 'open' });
    await engine.putPage('handoffs/in-other', {
      type: 'handoff', title: 'in other', compiled_truth: 'other', frontmatter: { status: 'open' },
    } as never, { sourceId: 'other' });
    const granted = await list(remoteCtx(['default']), { type: 'handoff', where: { status: 'open' }, source_id: '__all__' });
    expect(granted.map((r) => r.slug)).toEqual(['handoffs/in-default']);
    const both = await list(remoteCtx(['default', 'other']), { type: 'handoff', where: { status: 'open' }, source_id: '__all__' });
    expect(both.map((r) => `${r.source_id}:${r.slug}`).sort()).toEqual(['default:handoffs/in-default', 'other:handoffs/in-other']);
    await expect(list(remoteCtx(['default']), { type: 'handoff', source_id: 'other' })).rejects.toThrow();
  });

  test('a private page is hidden from a remote caller and listed to a trusted local one', async () => {
    await handoff('handoffs/private-one', { status: 'open', visibility: 'private' });
    await handoff('handoffs/world-one', { status: 'open' });
    const remote = await list(remoteCtx(), { type: 'handoff', where: { status: 'open' } });
    expect(remote.map((r) => r.slug)).toEqual(['handoffs/world-one']);
    const local = await list(localCtx(), { type: 'handoff', where: { status: 'open' } });
    expect(local.map((r) => r.slug).sort()).toEqual(['handoffs/private-one', 'handoffs/world-one']);
  });

  test('a remote caller is capped at 100 rows; a local caller is not', async () => {
    await engine.setConfig('sync.write_through', 'false');
    for (let i = 0; i < 105; i++) {
      await engine.putPage(`handoffs/bulk-${i}`, {
        type: 'handoff', title: `bulk ${i}`, compiled_truth: 'x', frontmatter: { status: 'open' },
      } as never);
    }
    expect((await list(remoteCtx(), { type: 'handoff', where: { status: 'open' }, limit: 500 })).length).toBe(100);
    expect((await list(localCtx(), { type: 'handoff', where: { status: 'open' }, limit: 500 })).length).toBe(105);
    expect((await list(remoteCtx(), { type: 'handoff', where: { status: 'open' } })).length).toBe(50);
  }, 120_000);

  test('bad arguments are invalid_params', async () => {
    await expect(list(localCtx(), { where: { status: 'open' } })).rejects.toThrow(/type is required/);
    await expect(list(localCtx(), { type: 'handoff', where: 'status=open' })).rejects.toThrow(/where must be an object/);
    await expect(list(localCtx(), { type: 'handoff', where: { status: 1 } })).rejects.toThrow(/must be text/);
    await expect(list(localCtx(), { type: 'handoff', where: { ' status': 'open' } })).rejects.toThrow(/empty or padded/);
  });

  test('a where key that is SQL text is a bound value, not SQL', async () => {
    await handoff('handoffs/plain', { status: 'open' });
    const rows = await list(localCtx(), { type: 'handoff', where: { "status' OR '1'='1": 'open' } });
    expect(rows).toEqual([]);
  });
});
