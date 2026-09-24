#!/usr/bin/env bun
/**
 * The Synchromy patch set, as one tool over one register (cosmic/patches.json).
 *
 *   bun scripts/cosmic-patches.ts list
 *   bun scripts/cosmic-patches.ts rebuild <upstream-tag> [--keep-going] [--no-test] [--no-regen] [--dir D] [--force]
 *   bun scripts/cosmic-patches.ts matrix <upstream-tag>...
 *   bun scripts/cosmic-patches.ts reproduce
 *   bun scripts/cosmic-patches.ts status
 *   bun scripts/cosmic-patches.ts pin-check [--sha SHA]
 *
 * WHY A REGISTER AND NOT A LIST IN PROSE
 *
 * On 2026-09-23 the list in PATCHES.md said every patch "is upstream-bound and
 * has an open upstream PR". Five of the eight had been declined eight days
 * earlier and two were never offered. The rebuild could not reproduce the lane
 * it was written for (a generated file conflicted on the SAME tag), two kept
 * tests survived only if somebody remembered to pass them by hand, and the pin
 * cosmic-hub runs was two merges behind the lane. Nothing reported any of it.
 * Each subcommand below exists to make one of those visible:
 *
 *   rebuild    the lane from a tag, in a throwaway worktree, never in yours
 *   matrix     rebuild onto several tags without tests: where does each patch stop?
 *   reproduce  rebuild the lane's OWN base tag and diff it against the lane.
 *              Empty means the register describes the lane completely.
 *   status     has upstream's answer on any PR changed since we last looked?
 *   pin-check  is the SHA cosmic-hub installs the head of this lane?
 */
import { $ } from 'bun';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export interface Patch {
  id: string;
  /** A branch merged onto the tag... */
  branch?: string;
  /** ...or a script run on the result, after the branches and the carried
   *  files. For a change that must survive upstream rewording: a branch
   *  touching text upstream edits every release conflicts on most rebuilds,
   *  a script with exact anchors fails only when an anchor moves, and says
   *  which. Exactly one of the two. */
  script?: string;
  what: string;
  state: 'permanent' | 'upstream-open' | 'landed';
  upstream: { pr: number | null; seen: 'open' | 'closed' | 'merged' | 'none'; checked: string; note?: string };
  since: string;
  depends_on: string[];
  hub_uses: string;
  tests: string[];
}
export interface Register {
  upstream_repo: string;
  lane: string;
  base_tag: string;
  hub: { repo: string; ref: string; dockerfile: string };
  patches: Patch[];
  carry: { path: string; why: string }[];
  regenerate: { path: string; command: string[] }[];
  ledger: string;
  held_back: { branch: string; pr: number; note: string }[];
  landed: { branch: string; pr: number; in: string }[];
}

export const REGISTER_PATH = 'cosmic/patches.json';

export function loadRegister(root: string): Register {
  return JSON.parse(readFileSync(join(root, REGISTER_PATH), 'utf8')) as Register;
}

/** v0.49.0.0 -> cosmic/v0.49.0, the naming the lanes already use. */
export function laneFor(tag: string): string {
  return `cosmic/${tag.replace(/\.0$/, '')}`;
}

/** The register as carried onto `tag`: same patches, the new lane and base. */
export function retarget(registerJson: string, tag: string): string {
  const reg = JSON.parse(registerJson) as Register;
  reg.lane = laneFor(tag);
  reg.base_tag = tag;
  return `${JSON.stringify(reg, null, 2)}\n`;
}

/** How a conflicted path is settled without a person, or null when it needs one.
 *  The ledger and generated files are rebuilt from scratch after the merges, so
 *  which side wins the textual merge does not matter; the tag's side is kept. */
export function autoResolution(path: string, reg: Register): 'ledger' | 'regenerate' | null {
  if (path === reg.ledger) return 'ledger';
  if (reg.regenerate.some(r => r.path === path)) return 'regenerate';
  return null;
}

type Outcome =
  | { id: string; result: 'merged' | 'merged-auto' }
  | { id: string; result: 'conflict'; files: string[] }
  | { id: string; result: 'skipped'; because: string };

interface BuildOpts { keepGoing: boolean; test: boolean; regen: boolean; dir?: string; branch?: string | null; force: boolean; carryFrom: string }

const root = (await $`git rev-parse --show-toplevel`.quiet().text()).trim();

