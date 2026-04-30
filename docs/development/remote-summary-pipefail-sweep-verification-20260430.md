# Remote Summary Pipefail Sweep Verification - 2026-04-30

## Local Verification

Worktree:

`/tmp/ms2-remote-summary-pipefail-sweep-20260430`

Branch:

`codex/remote-summary-pipefail-sweep-20260430`

Baseline:

`origin/main` at `a06e5099362e5e0e032c1a4569b64e854ceedb47`

Commands:

```bash
node --test scripts/ops/remote-summary-pipefail-contract.test.mjs
rg -n "\\| head -n 120|\\| head -n \\\"\\$max_lines\\\"" \
  .github/workflows/docker-build.yml \
  .github/workflows/attendance-remote-docker-gc-prod.yml \
  .github/workflows/attendance-remote-env-reconcile-prod.yml \
  .github/workflows/attendance-remote-upload-cleanup-prod.yml
ruby -e 'require "yaml"; %w[
  .github/workflows/docker-build.yml
  .github/workflows/attendance-remote-env-reconcile-prod.yml
  .github/workflows/attendance-remote-upload-cleanup-prod.yml
].each { |p| YAML.load_file(p) }; puts "workflow yaml ok"'
git diff --check
```

Results:

- `remote-summary-pipefail-contract.test.mjs`: passed.
- `rg ...`: no matches for the pipefail-sensitive summary shapes.
- workflow YAML parse: passed.
- `git diff --check`: passed.

## Regression Coverage

The new contract test checks that:

- deploy preflight summary no longer pipes into `head -n 120`.
- deploy stage extraction no longer pipes into `head -n "$max_lines"`.
- env reconcile and upload cleanup summaries preserve the `120` total-line cap
  plus their existing post-block tail behavior without an external `head`.
- the already-fixed Docker GC workflow stays protected.

## Residual Risk

This only prevents summary false reds. If deploy, env reconcile, upload cleanup,
or Docker GC remote work returns non-zero, their workflows should still fail via
the existing final gate outputs.
