#!/usr/bin/env bun
/**
 * The `cosmic-brand` patch (Synchromy/cosmic-hub#691): wire src/cosmic/brand.ts
 * into the places engine text leaves the process.
 *
 *   bun scripts/cosmic-brand.ts          apply (idempotent)
 *   bun scripts/cosmic-brand.ts --check  report, change nothing, exit 1 if anything is unapplied
 *
 * WHY A SCRIPT AND NOT A BRANCH. A branch rewording the engine's text would
 * touch some forty files that upstream edits every release, and conflict on
 * most rebuilds. This touches a dozen lines, each an exact anchor, and the
 * wording stays upstream's: brand.ts rewrites it at the edge, at runtime,
 * and only when COSMIC_BRAND is set. cosmic-patches.ts runs this after the
 * branch patches on every rebuild.
 *
 * 🔴 A MISSING ANCHOR IS A FAILURE, NEVER A SKIP. When upstream moves one of
 * these lines the rebuild must stop and name it, because a silently skipped
 * edit is an engine that says "gbrain" to customers again and passes every
 * test that does not look. The leak test (test/cosmic-brand.test.ts) is the
 * second net under this one.
 */
import { readFileSync, writeFileSync } from 'node:fs';

interface Edit { file: string; find: string; replace: string; import?: { names: string[]; from: string } }

const BRAND = (depth: string, names: string[]) => ({ names, from: `${depth}cosmic/brand.ts` });

export const EDITS: Edit[] = [
  // Every credential is minted here, so the new prefix is one line.
  { file: 'src/core/utils.ts',
    find: "return `${prefix}${randomBytes(32).toString('hex')}`;",
    replace: "return `${credentialPrefix(prefix)}${randomBytes(32).toString('hex')}`;",
    import: BRAND('../', ['credentialPrefix']) },
  // The three places a credential's KIND is read from its prefix. Each must
  // accept cosmic_ as well, or a new credential would be misclassified.
  { file: 'src/core/ops/sources.ts',
    find: "ctx.auth.clientId.startsWith('gbrain_cl_')",
    replace: "isCredential(ctx.auth.clientId, 'gbrain_cl_')",
    import: BRAND('../../', ['isCredential']) },
  { file: 'src/commands/serve-http.ts',
    find: "authInfo.clientId.startsWith('gbrain_cl_')",
    replace: "isCredential(authInfo.clientId, 'gbrain_cl_')",
    import: BRAND('../', ['isCredential', 'brandServerName', 'brandResourceName']) },
  { file: 'src/core/harness/delivery.ts',
    find: '/^gbrain_cl_[A-Za-z0-9_-]+$/.test(clientId)',
    replace: '/^(?:gbrain|cosmic)_cl_[A-Za-z0-9_-]+$/.test(clientId)' },
  // The server's name in the MCP handshake, HTTP and stdio.
  { file: 'src/commands/serve-http.ts',
    find: "{ name: 'gbrain', version: VERSION },",
    replace: "{ name: brandServerName('gbrain'), version: VERSION }," },
  { file: 'src/mcp/server.ts',
    find: "{ name: 'gbrain', version: VERSION },",
    replace: "{ name: brandServerName('gbrain'), version: VERSION },",
    import: BRAND('../', ['brandServerName']) },
  // The protected resource's name, read by every OAuth client that connects.
  { file: 'src/commands/serve-http.ts',
    find: "resourceName: 'GBrain MCP Server',",
    replace: "resourceName: brandResourceName('GBrain MCP Server')," },
  // Every tool schema leaves through buildToolDefs: HTTP tools/list,
  // request_tools and stdio.
  { file: 'src/mcp/tool-defs.ts',
    find: '    description: op.description,',
    replace: '    description: brandText(op.description),',
    import: BRAND('../', ['brandText']) },
  { file: 'src/mcp/tool-defs.ts',
    find: '...(p.description ? { description: p.description } : {}),',
    replace: '...(p.description ? { description: brandText(p.description) } : {}),' },
  { file: 'src/core/ops/request-tools.ts',
    find: 'one_line: firstSentenceOf(op.description)',
    replace: 'one_line: firstSentenceOf(brandText(op.description))',
    import: BRAND('../../', ['brandText']) },
  // The operating contract every connected agent reads first.
  { file: 'src/mcp/instructions.ts',
    find: '  if (!deploymentIdentity) return base;\n  return `${base}\\n\\nDeployment identity:\\n${deploymentIdentity}`;',
    replace: '  if (!deploymentIdentity) return brandText(base);\n  return brandText(`${base}\\n\\nDeployment identity:\\n${deploymentIdentity}`);',
    import: BRAND('../', ['brandText']) },
  // The error envelope: most "run `gbrain …`" suggestions travel in it.
  { file: 'src/core/ops/contract.ts',
    find: '      message: this.message,\n      suggestion: this.suggestion,',
    replace: '      message: brandText(this.message),\n      suggestion: this.suggestion === undefined ? undefined : brandText(this.suggestion),',
    import: BRAND('../../', ['brandText']) },
  // The hint on every remote put_page, the leak an agent meets most often.
  { file: 'src/core/ops/pages.ts',
    find: "      autoLinks = { skipped: 'remote', hint };\n      autoTimeline = { skipped: 'remote', hint };",
    replace: "      autoLinks = { skipped: 'remote', hint: brandText(hint) };\n      autoTimeline = { skipped: 'remote', hint: brandText(hint) };",
    import: BRAND('../../', ['brandText']) },
];

