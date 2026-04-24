# DingTalk P4 Remaining TODO Development

- Date: 2026-04-24
- Branch: `codex/dingtalk-next-slice-20260423`
- Base commit: `07119e52c`
- Scope: turn the remaining DingTalk P4 goal into a repo-tracked execution TODO and record the latest local readiness verification

## Context

The DingTalk P4 code and local tooling chain are largely implemented. The remaining work is dominated by real 142/staging remote-smoke execution, manual DingTalk-client/admin evidence collection, final packet validation, release-ready status, and final documentation.

The current sandbox cannot complete the fake API portions of the P4 regression because local loopback listening on `127.0.0.1` is denied with `EPERM`. That limitation affects verification planning, not the TODO document itself.

After the TODO was added, the local readiness subset was executed again against commit `07119e52c`. That run covered script syntax checks and the P4 tests that do not require real DingTalk, 142/staging credentials, or local fake API servers.

## Changes

- Added `docs/development/dingtalk-p4-remaining-todo-20260424.md`.
- Captured the remaining development volume estimate:
  - 10%-15% code fixes if real smoke exposes defects.
  - 70%-80% remote verification and evidence collection.
  - 10% final docs and PR closeout.
- Converted the remaining work into an ordered checklist covering:
  - local tooling readiness,
  - 142/staging input readiness,
  - remote smoke bootstrap,
  - manual DingTalk evidence,
  - finalize and handoff,
  - bug fix policy,
  - final deliverables.
- Included concrete commands for the smoke session, evidence recorder, strict finalize, and final closeout.
- Kept secret handling explicit: no raw tokens, webhook URLs, SEC secrets, public form tokens, or temporary passwords should be committed or copied into PR comments.
- Added a latest local readiness snapshot to `docs/development/dingtalk-p4-remaining-todo-20260424.md`.
- Marked local worktree/branch/static-check/sandbox-safe-test TODO items as complete.

## Out Of Scope

- No real 142/staging smoke was executed.
- No DingTalk tenant, webhook, admin token, or user token was used.
- No product code or smoke tooling code was changed in this documentation-only slice.
- Full P4 regression remains out of scope for this sandbox because fake API tests need local loopback listening on `127.0.0.1`.
