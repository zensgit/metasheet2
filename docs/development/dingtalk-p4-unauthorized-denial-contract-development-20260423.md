# DingTalk P4 Unauthorized Denial Contract Development

- Date: 2026-04-23
- Branch: `codex/dingtalk-p4-unauthorized-denial-contract-20260423`
- Scope: local P4 evidence contract hardening for the unauthorized-user remote smoke check.

## Changes

- Strengthened `compile-dingtalk-p4-smoke-evidence.mjs` strict checks for `unauthorized-user-denied`.
- A pass now requires:
  - `evidence.submitBlocked === true`
  - `evidence.recordInsertDelta === 0`, or equal `beforeRecordCount` / `afterRecordCount`
  - `evidence.blockedReason`, `evidence.errorSummary`, or `evidence.visibleErrorSummary`
- Extended `dingtalk-p4-evidence-record.mjs` with:
  - `--submit-blocked`
  - `--record-insert-delta`
  - `--before-record-count`
  - `--after-record-count`
  - `--blocked-reason`
- Updated the offline handoff chain to record `unauthorized-user-denied` via the recorder with structured no-insert proof.
- Updated remote smoke checklist and TODO guidance.

## Rationale

The checklist requires proving that an unauthorized DingTalk-bound user cannot submit and that no record is inserted. This contract prevents a generic screenshot or summary from being marked as pass without the no-insert evidence needed for release confidence.
