# GitHub Actions Node24 Opt-In - Design (2026-05-08)

## Background

After PR #1434 landed, several workflow runs surfaced GitHub's deprecation
notice for JavaScript actions still pinned to the Node.js 20 runtime. GitHub
ships a runner-side opt-in flag, `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24`, that
forces the runner to execute JS-action entrypoints under Node.js 24 without
requiring action authors to publish updated `runs.using` values. The flag does
not change the toolchain the workflow installs for its own build/test steps; it
only retargets the JS runtime the runner uses to launch action code.

## Scope of this change

This change is intentionally narrow. The follow-up only touches workflows that
were observed surfacing the deprecation warning in recent runs:

- `.github/workflows/docker-build.yml`
- `.github/workflows/deploy.yml`
- `.github/workflows/monitoring-alert.yml`
- `.github/workflows/phase5-production-flags-guard.yml`
- `.github/workflows/plugin-tests.yml`
- `.github/workflows/attendance-gate-contract-matrix.yml`
- `.github/workflows/phase5-validate.yml`

The first five workflows were the original batch identified before opening
PR #1439. The last two (`attendance-gate-contract-matrix.yml` and
`phase5-validate.yml`) were added after the PR's own check runs surfaced the
same `Node.js 20 actions are deprecated` warning, confirming they belong in
the same minimal opt-in batch rather than a later wave.

Each file gets a top-level `env:` block:

```
env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: 'true'
```

inserted as a top-level block before the first `jobs:` key. In workflows that
already have top-level `concurrency:` or `permissions:` blocks, the `env:` block
is placed after those blocks and before `jobs:`.

## What is deliberately NOT changed

- No `node-version` value is altered. The `actions/setup-node@v4` calls keep
  their existing `'20'` / `20.x` pins so the toolchain used by `pnpm install`,
  `pnpm build`, and `pnpm test` stays on the Node.js 20 line that the
  repository's lockfile and CI baselines were validated against.
- No DingTalk runtime files, secrets, or notification channel code are
  touched.
- Workflows outside the seven listed paths are left alone. We will widen the
  rollout only after this minimal batch verifies cleanly.
- No `runs.using` field on any custom action is changed. The flag is a runner
  override; action manifests remain as-is.

## Risk

Low. `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24` is the runner-side opt-in mechanism
named by the GitHub Actions deprecation warning. The blast radius is limited to
JS-action entrypoint launches; shell steps and the workflow's own Node toolchain
are unaffected. Compatibility of the pinned third-party actions is verified by
the follow-up workflow runs rather than assumed locally.

The two failure modes worth naming:

1. A pinned action version that internally relies on a Node-20-only API would
   surface as an action launch failure. None of the actions used here are
   known to depend on such APIs at their pinned versions.
2. Self-hosted runners that have not yet provisioned Node 24 binaries would
   fail to honour the override. This repo's CI uses GitHub-hosted
   `ubuntu-latest` runners only, which already include Node 24, so this case
   does not apply.

## Rollback

Single-file revert per workflow. Remove the inserted top-level `env:` block to
restore prior behaviour. Because no other lines were touched, `git revert` of
the follow-up commit, or a manual delete of the inserted block, is sufficient
and self-contained.

## Sequencing

This change should ride on its own commit/PR so the deprecation-warning
disappearance in workflow logs can be attributed cleanly. Once the seven
workflows show clean runs, a follow-up can extend the same `env:` block to
the remaining workflows under `.github/workflows/`.
