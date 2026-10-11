/**
 * Every tool the MCP server lists carries the annotations a connector
 * directory review asks for (Synchromy/cosmic-hub#707): a plain title, and
 * readOnlyHint true for a read, destructiveHint true for a write that deletes
 * or irreversibly overwrites, or an explicit readOnlyHint false for any other
 * write. Built with buildToolDefs, the builder src/mcp/server.ts and the HTTP
 * transports use.
 */
import { describe, test, expect } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import { buildToolDefs } from '../src/mcp/tool-defs.ts';
import {
  TITLES, DESTRUCTIVE, OPEN_WORLD, WRITES_WITHOUT_MUTATING_FLAG, toolAnnotationsFor, titleFromName,
} from '../src/core/ops/tool-annotations.ts';

const defs = buildToolDefs(operations);
const strictDefs = buildToolDefs(operations, { strictParams: true });
const byName = new Map(operations.map(op => [op.name, op]));

describe('MCP tool annotations', () => {
  test('every tool name is 64 characters or fewer', () => {
    for (const d of defs) expect(d.name.length, d.name).toBeLessThanOrEqual(64);
  });

  test('every tool has a plain, non-empty title', () => {
    for (const d of [...defs, ...strictDefs]) {
      const title = d.annotations?.title;
      expect(typeof title, d.name).toBe('string');
      expect(title!.trim().length, d.name).toBeGreaterThan(0);
      expect(title, d.name).toBe(title!.trim());
      expect(title, d.name).not.toMatch(/[()[\]{}<>]/);
      expect(title, d.name).not.toMatch(/[‒-―]/); // figure, en, em, horizontal-bar dashes
      expect(title, d.name).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(title, d.name).not.toMatch(/gbrain/i);
      expect(title, d.name).not.toContain('_'); // a title is words, not the tool name
      expect(title!.length, d.name).toBeLessThanOrEqual(60);
    }
  });

  test('every op the server lists is named in the title table', () => {
    const missing = operations.map(op => op.name).filter(n => TITLES[n] === undefined);
    expect(missing).toEqual([]);
  });

  test('readOnlyHint true, or destructiveHint true, or an explicit readOnlyHint false', () => {
    for (const d of defs) {
      const a = d.annotations!;
      expect(typeof a.readOnlyHint, d.name).toBe('boolean');
      expect(typeof a.destructiveHint, d.name).toBe('boolean');
      expect(typeof a.openWorldHint, d.name).toBe('boolean');
      // Never both: a read-only tool cannot be destructive.
      expect(a.readOnlyHint && a.destructiveHint, d.name).toBe(false);
    }
  });

  test('the read/write split comes from the op itself', () => {
    for (const d of defs) {
      const op = byName.get(d.name)!;
      const expectRead = !op.mutating && !WRITES_WITHOUT_MUTATING_FLAG.has(op.name);
      expect(d.annotations!.readOnlyHint, d.name).toBe(expectRead);
      expect(d.annotations!.destructiveHint, d.name).toBe(!expectRead && DESTRUCTIVE.has(op.name));
      expect(d.annotations!.openWorldHint, d.name).toBe(OPEN_WORLD.has(op.name));
    }
  });

  test('every destructive, open-world or override entry names a mutating op or a real one', () => {
    // An entry may name an op a carried patch adds, so absence is allowed;
    // a present op listed as destructive must be a write.
    for (const n of DESTRUCTIVE) {
      const op = byName.get(n);
      if (op) expect(op.mutating === true || WRITES_WITHOUT_MUTATING_FLAG.has(n), n).toBe(true);
    }
    for (const n of WRITES_WITHOUT_MUTATING_FLAG) {
      const op = byName.get(n);
      if (op) expect(op.mutating, n).not.toBe(true);
    }
  });

  test('the ops reviewers look at first are classed as expected', () => {
    const cls = (n: string) => {
      const a = defs.find(d => d.name === n)?.annotations;
      if (!a) return 'absent';
      return a.readOnlyHint ? 'read' : a.destructiveHint ? 'destructive' : 'write';
    };
    for (const n of ['search', 'query', 'get_page', 'list_pages', 'recall', 'entity', 'synthesize', 'whoami']) {
      expect(cls(n), n).toBe('read');
    }
    for (const n of ['put_page', 'delete_page', 'remove_link', 'remove_tag', 'revert_version', 'forget', 'forget_fact']) {
      expect(cls(n), n).toBe('destructive');
    }
    for (const n of ['remember', 'capture', 'add_link', 'add_tag', 'think', 'request_tools']) {
      expect(cls(n), n).toBe('write');
    }
  });

  test('an inline idempotentHint survives; inline titles do not', () => {
    expect(byName.get('remember')!.annotations!.idempotentHint).toBe(true);
    expect(byName.get('forget')!.annotations!.idempotentHint).toBe(true);
    expect(byName.get('synthesize')!.annotations!.title).toBe(TITLES.synthesize);
  });

  test('an op the table does not know still gets a title', () => {
    const op = { ...operations[0]!, name: 'brand_new_tool', annotations: undefined, mutating: true };
    expect(titleFromName('brand_new_tool')).toBe('Brand new tool');
    expect(toolAnnotationsFor(op)).toEqual({
      title: 'Brand new tool', readOnlyHint: false, destructiveHint: false, openWorldHint: false,
    });
  });
});
