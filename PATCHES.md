# Synchromy patch set

`Synchromy/cosmic-engine` is a fork of `garrytan/gbrain`. It exists so Cosmic
runs an engine we control: every patch here is upstream-bound and has an open
upstream pull request, and a `cosmic/<tag>` branch is upstream's tag plus these
branches merged in order. Anything proprietary lives in `cosmic-hub`, never
here, so the branch can always be rebuilt on the next upstream tag.

Decided by Neel and Khoa on 2026-09-07 (cosmic-hub #108, U1 and U2): pin the
hub to this fork rather than to a released upstream tag, so product direction
stays ours if the maintainers decide differently.

## Order matters

Stacked branches share commits; merging in this order keeps the history clean.
One line per branch: `<branch>  <upstream PR>  <what>`.

```
upstream/c1-contained-mutations         #4834  revision-guarded canonical page mutations, receipts
upstream/lock-fact-reconciliation       #4835  serialise destructive fact reconciliation
upstream/extract-facts-pause-marker     #4836  extract_facts fails closed on an operator pause marker
upstream/idempotent-append-page-event   #4837  append_page_event, idempotent typed interaction append
upstream/patch-page-type-title          #4838  patch_page accepts dedicated type and title fields
upstream/facts-since-composition        #4882  recall composes entity, session_id and since
upstream/exact-id-precedence            #4883  exact opaque-identifier precedence (KNOBS_HASH_VERSION 29)
```

Superseded in part by upstream: `upstream/chronicle-visibility` (#4881).
Upstream v0.48.3.0 (#4941) gates the chronicle timeline reads itself; the
ontology-provenance and `volunteer_chronicle` half is carried as a commit on
the `cosmic/` branch, with the original test kept in full.

Not carried from the Mac-era 17: bounded person create and Google Contacts
staging (default off, unused in the hub topology, never upstreamed).

## Rebuild on a new upstream tag

```
scripts/rebuild-cosmic.sh v0.48.4.0
```

Fetches the tag, creates `cosmic/v0.48.4`, merges the branches above in
order, resolves the module size ledger to upstream's side and re-derives it,
cherry-picks the carried commits, runs the touched test files. It stops at
the first real conflict and says which branch. When an upstream PR merges,
delete its line here and its branch; the next rebuild carries one patch less.

The hub pins the resulting SHA in its Dockerfile (cosmic-hub #352 is the
first). Cadence: monthly, or when an upstream release carries a fix Cosmic
needs; never per upstream release.
