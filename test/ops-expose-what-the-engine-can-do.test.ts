/**
 * Two directions of the same contract, and the second is the one that was
 * broken for a year.
 *
 * `PageFilters.effective_after` / `effective_before` were declared on the
 * filter type, implemented in postgres-engine and pglite-engine, and indexed
 * in schema.sql — since v0.46.25.0. No operation exposed them. So an agent
 * could ask when a page CHANGED and not when its subject HAPPENS, and finding
 * one brain's meetings for the coming week cost ~130 page scans and 90 calls.
 * Nothing failed; the capability was simply unreachable.
 *
 * Neither a unit nor an integration test catches that, because there is
 * nothing to call. The gap is between what the engine can do and what the
 * tool surface admits to, and only a check over both can see it.
 *
 * Direction 1 — declared but never read. A param on an op that nothing in its
 *   module consumes: wired into the schema and forgotten in the handler.
 * Direction 2 — implemented but never exposed. A filter the engine honours
 *   that no op offers. This is the one that happened.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { operations } from '../src/core/operations.ts';

const OPS_DIR = 'src/core/ops';
const files = readdirSync(OPS_DIR).filter(f => f.endsWith('.ts'))
  .map(f => [f, readFileSync(`${OPS_DIR}/${f}`, 'utf8')] as const);

/** The file that DEFINES an op, not one that merely names it. `context.ts`
 *  carries `tool_name: 'search'` and would otherwise be mistaken for home. */
function definitionOf(op: string) {
  const re = new RegExp(`:\\s*Operation\\s*=\\s*\\{[\\s\\S]{0,200}?name:\\s*'${op}'`);
  return files.find(([, s]) => re.test(s));
}

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

describe('an op exposes what it declares', () => {
  test('every declared param is read somewhere in its own module', () => {
    const orphan: string[] = [];
    for (const op of operations) {
      const home = definitionOf(op.name);
      if (!home) continue;
      for (const key of Object.keys(op.params ?? {})) {
        // The declaration is one mention; anything wired reads it again.
        // Module-wide, not handler-only: `snippet_chars` is consumed by a
        // helper the handler calls, which a handler.toString() scan misses.
        if (home[1].split(key).length - 1 < 2) orphan.push(`${op.name}.${key} (${home[0]})`);
      }
    }
    expect(orphan).toEqual([]);
  });
});

describe('an op exposes what the engine can do', () => {
  /** Deliberately not caller-controlled. A reason each, because an allowlist
   *  without one becomes the place a real gap goes to hide. */
  const INTERNAL: Record<string, string> = {
    updated_after_keyset: 'pagination cursor, assembled by the delta verb, not asked for',
    source_ids:           'resolved from the caller auth scope; a caller naming it would widen its own grant',
    exclude_private:      'THE privacy predicate. Caller-controllable would make private pages requestable',
  };

  test('every PageFilters field is reachable from some op, or listed as internal with a reason', () => {
    const types = readFileSync('src/core/types.ts', 'utf8');
    const block = types.match(/export interface PageFilters \{[\s\S]*?\n\}/)?.[0];
    expect(block, 'PageFilters not found — this test is reading the wrong file').toBeTruthy();

    const fields = [...block!.matchAll(/^\s{2}(\w+)\??:/gm)].map(m => snake(m[1]));
    expect(fields.length).toBeGreaterThan(5); // the parse worked at all

    const exposed = new Set(operations.flatMap(o => Object.keys(o.params ?? {})).map(snake));
    const hidden = fields.filter(f => !exposed.has(f) && !(f in INTERNAL));

    // A field here is a capability the engine honours and no caller can ask
    // for. Either surface it on an op, or add it to INTERNAL with the reason.
    expect(hidden).toEqual([]);
  });

  test('the date window specifically is reachable — the gap this test exists for', () => {
    const listPages = operations.find(o => o.name === 'list_pages');
    expect(listPages).toBeTruthy();
    const params = Object.keys(listPages!.params ?? {});
    expect(params).toContain('effective_after');
    expect(params).toContain('effective_before');
  });
});
