# Multitable Automation A6-4 BPMN Compile/Preview Scope Gate - 2026-06-12

Status: docs-only scope gate

Grounded on: `origin/main@52ce8279d`

Scope: A6-4 / W8 only - BPMN as a compile/preview and gap-report input for the
existing automation + approval substrate.

Runtime: not started

## Verdict

A6-4 may open only as a side-effect-free compile/preview adapter.

The adapter may parse existing Workflow Designer visual definitions or BPMN XML
drafts and return:

- an automation preview;
- an approval preview;
- a deterministic gap report;
- supported mapping evidence.

It must not deploy, start, execute, persist, publish, or mutate anything. BPMN is
a modeling language in this line, not a fourth production runtime.

## Grounding

Current main already has enough substrate for a useful constrained preview:

- A6-1 persistent `WorkflowJob` runtime is production reachable through
  rule-level `execution_mode`.
- A6-2 `wait_for_callback` suspend/resume is admin-gated and complete.
- A6-3 has both `condition_branch` exclusive branching and `parallel_branch`
  `joinMode: 'all'` fan-out/fan-in.
- W6-1 `start_approval` can start one approval instance from automation and
  resume or fail from W5 terminal completion events.
- Approval remains source-of-truth for approval templates, published runtime
  graphs, assignments, permissions, and task state.

Current main also has older Workflow Designer / BPMN surfaces:

- `WorkflowDesigner` supports visual node types such as start/end events,
  user/service/script tasks, exclusive/parallel gateways, and intermediate catch
  events.
- `POST /api/workflow-designer/workflows/:id/deploy` can deploy BPMN XML through
  `BPMNWorkflowEngine`.
- `POST /api/workflow/deploy` and `POST /api/workflow/start/:key` are live BPMN
  engine routes.
- `POST /api/workflow-designer/workflows/:id/test` writes a synthetic completed
  draft execution and is not a proof of automation/approval execution.

Those existing live BPMN routes are not the A6-4 target. A6-4 must not extend
them into the convergence engine v1 path.

## Scope Decision

### In Scope

1. Add a pure compile-preview module and, if needed, a read-only authenticated
   preview route.
2. Accept one of these inputs:
   - a Workflow Designer visual definition; or
   - a BPMN XML draft loaded from the existing designer draft.
3. Return a preview payload with:
   - `automationPreview`: proposed automation actions / graph shape;
   - `approvalPreview`: proposed approval-template or approval-runtime shape;
   - `gapReport`: unsupported nodes, unsupported mappings, and why;
   - `mappingReport`: which BPMN elements mapped to existing A6/W5/W6
     primitives;
   - `warnings`: non-blocking fidelity or authoring warnings.
4. Reuse existing automation and approval vocabulary:
   - automation actions: `condition_branch`, `parallel_branch`,
     `wait_for_callback`, `start_approval`, and the already-supported simple
     side-effect actions where explicitly configured;
   - C1 status and job vocabulary only in explanatory preview metadata, never a
     new status model;
   - approval source vocabulary and published-graph concepts only as preview.
5. Produce deterministic output: same input, same preview and same gap ordering.
6. Redact secret-shaped values from preview output before returning it.

### Out of Scope / Hard No

- No call to `BPMNWorkflowEngine.deployProcess()` or
  `BPMNWorkflowEngine.startProcess()`.
- No use of the old live `/api/workflow/deploy` or `/api/workflow/start/:key`
  paths as the A6-4 implementation path.
- No writes to `bpmn_*`, `workflow_definitions`, automation rule tables,
  approval template tables, automation execution tables, or automation job
  tables.
- No creation, update, publish, deploy, start, retry, resume, or backwrite.
- No live BPMN execution route.
- No second run store, audit store, job table, or status vocabulary.
- No generic JavaScript / SQL / HTTP code node.
- No branch-local `wait_for_callback` or nested branch mapping until A6-3-3 is
  explicitly unlocked.
- No `join_any` / cancellation mapping until A6-3-5 is explicitly unlocked.
- No result backwrite mapping until W7 runtime is explicitly unlocked.
- No public webhook/token emitter.

## Mapping Contract

