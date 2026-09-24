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
import { apply as brandCheck } from '../scripts/cosmic-brand.ts';
import { loadRegister, autoResolution, laneFor, retarget, type Register } from '../scripts/cosmic-patches.ts';

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
  'cosmic-brand': () => {
    // Every anchor applied; test/cosmic-brand.test.ts is the leak test proper.
    const r = brandCheck('.', true);
    expect(r.missing).toEqual([]);
    expect(r.applied).toEqual([]);
  },
};

describe('the patch register', () => {
  test('every patch is a branch or a script, never both, never neither', () => {
    for (const p of reg.patches) expect(!!p.branch !== !!p.script, p.id).toBe(true);
    for (const p of reg.patches.filter(x => x.script)) {
      expect(reg.carry.map(c => c.path), `${p.id}: its script must be carried`).toContain(p.script);
    }
  });

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

  test('the register carried onto a new tag describes the new lane, and keeps every patch', () => {
    const moved = JSON.parse(retarget(readFileSync('cosmic/patches.json', 'utf8'), 'v0.49.0.0')) as Register;
    expect(moved.lane).toBe('cosmic/v0.49.0');
    expect(moved.base_tag).toBe('v0.49.0.0');
    expect(moved.patches).toEqual(reg.patches);
    expect(moved.carry).toEqual(reg.carry);
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
