# Multitable RC `2026-05-08b` Evidence Archive + UI Harness Wrapper · Development

> Date: 2026-05-08
> Branch: `codex/multitable-rc-20260508b-evidence-archive-20260508`
> Base: `origin/main@ff0a11efe`
> Closes the post-RC P0 + P1 cleanup items.

## Background

After cutting RC tag `multitable-rc-20260508b-08c6036284` (UI sign-off complete), the verification evidence was sitting in operator-side `/tmp` files and shell history. The user surfaced two follow-ups:

- **P0** — formal evidence archive in `docs/development/`, so future audits don't chase scratch directories
- **P1** — split out a dedicated UI harness package script so future RC closeouts cannot conflate "API harness 7/7" with "UI smoke complete"

This PR addresses both. P2 (stale branch hygiene) was already executed in the cleanup phase that preceded this branch.

## Scope

### In

1. New canonical evidence archive `docs/development/multitable-rc-20260508b-final-verification.md`:
   - 7/7 API harness result + per-check coverage recap
   - 3/3 Gantt UI smoke result + per-case coverage
   - Composition (the merge sequence that produced `08c6036284`)
   - Cross-references to predecessor RC tag, related PRs, memory notes
   - Section listing surfaces that are NOT validated by this RC

2. Artifact copy at `docs/development/multitable-rc-20260508b-api-harness-report.md` — verbatim summary table from the 7/7 API harness run on 142 (the path is sibling to the verification MD because `docs/development/artifacts/` is `.gitignore`d).

3. New shell wrapper `scripts/verify-multitable-rc-ui-smoke.sh`:
   - Validates `FE_BASE_URL` / `API_BASE_URL` / `AUTH_TOKEN`
   - Rejects URLs containing credentials, query, or fragment (matches the API harness contract; pattern from `feedback_metasheet2_pr_hardening_checklist.md` #10)
   - Idempotently installs Chromium
   - Runs `multitable-gantt-smoke.spec.ts` with `--workers=1`
   - Copies Playwright `test-results/` into `OUTPUT_DIR`
   - Distinct exit codes 0 / 1 / 2

4. New package script entry `verify:multitable-rc:ui` in `package.json`, wiring the wrapper as `pnpm verify:multitable-rc:ui`.

### Out

- Migration / OpenAPI / runtime changes — none. This is RC closeout artifact + tooling.
- Extending the UI harness to cover additional surfaces (Hierarchy drag-to-reparent, formula editor click flows, DingTalk-protected public form, real SMTP) — explicitly listed as out-of-scope in the verification MD; future work can fork the wrapper.
- Stale branch hygiene (P2) — already executed earlier; this PR mentions but does not re-do.

## K3 PoC Stage 1 Lock applicability

- Does NOT modify `plugins/plugin-integration-core/*`.
- Pure RC closeout tooling (no user-facing feature change, no migration).
- Does NOT touch DingTalk / public-form / Gantt / Hierarchy / formula / automation runtime.

## Implementation notes

### Why a separate `verify:multitable-rc:ui` script

The pre-RC closeout had `pnpm verify:multitable-rc:staging` as the single GO/NO-GO command. It is HTTP-only and deliberately does not navigate a browser — the lifecycle/public-form/hierarchy/gantt-config/formula/automation-email/autoNumber-backfill checks all assert API contracts. When the staging Gantt UI dependency-arrow render bug surfaced (PR #1444), the API harness was 7/7 GO but the actual workbench rendering path was 2/3.

Calling out the UI harness as a separate `pnpm verify:multitable-rc:ui` makes the partitioning legible: "did API say GO?" and "did the Chromium-rendered Gantt say GO?" are distinct questions, and a single name does not invite confusion.

### Why a shell wrapper rather than extending the JS harness

The Playwright spec already exists at `packages/core-backend/tests/e2e/multitable-gantt-smoke.spec.ts`; it consumes the staging-shaped env contract via the `multitable-helpers.ts` extracted in PR #1424. The thinnest correct wrapper is a shell script that:

- Validates env (failing fast on the credential-bearing URL gotcha)
- Invokes the existing Playwright spec via the project's pnpm filter

A node-based wrapper would re-implement env validation in JS to wrap a child process; that's strictly more code without extra value.

### Why the stale-branch hygiene (P2) does not have a code change

Stale branches are local refs that carried squash-merged commits. They were deleted via `git branch -D` in the cleanup that preceded this branch:

- `codex/multitable-autonumber-field-20260507`
- `codex/multitable-field-ux-polish-20260507`
- `codex/multitable-gantt-dependency-arrows-20260507`
- `codex/multitable-gantt-dependency-field-render-fix-20260508`
- `codex/gantt-ui-deeplink-20260508`
- `codex/ms2-gantt-ui-smoke-142-runner-20260508`
- `codex/staging-ui-smoke-bootstrap-20260508`

Worktrees backing the last four of those branches were also removed via `git worktree remove --force`. Codex's other lanes (`codex/integration-*`, `codex/erp-plm-*`, `codex/dingtalk-evidence-large-secret-scan-20260506`, etc.) are untouched — they're outside the RC closeout scope.

## Files changed

| File | Lines |
|---|---|
| `docs/development/multitable-rc-20260508b-final-verification.md` | +new (~150) |
| `docs/development/multitable-rc-20260508b-api-harness-report.md` | +new (~17, copy of the 7/7 run report) |
| `scripts/verify-multitable-rc-ui-smoke.sh` | +new (~85) |
| `package.json` | +1 (`verify:multitable-rc:ui` entry) |
| `docs/development/multitable-rc-20260508b-evidence-archive-development-20260508.md` | +new |
| `docs/development/multitable-rc-20260508b-evidence-archive-verification-20260508.md` | +new |

## Known limitations

1. **UI harness still requires a manual SSH tunnel** to reach the deployed cluster's `:8081` from the operator's machine. The script does not orchestrate the tunnel itself — operators set it up, then run `pnpm verify:multitable-rc:ui`. Automating the tunnel would require either (a) baking SSH credentials into the script, which is unsafe, or (b) a richer ops runbook outside this PR's scope.
2. **Test data is not cleaned up** — `uniqueLabel` prevents collisions; matches the convention from the API harness and prior RC smoke specs.
3. **Browser binaries are downloaded lazily** by the wrapper's `playwright install chromium` step. First run on a clean operator machine takes ~30–60 s extra; subsequent runs are immediate.

## Cross-references

- RC tag: `multitable-rc-20260508b-08c6036284`
- Predecessor RC tag: `multitable-rc-20260508-1b06bf286`
- Investigation that ended with the UI fix: `docs/development/multitable-gantt-dependency-render-investigation-20260508.md` (merged via PR #1444)
- API harness: `scripts/verify-multitable-rc-staging-smoke.mjs` (PR #1432)
- UI smoke spec: `packages/core-backend/tests/e2e/multitable-gantt-smoke.spec.ts`
- Memory note distilling this RC's lessons: `~/.claude/projects/.../memory/feedback_metasheet2_skip_when_unreachable_blind_spot.md`
