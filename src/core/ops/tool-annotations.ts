/**
 * MCP ToolAnnotations for every operation (Synchromy/cosmic-hub#707).
 *
 * A connector directory review requires each tool to carry a `title` and the
 * hint that applies: `readOnlyHint: true` on a tool that only reads, and
 * `destructiveHint: true` on a tool that deletes or irreversibly overwrites
 * data. Before this, 8 of ~140 ops carried annotations at all.
 *
 * One central table, applied to the op objects in operations.ts the same way
 * OP_AREAS sets `area`, rather than an inline field on every op: the ops live
 * in some thirty modules that upstream edits every release, and a carried
 * patch touching each of them would conflict on most rebuilds.
 *
 * What is derived and what is declared:
 *   - readOnlyHint comes from the op's own `mutating` flag, so a new or
 *     changed op cannot drift from it. WRITES_WITHOUT_MUTATING_FLAG lists the
 *     ops that change server state without setting that flag.
 *   - destructiveHint is declared here (DESTRUCTIVE), because nothing on the
 *     op says whether a write can be undone. Only a mutating op can be
 *     destructive; read-only ops always get destructiveHint: false.
 *   - openWorldHint is declared here (OPEN_WORLD): true only for ops that
 *     reach content outside the brain (an arbitrary URL, a git remote, a
 *     chat provider). Calls to the configured model or embedding provider do
 *     not count; they are the brain's own machinery.
 *   - title is declared here (TITLES). An op missing from the table still
 *     gets a title made from its name, so no tool ever ships untitled, and
 *     test/mcp-tool-annotations.test.ts fails until the table names it.
 *   - idempotentHint is kept from the op's inline annotations when set.
 *
 * The table wins over a title set inline on the op: several inline titles
 * carry notes in brackets, which the directory review reads as part of the
 * name. Entries for ops that are not present (for example ops a carried
 * patch adds) are inert.
 */
import type { Operation, ToolAnnotations } from './contract.ts';

/** Short plain titles, sentence case. No brackets, no dashes as separators. */
export const TITLES: Record<string, string> = {
  // memory verbs
  recall: 'Recall facts',
  remember: 'Remember a fact',
  entity: 'Look up an entity',
  synthesize: 'Synthesize an answer, slow and costly',
  forget: 'Forget a fact',
  context_pack: 'Build a context pack',
  delta: 'What changed since',
  // pages
  get_page: 'Get page',
  put_page: 'Write or replace page',
  patch_page: 'Edit part of a page',
  append_page_event: 'Append event to page',
  delete_page: 'Delete page',
  list_pages: 'List pages',
  restore_page: 'Restore deleted page',
  purge_deleted_pages: 'Purge deleted pages',
  capture: 'Capture a note',
  fetch: 'Fetch search result',
  get_versions: 'List page versions',
  revert_version: 'Revert page to version',
  resolve_slugs: 'Resolve page slugs',
  get_chunks: 'Get page chunks',
  put_raw_data: 'Store raw data',
  get_raw_data: 'Get raw data',
  // search
  search: 'Keyword search',
  query: 'Hybrid search',
  search_modes: 'List search modes',
  search_stats: 'Search statistics',
  search_tune: 'Search tuning advice',
  cache_stats: 'Query cache statistics',
  search_by_image: 'Search by image',
  // tags
  add_tag: 'Add tag',
  remove_tag: 'Remove tag',
  get_tags: 'Get tags',
  // links and graph
  add_link: 'Add link',
  remove_link: 'Remove link',
  get_links: 'Get outgoing links',
  get_backlinks: 'Get backlinks',
  list_link_sources: 'List link sources',
  traverse_graph: 'Traverse link graph',
  find_orphans: 'Find orphan pages',
  // timeline
  add_timeline_entry: 'Add timeline entry',
  get_timeline: 'Get timeline',
  // life chronicle and ontology
  chronicle_day: 'Chronicle for a day',
  chronicle_on_this_day: 'On this day',
  chronicle_since: 'Chronicle since a date',
  chronicle_last_seen: 'Last seen',
  volunteer_chronicle: 'Recent chronicle for entities',
  chronicle_backfill: 'Backfill chronicle',
  ontology_get: 'Get ontology',
  ontology_propose: 'Record ontology observation',
  ontology_dimensions: 'List ontology dimensions',
  ontology_conflicts: 'List ontology conflicts',
  // admin and operations
  get_stats: 'Get statistics',
  get_health: 'Get health report',
  run_doctor: 'Run health checks',
  get_status_snapshot: 'Get status snapshot',
  quarantine_list: 'List quarantined pages',
  get_usage: 'Get usage',
  run_onboard: 'Run onboarding check',
  run_skillopt: 'Optimize a skill',
  migrate_embeddings: 'Migrate embeddings',
  code_traversal_cache_clear: 'Clear code traversal cache',
  // identity
  whoami: 'Show connection identity',
  get_brain_identity: 'Get brain identity',
  // skills and advisor
  list_skills: 'List skills',
  get_skill: 'Get skill',
  list_brain_skillpack: 'List installed skill pack',
  advisor: 'Get advisor report',
  // sources and sync
  sources_add: 'Add source',
  sources_list: 'List sources',
  sources_remove: 'Remove source',
  sources_status: 'Get source status',
  sync_brain: 'Sync from git repository',
  // ingest log
  log_ingest: 'Log an ingest event',
  get_ingest_log: 'Get ingest log',
  // files
  file_list: 'List files',
  file_upload: 'Upload file',
  file_url: 'Get file URL',
  // jobs
  submit_job: 'Submit background job',
  get_job: 'Get job',
  list_jobs: 'List jobs',
  cancel_job: 'Cancel job',
  retry_job: 'Retry job',
  get_job_progress: 'Get job progress',
  pause_job: 'Pause job',
  resume_job: 'Resume job',
  replay_job: 'Replay job',
  send_job_message: 'Send message to job',
  submit_agent: 'Submit agent job',
  get_agent_job: 'Get agent job',
  get_job_stats: 'Get job statistics',
  // takes and think
  takes_list: 'List takes',
  takes_search: 'Search takes',
  takes_scorecard: 'Takes scorecard',
  takes_calibration: 'Takes calibration',
  takes_add: 'Add take',
  takes_update: 'Update take',
  takes_resolve: 'Resolve take',
  takes_supersede: 'Supersede take',
  think: 'Think through a question',
  get_calibration_profile: 'Get calibration profile',
  // hot memory (facts)
  extract_facts: 'Extract facts',
  forget_fact: 'Forget fact by id',
  delete_fact: 'Delete a fact you wrote',
  // entity extraction and identity
  extract_entities: 'Extract entities',
  extraction_pending: 'List pending extractions',
  extraction_review: 'Review extracted entities',
  entity_identity_link: 'Link entity identities',
  entity_identity_unlink: 'Unlink entity identities',
  entity_identity_list: 'List entity identities',
  // open loops
  open_loops: 'List open loops',
  loops_close: 'Close loop',
  loops_mute: 'Mute loop',
  loops_unmute: 'Unmute loop',
  // insights
  get_recent_salience: 'Get recent salient pages',
  find_anomalies: 'Find anomalies',
  find_contradictions: 'Find contradictions',
  find_experts: 'Find experts',
  find_trajectory: 'Find trajectory',
  volunteer_context: 'Suggest relevant context',
  get_recent_transcripts: 'Get recent transcripts',
  // connectors
  connectors_status: 'Get connector status',
  connector_sync: 'Sync chat connector',
  // code intelligence
  code_callers: 'Find code callers',
  code_callees: 'Find code callees',
  code_def: 'Find code definition',
  code_refs: 'Find code references',
  code_blast: 'Code change impact',
  code_flow: 'Code call flow',
  // schema packs
  get_active_schema_pack: 'Get active schema pack',
  list_schema_packs: 'List schema packs',
  schema_stats: 'Schema statistics',
  schema_lint: 'Lint schema',
  schema_graph: 'Schema graph',
  schema_explain_type: 'Explain schema type',
  schema_review_orphans: 'Review schema orphans',
  schema_apply_mutations: 'Apply schema changes',
  reload_schema_pack: 'Reload schema pack',
  // discovery
  request_tools: 'Request more tools',
};

