# Approval Template Authoring Frontend MVP Design Lock - 2026-06-04

## Verdict

Approval Center can move forward with a frontend template-authoring MVP.

This is an Approval product UI slice, not a workflow-automation slice. It should expose existing approval-template runtime capabilities to template managers, while keeping multitable automation, trigger bindings, BPMN runtime, and approval-as-job untouched.

## Current State

Grounded on `origin/main@3e8382a8f`.

The backend already supports the core template lifecycle:

- `POST /api/approval-templates` creates a draft template behind `approval-templates:manage`.
- `PATCH /api/approval-templates/:id` updates metadata and can create a new draft version when `formSchema` or `approvalGraph` is supplied.
- `POST /api/approval-templates/:id/publish` publishes the latest version and freezes `runtime_graph`.
- `POST /api/approvals` starts an approval from an active published template behind `approvals:write`.

The frontend already supports the consumer side:

- `/approval-templates` lists templates and allows starting an approval from published templates.
- `/approvals/new/:templateId` renders the published template form and submits approval instances.
- `/approval-templates/:id` shows template metadata, form fields, visibility rules, and approval graph.

The missing frontend surface is template authoring:

- `TemplateCenterView.vue` renders a `新建模板` button, but it is disabled with tooltip `即将上线`.
- `approvals/api.ts` has list/get/clone/category/visibility/SLA helpers, but no generic `createTemplate`, `updateTemplate`, or `publishTemplate` wrappers.
- There is no UI for authoring `formSchema.fields` or `approvalGraph.nodes/edges`.

## Scope

Build a small, production-usable authoring UI for administrators who hold `approval-templates:manage`.

### In Scope

1. New template entry
   - Enable `新建模板` for `canManageTemplates`.
   - Route to a dedicated authoring view, for example `/approval-templates/new`.
   - Non-managers must not see or enter the authoring surface.

2. API client wrappers
   - Add typed wrappers in `apps/web/src/approvals/api.ts`:
     - `createTemplate(payload)`
     - `updateTemplate(templateId, payload)`
     - `publishTemplate(templateId, payload)`
   - The wrappers should use existing endpoints only. No backend route changes are expected in the MVP.

3. Basic template metadata
   - Key, name, description, category.
   - Visibility scope: `all`, `dept`, `role`, `user` with comma-separated ids for non-`all` scopes.
   - SLA hours: positive integer or empty/null.

4. Form schema builder
   - Add/edit/delete/reorder fields.
   - Supported MVP field types:
     - `text`
     - `textarea`
     - `number`
     - `date`
     - `datetime`
     - `select`
     - `multi-select`
     - `user`
   - Exclude `attachment` from new authoring for now. `ApprovalNewView` has a local drag-upload placeholder, but there is no real upload/persistence path, so exposing attachment authoring would create a broken user promise.
   - Validate field id uniqueness, non-empty labels, required select options, and stable ids before submit.
   - Existing unsupported field properties, especially `visibilityRule`, should be preserved when editing an existing template but not newly authored in this MVP.

5. Linear approval graph builder
   - MVP graph is linear: `start -> approval_1 -> ... -> end`.
   - Allow one or more approval nodes.
   - Supported approval-node sources:
     - legacy static user ids
     - legacy static role ids
     - `assigneeSources: [{ kind: 'requester' }]`
     - `assigneeSources: [{ kind: 'form_field_user', fieldId }]`
   - `form_field_user` can only choose fields of type `user`.
   - Supported modes:
     - `single`
     - `all`
     - `any`
   - Supported empty-assignee policies:
     - `error`
     - `auto-approve`
   - Do not expose parallel gateways, condition nodes, admin jump, SLA breach actions, add-sign/countersign, or BPMN in this slice.
   - Edit safety is mandatory: if an existing template carries unsupported graph constructs such as parallel gateways, condition nodes, add-sign/countersign, admin jump, SLA breach actions, or unknown node/edge shapes, the authoring view must block saving and either show a read-only state or route the user back with an explicit unsupported-template message. It must never silently flatten or overwrite an unsupported graph with the MVP linear graph.

6. Publish action
   - Add a publish action for template managers.
   - MVP publish policy may expose only `allowRevoke`; default should be explicit in the UI.
   - Auto-approval policy and revoke windows remain deferred unless separately scoped.

7. Start-approval compatibility
   - A template created and published through the new UI must be visible in `/approval-templates`.
   - A user with `approvals:write` must be able to start an approval from it through `/approvals/new/:templateId`.

## Non-Goals

