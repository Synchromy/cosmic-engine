/**
 * remember resolves its entity the way `entity` does, and refuses an entity
 * that matches no page (verbs/remember-entity.ts). Also pins entity's
 * near-miss order: name matches (resolve_slugs) before content matches.
 *
 * In-process through dispatchToolCall, against in-memory PGLite.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { RESPONSE_SCHEMAS } from '../src/core/verbs.ts';
import { validateAgainstSchema } from '../src/core/verbs/conformance.ts';
import { normalizeAlias } from '../src/core/search/alias-normalize.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await seed('companies/acme-example', 'Acme Example Io', 'company', 'A synthetic company.');
  await seed('people/alice-acme-example', 'Alice Example', 'person', 'Works at acme-example.');
  await seed('people/bob-builder', 'Bob Builder', 'person', 'A synthetic person.');
  await seed('inbox/drive/widget-sheet', 'Widget', 'document', 'A spreadsheet that shares a product name.');
  await seed('projects/gadget', 'Gadget Project', 'project', 'The gadget product.');
  await engine.setPageAliases('projects/gadget', 'default', [normalizeAlias('Gadget')]);
  await seed('notes/plain-note', 'Plain Note', 'note', 'A note with no entity shape.');
});

function localCtx(): OperationContext {
  return { engine, config: {} as never, logger: console as never, dryRun: false, remote: false, sourceId: 'default' } as OperationContext;
}

async function seed(slug: string, title: string, type: string, body: string) {
  await operationsByName['put_page'].handler(localCtx(), {
    slug,
    content: `---\ntitle: ${title}\ntype: ${type}\n---\n\n# ${title}\n\n${body}\n`,
  });
}

async function call(name: string, params: Record<string, unknown>) {
  const res = await dispatchToolCall(engine, name, params, { remote: true, sourceId: 'default' });
  const text = (res.content[0] as { text: string }).text;
  return { isError: res.isError === true, body: JSON.parse(text) as Record<string, any> };
}

async function remember(entity: string, fact = `a fact about ${entity} ${Math.random()}`) {
  return call('remember', { fact, provenance: 'test', entity });
}

async function factCount(entitySlug: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM facts WHERE source_id = 'default' AND entity_slug = $1`, [entitySlug]);
  return Number(rows[0]?.n ?? 0);
}

describe('remember: the entity resolves to the page entity would show', () => {
  it('an exact slug files there and says so', async () => {
    const { isError, body } = await remember('companies/acme-example');
    expect(isError).toBe(false);
    expect(body.status).toBe('inserted');
    expect(body.entity_slug).toBe('companies/acme-example');
    expect(body.entity_matched_by).toBe('slug');
    expect(validateAgainstSchema(body, RESPONSE_SCHEMAS.remember)).toEqual([]);
  });

  it('an exact title on an entity-shaped page files there', async () => {
    const { body } = await remember('Bob Builder');
    expect(body.entity_slug).toBe('people/bob-builder');
    expect(body.entity_matched_by).toBe('title');
  });

  it('an alias files under its page', async () => {
    const { body } = await remember('Gadget');
    expect(body.entity_slug).toBe('projects/gadget');
    expect(body.entity_matched_by).toBe('alias');
  });

  it('a bare name still reaches a person page by prefix expansion', async () => {
    const { isError, body } = await remember('Bob');
    expect(isError).toBe(false);
    expect(body.entity_slug).toBe('people/bob-builder');
    expect(body.entity_matched_by).toBe('name');
  });

  it('an explicit slug of a non-entity page is accepted: the caller named it', async () => {
    const { isError, body } = await remember('notes/plain-note');
    expect(isError).toBe(false);
    expect(body.entity_slug).toBe('notes/plain-note');
  });

  it('an entity-less fact is unchanged', async () => {
    const { isError, body } = await call('remember', { fact: 'no subject here', provenance: 'test' });
    expect(isError).toBe(false);
    expect(body.entity_slug).toBe(null);
    expect('entity_matched_by' in body).toBe(false);
  });
});

describe('remember: an entity with no page is refused, never filed silently', () => {
  it('a wrong directory prefix is refused, offering the page under the right one', async () => {
    const { isError, body } = await remember('orgs/acme-example');
    expect(isError).toBe(true);
    expect(body.error).toBe('not_found');
    expect(body.message).toContain('entity_not_found');
    expect(body.message).toContain('Nothing was saved');
    expect(body.suggestion).toContain('companies/acme-example');
    expect(body.protocol_version).toBe(1);
    const detail = JSON.parse(body.detail);
    expect(detail.entity).toBe('orgs/acme-example');
    expect(detail.suggestions[0].slug).toBe('companies/acme-example');
    expect(await factCount('orgs/acme-example')).toBe(0);
  });

  it('a name whose only title match is a non-entity page is refused, offering that page first', async () => {
    const { isError, body } = await remember('Widget');
    expect(isError).toBe(true);
    expect(body.message).toContain('inbox/drive/widget-sheet');
    const detail = JSON.parse(body.detail);
    expect(detail.suggestions[0]).toEqual({ slug: 'inbox/drive/widget-sheet', title: 'Widget', create_safety: 'exists' });
    expect(await factCount('widget')).toBe(0);
    expect(await factCount('inbox/drive/widget-sheet')).toBe(0);
  });

  it('a name that matches nothing is refused with a suggestion', async () => {
    const { isError, body } = await remember('zzz-nobody-at-all');
    expect(isError).toBe(true);
    expect(body.error).toBe('not_found');
    expect(typeof body.suggestion).toBe('string');
    expect(body.suggestion.length).toBeGreaterThan(0);
    expect(await factCount('zzz-nobody-at-all')).toBe(0);
  });

  it('once the page exists, the same call succeeds', async () => {
    await seed('orgs/new-example', 'New Example', 'company', 'Created after the refusal.');
    const { isError, body } = await remember('orgs/new-example');
    expect(isError).toBe(false);
    expect(body.entity_slug).toBe('orgs/new-example');
  });
});

describe('entity: a miss offers name matches before content matches', () => {
  it('a wrong directory prefix offers the page that shares the last segment', async () => {
    const { body } = await call('entity', { name: 'orgs/acme-example' });
    expect(body.found).toBe(false);
    expect(body.suggestions[0].slug).toBe('companies/acme-example');
    expect(body.suggestions[0].create_safety).toBe('probable');
  });

  it('a partial name offers the entity page ahead of other slug matches', async () => {
    const { body } = await call('entity', { name: 'acme' });
    expect(body.found).toBe(false);
    const slugs = (body.suggestions as Array<{ slug: string }>).map(s => s.slug);
    expect(slugs[0]).toBe('companies/acme-example');
    expect(slugs).toContain('people/alice-acme-example');
    expect(slugs.length).toBeLessThanOrEqual(5);
  });
});

describe('Codex review of #29', () => {
  it('the page remember checked is the page it writes under, never one a second lookup picks', async () => {
    await seed('people/alice.example', 'Alice Dotted', 'person', 'A public person page with a dotted slug.');
    await engine.setPageAliases('people/alice.example', 'default', [normalizeAlias('Alice Dotted Alias')]);
    await operationsByName['put_page'].handler(localCtx(), {
      slug: 'people/hidden-alice',
      content: '---\ntitle: Hidden Alice\ntype: person\nvisibility: private\n---\n\n# Hidden Alice\n\nPrivate.\n',
    });
    await engine.setPageAliases('people/hidden-alice', 'default', [normalizeAlias('people/alice.example')]);
    const { isError, body } = await remember('Alice Dotted Alias');
    expect(isError).toBe(false);
    expect(body.entity_slug).toBe('people/alice.example');
    expect(await factCount('people/hidden-alice')).toBe(0);
  });

  it('a project is not hidden by a newer document with the same title', async () => {
    await seed('projects/sprocket', 'Sprocket', 'project', 'The sprocket product.');
    await seed('inbox/drive/sprocket-doc', 'Sprocket', 'document', 'A newer document with the same title.');
    const { isError, body } = await remember('Sprocket');
    expect(isError).toBe(false);
    expect(body.entity_slug).toBe('projects/sprocket');
    const card = await call('entity', { name: 'Sprocket' });
    expect(card.body.card.entity.slug).toBe('projects/sprocket');
  });

  it('a private page never appears in a remote caller\'s suggestions', async () => {
    await operationsByName['put_page'].handler(localCtx(), {
      slug: 'companies/secretive-example',
      content: '---\ntitle: Secretive Example\ntype: company\nvisibility: private\n---\n\n# Secretive Example\n\nPrivate.\n',
    });
    const miss = await call('entity', { name: 'orgs/secretive-example' });
    expect(miss.body.found).toBe(false);
    expect(JSON.stringify(miss.body.suggestions)).not.toContain('companies/secretive-example');
    expect(JSON.stringify(miss.body.suggestions)).not.toContain('Secretive Example');
    const refused = await remember('orgs/secretive-example');
    expect(refused.isError).toBe(true);
    expect(refused.body.suggestion).not.toContain('companies/secretive-example');
    expect(JSON.parse(refused.body.detail).suggestions.map((x: { slug: string }) => x.slug)).not.toContain('companies/secretive-example');
  });
});

describe('a page deleted between the check and the write', () => {
  it('saves nothing and says so', async () => {
    const { writeSingleFact } = await import('../src/core/facts/write-single.ts');
    await seed('people/gone-example', 'Gone Example', 'person', 'Deleted below.');
    await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE slug = 'people/gone-example'`);
    await expect(writeSingleFact(engine, 'default', {
      fact: 'a fact about a page that was just deleted', provenance: 'test',
      resolvedEntitySlug: 'people/gone-example', visibility: 'world',
    })).rejects.toThrow('entity_not_found');
    expect(await factCount('people/gone-example')).toBe(0);
  });
});
