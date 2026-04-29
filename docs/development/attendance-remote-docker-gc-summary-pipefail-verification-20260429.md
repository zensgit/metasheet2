# Attendance Remote Docker GC Summary Pipefail Verification - 2026-04-29

## Local Verification

Worktree:

`/tmp/ms2-remote-gc-summary-fix-20260429`

Branch:

`codex/remote-gc-summary-pipefail-20260429`

Baseline:

`origin/main` at `54b08b3b6cb6cc6c40aca89f0b38d35be30fd38b`

Commands:

```bash
node --test scripts/ops/attendance-remote-docker-gc-workflow-contract.test.mjs
rg -n "\\| head -n 120" .github/workflows/attendance-remote-docker-gc-prod.yml
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/attendance-remote-docker-gc-prod.yml"); puts "workflow yaml ok"'
git diff --check
```

Results:

- `attendance-remote-docker-gc-workflow-contract.test.mjs`: passed.
- `rg -n "\\| head -n 120" ...`: no matches.
- workflow YAML parse: passed.
- `git diff --check`: passed.

## Live Evidence

Run:

`25117998840`

Observed behavior before this fix:

- remote GC step completed with `GC_RC=0`.
- Docker reclaimed `37.31GB`.
- `/dev/vda2` changed from `77G used 74G avail 0 use 100%` to
  `77G used 30G avail 44G use 41%`.
- summary step failed with exit code `141`.

## Regression Coverage

The new contract test locks the summary renderer away from the
pipefail-sensitive `awk ... | head -n 120` shape while preserving the 120-line
cap.

## Residual Risk

This only fixes a false-negative summary failure. If remote Docker GC itself
returns non-zero, the workflow still fails through the existing `gc_rc` gate.
