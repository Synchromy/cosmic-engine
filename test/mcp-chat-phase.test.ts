/**
 * MCP-originated model calls carry a chat usage phase naming the client and
 * the operation: `mcp:<client>:<operation>`.
 *
 * dispatchToolCall (the layer both MCP transports share) runs the op handler
 * under that phase, so every gateway.chat() an agent's tool call causes
 * (think, synthesize, query expansion) is attributable in chat_usage_log and
 * separable from Cosmic's own background jobs. Pinned here:
 *   - the client name comes from the auth the transport already resolved
 *     (client_name, else client id), "unknown" without auth;
 *   - an explicit phase set further in (a job, the synthesize cycle) keeps
 *     its own name, and a dispatch that already runs under a phase keeps it;
 *   - work outside the dispatch, and a facts-queue job queued outside it,
 *     gets no mcp phase even when the queue is pumped from inside one;
 *   - end to end on PGLite: a real synthesize call writes a chat_usage_log
 *     row with the mcp phase.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall, mcpChatPhase } from '../src/mcp/dispatch.ts';
import { operations, type Operation, type AuthInfo } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  __setChatTransportForTests,
  chat,
  configureGateway,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import {
  withChatPhase,
  currentChatPhase,
  setChatUsageSink,
  registerChatUsageSink,
  makeEngineChatUsageSink,
  type ChatUsageRecord,
} from '../src/core/ai/chat-usage.ts';
import { FactsQueue } from '../src/core/facts/queue.ts';
import { withEnv } from './helpers/with-env.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';

function fakeResult(over: Partial<ChatResult> = {}): ChatResult {
  return {
    text: 'ok',
    blocks: [{ type: 'text', text: 'ok' }],
    stopReason: 'end',
    usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5',
    providerId: 'anthropic',
    ...over,
  };
}

const say = () => chat({ model: 'anthropic:claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] });
const settle = () => new Promise((r) => setTimeout(r, 10));

function authFor(over: Partial<AuthInfo>): AuthInfo {
  return { token: 'not-a-real-token', clientId: 'client-id-1', scopes: ['read'], ...over };
}

describe('mcpChatPhase', () => {
  test('client_name, then client id, then unknown', () => {
    expect(mcpChatPhase(authFor({ clientName: 'claude-code' }), 'think')).toBe('mcp:claude-code:think');
    expect(mcpChatPhase(authFor({}), 'query')).toBe('mcp:client-id-1:query');
    expect(mcpChatPhase(undefined, 'synthesize')).toBe('mcp:unknown:synthesize');
    expect(mcpChatPhase(authFor({ clientName: '  ', clientId: '' }), 'think')).toBe('mcp:unknown:think');
  });

  test('a blank or whitespace-only client_name falls through to the client id', () => {
    expect(mcpChatPhase(authFor({ clientName: '' }), 'think')).toBe('mcp:client-id-1:think');
    expect(mcpChatPhase(authFor({ clientName: '   ' }), 'think')).toBe('mcp:client-id-1:think');
    expect(mcpChatPhase(authFor({ clientName: ' \t ' }), 'think')).toBe('mcp:client-id-1:think');
  });

  test('control characters are replaced and a long name is clamped; the token is never read', () => {
    const phase = mcpChatPhase(authFor({ clientName: 'a\nb\tc' + 'x'.repeat(500) }), 'think');
    expect(phase.startsWith('mcp:a_b_c')).toBe(true);
    expect(phase.endsWith(':think')).toBe(true);
    expect(phase.length).toBe('mcp:'.length + 128 + ':think'.length);
    expect(phase).not.toContain('not-a-real-token');
  });
});

describe('dispatchToolCall runs the handler under the mcp phase', () => {
  const engineStub = { kind: 'postgres', executeRaw: async () => [] } as unknown as BrainEngine;
  const OP = '__test_mcp_phase_op';
  let body: () => Promise<unknown> = async () => null;
  const op: Operation = {
    name: OP,
    description: 'test only',
    params: {},
    scope: 'read',
    handler: async () => body(),
  } as Operation;

  beforeAll(() => { operations.push(op); });
  afterAll(() => {
    const i = operations.indexOf(op);
    if (i >= 0) operations.splice(i, 1);
  });

  let records: ChatUsageRecord[] = [];
  const call = (auth?: AuthInfo) =>
    dispatchToolCall(engineStub, OP, {}, { remote: true, transport: 'http', sourceId: 'default', ...(auth ? { auth } : {}) });

  afterEach(() => {
    __setChatTransportForTests(null);
    setChatUsageSink(null);
    body = async () => null;
  });

  function rig() {
    records = [];
    setChatUsageSink((r) => { records.push(r); });
    __setChatTransportForTests(async () => fakeResult());
  }

  test('a chat call inside the handler logs mcp:<client>:<op>', async () => {
    rig();
    body = async () => { await say(); return { ok: true }; };
    const res = await call(authFor({ clientName: 'claude-code' }));
    expect(res.isError).toBeUndefined();
    await say(); // after the dispatch returned: not an MCP call
    await settle();
    expect(records.map((r) => r.phase)).toEqual([`mcp:claude-code:${OP}`, null]);
  });

  test('no auth (stdio) logs the unknown client', async () => {
    rig();
    body = async () => { await say(); return {}; };
    await call();
    await settle();
    expect(records.map((r) => r.phase)).toEqual([`mcp:unknown:${OP}`]);
  });

  test('an explicit phase set inside the handler keeps its own name', async () => {
    rig();
    body = async () => {
      await say();
      await withChatPhase('phase:synthesize', say);
      await withChatPhase('job:subagent', say);
      await say();
      return {};
    };
    await call(authFor({ clientName: 'codex' }));
    await settle();
    expect(records.map((r) => r.phase)).toEqual([
      `mcp:codex:${OP}`,
      'phase:synthesize',
      'job:subagent',
      `mcp:codex:${OP}`,
    ]);
  });

  test('a dispatch that already runs under a phase keeps that phase', async () => {
    rig();
    body = async () => { await say(); return {}; };
    await withChatPhase('job:autopilot-cycle', () => call(authFor({ clientName: 'codex' })));
    await settle();
    expect(records.map((r) => r.phase)).toEqual(['job:autopilot-cycle']);
  });

  test('the phase does not leak past the dispatch', async () => {
    rig();
    body = async () => ({ phase: currentChatPhase() });
    const res = await call(authFor({ clientName: 'claude-code' }));
    expect(JSON.parse(res.content[0]!.text).phase).toBe(`mcp:claude-code:${OP}`);
    expect(currentChatPhase()).toBeNull();
  });

  test('facts queue: a job queued outside the dispatch runs without the mcp phase, even when the MCP job frees its slot', async () => {
    rig();
    const queue = new FactsQueue({ perSessionInflightCap: 1 });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // The MCP call queues extraction on a session and returns.
    body = async () => {
      queue.enqueue(async () => { await gate; await say(); }, 'shared');
      return {};
    };
    await call(authFor({ clientName: 'claude-code' }));
    // Background work (no phase) queues on the same session. It waits for the
    // MCP job, and the MCP job's completion is what pumps it.
    queue.enqueue(async () => { await say(); }, 'shared');
    release();
    await queue.drainPending({ timeout: 1000 });
    await settle();
    expect(records.map((r) => r.phase)).toEqual([`mcp:claude-code:${OP}`, null]);
    await queue.shutdown();
  });
});

describe('end to end on PGLite: a synthesize call over MCP writes its phase to chat_usage_log', () => {
  let engine: PGLiteEngine;
  let deregister: () => void = () => {};

  beforeAll(async () => {
    configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    deregister = registerChatUsageSink(makeEngineChatUsageSink(engine));
  }, 60_000);

  afterAll(async () => {
    deregister();
    __setChatTransportForTests(null);
    resetGateway();
    await engine.disconnect();
  });

  test('rows group by mcp:<client>:synthesize', async () => {
    await engine.executeRaw('DELETE FROM chat_usage_log');
    __setChatTransportForTests(async () =>
      fakeResult({ text: JSON.stringify({ answer: 'An answer.', citations: [], gaps: [] }) }),
    );
    const res = await withEnv({ ANTHROPIC_API_KEY: 'sk-test-hermetic' }, () =>
      dispatchToolCall(engine, 'synthesize', { question: 'what do we know?' }, {
        remote: true,
        transport: 'http',
        sourceId: 'default',
        takesHoldersAllowList: ['world'],
        auth: authFor({ clientName: 'test-agent', sourceId: 'default' }),
      }),
    );
    expect(res.isError).toBeUndefined();
    await settle();
    const rows = (await engine.executeRaw(
      'SELECT phase, count(*)::int AS n FROM chat_usage_log GROUP BY phase ORDER BY phase',
    )) as Array<{ phase: string | null; n: number }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.phase === 'mcp:test-agent:synthesize')).toBe(true);
  });
});
