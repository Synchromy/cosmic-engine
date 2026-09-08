/**
 * list_pages gains `slug_prefix`, so a caller can ask for one directory.
 *
 * The filter layer has had `slugPrefix` since storage tiering — indexed by the
 * (source_id, slug) UNIQUE btree, so a range scan rather than a table walk —
 * but no operation exposed it. `PageFilters.slugPrefix` was reachable only
 * from inside the process, which meant every MCP and CLI caller wanting "the
 * pages under X/" had to ask for something broader and filter client-side.
 *
 * That is wrong whenever the pages you want do not share a type, and expensive
 * whenever they do: the cursor walk is serial by construction, so enumerating
 * one small directory costs the size of the whole brain.
 *
 * It only ever NARROWS a set the caller could already list — source scope, the
 * private-page predicate and the remote row cap are evaluated independently
 * and still apply — so it opens no new read surface. The last two tests pin
 * that rather than assuming it.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;

const op = operations.find((o) => o.name === 'list_pages')!;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as unknown as OperationContext['engine'],
    config: {} as OperationContext['config'],
    logger: console as unknown as OperationContext['logger'],
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  } as OperationContext;
}

async function slugs(params: Record<string, unknown>): Promise<string[]> {
  const res = (await op.handler(ctxOf(), params)) as { pages: Array<{ slug: string }> }
    | Array<{ slug: string }>;
  const pages = Array.isArray(res) ? res : res.pages;
  return pages.map((p) => p.slug).sort();
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Deliberately mixed types under one prefix: this is the case a type filter
  // cannot express, and the reason a prefix filter is not just a faster way to
  // ask the same question.
  for (const [slug, type] of [
    ['skills/alpha', 'guide'],
    ['skills/beta', 'concept'],
    ['skills/gamma', 'guide'],
    ['skillset/not-a-skill', 'guide'],   // shares the first 6 letters, not the prefix
    ['people/someone', 'entity'],
  ] as const) {
    await engine.putPage(slug, { type, title: slug, compiled_truth: `# ${slug}` } as never);
  }
});

afterAll(async () => {
  await engine.disconnect();
});

describe('list_pages slug_prefix', () => {
  test('returns one directory, whatever the pages in it are typed', async () => {
    expect(await slugs({ slug_prefix: 'skills/', limit: 100 }))
      .toEqual(['skills/alpha', 'skills/beta', 'skills/gamma']);
  });

  test('the separator is part of the prefix — a sibling that merely starts the same is out', async () => {
    // `skillset/not-a-skill` begins with "skills" and is NOT under "skills/".
    // Getting this wrong turns a directory listing into a substring match.
    const found = await slugs({ slug_prefix: 'skills/', limit: 100 });
    expect(found).not.toContain('skillset/not-a-skill');
  });

  test("trailing '/*' is accepted, the way bound_slug_prefixes is written", async () => {
    expect(await slugs({ slug_prefix: 'skills/*', limit: 100 }))
      .toEqual(await slugs({ slug_prefix: 'skills/', limit: 100 }));
  });

  test('it composes with type rather than replacing it', async () => {
    expect(await slugs({ slug_prefix: 'skills/', type: 'guide', limit: 100 }))
      .toEqual(['skills/alpha', 'skills/gamma']);
  });

  test('an empty prefix is "no filter", not a prefix that matches everything', async () => {
    // Passed through it would become LIKE '%' — the same rows by a slower
    // path, and an index scan turned into a table walk.
    const all = await slugs({ limit: 100 });
    expect(await slugs({ slug_prefix: '', limit: 100 })).toEqual(all);
  });

  test('a prefix matching nothing returns nothing, not everything', async () => {
    expect(await slugs({ slug_prefix: 'nothing-here/', limit: 100 })).toEqual([]);
  });

  test('LIKE metacharacters in the prefix are literal, not wildcards', async () => {
    // Unescaped, '%' would match every page — a prefix filter that widens is
    // worse than no prefix filter.
    expect(await slugs({ slug_prefix: '%', limit: 100 })).toEqual([]);
    expect(await slugs({ slug_prefix: 'skills/_lpha', limit: 100 })).toEqual([]);
  });
});
