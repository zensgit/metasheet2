# RA-1a transient-resolution wedge guard — Design

> Status: **PROPOSED — owner ratification needed** (touches the `createApproval` contract). Implemented on `claude/approval-ra1a-wedge-fix-20260627`; PR open, do-not-merge until ratified. Source of the finding: the RA-1a deep review (2026-06-27), P2.

## Problem
`createApproval` resolves the requester's directory department best-effort and **swallows failures** into `orgRelations = {}` (`ApprovalProductService.ts` ~:2876-2886). If the directory read fails **transiently at create** AND the template routes on `requester.department` **downstream of an approval node**, the create succeeds with the department absent, the `requester_snapshot` is frozen, and the first approval that reaches the condition throws → rolls back → re-throws on every retry **forever** (admin-cancel only). Fail-closed (safe, no mis-route) but a permanent in-flight wedge — production-triggerable and invisible to tests.

## Root cause — error-vs-empty conflation
The `catch` swallows BOTH a *thrown* read error (transient/infra) AND a *genuinely empty* result into `{}`. "department absent" is then ambiguous, and freezing it is wrong only for the transient case.

## Fix (error-vs-empty split)
Track whether the org-read threw (`orgReadFailed`). Then, **only when the published graph actually routes on `requester.department`** (new exported helper `runtimeGraphUsesRequesterDepartment`):
- read **THREW** (transient) and no department resolved → **fail the create fast**: `ServiceError(503, 'APPROVAL_REQUESTER_DEPARTMENT_UNRESOLVED')`, retryable. A visible, retryable create error beats a silent permanent wedge.
- read **SUCCEEDED but empty** (genuine row-level absence) → **proceed unchanged**; runtime fail-closes per the ratified lock. A requester who genuinely has no department is never blocked at create — ratified semantics preserved.

Non-`requester.department` templates and the manager-chain / dept-head paths are unaffected (the guard never fires for them).

## Why this preserves ratified semantics
The lock's "missing department → runtime fail-closed" is unchanged for genuine absence. The guard only changes the **transient-failure** case, converting a permanent mid-flight wedge into an immediate retryable create error. No change to publish validation, routing, or genuine-absence runtime behavior.

## Tests
- `approval-product-service.test.ts` (unit): transient read throw + `requester.department` graph → rejects 503; successful empty read + same graph → still creates (genuine absence proceeds).
- Happy path already covered by the round-trip integration test (#3294); the guard does not fire there (department resolves).

## Out of scope / future
- Optional: persist a `resolutionFailed` reason so `dispatch` can re-resolve ONLY the transient case (heal without re-reading on the happy path). Deferred — fail-fast-at-create needs no snapshot-schema change and is simpler.
