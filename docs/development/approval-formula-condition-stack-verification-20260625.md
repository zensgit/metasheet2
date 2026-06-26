# Approval Formula Conditions — Stack Verification Snapshot

Status: LANDING VERIFICATION — FC-1..FC-4 SHIPPED; FC-5 PENDING IN #3223.
This record documents the FC-1..FC-5 implementation and the verification used
to land the stack serially. It is not the final shipped closeout until the FC-5
squash SHA is stamped.

## Stack

| Slice | PR | Base | Head | State |
| --- | --- | --- | --- | --- |
| FC-1 evaluator | #3219 | `main` | `38b1b98d0` | shipped on main |
| FC-2 authoring | #3220 | `main` | `c0a875193` | shipped on main |
| FC-3 preset examples | #3221 | `main` | `a0071602b` | shipped on main |
| FC-4 backend dry-run | #3222 | `main` | `34644ba26` | shipped on main |
| FC-5 dry-run preview | #3223 | `main` | pending squash | this PR |

## FC-1 Rebase Hardening

After self-review, FC-1 now enforces the design-lock's nesting bound for pure
parenthesis nesting as well as AST operator depth. A formula such as
`((((...TRUE...))))` with 17 nested parentheses now fails with the same
fail-closed nesting-depth error instead of bypassing the depth cap.

Commands run from `/private/tmp/metasheet2-fc1-formula-condition`:

```sh
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-condition-formula.test.ts tests/unit/approval-graph-executor.test.ts tests/unit/approval-product-service.test.ts --reporter=dot
pnpm --filter @metasheet/core-backend type-check
git diff --check
```

Results:

- Backend focused unit suite: 98/98 passed.
- Backend `tsc --noEmit`: clean.
- `git diff --check`: clean.

Downstream draft PRs FC-2..FC-5 were then rebased on the hardened FC-1 head.

## Post-Rebase Stack Verification

Commands run from `/private/tmp/metasheet2-fc5-formula-condition` after the
FC-1 hardening and FC-2..FC-5 restack:

```sh
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-condition-formula.test.ts tests/unit/approval-graph-executor.test.ts tests/unit/approval-product-service.test.ts --reporter=dot
pnpm --filter @metasheet/web exec vitest run approval-common-template-presets approvalTemplateAuthoring approval-detail-field approval-template-authoring-detail approval-template-authoring-graph-preserve approval-template-authoring-condition-edit approval-template-authoring-parallel-edit approval-template-authoring-cc-edit approval-template-authoring-approval-node-edit approval-template-authoring-complex-node-config-allowlist approval-graph-topology-edit approval-graph-layout amountAutoSum useAutoSumTotal lineDerivation --reporter=dot
pnpm --filter @metasheet/web type-check
pnpm --filter @metasheet/core-backend type-check
git diff --check
```

Results:

- Backend focused unit suite: 98/98 passed.
- Approval web guard equivalent specs: 259/259 passed.
- `vue-tsc -b`: clean.
- Backend `tsc --noEmit`: clean.
- `git diff --check`: clean.

GitHub state during the original draft-stack restack:

- FC-1 #3219: all required checks green; `Strict E2E with Enhanced Gates`
  skipped as expected.
- FC-2 #3220: `approval-web-guard` and `pr-validate` green.
- FC-3 #3221: `approval-web-guard` and `pr-validate` green.
- FC-4 #3222: `pr-validate` green.
- FC-5 #3223: `approval-web-guard` and `pr-validate` green.
These entries are historical evidence from the draft-stack review. Current
state is the shipped/pending table above.

## FC-5 Verification

Commands run from `/private/tmp/metasheet2-fc5-formula-condition`:

```sh
pnpm --filter @metasheet/web exec vitest run approvalTemplateAuthoring approval-template-authoring-condition-edit --reporter=dot
pnpm --filter @metasheet/web exec vitest run approval-common-template-presets approvalTemplateAuthoring approval-detail-field approval-template-authoring-detail approval-template-authoring-graph-preserve approval-template-authoring-condition-edit approval-template-authoring-parallel-edit approval-template-authoring-cc-edit approval-template-authoring-approval-node-edit approval-template-authoring-complex-node-config-allowlist approval-graph-topology-edit approval-graph-layout amountAutoSum useAutoSumTotal lineDerivation --reporter=dot
pnpm --filter @metasheet/web type-check
pnpm --filter @metasheet/web lint
pnpm --filter @metasheet/web exec eslint src/views/approval/TemplateAuthoringView.vue tests/approvalTemplateAuthoring.spec.ts --max-warnings=0
git diff --check
```

Results:

- Focused frontend specs: 69/69 passed.
- Approval web guard equivalent specs: 259/259 passed.
- `vue-tsc -b`: clean.
- Repository-configured web lint: clean.
- Direct lint of the touched SFC/spec: clean.
- `git diff --check`: clean.

Note: direct linting of `src/approvals/api.ts` still hits a pre-existing
unrelated unused-parameter issue at `approvalId`; the FC-5 API addition is
covered by `vue-tsc -b` and the mounted wiring test.

## Boundaries

- FC-5 is UX-only over the FC-4 approval-specific dry-run endpoint.
- The dry-run preview is explicit-button only, not per-keystroke.
- Dry-run result text is informational only. It is not a save/publish gate.
- Sample JSON stays local to the authoring component and never enters the
  template payload.
- The mounted wiring test proves button -> endpoint payload -> result display,
  then save still emits only the formula graph config and preserves topology.

## Remaining Before Final Closeout

- Land FC-5 after rebasing onto the FC-4 squash and re-running its gates.
- Stamp the FC-5 squash SHA in this record and the design-lock.
- Update the design-lock status to `RATIFIED + SHIPPED`.
