/**
 * Cosmic C-19 catch-up: `gbrain embed --waiting`. Run as a FRESH process on a
 * timer (the hub's reconcile loop): `embed --stale` quarantines a page after
 * GBRAIN_EMBED_QUARANTINE_AFTER failures per PROCESS (#3622), so a long-lived
 * drain would skip every waiting page for the rest of an outage.
 *
 * While the embedder is still out it embeds nothing and says so; that is the
 * expected outcome on most ticks of an outage, not a failure.
 */
import type { BrainEngine } from './engine.ts';
import { isAvailable } from './ai/gateway.ts';
import { currentEmbeddingSignature } from './embedding.ts';
import { embedBatchWithBackoff } from './embed-retry.ts';
import { EMBED_PROBE_TEXT, embedStalePages } from './embed-stale.ts';
import { AUDIT_ROW_SOURCES } from './facts/audit-sources.ts';
import {
  clearEmbedWaiting,
  countEmbedWaiting,
  countPageNullChunks,
  isEmbedOutageError,
  listEmbedWaiting,
} from './embed-outage.ts';

type EmbedFn = (texts: string[], o: { abortSignal?: AbortSignal }) => Promise<Float32Array[]>;

export interface EmbedWaitingResult {
  /** true when the embedder is unconfigured or still refusing: nothing was tried. */
  outage: boolean;
  no_embedder?: true;
  pages_embedded: number;
  pages_waiting: number;
  facts_embedded: number;
}

/** Facts per run, so a first run over a large NULL backlog stays bounded. */
const FACTS_PER_RUN = 500;
const FACTS_BATCH = 50;

export async function drainEmbedWaiting(
  engine: BrainEngine,
  opts: { embedFn?: EmbedFn } = {},
): Promise<EmbedWaitingResult> {
  const embedFn: EmbedFn = opts.embedFn ?? ((texts, o) => embedBatchWithBackoff(texts, { abortSignal: o.abortSignal }));
  const idle = async (extra: Partial<EmbedWaitingResult> = {}): Promise<EmbedWaitingResult> => ({
    outage: true, pages_embedded: 0, pages_waiting: await countEmbedWaiting(engine), facts_embedded: 0, ...extra,
  });

  if (!isAvailable('embedding')) return idle({ no_embedder: true });
  try {
    await embedBatchWithBackoff([EMBED_PROBE_TEXT], { maxRetries: 0 });
  } catch (e) {
    if (isEmbedOutageError(e)) return idle();
    throw e;
  }

  const signature = currentEmbeddingSignature() ?? undefined;
  let pagesEmbedded = 0;
  for (const row of await listEmbedWaiting(engine)) {
    const page = await engine.getPage(row.slug, { sourceId: row.source_id });
    if (!page) {
      await clearEmbedWaiting(engine, row.source_id, row.slug);
      continue;
    }
    // embedStalePages logs and swallows a per-page failure; the marker is
    // cleared only when THIS page has no chunk left without a vector.
    await embedStalePages(engine, [row.slug], row.source_id, { embedFn, embeddingSignature: signature });
    if (await countPageNullChunks(engine, row.source_id, row.slug) === 0) {
      await clearEmbedWaiting(engine, row.source_id, row.slug);
      pagesEmbedded++;
    }
  }

  // Facts written while the embedder was out: `remember` already lands them
  // with a NULL embedding (fail-soft, write-single.ts). This fills the vector
  // only. The dedup and supersession skipped at write time are NOT replayed.
  // Same predicate as embedding-migration's `facts_pending`.
  let factsEmbedded = 0;
  const facts = await engine.executeRaw<{ id: number; fact: string }>(
    `SELECT id, fact FROM facts
      WHERE embedding IS NULL AND expired_at IS NULL AND NOT (source = ANY($1::text[]))
      ORDER BY id LIMIT ${FACTS_PER_RUN}`,
    [[...AUDIT_ROW_SOURCES]],
  );
  if (facts.length > 0) {
    const cast = await factsEmbeddingCast(engine);
    for (let i = 0; i < facts.length; i += FACTS_BATCH) {
      const batch = facts.slice(i, i + FACTS_BATCH);
      let vectors: Float32Array[];
      try {
        vectors = await embedFn(batch.map(f => f.fact), {});
      } catch (e) {
        if (isEmbedOutageError(e)) break; // out again: the next tick resumes
        throw e;
      }
      for (let j = 0; j < batch.length; j++) {
        if (!vectors[j]) continue;
        await engine.executeRaw(`UPDATE facts SET embedding = $1${cast}, embedded_at = now() WHERE id = $2 AND embedding IS NULL`,
          [`[${Array.from(vectors[j]).join(',')}]`, batch[j].id]);
        factsEmbedded++;
      }
    }
  }

  return { outage: false, pages_embedded: pagesEmbedded, pages_waiting: await countEmbedWaiting(engine), facts_embedded: factsEmbedded };
}

/** halfvec(N) or vector(N), read from the column, as postgres-engine's insert does. */
async function factsEmbeddingCast(engine: BrainEngine): Promise<'::vector' | '::halfvec'> {
  try {
    const rows = await engine.executeRaw<{ t: string | null }>(
      `SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute
        WHERE attrelid = 'facts'::regclass AND attname = 'embedding'`,
    );
    return rows[0]?.t && /halfvec/i.test(rows[0].t) ? '::halfvec' : '::vector';
  } catch {
    return '::vector';
  }
}
