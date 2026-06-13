# Multitable Automation A6-4a BPMN Compile/Preview Implementation Plan - 2026-06-12

Status: docs-only implementation plan; implemented by #2568

Grounded on: `origin/main@508c8aa2d`

Parent scope gate:
`multitable-automation-a6-4-bpmn-compile-preview-scope-gate-20260612.md`

Runtime: no live runtime; A6-4a pure compiler landed #2568; A6-4b route not started

## Verdict

A6-4a, explicitly unlocked on 2026-06-13, implemented only the pure compiler
core for BPMN / Workflow Designer compile-preview in #2568.

It must not add a route, DB write, migration, live BPMN execution path, frontend
entry point, or persistence side effect. The route belongs to A6-4b, after the
compiler output is deterministic and unit-tested.

## Why A6-4a Is Split From The Route

The existing `workflow-designer` route file already contains live BPMN deploy
and synthetic test surfaces:

- `POST /api/workflow-designer/workflows/:id/deploy` calls
  `BPMNWorkflowEngine.deployProcess()` when a draft has `bpmnXml`.
- `POST /api/workflow-designer/workflows/:id/test` appends a synthetic completed
  draft execution.
- `POST /api/workflow/deploy` and `POST /api/workflow/start/:key` are existing
  live BPMN engine routes.

A6-4 must not drift into those paths. The first safe slice is therefore a pure
module with no Express router dependency and no `BPMNWorkflowEngine`
dependency.

## A6-4a Change Set

Add exactly one production module and one unit test file:

```text
packages/core-backend/src/workflow/bpmnCompilePreview.ts
packages/core-backend/tests/unit/bpmn-compile-preview.test.ts
```

No other production files should change in A6-4a unless TypeScript export wiring
forces a minimal type-only import.

## Public Module Contract

The module should export a pure function:

```ts
export type BpmnCompilePreviewInput =
  | {
      mode: 'visual'
      workflowId?: string
      sourceVersion?: number
      visual: WorkflowDefinition
    }
  | {
      mode: 'bpmn_xml'
      workflowId?: string
      sourceVersion?: number
      bpmnXml: string
    }

export function compileBpmnPreview(input: BpmnCompilePreviewInput): BpmnCompilePreview
```

The exact internal helper names are free to change, but the module boundary must
stay pure:

- no DB import;
- no Express import;
- no `BPMNWorkflowEngine` import;
- no `WorkflowDesigner` instance construction;
- no route, deploy, start, publish, retry, resume, or backwrite call.

## Parser Boundary

For `mode: 'visual'`, consume the existing
`WorkflowDefinition` / `WorkflowNode` / `WorkflowEdge` shape from
`WorkflowDesigner.ts`.

For `mode: 'bpmn_xml'`, it is acceptable to use the existing backend `xml2js`
dependency as a parser library. Do not import or instantiate
`BPMNWorkflowEngine`; its parser is private and sits inside the live runtime
engine.

If XML parsing fails, return a deterministic unsupported preview with a single
gap entry for invalid XML instead of throwing an unshaped parser error.

## Output Shape

A6-4a should use the parent scope gate response shape:

```ts
type BpmnCompilePreview = {
  source: {
    workflowId?: string
    mode: 'visual' | 'bpmn_xml'
    sourceVersion?: number
  }
  supported: boolean
  automationPreview?: {
    actions: unknown[]
    requiresExecutionMode: 'workflow_job_v1'
  }
  approvalPreview?: {
    formSchema?: unknown
    approvalGraph?: unknown
    runtimeGraphPreview?: unknown
  }
  mappingReport: Array<{
    bpmnElementId: string
    bpmnElementType: string
    target: 'automation' | 'approval' | 'structural'
    targetKind: string
  }>
  gapReport: Array<{
    bpmnElementId: string
    bpmnElementType: string
    reason: string
    requiredRung?: 'A6-3-3' | 'A6-3-5' | 'W7' | 'public-webhook' | 'unsupported'
  }>
  warnings: string[]
}
```

