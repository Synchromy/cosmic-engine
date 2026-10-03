/**
 * Cosmic carried patch restricted-advisor (C-72, finding 8).
 *
 * Advisor collectors diagnose the whole brain, so a remotely connected member
 * with a partial source grant must not receive their counts or findings.
 */

import type { OperationContext } from './ops/contract.ts';
import { OperationError } from './ops/contract.ts';
import { sourceScopeOpts } from './ops/context.ts';

/** Refuse whole-brain advisor diagnostics outside a caller's complete grant. */
export async function assertAdvisorReadsWholeBrain(ctx: OperationContext): Promise<void> {
  if (ctx.remote === false) return;

  const scope = sourceScopeOpts(ctx);
  const readable = scope.sourceIds ?? (scope.sourceId ? [scope.sourceId] : undefined);
  if (!readable) return;

  const sources = await ctx.engine.executeRaw<{ id: string }>('SELECT id FROM sources');
  if (sources.some(({ id }) => !readable.includes(id))) {
    const err = new OperationError(
      'permission_denied',
      'The advisor reports on the whole brain, and your access does not cover all of it, so it is withheld.',
      'Ask the brain owner for access covering the whole brain.',
    );
    err.detail = 'reason=partial_read_grant';
    throw err;
  }
}
