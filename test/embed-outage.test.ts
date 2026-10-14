/**
 * Cosmic C-19 (add-write-queue-for-outages): nothing a person sends is lost
 * while the embedder is down. put_page lands the page waiting, the count
 * reads only the outage marker, and `embed --waiting` catches it up.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import {
  _resetEmbedOutageBreakerForTests,
  countEmbedWaiting,
  countPageNullChunks,
  isEmbedOutageError,
  isEmbedOutageMessage,
} from '../src/core/embed-outage.ts';
import { drainEmbedWaiting } from '../src/core/embed-waiting-drain.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let dim = 0;
let calls = 0;
const put = operations.find(o => o.name === 'put_page')!;
const health = operations.find(o => o.name === 'get_health')!;
const ctx = (remote = true): OperationContext => ({ engine: engine as any, config: {} as any, logger: console as any, dryRun: false, remote, sourceId: 'default' });

const status = (s: number, msg = 'provider said no') => Object.assign(new Error(msg), { status: s });
function refuse(err: () => Error) {
  __setEmbedTransportForTests((async () => { calls++; throw err(); }) as never);
}
function healthy() {
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
    calls++;
    return { embeddings: values.map(() => new Array(dim).fill(0.01)), usage: { tokens: values.length * 4 } };
  }) as never);
}
// Read the registry-active vector column; getChunks does not return it.
const nullChunks = (slug: string) => countPageNullChunks(engine, 'default', slug);

beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  const rows = await engine.executeRaw<{ dim: number }>("SELECT atttypmod AS dim FROM pg_attribute WHERE attrelid='content_chunks'::regclass AND attname='embedding'");
  dim = Number(rows[0]!.dim);
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: dim, env: { OPENAI_API_KEY: 'test' } });
}, 30000);
beforeEach(async () => { await resetPgliteState(engine); _resetEmbedOutageBreakerForTests(); calls = 0; });
afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await engine.disconnect(); });

describe('the outage classifier', () => {
  test('an outage: 401, 402, 403, key limit, 429, 5xx, refused connection', () => {
    for (const e of [status(401), status(402), status(403), status(429), status(500), status(503),
      new Error('Key limit exceeded'), new Error('429 Too Many Requests'),
      Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('wrapped'), { cause: status(402) })]) {
      expect(isEmbedOutageError(e)).toBe(true);
    }
  });
  test('never an outage: dimension mismatch, oversize, bad input, abort', () => {
    for (const e of [new Error('expected 1536 dimensions, not 512'), status(413), status(400), status(422),
      new Error("This model's maximum context length is 8192 tokens"),
      new Error('Input has 520 tokens'), Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })]) {
      expect(isEmbedOutageError(e)).toBe(false);
    }
  });
  test('the string form holds stored error text to the same rule', () => {
    expect(isEmbedOutageMessage('Key limit exceeded (total limit)')).toBe(true);
    expect(isEmbedOutageMessage('expected 1536 dimensions, not 512')).toBe(false);
    expect(isEmbedOutageMessage('page has 512 chunks')).toBe(false);
  });
});

describe('sending during an outage', () => {
  test('a 402 lands the page at once: readable, found by keyword, marked waiting, counted', async () => {
    refuse(() => status(402));
    const r = await put.handler(ctx(), { slug: 'notes/outage', content: '# Outage\n\nkeywordneedle arrives' }) as Record<string, unknown>;
    expect(r.embedding).toBe('waiting');
    expect((await engine.getPage('notes/outage', { sourceId: 'default' }))?.compiled_truth).toContain('keywordneedle');
    expect((await engine.searchKeyword('keywordneedle', { limit: 5 })).map(x => x.slug)).toContain('notes/outage');
    expect(await nullChunks('notes/outage')).toBeGreaterThan(0);
    expect(await countEmbedWaiting(engine)).toBe(1);
    expect(((await health.handler(ctx(false), {})) as any).embed_waiting).toEqual({ pages: 1 });
  });

  test('bad input still fails as today and is not marked', async () => {
    refuse(() => status(400, 'bad request: invalid input'));
    await expect(put.handler(ctx(), { slug: 'notes/bad', content: '# Bad\n\nbody' })).rejects.toThrow();
    expect(await engine.getPage('notes/bad', { sourceId: 'default' })).toBeNull();
    expect(await countEmbedWaiting(engine)).toBe(0);
  });

  test('a 429 storm returns inside the interactive cap, on the waiting path', async () => {
    refuse(() => status(429, 'rate limited'));   // no retry-after hint: the ladder would wait 60s
    const t0 = Date.now();
    const r = await put.handler(ctx(), { slug: 'notes/storm', content: '# Storm\n\nbody' }) as Record<string, unknown>;
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(r.embedding).toBe('waiting');
    expect(calls).toBe(2);   // one try, one retry
  }, 15000);

  test('a second write to the same page keeps one marker; the breaker allows one call, no retry', async () => {
    refuse(() => status(429, 'rate limited'));
    await put.handler(ctx(), { slug: 'notes/twice', content: '# Twice\n\nfirst' });
    const before = calls;
    const r = await put.handler(ctx(), { slug: 'notes/twice', content: '# Twice\n\nsecond' }) as Record<string, unknown>;
    expect(r.embedding).toBe('waiting');
    expect(calls).toBe(before + 1);
    expect(await countEmbedWaiting(engine)).toBe(1);
    expect((await engine.getPage('notes/twice', { sourceId: 'default' }))?.compiled_truth).toContain('second');
  }, 15000);

  test('while the breaker is open, bad input and a dimension mismatch still throw and are not marked', async () => {
    refuse(() => status(402));
    await put.handler(ctx(), { slug: 'notes/first', content: '# First\n\nbody' });
    for (const [slug, err] of [
      ['notes/bad-open', () => status(400, 'bad request: invalid input')],
      ['notes/dim-open', () => new Error('expected 1536 dimensions, not 512')],
    ] as const) {
      refuse(err);
      await expect(put.handler(ctx(), { slug, content: '# Later\n\nbody' })).rejects.toThrow();
      expect(await engine.getPage(slug, { sourceId: 'default' })).toBeNull();
    }
    expect(await countEmbedWaiting(engine)).toBe(1);
  });

  test('a later healthy write embeds the page and clears its marker', async () => {
    refuse(() => status(402));
    await put.handler(ctx(), { slug: 'notes/back', content: '# Back\n\nfirst' });
    _resetEmbedOutageBreakerForTests();
    healthy();
    const r = await put.handler(ctx(), { slug: 'notes/back', content: '# Back\n\nsecond' }) as Record<string, unknown>;
    expect(r.embedding).toBeUndefined();
    expect(await nullChunks('notes/back')).toBe(0);
    expect(await countEmbedWaiting(engine)).toBe(0);
  });
});

describe('the catch-up: embed --waiting', () => {
  test('while the embedder is still out it embeds nothing and keeps the marker', async () => {
    refuse(() => status(402));
    await put.handler(ctx(), { slug: 'notes/wait', content: '# Wait\n\nbody' });
    const r = await drainEmbedWaiting(engine);
    expect(r).toMatchObject({ outage: true, pages_embedded: 0, pages_waiting: 1, facts_embedded: 0 });
    expect(await nullChunks('notes/wait')).toBeGreaterThan(0);
  });

  test('once it returns, every waiting page and NULL fact is embedded and the count is zero', async () => {
    refuse(() => status(402));
    await put.handler(ctx(), { slug: 'notes/a', content: '# A\n\nalpha' });
    await put.handler(ctx(), { slug: 'notes/b', content: '# B\n\nbravo' });
    await engine.executeRaw(`INSERT INTO facts (source_id, fact, source) VALUES ('default', 'Khoa prefers mornings', 'mcp:remember')`);
    healthy();
    const r = await drainEmbedWaiting(engine);
    expect(r).toMatchObject({ outage: false, pages_embedded: 2, pages_waiting: 0, facts_embedded: 1 });
    expect(await nullChunks('notes/a')).toBe(0);
    expect(await nullChunks('notes/b')).toBe(0);
    const f = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts WHERE embedding IS NULL');
    expect(Number(f[0]!.n)).toBe(0);
    expect(((await health.handler(ctx(false), {})) as any).embed_waiting).toEqual({ pages: 0 });
  });

  test('a waiting page that was deleted loses its marker', async () => {
    refuse(() => status(402));
    await put.handler(ctx(), { slug: 'notes/gone', content: '# Gone\n\nbody' });
    await engine.executeRaw(`DELETE FROM pages WHERE slug = 'notes/gone'`);
    healthy();
    await drainEmbedWaiting(engine);
    const rows = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM cosmic_embed_waiting');
    expect(Number(rows[0]!.n)).toBe(0);
  });

  test('on a healthy brain the count is zero, an embed_skip page included', async () => {
    healthy();
    await put.handler(ctx(false), { slug: 'notes/skip', content: '---\nembed_skip: true\n---\n# Skip\n\nbody' });
    await put.handler(ctx(), { slug: 'notes/ok', content: '# Ok\n\nbody' });
    expect(await countEmbedWaiting(engine)).toBe(0);
    expect(((await health.handler(ctx(false), {})) as any).embed_waiting).toEqual({ pages: 0 });
  });
});

describe('importers other than put_page are unchanged', () => {
  test('without the marker table, a plain import still embeds, and an outage still throws', async () => {
    const fresh = new PGLiteEngine(); await fresh.connect({}); await fresh.initSchema();
    try {
      healthy();
      const ok = await importFromContent(fresh as any, 'notes/sync', '# Sync\n\nbody', {});
      expect(ok.status).toBe('imported');
      expect(ok.embedding).toBeUndefined();
      refuse(() => status(402));
      await expect(importFromContent(fresh as any, 'notes/sync2', '# Sync2\n\nbody', {})).rejects.toThrow();
      const t = await fresh.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'cosmic_embed_waiting'");
      expect(Number(t[0]!.n)).toBe(0);
    } finally {
      await fresh.disconnect();
    }
  }, 30000);
});
