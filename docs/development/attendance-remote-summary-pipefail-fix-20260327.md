# Attendance Remote Summary Pipefail Fix

## Background

After `#556` fixed the real storage exec bug, three attendance prod remote workflows still showed red in GitHub Actions even when the remote probe itself had already completed successfully:

- `Attendance Remote Preflight (Prod)`
- `Attendance Remote Metrics (Prod)`
- `Attendance Remote Storage Health (Prod)`

The failing step was the local `Write step summary ...` step, not the remote SSH check. The failure mode was `exit code 141`, which matches `SIGPIPE` from `head` when used in a pipeline under `set -euo pipefail`.

## Root Cause

Each summary step captured log snippets with command substitutions shaped like:

```sh
block="$(
  awk '...' "$log_file" | head -n 80
)"
```

Under `set -euo pipefail`, `head` exiting after it consumed enough lines caused the upstream `awk` to terminate on a broken pipe. That non-zero pipeline status then failed the entire summary step even though:

- the remote command had already returned `0`
- the workflow outputs already contained the correct remote exit code
- only the GitHub step summary rendering path was broken

## Design

Keep the fix scoped to summary rendering only:

1. Do not touch remote SSH commands, runbook links, or failure semantics of the remote checks.
2. Remove `head` from the command substitutions that extract summary snippets.
3. Move the line cap into the single `awk` program itself.

Applied caps:

- host sync blocks: first `80` lines
- main preflight / metrics / storage blocks:
  - first `120` lines inside the block
  - plus up to `20` post-block tail lines for interleaved success text

## Expected Outcome

- successful remote probes no longer fail the workflow on summary rendering
- failed remote probes still surface as failures through the existing `*_RC` outputs
- storage summary is proactively protected from the same false-negative pattern
