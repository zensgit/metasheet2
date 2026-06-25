# Approval Formula Conditions — Stack Verification Snapshot

Status: draft stack, not merged. This record documents the FC-1..FC-5 stacked
implementation state as of 2026-06-25. It is intentionally a snapshot, not a
"shipped" declaration.

## Stack

| Slice | PR | Base | Head | State |
| --- | --- | --- | --- | --- |
| FC-1 evaluator | #3219 | `main` | `7b0cb4f08` | open draft, GitHub checks green |
| FC-2 authoring | #3220 | `codex/approval-formula-condition-fc1-20260625` | `b5d8b2230` | open draft, GitHub checks green |
| FC-3 preset examples | #3221 | `codex/approval-formula-condition-fc2-20260625` | `bf0e30124` | open draft, GitHub checks green |
| FC-4 backend dry-run | #3222 | `codex/approval-formula-condition-fc3-20260625` | `e446d4095` | open draft, GitHub checks green |
| FC-5 dry-run preview | #3223 | `codex/approval-formula-condition-fc4-20260625` | this verification commit | open draft, GitHub checks green |

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

GitHub state after the restack:

- FC-1 #3219: all required checks green; `Strict E2E with Enhanced Gates`
  skipped as expected.
- FC-2 #3220: `approval-web-guard` and `pr-validate` green.
- FC-3 #3221: `approval-web-guard` and `pr-validate` green.
- FC-4 #3222: `pr-validate` green.
- FC-5 #3223: `approval-web-guard` and `pr-validate` green.
- All five PRs remain draft and unmerged.

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

## Remaining Before Shipping

- Keep the stack order: FC-1 -> FC-2 -> FC-3 -> FC-4 -> FC-5.
- Rebase each slice after the previous one lands.
- Re-run that slice's gates on the rebased head before marking ready.
- After the full stack lands, update this record or the design-lock status from
  draft-stack to shipped.
