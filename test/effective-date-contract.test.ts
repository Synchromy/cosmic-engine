/**
 * THE DATE KEYS ARE A PUBLISHED CONTRACT, NOT AN IMPLEMENTATION DETAIL.
 *
 * Consumers write frontmatter hoping this chain will read it. They cannot
 * import this function — `gbrain` ships as a binary, `computeEffectiveDate`
 * is not in the package's `exports`, and a consumer's CI does not install the
 * engine at all. So nothing on their side can verify the key they emit is one
 * this chain accepts. Their tests assert their own output and restate this
 * file's behaviour in a comment, which is not a check.
 *
 * ## The bug this file exists for (#393)
 *
 * cosmic-hub's funnel stamped `occurred_at:` into every page it landed, from
 * its first commit. This chain has never read that key. So every page fell
 * through to `fallback` — its import time — and nothing errored, because
 * `fallback` produces a VALID date, just the wrong one. Measured on one brain
 * on 2026-09-07: 759 of 1,504 pages. `since`/`until` and the recency boost all
 * rank on `effective_date`, so a page holding March messages sorted as though
 * it happened on the day it was imported.
 *
 * It was found by a person asking a question that depended on the date being
 * TRUE — "what is on next week" — months after it started, and repaired by
 * rewriting 2,404 pages on one tenant.
 *
 * ## What these tests are for, and what they are not
 *
 * Not "does the chain work" — effective-date.test.ts covers that. These say
 * that REMOVING OR RENAMING A KEY IS A BREAKING CHANGE, and name who breaks.
 * A failure here is not a bug in this file; it is a signal that a consumer
 * must be told before this ships.
 *
 * Add a key here when a consumer starts depending on it. Never delete a line
 * to make this file pass.
 */

import { describe, test, expect } from 'bun:test';
import { computeEffectiveDate } from '../src/core/effective-date.ts';
import type { EffectiveDateSource } from '../src/core/types.ts';

/** Every frontmatter key this chain promises to read, and who relies on it.
 *  The `why` is not decoration: a key nobody depends on should not be here,
 *  and a key somebody does depend on must never leave without them knowing. */
const PUBLISHED_KEYS: Array<{ key: EffectiveDateSource; why: string }> = [
  { key: 'event_date', why: 'meeting and event pages written by hand' },
  { key: 'date', why: "cosmic-hub ingest/funnel.ts renderPage — EVERY page every connector lands (#393)" },
  { key: 'published', why: 'writing/, where the publication date is the subject date' },
  { key: 'created', why: "an author's own creation stamp, when nothing better is stated" },
];

const ISO = '2026-03-20T12:09:00.000Z';

describe('the frontmatter date keys are a contract with consumers', () => {
  // 🔴 THE WHOLE POINT. Iterated over the SET, so a key added in November is
  // subject to this without anyone remembering the file exists — the rule
  // cosmic-hub's own connector-contract.test.ts was written to enforce after
  // seven bugs that each named the one member somebody happened to look at.
  for (const { key, why } of PUBLISHED_KEYS) {
    test(`${key} is read, and dates the page from its content — ${why}`, () => {
      const r = computeEffectiveDate({
        slug: 'inbox/gmail/example',
        frontmatter: { [key]: ISO },
        filename: null,
        updatedAt: new Date('2026-09-19T00:00:00Z'),
        createdAt: new Date('2026-09-19T00:00:00Z'),
      });
      expect(r.source).toBe(key);
      expect(r.date?.toISOString()).toBe(ISO);
      // Stated separately because this is the failure that actually happened:
      // an unread key does not error, it silently becomes the import time.
      expect(r.source).not.toBe('fallback');
    });
  }

  // ⚠️ AND THE SHAPE OF THE FAILURE, pinned so it cannot come back quietly.
  // A key the chain does not know is indistinguishable, from the consumer's
  // side, from one it does — until you look at effective_date_source.
  test('an unknown key falls back to the import time, silently and validly', () => {
    const importTime = new Date('2026-09-19T00:00:00Z');
    const r = computeEffectiveDate({
      slug: 'inbox/gcal/example',
      frontmatter: { occurred_at: ISO },   // the #393 key, deliberately not read
      filename: null,
      updatedAt: importTime,
      createdAt: importTime,
    });
    expect(r.source).toBe('fallback');
    expect(r.date?.toISOString()).toBe(importTime.toISOString());
    // Which is a real date. That is why nobody noticed for months.
    expect(r.date).not.toBeNull();
  });

  test('a future date survives, because "what is on next week" depends on it', () => {
    const nextWeek = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const r = computeEffectiveDate({
      slug: 'inbox/gcal/example',
      frontmatter: { date: nextWeek.toISOString() },
      filename: null,
      updatedAt: new Date(),
      createdAt: new Date(),
    });
    expect(r.source).toBe('date');
    expect(r.date?.getTime()).toBe(nextWeek.getTime());
  });
});
