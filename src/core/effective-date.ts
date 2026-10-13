/**
 * v0.29.1 — Compute a page's effective_date from frontmatter precedence.
 *
 * The "effective date" is the answer to "when was this page about?" It's
 * NOT updated_at (which churns from auto-link) and NOT created_at (which
 * is the row insert time). It's the user's stated content date.
 *
 * Precedence chain (default order):
 *   1. frontmatter.event_date    — meeting / event pages
 *   2. frontmatter.date          — dated essays
 *   3. frontmatter.published     — writing/
 *   4. filename-date             — leading YYYY-MM-DD in basename
 *   5. path-date                 — first YYYY-MM-DD in a slug directory segment
 *   6. frontmatter.created       — the author's creation stamp
 *   7. updated_at                — fallback
 *   8. created_at                — last resort (only if updated_at NULL)
 *
 * Per-prefix override: for `daily/` and `meetings/` slug prefixes, the
 * filename-date jumps to position 1 — the filename is the user's primary
 * signal there ("daily/2024-03-15.md" the FILE date matters more than any
 * frontmatter the user pasted). The path-date follows it there too.
 *
 * Why 5 and 6 exist: a brain moved between engines lands every page with
 * a fresh row time, and a page with none of 1-4 then reads as the day of
 * the move. Measured on a 1,504-page brain: 759 pages fell back that way,
 * while 651 of them carried a date in a directory name and 128 more in a
 * `created:` line. Both are the author's own statement of when the page
 * happened; ignoring them turned a dated brain into one day. The path-date
 * outranks `created:` because directory dates are placed by hand and
 * `created:` is often re-stamped by tooling on the way through.
 *
 * Returns BOTH the parsed Date and the source label so the doctor's
 * `effective_date_health` check can detect "fell back to updated_at" rows
 * that look populated but are functionally equivalent to a NULL.
 *
 * Range validation: parsed value must be in [1990-01-01, NOW + 1 year].
 * Out-of-range values are dropped (the chain falls through to the next
 * element). NaN / unparseable strings drop the same way.
 *
 * Pure function. No DB. Tested in test/effective-date.test.ts.
 */

import type { EffectiveDateSource } from './types.ts';

export interface EffectiveDateResult {
  date: Date | null;
  source: EffectiveDateSource | null;
}

export interface ComputeEffectiveDateOpts {
  slug: string;
  frontmatter: Record<string, unknown>;
  /** Basename without extension, e.g. "2024-03-15-acme-call". May be null/empty. */
  filename?: string | null;
  updatedAt: Date;
  createdAt: Date;
}

/**
 * Slug prefixes where the filename date wins over frontmatter dates. The
 * user's primary signal in these directories is the filename, not arbitrary
 * frontmatter the importer might have copied.
 *
 * Hardcoded in v0.29.1 (commit 2). v0.29.1 commit 5 introduces the
 * recency-decay map; we could move this list there if we wanted user-tunable
 * filename-first prefixes, but the daily/ + meetings/ defaults are stable
 * enough that hardcoding is correct.
 */
const FILENAME_FIRST_PREFIXES = ['daily/', 'meetings/'];

const MIN_DATE_MS = Date.UTC(1990, 0, 1);
const FILENAME_DATE_RE = /^(\d{4}-\d{2}-\d{2})/;
/** A whole YYYY-MM-DD inside a directory segment: `2026-06-25`, `w-2026-06-25`,
 *  but not the first ten characters of a longer digit run. */
const PATH_DATE_RE = /(?:^|[^0-9])(\d{4}-\d{2}-\d{2})(?![0-9])/;

function maxDateMs(): number {
  // NOW + 1 year, computed at call time so tests with a mocked Date.now()
  // see a moving boundary. Pages dated > 1 year in the future are almost
  // always corrupt (epoch math gone wrong, typoed century, bad parse).
  return Date.now() + 365 * 24 * 60 * 60 * 1000;
}

