#!/usr/bin/env bash
# Rebuild cosmic/<tag> from an upstream tag and the patch register.
#
#   scripts/rebuild-cosmic.sh v0.49.0.0 [--keep-going] [--no-test] [--force]
#
# Kept because it is the command people know. The work, and the list of what
# is carried, moved to scripts/cosmic-patches.ts and cosmic/patches.json:
# carried commits are no longer passed as arguments, they are "carry" entries.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
exec bun scripts/cosmic-patches.ts rebuild "$@"
