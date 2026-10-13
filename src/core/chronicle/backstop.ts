/** Compatibility entry point; current publications decide through chronicle/ledger.ts. */
import type { BrainEngine } from '../engine.ts';
import { derivesFrom, RESTRICTED_SOURCE_REASON } from '../restricted-no-derive.ts';

export interface ChronicleBackstopResult {
  enqueued: boolean;
  skipped?: string;
}

/** Legacy callers cannot enqueue extraction outside the current write-time ledger. */
export async function runChronicleBackstop(
  _page: { slug: string; type: string; compiled_truth?: string; frontmatter?: Record<string, unknown> },
  ctx: { engine: BrainEngine; sourceId: string },
): Promise<ChronicleBackstopResult> {
  if (!derivesFrom(ctx.sourceId)) return { enqueued: false, skipped: RESTRICTED_SOURCE_REASON };
  return { enqueued: false, skipped: 'no_write_decision' };
}