/** Parse a frontmatter value as a Date. Accepts Date instances, ISO strings, YYYY-MM-DD. Returns null on any failure. */
export function parseDateLoose(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const ms = Date.parse(trimmed);
    if (!Number.isFinite(ms)) return null;
    return new Date(ms);
  }
  if (typeof value === 'number') {
    // Plausibility: numbers are usually ms since epoch but YAML can yield
    // bare integers (year? month? day?) — accept only if the resulting Date
    // falls inside the valid window. validateInRange catches the rest.
    return Number.isFinite(value) ? new Date(value) : null;
  }
  return null;
}

function validateInRange(d: Date | null): Date | null {
  if (d === null) return null;
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  if (ms < MIN_DATE_MS) return null;
  if (ms > maxDateMs()) return null;
  return d;
}

function extractFilenameDate(filename: string | null | undefined): Date | null {
  if (!filename) return null;
  const m = filename.match(FILENAME_DATE_RE);
  if (!m) return null;
  return validateInRange(parseDateLoose(m[1]));
}

/** The first valid date in the slug's DIRECTORY segments. The basename is
 *  the filename-date's job and is deliberately not read here. */
function extractPathDate(slug: string): Date | null {
  const segments = slug.split('/');
  for (const seg of segments.slice(0, -1)) {
    const m = seg.match(PATH_DATE_RE);
    if (!m) continue;
    const d = validateInRange(parseDateLoose(m[1]));
    if (d) return d;
  }
  return null;
}

function hasFilenameFirstPrefix(slug: string): boolean {
  for (const p of FILENAME_FIRST_PREFIXES) {
    if (slug.startsWith(p)) return true;
  }
  return false;
}

/**
 * Run the precedence chain. Returns the first valid (in-range) date and its
 * source label. Falls all the way through to updated_at / created_at as
 * 'fallback' when nothing in frontmatter or filename parses.
 */
export function computeEffectiveDate(opts: ComputeEffectiveDateOpts): EffectiveDateResult {
  const { slug, frontmatter, filename, updatedAt, createdAt } = opts;
  const filenameFirst = hasFilenameFirstPrefix(slug);

  const fmEvent = validateInRange(parseDateLoose(frontmatter.event_date));
  const fmDate = validateInRange(parseDateLoose(frontmatter.date));
  const fmPublished = validateInRange(parseDateLoose(frontmatter.published));
  const fmCreated = validateInRange(parseDateLoose(frontmatter.created));
  const filenameDate = extractFilenameDate(filename);
  const pathDate = extractPathDate(slug);

  // Build the ordered candidate list. For filename-first prefixes
  // (daily/, meetings/) the filename moves to the head of the chain, and
  // the path-date goes with it. `created` is always last: it is a real
  // statement, but the one most often re-stamped by tooling.
  const candidates: Array<{ date: Date | null; source: EffectiveDateSource }> = filenameFirst
    ? [
        { date: filenameDate, source: 'filename' },
        { date: pathDate, source: 'path' },
        { date: fmEvent, source: 'event_date' },
        { date: fmDate, source: 'date' },
        { date: fmPublished, source: 'published' },
        { date: fmCreated, source: 'created' },
      ]
    : [
        { date: fmEvent, source: 'event_date' },
        { date: fmDate, source: 'date' },
        { date: fmPublished, source: 'published' },
        { date: filenameDate, source: 'filename' },
        { date: pathDate, source: 'path' },
        { date: fmCreated, source: 'created' },
      ];

  for (const c of candidates) {
    if (c.date !== null) return { date: c.date, source: c.source };
  }

  // Fallback chain: updated_at, then created_at. Both are guaranteed
  // non-null by the schema; the validation here is defensive against bad
  // test fixtures.
  const upd = validateInRange(updatedAt);
  if (upd !== null) return { date: upd, source: 'fallback' };
  const cre = validateInRange(createdAt);
  if (cre !== null) return { date: cre, source: 'fallback' };

  return { date: null, source: null };
}
