/**
 * C1 canonical page mutation operations.
 *
 * Kept separate from the legacy page CRUD cluster so the containment slice
 * has one reviewable boundary and pages.ts stays within the module-size gate.
 */

import { submitPageMutation, requestPrincipalForContext, initializeLocalPersistence } from '../persistence/page-mutations.ts';
import { digest } from '../persistence/digest.ts';
import { getWriteRequest } from '../persistence/journal.ts';
import { WRITE_REQUEST_PARAM, WRITE_WAIT_PARAM } from '../persistence/params.ts';
import type { BrainEngine } from '../engine.ts';
import { parseMarkdown } from '../markdown.ts';
import {
  canonicalMutationReceiptId,
  CanonicalMutationError,
  type SparsePagePatch,
} from '../canonical-page-mutations.ts';
import { validateCanonicalInteractionEvent } from '../canonical-page-events.ts';
import { OperationError } from './contract.ts';
import type { Operation, OperationContext } from './contract.ts';
import {
  enforceClientSlugFence,
  enforceSubagentSlugFence,
  parseSourceIdParam,
  validatePageSlug,
} from './context.ts';

type ActivePack = { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> };

const C1_UNSUPPORTED_CREATE_TYPES = new Set([
  'concept', 'media', 'tweet', 'social-digest', 'analysis', 'atom',
  'source', 'deal', 'email', 'slack', 'writing', 'event',
]);

function enabledConfigValue(value: string | null): boolean {
  if (value == null) return false;
  return ['1', 'true', 'on', 'yes'].includes(value.trim().toLowerCase());
}

function assertPlainObjectParam(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (value === undefined) return;
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new OperationError('invalid_params', `${name} must be a JSON object.`);
  }
}

function assertStringArrayParam(value: unknown, name: string): asserts value is string[] {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new OperationError('invalid_params', `${name} must be a JSON array of strings.`);
  }
}

export async function isC1ContainmentEnabled(engine: BrainEngine): Promise<boolean> {
  try {
    return enabledConfigValue(await engine.getConfig('writer.c1_containment'));
  } catch {
    // A failed config read must not silently turn an unactivated breaking
    // policy on. Activation is explicit and separately reviewed.
    return false;
  }
}

export async function isC1RevisionGuardEnabled(engine: BrainEngine): Promise<boolean> {
  try {
    return enabledConfigValue(await engine.getConfig('writer.c1_revision_guard'));
  } catch {
    return false;
  }
}

async function isAppendPageEventEnabled(engine: BrainEngine): Promise<boolean> {
  try {
    return enabledConfigValue(await engine.getConfig('writer.append_page_event'));
  } catch {
    return false;
  }
}

function canonicalMutationPrincipal(ctx: OperationContext): string {
  if (ctx.viaSubagent === true) {
    if (Number.isInteger(ctx.subagentId) && (ctx.subagentId ?? 0) > 0) return `subagent:${ctx.subagentId}`;
    throw new OperationError(
      'authority_required',
      'append_page_event requires a server-issued subagent identity.',
      'Retry through a correctly attributed subagent job.',
    );
  }
  if (ctx.auth?.clientId) return `oauth:${ctx.auth.clientId}`;
  if (ctx.remote === false) return 'local-owner';
  if (ctx.transport === 'stdio') return 'stdio-local';
  throw new OperationError(
    'unknown_transport',
    'append_page_event requires an authenticated or server-attributed caller identity.',
    'Use OAuth, the local owner CLI, or local stdio MCP.',
  );
}

function assertSourceInWriteGrant(ctx: OperationContext, sourceId: string): void {
  if (ctx.remote === false) return;
  const writeAuthority = ctx.auth?.sourceId ?? ctx.sourceId;
  if (sourceId === writeAuthority) return;
  throw new OperationError(
    'permission_denied',
    `source '${sourceId}' is outside your write authority`,
    'Federated read grants do not confer write authority.',
  );
}

