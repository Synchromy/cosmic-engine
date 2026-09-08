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
upstream/c1-contained-mutations            #4834  revision-guarded canonical page mutations, receipts
upstream/idempotent-append-page-event      #4837  append_page_event, idempotent typed interaction append
upstream/patch-page-type-title             #4838  patch_page accepts dedicated type and title fields
upstream/effective-date-path-and-created   #4957  effective_date reads a slug path date and frontmatter.created
upstream/c1-database-canonical             #4958  C1 mutations commit against the database row when no repo is configured; no append switch
upstream/sources-set-id                    —      sources set-id: a source's identity, changed safely
```

## Landed upstream, dropped from the set

Taken by v0.48.5.0 (the fix wave, credited to bhattman-dev): `upstream/lock-fact-reconciliation`
(#4835, as #4954), `upstream/chronicle-visibility` (#4881, both halves; the
carried ontology commit from cosmic/v0.48.3 is no longer needed and
`test/chronicle-private-visibility.test.ts` is kept, 9 of 9 against upstream's
own gate), `upstream/facts-since-composition` (#4882).

## Held back from cosmic/v0.48.5, still open upstream

`upstream/extract-facts-pause-marker` (#4836) conflicts in
`src/core/cycle/extract-facts.ts`; `upstream/exact-id-precedence` (#4883)
conflicts across the search files the v0.48.4.0 ranking wave rewrote
(`src/core/search/{hybrid,mode,modes-report}.ts`, `src/core/types.ts`, docs,
tests). Both need a hand rebase onto v0.48.5.0 before they return to the list.
Neither is needed for cosmic-hub gate 4 (#391) or #393.

Not carried from the Mac-era 17: bounded person create and Google Contacts
staging (default off, unused in the hub topology, never upstreamed).

## Rebuild on a new upstream tag

```
scripts/rebuild-cosmic.sh v0.48.6.0
```

Reads this list from the branch you run it on, fetches the tag, creates `cosmic/v0.48.6`, merges the branches above in
order, resolves the module size ledger to upstream's side and re-derives it,
cherry-picks the carried commits (this file, the script and any kept test), runs the touched test files. It stops at
the first real conflict and says which branch. When an upstream PR merges,
delete its line here and its branch; the next rebuild carries one patch less.

The hub pins the resulting SHA in its Dockerfile (cosmic-hub #352 is the
first). Cadence: monthly, or when an upstream release carries a fix Cosmic
needs; never per upstream release.
