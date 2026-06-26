# Approval Formula Conditions — Stack Review

Status: REVIEWED + SHIPPED — FC-1..FC-5 ON MAIN.

Date: 2026-06-25

This record reviews the FC-1..FC-5 implementation against the ratified
design-lock. It began as a draft-stack landing aid; after the serial landing,
all five slices are on `origin/main`.

## Stack State

| Slice | PR | Head | State |
| --- | --- | --- | --- |
| FC-1 evaluator | #3219 | `38b1b98d0` | shipped on main |
| FC-2 authoring | #3220 | `c0a875193` | shipped on main |
| FC-3 preset examples | #3221 | `a0071602b` | shipped on main |
| FC-4 backend dry-run | #3222 | `34644ba26` | shipped on main |
| FC-5 dry-run preview | #3234 | `be9ad83a4` | shipped on main |

The stack order was preserved: FC-1 -> FC-2 -> FC-3 -> FC-4 -> FC-5.

Current base/drift check:

- `origin/main` contains FC-1..FC-5 at the SHAs listed above.
- PR comments on the original draft stack only contained non-actionable Gemini
  quota warnings; no actionable review remained when FC-1 landing began.

## Reviewed Surfaces

- Backend evaluator: `packages/core-backend/src/services/ApprovalConditionFormula.ts`
- Backend graph validation/publish path:
  `packages/core-backend/src/services/ApprovalProductService.ts`
- Backend runtime branch selection:
  `packages/core-backend/src/services/ApprovalGraphExecutor.ts`
- Backend dry-run route: `packages/core-backend/src/routes/approvals.ts`
- Frontend condition authoring helper: `apps/web/src/approvals/conditionEdit.ts`
- Frontend template authoring view:
  `apps/web/src/views/approval/TemplateAuthoringView.vue`
- Frontend template shape guard:
  `apps/web/src/approvals/templateAuthoring.ts`
- Frontend API wrapper: `apps/web/src/approvals/api.ts`
- Mounted/frontend specs:
  `apps/web/tests/approvalTemplateAuthoring.spec.ts`
  and `apps/web/tests/approval-template-authoring-condition-edit.test.ts`
- Backend RBAC boundary spec:
  `packages/core-backend/tests/unit/approval-rbac-boundary.test.ts`

## Gate Review

### FC-1 — Backend Contract + Evaluator

Verdict: no blocking finding found after the parenthesis-depth hardening.

Evidence:

- Formula contract is additive: `ConditionBranch` keeps `rules` and adds
  optional `formula`.
- `normalizeApprovalGraph` rejects mixed `formula + non-empty rules`.
- Publish/update/create validation calls
  `assertApprovalConditionFormulaValidForSchema`.
- Runtime condition resolution uses the same
  `evaluateApprovalConditionFormula`.
- The evaluator is approval-specific and narrow: no eval, no external lookup,
  bounded expression length, AST nodes, nesting depth, field refs, and function
  calls.
- Unsafe arithmetic and malformed aggregates fail closed.
- Boolean `AND`/`OR` evaluate both operands, so malformed aggregate data cannot
  hide behind short-circuit behavior.

Self-review fix already landed in FC-1:

- Pure parenthesis nesting now counts against the max nesting-depth cap. A
  17-deep parenthesis wrapper around `TRUE` fails closed instead of bypassing
  the AST-depth limit.

Verification:

- Backend focused unit suite: 98/98 passed.
- Backend type-check: clean.
- GitHub checks: green; strict E2E skipped as expected.

### FC-2 — Frontend Authoring

Verdict: no blocking finding found.

Evidence:

- The editor seeds `predicateMode` from branch shape:
  formula branches hydrate as formula mode; rule branches hydrate as rule mode.
- Saving a formula branch emits `{ rules: [], formula: { expression } }`.
  Keeping `rules: []` is intentional because the backend/runtime branch shape
  still requires a rules array.
- Saving a rule branch omits `formula`.
- Non-condition nodes and all graph edges are deep-cloned and preserved.
- Formula reference preview checks top-level fields and detail sub-fields
  against the draft form schema. The backend remains the arbiter.
- The mounted wiring test switches a real condition branch from rules to
  formula and asserts the saved payload.

Verification:

- `approval-web-guard`: green.
- `pr-validate`: green.

### FC-3 — Preset Examples

Verdict: no blocking finding found in the current stack review.

Evidence:

- Formula-condition preset examples sit on top of the FC-1/FC-2 contract.
- They do not introduce a new evaluator or a new graph model.
- The stack remains draft, so these examples are not yet a shipped user promise.

Verification:

- `approval-web-guard`: green.
- `pr-validate`: green.

### FC-4 — Backend Dry-Run Endpoint

Verdict: no blocking finding found.

Evidence:

- Route is approval-specific:
  `POST /api/approval-templates/formula-condition/dry-run`.
- Route is protected by `authenticate` and
  `rbacGuard('approval-templates:manage')`.
