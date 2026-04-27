# Verification: Call abandonStaleRuns Best-Effort Before Pipeline Runs

**PR**: #1197  
**Date**: 2026-04-26  
**Base after refresh**: `origin/main` includes #1187 (`0f3a51d8e`)

## Commands

```bash
node plugins/plugin-integration-core/__tests__/pipeline-runner.test.cjs
node plugins/plugin-integration-core/__tests__/pipelines.test.cjs
node plugins/plugin-integration-core/__tests__/migration-sql.test.cjs
for f in plugins/plugin-integration-core/__tests__/*.test.cjs; do node "$f"; done
git diff --check
```

## Test Scenarios Added

Section 17 in `pipeline-runner.test.cjs` covers:

| Scenario | Expected result |
| --- | --- |
| `abandonStaleRuns()` exists and succeeds | Called once before the run, scoped to tenant/workspace/pipeline |
| `abandonStaleRuns()` throws | Pipeline continues and reads the source record |
| Registry has no `abandonStaleRuns()` method | Pipeline still runs; no `TypeError` |

## Regression Relationship To #1187

#1187 owns the registry-side guard and DB partial unique index. #1197 only wires
the recovery call before `startRun()`.

The important sequence after both PRs is:

```text
runPipeline()
  loadPipelineContext()
  abandonStaleRuns() best-effort
  startRun()
    createPipelineRun()
      friendly running-row pre-check
      DB unique index final guard
```

That means #1197 never weakens #1187. Cleanup failure falls through to #1187's
normal conflict path rather than creating a second running row.

## Current Local Results

Direct changed-surface tests:

```text
pipeline-runner.test.cjs: pass
pipelines.test.cjs: pass
migration-sql.test.cjs: pass
```

Full plugin CJS sweep:

```text
adapter-contracts: pass
credential-store: pass
db.cjs: pass
e2e-plm-k3wise-writeback: pass
erp-feedback: pass
external-systems: pass
http-adapter: pass
http-routes: pass
k3-wise-adapters: pass
migration-sql: pass
payload-redaction: pass
pipeline-runner: pass
pipelines: pass
plm-yuantus-wrapper: pass
plugin-runtime-smoke: pass
runner-support: pass
staging-installer: pass
transform-validator: pass
```

`git diff --check` also passes.

The package script `pnpm -F plugin-integration-core test` may need the root
workspace `node_modules`; temporary worktrees without dependencies can fail
before tests when `node --import tsx` cannot resolve `tsx`.
