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
upstream/sources-set-id                 —      sources set-id: a source's identity, changed safely
upstream/list-pages-slug-prefix         —      list_pages slug_prefix: ask for one directory
```

⚠️ `upstream/sources-set-id` and `upstream/list-pages-slug-prefix` have **no
upstream PR yet** — the only two lines here without one.

`upstream/sources-set-id` was written for cosmic-hub #423 (a deployment renamed
from `pilot` to `khoa` everywhere except inside its own brain) and merged straight
to the `cosmic/` branch first, which would have dropped it at the next
`rebuild-cosmic.sh` since that replays only the branches listed above. The
branch exists now and this line is what makes it survive. It is upstream-bound
like the rest — offering it needs a decision, not a rebase.

`upstream/list-pages-slug-prefix` was written for cosmic-hub #325: a skill page
written straight at the engine with a declared type that is not `guide` is
invisible to the Skills catalog, because the catalog can only ask "every page
of type guide" and then filter to `skills/` client-side. The filter layer has
had `slugPrefix` since storage tiering — indexed by the (source_id, slug)
btree — but no operation exposed it, so the one cheap fix was unreachable from
outside the process. With the parameter, the catalog asks for `skills/`
directly and drops the type filter, which makes it both CORRECT and narrower
than it is today. It only ever narrows a set the caller could already list, so
it is upstream-bound like the rest and offering it needs a decision, not a
rebase.

⚠️ The hub cannot use it until a rebuild carries it: asking for `slug_prefix`
against an engine that ignores the parameter would return every page and turn
the catalog's one call back into the ten-second unfiltered walk that #322
removed. So cosmic-hub #325 stays open until then, deliberately.

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
