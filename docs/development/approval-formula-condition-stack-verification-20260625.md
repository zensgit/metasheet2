# Approval Formula Conditions — Stack Verification Snapshot

Status: draft stack, not merged. This record documents the FC-1..FC-5 stacked
implementation state as of 2026-06-25. It is intentionally a snapshot, not a
"shipped" declaration.

## Stack

| Slice | PR | Base | Head | State |
| --- | --- | --- | --- | --- |
| FC-1 evaluator | #3219 | `main` | `05a4aea6f` | open draft, CI green |
| FC-2 authoring | #3220 | `codex/approval-formula-condition-fc1-20260625` | `e6ade9c09` | open draft, CI green |
| FC-3 preset examples | #3221 | `codex/approval-formula-condition-fc2-20260625` | `52690aaf4` | open draft, CI green |
| FC-4 backend dry-run | #3222 | `codex/approval-formula-condition-fc3-20260625` | `beea1d056` | open draft, pr-validate green |
| FC-5 dry-run preview | #3223 | `codex/approval-formula-condition-fc4-20260625` | `448f9e2b0` | open draft, local verification below |

## FC-5 Verification

Commands run from `/private/tmp/metasheet2-fc5-formula-condition`:

```sh
pnpm --filter @metasheet/web exec vitest run approvalTemplateAuthoring approval-template-authoring-condition-edit --reporter=dot
pnpm --filter @metasheet/web type-check
pnpm --filter @metasheet/web lint
pnpm --filter @metasheet/web exec eslint src/views/approval/TemplateAuthoringView.vue tests/approvalTemplateAuthoring.spec.ts --max-warnings=0
git diff --check
```

Results:

- Focused frontend specs: 69/69 passed.
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
