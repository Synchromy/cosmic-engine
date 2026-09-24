// A brain with no repo keeps its pages in the database only. The revision-
// guarded mutations must work there exactly as they do against a file:
// get_page hands out a canonical_revision, patch_page and append_page_event
// commit against it, receipts and replay behave the same, and no file is
// ever written. Before this, such a brain got `canonical_unavailable` from
// the safe path while whole-page put_page kept working.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { databaseCanonicalForm, readCanonicalPage } from '../src/core/canonical-page-mutations.ts';

let engine: PGLiteEngine;
let scratch: string;

const putPage = operations.find((op) => op.name === 'put_page')!;
const patchPage = operations.find((op) => op.name === 'patch_page')!;
const getPage = operations.find((op) => op.name === 'get_page')!;
const getVersions = operations.find((op) => op.name === 'get_versions')!;
const appendEvent = operations.find((op) => op.name === 'append_page_event')!;

function ctx(): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

/** A hosted writer: remote, scoped, exactly the caller that was locked out. */
function writerCtx(): OperationContext {
  return {
    ...ctx(),
    remote: true,
    transport: 'http',
    takesHoldersAllowList: ['world'],
    auth: { token: 'w', clientId: 'agent-mini', scopes: ['read', 'write'], sourceId: 'default' },
  } as OperationContext;
}

const PAGE = `---
type: note
title: Database only
data_class: personal
created: 2026-07-14
tags: [alpha, beta]
---

Body of the page.

<!-- timeline -->

- 2026-07-14: first line
`;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  resetGateway();
  scratch = mkdtempSync(join(tmpdir(), 'c1-db-'));
  // No sync.repo_path, no source local_path: the database is the only copy.
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

async function revisionOf(slug: string): Promise<string> {
  const page = await getPage.handler(writerCtx(), { slug }) as { canonical_revision?: string };
  expect(page.canonical_revision, 'get_page must hand out a revision on a database-canonical brain').toMatch(/^sha256:[0-9a-f]{64}$/);
  return page.canonical_revision!;
}

