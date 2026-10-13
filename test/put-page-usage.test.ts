/**
 * Cosmic carried patch `put-page-usage` (cosmic-hub #1477, decision 1).
 *
 * A put_page result, and the mcp_request_log row serve-http writes for it,
 * say what the write did (created | updated | unchanged) and what its indexing
 * cost (embed_tokens, embed_cost_usd). The row is built the way serve-http's
 * success insert builds it: the redacted params summary, passed through
 * requestLogParamsWithUsage, into mcp_request_log.params as jsonb.
 *
 * Hermetic: in-memory PGLite, embed transport stubbed (openai 3-large, $0.13/MTok).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall, summarizeMcpParams } from '../src/mcp/dispatch.ts';
import { executeRawJsonb } from '../src/core/sql-query.ts';
import { requestLogParamsWithUsage } from '../src/core/put-page-usage.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
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
});

afterAll(async () => {
  await engine.disconnect();
  __setEmbedTransportForTests(null);
  resetGateway();
});

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

/** One tools/call the way serve-http runs it, then its success row read back. */
async function callAndLog(name: string, params: Record<string, unknown>) {
  const toolResult = await dispatchToolCall(engine, name, params, { remote: false, sourceId: 'default', logger: quiet } as any);
  expect(toolResult.isError).toBeFalsy();
  const result = JSON.parse(toolResult.content[0].text);
  const rows = await executeRawJsonb<{ params: Record<string, unknown> }>(
    engine,
    `INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, params)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING params`,
    ['test-client', 'test-agent', name, 1, 'success'],
    [requestLogParamsWithUsage(name, summarizeMcpParams(name, params), toolResult)],
  );
  return { result, row: rows[0].params };
}

const body = (s: string) => `---\ntitle: Usage probe\ntype: note\n---\n\n${s}\n`;

describe('put-page-usage', () => {
  test('a new page: created, with the embed tokens and their cost', async () => {
    const before = embedCalls;
    const { result, row } = await callAndLog('put_page', { slug: 'notes/usage-probe', content: body('First version of the page, long enough to chunk.') });
    expect(embedCalls).toBe(before + 1);
    expect(result.status).toBe('created_or_updated');
    expect(result.outcome).toBe('created');
    expect(result.embed_tokens).toBeGreaterThan(0);
    expect(result.embed_cost_usd).toBeCloseTo((result.embed_tokens / 1_000_000) * 0.13, 12);
    expect(row.outcome).toBe('created');
    expect(row.embed_tokens).toBe(result.embed_tokens);
    expect(row.embed_cost_usd).toBe(result.embed_cost_usd);
    expect(row.redacted).toBe(true); // the summary is kept, the usage is merged in
    expect(row.declared_keys).toEqual(['content', 'slug']);
  });

  test('changed content on the same slug: updated, re-embedded', async () => {
    const { result, row } = await callAndLog('put_page', { slug: 'notes/usage-probe', content: body('Second version, with different words in it.') });
    expect(result.outcome).toBe('updated');
    expect(result.embed_tokens).toBeGreaterThan(0);
    expect(row.outcome).toBe('updated');
    expect(row.embed_cost_usd).toBeGreaterThan(0);
  });

  test('the same content again: unchanged, nothing embedded, status as before', async () => {
    const before = embedCalls;
    const { result, row } = await callAndLog('put_page', { slug: 'notes/usage-probe', content: body('Second version, with different words in it.') });
    expect(embedCalls).toBe(before);
    expect(result.status).toBe('skipped');
    expect(result.outcome).toBe('unchanged');
    expect(row).toMatchObject({ outcome: 'unchanged', embed_tokens: 0, embed_cost_usd: 0 });
  });

  test('capture goes through put_page and logs the same fields', async () => {
    const { result, row } = await callAndLog('capture', { content: 'A captured thought about usage ledgers.' });
    expect(result.outcome).toBe('created');
    expect(row.outcome).toBe('created');
    expect(row.embed_tokens).toBeGreaterThan(0);
  });

  test('any other op keeps its params untouched', async () => {
    const params = { redacted: true, kind: 'object' };
    expect(requestLogParamsWithUsage('get_page', params, { content: [{ text: '{"outcome":"created"}' }] })).toBe(params);
  });
});
