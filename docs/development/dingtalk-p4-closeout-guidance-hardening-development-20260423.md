# DingTalk P4 Closeout Guidance Hardening Development

- Date: 2026-04-23
- Branch: `codex/dingtalk-next-slice-20260423`
- Scope: make generated final-smoke commands and closeout reruns safer before 142 execution

## Problem

The final P4 tooling already supports readiness, status, handoff, closeout, and final docs generation, but several generated outputs could mislead operators when non-default paths were used or when rerunning into a reused directory:

- `dingtalk-p4-release-readiness.mjs` rendered a next smoke-session command with the default session output path even when `--smoke-output-dir` was configured.
- `dingtalk-p4-smoke-status.mjs` suggested a final closeout command with the sample packet path `artifacts/dingtalk-staging-evidence-packet/142-final` instead of the packet directory implied by `--handoff-summary` / `--publish-check-json`.
- `dingtalk-p4-final-docs.mjs` rendered its verification self-check command with `--output-dir docs/development` and no `--date`, ignoring custom output/date values.
- `dingtalk-p4-final-closeout.mjs --skip-docs` could leave stale final docs in a reused docs directory.
- Early final-closeout validation failures could leave stale previous `closeout-summary.json` / `closeout-summary.md` files behind.

## Changes

- Release readiness summaries now include `plannedSmokeSession` with the exact output directory, timeout, and command to run next.
- Release readiness Markdown now renders the planned smoke-session command from the actual options.
- Smoke status now derives final closeout packet output from the configured handoff summary, publish check, or sanitized session name instead of hardcoding `142-final`.
- Final docs models now retain the actual docs output directory, development MD, and verification MD paths.
- Final docs verification Markdown now includes the actual `--output-dir` and `--date` used for generation.
- Final closeout removes stale closeout summaries before running validation and clears expected final docs when `--skip-docs` is used.
- The master DingTalk plan/TODO now tracks this closeout guidance hardening as complete.

## Operator Impact

For final readiness planning, the generated `release-readiness-summary.md` now mirrors the real command shape:

```bash
node scripts/ops/dingtalk-p4-release-readiness.mjs \
  --p4-env-file ~/.config/yuantus/dingtalk-p4-staging.env \
  --smoke-output-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --run-smoke-session
```

For manual closeout, generated status TODOs now point to the same packet directory that the operator is already using for handoff or publish validation:

```bash
node scripts/ops/dingtalk-p4-final-closeout.mjs \
  --session-dir output/dingtalk-p4-remote-smoke-session/142-session \
  --packet-output-dir artifacts/dingtalk-staging-evidence-packet/142-session-final \
  --docs-output-dir docs/development
```

When `--skip-docs` is intentional, stale `dingtalk-final-remote-smoke-*.md` files for the same date are removed so the directory cannot imply that fresh docs were generated.

## Out Of Scope

- No real 142 staging or DingTalk tenant calls were executed.
- No admin token, DingTalk robot token, SEC secret, or public form token was required.
- This does not change the final evidence contract, packet publish validator, or remote smoke API behavior.