describe('a database-canonical brain', () => {
  test('🔴 readCanonicalPage resolves to the row, not to canonical_unavailable', async () => {
    await putPage.handler(ctx(), { slug: 'notes/db-only', content: PAGE });
    const snap = await readCanonicalPage(engine, 'notes/db-only', 'default');
    expect(snap.exists).toBe(true);
    expect('database' in snap.target).toBe(true);
    expect(snap.revision).toMatch(/^sha256:/);
    // The canonical form is a fixed point: rendering it again changes nothing.
    expect(databaseCanonicalForm(snap.content!, 'notes/db-only')).toBe(snap.content!);
  });

  test('a missing page reads as absent, never as an error', async () => {
    const snap = await readCanonicalPage(engine, 'notes/nowhere', 'default');
    expect(snap.exists).toBe(false);
    expect(snap.revision).toBeNull();
  });

  test('🔴 patch_page with the revision from get_page patches, versions, and returns the next revision', async () => {
    await putPage.handler(ctx(), { slug: 'notes/db-only', content: PAGE });
    const before = await revisionOf('notes/db-only');

    const r = await patchPage.handler(writerCtx(), {
      slug: 'notes/db-only',
      base_revision: before,
      title: 'Database only (patched)',
      frontmatter_set: { status: 'checked' },
    }) as { status: string; canonical_revision: string; projection_state: string };
    expect(r.status).toBe('patched');
    expect(r.projection_state).toBe('current');

    const page = await getPage.handler(writerCtx(), { slug: 'notes/db-only' }) as Record<string, unknown>;
    expect(page.title).toBe('Database only (patched)');
    expect((page.frontmatter as Record<string, unknown>).status).toBe('checked');
    expect((page.frontmatter as Record<string, unknown>).created).toBeDefined();

    // 🔴 The revision returned is the revision the next reader computes.
    // Without the canonical form this drifted (JSONB drops key order), and a
    // client chaining two patches would conflict on its own write.
    expect(await revisionOf('notes/db-only')).toBe(r.canonical_revision);

    const versions = await getVersions.handler(ctx(), { slug: 'notes/db-only' }) as unknown[];
    expect(versions.length).toBe(1);
  });

  test('a stale revision conflicts and changes nothing', async () => {
    await putPage.handler(ctx(), { slug: 'notes/db-only', content: PAGE });
    const before = await revisionOf('notes/db-only');
    await patchPage.handler(writerCtx(), { slug: 'notes/db-only', base_revision: before, title: 'First' });
    let code = '';
    try {
      await patchPage.handler(writerCtx(), { slug: 'notes/db-only', base_revision: before, title: 'Second' });
    } catch (e) {
      code = e instanceof OperationError ? e.code : 'other';
    }
    expect(code).toBe('revision_conflict');
    const page = await getPage.handler(writerCtx(), { slug: 'notes/db-only' }) as Record<string, unknown>;
    expect(page.title).toBe('First');
  });

  test('🔴 append_page_event appends with a receipt and replays on the same key, with no gate to switch on', async () => {
    await putPage.handler(ctx(), { slug: 'people/ahmed', content: PAGE.replace('title: Database only', 'title: Ahmed') });
    const event = { slug: 'people/ahmed', idempotency_key: 'gate4:2026-09-08', date: '2026-09-08', channel: 'check', note: 'append from the mini writer' };

    const first = await appendEvent.handler(writerCtx(), event) as { status: string; receipt: { canonical_revision: string } };
    expect(first.status).toBe('appended');
    expect(first.receipt.canonical_revision).toMatch(/^sha256:/);
    expect(await revisionOf('people/ahmed')).toBe(first.receipt.canonical_revision);

    const page = await getPage.handler(writerCtx(), { slug: 'people/ahmed', include_content: true }) as { content: string };
    expect(page.content).toContain('append from the mini writer');

    const again = await appendEvent.handler(writerCtx(), event) as { status: string };
    expect(again.status).toBe('replayed');
    const after = await getPage.handler(writerCtx(), { slug: 'people/ahmed', include_content: true }) as { content: string };
    expect(after.content.split('append from the mini writer').length).toBe(2);
  });

  test('append then patch chain on the revisions each returned', async () => {
    await putPage.handler(ctx(), { slug: 'people/ahmed', content: PAGE });
    const a = await appendEvent.handler(writerCtx(), { slug: 'people/ahmed', idempotency_key: 'k1', date: '2026-09-08', channel: 'email', note: 'one' }) as { receipt: { canonical_revision: string } };
    const p = await patchPage.handler(writerCtx(), { slug: 'people/ahmed', base_revision: a.receipt.canonical_revision, type: 'person' }) as { canonical_revision: string };
    const page = await getPage.handler(writerCtx(), { slug: 'people/ahmed', include_content: true }) as { type: string; content: string };
    expect(page.type).toBe('person');
    expect(page.content).toContain('one');
    expect(await revisionOf('people/ahmed')).toBe(p.canonical_revision);
  });

  test('nothing is written to disk', async () => {
    await putPage.handler(ctx(), { slug: 'notes/db-only', content: PAGE });
    const before = await revisionOf('notes/db-only');
    await patchPage.handler(writerCtx(), { slug: 'notes/db-only', base_revision: before, title: 'On disk?' });
    await appendEvent.handler(writerCtx(), { slug: 'notes/db-only', idempotency_key: 'k', date: '2026-09-08', channel: 'x', note: 'y' });
    expect(existsSync(join(scratch, 'notes'))).toBe(false);
    expect(readdirSync(scratch)).toEqual([]);
  });

  test('a configured repo that is missing is still an error, not a silent fall-through', async () => {
    await putPage.handler(ctx(), { slug: 'notes/db-only', content: PAGE });
    await engine.setConfig('sync.repo_path', join(scratch, 'gone'));
    let code = '';
    try {
      await readCanonicalPage(engine, 'notes/db-only', 'default');
    } catch (e) {
      code = (e as { code?: string }).code ?? 'other';
    }
    expect(code).toBe('canonical_unavailable');
  });
});