export function assertC1CreateAdmissible(
  content: string,
  slug: string,
  activePack?: ActivePack,
): void {
  const candidate = parseMarkdown(content, `${slug}.md`, {
    validate: true,
    expectedSlug: slug,
    ...(activePack ? { activePack } : {}),
  });
  if ((candidate.errors ?? []).length > 0) {
    throw new OperationError(
      'invalid_params',
      `C1 containment rejected invalid canonical Markdown: ${(candidate.errors ?? []).map((e) => e.code).join(', ')}.`,
      'Fix the Markdown/frontmatter before retrying. No canonical page was written.',
    );
  }
  const normalizedType = String(candidate.type).trim().toLowerCase();
  if (C1_UNSUPPORTED_CREATE_TYPES.has(normalizedType)) {
    throw new OperationError(
      'unsupported_type',
      `C1 containment keeps type '${candidate.type}' read-compatible but does not authorize new canonical creates.`,
      'Route this item to report-only review; do not infer or auto-remap a replacement type.',
    );
  }

  // D4 assigns tenant, authenticated writer, policy-version, canonical-hash,
  // and receipt construction to a trusted server-side authority boundary.
  // OperationContext does not carry that authority envelope yet. Frontmatter
  // is caller-owned input, so accepting tenant_id/privacy/lineage keys merely
  // because they are present would let the caller self-attest the very fields
  // the boundary is supposed to guarantee. Until that ingress exists, C1's
  // only honest fail-closed behaviour is to reject every new authoritative
  // page. Existing pages remain revision-patchable through patch_page.
  throw new OperationError(
    'authority_required',
    `C1 containment cannot admit new authoritative page '${slug}' without a trusted server-issued authority envelope.`,
    'Keep the input in its source/raw lane or submit it for review. Do not copy authority metadata into frontmatter to bypass this gate.',
  );
}

