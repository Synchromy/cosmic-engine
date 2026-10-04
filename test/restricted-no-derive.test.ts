/**
 * C-72 finding 9 — what Cosmic derives takes no input from the `restricted`
 * source, nor from `founders`, which starts restricted (finding 10). Carried patch `restricted-no-derive` (cosmic/patches.json).
 *
 * Each restricted case has a visible control on the same path, so a case
 * cannot pass because the path never ran.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runFactsBackstop, runFactsPipeline } from '../src/core/facts/backstop.ts';
import { runChronicleBackstop } from '../src/core/chronicle/backstop.ts';
import { extractTimelineFromMeetings } from '../src/core/extract-timeline-from-meetings.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { derivesFrom } from '../src/core/restricted-no-derive.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { markShortLivedCliProcess, __resetShortLivedCliForTests } from '../src/core/facts/cli-process-mode.ts';

let engine: PGLiteEngine;
let schemaVersion: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version'))!;
});
afterAll(async () => { await engine.disconnect(); });
afterEach(() => { __resetShortLivedCliForTests(); });
beforeEach(async () => {
  // The hub lands pages with one-shot `gbrain capture` / `gbrain call`, whose
  // facts backstop submits a durable facts-absorb job (cli-process-mode.ts).
  markShortLivedCliProcess();
  await resetPgliteState(engine);
  // The reset truncates config; MinionQueue reads the schema version from it.
  await engine.setConfig('version', schemaVersion);
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('restricted', 'restricted'), ('founders', 'founders'), ('shared', 'shared')");
});

function localCtx(sourceId: string): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: false,
    sourceId,
  } as OperationContext;
}

const putPage = operations.find(o => o.name === 'put_page')!;
const extractEntities = operations.find(o => o.name === 'extract_entities')!;
const extractFacts = operations.find(o => o.name === 'extract_facts')!;

const EMAIL = [
  '---',
  'type: email',
  'title: Confidential terms with Jane Doe',
  '---',
  '',
  'Jane Doe wrote to say she is leaving Acme Corp next month and asked us to keep her new salary of 240k between us.',
].join('\n');

const emailPage = {
  slug: 'emails/jane-terms', type: 'email' as const,
  compiled_truth: 'Jane Doe wrote to say she is leaving Acme Corp next month and asked us to keep her new salary between us.',
  frontmatter: {},
};

async function jobCount(name: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM minion_jobs WHERE name = $1', [name]);
  return Number(rows[0]!.n);
}

async function factCount(): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts');
  return Number(rows[0]!.n);
}

async function janeSnapshot() {
  const page = await engine.getPage('people/jane', { sourceId: 'default' });
  const timeline = await engine.getTimeline('people/jane', { sourceId: 'default' });
  return { body: page?.compiled_truth, timeline: page?.timeline, rows: timeline.length };
}

describe('restricted-no-derive: which sources derive', () => {
  test('restricted and founders do not; default, shared and an unscoped call do', () => {
    expect(derivesFrom('restricted')).toBe(false);
    expect(derivesFrom('founders')).toBe(false);
    expect(derivesFrom('default')).toBe(true);
    expect(derivesFrom('shared')).toBe(true);
    expect(derivesFrom(undefined)).toBe(true);
  });
});

describe('restricted-no-derive: a restricted email about a person adds nothing to people/<name>', () => {
  test('the scenario: a local put_page in restricted queues no derivation and leaves people/jane as it was', async () => {
    await engine.putPage('people/jane', { type: 'person', title: 'Jane Doe', compiled_truth: 'Jane Doe, engineer.', timeline: '', frontmatter: {} });
    const before = await janeSnapshot();

    await putPage.handler(localCtx('restricted'), { slug: 'emails/jane-terms', content: EMAIL });

    expect(await engine.getPage('emails/jane-terms', { sourceId: 'restricted' })).not.toBeNull();
    expect(await jobCount('facts-absorb')).toBe(0);
    expect(await jobCount('chronicle_extract')).toBe(0);
    expect(await factCount()).toBe(0);
    expect(await janeSnapshot()).toEqual(before);
    const stubs = await engine.executeRaw<{ n: number }>(
      "SELECT count(*)::int AS n FROM pages WHERE source_id = 'restricted' AND (slug LIKE 'people/%' OR slug LIKE 'companies/%')");
    expect(Number(stubs[0]!.n)).toBe(0);
  });

  test('control: the same put_page in default queues the facts backstop', async () => {
    await putPage.handler(localCtx('default'), { slug: 'emails/jane-terms', content: EMAIL });
    expect(await jobCount('facts-absorb')).toBe(1);
  });
});

describe('restricted-no-derive: the backstops and their workers', () => {
  test('the facts and chronicle backstops refuse restricted, before any other gate', async () => {
    expect(await runFactsBackstop(emailPage, { engine, sourceId: 'restricted', source: 'mcp:put_page', sessionId: null }))
      .toMatchObject({ enqueued: false, skipped: 'restricted_source' });
    expect(await runFactsBackstop(emailPage, { engine, sourceId: 'restricted', source: 'mcp:put_page', sessionId: null, mode: 'inline' }))
      .toMatchObject({ inserted: 0, skipped: 'restricted_source' });
    expect(await runChronicleBackstop(emailPage, { engine, sourceId: 'restricted' }))
      .toEqual({ enqueued: false, skipped: 'restricted_source' });
    expect(await jobCount('facts-absorb')).toBe(0);
  });

  test('the facts and chronicle backstops refuse founders the same way', async () => {
    expect(await runFactsBackstop(emailPage, { engine, sourceId: 'founders', source: 'mcp:put_page', sessionId: null }))
      .toMatchObject({ enqueued: false, skipped: 'restricted_source' });
    expect(await runChronicleBackstop(emailPage, { engine, sourceId: 'founders' }))
      .toEqual({ enqueued: false, skipped: 'restricted_source' });
    expect(await jobCount('facts-absorb')).toBe(0);
  });

  test('control: the facts backstop queues the same page in a visible source', async () => {
    expect(await runFactsBackstop(emailPage, { engine, sourceId: 'shared', source: 'mcp:put_page', sessionId: null }))
      .toMatchObject({ enqueued: true });
  });

  test('extract_facts in restricted or founders derives nothing and says why', async () => {
    for (const sourceId of ['restricted', 'founders']) {
      expect(await extractFacts.handler(localCtx(sourceId), { turn_text: emailPage.compiled_truth }))
        .toMatchObject({ inserted: 0, skipped: 'restricted_source' });
    }
    expect(await factCount()).toBe(0);
  });

  test('control: extract_facts in a visible source goes on to extraction', async () => {
    // No chat model in tests, so reaching extraction shows as extraction_unavailable.
    expect(await extractFacts.handler(localCtx('shared'), { turn_text: emailPage.compiled_truth }))
      .toMatchObject({ skipped: 'extraction_unavailable' });
  });

  test('runFactsPipeline, the raw-turn entry sweep and checkpoint harvest share, derives nothing from restricted or founders', async () => {
    for (const sourceId of ['restricted', 'founders']) {
      expect(await runFactsPipeline(emailPage.compiled_truth, { engine, sourceId, source: 'mcp:extract_facts', sessionId: null }))
        .toEqual({ inserted: 0, duplicate: 0, superseded: 0, fact_ids: [], entity_slugs: [] });
    }
    // Control: the same turn in a visible source reaches the extractor.
    expect(await runFactsPipeline(emailPage.compiled_truth, { engine, sourceId: 'shared', source: 'mcp:extract_facts', sessionId: null }))
      .toMatchObject({ skipped_reason: 'chat_unavailable' });
  });

  test('a facts-absorb or chronicle_extract job already queued for restricted does not run', async () => {
    await engine.putPage(emailPage.slug, { ...emailPage, title: 'Terms', timeline: '' }, { sourceId: 'restricted' });
    const { MinionWorker } = await import('../src/core/minions/worker.ts');
    const { registerBuiltinHandlers } = await import('../src/commands/jobs.ts');
    const worker = new MinionWorker(engine, { queue: 'default' });
    await registerBuiltinHandlers(worker, engine);
    const handlers = (worker as unknown as { handlers: Map<string, (job: unknown) => Promise<unknown>> }).handlers;
    const job = (name: string) => ({ id: 1, name, data: { slug: 'emails/jane-terms', sourceId: 'restricted' }, signal: new AbortController().signal, updateProgress: async () => {}, log: async () => {} });
    expect(await handlers.get('facts-absorb')!(job('facts-absorb'))).toMatchObject({ skipped: 'restricted_source' });
    expect(await handlers.get('chronicle_extract')!(job('chronicle_extract'))).toMatchObject({ skipped: 'restricted_source' });
  });
});

describe('restricted-no-derive: meetings, entities and the cycle', () => {
  async function meetingIn(sourceId: string) {
    await engine.setConfig('link_resolution.cross_source', 'true');
    await engine.putPage('people/jane', { type: 'person', title: 'Jane Doe', compiled_truth: 'Jane Doe, engineer.', timeline: '', frontmatter: {} });
    await engine.putPage('meetings/2026-10-01-terms', {
      type: 'meeting', title: 'Terms', compiled_truth: 'Jane Doe attended and named her new salary.', timeline: '', frontmatter: { date: '2026-10-01' },
    }, { sourceId });
    await extractTimelineFromMeetings(engine);
    return (await engine.getTimeline('people/jane', { sourceId: 'default' })).length;
  }

  test('a restricted meeting adds no timeline line to a visible person, even with cross_source on', async () => {
    expect(await meetingIn('restricted')).toBe(0);
  });

  test('a founders meeting adds no timeline line either: founders starts restricted (finding 10)', async () => {
    expect(await meetingIn('founders')).toBe(0);
  });

  test('control: the same meeting in a visible source does add the line', async () => {
    expect(await meetingIn('shared')).toBe(1);
  });

  test('extract_entities in restricted creates no people or companies stub', async () => {
    const r = await extractEntities.handler(localCtx('restricted'), { text: 'Jane Doe works at Acme Corp.', source_slug: 'emails/jane-terms' });
    expect(r).toMatchObject({ status: 'skipped', reason: 'restricted_source', count: 0 });
    const rows = await engine.executeRaw<{ n: number }>(
      "SELECT count(*)::int AS n FROM pages WHERE slug LIKE 'people/%' OR slug LIKE 'companies/%'");
    expect(Number(rows[0]!.n)).toBe(0);
  });

  test('a cycle for restricted skips the phases that derive, and keeps its own links and timeline', async () => {
    const { runCycle } = await import('../src/core/cycle.ts');
    const report = await runCycle(engine, {
      brainDir: null, sourceId: 'restricted', dryRun: true,
      phases: ['extract', 'extract_facts', 'extract_atoms', 'consolidate'],
    } as Parameters<typeof runCycle>[1]);
    const byPhase = Object.fromEntries(report.phases.map(p => [p.phase, p.details?.reason]));
    expect(byPhase.extract_facts).toBe('restricted_source');
    expect(byPhase.extract_atoms).toBe('restricted_source');
    expect(byPhase.consolidate).toBe('restricted_source');
    expect(byPhase.extract).not.toBe('restricted_source');
  });

  test('a global cycle: the phases that loop every source themselves leave restricted out, and still visit the visible ones', async () => {
    await engine.setConfig('cycle.conversation_facts_backfill.enabled', 'true');
    await engine.setConfig('cycle.enrich_thin.enabled', 'true');
    const { runCycle } = await import('../src/core/cycle.ts');
    const report = await runCycle(engine, {
      brainDir: null, dryRun: true,
      phases: ['conversation_facts_backfill', 'enrich_thin'],
    } as Parameters<typeof runCycle>[1]);
    for (const name of ['conversation_facts_backfill', 'enrich_thin']) {
      const visited = Object.keys((report.phases.find(p => p.phase === name)?.details?.per_source ?? {}) as object);
      expect(visited).toContain('shared');
      expect(visited).not.toContain('restricted');
      expect(visited).not.toContain('founders');
    }
  });

  test('consolidate, which scans every source on a global cycle, promotes no restricted or founders facts and still promotes visible ones', async () => {
    const old = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    for (const sourceId of ['restricted', 'founders', 'shared']) {
      for (let i = 0; i < 3; i++) {
        await engine.executeRaw(
          `INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from)
           VALUES ($1, 'people/jane', $2, 'fact', 'test', $3::timestamptz)`,
          [sourceId, `jane fact ${i}`, old],
        );
      }
    }
    const { runPhaseConsolidate } = await import('../src/core/cycle/phases/consolidate.ts');
    const r = await runPhaseConsolidate(engine, { dryRun: true });
    // Only the shared bucket passes the scan; without the patch all three do.
    expect(r.details.buckets_processed).toBe(1);
    expect(r.details.buckets_skipped).toBe(0);
  });
});
