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
  type SparsePagePatch,
} from '../canonical-page-mutations.ts';
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
    type: { type: 'string', required: false, description: 'New page type (lowercase slug grammar). type is a reserved frontmatter key, so this is the only way to retype a page through patch_page.' },
    title: { type: 'string', required: false, description: 'New page title (single line, 1-300 characters). title is a reserved frontmatter key, so this is the only way to retitle a page through patch_page.' },
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
    if (p.type !== undefined && (typeof p.type !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(p.type))) {
      throw new OperationError('invalid_params', 'patch_page type must be a lowercase slug-grammar string.', 'Pass a declared page type such as conversation or meeting.');
    }
    if (p.title !== undefined && (typeof p.title !== 'string' || p.title.trim().length === 0 || p.title.length > 300 || /[\r\n]/.test(p.title))) {
      throw new OperationError('invalid_params', 'patch_page title must be a single non-empty line of at most 300 characters.', 'Pass the full new title as one line.');
    }
    const patch: SparsePagePatch = {
      ...(typeof p.type === 'string' ? { type: p.type } : {}),
      ...(typeof p.title === 'string' ? { title: p.title.trim() } : {}),
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
      params: { ...p, ...patch, request_id: requestId, source_id: sourceId },
    });
    return { ...result, resumed: prior?.state === 'committed' };

  },
  cliHints: { name: 'patch-page', positional: ['slug'] },
};
