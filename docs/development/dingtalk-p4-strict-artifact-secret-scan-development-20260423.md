# DingTalk P4 Strict Artifact Secret Scan Development

- Date: 2026-04-23
- Branch: `codex/dingtalk-p4-artifact-secret-scan-20260423`
- Scope: local P4 evidence compiler hardening.

## Changes

- Added secret-like text scanning to `compile-dingtalk-p4-smoke-evidence.mjs` for referenced local manual artifact files.
- The scan runs after the existing strict artifact path, file, and non-empty checks.
- Small likely-text artifacts are scanned for DingTalk robot webhooks, `access_token` params, bearer tokens, `SEC...` secrets, JWTs, client secret assignments, and public form tokens.
- Findings are reported as `manualEvidenceIssues` with `code: "artifact_secret_detected"`.
- The issue records the artifact path and pattern name, but never stores the matched secret preview.
- Updated the remote smoke checklist and P4 TODO so operators know strict compile catches raw secret-like text artifacts before final handoff.

## Rationale

The final packet validator already scans exported packets, and the evidence recorder scans artifacts it writes. This change catches the same class of mistakes earlier when an operator manually edits `workspace/evidence.json` or places artifacts directly before `--finalize`.
