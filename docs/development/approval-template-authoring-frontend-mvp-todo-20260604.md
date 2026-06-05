# Approval Template Authoring Frontend MVP TODO - 2026-06-04

Status: **Design-lock proposed, implementation not started**.

Canonical design: `docs/development/approval-template-authoring-frontend-mvp-design-20260604.md`.

## Goal

Make Approval Center usable end-to-end for template managers:

`new/edit template -> publish -> users start approval -> approvers act`.

This TODO covers only the frontend authoring MVP. It does not authorize approval trigger bindings, automation `start_approval`, BPMN runtime, or A6 approval-as-job work.

## Progress

| Item | Status |
|---|---|
| Design-lock | [x] drafted in this PR |
| API client wrappers | [ ] not started |
| Template authoring route/view | [ ] not started |
| Form schema builder | [ ] not started |
| Linear approval graph builder | [ ] not started |
| Publish UI | [ ] not started |
| Frontend tests/typecheck | [ ] not started |
| Real-stack UAT | [ ] not started |

## Implementation Tasks

### A1. API Client

- [ ] Add `createTemplate()` wrapper in `apps/web/src/approvals/api.ts`.
- [ ] Add generic `updateTemplate()` wrapper or a narrow `updateTemplateDraft()` wrapper that can send `formSchema` and `approvalGraph`.
- [ ] Add `publishTemplate()` wrapper.
- [ ] Add request/response types in `apps/web/src/types/approval.ts` if missing.
- [ ] Keep existing metadata helpers (`updateTemplateCategory`, `updateTemplateVisibilityScope`, `updateTemplateSlaHours`) working.

### A2. Routing and Entry

- [ ] Add `/approval-templates/new` route.
- [ ] Consider `/approval-templates/:id/edit` for draft/latest-version editing.
- [ ] Enable `新建模板` button only when `canManageTemplates`.
- [ ] Add route-level no-permission state for users without `approval-templates:manage`.

### A3. Authoring View Shell

- [ ] Create a dedicated authoring view, for example `TemplateAuthoringView.vue`.
- [ ] Header actions: back, save draft, publish.
- [ ] Show save/publish loading state separately.
- [ ] Preserve server validation errors and show them near the relevant section when possible.
- [ ] Follow the existing approval frontend convention: inline Chinese copy is acceptable in this MVP; do not introduce a multitable-style strict label module unless an approval-wide i18n slice is scoped.

### A4. Basic Metadata Editor

- [ ] Key.
- [ ] Name.
- [ ] Description.
- [ ] Category.
- [ ] Visibility scope.
- [ ] SLA hours.
- [ ] Client validation for key/name.

### A5. Form Schema Builder

- [ ] Field list with add/edit/delete/reorder.
- [ ] Supported field types:
  - [ ] text
  - [ ] textarea
  - [ ] number
  - [ ] date
  - [ ] datetime
  - [ ] select
  - [ ] multi-select
  - [ ] user
- [ ] Required flag.
- [ ] Placeholder.
- [ ] Default value where safe.
- [ ] Select/multi-select options editor.
- [ ] Block duplicate field ids.
- [ ] Block empty field ids/labels.
- [ ] Block empty select option labels/values.
- [ ] Do not allow new `attachment` fields in this MVP.
- [ ] Preserve existing `visibilityRule` metadata when editing old templates.

### A6. Linear Approval Graph Builder

- [ ] Linear step list.
- [ ] Add/remove/reorder approval steps.
- [ ] Approval mode: `single`, `all`, `any`.
- [ ] Empty assignee policy: `error`, `auto-approve`.
- [ ] Static user ids source.
- [ ] Static role ids source.
- [ ] Requester source.
- [ ] Form-field user source.
- [ ] Only allow `form_field_user` to reference fields of type `user`.
- [ ] Emit deterministic node keys and edge keys.
- [ ] Do not expose parallel/condition/BPMN nodes.
- [ ] When editing an existing template, detect unsupported graph constructs and block saving or open read-only with an explicit unsupported-template message.
- [ ] Never silently flatten an unsupported existing graph into the MVP linear graph.

### A7. Publish UX

- [ ] Add publish button for template managers.
- [ ] Confirm before publishing.
- [ ] Send explicit publish policy.
- [ ] MVP may expose only `allowRevoke`.
- [ ] After publish, return to template detail or template center and refresh.

### A8. Tests

- [ ] API client spec for create/update/publish payload shape.
- [ ] Template center spec for enabled `新建模板` entry and non-manager hiding/disabled behavior.
- [ ] Authoring view create-draft spec.
- [ ] Authoring view update-draft spec.
- [ ] Publish spec.
- [ ] Field validation spec.
- [ ] Existing `visibilityRule` round-trip spec: edit an unrelated supported field, save, and assert unsupported field metadata survives.
- [ ] Unsupported graph edit-safety spec: existing parallel/condition/add-sign/unknown graph cannot be saved through the linear builder.
- [ ] `form_field_user` guard spec.
- [ ] Attachment not-authorable spec.
- [ ] Existing `ApprovalNewView` compatibility spec with a template authored by the new builder shape.
- [ ] Typecheck.

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
