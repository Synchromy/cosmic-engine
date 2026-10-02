/**
 * C-72 finding 9 — what Cosmic derives takes no input from the `restricted`
 * source. Carried patch `restricted-no-derive` (cosmic/patches.json).
 *
 * Each restricted case has a visible control on the same path, so a case
 * cannot pass because the path never ran.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runFactsBackstop } from '../src/core/facts/backstop.ts';
import { runChronicleBackstop } from '../src/core/chronicle/backstop.ts';
import { extractTimelineFromMeetings } from '../src/core/extract-timeline-from-meetings.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
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
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('restricted', 'restricted'), ('shared', 'shared')");
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

  test('control: the facts backstop queues the same page in a visible source', async () => {
    expect(await runFactsBackstop(emailPage, { engine, sourceId: 'shared', source: 'mcp:put_page', sessionId: null }))
      .toMatchObject({ enqueued: true });
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
});
