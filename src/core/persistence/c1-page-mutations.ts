/** C1 metadata patches and typed interaction appends in the canonical coordinator. */
import type { BrainEngine } from '../engine.ts';
import { applyCanonicalInteractionEvent } from '../canonical-page-events.ts';
import { importFromContent } from '../import-file.ts';
import type { PreparedContentImport } from './prepared-import.ts';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { OperationError } from '../ops/contract.ts';
import { assertC1CreateAdmissible, isC1ContainmentEnabled, isC1RevisionGuardEnabled } from '../ops/pages-c1.ts';
import { applySparsePagePatch, CanonicalMutationError, exactCanonicalRevision, readCanonicalPage, type SparsePagePatch } from '../canonical-page-mutations.ts';
import { parseMarkdown, type ParseOpts } from '../markdown.ts';
import { GATE_OWNED_FRONTMATTER_KEYS } from '../import-screen.ts';
import { loadActivePackForEngine } from '../schema-pack/engine-resolution.ts';
import { sealPageTextProjection } from '../page-state/projections.ts';
import { prepareFileTarget } from './page-prepare.ts';
import { prepareCoreGuard } from './core-guard.ts';
import { withTrustKeep } from './context.ts';
import type { WriteRequest } from './model.ts';
import type { PreparedMutation } from './coordinator.ts';

export async function assertC1PageAdmission(engine: BrainEngine, sourceId: string, slug: string, content: string, pack?: ParseOpts['activePack']): Promise<void> {
  const containment = await isC1ContainmentEnabled(engine);
  if (!containment && !await isC1RevisionGuardEnabled(engine)) return;
  const [page, canonical] = await Promise.all([
    engine.getPage(slug, { sourceId }),
    readCanonicalPage(engine, slug, sourceId).catch(error => {
      if (error instanceof CanonicalMutationError && error.code === 'canonical_unavailable') return null;
      throw error;
    }),
  ]);
  if (page || canonical?.exists) throw new OperationError('revision_required',
    `C1 blocks whole-page replacement of existing page '${slug}'.`,
    'Read get_page and use patch_page with canonical_revision as base_revision.');
  if (containment) assertC1CreateAdmissible(content, slug, pack);
}

/** Repeat the C1 admission gate for ordinary whole-page writes at preparation. */
export async function assertC1PreparedPageAdmission(engine: BrainEngine, row: WriteRequest, pack?: ParseOpts['activePack']): Promise<void> {
  if (row.operation === 'capture' || row.operation === 'put_page' && row.intent?.kind === undefined) {
    await assertC1PageAdmission(engine, row.source_id, row.slug, row.intent!.content as string, pack);
  }
}

