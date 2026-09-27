/**
 * delete_fact: one fence row and its facts row leave together, for the writer
 * that put them there, and nothing else moves.
 *
 * Real PGLite and a real fence file; no LLM, no network.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { deleteFenceRow } from '../src/core/facts/delete-fence-row.ts';
import { operationsByName } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { acquirePageLock } from '../src/core/page-lock.ts';

let engine: PGLiteEngine;
let brainDir: string;

const SLUG = 'companies/acme-example';
const HUB = 'gmail:18f00example';
const FILE = `---
title: Acme Example
type: company
---
# Acme Example

Body.

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Founded in 2017 | fact | 1.0 | world | high | 2017-01-01 |  | linkedin |  |
| 2 | The plan renews on 2026-10-01 | event | 1.0 | world | medium | 2026-09-20 | 2026-10-02 | ${HUB} |  |
| 3 | Offer ends 2026-09-30 | event | 1.0 | private | medium | 2026-09-20 | 2026-10-01 | ${HUB} |  |
<!--- gbrain:facts:end -->
`;

const filePath = () => join(brainDir, `${SLUG}.md`);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  brainDir = mkdtempSync(join(tmpdir(), 'delete-fence-fact-'));
  await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [brainDir]);
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(brainDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM fact_withdrawals');
  await engine.executeRaw('DELETE FROM facts');
  await engine.executeRaw('DELETE FROM pages');
  rmSync(join(brainDir, 'companies'), { recursive: true, force: true });
  mkdirSync(join(brainDir, 'companies'), { recursive: true });
  writeFileSync(filePath(), FILE, 'utf-8');
  const imp = await importFromContent(engine, SLUG, FILE, { noEmbed: true, sourceId: 'default' });
  expect(imp.status).toBe('imported');
  await runExtractFacts(engine, { slugs: [SLUG] });
});

async function rows() {
  return engine.executeRaw<{ id: number; row_num: number; fact: string; source: string }>(
    `SELECT id, row_num, fact, source FROM facts WHERE source_markdown_slug = $1 ORDER BY row_num`, [SLUG]);
}
async function idOf(rowNum: number): Promise<number> {
  const r = (await rows()).find(x => x.row_num === rowNum);
  expect(r).toBeDefined();
  return Number(r!.id);
}

describe('deleteFenceRow', () => {
  test('deletes exactly the named row from the file, the DB body and the facts table', async () => {
    const id = await idOf(2);
    const r = await deleteFenceRow(engine, id, { sourceId: 'default', provenance: HUB });
    expect(r).toEqual({ ok: true, id, slug: SLUG, row_num: 2 });

    const file = readFileSync(filePath(), 'utf-8');
    expect(file).not.toContain('The plan renews');
    expect(file).toContain('Founded in 2017');
    expect(file).toContain('Offer ends 2026-09-30');
    expect(existsSync(`${filePath()}.tmp`)).toBe(false);

    const page = await engine.getPage(SLUG, { sourceId: 'default' });
    expect(page!.compiled_truth).not.toContain('The plan renews');
    expect(page!.compiled_truth).toContain('Founded in 2017');

    expect((await rows()).map(x => x.row_num)).toEqual([1, 3]);
    // A removal, not a retraction: nothing stops the claim landing again.
    expect((await engine.executeRaw('SELECT 1 FROM fact_withdrawals')).length).toBe(0);
  });

  test('the reconcile afterwards is a no-op: the row does not come back', async () => {
    const id = await idOf(2);
    await deleteFenceRow(engine, id, { sourceId: 'default', provenance: HUB });
    await runExtractFacts(engine, { slugs: [SLUG] });
    const after = await rows();
    expect(after.map(x => x.row_num)).toEqual([1, 3]);
    expect(after.some(x => x.fact.includes('The plan renews'))).toBe(false);
  });

  test('refuses a row written with another provenance, and leaves it untouched', async () => {
    const before = readFileSync(filePath(), 'utf-8');
    const id = await idOf(1); // source: linkedin
    const r = await deleteFenceRow(engine, id, { sourceId: 'default', provenance: HUB });
    expect(r).toMatchObject({ ok: false, refused: 'provenance_mismatch' });
    expect(readFileSync(filePath(), 'utf-8')).toBe(before);
    expect((await rows()).map(x => x.row_num)).toEqual([1, 2, 3]);
  });

  test('refuses a provenance that only starts the same way', async () => {
    const id = await idOf(2);
    const r = await deleteFenceRow(engine, id, { sourceId: 'default', provenance: 'gmail:' });
    expect(r).toMatchObject({ ok: false, refused: 'provenance_mismatch' });
    expect((await rows()).length).toBe(3);
  });

  test('refuses an unknown id and another source\'s row as the same not_found', async () => {
    expect(await deleteFenceRow(engine, 999_999, { sourceId: 'default', provenance: HUB }))
      .toMatchObject({ ok: false, refused: 'not_found' });
    const id = await idOf(2);
    expect(await deleteFenceRow(engine, id, { sourceId: 'other', provenance: HUB }))
      .toMatchObject({ ok: false, refused: 'not_found' });
    expect((await rows()).length).toBe(3);
  });

  test('a remote caller cannot reach a private row', async () => {
    const id = await idOf(3); // private
    expect(await deleteFenceRow(engine, id, { sourceId: 'default', provenance: HUB, worldOnly: true }))
      .toMatchObject({ ok: false, refused: 'not_found' });
    expect((await rows()).length).toBe(3);
  });

  test('refuses a database-only row', async () => {
    const [ins] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, confidence)
       VALUES ('default', $1, 'A table-only fact', 'fact', 'world', $2, 1.0) RETURNING id`, [SLUG, HUB]);
    const r = await deleteFenceRow(engine, Number(ins.id), { sourceId: 'default', provenance: HUB });
    expect(r).toMatchObject({ ok: false, refused: 'not_a_fence_row' });
    expect((await engine.executeRaw('SELECT 1 FROM facts WHERE id = $1', [ins.id])).length).toBe(1);
  });

  test('refuses when the fence no longer holds the row as recorded, and changes nothing', async () => {
    const id = await idOf(2);
    const drifted = FILE.replace('The plan renews on 2026-10-01', 'The plan renews on 2026-11-01');
    writeFileSync(filePath(), drifted, 'utf-8');
    const r = await deleteFenceRow(engine, id, { sourceId: 'default', provenance: HUB });
    expect(r).toMatchObject({ ok: false, refused: 'fence_drift' });
    expect(readFileSync(filePath(), 'utf-8')).toBe(drifted);
    expect((await rows()).length).toBe(3);
  });

  test('refuses a row another row records as its successor', async () => {
    const id2 = await idOf(2);
    const id3 = await idOf(3);
    await engine.executeRaw('UPDATE facts SET superseded_by = $1 WHERE id = $2', [id2, id3]);
    const r = await deleteFenceRow(engine, id2, { sourceId: 'default', provenance: HUB });
    expect(r).toMatchObject({ ok: false, refused: 'referenced' });
    expect((await rows()).length).toBe(3);
  });

  test('waits on the page lock: a held lock times it out and nothing changes', async () => {
    const id = await idOf(2);
    const lock = await acquirePageLock(SLUG, { sourceId: 'default' });
    expect(lock).not.toBeNull();
    try {
      await expect(deleteFenceRow(engine, id, { sourceId: 'default', provenance: HUB })).rejects.toThrow();
    } finally {
      await lock?.release();
    }
    expect((await rows()).length).toBe(3);
    expect(readFileSync(filePath(), 'utf-8')).toBe(FILE);
  }, 20_000);
});

describe('the delete_fact op', () => {
  const op = operationsByName.delete_fact;
  const ctx = (over: Record<string, unknown> = {}) =>
    ({ engine, sourceId: 'default', remote: false, dryRun: false, ...over }) as never;

  test('is a write op that requires id and provenance', () => {
    expect(op).toBeDefined();
    expect(op.mutating).toBe(true);
    expect(op.scope).toBe('write');
    expect(op.params.id.required).toBe(true);
    expect(op.params.provenance.required).toBe(true);
  });

  test('deletes a row the caller wrote', async () => {
    const id = await idOf(2);
    const out = await op.handler(ctx(), { id, provenance: HUB });
    expect(out).toEqual({ id, deleted: true, slug: SLUG, row_num: 2 });
  });

  test('a refusal is a typed error naming why', async () => {
    const id = await idOf(1);
    const refusal = (params: Record<string, unknown>) =>
      op.handler(ctx(), params).then(() => null, (e: unknown) => e as OperationError);
    const err = (await refusal({ id, provenance: HUB }))!;
    expect(err).toBeInstanceOf(OperationError);
    expect(err.code).toBe('provenance_mismatch');
    const missing = (await refusal({ id: 999_999, provenance: HUB }))!;
    expect(missing.code).toBe('fact_not_found');
    const noProv = (await refusal({ id, provenance: '  ' }))!;
    expect(noProv.code).toBe('invalid_params');
    expect((await rows()).length).toBe(3);
  });

  test('dry run changes nothing', async () => {
    const id = await idOf(2);
    expect(await op.handler(ctx({ dryRun: true }), { id, provenance: HUB }))
      .toEqual({ dry_run: true, action: 'delete_fact', id });
    expect((await rows()).length).toBe(3);
  });
});
