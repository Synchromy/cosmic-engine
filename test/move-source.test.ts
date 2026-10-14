import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { EMBED_WAITING_TABLE, movePageSource, SOURCE_ID_TABLES } from '../src/core/move-source.ts';
import { runPages } from '../src/commands/pages.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

// The embed-outage-defer patch creates this table on first use (src/core/embed-outage.ts). It is made
// here with the same shape so this test also runs on the bare tag, where that patch is absent.
async function ensureEmbedWaitingTable(e: PGLiteEngine) {
  await e.executeRaw(`CREATE TABLE IF NOT EXISTS cosmic_embed_waiting (
    source_id TEXT NOT NULL, slug TEXT NOT NULL, since TIMESTAMPTZ NOT NULL DEFAULT now(), reason TEXT,
    PRIMARY KEY (source_id, slug))`);
}

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 20_000);
afterAll(() => engine.disconnect());
beforeEach(() => resetPgliteState(engine), 20_000);

async function source(id: string) {
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $2)', [id, id]);
}
async function restricted(slug = 'notes/private') {
  await source('restricted');
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'secret' }, { sourceId: 'restricted' });
  return (await engine.getPage(slug, { sourceId: 'restricted' }))!;
}

describe('move-source', () => {
  test('makes an explicit decision for every source_id table, the lazily created one included', async () => {
    await ensureEmbedWaitingTable(engine);
    const found = await engine.executeRaw<{ table_name: string }>(
      "SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name WHERE c.column_name = 'source_id' AND c.table_schema = current_schema() AND t.table_type = 'BASE TABLE' ORDER BY c.table_name",
    );
    expect(found.map(r => r.table_name)).toEqual([...SOURCE_ID_TABLES, EMBED_WAITING_TABLE].map(r => r.table).sort());
    for (const t of SOURCE_ID_TABLES) expect(t.why.length).toBeGreaterThan(0);
  });

  test('keeps versions, re-keys aliases and embed waiting, and leaves leave-tables and other pages alone', async () => {
    const page = await restricted();
    await engine.createVersion(page.slug, { sourceId: 'restricted' });
    await engine.createVersion(page.slug, { sourceId: 'restricted' });
    await engine.putPage('notes/sibling', { type: 'note', title: 'sibling', compiled_truth: 'other' }, { sourceId: 'restricted' });
    await engine.executeRaw('INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ($1, $2, $3), ($1, $4, $5)',
      ['restricted', 'notes/old-private', page.slug, 'notes/old-sibling', 'notes/sibling']);
    await engine.executeRaw('INSERT INTO page_aliases (source_id, alias_norm, slug) VALUES ($1, $2, $3)', ['restricted', 'private', page.slug]);
    await ensureEmbedWaitingTable(engine);
    await engine.executeRaw('INSERT INTO cosmic_embed_waiting (source_id, slug) VALUES ($1, $2)', ['restricted', page.slug]);
    await engine.executeRaw('INSERT INTO ingest_log (source_id, source_type, source_ref, pages_updated, summary) VALUES ($1, $2, $3, $4, $5)',
      ['restricted', 'test', page.slug, '[]', 'landed restricted']);

    const result = await movePageSource(engine, { slug: page.slug, from: 'restricted', to: 'default' });
    expect(result.moved).toMatchObject({ pages: 1, slug_aliases: 1, page_aliases: 1, cosmic_embed_waiting: 1 });
    expect(await engine.executeRaw('SELECT 1 FROM page_versions WHERE page_id = $1', [page.id])).toHaveLength(2);
    expect(await engine.executeRaw('SELECT source_id FROM slug_aliases WHERE canonical_slug = $1', [page.slug])).toEqual([{ source_id: 'default' }]);
    expect(await engine.executeRaw('SELECT source_id FROM slug_aliases WHERE canonical_slug = $1', ['notes/sibling'])).toEqual([{ source_id: 'restricted' }]);
    expect(await engine.executeRaw('SELECT source_id FROM page_aliases WHERE slug = $1', [page.slug])).toEqual([{ source_id: 'default' }]);
    expect(await engine.executeRaw('SELECT source_id FROM cosmic_embed_waiting WHERE slug = $1', [page.slug])).toEqual([{ source_id: 'default' }]);
    expect(await engine.executeRaw('SELECT source_id FROM ingest_log WHERE source_ref = $1', [page.slug])).toEqual([{ source_id: 'restricted' }]);
    expect(await engine.getPage('notes/sibling', { sourceId: 'restricted' })).not.toBeNull();
  });

  test('refuses a soft-deleted destination twin', async () => {
    const page = await restricted();
    await engine.putPage(page.slug, { type: 'note', title: page.slug, compiled_truth: 'visible' });
    await engine.executeRaw("UPDATE pages SET deleted_at = now() WHERE source_id = 'default' AND slug = $1", [page.slug]);
    await expect(movePageSource(engine, { slug: page.slug, from: 'restricted', to: 'default' })).rejects.toThrow('already has a page');
    expect((await engine.getPage(page.slug, { sourceId: 'restricted' }))!.id).toBe(page.id);
  });

  test('refuses a move into restricted onto a page from a different origin, naming the origin', async () => {
    await restricted('people/ana');
    await engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter || '{"origin_source":"gmail"}'::jsonb WHERE source_id = 'restricted'`);
    await engine.putPage('people/ana', { type: 'person', title: 'Ana', compiled_truth: 'visible', frontmatter: { origin_source: 'attio' } });
    await expect(movePageSource(engine, { slug: 'people/ana', from: 'default', to: 'restricted' }))
      .rejects.toThrow("a restricted page from origin 'gmail' already holds 'people/ana'");
    expect(await engine.getPage('people/ana', { sourceId: 'default' })).not.toBeNull();
  });

  test('refuses an unknown destination, a missing page, the same source, and an ambiguous slug', async () => {
    const page = await restricted();
    await expect(movePageSource(engine, { slug: page.slug, from: 'restricted', to: 'nowhere' })).rejects.toThrow("'nowhere' does not exist");
    await expect(movePageSource(engine, { slug: 'notes/none', from: 'restricted', to: 'default' })).rejects.toThrow('no live page');
    await expect(movePageSource(engine, { slug: page.slug, from: 'restricted', to: 'restricted' })).rejects.toThrow('already the destination');
    await source('shared');
    await engine.putPage(page.slug, { type: 'note', title: page.slug, compiled_truth: 'also' }, { sourceId: 'shared' });
    await expect(movePageSource(engine, { slug: page.slug, to: 'default' })).rejects.toThrow("live in 'restricted', 'shared'");
    expect(await engine.executeRaw("SELECT source_id FROM pages WHERE slug = $1 ORDER BY source_id", [page.slug]))
      .toEqual([{ source_id: 'restricted' }, { source_id: 'shared' }]);
  });

  test('without --from, the one live page outside the destination is moved', async () => {
    const page = await restricted();
    const result = await movePageSource(engine, { slug: page.slug, to: 'default' });
    expect(result.from).toBe('restricted');
    expect((await engine.getPage(page.slug, { sourceId: 'default' }))!.id).toBe(page.id);
  });

  test('moves the page id and page-local rows, leaving unrelated source rows alone', async () => {
    const page = await restricted();
    await engine.putPage('notes/public', { type: 'note', title: 'public', compiled_truth: 'public' });
    await engine.upsertChunks(page.slug, [{ chunk_index: 0, chunk_text: 'secret', chunk_source: 'compiled_truth' }], { sourceId: 'restricted' });
    await engine.addTimelineEntriesBatch([{ slug: page.slug, date: '2026-01-01', summary: 'secret event', source_id: 'restricted' }]);
    await engine.executeRaw('INSERT INTO raw_data (page_id, source, data) VALUES ($1, $2, $3::text::jsonb)', [page.id, 'test', '{"kept":true}']);
    await engine.addLinksBatch([
      { from_slug: 'notes/public', to_slug: page.slug, from_source_id: 'default', to_source_id: 'restricted' },
      { from_slug: page.slug, to_slug: 'notes/public', from_source_id: 'restricted', to_source_id: 'default' },
    ]);
    await engine.executeRaw('INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ($1, $2, $3)', ['restricted', 'notes/old-private', page.slug]);
    await engine.executeRaw('INSERT INTO page_aliases (source_id, alias_norm, slug) VALUES ($1, $2, $3)', ['restricted', 'private', page.slug]);
    await engine.executeRaw("INSERT INTO facts (source_id, fact, source, source_markdown_slug) VALUES ($1, $2, $3, $4)", ['restricted', 'fenced fact', 'test', page.slug]);
    await engine.executeRaw("INSERT INTO facts (source_id, fact, source, source_markdown_slug) VALUES ($1, $2, $3, $4)", ['restricted', 'other fact', 'test', 'notes/other']);

    const result = await movePageSource(engine, { slug: page.slug, from: 'restricted', to: 'default' });
    expect(result.page_id).toBe(page.id);
    expect(result.moved.pages).toBe(1);
    expect(await engine.getPage(page.slug, { sourceId: 'restricted' })).toBeNull();
    expect((await engine.getPage(page.slug, { sourceId: 'default' }))!.id).toBe(page.id);
    expect(await engine.executeRaw('SELECT 1 FROM content_chunks WHERE page_id = $1', [page.id])).toHaveLength(1);
    expect(await engine.executeRaw('SELECT 1 FROM timeline_entries WHERE page_id = $1', [page.id])).toHaveLength(1);
    expect(await engine.executeRaw('SELECT 1 FROM raw_data WHERE page_id = $1', [page.id])).toHaveLength(1);
    expect(await engine.executeRaw('SELECT 1 FROM links WHERE from_page_id = $1 OR to_page_id = $1', [page.id])).toHaveLength(2);
    expect(await engine.executeRaw('SELECT 1 FROM facts WHERE source_id = $1 AND source_markdown_slug = $2', ['default', page.slug])).toHaveLength(1);
    expect(await engine.executeRaw('SELECT 1 FROM facts WHERE source_id = $1 AND source_markdown_slug = $2', ['restricted', 'notes/other'])).toHaveLength(1);
  });

  test('refuses a live destination twin without changing the source page', async () => {
    const page = await restricted();
    await engine.putPage(page.slug, { type: 'note', title: page.slug, compiled_truth: 'visible' });
    await expect(movePageSource(engine, { slug: page.slug, from: 'restricted', to: 'default' })).rejects.toThrow('already has a page');
    expect(await engine.getPage(page.slug, { sourceId: 'restricted' })).not.toBeNull();
  });

  test('dry run reports rows and changes nothing', async () => {
    const page = await restricted();
    const result = await movePageSource(engine, { slug: page.slug, from: 'restricted', to: 'default', dryRun: true });
    expect(result.dry_run).toBe(true);
    expect(result.moved.pages).toBe(1);
    expect(await engine.getPage(page.slug, { sourceId: 'restricted' })).not.toBeNull();
    expect(await engine.getPage(page.slug, { sourceId: 'default' })).toBeNull();
  });

  test('rolls all updates back when a later move action fails', async () => {
    const page = await restricted();
    await engine.executeRaw('INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ($1, $2, $3)', ['restricted', 'notes/old-private', page.slug]);
    await expect(movePageSource(engine, { slug: page.slug, from: 'restricted', to: 'default', beforeMoveTable: table => {
      if (table === 'slug_aliases') throw new Error('forced failure');
    }})).rejects.toThrow('forced failure');
    expect(await engine.getPage(page.slug, { sourceId: 'restricted' })).not.toBeNull();
    expect(await engine.executeRaw('SELECT 1 FROM slug_aliases WHERE source_id = $1', ['restricted'])).toHaveLength(1);
  });

  test('CLI prints the move result as JSON', async () => {
    const page = await restricted();
    const output: string[] = [];
    const original = console.log;
    console.log = value => output.push(String(value));
    try { await runPages(engine, ['move-source', page.slug, 'default', '--from', 'restricted', '--json']); }
    finally { console.log = original; }
    expect(JSON.parse(output.join('\n')).page_id).toBe(page.id);
  });
});
