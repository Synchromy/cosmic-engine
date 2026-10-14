/**
 * The `cosmic-brand` patch holds: with COSMIC_BRAND set, nothing the engine
 * tells a connected agent names the engine (Synchromy/cosmic-hub#691).
 *
 * This is the leak test the rebuild runs. It builds the REAL tool list for
 * every operation a remote client can reach, not a sample, so a description
 * upstream adds next release is judged the day it lands. And it checks the
 * inverse just as hard: with COSMIC_BRAND unset the engine must be
 * byte-identical to upstream, which is what keeps upstream's own pinned
 * tests passing on our lane.
 *
 * Measured before the patch, on the v0.48.5 lane: 36 "gbrain" mentions, 41
 * release markers and 14 issue references across 124 remote tools, a
 * handshake opening "GBrain agent operating contract", and `whoami`
 * returning gbrain_cl_… .
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import { buildToolDefs } from '../src/mcp/tool-defs.ts';
import { resolveMcpInstructions } from '../src/mcp/instructions.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { generateToken } from '../src/core/utils.ts';
import { brandText, brandServerName, brandResourceName, isCredential, brandCapabilities } from '../src/cosmic/brand.ts';
import { describeAuthCapabilities } from '../src/core/harness/capabilities.ts';
import { apply } from '../scripts/cosmic-brand.ts';

const remote = operations.filter((op) => !op.localOnly);

/** khoa's own connection on 2026-09-24: read scope, no delegation. `whoami`
 *  answered with `gbrain auth rescope-client …` repair commands. */
const readOnly = () => describeAuthCapabilities({
  token: 't', clientId: 'gbrain_cl_5f8e', clientName: 'khoa-cosmic-agent', scopes: ['read'],
  sourceId: 'khoa', sourceActive: true, allowedSources: ['khoa'], grantRevision: 0, surface: 'starter',
} as never, { surface: 'starter', visibleOperations: ['whoami'] });
const LEAK = /(?<![\w-])gbrain(?![\w-])|gbrain:\/\/|GBRAIN_[A-Z_]+|\.gbrain-source|`gbrain /i;
const RELEASE = /\bv0\.\d+(?:\.\d+)*/;
const ISSUE = /#\d{4,5}\b/;

let saved: string | undefined;
beforeEach(() => { saved = process.env.COSMIC_BRAND; });
afterEach(() => { if (saved === undefined) delete process.env.COSMIC_BRAND; else process.env.COSMIC_BRAND = saved; });

describe('the patch is wired in', () => {
  test('every anchor in scripts/cosmic-brand.ts is applied on this tree', () => {
    const r = apply('.', true);
    expect(r.missing).toEqual([]);
    expect(r.applied).toEqual([]);
  });
});

describe('branded: what a connected agent reads', () => {
  beforeEach(() => { process.env.COSMIC_BRAND = 'Cosmic'; });

  test('no tool or parameter description names the engine, its releases or its issues', () => {
    const offenders: string[] = [];
    for (const def of buildToolDefs(remote, { strictParams: true })) {
      const texts = [def.description, ...Object.values(def.inputSchema.properties as Record<string, { description?: string }>)
        .map((p) => p.description ?? '')];
      for (const t of texts) {
        if (LEAK.test(t)) offenders.push(`${def.name}: gbrain — ${t.match(LEAK)![0]}`);
        if (RELEASE.test(t)) offenders.push(`${def.name}: release — ${t.match(RELEASE)![0]}`);
        if (ISSUE.test(t)) offenders.push(`${def.name}: issue — ${t.match(ISSUE)![0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('no description was emptied by the rewrite', () => {
    for (const def of buildToolDefs(remote)) expect(def.description.trim().length, def.name).toBeGreaterThan(0);
  });

  test('the handshake instructions are Cosmic', () => {
    const text = resolveMcpInstructions(null, { COSMIC_BRAND: 'Cosmic' });
    expect(text).not.toMatch(LEAK);
    expect(text).toContain('Cosmic agent operating contract');
    // The rules themselves survive: they are why the contract exists.
    expect(text).toContain('put_page REPLACES the entire page');
    // An address is rewritten to one that exists, never renamed into one that does not.
    expect(text).not.toContain('Cosmic://');
    expect(text).toContain('Read whoami to understand');
  });

  test('the server and the resource are named Cosmic', () => {
    expect(brandServerName('gbrain')).toBe('cosmic');
    expect(brandResourceName('GBrain MCP Server')).toBe('Cosmic');
  });

  test('a new credential is cosmic_, and both prefixes are accepted', () => {
    const id = generateToken('gbrain_cl_');
    expect(id.startsWith('cosmic_cl_')).toBe(true);
    expect(isCredential(id, 'gbrain_cl_')).toBe(true);
    expect(isCredential(`gbrain_cl_${'a'.repeat(64)}`, 'gbrain_cl_')).toBe(true);
    // An auth check never widens with config: only these two prefixes.
    expect(isCredential(`evil_cl_${'a'.repeat(64)}`, 'gbrain_cl_')).toBe(false);
    expect(isCredential(`cosmic_at_${'a'.repeat(64)}`, 'gbrain_cl_')).toBe(false);
  });

  test("whoami's repair tells the agent what it can do, not an engine command", () => {
    const before = readOnly();
    expect(JSON.stringify(before)).toMatch(/gbrain auth rescope-client/);   // the leak, reproduced
    const caps = brandCapabilities(before);
    expect(JSON.stringify(caps)).not.toMatch(LEAK);
    const repair = caps.delegation_repair as Record<string, unknown>;
    expect(repair.preview_command).toBeNull();
    expect(repair.missing_choices).toEqual((before.delegation_repair as Record<string, unknown>).missing_choices);
    for (const r of caps.remediation as Array<{ command: string }>) expect(r.command).toMatch(/operator of this Cosmic/);
  });

  test('an error suggestion does not send the agent to the engine CLI', () => {
    const e = new OperationError('schema_outdated', 'The brain schema is behind this gbrain release.',
      'Run `gbrain apply-migrations --yes` on the brain host. Then retry the call.');
    const j = e.toJSON();
    expect(`${j.message} ${j.suggestion}`).not.toMatch(LEAK);
    expect(j.suggestion).toBe('Then retry the call.');
  });
});

describe('unbranded: byte-identical to upstream', () => {
  beforeEach(() => { delete process.env.COSMIC_BRAND; });

  test('tool definitions are exactly what upstream emits', () => {
    const defs = buildToolDefs(remote);
    for (const def of defs) {
      const op = remote.find((o) => o.name === def.name)!;
      expect(def.description).toBe(op.description);
    }
  });

  test('the handshake, the names and new credentials are upstream\'s', () => {
    expect(resolveMcpInstructions(null, {})).toContain('GBrain agent operating contract');
    expect(brandServerName('gbrain')).toBe('gbrain');
    expect(brandResourceName('GBrain MCP Server')).toBe('GBrain MCP Server');
    expect(generateToken('gbrain_cl_').startsWith('gbrain_cl_')).toBe(true);
    expect(brandText('Run `gbrain doctor`.')).toBe('Run `gbrain doctor`.');
    const caps = readOnly();
    expect(brandCapabilities(caps)).toEqual(caps);
  });
});
