/**
 * Cosmic carried patch `capture-receipt-usage` (cosmic-hub #1477).
 *
 * The hub lands ingested pages with `gbrain capture --file … --json`, a CLI
 * call that writes no mcp_request_log row. So the `--json` receipt itself
 * carries put_page's usage fields (put-page-usage): outcome
 * (created | updated | unchanged), embed_tokens and embed_cost_usd.
 *
 * Hermetic: in-memory PGLite, embed transport stubbed (openai 3-large, $0.13/MTok).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCapture, captureUsageOf } from '../src/commands/capture.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
let tmpRoot: string;
let embedCalls = 0;

beforeAll(async () => {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env, OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'sk-test-stub' },
  });
  __setEmbedTransportForTests(async ({ values }: any) => {
    embedCalls += 1;
    return { embeddings: values.map(() => new Array(1536).fill(0.001)), usage: { tokens: 0 } } as any;
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-capture-usage-'));
  const brainDir = path.join(tmpRoot, 'brain');
  fs.mkdirSync(brainDir, { recursive: true });
  await engine.setConfig('sync.repo_path', brainDir);
  await engine.setConfig('schema_pack', 'gbrain-base');
});

afterAll(async () => {
  await engine.disconnect();
  __setEmbedTransportForTests(null);
  resetGateway();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** `gbrain capture --file <f> --slug <slug> --type note --json`, the hub's call, and its receipt. */
async function captureJson(slug: string, body: string): Promise<Record<string, any>> {
  const file = path.join(tmpRoot, `${slug.replace(/\//g, '_')}.md`);
  fs.writeFileSync(file, body);
  const out: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => out.push(a.map(String).join(' '));
  try {
    await runCapture(engine, ['--file', file, '--slug', slug, '--type', 'note', '--json']);
  } finally {
    console.log = origLog;
  }
  return JSON.parse(out.join('\n'));
}

describe('capture-receipt-usage', () => {
  test('a new page: the receipt says created, with the embed tokens and their cost', async () => {
    const before = embedCalls;
    const r = await captureJson('inbox/usage-receipt', '# Usage receipt\n\nFirst version of the page, long enough to chunk.');
    expect(embedCalls).toBe(before + 1);
    expect(r.slug).toBe('inbox/usage-receipt');
    expect(r.outcome).toBe('created');
    expect(r.embed_tokens).toBeGreaterThan(0);
    expect(r.embed_cost_usd).toBeCloseTo((r.embed_tokens / 1_000_000) * 0.13, 12);
    expect(r.content_hash).toMatch(/^[a-f0-9]{64}$/); // the receipt's own fields are kept
  });

  test('changed content on the same slug: updated, re-embedded', async () => {
    const r = await captureJson('inbox/usage-receipt', '# Usage receipt\n\nSecond version, with different words in it.');
    expect(r.outcome).toBe('updated');
    expect(r.embed_tokens).toBeGreaterThan(0);
    expect(r.embed_cost_usd).toBeGreaterThan(0);
  });

  test('the same content again: unchanged, nothing embedded', async () => {
    const before = embedCalls;
    const r = await captureJson('inbox/usage-receipt', '# Usage receipt\n\nSecond version, with different words in it.');
    expect(embedCalls).toBe(before);
    expect(r).toMatchObject({ outcome: 'unchanged', embed_tokens: 0, embed_cost_usd: 0 });
  });

  test('a put_page result without usage (an older server) adds nothing to the receipt', () => {
    expect(captureUsageOf({ slug: 'x', status: 'created_or_updated' })).toEqual({});
    expect(captureUsageOf(null)).toEqual({});
    expect(captureUsageOf({ outcome: 'created', embed_tokens: 'many' })).toEqual({ outcome: 'created', embed_tokens: 0, embed_cost_usd: 0 });
  });
});
