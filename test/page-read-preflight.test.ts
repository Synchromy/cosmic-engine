import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readPageIdentity } from '../src/core/page-read-identity.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';
import { awaitPendingLastRetrievedWrites } from '../src/core/last-retrieved.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';

// PostgreSQL is opt-in and guarded. It uses an owned minimal relational fixture,
// not pgvector or full migrations. Actual engine methods execute every query.
const pgUrl = process.env.GBRAIN_TEST_PAGE_READ_DATABASE_URL;
if (pgUrl) assertSafeE2eDatabaseUrl(pgUrl);
const relationalFixture = `
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE sources (id text PRIMARY KEY, name text, local_path text, last_sync_at timestamptz, config jsonb DEFAULT '{}', archived boolean DEFAULT false);
CREATE TABLE pages (
 id serial PRIMARY KEY, source_id text NOT NULL DEFAULT 'default' REFERENCES sources(id),
 slug text NOT NULL, type text DEFAULT 'note', title text, compiled_truth text DEFAULT '', timeline text DEFAULT '',
 frontmatter jsonb DEFAULT '{}', content_hash text DEFAULT '', created_at timestamptz DEFAULT now(),
 updated_at timestamptz DEFAULT now(), deleted_at timestamptz, last_retrieved_at timestamptz,
 effective_date timestamptz, effective_date_source text, source_kind text, source_uri text, source_path text,
 ingested_via text, ingested_at timestamptz, contextual_retrieval_mode text,
 UNIQUE(source_id,slug));
CREATE TABLE tags (page_id int REFERENCES pages(id) ON DELETE CASCADE, tag text);
CREATE TABLE slug_aliases (id serial PRIMARY KEY, source_id text, alias_slug text, canonical_slug text);
CREATE TABLE config (key text PRIMARY KEY, value text, updated_at timestamptz DEFAULT now());
`;

