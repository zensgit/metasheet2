# DingTalk P4 Regression Gate Development

- Date: 2026-04-23
- Scope: local DingTalk P4 ops/product regression gate runner
- Branch: `codex/dingtalk-p4-regression-gate-20260423`

## Changes

- Added `scripts/ops/dingtalk-p4-regression-gate.mjs`.
- Added profile-based execution:
  - `ops`: P4 smoke/session/status/evidence/handoff/docs tooling tests plus `git diff --check`.
  - `product`: backend/frontend DingTalk regression tests and builds from the final plan.
  - `all`: ops and product profiles together.
- Added `--plan-only` so operators can generate a command plan without running long product checks.
- Added redacted `summary.json`, `summary.md`, and per-check stdout/stderr logs under `output/dingtalk-p4-regression-gate/<run-id>/`.
- Updated the DingTalk P4 TODO and final plan so final smoke can reference one regression-gate output instead of hand-copying command lists.

## Rationale

The remaining DingTalk work depends on real staging credentials and DingTalk client/admin evidence. Before that run, the local verification contract should be reproducible and auditable. A single regression gate gives operators one command per profile and produces evidence that can be attached to final remote smoke notes without leaking tokens.

## Usage

Plan only:

```bash
node scripts/ops/dingtalk-p4-regression-gate.mjs --profile ops --plan-only
```

Run ops checks:

```bash
node scripts/ops/dingtalk-p4-regression-gate.mjs \
  --profile ops \
  --output-dir output/dingtalk-p4-regression-gate/142-ops
```

Run product checks:

```bash
node scripts/ops/dingtalk-p4-regression-gate.mjs \
  --profile product \
  --output-dir output/dingtalk-p4-regression-gate/142-product
```
