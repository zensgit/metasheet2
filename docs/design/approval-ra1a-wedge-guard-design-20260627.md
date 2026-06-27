# RA-1a requester.department wedge guard — Design

> Status: **RATIFIED — SHIPPED #3296 (`4d5a388b5`, 2026-06-27).** Owner-ratified; the create-time wedge guard (reject-at-create 503/422, token-aware AST detection) is on `main`. Source of the finding: the RA-1a deep review (2026-06-27), P2.

## Problem
`createApproval` resolves the requester's directory department best-effort and **swallows failures** into `orgRelations = {}` (`ApprovalProductService.ts` ~:2876-2886). If the template routes on `requester.department` **downstream of an approval node** and the department is absent — whether because the read **failed transiently** OR because the requester **genuinely has none** — the create succeeds, the `requester_snapshot` is frozen, and the first approval that reaches the condition throws → rolls back → re-throws on **every retry forever** (admin-cancel only). Fail-closed (no mis-route) but a permanent in-flight wedge — production-triggerable and invisible to tests.

The lock §2 intends absence to be **"reject this createApproval rather than route on a phantom value"** — but the runtime realizes that only when the condition is reachable *at create*. A **downstream** condition rejects at dispatch (post-freeze) instead, which is the wedge. This holds for both the transient AND the genuine-absence trigger; an earlier scoping that fixed only the transient case left the (deterministic) genuine-absence wedge open.

## Fix
When the published graph routes on `requester.department` (new exported helper `runtimeGraphUsesRequesterDepartment`) and the department did not resolve, **reject at create** — realizing the lock's reject-at-create regardless of graph topology. The cause is distinguished for the caller:
- read **THREW** (transient/infra) → `ServiceError(503, 'APPROVAL_REQUESTER_DEPARTMENT_UNRESOLVED')` — retryable.
- read **SUCCEEDED but empty** (genuine row-level absence) → `ServiceError(422, 'APPROVAL_REQUESTER_DEPARTMENT_REQUIRED')` — the requester's department is unset for a template that routes on it.

Non-`requester.department` templates and the manager-chain / dept-head paths are unaffected (the guard never fires; genuine absence on those still follows their `emptyAssigneePolicy`).

## Alignment with the ratified lock
The lock §2: row-level absence → "reject this createApproval rather than route on a phantom value." This guard makes that hold regardless of topology, for both causes. No change to publish validation, to routing, or to the never-phantom-route rule. Conservative trade-off: the guard fires whenever the graph *references* `requester.department` (coarse), so it can reject a create whose actual path would not have reached the condition — accepted under the lock's "never route on a phantom value" priority; precise per-path reachability is not knowable at create (branches depend on future approver decisions).

## Tests
- `approval-product-service.test.ts` (unit): transient throw + `requester.department` graph → rejects **503**; successful empty read + same graph → rejects **422** (genuine absence fail-closed at create, NOT a downstream wedge); existing non-department createApproval paths unaffected (64/64 green; tsc clean).
- Happy path covered by the round-trip integration test (#3294, now wired into the CI integration lane); the guard does not fire there (department resolves).

## Out of scope / future
- Optional: instead of reject-at-create, persist a `resolutionFailed` reason and re-resolve ONLY the transient case at dispatch (heal without re-reading on the happy path). Deferred — reject-at-create needs no snapshot-schema change and is the lock's stated behavior.
