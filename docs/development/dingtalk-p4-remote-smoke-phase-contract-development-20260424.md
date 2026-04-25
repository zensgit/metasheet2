# DingTalk P4 Remote Smoke Phase Contract Development

- Date: 2026-04-24
- Branch: `codex/dingtalk-next-slice-20260423`
- Scope: add a stable `remoteSmokePhase` signal to the DingTalk P4 remote-smoke tooling chain

## Problem

The P4 smoke status already had release-oriented `overallStatus` values such as `manual_pending`, `finalize_pending`, `handoff_pending`, and `release_ready`. That is useful for the full closeout chain, but it is too broad for operators and automation that only need to know the remote-smoke evidence phase.

## Contract

`remoteSmokePhase` is a narrower evidence-collection state with four allowed values:

- `bootstrap_pending`: API/bootstrap smoke checks are incomplete.
- `manual_pending`: bootstrap is complete, but real DingTalk-client/admin evidence is incomplete or has strict evidence issues.
- `finalize_pending`: all required remote-smoke evidence is present and the session is ready for strict finalize or handoff.
- `fail`: a failed check or operational failure needs investigation.

## Changes

- `compile-dingtalk-p4-smoke-evidence.mjs` now computes `remoteSmokePhase` from API bootstrap status, required check gaps, failed checks, unknown checks, and strict manual evidence issues.
- `dingtalk-p4-smoke-status.mjs` now carries the phase into `smoke-status.json`, `smoke-status.md`, and `smoke-todo.md`, while keeping `overallStatus` as the broader release-readiness status.
- `dingtalk-p4-smoke-session.mjs` now records the phase on bootstrap/finalize session summaries, status report summaries, and `finalStrictSummary`.
- `dingtalk-p4-evidence-record.mjs` now prints the refreshed phase after successful manual evidence writes.
- `dingtalk-p4-release-readiness.mjs` now surfaces phase, TODO progress, and current focus when it launches the smoke session automatically.
- `export-dingtalk-staging-evidence-packet.mjs` now copies the compiled phase into final-pass packet metadata.
- `validate-dingtalk-staging-evidence-packet.mjs` now validates phase enum values and checks packet metadata matches the compiled summary when both are present.
- `dingtalk-p4-final-docs.mjs` now includes the phase in final development/verification notes and keeps release-ready docs gated on `finalize_pending`.

## Documentation

- Updated `docs/dingtalk-remote-smoke-checklist-20260422.md` with the phase enum and the distinction from `overallStatus`.
- Updated `docs/development/dingtalk-feature-plan-and-todo-20260422.md` to mark the phase contract complete and to keep the real no-email admin smoke item visible in the remaining remote-smoke TODO list.

## Out Of Scope

- No real DingTalk tenant, webhook, staging admin token, or 142 server token was used.
- The existing final-pass gate still relies on final strict status, compiled pass status, API bootstrap pass, remote client pass, required checks, and empty issue arrays.
- This change does not make `remoteSmokePhase` a replacement for `overallStatus`; it is an additional operator/automation signal.
