/**
 * gbrain sources set-id <old> <new> [--confirm] — change a source's identity.
 *
 * `sources rename` changes the DISPLAY name and says "(id is immutable)",
 * which was true and is the problem: an id chosen when a brain is created is
 * the one it keeps forever. Cosmic hit this on 2026-09-08 — a deployment
 * provisioned as `pilot` became `khoa` everywhere else (host, label, backups,
 * recovery kit, registry) while its 2,523 pages still recorded
 * `source_id: pilot`. That id is not cosmetic: the vault renders as
 * `<source>/<slug>.md`, so it is a folder on the owner's laptop, and it is
 * what `whoami` reports to every agent.
 *
 * 🔴 WHY THIS CANNOT BE A ONE-LINE UPDATE. Thirteen foreign keys point at
 * `sources` and every one is NO ACTION, so `UPDATE sources SET id = …` fails
 * outright. The manual alternative is worse: on a real brain the identity is
 * spread over ~20 `source_id` columns of which HALF have no foreign key
 * (`ingest_log` alone held 8,718 rows, three times `pages`). Miss one by hand
 * and nothing complains — the row simply points at a source that no longer
 * exists, surfacing weeks later as an empty search result.
 *
 * 🔴 THE DESIGN IS THE LAST STATEMENT. This ends by DELETING the old
 * `sources` row, inside the same transaction. If any FK-guarded column was
 * missed, that delete raises and the whole migration rolls back. The step
 * that proves completeness is the step that cannot lie about it — which is
 * exactly what hand-written SQL cannot give you.
 *
 * 🔴 IT REWRITES `source_id` COLUMNS ONLY, NEVER A COLUMN NAMED `source`.
 * That distinction is load-bearing and was found by measurement, not by
 * reading: `raw_data.source` holds `refs`, `gmail`, `sessions`, `whatsapp` —
 * CONNECTOR names, not source ids. A migration that matched on the word
 * "source" would silently corrupt them. Column discovery is therefore an
 * exact match on `source_id`, plus a named allowlist for the array columns
 * that genuinely hold source ids.
 *
 * Columns are discovered from information_schema at RUN time, never
 * hardcoded, so a table added by a later migration cannot quietly keep the
 * old id.
 *
 * Every device joined to this brain re-syncs afterwards: the manifest keys
 * off `<source>/<slug>.md` and every path changes. That is inherent to the
 * rename, not a defect, and the command says so before it does anything.
 *
 * 🔴 THE VAULT DIRECTORY MOVES WITH THE ID, INSIDE THE TRANSACTION. The
 * first version rewrote `local_path` as a string and left the directory
 * alone, on the stated belief that "the vault is a render of the database,
 * so the next reconcile writes the new tree". It does not. Cosmic ran that
 * version on 2026-09-08: the row then advertised `<brains>/khoa` while
 * all 2,499 pages still sat in `<brains>/pilot`. The hub's sync manifest
 * identifies a page by joining its FIRST PATH SEGMENT on disk to `source_id`,
 * so every page missed the join and the manifest went to ZERO entries. An
 * empty manifest is not inert — sync is a mirror, so it means "delete every
 * page" on every joined device. Nothing pulled during the window, which was
 * luck and not a safeguard.
 *
 * So the rename is ONE operation over TWO stores, and the filesystem half is
 * the last statement inside the transaction: if it throws, the database
 * rolls back with it, and the two can never disagree about where the pages
 * live. See cosmic-hub #438.
 */
import { existsSync, renameSync } from 'node:fs';
import type { BrainEngine } from '../core/engine.ts';
import { assertValidSourceId } from '../core/source-id.ts';

/** Array columns that hold source ids. Named explicitly because they cannot
 *  be found by column name alone and must never be guessed at. */
const ARRAY_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'oauth_clients', column: 'federated_read' },
];

/** Postgres identifiers we are willing to interpolate. Discovery reads from
 *  information_schema so these are already the database's own names, but the
 *  values reach a query string rather than a bind parameter — so they are
 *  checked rather than trusted. */
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

interface Target { table: string; column: string; kind: 'scalar' | 'array' }

/** Every place a source id is recorded, asked of the database itself. */
export async function discoverTargets(engine: BrainEngine): Promise<Target[]> {
  const scalars = await engine.executeRaw<{ table_name: string; column_name: string }>(
    `SELECT c.table_name, c.column_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public'
        AND t.table_type = 'BASE TABLE'
        AND c.column_name = 'source_id'
      ORDER BY c.table_name`,
    [],
  );
  const out: Target[] = scalars
    .filter((r) => IDENT_RE.test(r.table_name) && IDENT_RE.test(r.column_name))
    .map((r) => ({ table: r.table_name, column: r.column_name, kind: 'scalar' as const }));

  for (const a of ARRAY_COLUMNS) {
    const [exists] = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
      [a.table, a.column],
    );
    if (exists && exists.n > 0) out.push({ ...a, kind: 'array' });
  }
  return out;
}

