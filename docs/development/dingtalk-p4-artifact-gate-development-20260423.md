# DingTalk P4 Strict Artifact Gate Development

- Date: 2026-04-23
- Scope: P4 remote-smoke evidence compiler hardening
- Branch: `codex/dingtalk-p4-artifact-gate-20260423`

## What Changed

- Added strict validation for manual DingTalk-client/admin artifact refs in `scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs`.
- A manual check marked `pass` must now reference at least one artifact that is:
  - a relative path
  - inside `artifacts/<check-id>/` next to the input `evidence.json`
  - present on disk
  - a file, not a directory
  - non-empty
- Added `--allow-external-artifact-refs` for controlled external evidence stores. Without this flag, URL refs fail strict mode with `artifact_ref_external_disallowed`.
- Redacted artifact refs are included in `manualEvidenceIssues` so operators can fix the bundle without leaking tokens.
- Updated tests to create real local artifact files for passing evidence and to cover missing, wrong-folder, absolute, traversal, empty, and external URL refs.
- Updated the remote smoke checklist and P4 TODO to describe the self-contained evidence bundle rule.

## Why

The previous strict mode proved that manual metadata existed, but it did not prove that referenced screenshots or logs were actually included. This allowed an evidence file to pass with placeholder refs such as `screenshots/foo.png`. The new gate makes strict pass evidence reproducible and reviewable from the submitted bundle.

## Files

- `scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs`
- `scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs`
- `docs/dingtalk-remote-smoke-checklist-20260422.md`
- `docs/development/dingtalk-feature-plan-and-todo-20260422.md`

## Operator Flow

1. Generate a kit with `--init-kit`.
2. Put screenshots, exported logs, or notes under the generated `artifacts/<check-id>/` folders.
3. Fill per-check `evidence.artifacts` with those relative paths.
4. Run strict compile. If the compiler reports `artifact_ref_*`, fix the bundle before treating the smoke as passed.