The first implementation must be conservative. If a mapping is not fully
grounded in landed automation or approval contracts, it goes to the gap report
instead of being silently dropped or approximated.

| BPMN / designer element | Preview behavior |
|---|---|
| Start event | Structural only. It may identify the trigger boundary, but must not invent a new trigger binding. |
| End event | Structural only. It may close the preview graph. |
| Service task | Maps only when the node explicitly names a supported automation action and provides the required config shape. Otherwise gap. |
| User task | Maps to an approval preview only when it can express a supported approval assignee source and form shape. Otherwise gap. |
| Exclusive gateway | Maps to `condition_branch` preview when outgoing conditions and a default path can be expressed in the existing condition model. Otherwise gap. |
| Parallel gateway split + matching join | Maps to `parallel_branch` with `joinMode: 'all'` only when the split/join pair is well-formed. Otherwise gap. |
| Intermediate catch event, message/signal | Gap until public webhook/token emitter is explicitly scoped. |
| Intermediate catch event, timer | Gap until delay/timer resume and durable scheduler semantics are explicitly scoped. |
| Script task | Gap. Generic code execution is out of scope. |
| Inclusive gateway, event gateway, boundary event, subprocess, call activity | Gap in v1. |

## Shape of the Preview Response

The exact TypeScript shape belongs in the implementation PR, but the first slice
should expose this structure:

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

`supported` means "all required runtime mappings are supported by existing,
landed contracts." It must not mean "safe to deploy as BPMN."

## Implementation Entry Point

The first implementation PR should start with a pure module and route only if the
module is already deterministic:

1. Build a pure compiler function that accepts normalized designer/BPMN input.
2. Add unit tests for supported and unsupported mappings.
3. Add a read-only preview route only after the pure module is stable.
4. Add route tests proving no persistence and no live BPMN engine calls.
5. Add frontend only after the response contract is stable.

Recommended route shape if a route is added:

```text
POST /api/workflow-designer/workflows/:id/compile-preview
```

That route name is intentionally different from `deploy`, `test`, `start`, or
`publish`.

## Required Tests

The implementation PR must include focused tests before merge:

1. **Side-effect free:** preview does not call deploy/start/publish/create/update
   services and performs no DB writes except ordinary read queries needed to load
   the draft.
2. **No live BPMN engine:** spies or dependency injection prove the preview route
   does not call `BPMNWorkflowEngine.deployProcess()` or `startProcess()`.
3. **Exclusive gateway mapping:** a valid exclusive gateway maps to
   `condition_branch`; missing default or unrepresentable condition goes to
   `gapReport`.
4. **Parallel gateway mapping:** a well-formed split/join maps to
   `parallel_branch` with `joinMode: 'all'`; mixed split/join or unmatched join
   goes to `gapReport`.
5. **Unsupported node report:** script task, inclusive gateway, event gateway,
   subprocess, boundary event, and call activity produce deterministic gaps.
6. **Timer/message gap:** intermediate catch timer/message/signal events are
   reported as gated, not silently compiled.
7. **Redaction:** secret-shaped values in node config are redacted in
   `automationPreview`, `approvalPreview`, and gap/warning text.
8. **Stable output:** equivalent input produces stable, sorted mapping/gap
   output.
9. **No new runtime route:** route inventory or tests prove no new live
   `/start`, `/deploy`, or execution route was added.

## Re-entry Signal

The owner unlock phrase for runtime implementation should be explicit, for
example:

> Start A6-4 BPMN compile-preview adapter only: side-effect-free preview +
> deterministic gap report, no deploy/start/live BPMN runtime, no persistence,
> gateway mappings to existing A6-3 condition/parallel primitives.

"Continue workflow automation" is not enough for A6-4 runtime implementation.

## Exit Criteria for This Scope Gate

This docs-only scope gate is complete when:

- the A6 execution plan points to this file for A6-4 detail;
- the run-governance TODO distinguishes "A6-4 scope-gate recorded" from
  "A6-4 implementation not started";
- the workflow/automation completion ledger lists W8 as scoped but not built;
- no runtime files, migrations, routes, or tests change in this PR.
