/**
 * Cosmic carried patch `restricted-no-derive` (C-72, add-restricted-content,
 * finding 9). See cosmic/patches.json.
 *
 * Shared derivations must never use the company-restricted source as input:
 * members cannot read it, so their derived pages must not contain it.
 *
 * This deliberately does not restrict direct reads, writes, embedding, or
 * page-local link/timeline work that remains on a restricted page.
 */

export const RESTRICTED_SOURCE_ID = 'restricted';
export const RESTRICTED_SOURCE_REASON = 'restricted_source';

/** Whether content from this source may be used to derive shared state. */
export function derivesFrom(sourceId: string | undefined): boolean {
  return sourceId !== RESTRICTED_SOURCE_ID;
}
