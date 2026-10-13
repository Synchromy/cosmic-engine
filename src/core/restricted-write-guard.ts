/**
 * Cosmic carried patch `restricted-write-guard` (C-72, add-restricted-content,
 * finding 6). See cosmic/patches.json.
 *
 * On a company Cosmic, restricted content lives in one engine source,
 * `restricted`, which member-level clients leave out of `federated_read`.
 * Pages are unique on (source_id, slug), so a remote put_page to a slug that
 * already lives in `restricted` would land in the caller's write source as a
 * VISIBLE twin members can read. That one write is refused, naming the page.
 *
 * Nothing else is: trusted local writes (`gbrain capture` / `gbrain call`,
 * which is how the hub's ingest funnel lands) and remote writes to a slug that
 * two visible sources share (preserving imports) are untouched.
 */

import type { OperationContext } from './ops/contract.ts';
import { OperationError } from './ops/contract.ts';

export const RESTRICTED_SOURCE_ID = 'restricted';

/** Refuse a remote write that would create a visible twin of a restricted page. */
export async function assertNoRestrictedTwin(
  ctx: OperationContext,
  slug: string,
  targetSourceId: string,
  op: string,
): Promise<void> {
  if (ctx.remote === false || targetSourceId === RESTRICTED_SOURCE_ID) return;

  // getPage hides soft-deleted rows, so a deleted restricted page does not block.
  const restricted = await ctx.engine.getPage(slug, { sourceId: RESTRICTED_SOURCE_ID });
  if (!restricted) return;

  throw new OperationError(
    'permission_denied',
    `${op} refused: '${slug}' is a restricted page (source '${RESTRICTED_SOURCE_ID}'); writing it in '${targetSourceId}' would make a visible copy members can read.`,
    `Edit '${slug}' in source '${RESTRICTED_SOURCE_ID}' instead: patch_page with source_id 'restricted', or put_page from a client whose write source is restricted.`,
  );
}
