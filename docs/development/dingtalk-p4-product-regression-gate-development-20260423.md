# DingTalk P4 Product Regression Gate Development

- Date: 2026-04-23
- Branch: `codex/dingtalk-p4-product-gate-20260423`
- Base: `origin/main` at `a432a97a1`
- Scope: close and harden the local product regression gate TODO before final 142 remote smoke

## Goal

The final DingTalk TODO still had the product regression profile pending after the ops profile and release-readiness tooling were completed. The existing product profile also did not include the org destination catalog tests added by #1118. This slice adds those checks, installs workspace dependencies in a clean worktree, runs the hardened `product` profile, and updates the final plan so the remaining blockers are only private remote-smoke inputs and real manual evidence.

## Changes

- Added org destination catalog coverage to the product profile:
  - `tests/integration/dingtalk-group-destination-routes.api.test.ts`
  - `tests/unit/automation-v1.test.ts`
  - `tests/multitable-automation-manager.spec.ts`
  - `tests/multitable-automation-rule-editor.spec.ts`
- Added a regression-gate product plan test so the org catalog checks stay in the profile.
- Ran `pnpm install --offline` in the isolated worktree so backend/frontend product checks could execute.
- Ran `scripts/ops/dingtalk-p4-regression-gate.mjs --profile product`.
- Updated `docs/development/dingtalk-final-development-plan-and-todo-20260423.md`:
  - current branch/base commit now point at this follow-up worktree;
  - product gate items are marked complete;
  - product gate summary paths are referenced for final verification.
- No application runtime source change was required because all product checks passed.

## Local Outputs

- Product summary JSON: `output/dingtalk-p4-regression-gate/142-product/summary.json`
- Product summary Markdown: `output/dingtalk-p4-regression-gate/142-product/summary.md`
- Product logs: `output/dingtalk-p4-regression-gate/142-product/logs/`

These outputs remain untracked. They contain redacted local verification evidence only.

## Remaining Work

- Fill the private P4 env with staging backend/web URL, admin token, DingTalk group A/B webhooks, allowlist user IDs, and manual target identities.
- Re-run release readiness without `--allow-failures`.
- Execute final 142 remote smoke, record manual DingTalk evidence, finalize strict compile, export the final handoff packet, and generate final remote-smoke docs.
