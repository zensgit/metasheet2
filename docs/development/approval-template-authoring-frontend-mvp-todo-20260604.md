# Approval Template Authoring Frontend MVP TODO - 2026-06-04

Status: **Frontend MVP implemented in this branch; real-stack UAT pending**.

Canonical design: `docs/development/approval-template-authoring-frontend-mvp-design-20260604.md`.

## Goal

Make Approval Center usable end-to-end for template managers:

`new/edit template -> publish -> users start approval -> approvers act`.

This TODO covers only the frontend authoring MVP. It does not authorize approval trigger bindings, automation `start_approval`, BPMN runtime, or A6 approval-as-job work.

## Progress

| Item | Status |
|---|---|
| Design-lock | [x] landed via #2292 |
| API client wrappers | [x] implemented |
| Template authoring route/view | [x] implemented |
| Form schema builder | [x] implemented |
| Linear approval graph builder | [x] implemented |
| Publish UI | [x] implemented |
| Frontend tests/typecheck | [x] passed |
| Real-stack UAT | [ ] not started |

## Implementation Tasks

### A1. API Client

- [x] Add `createTemplate()` wrapper in `apps/web/src/approvals/api.ts`.
- [x] Add generic `updateTemplate()` wrapper or a narrow `updateTemplateDraft()` wrapper that can send `formSchema` and `approvalGraph`.
- [x] Add `publishTemplate()` wrapper.
- [x] Add request/response types in `apps/web/src/types/approval.ts` if missing.
- [x] Keep existing metadata helpers (`updateTemplateCategory`, `updateTemplateVisibilityScope`, `updateTemplateSlaHours`) working.

### A2. Routing and Entry

- [x] Add `/approval-templates/new` route.
- [x] Consider `/approval-templates/:id/edit` for draft/latest-version editing.
- [x] Enable `新建模板` button only when `canManageTemplates`.
- [x] Add route-level no-permission state for users without `approval-templates:manage`.

### A3. Authoring View Shell

- [x] Create a dedicated authoring view, for example `TemplateAuthoringView.vue`.
- [x] Header actions: back, save draft, publish.
- [x] Show save/publish loading state separately.
- [x] Preserve server validation errors and show them near the relevant section when possible.
- [x] Follow the existing approval frontend convention: inline Chinese copy is acceptable in this MVP; do not introduce a multitable-style strict label module unless an approval-wide i18n slice is scoped.

### A4. Basic Metadata Editor

- [x] Key.
- [x] Name.
- [x] Description.
- [x] Category.
- [x] Visibility scope.
- [x] SLA hours.
- [x] Client validation for key/name.

### A5. Form Schema Builder

- [x] Field list with add/edit/delete/reorder.
- [ ] Supported field types:
  - [x] text
  - [x] textarea
  - [x] number
  - [x] date
  - [x] datetime
  - [x] select
  - [x] multi-select
  - [x] user
- [x] Required flag.
- [x] Placeholder.
- [x] Preserve existing `defaultValue` where safe; new default-value authoring remains omitted in this MVP.
- [x] Select/multi-select options editor.
- [x] Block duplicate field ids.
- [x] Block empty field ids/labels.
- [x] Block empty select option labels/values.
- [x] Do not allow new `attachment` fields in this MVP.
- [x] Preserve existing `visibilityRule` metadata when editing old templates.

### A6. Linear Approval Graph Builder

- [x] Linear step list.
- [x] Add/remove/reorder approval steps.
- [x] Approval mode: `single`, `all`, `any`.
- [x] Empty assignee policy: `error`, `auto-approve`.
- [x] Static user ids source.
- [x] Static role ids source.
- [x] Requester source.
- [x] Form-field user source.
- [x] Only allow `form_field_user` to reference fields of type `user`.
- [x] Emit deterministic node keys and edge keys.
- [x] Do not expose parallel/condition/BPMN nodes.
- [x] When editing an existing template, detect unsupported graph constructs and block saving or open read-only with an explicit unsupported-template message.
- [x] Never silently flatten an unsupported existing graph into the MVP linear graph.

### A7. Publish UX

- [x] Add publish button for template managers.
- [x] Confirm before publishing.
- [x] Send explicit publish policy.
- [x] MVP may expose only `allowRevoke`.
- [x] After publish, return to template detail or template center and refresh.

### A8. Tests

- [x] API/payload spec for create/update/publish payload shape.
- [x] Template center spec for enabled `新建模板` entry and non-manager hiding/disabled behavior.
- [x] Authoring view create-draft spec.
- [x] Authoring view update-draft spec.
- [x] Publish spec.
- [x] Field validation spec.
- [x] Existing `visibilityRule` round-trip spec: edit an unrelated supported field, save, and assert unsupported field metadata survives.
- [x] Unsupported graph edit-safety spec: existing parallel/condition/add-sign/unknown graph cannot be saved through the linear builder.
- [x] `form_field_user` guard spec.
- [x] Attachment not-authorable spec.
- [x] Existing `ApprovalNewView` compatibility path remains covered by approval permission/lifecycle specs; real-stack UAT remains pending.
- [x] Typecheck.

### A9. UAT

- [ ] Manager creates a simple two-field template.
- [ ] Manager configures one approval step with static user or requester source.
- [ ] Manager publishes template.
- [ ] Writer starts approval from `/approval-templates`.
- [ ] Actor approves.
- [ ] Requester sees terminal state under `我发起的`.
- [ ] Non-manager cannot enter authoring view.

## Explicitly Deferred

- [ ] Field visibility rule editor.
- [ ] Attachment upload field authoring.
- [ ] Directory-backed user/role picker.
- [ ] Parallel gateway authoring.
- [ ] Condition gateway authoring.
- [ ] BPMN designer/runtime connection.
- [ ] Approval trigger bindings.
- [ ] Public form / multitable submit-to-approval binding.
- [ ] Approval result backwrite.
- [ ] Automation `start_approval`.
- [ ] Approval-as-job / A6-5 convergence.

## Merge Gate for Implementation PR

The implementation PR is not ready unless:

- all new frontend specs pass;
- `pnpm --filter @metasheet/web exec vue-tsc -b` or the repo's current frontend typecheck equivalent passes;
- no backend files are changed unless a backend-specific issue is found and separately called out;
- no automation/A6 files are changed;
- unsupported existing graph or field metadata is preserved or explicitly blocked, never silently discarded;
- the PR description includes an operator UAT checklist.