/** How many rows each target holds for this id — the preview, and the number
 *  the migration must match. */
export async function countRows(engine: BrainEngine, targets: Target[], id: string):
Promise<Array<{ target: Target; rows: number }>> {
  const out: Array<{ target: Target; rows: number }> = [];
  for (const t of targets) {
    const where = t.kind === 'array' ? `$1 = ANY("${t.column}")` : `"${t.column}" = $1`;
    const [r] = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM public."${t.table}" WHERE ${where}`, [id],
    );
    if (r && r.n > 0) out.push({ target: t, rows: r.n });
  }
  return out;
}

/** The two filesystem calls this command makes, injectable so the FAILURE
 *  paths can be tested. The directory move is the safety-critical half — it
 *  is what keeps the database and the vault from disagreeing — and a rollback
 *  that is never exercised is a rollback nobody should trust. Defaults to the
 *  real filesystem; only the tests pass anything else. */
export interface FsOps { existsSync: typeof existsSync; renameSync: typeof renameSync }

export async function runSetId(
  engine: BrainEngine,
  rawArgs: string[],
  fs: FsOps = { existsSync, renameSync },
): Promise<void> {
  const confirm = rawArgs.includes('--confirm');
  const args = rawArgs.filter((a) => a !== '--confirm');
  const [oldId, newId] = args;

  if (!oldId || !newId) {
    console.error('Usage: gbrain sources set-id <old-id> <new-id> [--confirm]');
    console.error('  Changes a source\'s IDENTITY across every table that records it.');
    console.error('  Without --confirm it only previews what would change.');
    console.error('  Every joined device re-syncs afterwards: the vault renders as');
    console.error('  <source>/<slug>.md, so every path changes.');
    process.exit(2);
  }
  if (oldId === newId) {
    console.error(`Error: "${oldId}" is already the id. Nothing to do.`);
    process.exit(2);
  }
  try {
    assertValidSourceId(newId);
  } catch (e) {
    console.error(`Error: "${newId}" is not a valid source id — ${(e as Error).message}`);
    process.exit(2);
  }

  const [src] = await engine.executeRaw<{ id: string; name: string; local_path: string | null; archived: boolean }>(
    `SELECT id, name, local_path, archived FROM sources WHERE id = $1`, [oldId],
  );
  if (!src) {
    console.error(`Error: source "${oldId}" not found.`);
    console.error(`  Run 'gbrain sources list' to see registered sources.`);
    process.exit(4);
  }
  // An archived source is mid-deletion (72h window). Renaming one would
  // rewrite rows the purge is about to remove, and leave the operator with a
  // new id they cannot find in `sources list`.
  if (src.archived) {
    console.error(`Error: source "${oldId}" is archived. Restore it first, or purge it.`);
    process.exit(4);
  }
  const [taken] = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM sources WHERE id = $1`, [newId],
  );
  if (taken) {
    console.error(`Error: source "${newId}" already exists. Pick a free id.`);
    process.exit(4);
  }

  const targets = await discoverTargets(engine);
  const counts = await countRows(engine, targets, oldId);
  const total = counts.reduce((a, c) => a + c.rows, 0);

  // The vault directory is NAMED BY THE ID, so this rename spans two stores.
  // `assertValidSourceId` has already rejected any id containing a slash or a
  // dot, so `newId` cannot escape its parent directory when spliced in here.
  const newPath = src.local_path && src.local_path.endsWith(`/${oldId}`)
    ? `${src.local_path.slice(0, -oldId.length - 1)}/${newId}`
    : src.local_path;
  // Only move what is actually here. `local_path` is recorded by whichever
  // machine created the source, so a brain administered from a second box has
  // a legitimate path that does not exist locally — that is a warning, not a
  // failure, and the operator is told to move it by hand.
  const move = src.local_path && newPath && newPath !== src.local_path && fs.existsSync(src.local_path)
    ? { from: src.local_path, to: newPath }
    : null;

  console.log(`\n  ${oldId} → ${newId}   (${src.name})`);
  console.log(`  ${targets.length} columns record a source id; ${counts.length} hold rows for "${oldId}":\n`);
  for (const c of counts) {
    console.log(`    ${(c.target.table + '.' + c.target.column).padEnd(38)} ${String(c.rows).padStart(7)}`);
  }
  console.log(`    ${'total'.padEnd(38)} ${String(total).padStart(7)}\n`);

  if (move) {
    console.log(`  directory: ${move.from} → ${move.to}\n`);
  } else if (newPath !== src.local_path) {
    console.log(`  directory: ${src.local_path} is NOT on this machine — move it to`);
    console.log(`             ${newPath} by hand, or the vault and the brain disagree.\n`);
  }

  if (!confirm) {
    console.log('  Preview only. Re-run with --confirm to apply.');
    console.log('  ⚠️  Every device joined to this brain re-syncs afterwards — the vault');
    console.log('      renders as <source>/<slug>.md, so every path changes.\n');
    return;
  }

  // Refuse to merge two vault trees. If something already occupies the new
  // path, only a human knows which copy is real.
  if (move && fs.existsSync(move.to)) {
    console.error(`Error: ${move.to} already exists.`);
    console.error('  Move or remove it first — this will not merge two vault trees.');
    process.exit(4);
  }

  const applied: Array<{ label: string; rows: number }> = [];
  let moved = false;
  try {
    await engine.transaction(async (tx) => {
      // The new row first: every FK-guarded UPDATE below needs a parent to
      // point at, and this order means a failure leaves the OLD id intact and
      // complete rather than half-moved.
      //
      // The column list is read from the schema rather than written out, so a
      // column added by a later migration is carried over instead of silently
      // reset to its default — the same reason discovery is dynamic.
      const srcCols = await tx.executeRaw<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'sources'
          ORDER BY ordinal_position`, [],
      );
      const names = srcCols.map((c) => c.column_name).filter((n) => IDENT_RE.test(n));
      const selectList = names
        .map((n) => (n === 'id' ? '$2' : n === 'local_path' ? '$3' : n === 'name' ? '$4' : `"${n}"`))
        .join(', ');

      // 🔴 `sources.name` is UNIQUE, so the new row cannot be born holding the
      // display name while the old row still has it. Park the old name first,
      // and put the real one back after the old row is gone. Found by the test,
      // not by reading the schema — the first version of this deadlocked on its
      // own copy.
      await tx.executeRaw(`UPDATE sources SET name = $2 WHERE id = $1`,
        [oldId, `${oldId}__migrating`]);
      await tx.executeRaw(
        `INSERT INTO sources (${names.map((n) => `"${n}"`).join(', ')})
         SELECT ${selectList} FROM sources WHERE id = $1`,
        [oldId, newId, newPath, src.name],
      );

      for (const { target: t } of counts) {
        const sql = t.kind === 'array'
          ? `UPDATE public."${t.table}" SET "${t.column}" = array_replace("${t.column}", $1, $2) WHERE $1 = ANY("${t.column}")`
          : `UPDATE public."${t.table}" SET "${t.column}" = $2 WHERE "${t.column}" = $1`;
        const res = await tx.executeRaw<{ n: number }>(sql + ' RETURNING 1 AS n', [oldId, newId]);
        applied.push({ label: `${t.table}.${t.column}`, rows: res.length });
      }

      // The brain-level default is a config string, not a column, so no FK
      // protects it and nothing above would have found it.
      const def = await tx.executeRaw<{ value: string }>(
        `SELECT value FROM config WHERE key = 'sources.default'`, [],
      ).catch(() => []);
      if (def[0]?.value === oldId) {
        await tx.executeRaw(`UPDATE config SET value = $1 WHERE key = 'sources.default'`, [newId]);
        applied.push({ label: 'config.sources.default', rows: 1 });
      }

      // 🔴 THE PROOF. Every FK to `sources` is NO ACTION, so this raises if a
      // guarded column still points at the old id — and the transaction rolls
      // back whole. Never move this earlier and never make it a soft delete.
      await tx.executeRaw(`DELETE FROM sources WHERE id = $1`, [oldId]);

      // 🔴 THE FILESYSTEM HALF — LAST, AND INSIDE THE TRANSACTION. If this
      // throws, the rows above roll back, so the database can never end up
      // describing a directory that was not moved. That split is what emptied
      // Cosmic's sync manifest on 2026-09-08 (cosmic-hub #438).
      if (move) {
        fs.renameSync(move.from, move.to);
        moved = true;
      }
    });
  } catch (e) {
    // The rename is the last statement in the transaction, so arriving here
    // with `moved` set means COMMIT itself failed afterwards. The database is
    // back at the old id; put the directory back to match, because a moved
    // directory under a rolled-back database is the very state this command
    // exists to prevent.
    if (moved && move) {
      try {
        fs.renameSync(move.to, move.from);
      } catch (undo) {
        console.error(`\n  🔴 The database rolled back, but ${move.to} could NOT be moved back to`);
        console.error(`     ${move.from}: ${(undo as Error).message}`);
        console.error('     Move it back by hand BEFORE running anything else: until you do,');
        console.error('     the brain and the vault disagree about where the pages live.\n');
      }
    }
    throw e;
  }

  console.log(`  Applied:`);
  for (const a of applied) console.log(`    ${a.label.padEnd(38)} ${String(a.rows).padStart(7)}`);
  console.log(`\n  Source "${oldId}" is now "${newId}".`);
  if (move) {
    console.log(`  directory:          ${move.from} → ${move.to}`);
  } else if (newPath !== src.local_path) {
    console.log(`  local_path pointer: ${src.local_path} → ${newPath}`);
    console.log(`  ⚠️  The directory was NOT moved — it is not on this machine. Move it to`);
    console.log(`      ${newPath} before any device syncs, or the manifest will be empty.`);
  }
  console.log('  ⚠️  Every joined device will re-sync: the vault path for every page changed.\n');
}