async function ensureRemotes(reg: Register) {
  const remotes = (await $`git -C ${root} remote`.quiet().text()).split('\n');
  if (!remotes.includes('upstream')) await $`git -C ${root} remote add upstream https://github.com/${reg.upstream_repo}.git`;
}

async function fetchTag(tag: string) {
  // A tag, fetched by name. `--tags` would try to move upstream's floating
  // tags (latest-stable) and fail the whole fetch on a clobber.
  await $`git -C ${root} fetch -q upstream refs/tags/${tag}:refs/tags/${tag}`;
}

async function unmerged(dir: string): Promise<string[]> {
  const out = await $`git -C ${dir} diff --name-only --diff-filter=U`.quiet().text();
  return out.split('\n').filter(Boolean);
}

/** Port of the ledger step the bash rebuild had: every FAIL line names a file
 *  and its real size; write that size back and say which rebuild moved it. */
async function rederiveLedger(dir: string, reg: Register, tag: string) {
  if (!existsSync(join(dir, 'scripts/check-module-size.sh'))) return;
  // The check reports on stderr, which is why the bash version ran it 2>&1.
  const run = await $`bash scripts/check-module-size.sh`.cwd(dir).nothrow().quiet();
  const out = `${run.stdout}${run.stderr}`;
  const sizes = new Map<string, string>();
  for (const line of out.split('\n')) {
    const m = line.match(/^FAIL: (\S+) (?:is|shrank to) (\d+) lines/);
    if (m) sizes.set(m[1], m[2]);
  }
  if (sizes.size === 0) return;
  const path = join(dir, reg.ledger);
  const rows = readFileSync(path, 'utf8').split('\n').map(row => {
    const cols = row.split('\t');
    const n = sizes.get(cols[0]);
    if (n === undefined || cols.length < 2) return row;
    if (cols.length >= 4) cols[3] = `${cols[3]}; rebuilt on ${tag}: ${cols[1]}->${n}`;
    cols[1] = n;
    return cols.join('\t');
  });
  writeFileSync(path, rows.join('\n'));
}

