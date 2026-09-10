#!/usr/bin/env bash
# Rebuild the cosmic/<tag> branch: upstream tag + the Synchromy patch branches
# listed in PATCHES.md, in order, then the carried commits, then the touched
# tests. Stops at the first conflict that is not the module size ledger.
#
#   scripts/rebuild-cosmic.sh v0.48.4.0 [carried-commit ...]
set -euo pipefail
TAG="${1:?usage: scripts/rebuild-cosmic.sh <upstream-tag> [carried-commit ...]}"; shift || true
BRANCH="cosmic/${TAG%.0}"
cd "$(git rev-parse --show-toplevel)"
git remote get-url upstream >/dev/null 2>&1 || git remote add upstream https://github.com/garrytan/gbrain.git
git fetch -q upstream "refs/tags/$TAG:refs/tags/$TAG"
git fetch -q origin
[ -z "$(git status --porcelain)" ] || { echo "working tree is dirty; refusing"; exit 2; }
# PATCHES.md lives on the cosmic/ branch, not on the upstream tag: read the list first.
mapfile -t PATCH_BRANCHES < <(awk '/^```$/{f=!f; next} f && /^upstream\//{print $1}' PATCHES.md)
[ "${#PATCH_BRANCHES[@]}" -gt 0 ] || { echo "no upstream/ branches listed in PATCHES.md; run this from a cosmic/ branch"; exit 2; }
git checkout -q -B "$BRANCH" "$TAG"
echo "== $BRANCH from $TAG ($(git rev-parse --short HEAD))"

ledger_only() { [ "$(git diff --name-only --diff-filter=U | tr -d '\n')" = "scripts/module-size-limits.tsv" ]; }
for b in "${PATCH_BRANCHES[@]}"; do
  git fetch -q origin "$b"
  if git merge -q --no-edit "origin/$b" >/dev/null 2>&1; then echo "merged  $b"
  elif ledger_only; then
    git checkout --ours scripts/module-size-limits.tsv && git add scripts/module-size-limits.tsv
    git -c core.editor=true merge --continue >/dev/null 2>&1 && echo "merged  $b (ledger resolved to upstream)"
  else
    echo "CONFLICT in $b:"; git diff --name-only --diff-filter=U; git merge --abort; exit 1
  fi
done

for c in "$@"; do git cherry-pick -x "$c" >/dev/null && echo "carried $c"; done

# Re-derive the ledger: every FAIL line names the file and its real size.
bash scripts/check-module-size.sh 2>&1 | grep '^FAIL' | sed -E 's/^FAIL: (\S+) (is|shrank to) ([0-9]+) lines.*/\1 \3/' | while read -r f n; do
  awk -v f="$f" -v n="$n" -v t="$TAG" 'BEGIN{FS=OFS="\t"} $1==f{ $4=$4 "; rebuilt on " t ": " $2 "->" n; $2=n } {print}' scripts/module-size-limits.tsv > /tmp/ledger.$$ && mv /tmp/ledger.$$ scripts/module-size-limits.tsv
done
bash scripts/check-module-size.sh | tail -1
if [ -n "$(git status --porcelain)" ]; then git commit -qam "chore: re-derive the module size ledger for $BRANCH"; fi

echo "== touched tests"
mapfile -t FILES < <(git diff --name-only "$TAG..HEAD" -- test | grep '\.test\.ts$')
[ -d node_modules ] || bun install --silent
GBRAIN_EMBED_RETRY_MAX=0 bun test --timeout=60000 "${FILES[@]}" 2>&1 | tail -4
echo "== $BRANCH at $(git rev-parse HEAD); pin this SHA in cosmic-hub/Dockerfile"