for (const backend of ['pglite', 'postgres'] as const) {
  const suite = backend === 'postgres' && !pgUrl ? describe.skip : describe;
  suite(backend + ' authorized page read preflight', () => {
    let engine: BrainEngine;
    beforeAll(async () => {
      if (backend === 'pglite') {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
      } else {
        engine = new PostgresEngine();
        await engine.connect({ database_url: pgUrl!, poolSize: 2 } as any);
        // This URL is caller-supplied only through the dedicated test variable;
        // the safety guard above is mandatory before destructive fixture setup.
        await engine.executeRaw('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
        for (const statement of relationalFixture.split(';').filter(x => x.trim())) {
          await engine.executeRaw(statement);
        }
      }
      for (const source of ['default', 'alpha', 'beta']) {
        await engine.executeRaw("INSERT INTO sources (id,name) VALUES ($1,$1) ON CONFLICT(id) DO NOTHING", [source]);
      }
    }, 60_000);
    beforeEach(async () => {
      await awaitPendingLastRetrievedWrites();
      await engine.executeRaw('TRUNCATE pages CASCADE');
      await engine.executeRaw('DELETE FROM slug_aliases');
      await engine.executeRaw('UPDATE sources SET archived = false');
      await engine.executeRaw('DELETE FROM config');
      __resetPrivateVisibilityCacheForTests();
    });
    afterAll(async () => { await awaitPendingLastRetrievedWrites(); await engine?.disconnect(); });

    async function seed(slug = 'notes/admitted', source = 'default', visibility = 'world') {
      const rows = await engine.executeRaw<{ id: number }>(`INSERT INTO pages
        (slug, source_id, type, title, compiled_truth, timeline, frontmatter)
        VALUES ($1,$2,'note','Synthetic page','synthetic body','synthetic timeline',
          jsonb_build_object('visibility',$3::text)) RETURNING id`, [slug, source, visibility]);
      return Number(rows[0].id);
    }
    function ctx(overrides: Partial<OperationContext> = {}): OperationContext {
      return { engine, config: {} as any, logger: console, dryRun: false,
        remote: true, sourceId: 'default', ...overrides };
    }
    async function read(name = 'get_page', params: Record<string, unknown> = { slug: 'notes/admitted' },
      overrides: Partial<OperationContext> = {}): Promise<any> {
      return operations.find(op => op.name === name)!.handler(ctx(overrides), params);
    }
    function observed() {
      const calls: string[] = [];
      const wrapped = new Proxy(engine, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            if (['getPageIdentity', 'getPage', 'getTags'].includes(String(key))) calls.push(String(key));
            if (key === 'executeRaw' && /UPDATE pages SET last_retrieved_at/i.test(String(args[0]))) calls.push('stamp');
            return value.apply(target, args);
          };
        },
      });
      return { calls, wrapped };
    }
    async function unstamped() {
      await awaitPendingLastRetrievedWrites();
      const rows = await engine.executeRaw('SELECT id FROM pages WHERE last_retrieved_at IS NOT NULL');
      expect(rows).toHaveLength(0);
    }

    for (const name of ['get_page', 'fetch'] as const) {
      test(name + ' refuses before body, tags, canonical revision or retrieval stamps', async () => {
        const id = await seed();
        const { calls, wrapped } = observed();
        await expect(read(name, name === 'get_page'
          ? { slug: 'notes/admitted', include_content: true } : { id: 'notes/admitted' }, {
          engine: wrapped,
          beforePageRead: async target => {
            expect(Object.isFrozen(target)).toBe(true);
            expect(target).toEqual({ operation: name, id, source_id: 'default', slug: 'notes/admitted' });
            calls.push('admit');
            throw new OperationError('read_only', 'synthetic refusal');
          },
        })).rejects.toThrow('synthetic refusal');
        expect(calls).toEqual(['getPageIdentity', 'admit']);
        await unstamped();
      });
      test(name + ' never selects a replacement body at an admitted slug', async () => {
        const original = await seed();
        const { calls, wrapped } = observed();
        await expect(read(name, name === 'get_page' ? { slug: 'notes/admitted' } : { id: 'notes/admitted' }, {
          engine: wrapped,
          beforePageRead: async () => {
            await engine.executeRaw('DELETE FROM pages WHERE id = $1', [original]);
            const replacement = await seed();
            expect(replacement).not.toBe(original);
          },
        })).rejects.toThrow('Page is no longer available');
        expect(calls).toEqual(['getPageIdentity', 'getPage']);
        await unstamped();
      });
      test(name + ' supports absent callback and preserves its response', async () => {
        const id = await seed();
        await engine.executeRaw("INSERT INTO tags (page_id,tag) VALUES ($1,'synthetic-tag')", [id]);
        const output = await read(name, name === 'get_page'
          ? { slug: 'notes/admitted', include_content: true } : { id: '  notes/admitted  ' });
        if (name === 'get_page') {
          expect(output.id).toBe(id);
          expect(output.compiled_truth).toBe('synthetic body');
          expect(output.content).toContain('synthetic timeline');
          expect(output.tags).toEqual(['synthetic-tag']);
          expect(output.canonical_revision).toBeString();
          expect(output).not.toHaveProperty('private');
        } else {
          expect(Object.keys(output).sort()).toEqual(['id', 'metadata', 'text', 'title', 'url']);
          expect(output.id).toBe('notes/admitted');
          expect(output.text).toContain('synthetic body');
          expect(output.metadata.tags).toEqual(['synthetic-tag']);
        }
      });
    }
    test('metadata projection excludes bodies and matches source precedence', async () => {
      await seed('same', 'alpha', 'private');
      const beta = await seed('same', 'beta');
      const chosen = await engine.getPageIdentity('same', { sourceIds: ['beta', 'alpha'], sourceId: 'alpha' });
      expect(chosen).toEqual({ id: beta, source_id: 'beta', slug: 'same', private: false });
      expect(await engine.getPageIdentity('same', { sourceId: 'alpha', excludePrivate: true })).toBeNull();
      expect(await engine.getPage('same', { sourceId: 'beta', expectedPageId: beta + 100 })).toBeNull();
    });
    test('admission occurs exactly once before full reads and content remains opt-in', async () => {
      await seed();
      const { calls, wrapped } = observed();
      const output = await read('get_page', { slug: 'notes/admitted', beforePageRead: true, _meta: { admitted: true } }, {
        engine: wrapped, beforePageRead: async () => { calls.push('admit'); },
      });
      expect(calls.slice(0, 3)).toEqual(['getPageIdentity', 'admit', 'getPage']);
      expect(calls.filter(x => x === 'admit')).toHaveLength(1);
      expect(output).not.toHaveProperty('content');
      expect(output).not.toHaveProperty('resolved_slug');
    });
    test('fetch private anchor does not substitute public namesake; get_page retains filtered selection', async () => {
      await seed('same', 'alpha', 'private');
      const beta = await seed('same', 'beta');
      const grants = { auth: { allowedSources: ['alpha', 'beta'] } as any, sourceId: 'alpha' };
      await expect(read('fetch', { id: 'same' }, grants)).rejects.toThrow('Page not found');
      const result = await read('get_page', { slug: 'same' }, grants);
      expect(result.id).toBe(beta);
    });
    test('alias binds source owner and canonical identity ahead of fuzzy fallback', async () => {
      await seed('canonical', 'alpha');
      const beta = await seed('canonical', 'beta');
      await engine.executeRaw("INSERT INTO slug_aliases(source_id,alias_slug,canonical_slug) VALUES ('beta','retired','canonical')");
      const got: number[] = [];
      const result = await read('get_page', { slug: 'retired', fuzzy: true }, {
        auth: { allowedSources: ['alpha', 'beta'] } as any, sourceId: 'alpha',
        beforePageRead: async target => { got.push(target.id); },
      });
      expect(got).toEqual([beta]);
      expect(result.source_id).toBe('beta');
      expect(result.resolved_slug).toBe('canonical');
    });
    test('authorized deleted exact shell wins over alias; ordinary read follows live alias', async () => {
      const shell = await seed('retired');
      const live = await seed('canonical');
      await engine.executeRaw('UPDATE pages SET deleted_at = now() WHERE id = $1', [shell]);
      await engine.executeRaw("INSERT INTO slug_aliases(source_id,alias_slug,canonical_slug) VALUES ('default','retired','canonical')");
      expect((await read('get_page', { slug: 'retired', include_deleted: true })).id).toBe(shell);
      expect((await read('get_page', { slug: 'retired' })).id).toBe(live);
      await expect(read('fetch', { id: 'retired' })).rejects.toThrow('Page not found');
    });
    test('fuzzy single result and ambiguity preserve output without admitting ambiguity', async () => {
      const one = await seed('notes/unique-fragment-one');
      expect((await read('get_page', { slug: 'unique-fragment', fuzzy: true })).id).toBe(one);
      await seed('notes/unique-fragment-two');
      let admitted = false;
      const result = await read('get_page', { slug: 'unique-fragment', fuzzy: true }, {
        beforePageRead: async () => { admitted = true; },
      });
      expect(result.error).toBe('ambiguous_slug');
      expect(result.candidates.sort()).toEqual(['notes/unique-fragment-one', 'notes/unique-fragment-two']);
      expect(admitted).toBe(false);
    });
    test('private, missing and out-of-grant errors never admit or load bodies', async () => {
      await seed('private', 'default', 'private');
      await seed('outside', 'beta');
      const { calls, wrapped } = observed();
      for (const slug of ['private', 'outside', 'missing']) {
        await expect(read('get_page', { slug }, {
          engine: wrapped, beforePageRead: async () => { calls.push('admit'); },
        })).rejects.toThrow('Page not found');
      }
      expect(calls.every(x => x === 'getPageIdentity')).toBe(true);
      await unstamped();
    });
    test('trusted local alternate-source diagnostics are metadata-only', async () => {
      await seed('outside', 'beta');
      const { calls, wrapped } = observed();
      let error: any;
      try { await read('get_page', { slug: 'outside' }, { engine: wrapped, remote: false }); } catch (e) { error = e; }
      expect(error.code).toBe('page_not_found');
      expect(error.suggestion).toContain("source 'beta'");
      expect(calls.every(x => x === 'getPageIdentity')).toBe(true);
    });
    test('explicit archived source fails while implicit recovery keeps its existing semantics', async () => {
      const id = await seed('archived', 'alpha');
      await engine.executeRaw("UPDATE sources SET archived = true WHERE id = 'alpha'");
      const grants = { sourceId: 'alpha', auth: { allowedSources: ['alpha'] } as any };
      await expect(read('get_page', { slug: 'archived', source_id: 'alpha', include_deleted: true }, grants)).rejects.toThrow('removed or archived');
      expect((await read('get_page', { slug: 'archived', include_deleted: true }, grants)).id).toBe(id);
    });
    for (const change of ['rename', 'private', 'deleted', 'grant', 'archive'] as const) {
      test(change + ' during admission cannot return inaccessible/substituted content', async () => {
        const id = await seed('notes/admitted', 'alpha');
        const caller = ctx({ sourceId: 'alpha', auth: { allowedSources: ['alpha'] } as any });
        caller.beforePageRead = async () => {
          if (change === 'rename') await engine.executeRaw("UPDATE pages SET slug='moved' WHERE id=$1", [id]);
          if (change === 'private') await engine.executeRaw(`UPDATE pages SET frontmatter='{"visibility":"private"}'::jsonb WHERE id=$1`, [id]);
          if (change === 'deleted') await engine.executeRaw('UPDATE pages SET deleted_at=now() WHERE id=$1', [id]);
          if (change === 'archive') await engine.executeRaw("UPDATE sources SET archived=true WHERE id='alpha'");
          if (change === 'grant') caller.auth!.allowedSources = ['beta'];
        };
        await expect(operations.find(op => op.name === 'get_page')!.handler(caller,
          { slug: 'notes/admitted', source_id: 'alpha' })).rejects.toBeInstanceOf(OperationError);
        await unstamped();
      });
    }
    test('authorized include_deleted still succeeds if deletion happens during admission', async () => {
      const id = await seed();
      const result = await read('get_page', { slug: 'notes/admitted', include_deleted: true }, {
        beforePageRead: async () => { await engine.executeRaw('UPDATE pages SET deleted_at=now() WHERE id=$1', [id]); },
      });
      expect(result.id).toBe(id);
      expect(result.deleted_at).not.toBeNull();
    });
    test('trusted visibility opt-out preserves remote body fence sanitization', async () => {
      await seed('private', 'default', 'private');
      await engine.executeRaw("INSERT INTO config(key,value) VALUES ('search.remote_private_pages','visible')");
      await engine.executeRaw("UPDATE pages SET compiled_truth=$1 WHERE slug='private'", [
        'public section\n<!--- gbrain:takes:begin -->\nPRIVATE-FENCE\n<!--- gbrain:takes:end -->',
      ]);
      const result = await read('get_page', { slug: 'private', include_content: true });
      expect(result.compiled_truth).toContain('public section');
      expect(result.content).not.toContain('PRIVATE-FENCE');
    });
    if (backend === 'postgres') {
      test('metadata SQL retains scoped PostgreSQL RLS transaction', async () => {
        await seed('same', 'alpha');
        await engine.executeRaw("DROP ROLE IF EXISTS page_preflight_reader");
        await engine.executeRaw("CREATE ROLE page_preflight_reader LOGIN");
        await engine.executeRaw("GRANT USAGE ON SCHEMA public TO page_preflight_reader");
        await engine.executeRaw("GRANT SELECT ON pages TO page_preflight_reader");
        await engine.executeRaw("ALTER TABLE pages ENABLE ROW LEVEL SECURITY");
        await engine.executeRaw(`CREATE POLICY page_preflight_scope ON pages USING
          (source_id = ANY(string_to_array(current_setting('app.scopes',true),',')))`);
        const url = new URL(pgUrl!); url.username = 'page_preflight_reader';
        const reader = new PostgresEngine();
        const previous = process.env.GBRAIN_RLS_SCOPE_BINDING;
        try {
          await reader.connect({ database_url: url.toString(), poolSize: 1 } as any);
          process.env.GBRAIN_RLS_SCOPE_BINDING = '1';
          expect(await reader.getPageIdentity('same', { sourceId: 'alpha' })).toMatchObject({ source_id: 'alpha' });
          delete process.env.GBRAIN_RLS_SCOPE_BINDING;
          expect(await reader.getPageIdentity('same', { sourceId: 'alpha' })).toBeNull();
        } finally {
          if (previous === undefined) delete process.env.GBRAIN_RLS_SCOPE_BINDING;
          else process.env.GBRAIN_RLS_SCOPE_BINDING = previous;
          await reader.disconnect();
          await engine.executeRaw('DROP POLICY page_preflight_scope ON pages');
          await engine.executeRaw('ALTER TABLE pages DISABLE ROW LEVEL SECURITY');
          await engine.executeRaw('DROP OWNED BY page_preflight_reader');
          await engine.executeRaw('DROP ROLE page_preflight_reader');
        }
      });
    }
  });
}

test('metadata query projects only identity and visibility, with one bounded query', async () => {
  let count = 0;
  await readPageIdentity(async (sql, params) => {
    count++;
    expect(sql).not.toMatch(/compiled_truth|timeline|title|SELECT \*|tags|canonical_revision/);
    expect(sql).toContain("frontmatter->>'visibility'");
    expect(sql).toContain('LIMIT 1');
    expect(params).toContain('synthetic');
    return [];
  }, 'synthetic');
  expect(count).toBe(1);
});