async function build(tag: string, reg: Register, o: BuildOpts): Promise<{ dir: string; outcomes: Outcome[]; ok: boolean; testsOk: boolean | null; sha: string }> {
  await ensureRemotes(reg);
  await fetchTag(tag);
  await $`git -C ${root} fetch -q origin`;

  const dir = resolve(o.dir ?? join(root, '..', `cosmic-build-${tag}`));
  if (existsSync(dir)) {
    if (!o.force) throw new Error(`${dir} exists; pass --force to replace it`);
    await $`git -C ${root} worktree remove --force ${dir}`.nothrow().quiet();
    rmSync(dir, { recursive: true, force: true });
  }
  await $`git -C ${root} worktree add -q --detach ${dir} ${tag}`.quiet();
  if (o.branch) await $`git -C ${dir} checkout -q -B ${o.branch}`.quiet();

  const outcomes: Outcome[] = [];
  const failed = new Set<string>();
  for (const p of reg.patches) {
    if (p.script) continue;   // applied below, once the tree is whole
    const blocker = p.depends_on.find(d => failed.has(d));
    if (blocker) { outcomes.push({ id: p.id, result: 'skipped', because: blocker }); failed.add(p.id); continue; }
    const merge = await $`git -C ${dir} merge -q --no-edit --no-ff origin/${p.branch}`.nothrow().quiet();
    if (merge.exitCode === 0) { outcomes.push({ id: p.id, result: 'merged' }); continue; }
    const files = await unmerged(dir);
    if (files.length === 0) throw new Error(`merging ${p.branch} failed without a conflict:\n${merge.stderr}`);
    const real = files.filter(f => autoResolution(f, reg) === null);
    if (real.length === 0) {
      for (const f of files) await $`git -C ${dir} checkout -q --ours -- ${f}`.quiet();
      await $`git -C ${dir} add -- ${files}`.quiet();
      await $`git -C ${dir} -c core.editor=true merge --continue`.quiet();
      outcomes.push({ id: p.id, result: 'merged-auto' });
      continue;
    }
    outcomes.push({ id: p.id, result: 'conflict', files: real });
    failed.add(p.id);
    if (!o.keepGoing) {
      // Left conflicted on purpose: this worktree is where a person resolves it.
      return { dir, outcomes, ok: false, testsOk: null, sha: '' };
    }
    await $`git -C ${dir} merge --abort`.quiet();
  }

  // Carried files: new files that are ours alone. Copied from the ref this
  // tool runs on, so the lane's tooling and kept tests travel with it without
  // anyone passing commits by hand.
  const carried: string[] = [];
  for (const c of reg.carry) {
    const src = await $`git -C ${root} show ${o.carryFrom}:${c.path}`.nothrow().quiet();
    if (src.exitCode !== 0) throw new Error(`carry: ${c.path} is not in ${o.carryFrom}`);
    const atTag = await $`git -C ${root} cat-file -e ${tag}:${c.path}`.nothrow().quiet();
    if (atTag.exitCode === 0) {
      const theirs = await $`git -C ${root} show ${tag}:${c.path}`.quiet().text();
      if (theirs !== src.text()) throw new Error(`carry: upstream ${tag} now ships ${c.path}; decide whose it is before carrying it`);
    }
    mkdirSync(dirname(join(dir, c.path)), { recursive: true });
    // The register travels too, and on the new lane it must describe THAT lane,
    // or pin-check and reproduce there would still point at the old one.
    const body = c.path === REGISTER_PATH ? retarget(src.text(), tag) : src.stdout;
    writeFileSync(join(dir, c.path), body);
    const mode = (await $`git -C ${root} ls-tree ${o.carryFrom} -- ${c.path}`.quiet().text()).split(/\s/)[0];
    if (mode === '100755') chmodSync(join(dir, c.path), 0o755);
    carried.push(c.path);
  }
  await $`git -C ${dir} add -- ${carried}`.quiet();
  if ((await $`git -C ${dir} status --porcelain`.quiet().text()).trim())
    await $`git -C ${dir} commit -qm ${`chore: carry the Synchromy patch tooling and kept tests onto ${tag}`}`.quiet();

  if (o.regen || o.test || reg.patches.some(p => p.script)) await $`bun install --frozen-lockfile --silent`.cwd(dir).quiet();

  // Script patches run on the whole tree: every branch merged and every
  // carried file present, since a script may be one of the carried files.
  // Before regeneration, so generated files describe the patched engine.
  for (const p of reg.patches.filter(x => x.script)) {
    const blocker = p.depends_on.find(d => failed.has(d));
    if (blocker) { outcomes.push({ id: p.id, result: 'skipped', because: blocker }); failed.add(p.id); continue; }
    const run = await $`bun ${p.script!}`.cwd(dir).nothrow().quiet();
    if (run.exitCode !== 0) {
      const missing = `${run.stdout}`.split('\n').filter(l => l.startsWith('MISSING')).map(l => l.replace(/^MISSING\s+/, ''));
      outcomes.push({ id: p.id, result: 'conflict', files: missing.length ? missing : [`${p.script} exited ${run.exitCode}`] });
      failed.add(p.id);
      if (!o.keepGoing) return { dir, outcomes, ok: false, testsOk: null, sha: '' };
      continue;
    }
    outcomes.push({ id: p.id, result: 'merged' });
    if ((await $`git -C ${dir} status --porcelain`.quiet().text()).trim()) {
      await $`git -C ${dir} add -A`.quiet();
      await $`git -C ${dir} commit -qm ${`patch: ${p.id} (${p.script})`}`.quiet();
    }
  }

  if (o.regen) {
    for (const r of reg.regenerate) {
      const run = await $`${r.command}`.cwd(dir).nothrow().quiet();
      if (run.exitCode !== 0) throw new Error(`regenerate ${r.path}: ${r.command.join(' ')} failed\n${run.stderr}`);
    }
    await rederiveLedger(dir, reg, tag);
    if ((await $`git -C ${dir} status --porcelain`.quiet().text()).trim()) {
      await $`git -C ${dir} add -A`.quiet();
      await $`git -C ${dir} commit -qm ${`chore: regenerate generated files and re-derive the module size ledger on ${tag}`}`.quiet();
    }
  }

  const ok = outcomes.every(x => x.result === 'merged' || x.result === 'merged-auto');
  let testsOk: boolean | null = null;
  if (o.test && ok) {
    const files = [...new Set(['test/cosmic-patches.test.ts', ...reg.patches.flatMap(p => p.tests),
      ...reg.carry.map(c => c.path).filter(p => p.startsWith('test/') && p !== 'test/cosmic-patches.test.ts')])];
    const run = await $`bun test --timeout=60000 ${files}`.cwd(dir).env({ ...process.env, GBRAIN_EMBED_RETRY_MAX: '0' }).nothrow();
    testsOk = run.exitCode === 0;
  }
  const sha = (await $`git -C ${dir} rev-parse HEAD`.quiet().text()).trim();
  return { dir, outcomes, ok, testsOk, sha };
}

