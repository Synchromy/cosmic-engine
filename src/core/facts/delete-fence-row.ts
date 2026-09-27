/**
 * Delete ONE fence row and its facts row, together, for the writer that put
 * it there.
 *
 * Every other single-fact removal (`forget`, `forget_fact`, supersede) strikes
 * the fence row and expires the facts row: the claim stays in the page text,
 * struck through, and a withdrawal record keeps it from coming back. That is
 * right for a retraction. It is wrong for a fact that simply ran out, such as
 * "the plan renews on 1 Oct" written by an ingest job with a ttl: once the
 * date passes, the writer wants the row gone from the page, and a later
 * notice with the same claim must be free to land again (a withdrawal would
 * refuse it). Only the page-wide reconcile deletes rows today, and nothing
 * safe exists for one row: a get_page -> put_page rewrite loses any fact
 * another writer adds in between (#4872).
 *
 * The caller proves it wrote the row by naming its provenance: the row's
 * `source`, which is whatever the writer passed to `remember` as provenance.
 * A row whose provenance does not match exactly is refused and untouched, so
 * a job can delete what it wrote and nothing a person, an extractor or
 * another job wrote.
 *
 * Order, under the source filesystem lock and then the page lock (the same
 * hierarchy as writeFactsToFence and forgetFactInFence):
 *   1. read the fence file; the row must be there with the DB row's claim and
 *      provenance, or refuse (drift is doctor's to report, not ours to guess);
 *   2. write the fence without that row to `<file>.tmp` and parse-validate it;
 *   3. in ONE database transaction: delete the facts row (re-checked by id,
 *      source, provenance and row number), mirror the new body into
 *      pages.compiled_truth, then rename the .tmp over the file. A failed
 *      rename throws inside the transaction, so the facts row and the DB body
 *      roll back with it; a failed delete leaves the file as it was.
 * No withdrawal is recorded: this is a removal, not a retraction.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';

import type { BrainEngine } from '../engine.ts';
import { withPageLock } from '../page-lock.ts';
import { assertSourceFilesystemActive, hasSourceFilesystemLock, withSourceFilesystemLock } from '../minions/source-filesystem.ts';
import { isWriteThroughDisabled, resolvePageWriteTarget } from '../write-through.ts';
import { isDurabilityHardened, commitWriteThroughFile } from '../brain-repo-durability.ts';
import { parseFactsFence, renderFactsTable, replaceOrInsertFactsFence } from '../facts-fence.ts';
import { parseMarkdown } from '../markdown.ts';
import { sanitizeText } from '../batch-rows.ts';
import { contentHash } from '../utils.ts';

/** Why a delete did not happen. Each leaves the file and the facts table untouched. */
export type DeleteFenceRowRefusal =
  /** Unknown id, another source's row, or (remote) a private row: indistinguishable on purpose. */
  | 'not_found'
  /** The row's provenance is not the one the caller named: someone else wrote it. */
  | 'provenance_mismatch'
  /** The row is not on a page: DB-only row, no local_path, write-through off, or no file. */
  | 'not_a_fence_row'
  /** The fence file does not hold this row as the DB describes it, or does not parse. */
  | 'fence_drift'
  /** Another facts row records this one as its successor; deleting it would orphan that link. */
  | 'referenced';

export type DeleteFenceRowResult =
  | { ok: true; id: number; slug: string; row_num: number }
  | { ok: false; refused: DeleteFenceRowRefusal; detail: string };

interface FactRow {
  id: string;
  source_id: string;
  source: string | null;
  fact: string;
  visibility: string;
  row_num: number | null;
  source_markdown_slug: string | null;
}

export interface DeleteFenceRowOpts {
  /** The caller's source. A row in any other source is `not_found`. */
  sourceId: string;
  /** Must equal the row's recorded provenance (`facts.source`) exactly. */
  provenance: string;
  /** Remote callers reach world rows only, as with forget. */
  worldOnly?: boolean;
}

const refuse = (refused: DeleteFenceRowRefusal, detail: string): DeleteFenceRowResult =>
  ({ ok: false, refused, detail });