`supported: true` means every non-structural element in the input mapped to an
already-landed automation or approval primitive. It does not mean the BPMN can be
deployed or started.

## First Mapping Rules

The first compiler is intentionally conservative:

| Source element | A6-4a behavior |
|---|---|
| Start event | Structural mapping only. No trigger binding. |
| End event | Structural mapping only. |
| Service task | Map only when config explicitly names a supported automation action shape. Otherwise gap. |
| User task | Map only when config explicitly describes a supported approval preview shape. Otherwise gap. |
| Exclusive gateway | Map to `condition_branch` only when outgoing edges have representable conditions and a default path. Otherwise gap. |
| Parallel gateway split + matching join | Map to `parallel_branch` with `joinMode: 'all'` only when the split/join pair is well-formed. Otherwise gap. |
| Intermediate catch event, message/signal | Gap with `requiredRung: 'public-webhook'`. |
| Intermediate catch event, timer | Gap with `requiredRung: 'unsupported'` until delay/timer resume is separately scoped. |
| Script task | Gap with `requiredRung: 'unsupported'`. |
| Inclusive gateway / event gateway / boundary event / subprocess / call activity | Gap with `requiredRung: 'unsupported'`. |

Do not approximate unsupported nodes by dropping them. Every unsupported element
must appear in `gapReport`.

## Determinism Rules

Unit tests should lock these ordering rules:

- sort `mappingReport` by `bpmnElementId`, then `target`, then `targetKind`;
- sort `gapReport` by `bpmnElementId`, then `bpmnElementType`, then `reason`;
- sort `warnings` lexicographically;
- use stable branch keys derived from source element ids;
- do not include timestamps, random ids, or environment-dependent strings.

## Redaction

The compiler must run the final response through
`redactValue()` from `packages/core-backend/src/multitable/automation-log-redact.ts`
before returning it.

The redaction test must include at least:

- secret-shaped service-task config;
- auth/header-shaped config keys;
- secret-shaped warning or gap text.

## Required Tests For A6-4a

1. Visual start/end-only input returns `supported: true`, structural mapping
   entries, and no actions.
2. Visual exclusive gateway maps to `condition_branch` when default and
   conditions are representable.
3. Visual exclusive gateway without a default path goes to `gapReport`.
4. Visual parallel split/join maps to `parallel_branch` with `joinMode: 'all'`.
5. Unmatched or ambiguous parallel gateways go to `gapReport`.
6. Script task, inclusive gateway, event gateway, subprocess, boundary event, and
   call activity produce deterministic gaps.
7. Timer/message/signal catch events produce gated gaps, not
   `wait_for_callback` mappings.
8. Secret-shaped values are redacted in all returned preview sections.
9. Equivalent input produces byte-stable output.
10. Static source test or import test proves
    `bpmnCompilePreview.ts` does not import `BPMNWorkflowEngine`, route modules,
    `db`, or approval / automation mutating services.

## A6-4b Follow Slice

After A6-4a landed in #2568, A6-4b may add the read-only route only under a
separate explicit opt-in:

```text
POST /api/workflow-designer/workflows/:id/compile-preview
```

A6-4b must:

- load the draft through `WorkflowDesigner.loadWorkflowDraft()`;
- require ordinary draft access (`hasWorkflowDraftAccess`), not deploy access;
- call only `compileBpmnPreview()`;
- prove no call to `ensureWorkflowEngineReady()`,
  `BPMNWorkflowEngine.deployProcess()`, or `BPMNWorkflowEngine.startProcess()`;
- prove no write to `workflow_definitions`, BPMN tables, automation tables,
  approval tables, execution tables, or job tables.

## Re-entry

This document is not an authorization for A6-4b by itself. A6-4a has landed; the
owner still must explicitly unlock any route/UI follow-up using the parent
scope gate language:

> Start A6-4 BPMN compile-preview adapter only: side-effect-free preview +
> deterministic gap report, no deploy/start/live BPMN runtime, no persistence,
> gateway mappings to existing A6-3 condition/parallel primitives.
