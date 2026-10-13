/**
 * Cosmic carried patch `restricted-no-derive` (C-72, add-restricted-content,
 * finding 9). See cosmic/patches.json.
 *
 * Shared derivations must never use a member-hidden source as input:
 * members cannot read it, so their derived pages must not contain it.
 * Member-hidden sources are `restricted` and, by finding 10, the existing
 * `founders` source, which starts restricted.
 *
 * This deliberately does not restrict direct reads, writes, embedding, or
 * page-local link/timeline work that remains on a restricted page.
 */

export const RESTRICTED_SOURCE_ID = 'restricted';
export const FOUNDERS_SOURCE_ID = 'founders';
export const RESTRICTED_SOURCE_REASON = 'restricted_source';

/** Sources members cannot read, so nothing shared is derived from them. */
export const NO_DERIVE_SOURCE_IDS: readonly string[] = [RESTRICTED_SOURCE_ID, FOUNDERS_SOURCE_ID];

/** Whether content from this source may be used to derive shared state. */
export function derivesFrom(sourceId: string | undefined): boolean {
  return sourceId === undefined || !NO_DERIVE_SOURCE_IDS.includes(sourceId);
}