export async function deleteFenceRow(
  engine: BrainEngine,
  factId: number,
  opts: DeleteFenceRowOpts,
): Promise<DeleteFenceRowResult> {
  const rows = await engine.executeRaw<FactRow>(
    `SELECT id, source_id, source, fact, visibility, row_num, source_markdown_slug
       FROM facts WHERE id = $1`,
    [factId],
  );
  const row = rows[0];
  if (!row || row.source_id !== opts.sourceId || (opts.worldOnly === true && row.visibility !== 'world')) {
    return refuse('not_found', `no fact ${factId} in source ${opts.sourceId}`);
  }
  if (row.source !== opts.provenance) {
    return refuse('provenance_mismatch', `fact ${factId} was not written with that provenance`);
  }
  if (row.row_num === null || row.source_markdown_slug === null) {
    return refuse('not_a_fence_row', `fact ${factId} is a database-only row, on no page`);
  }
  const successors = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM facts WHERE superseded_by = $1 LIMIT 1`, [factId]);
  if (successors.length > 0) {
    return refuse('referenced', `fact ${successors[0].id} records fact ${factId} as its successor`);
  }

  const localPath = (await engine.executeRaw<{ local_path: string | null }>(
    `SELECT local_path FROM sources WHERE id = $1`, [row.source_id]))[0]?.local_path ?? null;
  if (!localPath || await isWriteThroughDisabled(engine)) {
    return refuse('not_a_fence_row', `source ${row.source_id} keeps no fence files`);
  }
  const slug = row.source_markdown_slug;
  const rowNum = row.row_num;
  const resolved = await resolvePageWriteTarget(engine, slug, row.source_id);
  if (!resolved.ok) return refuse('not_a_fence_row', `no usable file for ${slug}`);
  const { filePath, writeRoot } = resolved;

  const underPageLock = (): Promise<DeleteFenceRowResult> => withPageLock(slug, async () => {
    if (!existsSync(filePath)) return refuse('not_a_fence_row', `${slug} has no file`);
    const body = readFileSync(filePath, 'utf-8');
    const parsed = parseFactsFence(body);
    if (parsed.warnings.length > 0) {
      return refuse('fence_drift', `${slug}'s fence does not parse cleanly; nothing re-rendered`);
    }
    const target = parsed.facts.find(f => f.rowNum === rowNum);
    if (!target || target.claim !== row.fact || (target.source ?? '') !== opts.provenance) {
      return refuse('fence_drift', `${slug}'s fence does not hold row #${rowNum} as the database records it`);
    }
    const newBody = replaceOrInsertFactsFence(body, renderFactsTable(parsed.facts.filter(f => f.rowNum !== rowNum)));

    const tmpPath = `${filePath}.tmp`;
    assertSourceFilesystemActive();
    writeFileSync(tmpPath, newBody, 'utf-8');
    const tmpBody = readFileSync(tmpPath, 'utf-8');
    const check = parseFactsFence(tmpBody);
    if (check.warnings.length > 0 || check.facts.length !== parsed.facts.length - 1) {
      rmSync(tmpPath, { force: true });
      return refuse('fence_drift', `the fence without row #${rowNum} did not re-parse; nothing changed`);
    }

    try {
      await engine.transaction(async tx => {
        const gone = await tx.executeRaw<{ id: string }>(
          `DELETE FROM facts
            WHERE id = $1 AND source_id = $2 AND source = $3
              AND source_markdown_slug = $4 AND row_num = $5
            RETURNING id`,
          [factId, row.source_id, opts.provenance, slug, rowNum],
        );
        if (gone.length !== 1) throw new RowMoved();
        // The DB body is what get_page and the reconcile read. Mirror the
        // file bytes as import-file.ts would; keep the row's content_hash so
        // the next sync still re-imports and re-chunks (#4696, #4872).
        const page = await tx.getPage(slug, { sourceId: row.source_id });
        if (page) {
          const reparsed = parseMarkdown(tmpBody, `${slug}.md`);
          await tx.refreshPageBody(slug, row.source_id,
            sanitizeText(reparsed.compiled_truth), sanitizeText(reparsed.timeline),
            page.content_hash || contentHash(page));
        }
        renameSync(tmpPath, filePath);
      });
    } catch (err) {
      rmSync(tmpPath, { force: true });
      if (err instanceof RowMoved) {
        return refuse('fence_drift', `fact ${factId} changed while the page was locked; nothing changed`);
      }
      throw err;
    }

    if (isDurabilityHardened(writeRoot)) commitWriteThroughFile(writeRoot, filePath, slug);
    return { ok: true, id: factId, slug, row_num: rowNum };
  }, { timeoutMs: 5_000, sourceId: row.source_id });

  return hasSourceFilesystemLock(writeRoot)
    ? underPageLock()
    : withSourceFilesystemLock(engine, writeRoot, underPageLock);
}

class RowMoved extends Error {}
