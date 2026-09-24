# Synchromy patch set

`Synchromy/cosmic-engine` is a fork of `garrytan/gbrain`. It exists so Cosmic
runs an engine we control. A `cosmic/<tag>` branch is upstream's tag plus the
patches in **`cosmic/patches.json`**, merged in order, plus the files that
register carries.

Decided by Neel and Khoa on 2026-09-07 (cosmic-hub #108, U1 and U2): pin the
hub to this fork rather than to a released upstream tag, so product direction
stays ours if the maintainers decide differently. They did: on 2026-09-15
upstream declined five of our patches as new product surface, which is a
maintainer's call and not a community fix. Those patches are **permanent**
now, and this file used to say otherwise (cosmic-hub #692).

## The register is the list

`cosmic/patches.json` is the only list. This file explains it; it does not
repeat it. Print the current state with:

```
bun scripts/cosmic-patches.ts list
```

Each patch has a `state`:

| state | meaning | what happens to it |
|---|---|---|
| `upstream-open` | an upstream PR is open | carried until upstream answers |
| `permanent` | declined, or never offered | carried on every rebuild, for good |
| `landed` | upstream merged it | dropped at the next rebuild, with its branch |

`depends_on` records stacking. `c1-database-canonical` needs the three C1
patches under it, so when one of those stops, the rebuild says the others were
skipped because of it, rather than reporting four separate failures.

A patch is a `branch` merged onto the tag, or a `script` run on the result
after every branch and carried file. A script is for a change that must survive
upstream rewording: `cosmic-brand` (cosmic-hub #691) edits a dozen exact
anchors instead of rewording forty files, and fails naming the anchor when
upstream moves one. Its presence probe is a leak test over the real tool list.

`carry` is new files that are ours alone (this tooling and tests we kept when
their patch landed upstream). They are copied from the lane you rebuild from,
so nobody passes commits by hand. If upstream ever ships the same path, the
rebuild stops and asks whose it is.

`regenerate` is generated files. A conflict in one is settled by taking the
tag's copy and running its generator after the merges, which is what the file
itself asks for. The module size ledger is re-derived the same way.

## Commands

```
bun scripts/cosmic-patches.ts rebuild v0.49.0.0     # the lane, in ../cosmic-build-<tag>, with the patch tests
bun scripts/cosmic-patches.ts matrix v0.49.0.0 v0.53.0.0   # where each patch stops, per tag, no tests
bun scripts/cosmic-patches.ts reproduce             # rebuild our own base tag; must equal HEAD
bun scripts/cosmic-patches.ts status                # has upstream answered any PR differently?
bun scripts/cosmic-patches.ts pin-check             # is cosmic-hub's pin the head of this lane?
```

`scripts/rebuild-cosmic.sh <tag>` still works and calls `rebuild`.

A rebuild never touches your checkout: it builds in its own worktree. When a
patch conflicts it stops, leaves the merge open there, and names the patch and
the files. The fix is to rebase that patch's branch onto the new tag (or
resolve in place and push the result as the patch's new branch), point the
register at it, and run again.

## What proves it

- **`test/cosmic-patches.test.ts`**: one presence probe per patch, on the surface
  the patch adds. A patch the rebuild dropped fails there by name. A patch
  added to the register without a probe fails there too. All eight probes
  fail on plain upstream v0.48.5.0, which is what makes them worth running.
- **`reproduce`**: the register describes the lane completely only if
  rebuilding the lane's own base tag gives the lane back, byte for byte.
- **`status`** and **`pin-check`** exit non-zero on any change, so they can run
  unattended and still be noticed.

## When to run what

- Before every rebuild: `status`, so the register is current.
- After every change to a patch or the register: `reproduce`.
- After cosmic-hub moves its pin: `pin-check`.
- Cadence for rebuilding onto a new upstream tag: monthly, or when an upstream
  release carries a fix Cosmic needs; never per upstream release. Run `matrix`
  over the candidate tags first.

The hub pins the resulting SHA in its Dockerfile (cosmic-hub #352 was the
first).

## History that is not in the register

Not carried from the Mac-era 17: bounded person create and Google Contacts
staging (default off, unused in the hub topology, never upstreamed).

`cosmic/v0.48.3` is a parallel lane, not an ancestor of `cosmic/v0.48.5`; they
diverge at the v0.48.3.0 tag. It is not maintained.
