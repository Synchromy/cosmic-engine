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
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSetId, discoverTargets, type FsOps } from '../src/commands/sources-set-id.ts';
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
    `INSERT INTO sources (id, name, local_path) VALUES ('old', 'Old', '/srv/brains/old')`, []);
}

const exit = () => spyOn(process, 'exit').mockImplementation(((c?: number) => {
  throw new Error(`exit:${c ?? 0}`);
}) as never);

beforeEach(fresh);
afterAll(async () => { await engine.disconnect(); });

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
    expect(rows[0]!.local_path).toBe('/srv/brains/new');
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

/** 🔴 The half that was missing, and the reason cosmic-hub #438 exists.
 *
 *  The first version of this command rewrote `local_path` as a string and left
 *  the directory where it was, believing a later reconcile would re-render the
 *  tree. It does not. Run against Cosmic on 2026-09-08 that left the brain
 *  advertising `<brains>/khoa` while 2,499 pages sat in `<brains>/pilot`,
 *  and the hub's sync manifest — which identifies a page by joining its first
 *  path segment to `source_id` — went to ZERO entries. Sync is a mirror, so an
 *  empty manifest instructs every joined device to delete every page. Nothing
 *  pulled during the window. That was luck.
 *
 *  The property these tests defend: the database and the vault directory move
 *  together or neither moves. */
describe('the vault directory moves with the id', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'setid-'));
  });
  afterAll(() => { /* per-test dirs are inside tmpdir and small */ });

  async function sourceAt(dir: string): Promise<void> {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.md'), '# A');
    await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'old'`, [dir]);
  }

  test('the directory is renamed alongside the rows', async () => {
    const from = join(root, 'old');
    await sourceAt(from);
    await runSetId(engine, ['old', 'new', '--confirm']);

    expect(existsSync(from)).toBe(false);
    expect(existsSync(join(root, 'new'))).toBe(true);
    // The pages came with it — a rename, never a copy that could half-finish.
    expect(existsSync(join(root, 'new', 'a.md'))).toBe(true);

    const [r] = await engine.executeRaw<{ local_path: string }>(
      `SELECT local_path FROM sources WHERE id = 'new'`, []);
    expect(r!.local_path).toBe(join(root, 'new'));
  });

  // Only a human knows which copy is real, so the command must not choose.
  test('it refuses when something already occupies the new path, and writes nothing', async () => {
    await sourceAt(join(root, 'old'));
    mkdirSync(join(root, 'new'));
    const e = exit();
    await expect(runSetId(engine, ['old', 'new', '--confirm'])).rejects.toThrow('exit:4');
    e.mockRestore();

    const [r] = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM sources WHERE id = 'old'`, []);
    expect(r!.n).toBe(1);
    expect(existsSync(join(root, 'old'))).toBe(true);
  });

  // A path recorded by a different machine is legitimate. It must not stop the
  // rename — but the operator has to be told, because until they move it the
  // manifest is empty.
  test('a local_path that is not on this machine warns instead of failing', async () => {
    await engine.executeRaw(
      `UPDATE sources SET local_path = '/nowhere/that/exists/old' WHERE id = 'old'`, []);
    const said: string[] = [];
    const log = spyOn(console, 'log').mockImplementation(((m?: unknown) => { said.push(String(m)); }) as never);
    await runSetId(engine, ['old', 'new', '--confirm']);
    log.mockRestore();

    const [r] = await engine.executeRaw<{ local_path: string }>(
      `SELECT local_path FROM sources WHERE id = 'new'`, []);
    expect(r!.local_path).toBe('/nowhere/that/exists/new');
    expect(said.join('\n')).toContain('NOT moved');
  });

  // 🔴 One operation over two stores. If the filesystem half throws, the
  // database half must not survive it.
  test('a failed move rolls the database back whole', async () => {
    const from = join(root, 'old');
    await sourceAt(from);
    const boom: FsOps = {
      existsSync,
      renameSync: () => { throw new Error('EXDEV: simulated cross-device rename'); },
    };
    await expect(runSetId(engine, ['old', 'new', '--confirm'], boom)).rejects.toThrow('EXDEV');

    const rows = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM sources WHERE id IN ('old','new')`, []);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('old');
    expect(existsSync(from)).toBe(true);
  });

  // The mirror image: the move succeeded and COMMIT then failed. The directory
  // has to come back, or the database describes a tree that is no longer there.
  test('a commit that fails after the move puts the directory back', async () => {
    const from = join(root, 'old');
    await sourceAt(from);
    const failAtCommit = {
      ...engine,
      executeRaw: engine.executeRaw.bind(engine),
      transaction: async (fn: Parameters<PGLiteEngine['transaction']>[0]) => {
        await engine.transaction(fn);
        throw new Error('commit failed');
      },
    } as unknown as typeof engine;

    await expect(runSetId(failAtCommit, ['old', 'new', '--confirm'])).rejects.toThrow('commit failed');
    expect(existsSync(from)).toBe(true);
    expect(existsSync(join(root, 'new'))).toBe(false);
  });
});
