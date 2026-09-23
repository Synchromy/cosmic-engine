/**
 * The Synchromy patch register is true, and every patch in it is actually here.
 *
 * A rebuild that silently drops a patch produces an engine that starts, passes
 * upstream's own tests and quietly lacks a capability cosmic-hub calls. The
 * merge step cannot notice that: a branch missing from the list is simply
 * never merged. So every patch owns one probe below, a cheap assertion on the
 * surface it adds, and a patch with no probe fails this file. Adding a patch to
 * cosmic/patches.json means adding its probe here in the same change.
 */
import { describe, test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { operationsByName } from '../src/core/operations.ts';
import { computeEffectiveDate } from '../src/core/effective-date.ts';
import { loadRegister, autoResolution, laneFor, type Register } from '../scripts/cosmic-patches.ts';

const reg: Register = loadRegister('.');

const PROBES: Record<string, () => void> = {
  'c1-contained-mutations': () => {
    expect(operationsByName.patch_page).toBeDefined();
    expect(operationsByName.patch_page.params.base_revision?.required).toBe(true);
  },
  'idempotent-append-page-event': () => {
    expect(operationsByName.append_page_event).toBeDefined();
  },
  'patch-page-type-title': () => {
    expect(Object.keys(operationsByName.patch_page.params)).toEqual(expect.arrayContaining(['type', 'title']));
  },
  'effective-date-path-and-created': () => {
    const at = new Date('2026-01-01T00:00:00Z');
    const fromPath = computeEffectiveDate({ slug: 'calendar/2024-03-15/standup', frontmatter: {}, updatedAt: at, createdAt: at });
    expect(fromPath.source).toBe('path');
    const fromCreated = computeEffectiveDate({ slug: 'notes/acme', frontmatter: { created: '2024-03-15' }, updatedAt: at, createdAt: at });
    expect(fromCreated.source).toBe('created');
  },
  'c1-database-canonical': () => {
    const src = readFileSync('src/core/canonical-page-mutations.ts', 'utf8');
    expect(src).toContain('export function isDatabaseCanonical');
  },
  'sources-set-id': () => {
    expect(existsSync('src/commands/sources-set-id.ts')).toBe(true);
    expect(readFileSync('src/commands/sources.ts', 'utf8')).toContain("case 'set-id':");
  },
  'list-pages-effective-date': () => {
    expect(Object.keys(operationsByName.list_pages.params)).toEqual(expect.arrayContaining(['effective_after', 'effective_before']));
  },
  'ops-expose-what-the-engine-can-do': () => {
    expect(existsSync('test/ops-expose-what-the-engine-can-do.test.ts')).toBe(true);
  },
};

describe('the patch register', () => {
  test('ids are unique and every dependency is listed earlier', () => {
    const seen = new Set<string>();
    for (const p of reg.patches) {
      expect(seen.has(p.id)).toBe(false);
      for (const d of p.depends_on) expect(seen.has(d)).toBe(true);
      seen.add(p.id);
    }
  });

  test('state agrees with what upstream was last seen to say', () => {
    for (const p of reg.patches) {
      if (p.state === 'upstream-open') expect(p.upstream.seen).toBe('open');
      if (p.upstream.seen === 'none') expect(p.upstream.pr).toBeNull();
      if (p.upstream.seen === 'merged') expect(p.state).toBe('landed');
      expect(p.upstream.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test('every test a patch names, and every carried file, exists', () => {
    for (const p of reg.patches) for (const t of p.tests) expect(existsSync(t), `${p.id}: ${t}`).toBe(true);
    for (const c of reg.carry) expect(existsSync(c.path), c.path).toBe(true);
    for (const r of reg.regenerate) expect(existsSync(r.path), r.path).toBe(true);
  });

  test('conflicts in the ledger and generated files settle themselves, nothing else does', () => {
    expect(autoResolution(reg.ledger, reg)).toBe('ledger');
    for (const r of reg.regenerate) expect(autoResolution(r.path, reg)).toBe('regenerate');
    expect(autoResolution('src/core/ops/pages.ts', reg)).toBeNull();
  });

  test('lane naming matches the lanes that exist', () => {
    expect(laneFor(reg.base_tag)).toBe(reg.lane);
  });
});

describe('every patch is present', () => {
  test('every patch has a probe, and no probe outlives its patch', () => {
    const ids = reg.patches.filter(p => p.state !== 'landed').map(p => p.id).sort();
    expect(Object.keys(PROBES).sort()).toEqual(ids);
  });

  for (const p of reg.patches.filter(p => p.state !== 'landed')) {
    test(p.id, () => PROBES[p.id]!());
  }
});
