/**
 * Cosmic C-19: when the embedder is OUT (refusing, over its key limit, down),
 * a page write lands without its embedding and is marked waiting; the
 * `gbrain embed --waiting` catch-up embeds it once the embedder answers.
 *
 * The classifier is deliberately conservative: anything it does not
 * recognise as an outage still throws, as every embed failure did before.
 * A dimension mismatch, an oversize payload or bad input is never an outage.
 *
 * The marker is its own table rather than "chunks with a NULL embedding",
 * because that set is not empty on a healthy brain (embed_skip, null
 * signature, quarantined pages). It is created idempotently here, not by a
 * numbered migration: this is a carried patch and upstream owns the numbers.
 */
import type { BrainEngine } from './engine.ts';
import { detect429FromCause, isTransientNetworkEmbedError } from './embed-retry.ts';
import { resolveActiveEmbeddingColumnFromEngine, quoteIdentifier } from './search/embedding-column.ts';

const NOT_OUTAGE = /expected\s+\d+\s+dimensions|dimension|maximum context length|context_length|too long|too many tokens|payload too large|\b413\b|invalid input|bad request/i;
const OUTAGE = /key limit exceeded|insufficient (credits|balance|quota)|insufficient_quota|payment required|unauthorized|forbidden|invalid api key|rate.?limit|too many requests|\b429\b|internal server error|bad gateway|service unavailable|gateway timeout|status(?: code)?:? 5\d\d|\b5\d\d (?:internal|bad|service|gateway)|ECONNREFUSED|connection refused/i;

/** The string form, so another repo can hold stored error text to the same rule. */
export function isEmbedOutageMessage(msg: string): boolean {
  if (NOT_OUTAGE.test(msg)) return false;
  return OUTAGE.test(msg);
}

export function isEmbedOutageError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  if ((error as { name?: unknown })?.name === 'AbortError' || /\baborted\b/i.test(msg)) return false;
  if (NOT_OUTAGE.test(msg)) return false;
  let cur: unknown = error;
  for (let depth = 0; depth < 5 && cur != null; depth++) {
    const obj = cur as { status?: unknown; statusCode?: unknown; code?: unknown; cause?: unknown };
    const status = obj.status ?? obj.statusCode;
    if (typeof status === 'number') {
      if (status === 401 || status === 402 || status === 403 || status === 429 || (status >= 500 && status <= 599)) return true;
      if (status >= 400 && status < 500) return false;
    }
    if (obj.code === 'ECONNREFUSED') return true;
    cur = obj.cause;
  }
  return detect429FromCause(error) || isTransientNetworkEmbedError(error) || isEmbedOutageMessage(msg);
}

/**
 * In-process breaker: once a write has met an outage, the next writes in the
 * following minute skip the embed attempt and go straight to waiting, so a
 * burst of writes does not each spend the retry budget. A successful embed
 * closes it.
 */
const BREAKER_MS = 60_000;
let _openUntil = 0;
export function embedOutageBreakerOpen(now = Date.now()): boolean { return now < _openUntil; }
export function noteEmbedOutage(now = Date.now()): void { _openUntil = now + BREAKER_MS; }
export function noteEmbedHealthy(): void { _openUntil = 0; }
/** @internal test seam */
export function _resetEmbedOutageBreakerForTests(): void { _openUntil = 0; }

const ensured = new WeakSet<object>();

export async function ensureEmbedWaitingTable(engine: BrainEngine): Promise<void> {
  if (ensured.has(engine as object)) return;
  try {
    await engine.executeRaw(`CREATE TABLE IF NOT EXISTS cosmic_embed_waiting (
      source_id TEXT NOT NULL, slug TEXT NOT NULL, since TIMESTAMPTZ NOT NULL DEFAULT now(), reason TEXT,
      PRIMARY KEY (source_id, slug))`);
  } catch (e) {
    // Two processes racing CREATE TABLE IF NOT EXISTS on Postgres can lose
    // with a duplicate-type error; the table exists either way.
    if (!/already exists|duplicate key|23505/i.test(e instanceof Error ? e.message : String(e))) throw e;
  }
  ensured.add(engine as object);
}

export async function countEmbedWaiting(engine: BrainEngine, scope?: { sourceId?: string; sourceIds?: string[] }): Promise<number> {
  await ensureEmbedWaitingTable(engine);
  const ids = scope?.sourceIds ?? (scope?.sourceId ? [scope.sourceId] : undefined);
  const suffix = ids ? ' AND w.source_id = ANY($1::text[])' : '';
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM cosmic_embed_waiting w
       JOIN pages p ON p.source_id = w.source_id AND p.slug = w.slug
      WHERE p.deleted_at IS NULL${suffix}`,
    ids ? [ids] : [],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function listEmbedWaiting(engine: BrainEngine): Promise<Array<{ source_id: string; slug: string }>> {
  await ensureEmbedWaitingTable(engine);
  return engine.executeRaw(`SELECT source_id, slug FROM cosmic_embed_waiting ORDER BY since`);
}

export async function clearEmbedWaiting(engine: BrainEngine, sourceId: string, slug: string): Promise<void> {
  await ensureEmbedWaitingTable(engine);
  await engine.executeRaw('DELETE FROM cosmic_embed_waiting WHERE source_id = $1 AND slug = $2', [sourceId, slug]);
}

/** Chunks of ONE page still without a vector in the registry-active column. */
export async function countPageNullChunks(engine: BrainEngine, sourceId: string, slug: string): Promise<number> {
  const col = quoteIdentifier((await resolveActiveEmbeddingColumnFromEngine(engine, { fallbackToLegacy: true })).name);
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE p.slug = $1 AND p.source_id = $2 AND cc.${col} IS NULL`,
    [slug, sourceId],
  );
  return Number(rows[0]?.n ?? 0);
}