- No new backend migration.
- No new approval backend endpoint.
- No approval trigger bindings.
- No multitable/public-form submit-to-approval binding.
- No approval result backwrite to multitable records.
- No automation `start_approval` action.
- No A6 approval-as-job bridge.
- No BPMN runtime or workflow designer coupling.
- No attachment upload runtime.
- No full role/user directory picker. Text/id entry is acceptable for the first MVP if labels make that clear.
- No field visibility authoring UI. Preserve existing `visibilityRule` data when present; authoring it is a later slice.

## Permission Model

Keep the existing separation:

| Operation | Permission |
|---|---|
| list/read templates | `approvals:read` |
| create/edit/publish templates | `approval-templates:manage` |
| start approvals | `approvals:write` |
| act on approvals | `approvals:act` |

The authoring view must not rely on frontend-only guards. Backend RBAC is already authoritative; frontend guards are for discoverability and avoiding dead affordances.

## Data Shape

### Minimal `formSchema`

```ts
{
  fields: Array<{
    id: string
    type: 'text' | 'textarea' | 'number' | 'date' | 'datetime' | 'select' | 'multi-select' | 'user'
    label: string
    required?: boolean
    placeholder?: string
    options?: Array<{ label: string; value: string }>
    defaultValue?: unknown
  }>
}
```

### Minimal linear `approvalGraph`

```ts
{
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    {
      key: 'approval_1',
      type: 'approval',
      name: '审批人 1',
      config: {
        approvalMode: 'single' | 'all' | 'any',
        emptyAssigneePolicy: 'error' | 'auto-approve',
        assigneeSources?: ApprovalAssigneeSource[],
        assigneeType?: 'user' | 'role',
        assigneeIds?: string[],
      },
    },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
    { key: 'edge-approval_1-end', source: 'approval_1', target: 'end' },
  ],
}
```

Prefer `assigneeSources` for new dynamic-source authoring. Legacy `assigneeType/assigneeIds` may still be emitted for static user/role because current read views already understand them.

## UX Shape

The MVP should feel like an admin tool, not a workflow designer.

Follow the existing approvals frontend string convention for this MVP: inline Chinese copy is acceptable because the current approval views already use inline Chinese instead of a strict label module. Do not import the multitable strict-zero i18n pattern into this slice unless a later approval-wide i18n track is explicitly scoped.

Recommended structure:

1. Header
   - Back to template center.
   - Save draft.
   - Publish.
   - Loading/error state.

2. Basic info panel
   - Key, name, description, category, visibility, SLA.

3. Form fields panel
   - Dense table/list of fields.
   - Add field drawer/dialog.
   - Reorder controls.

4. Approval steps panel
   - Linear step list.
   - Add approval step.
   - Source type selector.
   - Mode and empty-assignee policy controls.

5. JSON preview/debug panel
   - Collapsible raw `formSchema` and `approvalGraph` preview for implementers.
   - Read-only. Do not make raw JSON editing the primary UX.

## Test Matrix

Frontend specs should cover:

| Test | Expected |
|---|---|
| Non-manager cannot access authoring UI | button hidden/disabled and route guard blocks or shows no-permission state |
| Create draft | sends `POST /api/approval-templates` with metadata, `formSchema`, and linear `approvalGraph` |
| Update draft | sends `PATCH /api/approval-templates/:id` and preserves existing `visibilityRule` properties |
| Edit unsupported graph | existing template with unsupported graph/node/edge constructs opens read-only or blocks save with an explicit message; saving must not flatten the graph |
| Preserve unsupported field metadata | editing an unrelated field and saving round-trips existing `visibilityRule` data unchanged |
| Publish | sends `POST /api/approval-templates/:id/publish` with explicit policy |
| Field validation | duplicate field ids and empty select options block save |
| `form_field_user` validation | only user fields are selectable |
| Unsupported attachment | cannot author new attachment field |
| Start compatibility smoke | created/published template shape renders in `ApprovalNewView` and submits via `createApproval` mock/client path |

Backend tests are not required if no backend code changes. If the implementation changes route payload shape, add route tests before merging.

## Rollout Plan

1. Land this design-lock and TODO.
2. Implement frontend-only MVP in a small PR.
3. Run targeted frontend specs and typecheck.
4. Do one real-stack UAT:
   - manager creates a template;
   - manager publishes it;
   - writer starts an approval;
   - actor approves/rejects;
   - requester sees it under `我发起的`.

## Review Checklist

Reviewers should explicitly check:

- No automation/A6 files changed.
- No trigger-binding/backwrite/start-approval/BPMN behavior added.
- Template creation remains behind `approval-templates:manage`.
- Approval start remains behind `approvals:write`.
- Dynamic assignee source config matches the backend resolver contract.
- Editing an existing template cannot silently destroy unsupported graph or field metadata.
- The UI cannot create a template that `ApprovalProductService.createTemplate()` would reject for obvious client-side reasons.
