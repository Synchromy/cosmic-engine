/**
 * Cosmic carried patch `put-page-usage` (cosmic-hub #1477).
 *
 * The hub's usage ledger reads mcp_request_log. A put_page row there said only
 * that a page was written. This module names what the write did (created,
 * updated or unchanged) and what its indexing cost, so the row and the
 * put_page result can carry it. capture delegates to put_page and inherits it.
 *
 * embed_tokens sums content_chunks.token_count for chunks sent to the provider,
 * using the upstream tokenizer when a provider-free publication left it null.
 * Stored chunk counts are never changed. embed_cost_usd prices this estimate
 * at the configured model's rate (embedding-pricing.ts).
 */
import { estimateEmbeddingCostUsd } from './embedding.ts';

export type PutPageOutcome = 'created' | 'updated' | 'unchanged';

export interface PutPageUsage {
  outcome: PutPageOutcome;
  embed_tokens: number;
  embed_cost_usd: number;
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

/** Charge only chunks passed to the provider, never the vectors a publication reused. */
export async function recordPageEmbeddingUsage(engine: import('./engine.ts').BrainEngine, requestId: string, tokens: number): Promise<void> {
  if (tokens <= 0) return;
  const cost = Number(estimateEmbeddingCostUsd(tokens).toFixed(10));
  await engine.executeRaw(`UPDATE persistence_requests SET outcome = outcome || jsonb_build_object(
    'embed_tokens',COALESCE((outcome->>'embed_tokens')::bigint,0)+$2::bigint,
    'embed_cost_usd',COALESCE((outcome->>'embed_cost_usd')::numeric,0)+$3::numeric)
    WHERE id=$1::uuid AND operation IN ('put_page','capture') AND outcome->>'page_outcome' IN ('created','updated')`,
  [requestId, tokens, cost]);
}

// Embedding after the reply deadline updates the receipt, but the HTTP log row
// is not backfilled: its usage is a lower bound (cosmic-hub #1477, decision 1).
/** The top-level outcome is a string; the full receipt remains at write_request.outcome. */
export async function pageResponseWithUsage(
  engine: import('./engine.ts').BrainEngine,
  response: Record<string, unknown>,
  internalRequestId: string,
  deadline: number,
): Promise<Record<string, unknown>> {
  const receipt = response.outcome as Record<string, unknown> | undefined;
  if (!receipt || typeof receipt.page_outcome !== 'string') return response;
  let usage = receipt;
  // Embedding remains a post-publication effect. Do not wait beyond wait_ms, or
  // wait on a provider retry: a committed text write still succeeds on outage.
  if (receipt.page_outcome !== 'unchanged' && response.embedding_state === 'queued') {
    do {
      const [row] = await engine.executeRaw<{ outcome: Record<string, unknown>; state: string | null; error_code: string | null }>(
        `SELECT r.outcome,e.state,e.error_code FROM persistence_requests r
         LEFT JOIN persistence_effects e ON e.request_id=r.id AND e.kind='embedding' WHERE r.id=$1::uuid`,
        [internalRequestId]);
      if (!row) break;
      usage = row.outcome;
      if (!row.state || ['committed','failed'].includes(row.state) || row.error_code || performance.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(0, deadline - performance.now()))));
    } while (performance.now() < deadline);
  }
  const counts = { embed_tokens: usage.embed_tokens ?? 0, embed_cost_usd: usage.embed_cost_usd ?? 0 };
  const writeRequest = response.write_request as Record<string, unknown> | undefined;
  return { ...response, outcome: usage.page_outcome, ...counts,
    ...(writeRequest ? { write_request: { ...writeRequest, ...counts, outcome: usage } } : {}) };

}
