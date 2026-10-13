import type { CyclePhase, PhaseResult } from './cycle.ts';
import { PHASE_SCOPE } from './cycle/phase-scope.ts';

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

// Shared derivations consume page content; page-local extract, weight and embedding remain enabled.
const RESTRICTED_DERIVATION_PHASES = new Set<CyclePhase>([
  'synthesize', 'extract_facts', 'extract_atoms', 'patterns',
  'synthesize_concepts', 'consolidate',
  'propose_takes', 'grade_takes', 'calibration_profile', 'drift',
  'conversation_facts_backfill', 'enrich_thin', 'chronicle',
]);

export function restrictCycleDerivations(phases: CyclePhase[], sourceId: string | undefined): CyclePhase[] {
  return derivesFrom(sourceId) ? phases : phases.filter(phase => !RESTRICTED_DERIVATION_PHASES.has(phase));
}

export function excludedCyclePhaseResult(phase: CyclePhase, sourceId: string | undefined): PhaseResult {
  const restricted = !derivesFrom(sourceId) && RESTRICTED_DERIVATION_PHASES.has(phase);
  return {
    phase,
    status: 'skipped',
    duration_ms: 0,
    summary: restricted
      ? 'restricted source is excluded from shared derivations'
      : `excluded from implicit non-default source cycle (${PHASE_SCOPE[phase]} scope)`,
    details: {
      reason: restricted ? RESTRICTED_SOURCE_REASON : 'excluded_from_implicit_source_cycle',
      source_id: sourceId,
      phase_scope: PHASE_SCOPE[phase],
    },
  };
}