function addImport(src: string, names: string[], from: string): string {
  const line = `import { ${names.join(', ')} } from '${from}';`;
  const existing = new RegExp(`^import \\{([^}]*)\\} from '${from.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}';$`, 'm');
  const m = existing.exec(src);
  if (m) {
    const have = new Set(m[1].split(',').map((s) => s.trim()).filter(Boolean));
    const missing = names.filter((n) => !have.has(n));
    if (!missing.length) return src;
    return src.replace(existing, `import { ${[...have, ...missing].join(', ')} } from '${from}';`);
  }
  // After the first import, so a file's header comment stays on top.
  const first = /^import .*$/m.exec(src);
  if (!first) throw new Error(`no import line to anchor on (${from})`);
  const at = first.index + first[0].length;
  return `${src.slice(0, at)}\n${line}${src.slice(at)}`;
}

export function apply(root: string, check = false): { applied: string[]; already: string[]; missing: string[] } {
  const applied: string[] = [], already: string[] = [], missing: string[] = [];
  const files = new Map<string, string>();
  const read = (f: string) => files.get(f) ?? readFileSync(`${root}/${f}`, 'utf8');
  for (const e of EDITS) {
    let src = read(e.file);
    const label = `${e.file}: ${e.find.split('\n')[0].trim().slice(0, 70)}`;
    if (src.includes(e.replace)) already.push(label);
    else if (src.includes(e.find)) { src = src.replace(e.find, e.replace); applied.push(label); }
    else { missing.push(label); continue; }
    if (e.import) src = addImport(src, e.import.names, e.import.from);
    files.set(e.file, src);
  }
  if (!check && !missing.length) for (const [f, s] of files) writeFileSync(`${root}/${f}`, s);
  return { applied, already, missing };
}

if (import.meta.main) {
  const check = process.argv.includes('--check');
  const root = (await Bun.$`git rev-parse --show-toplevel`.quiet().text()).trim();
  const r = apply(root, check);
  for (const l of r.applied) console.log(`${check ? 'would apply' : 'applied'}  ${l}`);
  for (const l of r.already) console.log(`already    ${l}`);
  for (const l of r.missing) console.log(`MISSING    ${l}`);
  if (r.missing.length) {
    console.log(`\n${r.missing.length} anchor(s) not found: upstream moved them. Nothing was written. Update EDITS in scripts/cosmic-brand.ts.`);
    process.exit(1);
  }
  process.exit(check && r.applied.length ? 1 : 0);
}