/**
 * Writes that delete data or overwrite it in a way the caller cannot simply
 * undo with another tool call. put_page is here because it replaces the
 * whole page: an agent that sends part of a page loses the rest.
 */
export const DESTRUCTIVE: ReadonlySet<string> = new Set([
  'put_page',
  'delete_page',
  'purge_deleted_pages',
  'revert_version',
  'remove_tag',
  'remove_link',
  'forget',
  'forget_fact',
  'delete_fact',
  'sources_remove',
  'cancel_job',
  'entity_identity_unlink',
  'extraction_review', // its reject action soft-deletes the stubs
  'migrate_embeddings', // replaces every embedding and the vector dimension
  'schema_apply_mutations', // rewrites the schema pack file
]);

/** Ops that reach content outside the brain. */
export const OPEN_WORLD: ReadonlySet<string> = new Set([
  'search_by_image', // fetches an http(s) image_url
  'sources_add', // clones a remote git URL
  'connector_sync', // pulls conversation history from a chat provider
]);

/** Ops that change server state without setting `mutating`. */
export const WRITES_WITHOUT_MUTATING_FLAG: ReadonlySet<string> = new Set([
  'reload_schema_pack', // flushes the in-process schema pack cache
]);

/** A title from an op name, for an op the table does not name yet. */
export function titleFromName(name: string): string {
  const words = name.split('_').filter(Boolean).join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The annotations an op is served with. Key order is fixed: the tool list
 *  is compared byte for byte. */
export function toolAnnotationsFor(op: Operation): ToolAnnotations {
  const readOnly = !op.mutating && !WRITES_WITHOUT_MUTATING_FLAG.has(op.name);
  const idempotent = op.annotations?.idempotentHint;
  return {
    title: TITLES[op.name] ?? titleFromName(op.name),
    readOnlyHint: readOnly,
    destructiveHint: !readOnly && DESTRUCTIVE.has(op.name),
    ...(idempotent !== undefined ? { idempotentHint: idempotent } : {}),
    openWorldHint: OPEN_WORLD.has(op.name),
  };
}

/** Give every op its annotations, in place (as OP_AREAS does for `area`). */
export function applyToolAnnotations(ops: Operation[]): void {
  for (const op of ops) op.annotations = toolAnnotationsFor(op);
}
