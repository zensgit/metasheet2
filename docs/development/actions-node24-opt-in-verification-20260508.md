# GitHub Actions Node24 Opt-In - Verification (2026-05-08)

Companion to `actions-node24-opt-in-design-20260508.md`. This file records the
local checks run before pushing and the post-merge signals to watch.

## Files changed

Workflows (top-level `env:` block added between `on:` and `jobs:`):

- .github/workflows/docker-build.yml
- .github/workflows/deploy.yml
- .github/workflows/monitoring-alert.yml
- .github/workflows/phase5-production-flags-guard.yml
- .github/workflows/plugin-tests.yml
- .github/workflows/attendance-gate-contract-matrix.yml
- .github/workflows/phase5-validate.yml

The last two workflows were appended after the PR's own check runs surfaced
the `Node.js 20 actions are deprecated` warning on
`attendance-gate-contract-matrix` and `phase5-validate`, so they were folded
into the same minimal opt-in batch rather than deferred to a later wave.

Docs:

- docs/development/actions-node24-opt-in-design-20260508.md
- docs/development/actions-node24-opt-in-verification-20260508.md

## Local verification commands

Run from the repository root.

1. Confirm the env block landed in exactly seven workflows and nothing else:

   ```
   grep -l "FORCE_JAVASCRIPT_ACTIONS_TO_NODE24" .github/workflows
   ```

   Expected output: the seven workflow paths listed above and no others.

2. Confirm the flag is set as a top-level env, not inside a job:

   ```
   grep -B1 -A1 "FORCE_JAVASCRIPT_ACTIONS_TO_NODE24" .github/workflows/*.yml
   ```

   Expected: each match is preceded by a top-level `env:` key (column 0),
   not by `        env:` indented under a step or job.

3. Confirm `node-version` pins are unchanged:

   ```
   grep -nE "node-version" .github/workflows/docker-build.yml .github/workflows/deploy.yml .github/workflows/monitoring-alert.yml .github/workflows/phase5-production-flags-guard.yml .github/workflows/plugin-tests.yml .github/workflows/attendance-gate-contract-matrix.yml .github/workflows/phase5-validate.yml
   ```

   Expected: every existing `'20'` / `20.x` / `'18.x'` value is still present
   and unchanged. No `node-version: '24'` or `node-version: 24.x` value should
   appear. (`phase5-validate.yml` keeps its `'18.x'` pin; the runner-side flag
   only retargets JS-action launches and does not change the toolchain Node
   version.)

4. YAML lint (optional but recommended if `yamllint` is installed locally):

   ```
   yamllint .github/workflows/docker-build.yml .github/workflows/deploy.yml .github/workflows/monitoring-alert.yml .github/workflows/phase5-production-flags-guard.yml .github/workflows/plugin-tests.yml .github/workflows/attendance-gate-contract-matrix.yml .github/workflows/phase5-validate.yml
   ```

5. Diff review:

   ```
   git diff -- .github/workflows
   ```

   Expected: each of the seven files shows a small hunk inserting the top-level
   `env:` block. No other non-blank workflow logic lines should change.

## Post-merge signals

After this lands on `main`, watch the next run of each affected workflow:

- The "Set up job" log section should no longer print the
  `Node.js 20 actions are deprecated` warning for JS actions.
- Workflow duration should be unchanged within normal variance; the override
  only swaps the runtime the runner launches JS actions under.
- `pnpm install`, `pnpm build`, and `pnpm test` steps continue to run under
  Node.js 20 because their toolchain is provided by `actions/setup-node@v4`
  and is independent of the runner-side override.

If the warning still appears for a specific action, that action is likely
using a non-JS `runs.using` (Docker or composite) and is unaffected by this
flag; address that case separately.

## Risk and rollback

See the design doc. Rollback is a per-file delete of the inserted top-level
`env:` block, or `git revert` of the follow-up commit. No data, secrets, or
runtime DingTalk code is touched by this change.