- It validates `expression`, `formSchema.fields`, and object-shaped `formData`.
- It calls the same validator/evaluator as publish/runtime:
  `assertApprovalConditionFormulaValidForSchema` and
  `evaluateApprovalConditionFormula`.
- Formula errors return structured diagnostics in the response body instead of
  falling through as generic 500s.
- The route does not call the sheet-scoped multitable formula dry-run API.

Verification:

- RBAC boundary tests cover no-auth 401, wrong-scope 403, manage-scope 200, and
  runtime diagnostic response.
- `pr-validate`: green.

### FC-5 — Frontend Dry-Run Preview

Verdict: no blocking finding found.

Evidence:

- Preview is explicit-button only; it is not per-keystroke.
- Sample JSON is parsed locally and must be an object.
- Request payload sends `{ formSchema, expression, formData }` to the FC-4
  endpoint wrapper.
- The preview result is informational only; it is not a save/publish gate.
- Mounted wiring test proves:
  - button -> endpoint payload,
  - result rendering,
  - save payload still contains only graph config,
  - sample data does not enter the template payload.

Verification:

- Local post-restack backend focused suite: 98/98 passed.
- Local approval-web-guard equivalent suite: 259/259 passed.
- Web type-check: clean.
- Backend type-check: clean.
- `git diff --check`: clean.
- GitHub `approval-web-guard`: green.
- GitHub `pr-validate`: green.

## Non-Blocking Notes

- Direct linting of `apps/web/src/approvals/api.ts` still hits a pre-existing
  unrelated unused-parameter issue at `approvalId`. The FC-5 API addition is
  covered by `vue-tsc -b` and the mounted wiring test.
- FC-3 examples are useful examples, not a substitute for FC-1/FC-2/FC-4/FC-5
  contract verification.
- This review did not convert the PRs from draft to ready and did not merge
  anything.

## Landing Requirements

Before shipping:

1. Convert or land one slice at a time in stack order:
   FC-1 -> FC-2 -> FC-3 -> FC-4 -> FC-5.
2. After each slice lands, rebase the next slice onto the new base.
3. Re-run the slice's gates on the rebased head.
4. Keep the backend as the branch arbiter; frontend dry-run remains UX only.
5. After FC-5 lands, update the design-lock/status docs from draft-stack to
   shipped.

## Landing Checklist

Historical checklist used for the serial landing. It is retained as process
evidence; do not read unchecked items below as current work for FC-1..FC-4.

### FC-1 #3219

1. Confirm `origin/main` has not advanced; if it has, rebase FC-1 onto the new
   `origin/main`.
2. Convert #3219 from draft to ready.
3. Re-run/confirm the full required check set.
4. Squash-merge #3219.
5. Record the squash SHA.

### FC-2 #3220

1. Rebase FC-2 onto the merged FC-1 squash commit.
2. Confirm the authoring diff still only adds formula authoring and does not
   touch backend runtime.
3. Re-run/confirm `approval-web-guard` and `pr-validate`.
4. Convert #3220 from draft to ready.
5. Squash-merge #3220.
6. Record the squash SHA.

### FC-3 #3221

1. Rebase FC-3 onto the merged FC-2 squash commit.
2. Confirm the preset examples still use the FC-1/FC-2 formula contract and do
   not introduce a second evaluator or graph shape.
3. Re-run/confirm `approval-web-guard` and `pr-validate`.
4. Convert #3221 from draft to ready.
5. Squash-merge #3221.
6. Record the squash SHA.

### FC-4 #3222

1. Rebase FC-4 onto the merged FC-3 squash commit.
2. Confirm the dry-run route remains approval-specific and protected by
   `authenticate` + `rbacGuard('approval-templates:manage')`.
3. Re-run/confirm `pr-validate` and the RBAC boundary tests covering 401/403/200
   plus formula diagnostics.
4. Convert #3222 from draft to ready.
5. Squash-merge #3222.
6. Record the squash SHA.

### FC-5 #3234 (replacement for closed #3223)

1. Rebase FC-5 onto the merged FC-4 squash commit.
2. Confirm the preview remains explicit-button UX only and sample JSON still
   does not enter the template payload.
3. Re-run/confirm `approval-web-guard`, `pr-validate`, and the mounted wiring
   spec.
4. Open replacement PR #3234 because original #3223 was closed against the
   deleted FC-4 branch.
5. Squash-merge #3234.
6. Record the squash SHA.

### Closeout

1. `docs/design/approval-formula-condition-design-lock-20260625.md` now reads
   `RATIFIED + SHIPPED` with all five squash SHAs.
2. This review record and the stack verification record stamp the FC-5 squash.
3. Closed #3223 is superseded by shipped #3234; no FC runtime branch remains
   intentionally open for this stack.

## Review Verdict

APPROVE — STACK SHIPPED.

I found no remaining blocker in FC-5 after the FC-1 parenthesis-depth
hardening and the serial FC-1..FC-4 landing. FC-5 shipped as #3234
`be9ad83a4`; the shipped-state documentation now stamps the full stack.
