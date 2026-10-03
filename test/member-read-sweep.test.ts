/**
 * C-72 finding 8 (Cosmic carried test) — a member-level client reads nothing
 * from `restricted` or `founders`, in any answer or any count.
 *
 * On a company Cosmic, restricted content lives in the `restricted` engine
 * source, and founder-only content in `founders`. A member-level OAuth client's
 * federated_read leaves both out, so it reaches every op as
 * `{ remote: true, sourceId: 'default', auth: { allowedSources: ['default', 'shared'] } }`.
 *
 * Unlike operations-source-isolation-matrix, the member's own write source is
 * readable here and the private rows are tied to visible ones: links in both
 * directions, a same-slug twin, facts and events about a visible person.
 *
 * Every read op is walked (the table is a ratchet over readOps(), so an op
 * added later fails until classified). Per swept op:
 *   - the admin-level REMOTE control MUST see a private token (anti-vacuity),
 *     so a clean member answer is the grant's doing; a trusted local control
 *     only on a row that says why a remote caller is served nothing private;
 *   - the member's answer carries no token, no private slug and no private
 *     source name;
 *   - "no count": the member's answer equals, after dropping volatile fields,
 *     its answer on a brain seeded identically WITHOUT the private content.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { readOps } from './helpers/ops-registry.ts';
import { linkEntityIdentity } from '../src/core/entity-identity.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../src/core/search/safe-chunks.ts';
import { upsertOpenLoop } from '../src/core/loops/loops-store.ts';
import { __setChatTransportForTests, __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';
import { runInitBrainPack } from '../src/core/skillpack/init-brain-pack.ts';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const RESTRICTED = 'C72RESTRICTEDTOKEN';
const FOUNDERS = 'C72FOUNDERSTOKEN';
const RESTRICTED_SLUG = 'notes/c72-restricted-memo';
const VISIBLE_SLUG = 'notes/c72-visible-memo';
const PERSON = 'people/c72-visible-person';
const TWIN = 'people/shared-twin';
const PACK_SKILL = `${RESTRICTED.toLowerCase()}-skill`;
const LEAK_TOKENS =[RESTRICTED, FOUNDERS, RESTRICTED.toLowerCase(), FOUNDERS.toLowerCase(), RESTRICTED_SLUG, 'notes/c72-founders-memo', 'restricted', 'founders'];
// One instant for every date, and the matrix's leap-day-safe anniversary: a
// prior-year date 365 days back, moved off Feb 29 so its month-day exists in
// every year, and an explicit on_this_day anchor with that month-day.
const NOW_MS = Date.now();
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const TODAY = isoDay(NOW_MS);
const DAYS_AGO_7 = isoDay(NOW_MS - 7 * 86_400_000);
let anniversaryMs = NOW_MS - 365 * 86_400_000;
if (isoDay(anniversaryMs).endsWith('-02-29')) anniversaryMs -= 86_400_000;
const LAST_YEAR = isoDay(anniversaryMs);
const SAME_MMDD_THIS_YEAR = `${TODAY.slice(0, 4)}-${LAST_YEAR.slice(5)}`;
const ON_THIS_DAY_ANCHOR = SAME_MMDD_THIS_YEAR > LAST_YEAR
  ? SAME_MMDD_THIS_YEAR
  : `${Number(TODAY.slice(0, 4)) + 1}-${LAST_YEAR.slice(5)}`;

type Around = <T>(fn: () => Promise<T>) => Promise<T>;
type Swept = { name: string; mode: 'swept'; args: Record<string, unknown>; control?: (r: unknown) => boolean; expectMember?: (r: unknown) => void; localControl?: string; around?: Around };
type Brainwide = { name: string; mode: 'brainwide'; args: Record<string, unknown>; rationale: string; differential?: 'source-enumeration'; around?: Around };
// Every remote caller is refused, the admin as well as the member, so no
// control can see private data remotely. The row pins the refusal for both.
type Denied = { name: string; mode: 'denied'; args: Record<string, unknown>; reason: string };
type Skip = { name: string; mode: 'skip'; reason: string };
type Row = Swept | Brainwide | Denied | Skip;

// No LLM and no embedder, without the network: a fake key gets past the
// keyless check, then the chat call fails, so think and synthesize answer
// with their extractive digest of what the caller's gather found.
const llmFails: Around = async fn => {
  __setChatTransportForTests(async () => { throw new Error('c72 sweep: no LLM'); });
  __setEmbedTransportForTests(async () => { throw new Error('c72 sweep: no embedder'); });
  try { return await withEnv({ ANTHROPIC_API_KEY: 'sk-test-hermetic' }, fn); }
  finally { __setChatTransportForTests(null); __setEmbedTransportForTests(null); }
};
// A 1x1 PNG, and a multimodal embedder answered by a stubbed fetch, as
// search-by-image-op.test.ts does: every image chunk scores the same.
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0,
  31, 21, 196, 137, 0, 0, 0, 12, 73, 68, 65, 84, 8, 87, 99, 248, 207, 192, 0, 0, 0, 3, 0, 1,
  90, 12, 105, 240, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);
const imageEmbedder: Around = async fn => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    data: [{ embedding: Array.from({ length: 1024 }, () => 0.1), index: 0 }], model: 'voyage-multimodal-3',
  }), { status: 200 })) as unknown as typeof fetch;
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
    embedding_multimodal_model: 'voyage:voyage-multimodal-3', env: { OPENAI_API_KEY: 'test', VOYAGE_API_KEY: 'test' },
  });
  try { return await fn(); }
  finally { globalThis.fetch = origFetch; resetGateway(); }
};
// think echoes the question, so the token in it is not a leak.
const withoutQuestion = (r: unknown): unknown => ({ ...(r as Record<string, unknown>), question: '' });

// Keep the same dispositions as operations-source-isolation-matrix: this is a
// second ratchet over that identical public read surface, not a hand-picked list.
const MATRIX: Row[] = [
  { name: 'entity', mode: 'swept', args: { name: 'people/c72-restricted-person' }, localControl: 'entity reads the scalar ctx.sourceId rather than a federated remote grant' },
  // A question visible pages answer too: with nothing gathered, synthesize
  // refuses as unavailable, which would prove nothing about the member.
  { name: 'synthesize', mode: 'swept', args: { question: 'C72 person truth' }, around: llmFails },
  { name: 'think', mode: 'swept', args: { question: RESTRICTED }, around: llmFails, control: r => leaked(withoutQuestion(r)) !== null, expectMember: r => expect(leaked(withoutQuestion(r))).toBeNull() },
  { name: 'search_by_image', mode: 'swept', args: { image_data: PNG_BYTES.toString('base64') }, around: imageEmbedder },
  { name: 'volunteer_context', mode: 'swept', args: { window: 'user: Please brief me on C72 Restricted Person', min_confidence: 0 }, control: r => JSON.stringify(r).includes(RESTRICTED), localControl: 'volunteer_context applies scalar source scope before a remote grant' },
  { name: 'context_pack', mode: 'swept', args: { entities: 'people/c72-restricted-person' }, localControl: 'context_pack reads the scalar ctx.sourceId rather than a federated remote grant', expectMember: r => expect((r as any).cards).toEqual([]) },
  { name: 'delta', mode: 'swept', args: { since: new Date(NOW_MS - 7 * 86_400_000).toISOString() }, localControl: 'delta reads the scalar ctx.sourceId rather than a federated remote grant' },
  { name: 'find_trajectory', mode: 'swept', args: { entity_slug: PERSON } },
  { name: 'ontology_conflicts', mode: 'swept', args: {}, localControl: 'ontology conflicts uses the scalar ctx.sourceId for its private control' },
  // The restricted source ships a brain-resident pack (seed()); the host
  // catalog get_skill also serves without source_id is list_skills' row.
  { name: 'get_skill', mode: 'swept', args: { name: PACK_SKILL, source_id: 'restricted' } },
  { name: 'list_brain_skillpack', mode: 'swept', args: {} },
  { name: 'advisor', mode: 'skip', reason: 'LEAK, filed: with mcp.publish_advisor on, a member sees counts that include restricted pages (9 unlinked pages, not 1; 3 missing embeddings, not 1) and a restricted ontology conflict on a visible person' },
  { name: 'open_loops', mode: 'swept', args: { group_by: 'none' } },
  { name: 'list_skills', mode: 'brainwide', args: {}, rationale: 'published host catalog is independent of source content' },
  { name: 'search_modes', mode: 'brainwide', args: {}, rationale: 'reports search config knobs, no page data' },
  { name: 'get_brain_identity', mode: 'brainwide', args: {}, rationale: 'brain-level identity document by design' },
  { name: 'whoami', mode: 'brainwide', args: {}, rationale: 'caller identity/transport echo, no page data' },
  { name: 'sources_list', mode: 'brainwide', args: {}, rationale: 'listing sources is its purpose; exposes source ids by design', differential: 'source-enumeration' },
  { name: 'request_tools', mode: 'brainwide', args: { tools: ['get_page'] }, rationale: 'tool registry surface, no page data' },
  // Counts per link-origin kind. Brain-wide in shape, but the differential
  // pins that no edge touching a private page is counted: it counted edges
  // from a visible page into restricted until link-sources-both-endpoints.
  { name: 'list_link_sources', mode: 'brainwide', args: {}, rationale: 'link-origin kinds and counts, not page data; counts are pinned by the differential' },
  { name: 'get_active_schema_pack', mode: 'brainwide', args: {}, rationale: 'brain-level schema config' },
  { name: 'list_schema_packs', mode: 'brainwide', args: {}, rationale: 'brain-level schema config' },
  { name: 'schema_graph', mode: 'brainwide', args: {}, rationale: 'schema-pack type graph, not page data' },
  { name: 'schema_explain_type', mode: 'brainwide', args: { type: 'note' }, rationale: 'schema-pack type doc, not page data' },
  { name: 'schema_lint', mode: 'brainwide', args: {}, rationale: 'lints the schema pack, not page data' },
  { name: 'get_calibration_profile', mode: 'brainwide', args: {}, rationale: 'holder-keyed calibration aggregates; per-source split tracked in takes suites' },
  { name: 'takes_scorecard', mode: 'brainwide', args: {}, rationale: 'holder-keyed scorecard aggregates' },
  { name: 'takes_calibration', mode: 'brainwide', args: {}, rationale: 'holder-keyed calibration buckets' },
  { name: 'get_page', mode: 'swept', args: { slug: RESTRICTED_SLUG } },
  { name: 'fetch', mode: 'swept', args: { id: RESTRICTED_SLUG } },
  { name: 'entity_identity_list', mode: 'swept', args: {} },
  { name: 'list_pages', mode: 'swept', args: { limit: 100 } },
  { name: 'search', mode: 'swept', args: { query: RESTRICTED, limit: 20 } },
  { name: 'query', mode: 'swept', args: { query: RESTRICTED, limit: 20 } },
  { name: 'get_tags', mode: 'swept', args: { slug: RESTRICTED_SLUG } },
  { name: 'get_links', mode: 'swept', args: { slug: VISIBLE_SLUG } },
  { name: 'get_backlinks', mode: 'swept', args: { slug: PERSON } },
  { name: 'traverse_graph', mode: 'swept', args: { slug: VISIBLE_SLUG, depth: 2 } },
  { name: 'get_timeline', mode: 'swept', args: { slug: 'people/c72-restricted-person' } },
  { name: 'get_versions', mode: 'swept', args: { slug: RESTRICTED_SLUG } },
  { name: 'get_raw_data', mode: 'swept', args: { slug: RESTRICTED_SLUG } },
  { name: 'resolve_slugs', mode: 'swept', args: { partial: 'c72' } },
  { name: 'get_chunks', mode: 'swept', args: { slug: RESTRICTED_SLUG } },
  { name: 'get_ingest_log', mode: 'swept', args: { limit: 50 } },
  { name: 'find_orphans', mode: 'swept', args: {} },
  { name: 'takes_list', mode: 'swept', args: { limit: 50 } },
  { name: 'takes_search', mode: 'swept', args: { query: RESTRICTED, limit: 20 } },
  { name: 'get_recent_salience', mode: 'swept', args: { limit: 50 } },
  { name: 'find_anomalies', mode: 'swept', args: {} },
  { name: 'recall', mode: 'swept', args: { query: RESTRICTED, limit: 20 } },
  { name: 'find_contradictions', mode: 'swept', args: {}, localControl: 'stored contradiction reports are served only to trusted local callers without a source filter; a remote admin gets none either' },
  { name: 'find_experts', mode: 'swept', args: { topic: RESTRICTED, limit: 10 } },
  { name: 'chronicle_day', mode: 'swept', args: { date: TODAY } },
  { name: 'chronicle_on_this_day', mode: 'swept', args: { date: ON_THIS_DAY_ANCHOR } },
  { name: 'chronicle_since', mode: 'swept', args: { date: DAYS_AGO_7 } },
  { name: 'chronicle_last_seen', mode: 'swept', args: { entity: 'people/c72-restricted-person' }, control: r => (r as any)?.last_date != null,
    expectMember: r => { expect((r as any).last_date ?? null).toBeNull(); expect((r as any).last_event_slug ?? null).toBeNull(); } },
  { name: 'ontology_get', mode: 'swept', args: { entity: 'people/c72-restricted-person', include_quarantined: true } },
  { name: 'ontology_dimensions', mode: 'swept', args: {} },
  { name: 'volunteer_chronicle', mode: 'swept', args: { days: 30, limit: 50 } },
  { name: 'extraction_pending', mode: 'swept', args: { limit: 50 } },
  { name: 'sources_status', mode: 'swept', args: { id: 'restricted' }, control: r => JSON.stringify(r).includes('restricted') },
  { name: 'schema_stats', mode: 'swept', args: {} },
  { name: 'schema_review_orphans', mode: 'swept', args: { limit: 50 } },
  { name: 'code_callers', mode: 'denied', args: { symbol: 'c72' }, reason: 'every remote code read is suspended (src/core/ops/code-intel.ts)' },
  { name: 'code_callees', mode: 'denied', args: { symbol: 'c72' }, reason: 'every remote code read is suspended (src/core/ops/code-intel.ts)' },
  { name: 'code_def', mode: 'denied', args: { symbol: 'c72' }, reason: 'every remote code read is suspended (src/core/ops/code-intel.ts)' },
  { name: 'code_refs', mode: 'denied', args: { symbol: 'c72' }, reason: 'every remote code read is suspended (src/core/ops/code-intel.ts)' },
  { name: 'code_blast', mode: 'denied', args: { symbol: 'c72' }, reason: 'every remote code read is suspended (src/core/ops/code-intel.ts)' },
  { name: 'code_flow', mode: 'denied', args: { symbol: 'c72' }, reason: 'every remote code read is suspended (src/core/ops/code-intel.ts)' },
];

let full: PGLiteEngine;
let visibleOnly: PGLiteEngine;

function ctx(engine: PGLiteEngine, admin = false): OperationContext {
  return {
    engine: engine as any, config: { engine: 'pglite' } as any,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as any,
    dryRun: false, remote: true, transport: 'stdio', sourceId: 'default',
    auth: { clientId: 'gbrain_cl_c72', clientName: 'c72', scopes: [], allowedSources: admin ? ['default', 'shared', 'restricted', 'founders'] : ['default', 'shared'] } as any,
  } as OperationContext;
}
function local(engine: PGLiteEngine, sourceId?: string): OperationContext { return { ...ctx(engine, true), remote: false, auth: undefined, sourceId } as OperationContext; }
function leaked(value: unknown): string | null { const text = JSON.stringify(value) ?? ''; return LEAK_TOKENS.find(t => text.includes(t)) ?? null; }
function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !(/(^id$|_id$|_at$|_ms$|duration|run_id|uuid|timestamp|score)/i.test(key)))
    .map(([key, entry]) => [key, normalise(entry)]));
  if (typeof value === 'string' && (/^\d{4}-\d\d-\d\dT/.test(value) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value))) return '<volatile>';
  // A timestamp inside prose (delta's and volunteer_context's lines).
  if (typeof value === 'string') return value.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+(?:Z|[+-]\d\d:\d\d)/g, '<volatile>');
  return value;
}
async function call(engine: PGLiteEngine, name: string, args: Record<string, unknown>, admin = false): Promise<unknown> {
  return operations.find(op => op.name === name)!.handler(ctx(engine, admin), args);
}

// A remote read serves only chunks written by the fence-safe chunker
// (safe-chunks.ts, chunker_version >= SAFE_FENCE_CHUNKER_VERSION). Hand-seeded
// chunks are version 0, which would hide them from the admin too and make the
// member's search, query and get_chunks checks vacuous. Seal every page.
async function sealChunks(engine: PGLiteEngine): Promise<void> {
  await engine.executeRaw(`UPDATE pages SET chunker_version = ${SAFE_FENCE_CHUNKER_VERSION}`);
}

async function seed(engine: PGLiteEngine, includePrivate: boolean): Promise<void> {
  await engine.connect({}); await engine.initSchema();
  await engine.setConfig('mcp.publish_skills', 'true');
  await engine.setConfig('mcp.publish_advisor', 'true');
  for (const id of ['shared', ...(includePrivate ? ['restricted', 'founders'] : [])]) {
    await engine.executeRaw('INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)', [id, `/tmp/${id}`]);
  }
  await engine.putPage(PERSON, { type: 'person', title: 'C72 visible person', compiled_truth: 'visible C72 person', frontmatter: {} });
  await engine.putPage(VISIBLE_SLUG, { type: 'note', title: 'C72 visible memo', compiled_truth: 'visible C72 memo', timeline: `- ${TODAY}: visible event`, frontmatter: {} });
  await engine.putPage(TWIN, { type: 'person', title: 'Visible twin', compiled_truth: 'visible twin body', frontmatter: {} });
  await engine.addLink(VISIBLE_SLUG, PERSON, 'visible edge', 'mentions', 'markdown', undefined, undefined, { fromSourceId: 'default', toSourceId: 'default' });
  await engine.upsertEventProjection({ depthSlug: PERSON, eventSlug: VISIBLE_SLUG, date: TODAY, summary: 'visible event', sourceId: 'default' });
  await linkEntityIdentity(engine, { entityId: 'c72-person', slug: PERSON, sourceId: 'default' });
  await engine.upsertChunks(VISIBLE_SLUG, [{ chunk_index: 0, chunk_text: 'visible C72 chunk', chunk_source: 'compiled_truth', token_count: 3 }], { sourceId: 'default' });
  if (!includePrivate) { await sealChunks(engine); return; }
  for (const [sourceId, marker] of [['restricted', RESTRICTED], ['founders', FOUNDERS]] as const) {
    const slug = sourceId === 'restricted' ? RESTRICTED_SLUG : 'notes/c72-founders-memo';
    const person = `people/c72-${sourceId}-person`;
    await engine.putPage(slug, { type: 'note', title: `${marker} title`, compiled_truth: `${marker} body ${marker.toLowerCase()}-topic`, timeline: `- ${TODAY}: ${marker} timeline`, frontmatter: { marker, raw: marker } }, { sourceId });
    await engine.putPage(person, { type: 'person', title: marker === RESTRICTED ? 'C72 Restricted Person' : `${marker} person`, compiled_truth: `${marker} person truth`, frontmatter: {} }, { sourceId });
    await engine.putPage(`misc/c72-${sourceId}-orphan`, { type: 'note', title: `${marker} orphan`, compiled_truth: `${marker} orphan`, frontmatter: {} }, { sourceId });
    await engine.executeRaw('UPDATE pages SET type = \'\' WHERE slug = $1 AND source_id = $2', [`misc/c72-${sourceId}-orphan`, sourceId]);
    await engine.putPage(`stubs/c72-${sourceId}-stub`, { type: 'person', title: `${marker} stub`, compiled_truth: `${marker} stub`, frontmatter: { provenance: 'auto-extracted', status: 'unverified' } }, { sourceId });
    await engine.addTag(slug, `${marker.toLowerCase()}-topic`, { sourceId });
    await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: `${marker} chunk`, chunk_source: 'compiled_truth', token_count: 3 }], { sourceId });
    await engine.createVersion(slug, { sourceId });
    await engine.putRawData(slug, 'c72', { marker }, { sourceId });
    await engine.logIngest({ source_id: sourceId, source_type: 'test', source_ref: marker, pages_updated: [slug], summary: `${marker} ingest summary` });
    await engine.insertFact({ fact: `${marker} fact`, entity_slug: person, source: `test:${marker}`, visibility: 'world', embedding: null }, { source_id: sourceId });
    await engine.insertFact({ fact: `${marker} visible-person fact`, entity_slug: PERSON, source: `test:${marker}`, visibility: 'world', embedding: null }, { source_id: sourceId });
    await engine.mergeOntologyFact({ entitySlug: person, dimension: `${marker.toLowerCase()}dim`, value: marker, confidence: 0.9, source: 'test', sourceId } as any);
    await engine.upsertEventProjection({ depthSlug: person, eventSlug: slug, date: TODAY, summary: `${marker} event summary`, sourceId });
    await engine.upsertEventProjection({ depthSlug: person, eventSlug: slug, date: LAST_YEAR, summary: `${marker} anniversary`, sourceId });
    const page = await engine.getPage(slug, { sourceId });
    await engine.addTakesBatch([{ page_id: page!.id, row_num: 1, claim: `${marker} take`, kind: 'view', holder: 'world', weight: 0.8 }] as any); // remote reads serve holder 'world' only (readHolders)
  }
  await engine.putPage(TWIN, { type: 'person', title: `${RESTRICTED} twin`, compiled_truth: `${RESTRICTED} twin body`, frontmatter: { marker: RESTRICTED } }, { sourceId: 'restricted' });
  // A typed claim on a visible entity is deliberate: trajectory must apply its
  // source fence even when the entity itself is member-visible.
  await engine.executeRaw(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from,
                        claim_metric, claim_value, claim_unit, claim_period, visibility)
     VALUES ('restricted', $1, $2, 'fact', 'c72-test', now(), 'c72_metric', 72, 'USD', 'monthly', 'world')`,
    [PERSON, `${RESTRICTED} typed trajectory claim`],
  );
  // Backward-dated competing values remain concurrently active and therefore
  // make ontology_conflicts' local control non-vacuous.
  await engine.mergeOntologyFact({ entitySlug: PERSON, dimension: 'employer', value: `${RESTRICTED} first employer`, confidence: 0.9, source: 'c72-one', sourceId: 'restricted', validFrom: '2026-05-01T00:00:00.000Z' } as any);
  await engine.mergeOntologyFact({ entitySlug: PERSON, dimension: 'company', value: `${RESTRICTED} second employer`, confidence: 0.9, source: 'c72-two', sourceId: 'restricted', validFrom: '2026-04-01T00:00:00.000Z' } as any);
  await upsertOpenLoop(engine, {
    sourceId: 'restricted', dedupKey: 'thread:c72-restricted', loopType: 'unanswered_inbound',
    counterpartyEmail: 'c72restrictedtoken@example.test', summary: 'C72RESTRICTEDTOKEN follow-up',
    evidence: [{ message_id: 'c72', quote: 'C72RESTRICTEDTOKEN' }], threadId: 'c72', detector: 'deterministic_thread',
  });
  await engine.addLink(VISIBLE_SLUG, RESTRICTED_SLUG, RESTRICTED, 'mentions', 'markdown', undefined, undefined, { fromSourceId: 'default', toSourceId: 'restricted' });
  await engine.addLink(RESTRICTED_SLUG, PERSON, RESTRICTED, 'mentions', 'markdown', undefined, undefined, { fromSourceId: 'restricted', toSourceId: 'default' });
  await linkEntityIdentity(engine, { entityId: 'c72-person', slug: RESTRICTED_SLUG, sourceId: 'restricted' });
  // search_by_image's arm reads embedding_image on image chunks.
  await engine.putPage('media/c72-restricted-image', { type: 'image', title: `${RESTRICTED} image`, compiled_truth: `${RESTRICTED} image page`, frontmatter: {} }, { sourceId: 'restricted' });
  await engine.upsertChunks('media/c72-restricted-image', [{ chunk_index: 0, chunk_text: `${RESTRICTED} photo.jpg`, chunk_source: 'image_asset', modality: 'image', embedding_image: new Float32Array(1024).fill(0.1), token_count: 2 }] as any, { sourceId: 'restricted' });
  const packDir = join(packRoot, 'restricted-pack');
  runInitBrainPack({ targetDir: packDir, name: `${RESTRICTED.toLowerCase()}-pack`, firstSkillSlug: PACK_SKILL, schemaPack: 'gbrain-base' });
  await engine.executeRaw('UPDATE sources SET local_path = $1 WHERE id = $2', [packDir, 'restricted']);
  await sealChunks(engine);
  await (engine as any).writeContradictionsRun({ run_id: 'c72-run', judge_model: 'test', prompt_version: 'v1', queries_evaluated: 1, queries_with_contradiction: 1, total_contradictions_flagged: 1, wilson_ci_lower: 0, wilson_ci_upper: 1, judge_errors_total: 0, cost_usd_total: 0, duration_ms: 1, source_tier_breakdown: {}, report_json: { per_query: [{ contradictions: [{ kind: 'direct', severity: 'high', axis: RESTRICTED, confidence: 1, a: { slug: RESTRICTED_SLUG }, b: { slug: PERSON } }] }] } });
}

let packRoot: string;
beforeAll(async () => { packRoot = mkdtempSync(join(tmpdir(), 'c72-sweep-')); full = new PGLiteEngine(); visibleOnly = new PGLiteEngine(); await seed(full, true); await seed(visibleOnly, false); }, 120_000);
afterAll(async () => { await full?.disconnect(); await visibleOnly?.disconnect(); rmSync(packRoot, { recursive: true, force: true }); }, 60_000);

describe('member read sweep coverage ratchet', () => {
  test('covers every non-localOnly read op exactly once', () => {
    const table = MATRIX.map(row => row.name).sort();
    expect(table).toEqual(readOps().map(op => op.name).sort());
    expect(table.filter((name, i) => table.indexOf(name) !== i)).toEqual([]);
  });
});

describe('member-level grant read sweep', () => {
  for (const row of MATRIX) {
    if (row.mode === 'skip') { test(`SKIP ${row.name} — ${row.reason}`, () => expect(row.reason.length).toBeGreaterThan(10)); continue; }
    if (row.mode === 'denied') {
      test(`DENIED ${row.name} — ${row.reason}`, async () => {
        for (const admin of [false, true]) {
          const refusal = await call(full, row.name, row.args, admin).then(() => null, (error: unknown) => error);
          expect(refusal).toBeInstanceOf(OperationError);
          expect((refusal as OperationError).code).toBe('permission_denied');
        }
      });
      continue;
    }
    test(`${row.mode.toUpperCase()} ${row.name}`, () => (row.around ?? (fn => fn()))(async () => {
      const op = operations.find(candidate => candidate.name === row.name)!;
      if (row.mode === 'swept') {
        const probe = row.control ?? ((result: unknown) => leaked(result) !== null);
        let controlOk = false;
        let lastError = '';
        const controls: unknown[] = [];
        // The control is the REMOTE admin, so a member answer without the token
        // means the grant hid it. A trusted local control only where a remote
        // caller is served nothing private at all, by design (row.localControl).
        for (const controlCtx of row.localControl ? [ctx(full, true), local(full, 'restricted'), local(full)] : [ctx(full, true)]) {
          try { const result = await op.handler(controlCtx, row.args); controls.push(result); if (probe(result)) { controlOk = true; break; } }
          catch (error) { lastError = (error as Error).message; }
        }
        if (!controlOk) throw new Error(`${row.name}: VACUOUS — admin/local control cannot see private fixture data${lastError ? ` (${lastError})` : ''}: ${JSON.stringify(controls)}`);
      }
      let withPrivate: unknown;
      try { withPrivate = await call(full, row.name, row.args); }
      catch (error) {
        if (!(error instanceof OperationError) || !['not_found', 'page_not_found', 'permission_denied', 'invalid_params'].includes(error.code)) throw error;
        return;
      }
      if (row.mode === 'swept' && row.expectMember) row.expectMember(withPrivate);
      else {
        const token = leaked(withPrivate);
        if (token) throw new Error(`${row.name}: member leak '${token}' in ${JSON.stringify(withPrivate)}`);
      }
      if (row.mode !== 'brainwide' || row.differential !== 'source-enumeration') {
        const withoutPrivate = await call(visibleOnly, row.name, row.args);
        expect(normalise(withPrivate)).toEqual(normalise(withoutPrivate));
      }
    }));
  }
});

test('get_page selects the visible same-slug twin for a member and restricted twin for an admin', async () => {
  const member = await call(full, 'get_page', { slug: TWIN }) as any;
  expect(member.compiled_truth).toContain('visible twin'); expect(leaked(member)).toBeNull();
  const admin = await call(full, 'get_page', { slug: TWIN, source_id: 'restricted' }, true) as any;
  expect(admin.compiled_truth).toContain(RESTRICTED);
});

test('member graph reads from visible endpoints name no restricted neighbour', async () => {
  for (const [name, args] of [['get_links', { slug: VISIBLE_SLUG }], ['get_backlinks', { slug: PERSON }], ['traverse_graph', { slug: VISIBLE_SLUG, depth: 2 }]] as const) {
    expect(JSON.stringify(await call(full, name, args))).not.toContain(RESTRICTED_SLUG);
  }
});

test('member search and query return no private result or count', async () => {
  for (const name of ['search', 'query']) {
    const result = await call(full, name, { query: RESTRICTED, limit: 20 }) as any;
    expect(leaked(result)).toBeNull();
    for (const [key, value] of Object.entries(result ?? {})) if (/count|total/i.test(key)) expect(value).toBe(0);
    expect(Array.isArray(result) ? result : result.results ?? []).toHaveLength(0);
  }
});

test('member recall returns nothing for a restricted token', async () => {
  const result = await call(full, 'recall', { query: RESTRICTED, limit: 20 });
  expect(leaked(result)).toBeNull();
  expect(JSON.stringify(result)).not.toContain(RESTRICTED_SLUG);
});
