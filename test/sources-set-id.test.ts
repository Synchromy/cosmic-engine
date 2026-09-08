/**
 * `gbrain sources set-id` — changing a source's identity, not its label.
 *
 * `sources rename` moved the display name and said "(id is immutable)". That
 * was true and it was the problem: an id chosen when a brain is created is the
 * one it keeps. Cosmic met it when a deployment provisioned as `pilot` became
 * `khoa` everywhere except inside the brain, where 2,523 pages still recorded
 * the old id — which is the folder name on the owner's laptop and what
 * `whoami` reports.
 *
 * Runs against PGLite, like the other sources tests.
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll, spyOn } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSetId, discoverTargets } from '../src/commands/sources-set-id.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await withEnv({ GBRAIN_PGLITE_SNAPSHOT: undefined }, async () => {
    await engine.connect({});
    await engine.initSchema();
  });
});

async function fresh(): Promise<void> {
  await engine.executeRaw(`DELETE FROM pages WHERE source_id IN ('old','new','keep')`, []);
  await engine.executeRaw(`DELETE FROM sources WHERE id IN ('old','new','keep')`, []);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path) VALUES ('old', 'Old', '/data/brain/old')`, []);
}

const exit = () => spyOn(process, 'exit').mockImplementation(((c?: number) => {
  throw new Error(`exit:${c ?? 0}`);
}) as never);

beforeEach(fresh);
afterAll(async () => { await engine?.close?.(); });

describe('discovery', () => {
  // 🔴 The distinction the whole command rests on. `raw_data.source` holds
  // CONNECTOR names — refs, gmail, sessions, whatsapp — not source ids.
  // Matching on the word "source" would rewrite them.
  test('finds source_id columns and never a column merely named "source"', async () => {
    const targets = await discoverTargets(engine);
    expect(targets.length).toBeGreaterThan(3);
    expect(targets.every((t) => t.column === 'source_id' || t.kind === 'array')).toBe(true);
    expect(targets.some((t) => t.table === 'pages' && t.column === 'source_id')).toBe(true);
    expect(targets.some((t) => t.table === 'raw_data' && t.column === 'source')).toBe(false);
  });
});

describe('refusals — all before anything is written', () => {
  test('a missing source', async () => {
    const e = exit();
    await expect(runSetId(engine, ['nope', 'new', '--confirm'])).rejects.toThrow('exit:4');
    e.mockRestore();
  });

  test('an id that is already taken', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('keep','Keep')`, []);
    const e = exit();
    await expect(runSetId(engine, ['old', 'keep', '--confirm'])).rejects.toThrow('exit:4');
    e.mockRestore();
  });

  test('an invalid id, by the engine\'s own rule', async () => {
    const e = exit();
    await expect(runSetId(engine, ['old', 'Not_Valid', '--confirm'])).rejects.toThrow('exit:2');
    e.mockRestore();
  });

  test('renaming to itself', async () => {
    const e = exit();
    await expect(runSetId(engine, ['old', 'old', '--confirm'])).rejects.toThrow('exit:2');
    e.mockRestore();
  });

  // An archived source is inside its 72h delete window. Renaming one rewrites
  // rows the purge is about to remove, and hands back an id `sources list`
  // will not show.
  test('an archived source', async () => {
    await engine.executeRaw(`UPDATE sources SET archived = true WHERE id = 'old'`, []);
    const e = exit();
    await expect(runSetId(engine, ['old', 'new', '--confirm'])).rejects.toThrow('exit:4');
    e.mockRestore();
  });
});

describe('the migration', () => {
  test('previewing changes nothing', async () => {
    await runSetId(engine, ['old', 'new']);
    const [r] = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM sources WHERE id = 'old'`, []);
    expect(r!.n).toBe(1);
  });

  test('it moves the rows, the row, and the path pointer', async () => {
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, title, compiled_truth, type)
       VALUES ('old','a','A','x','note'), ('old','b','B','y','note')`, []);
    await runSetId(engine, ['old', 'new', '--confirm']);

    const [pagesOld] = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM pages WHERE source_id = 'old'`, []);
    const [pagesNew] = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM pages WHERE source_id = 'new'`, []);
    expect(pagesOld!.n).toBe(0);
    expect(pagesNew!.n).toBe(2);

    const rows = await engine.executeRaw<{ id: string; name: string; local_path: string }>(
      `SELECT id, name, local_path FROM sources WHERE id IN ('old','new')`, []);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('new');
    // The display name is carried, not reset — this changes identity, not label.
    expect(rows[0]!.name).toBe('Old');
    expect(rows[0]!.local_path).toBe('/data/brain/new');
  });

  test('another source is left completely alone', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('keep','Keep')`, []);
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, title, compiled_truth, type) VALUES ('keep','k','K','z','note')`, []);
    await runSetId(engine, ['old', 'new', '--confirm']);
    const [r] = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM pages WHERE source_id = 'keep'`, []);
    expect(r!.n).toBe(1);
  });

  // 🔴 The design, asserted. The last statement deletes the old row, so an
  // incomplete migration cannot commit — a foreign key raises and the whole
  // transaction rolls back. If this ever passes with the old row gone AND
  // rows still pointing at it, the safety property is gone.
  test('the old row is gone only because nothing still points at it', async () => {
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, title, compiled_truth, type) VALUES ('old','c','C','w','note')`, []);
    await runSetId(engine, ['old', 'new', '--confirm']);
    const [orphans] = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM pages WHERE source_id NOT IN (SELECT id FROM sources)`, []);
    expect(orphans!.n).toBe(0);
  });
});