/** Safely patch an existing canonical page using exact-byte CAS semantics. */
export const patchPageOperation: Operation = {
  name: 'patch_page',
  outputRedaction: 'no_stored_text',
  description: 'Patch existing canonical Markdown using base_revision from get_page. Omitted fields survive; frontmatter_unset explicitly removes keys. Objects and arrays replace atomically. The canonical owner coordinates file publication, projection, recovery and durable request receipts. Retry with the same request_id.',
  params: {
    request_id: WRITE_REQUEST_PARAM,
    wait_ms: WRITE_WAIT_PARAM,
    slug: { type: 'string', required: true, description: 'Existing page slug.' },
    source_id: { type: 'string', required: false, description: 'Source that supplied the canonical_revision. Remote callers may target only their write source.' },
    base_revision: { type: 'string', required: true, description: 'Exact canonical_revision returned by get_page.' },
    frontmatter_set: { type: 'object', required: false, description: 'Top-level frontmatter keys to set. Nested objects and arrays replace atomically.' },
    frontmatter_unset: { type: 'array', required: false, items: { type: 'string' }, description: 'Top-level frontmatter keys to remove explicitly.' },
    frontmatter_set_if_empty: { type: 'object', required: false, description: 'Set a key only when absent, null, or a blank string.' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    const slug = p.slug as string;
    validatePageSlug(slug);
    enforceSubagentSlugFence(ctx, slug, 'patch_page');
    enforceClientSlugFence(ctx, slug, 'patch_page');
    const baseRevision = typeof p.base_revision === 'string' ? p.base_revision : '';
    if (!/^sha256:[0-9a-f]{64}$/.test(baseRevision)) {
      throw new OperationError('invalid_params', 'patch_page requires a valid sha256 canonical base_revision.', 'Read the page with get_page and pass its canonical_revision unchanged.');
    }
    if (ctx.dryRun) return { dry_run: true, action: 'patch_page', slug, base_revision: baseRevision };

    const requestedSource = parseSourceIdParam(p.source_id, 'patch_page');
    const sourceId = requestedSource ?? ctx.sourceId ?? 'default';
    if (ctx.remote !== false) {
      const writeAuthority = ctx.auth?.sourceId ?? ctx.sourceId;
      if (sourceId !== writeAuthority) {
        throw new OperationError(
          'permission_denied',
          `source '${sourceId}' is outside your write authority`,
          'Pass the source_id returned by get_page only when it is also your write source. Federated read grants do not confer write authority.',
        );
      }
    }
    assertPlainObjectParam(p.frontmatter_set, 'frontmatter_set');
    assertStringArrayParam(p.frontmatter_unset, 'frontmatter_unset');
    assertPlainObjectParam(p.frontmatter_set_if_empty, 'frontmatter_set_if_empty');
    const existing = await ctx.engine.getPage(slug, { sourceId });
    if (!existing) throw new OperationError('page_not_found', `Page not found: ${slug}`, 'patch_page updates existing pages only.');
    const patch: SparsePagePatch = {
      ...(p.frontmatter_set !== undefined ? { frontmatter_set: p.frontmatter_set as Record<string, unknown> } : {}),
      ...(p.frontmatter_unset !== undefined ? { frontmatter_unset: p.frontmatter_unset as string[] } : {}),
      ...(p.frontmatter_set_if_empty !== undefined ? { frontmatter_set_if_empty: p.frontmatter_set_if_empty as Record<string, unknown> } : {}),
    };

    // The principal-scoped coordinator journal owns replay and publication.
    // Derive a stable UUID when older hub callers omit request_id.
    await initializeLocalPersistence(ctx);
    const principal = await requestPrincipalForContext(ctx);
    const hash = digest({ operation: 'patch_page', sourceId, slug, baseRevision, patch });
    const requestId = p.request_id ?? `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    const prior = typeof requestId === 'string' ? await getWriteRequest(ctx.engine, principal, requestId) : null;
    const result = await submitPageMutation(ctx, {
      operation: 'patch_page',
      params: { ...p, request_id: requestId, source_id: sourceId },
    });
    return { ...result, resumed: prior?.state === 'committed' };

  },
  cliHints: { name: 'patch-page', positional: ['slug'] },
};

/** Append one typed interaction to an existing canonical page exactly once. */
export const appendPageEventOperation: Operation = {
  name: 'append_page_event',
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Append one typed interaction to an existing canonical page. The server derives caller identity and event marker, binds a caller-stable idempotency key to the full request, coordinates canonical publication, projection and recovery, and returns an immutable receipt. Historical events are placed by date and never regress last-contact metadata.',
  params: {
    slug: { type: 'string', required: true, description: 'Existing canonical page slug.' },
    source_id: { type: 'string', required: false, description: 'Write-authorized source containing the page.' },
    idempotency_key: { type: 'string', required: true, description: 'Stable upstream event identity, namespaced by provider and target slug.' },
    date: { type: 'string', required: true, description: 'Interaction date as YYYY-MM-DD.' },
    channel: { type: 'string', required: true, description: 'Short interaction channel label.' },
    note: { type: 'string', required: true, description: 'Single-line plain-text interaction summary.' },
  },
  mutating: true,
  scope: 'write',
  publishGateKey: 'writer.append_page_event',
  handler: async (ctx, p) => {
    const slug = p.slug as string;
    validatePageSlug(slug);
    enforceSubagentSlugFence(ctx, slug, 'append_page_event');
    enforceClientSlugFence(ctx, slug, 'append_page_event');
    const requestedSource = parseSourceIdParam(p.source_id, 'append_page_event');
    const sourceId = requestedSource ?? ctx.sourceId ?? 'default';
    assertSourceInWriteGrant(ctx, sourceId);
    const principalId = canonicalMutationPrincipal(ctx);
    const rawIdempotencyKey = p.idempotency_key;
    if (typeof rawIdempotencyKey !== 'string'
      || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(rawIdempotencyKey)) {
      throw new OperationError('invalid_params', 'append_page_event requires a single-line idempotency_key of 1 to 512 characters.');
    }
    const idempotencyKey = rawIdempotencyKey.trim();
    if (idempotencyKey.length < 1 || idempotencyKey.length > 512) {
      throw new OperationError('invalid_params', 'append_page_event requires a single-line idempotency_key of 1 to 512 characters.');
    }
    const semanticRequest = { date: p.date, channel: p.channel, note: p.note };
    const eventToken = canonicalMutationReceiptId(principalId, sourceId, idempotencyKey);
    try {
      validateCanonicalInteractionEvent({
        date: p.date as string,
        channel: p.channel as string,
        note: p.note as string,
        eventToken,
      });
    } catch (error) {
      if (error instanceof CanonicalMutationError) throw new OperationError('invalid_params', error.message);
      throw error;
    }
    if (!await isAppendPageEventEnabled(ctx.engine)) {
      throw new OperationError(
        'unavailable',
        'append_page_event is installed but not activated for this brain.',
        'Keep the writer on its reviewed source-only adapter until the append-event conformance gate is approved.',
      );
    }
    if (ctx.dryRun) {
      return { dry_run: true, action: 'append_page_event', slug, source_id: sourceId };
    }
    // The canonical owner owns the file, projection, crash recovery and receipt.
    // Namespace the durable request by the server-derived event identity.
    if (!ctx.auth?.principal) await initializeLocalPersistence({ ...ctx, auth: undefined });
    const principal = await requestPrincipalForContext(ctx);
    const hash = eventToken.slice('sha256:'.length);
    const requestId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    const prior = await getWriteRequest(ctx.engine, principal, requestId);
    if (!prior && !await ctx.engine.getPage(slug, { sourceId })) {
      throw new OperationError('page_not_found', `Page not found: ${slug}`, 'append_page_event updates existing pages only.');
    }
    const result = await submitPageMutation(ctx, {
      operation: 'append_page_event',
      params: { slug, source_id: sourceId, request_id: requestId,
        idempotency_key: idempotencyKey, principal_id: principalId,
        event_token: eventToken, ...semanticRequest },
    });
    return { ...result, status: prior?.state === 'committed' ? 'replayed' : result.status };

  },
  cliHints: { name: 'append-page-event', positional: ['slug', 'date', 'channel', 'note'] },
};