function cell(x: Outcome): string {
  switch (x.result) {
    case 'merged': return 'ok';
    case 'merged-auto': return 'ok*';
    case 'skipped': return `skip(${x.because})`;
    case 'conflict': return `CONFLICT ${x.files.join(',')}`;
  }
}

function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true;
}
function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name); if (i < 0) return undefined;
  const v = args[i + 1]; args.splice(i, 2); return v;
}

async function main(argv: string[]) {
  const [cmd, ...args] = argv;
  const reg = loadRegister(root);

  if (cmd === 'list') {
    for (const p of reg.patches)
      console.log([p.id.padEnd(36), p.state.padEnd(14), (p.upstream.pr ? `#${p.upstream.pr}` : '-').padEnd(6), p.upstream.seen.padEnd(7), p.since, p.script ? `script ${p.script}` : ''].join(' '));
    return 0;
  }

  if (cmd === 'rebuild') {
    const keepGoing = flag(args, '--keep-going'), noTest = flag(args, '--no-test'), noRegen = flag(args, '--no-regen'), force = flag(args, '--force');
    const dir = option(args, '--dir');
    const tag = args[0];
    if (!tag || args.length > 1) {
      console.error('usage: cosmic-patches.ts rebuild <upstream-tag> [--keep-going] [--no-test] [--no-regen] [--dir D] [--force]');
      if (args.length > 1) console.error('Carried commits are no longer passed by hand: add the file to "carry" in cosmic/patches.json.');
      return 2;
    }
    const r = await build(tag, reg, { keepGoing, test: !noTest, regen: !noRegen, dir, branch: laneFor(tag), force, carryFrom: 'HEAD' });
    for (const x of r.outcomes) console.log(`${x.id.padEnd(36)} ${cell(x)}`);
    if (!r.ok) {
      const c = r.outcomes.find(x => x.result === 'conflict');
      console.log(`\nSTOPPED at ${c?.id}. ${keepGoing ? '' : `The merge is left open in ${r.dir}: resolve it there, or rebase ${c ? reg.patches.find(p => p.id === c.id)?.branch : ''} onto ${tag} and point the register at the result.`}`);
      return 1;
    }
    if (r.testsOk === false) { console.log(`\nbuilt ${laneFor(tag)} at ${r.sha} in ${r.dir}, but the patch tests FAILED`); return 3; }
    console.log(`\n${laneFor(tag)} at ${r.sha} in ${r.dir}${r.testsOk ? ', patch tests passed' : ''}. Pin this SHA in cosmic-hub/Dockerfile once it is pushed.`);
    return 0;
  }

  if (cmd === 'matrix') {
    if (args.length === 0) { console.error('usage: cosmic-patches.ts matrix <upstream-tag>...'); return 2; }
    let worst = 0;
    for (const tag of args) {
      const dir = join(tmpdir(), `cosmic-matrix-${process.pid}-${tag}`);
      const r = await build(tag, reg, { keepGoing: true, test: false, regen: false, dir, branch: null, force: true, carryFrom: 'HEAD' });
      console.log(`${tag.padEnd(11)} ${r.outcomes.map(x => `${x.id}=${cell(x)}`).join('  ')}`);
      if (!r.ok) worst = 1;
      await $`git -C ${root} worktree remove --force ${dir}`.nothrow().quiet();
    }
    console.log('\nok = clean merge · ok* = only the ledger or a generated file conflicted, settled automatically');
    return worst;
  }

  if (cmd === 'reproduce') {
    const dir = join(tmpdir(), `cosmic-reproduce-${process.pid}`);
    const r = await build(reg.base_tag, reg, { keepGoing: false, test: false, regen: true, dir, branch: null, force: true, carryFrom: 'HEAD' });
    if (!r.ok) { for (const x of r.outcomes) console.log(`${x.id.padEnd(36)} ${cell(x)}`); await $`git -C ${root} worktree remove --force ${dir}`.nothrow().quiet(); return 1; }
    // The ledger is derived, like a generated file: its rows depend on merge
    // order and the ratchet's slack, so two correct builds can differ in it.
    // It is held to the check it exists for, on both sides, instead of bytes.
    const diff = await $`git -C ${root} diff --stat HEAD ${r.sha} -- . ${`:!${reg.ledger}`}`.quiet().text();
    const sizeCheck = async (cwd: string) => (await $`bash scripts/check-module-size.sh`.cwd(cwd).nothrow().quiet()).exitCode === 0;
    const builtOk = await sizeCheck(dir), laneOk = await sizeCheck(root);
    await $`git -C ${root} worktree remove --force ${dir}`.nothrow().quiet();
    let code = 0;
    if (diff.trim()) {
      console.log(`Rebuilding ${reg.base_tag} from the register does NOT give this lane. What the register misses:\n${diff}`);
      code = 1;
    } else console.log(`Rebuilding ${reg.base_tag} from the register reproduces HEAD (every file but the size ledger, byte for byte).`);
    console.log(`module size check: rebuilt ${builtOk ? 'passes' : 'FAILS'}, this lane ${laneOk ? 'passes' : 'FAILS'}`);
    if (!builtOk || !laneOk) code = 1;
    return code;
  }

  if (cmd === 'status') {
    let changed = 0;
    const rows = [
      ...reg.patches.map(p => ({ what: p.id, pr: p.upstream.pr, seen: p.upstream.seen })),
      ...reg.held_back.map(h => ({ what: `${h.branch} (held back)`, pr: h.pr, seen: 'closed' as const })),
    ];
    for (const row of rows) {
      if (!row.pr) { console.log(`${row.what.padEnd(48)} no upstream PR`); continue; }
      const j = JSON.parse(await $`gh api repos/${reg.upstream_repo}/pulls/${row.pr} --jq ${'{state: .state, merged: .merged_at}'}`.quiet().text());
      const now = j.merged ? 'merged' : j.state;
      const moved = now !== row.seen;
      if (moved) changed++;
      const advice = !moved ? '' : now === 'merged' ? '  -> landed: move it to "landed" and drop its branch at the next rebuild'
        : now === 'closed' ? '  -> declined: set state "permanent"' : '  -> reopened';
      console.log(`${row.what.padEnd(48)} #${String(row.pr).padEnd(5)} was ${row.seen.padEnd(6)} now ${now}${advice}`);
    }
    console.log(changed ? `\n${changed} changed since the register was last updated.` : '\nNothing changed upstream.');
    return changed ? 1 : 0;
  }

  if (cmd === 'pin-check') {
    let pin = option(args, '--sha');
    if (!pin) {
      const docker = await $`gh api ${`repos/${reg.hub.repo}/contents/${reg.hub.dockerfile}?ref=${reg.hub.ref}`} --jq .content`.quiet().text();
      const m = Buffer.from(docker, 'base64').toString('utf8').match(/cosmic-engine#([0-9a-f]{7,40})/);
      if (!m) { console.error(`no cosmic-engine#<sha> pin found in ${reg.hub.repo}/${reg.hub.dockerfile}`); return 2; }
      pin = m[1];
    }
    await $`git -C ${root} fetch -q origin`;
    const head = (await $`git -C ${root} rev-parse origin/${reg.lane}`.quiet().text()).trim();
    const full = (await $`git -C ${root} rev-parse ${pin}`.nothrow().quiet().text()).trim();
    if (full === head) { console.log(`pinned ${pin.slice(0, 9)} is the head of ${reg.lane}.`); return 0; }
    const onLane = (await $`git -C ${root} merge-base --is-ancestor ${pin} ${head}`.nothrow().quiet()).exitCode === 0;
    const ahead = (await $`git -C ${root} log --oneline --first-parent ${pin}..${head}`.nothrow().quiet().text()).trim();
    console.log(`pinned ${pin.slice(0, 9)} is NOT the head of ${reg.lane} (${head.slice(0, 9)}).`);
    console.log(onLane ? `The lane has moved on since the pin:\n${ahead}` : `The pin is not on ${reg.lane} at all.`);
    return 1;
  }

  console.error('usage: cosmic-patches.ts list | rebuild <tag> | matrix <tag>... | reproduce | status | pin-check [--sha SHA]');
  return 2;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
