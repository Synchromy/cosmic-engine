/**
 * Cosmic carried patch `put-page-usage` (cosmic-hub #1477).
 *
 * The hub's usage ledger reads mcp_request_log. A put_page row there said only
 * that a page was written. This module names what the write did (created,
 * updated or unchanged) and what its indexing cost, so the row and the
 * put_page result can carry it. capture delegates to put_page and inherits it.
 *
 * embed_tokens is the engine's own per-chunk estimate (wrapped text length / 4,
 * the value stored in content_chunks.token_count): the embed SDK shape does not
 * surface provider usage. embed_cost_usd prices it at the configured model's
 * rate (embedding-pricing.ts).
 */
import { estimateEmbeddingCostUsd } from './embedding.ts';

export type PutPageOutcome = 'created' | 'updated' | 'unchanged';

export interface PutPageUsage {
  outcome: PutPageOutcome;
  embed_tokens: number;
  embed_cost_usd: number;
}

/** From importFromContent's result: only an 'imported' write changed anything. */
export function putPageUsage(result: { status: string; outcome?: 'created' | 'updated'; embed_tokens?: number }): PutPageUsage {
  const imported = result.status === 'imported';
  const tokens = imported ? (result.embed_tokens ?? 0) : 0;
  return {
    outcome: imported ? (result.outcome ?? 'updated') : 'unchanged',
    embed_tokens: tokens,
    embed_cost_usd: tokens > 0 ? Number(estimateEmbeddingCostUsd(tokens).toFixed(10)) : 0,
  };
}

const USAGE_OPS = new Set(['put_page', 'capture']);

/**
 * The request-log params for a successful tool call: the redacted summary with
 * put_page's usage merged in. Any other op, or a result without an outcome
 * (dry_run), keeps its params as they were.
 */
export function requestLogParamsWithUsage(
  opName: string,
  params: unknown,
  toolResult: { content?: Array<{ text?: string }> },
): unknown {
  if (!USAGE_OPS.has(opName)) return params;
  let r: Partial<PutPageUsage> | null = null;
  try { r = JSON.parse(toolResult.content?.[0]?.text ?? 'null'); } catch { return params; }
  if (!r || typeof r !== 'object' || typeof r.outcome !== 'string') return params;
  const base = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  return { ...base, outcome: r.outcome, embed_tokens: r.embed_tokens ?? 0, embed_cost_usd: r.embed_cost_usd ?? 0 };
}
