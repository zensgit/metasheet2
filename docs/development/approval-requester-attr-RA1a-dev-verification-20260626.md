# RA-1a — `requester.department` formula conditions — dev + verification

Status: BUILT + VERIFIED on branch `claude/approval-requester-attr-RA1a-code-20260626` (4 commits).
Scope per design-lock #3244 + scope correction #3259: **`requester.department` ONLY.**

## What shipped
Approval condition formulas can now route on the requester's **directory-resolved department**, e.g.
`requester.department == "财务"` or `requester.department != "财务" AND {amount} >= 5000`. The value is
server-resolved and frozen — tamper-resistant by provenance, unlike applicant-typed form fields.

| Layer | File | Commit |
|---|---|---|
| Evaluator namespace | `ApprovalConditionFormula.ts` (+ unit tests) | `c933396e9` |
| Snapshot source | `ApprovalDirectoryOrg.ts` | `239c16e46` |
| Threading (executor + snapshot + createApproval) | `ApprovalGraphExecutor.ts`, `approval-product.ts`, `ApprovalProductService.ts` | `f8154c8d5` |
| Resolver tests | `approval-directory-org.test.ts` | `d7c9fa896` |

## How each review finding was honoured
- **P1 — provenance, not `actor.department`.** `requester.department` reads a NEW frozen field
  `ApprovalRequesterSnapshot.directoryDepartment`, set in `createApproval` from
  `ApprovalDirectoryOrg.primaryDepartmentName` (the directory `directory_departments.name`). The
  JWT/session `actor.department` is never consulted by the evaluator.
- **P2 — raw key pinned.** Department name = `directory_departments.name`, added to the existing
  `resolveApprovalRequesterOrgRelations` SELECT (`d.name AS primary_department_name`). (`requester.level`
  is NOT built — `directory_accounts` has no seniority level; see #3259.)
- **P2 — constructor context, no re-query.** `ApprovalGraphExecutor` takes a `requesterContext` ctor
  option (beside `formData`); the condition node passes it to `evaluateApprovalConditionFormula`. No
  directory re-query at eval time, no resolver-bypass. Threaded at all 3 executor constructions — create
  + both dispatch paths (the latter from the reloaded `requester_snapshot`), so a formula condition routes
  consistently at create AND after an approval action.
- **Fail-closed split.** *Attribute-structural* (parse/publish): the RA-1a allowlist is `{department}`;
  `parsePrimary` rejects `level`/`role`/`title`/unknown at PARSE, so they never reach runtime — and `in` /
  array literals parse-reject for free. *Row-level* (runtime): a null context or missing/blank department
  fails the create rather than routing on a phantom.
- **No spoof.** The `requester.<attr>` token resolves only from the frozen context; a form field literally
  named `requester` is ignored (test asserts it).

## Verification (all green)
- `ApprovalConditionFormula.ts` evaluator unit suite — **13/13** (6 existing + 7 new): eval `==`/`!=`,
  AND-with-form-fields, the full parse-reject matrix (`level`/`role`/`title`/unknown/`in`/arrays/bare/empty
  attr), runtime fail-closed (null context / missing / blank / null department), no-spoof, and
  publish-validation (compared → boolean OK; bare → non-boolean reject; `level` → unsupported).
- `approval-directory-org.test.ts` — **10/10** (8 existing + 2 new): `primaryDepartmentName` resolved from
  `d.name`; omitted when the directory has no department name.
- `tsc --noEmit` on `@metasheet/core-backend` — **clean**.
- Affected backend suites (condition-formula / directory-org / graph-executor / product-service) —
  **113/113**, no regression.
- **Dispatch round-trip — safe by construction.** The dispatch paths read `directoryDepartment` from the
  reloaded `instance.requester_snapshot`; that column is a whole-object `JSON.stringify(requesterSnapshot)`
  at create (`ApprovalProductService.ts:2964`), so the field persists + reloads (NOT a field-by-field
  projection that would silently drop it). Residual gap: no end-to-end create→action→dispatch *integration*
  test exercises a formula via the reload path (the unit tests use a hand-built context) — recommended
  follow-up; the round-trip is structurally safe today.

## Scope boundary (deliberate, per #3259)
- **`requester.level`** — DEFERRED (no directory source). Parse-rejects.
- **`requester.role`** — RA-1b (membership + `in` + array literals). Parse-rejects.
- **`requester.title`** — the seniority candidate, its own title-vs-level design-lock. Parse-rejects.
- **Org-level structural publish-check** (template publishes only if the org's directory can supply a
  department) — RA-2 refinement. RA-1a relies on the parse-time attribute allowlist + the runtime
  row-level fail-closed; an org with no department names today simply has every such create fail-closed
  rather than failing at publish. Noted as the one RA-2 follow-up.

## Next
RA-1b (`requester.role` membership) and the `title`-vs-`level` seniority design-lock, each separate and
not mixed with `department`.
