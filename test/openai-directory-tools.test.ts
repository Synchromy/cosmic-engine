/**
 * Tool behaviour a public directory review checks: a client whose surface an
 * operator pinned is not offered request_tools, volunteer_context reads only
 * a short window and says so, and no description tells the model to prefer a
 * tool over another.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { operations } from '../src/core/operations.ts';
import { filterOpsForSurface, isSurfacePinned, withoutPinnedMetaOps } from '../src/mcp/surface.ts';
import { VOLUNTEER_MAX_WINDOW_TURNS } from '../src/core/ops/insights.ts';
import { parseWindow } from '../src/core/context/volunteer.ts';

const names = (ops: { name: string }[]) => ops.map(o => o.name);

describe('request_tools on an operator-pinned client', () => {
  for (const surface of ['starter', 'full'] as const) {
    it(`is dropped on ${surface} when the operator pinned the surface`, () => {
      const listed = withoutPinnedMetaOps(filterOpsForSurface(operations, surface), 'operator');
      expect(names(listed)).not.toContain('request_tools');
      expect(listed.length).toBe(filterOpsForSurface(operations, surface).length - 1);
    });
  }

  it('stays for a client that set its own surface or has none', () => {
    for (const setBy of ['self', 'dcr_default', undefined]) {
      expect(isSurfacePinned(setBy)).toBe(false);
      expect(names(withoutPinnedMetaOps(filterOpsForSurface(operations, 'starter'), setBy))).toContain('request_tools');
    }
  });

  it('serve-http feeds the filtered list to both tools/list and the dispatch allow-set', () => {
    const src = readFileSync('src/commands/serve-http.ts', 'utf8');
    expect(src).toContain('withoutPinnedMetaOps(filterOpsForSurface(mcpOperationsBase, surface), authInfo.surfaceSetBy)');
    expect(src).toContain("surface === 'full' && authInfo.allowedOperations == null && !isSurfacePinned(authInfo.surfaceSetBy) ? undefined");
  });
});

describe('volunteer_context reads a short window', () => {
  const op = operations.find(o => o.name === 'volunteer_context')!;

  it('describes the cap on the op and the window param', () => {
    expect(op.description).toContain(`at most ${VOLUNTEER_MAX_WINDOW_TURNS}`);
    expect(op.description).not.toContain('WITHOUT being asked');
    expect(String(op.params.window.description)).toContain(`only the newest ${VOLUNTEER_MAX_WINDOW_TURNS} are read`);
  });

  it('the handler keeps only the newest turns', () => {
    expect(readFileSync('src/core/ops/insights.ts', 'utf8'))
      .toContain('parseWindow(p.window).slice(-VOLUNTEER_MAX_WINDOW_TURNS)');
    const window = Array.from({ length: 20 }, (_, i) => `user: turn ${i}`).join('\n');
    const kept = parseWindow(window).slice(-VOLUNTEER_MAX_WINDOW_TURNS);
    expect(kept.length).toBe(VOLUNTEER_MAX_WINDOW_TURNS);
    expect(kept[0].text).toBe(`turn ${20 - VOLUNTEER_MAX_WINDOW_TURNS}`);
  });
});

describe('descriptions do not steer tool choice', () => {
  it('code_def no longer tells the model to use it before grep', () => {
    const op = operations.find(o => o.name === 'code_def')!;
    expect(op.description).not.toMatch(/before reaching for grep/i);
  });
});
