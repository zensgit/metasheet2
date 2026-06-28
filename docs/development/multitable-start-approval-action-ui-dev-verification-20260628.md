# `start_approval` automation action — editor "light-up" — dev & verification (2026-06-28)

> Status: built + verified. Grounding: `origin/main` @ `262b52524` (the form.submitted merge). Candidate-B
> "light up a BACKEND-ONLY action" slice; owner-authorized as the pairing after form.submitted
> ("表单提交 → 发起审批"). Advisor-reviewed before implementation. Frontend-only (no backend change).

## 1. The gap

`start_approval` was a fully-wired backend action (execution proven by `multitable-automation-start-approval.test.ts`,
save-validation enforced by `validateStartApprovalConfig` inside create/updateRule) **but absent from the editor's
selectable action types** (`SUPPORTED_SELECTABLE_ACTION_TYPES`) with no config UI — authorable only via direct
API. So "form submit → start approval" couldn't be built in the UI. This exposes it.

## 2. What changed (frontend only)

- **Selectable + label**: `start_approval` added to `SUPPORTED_SELECTABLE_ACTION_TYPES` + the frontend
  `AutomationActionType` union + an `automationActionTypeLabel` case ("发起审批" / "Start approval").
- **Config block** (`MetaAutomationRuleEditor.vue`): `templateId` + `formDataMapping`.
  - **templateId** — a **fetched `<select>` over approval templates** (new `client.listApprovalTemplates()` →
    `GET /api/approval-templates`) **with a free-text fallback**. That route is `rbacGuard('approvals:read')`;
    an automation author may lack it, so a 401/403/empty fetch degrades to a text input — **the select is never a
    hard dependency** (the design's single most important point).
  - **formDataMapping** — a free-form key→value rows editor (approval field → record field picker), reusing the
    `FieldPair` shape + `fieldPairsToRecord`, mirroring `update_record`.
- **Two-direction wiring** (the real work vs the config-less form.submitted): `buildActionPayload` assembles
  `{templateId, formDataMapping}`; `draftConfigFromAction` disassembles a saved mapping object back into editable
  rows. Round-trip covered by a spec.
- **Deferred (named)**: `requester` mode + `resultWriteback` — both **optional** in the backend; out of v1.
  Schema-aware mapping labels (fetching each template's form schema) is a second integration — also v2.

The UI is **authoring, not the validation gate** — `validateStartApprovalConfig` already fail-closes templateId
+ non-empty mapping at save (create/updateRule), so a bad/incomplete config is rejected server-side regardless.

## 3. Verification

- **Editor + labels specs — 110/110** (`apps/web`): `start_approval` is a selectable action; selecting it renders
  the template + mapping config; a rule **saves** as `{type:'start_approval', config:{templateId, formDataMapping}}`;
  and a **form.submitted → start_approval** rule **backfills** (templateId + mapping rows repopulate) and
  **round-trips** on save (both directions, the combo the use-case needs). `vue-tsc -b` exit 0.
- **Save-boundary validation — already covered** (no duplication): `automation-v1.test.ts` W6-1 "createRule rejects
  invalid start_approval config before persistence" → `actionConfig.templateId is required`. The UI relies on this.
- **Backend capability re-check — 14/14** (`multitable-automation-start-approval`, real DB): `start_approval`
  executes (`AutomationService → ApprovalProductService.createApproval`). No backend change in this slice.

## 4. Out of scope (named)

- `requester` mode + `resultWriteback` UI (optional backend config) — v2.
- Schema-aware mapping (per-template form-field labels) — a second integration; v2.
- `delete_record` action UI (destructive — perm/confirm/log/anti-misdelete first) · DARK rollout · API
  write-back · realtime · template · mobile — independent arcs.
