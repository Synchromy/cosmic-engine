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
upstream/effective-date-occurred-at        TBD    effective_date reads frontmatter.occurred_at, an event's own time as a connector names it
upstream/c1-database-canonical             #4958  C1 mutations commit against the database row when no repo is configured; no append switch
upstream/sources-set-id                    —      sources set-id: a source's identity, changed safely
upstream/list-pages-effective-date         #5144  list_pages exposes effective_after/effective_before
upstream/ops-expose-what-the-engine-can-do —      a filter the engine honours that no op exposes is a bug
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

## Local candidate awaiting publication

`feat/generic-read-only-guard-0920` adds optional host-owned mutation admission
for registered operations on the exact deployed engine pin. No upstream PR or
release exists yet. Direct engine writers and running background jobs are not
covered; this is not a whole-process read-only switch.

`feat/background-mutation-admission-0921` extends that local candidate to worker
admission and queue progress diagnostics, defers waiting-TTL/private-queue
cancellation while paused, and exposes typed capture denials as a stable CLI
line. No upstream PR or release exists yet. Already admitted handlers and
active/stalled recovery (including orphaned-parent bookkeeping) may finish.
TTL and lease ages continue; expired waiting work can be cancelled after
resumption. Inline dream drains and unguarded direct writers remain outside
coverage. Policy reads and database claims do not form an atomic barrier.

`feat/authorized-page-read-preflight-0921` adds generic metadata-only page
resolution and optional host-owned admission before get_page/fetch content reads.
Final SQL binds the expected page identity; restore/source/privacy semantics
remain as before. No accounting, transport bootstrap, upstream PR, release or
activation exists in this slice. Ordinary successful reads add one metadata
query even without a callback.

## Local native lifecycle candidate

`feat/native-operation-lifecycle-0921` adds optional generic trusted-host lifecycle admission for native HTTP tools. Source and actual compiled executable use the same external-module path. This local candidate has no upstream PR or deployment. Producer outcomes, proprietary accounting and internal-subcall propagation remain separate prerequisites before a paid host is enabled.

## Local native producer-outcome candidate

`feat/native-operation-outcomes-0921` extends the optional generic lifecycle with terminal producer failures and bounded effects after definitive authorization. Only explicit failed-think and restricted-contradiction branches are instrumented here. Search/assembler availability and session cursor effects remain separate. No upstream PR, deployment or paid activation is claimed.

## Local hybrid retrieval-completion foundation

Optional trusted completion evidence follows the selected search/query result through lexical, vector, alias, exact and relational retrieval. Failed required hydration and discarded vector/adaptive/CRAG paths cannot authorize an empty fallback. Standalone behavior and the hard-disabled semantic result cache remain unchanged. This is the first B2b slice only; entity/think/context assemblers, cursor effects and host accounting integration remain prerequisites. The hybrid module ceiling increases 3295 to 3320 solely for the reviewed optional completion plumbing; no unrelated search extraction. Local-only, no upstream/publication or activation claim.