export async function prepareC1PagePatch(engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  if (!row.intent) throw new OperationError('storage_error', 'Patch intent is missing.');
  const append = row.operation === 'append_page_event';
  const sourceId = row.source_id;
  const slug = row.slug;
  if (/^(false|0|off|no)$/i.test(await engine.getConfig('sync.write_through') ?? 'true')) {
    throw new OperationError('unavailable', 'patch_page requires canonical write-through.');
  }
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  if (!snapshot || snapshot.page.deleted_at) throw new OperationError('page_not_found', `Page not found: ${slug}`);
  const pack = await loadActivePackForEngine(engine, { sourceId, remote: row.authority.remote });
  if (!pack) throw new OperationError('unavailable', 'The schema pack required to protect derived fields is unavailable.');
  // prepareFileTarget resolves the owner's recorded path and enforces mirror,
  // confinement, held-file and file/database drift rules before we read bytes.
  const target = await prepareFileTarget(engine, row, snapshot, '', undefined, { activePack: pack.manifest, remote: row.authority.remote });
  if (!target) throw new OperationError('unavailable', 'patch_page requires an owned canonical Markdown file.');
  const before = readFileSync(target.path, 'utf8');
  if (!append && exactCanonicalRevision(before) !== row.intent.base_revision) throw new OperationError('revision_conflict',
    'The canonical page changed since base_revision was read.', 'Read get_page again and retry against its canonical_revision.');
  const derived = new Set(['trust_tier', ...GATE_OWNED_FRONTMATTER_KEYS,
    ...pack.manifest.frontmatter_links.filter(rule => rule.page_type === snapshot.page.type).flatMap(rule => rule.fields)]);
  let content: string;
  try { content = append
    ? applyCanonicalInteractionEvent(before, slug, { date: row.intent.date as string, channel: row.intent.channel as string,
        note: row.intent.note as string, eventToken: row.intent.event_token as string })
    : applySparsePagePatch(before, slug, row.intent as SparsePagePatch, derived); }
  catch (error) {
    if (error instanceof CanonicalMutationError) throw new OperationError('invalid_params', error.message);
    throw error;
  }
  const parsed = parseMarkdown(content, `${slug}.md`, { validate: true, expectedSlug: slug, activePack: pack.manifest });
  if (parsed.errors?.length) throw new OperationError('invalid_params', 'Patched canonical Markdown failed validation.');
  const core = await prepareCoreGuard(engine, { row, snapshot, incoming: parsed });
  const revision = exactCanonicalRevision(content);
  let imported: PreparedContentImport | undefined;
  if (append) {
    await importFromContent(engine, slug, content, { sourceId, noEmbed: true, forceRechunk: true,
      preserveGateMarkers: true, activePack: pack.manifest, fences: 'coordinated',
      prepare: async ready => { imported = ready; return ready.result; } });
    if (!imported) throw new OperationError('invalid_params', 'Interaction projection could not be prepared.');
  }
  return {
    observedRevision: snapshot.revision,
    file: { ...target, content },
    ...(core ? { exclusiveSources: core.exclusiveSources } : {}),
    validate: async tx => {
      if (/^(false|0|off|no)$/i.test(await tx.getConfig('sync.write_through') ?? 'true')) {
        throw new OperationError('unavailable', 'Canonical write-through was disabled before publication.');
      }
      if (append && !/^(true|1|on|yes)$/i.test(await tx.getConfig('writer.append_page_event') ?? 'false')) {
        throw new OperationError('unavailable', 'append_page_event was disabled before publication.');
      }
      await imported?.validate(tx);
      await core?.validate(tx);
    },
    apply: async tx => {
      if (imported) await withTrustKeep(tx, ['pages'], () => imported!.apply(tx));
      else {
        await tx.createVersion(slug, { sourceId });
        // A metadata patch preserves the canonical body's trust and protected rows.
        await withTrustKeep(tx, ['pages'], () => tx.putPage(slug, {
          type: parsed.type, title: parsed.title, compiled_truth: parsed.compiled_truth,
          timeline: parsed.timeline, frontmatter: parsed.frontmatter, tags: parsed.tags,
        }, { sourceId }));
      }
      const projected = await tx.getPage(slug, { sourceId });
      const fields = (page: { type: string; title: string; compiled_truth: string; timeline?: string; frontmatter: unknown }) =>
        JSON.parse(JSON.stringify({ type: page.type, title: page.title, compiled_truth: page.compiled_truth,
          timeline: page.timeline ?? '', frontmatter: page.frontmatter }));
      if (!projected || !isDeepStrictEqual(fields(projected), fields(parsed))) {
        throw new Error('Canonical patch projection did not match the accepted Markdown.');
      }
      if (append) {
        const tags = new Set(await tx.getTags(slug, { sourceId }));
        const chunks = await tx.getChunks(slug, { sourceId });
        if (!parsed.tags.every(tag => tags.has(tag))
          || !chunks.some(chunk => chunk.chunk_text.includes(row.intent!.event_token as string))) {
          throw new Error('Canonical interaction tags or content chunks did not match the accepted Markdown.');
        }
      }
      await sealPageTextProjection(tx, slug, sourceId);
      const final = await tx.readPageSnapshot(slug, { sourceId });
      await core?.record(tx, final?.revision ?? null);
      if (append) {
        const receipt = { receipt_version: 2, receipt_id: row.intent!.event_token,
          principal_id: row.intent!.principal_id, operation: row.operation, source_id: sourceId, slug,
          idempotency_key: row.intent!.idempotency_key, request_hash: row.digest,
          base_revision: exactCanonicalRevision(before), canonical_revision: revision,
          projected_revision: revision, committed_at: new Date().toISOString() };
        return { status: 'appended', slug, source_id: sourceId, projection_state: 'current', receipt };
      }
      return { status: 'patched', slug, source_id: sourceId, canonical_revision: revision, projected_revision: revision, projection_state: 'current' };
    },
  };
}
