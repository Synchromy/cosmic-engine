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
