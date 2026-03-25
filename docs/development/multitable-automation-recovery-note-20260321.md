# Multitable Automation Recovery Note

Date: 2026-03-21
Branch: `codex/multitable-fields-views-linkage-automation-20260312`

## Why automation was not resumed first

During recovery, the `multitable` capability path itself was healthy:

- multitable frontend specs passed
- multitable backend integration specs passed
- `apps/web` build passed
- `packages/core-backend` build passed

The blocker is not inside the multitable module. It is the current workflow-designer chain that automation would have to depend on.

## Current workflow-designer mismatch

### Backend table mismatch

`packages/core-backend/src/routes/workflow-designer.ts` currently queries tables that do not exist in the checked-in migrations:

- `workflow_designer_definitions`
- `workflow_collaboration`
- `workflow_execution_history`

But `packages/core-backend/src/db/migrations/zzzz20260309103000_create_workflow_designer_support_tables.ts` only creates:

- `workflow_definitions`
- `workflow_templates`
- `workflow_node_library`
- `workflow_analytics`

### Backend service mismatch

`packages/core-backend/src/workflow/WorkflowDesigner.ts` persists to `workflow_definitions`, while the route layer reads from `workflow_designer_definitions`.

That means a newly created workflow would not be readable through the current route path even if creation succeeded.

### Frontend contract mismatch

`apps/web/src/views/WorkflowDesigner.vue` currently assumes:

- load response fields like `name`, `description`, `version`, `bpmnXml`
- create response field `id`
- save payload shape based on `bpmnXml`

But `packages/core-backend/src/routes/workflow-designer.ts` uses a different envelope and a different model:

- `success` / `data`
- workflow create returns `data.workflowId`
- workflow definitions are validated as `nodes` + `edges` JSON, not raw BPMN XML

## Recommended next automation recovery order

1. Unify workflow-designer persistence and route reads onto one table model.
2. Decide the canonical workflow payload contract: visual JSON, BPMN XML, or both.
3. Fix `apps/web/src/views/WorkflowDesigner.vue` to that contract.
4. Only after that, add multitable automation entrypoints and starter templates.

## Recovery decision for this turn

Because automation depends on the broken workflow-designer chain, development resumed on a contained multitable backlog item instead:

- attachment preview / thumbnail rendering in grid, form, and record drawer
