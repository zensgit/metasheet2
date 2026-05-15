# Multitable Feishu Phase 3 — Lane C PM / SME Input Checklist

- Date: 2026-05-15
- Author: Claude (Opus 4.7, 1M context), interactive harness; **read-only design preparation, no code, no TODO Status change, no implementation PR**
- Status: **Landed as read-only decision packet; not ratified.** The PM / SME inputs enumerated below are required before Lane C re-enters the active queue; this document does NOT itself ratify any input or flip the Lane C TODO Status line.
- Companion to: `docs/development/multitable-phase3-unlock-checklist-20260515.md` (Lane C section)
- Scope: enumerate what PM and SME must provide before Lane C1 (template preview + dry-run) and Lane C2 (template install + onboarding) can re-enter the active queue. Lane C is currently `pending PM / SME assignment` per the TODO — this checklist describes the inputs that would unblock it.

## 1. Charter

`docs/development/multitable-feishu-phase3-ai-hardening-plan-20260514.md` proposes five industry templates for Lane C:

1. Project management
2. CRM follow-up
3. Contract management
4. Inspection feedback
5. Recruiting pipeline

Each template ships in `packages/core-backend/src/multitable/template-library.ts` (which already hosts the V1 library surface — `MultitableTemplate` type, `listMultitableTemplates`, `getMultitableTemplate`, `installMultitableTemplate*`). C1 adds preview / dry-run endpoints; C2 adds install hardening + onboarding checklist + rollback strategy.

A template that ships is a **long-term commitment** — once exposed in product UI, fields and views become a contract for tenants who installed it. Renaming a field after install requires migration. The PM / SME inputs gathered here become that contract.

## 2. Generic inputs required for every template

These apply uniformly to all five templates. Without them, NO template can be authored.

| # | Input | What | Why | Owner |
| --- | --- | --- | --- | --- |
| G-1 | PM / PD ownership | Named person responsible for product correctness across the template's lifetime (not just authoring) | Field-set drift, customer-found gaps, and post-install changes all need a single named owner | PM |
| G-2 | Acceptance criteria | A short Markdown checklist that a SME signs after install — "if these 8 operations work cleanly, the template is good" | Otherwise "template works" becomes opinionated | PM + SME (joint) |
| G-3 | Out-of-scope statement | What the template **does NOT** claim to do (e.g., "this CRM template is not a sales-attribution system") | Prevents customer-facing scope creep | PM |
| G-4 | Sample record set | 3-5 deliberately anonymized records per template, in CSV or JSON, that operators can preview pre-install | Drives the preview / dry-run endpoint design and onboarding screenshot quality | SME |
| G-5 | Initial permission recommendation | Which subjects (anonymous / authenticated / admin / role X) should see / edit / admin | Drives the `MultitableTemplate.defaultPermissions` field shape | PM + SME |
| G-6 | Rollback strategy choice (T7) | Transactional / compensating writes / best-effort no-rollback. **One choice across all five templates**, or per-template if some warrant transactional and others don't | T7 is the C2 activation blocker; this is **the** decision that determines C2 PR scope (single sub-lane vs multi-week effort) | operator (informed by PM + engineering estimate) |
| G-7 | Template stability commitment | "Once shipped, the field id and field type are stable through `2026-12-31`; only labels / sample records may change" — or alternative | Customers who install today rely on field ids; renaming requires a migration | PM |

## 3. Per-template inputs

For each template, PM / SME must produce **all** of the following before engineering writes any code:

### Section A — schema

- **Field set**: list each field with `(id, type, label_zh, label_en, description, required, default, max_length_or_max_value, enum_options_if_select)`. Conservative count: 8-15 fields per template.
- **Field ordering** in default grid view.
- **System-managed fields** to suppress in user-visible UI (e.g., `createdAt`, `updatedBy`).

### Section B — views

- **Default view** (grid / kanban / gallery / form). One required per template.
- **Optional views** to ship in template (e.g., gantt for project management). For each: grouping field, filter clause, sort.
- **Public-form view** (if any): which fields are exposed to anonymous, what protected mode (`public` / `dingtalk` / `dingtalk_granted`).

### Section C — automations

- **Triggers** to pre-create (e.g., `record.created` notification, `field.changed` status update).
- **Actions** to pre-wire (e.g., `send_email`, `send_dingtalk_group_message`, `update_record`). For each action: the action config shape (recipient, subject template, body template).
- **Disabled-by-default vs enabled-by-default** for each automation. Most should be DISABLED by default — operators opt in after install.

### Section D — permissions

- **Subject roster**: which roles / groups / member-groups the template assumes exist on a host tenant. For tenants that lack these, the install dry-run must flag.
- **Per-resource matrix**: for sheet / view / field / record / export, which subjects can read / write / admin. Reuses the M4 permission codes (`SHEET_READ_*`, `SHEET_WRITE_*`, `SHEET_OWN_WRITE_*`, `SHEET_ADMIN_*`).

### Section E — lifecycle / KPI taxonomy (where applicable)

- **Status / stage enum**: ordered list (e.g., `lead → contacted → proposal_sent → won|lost`).
- **Allowed transitions**: which status moves are valid.
- **Aging / SLA flags**: thresholds beyond which a record is considered "stale" (drives gantt color, kanban warning chips).

### Section F — installation impact summary

- **Estimated provision time** per install (counts of sheet, view, field, automation, permission code entries).
- **Conflicts**: known names that may collide with existing tenant data; defines the conflict-resolution UI.
- **Cleanup contract**: what `uninstallMultitableTemplate(templateId)` should remove vs preserve (e.g., remove the template's automations but keep user-created records).

### Section G — onboarding checklist (C2 scope)

- **5-7 post-install steps** the operator should take (link X automation to a real recipient; review default permissions for X group; etc.).
- **Each step needs**: name, expected duration in minutes, screenshot or pointer to docs, "I'm done" checkbox semantics.

## 4. Per-template specifics — proposed starting points (subject to SME ratification)

The starting points below are Claude's read of common-sense schema based on each domain. **Every value below is a strawman**, NOT a recommendation. The SME must validate or replace each item.

### 4.1 Project management

- **SME profile needed**: someone who has run a real ≥10-person engineering project for ≥6 months.
- **Strawman fields**: `task_id`, `title`, `description`, `assignee`, `priority` (`P0`-`P3`), `status` (`backlog`/`in_progress`/`in_review`/`done`/`blocked`), `start_date`, `due_date`, `actual_finish_date`, `parent_task_id`, `estimate_hours`, `tags`.
- **Strawman views**: grid (default), kanban-by-status, gantt-by-due-date, hierarchy (parent_task_id).
- **Strawman automations**: `record.created` → DingTalk notify assignee; `status.changed to blocked` → DingTalk notify project owner.
- **Open questions for SME**: are sub-tasks via `parent_task_id` (self-link) or via a separate `task_subtask` sheet? Is `actual_finish_date` written by automation on `status → done`, or manually?

### 4.2 CRM follow-up

- **SME profile needed**: someone who has been an account manager or sales-ops lead.
- **Strawman fields**: `lead_id`, `company`, `contact_name`, `contact_email`, `contact_phone`, `stage` (`new`/`contacted`/`qualified`/`proposal`/`won`/`lost`), `owner`, `last_contact_date`, `next_action`, `next_action_date`, `expected_close_date`, `value_usd`, `lost_reason`.
- **Strawman views**: grid (default), kanban-by-stage, gallery (for showing company logos), form (lead intake).
- **Strawman automations**: `record.created` → assign owner via round-robin; `stage = qualified` → DingTalk notify sales manager; aging > 7 days without `next_action_date` → DingTalk warning.
- **Critical SME inputs needed**: round-robin owner-assignment rule; lost-reason taxonomy; whether `value_usd` should be CNY or multi-currency; whether to suppress PII in export.

### 4.3 Contract management

- **SME profile needed**: someone with contracts/legal-ops exposure who has handled ≥20 contracts.
- **Strawman fields**: `contract_id`, `contract_name`, `counterparty`, `contract_type` (`framework`/`SOW`/`PO`/`NDA`), `status` (`drafting`/`internal_review`/`legal_review`/`signed`/`active`/`expiring`/`expired`/`terminated`), `start_date`, `end_date`, `value`, `owner_user`, `legal_reviewer_user`, `attachment_ids`, `notes`.
- **Strawman views**: grid (default), kanban-by-status, calendar-by-end-date (for expiry watch), form (intake).
- **Strawman automations**: `30 days before end_date` → DingTalk notify owner; `status = signed` → automation to log to audit channel.
- **Critical SME inputs needed**: legal team subject-permission scope (read-only on signed contracts? full edit?); expiry alert lead times (30 / 60 / 90 days?); attachment retention policy.

### 4.4 Inspection feedback

- **SME profile needed**: someone who runs QA / field-inspection or audit processes.
- **Strawman fields**: `inspection_id`, `site`, `inspector`, `inspection_date`, `inspection_type`, `score` (numeric), `findings` (long_text), `severity` (`info`/`minor`/`major`/`critical`), `corrective_action`, `corrective_due_date`, `corrective_owner`, `status` (`open`/`in_remediation`/`verified`/`closed`).
- **Strawman views**: grid (default), kanban-by-severity, gallery (for inspection photos / attachments), form (mobile-friendly intake).
- **Strawman automations**: `severity = critical` → DingTalk notify ops lead; `corrective_due_date passed AND status != verified` → DingTalk escalation.
- **Critical SME inputs needed**: severity definitions; photo-attachment policy (max size, redaction needed?); inspector role/permission boundaries (can inspectors see other inspectors' findings?).

### 4.5 Recruiting pipeline

- **SME profile needed**: someone with TA / recruiter / hiring-manager hands-on experience.
- **Strawman fields**: `candidate_id`, `name`, `role_id`, `source`, `current_stage` (`applied`/`screening`/`phone_screen`/`onsite`/`offer`/`hired`/`rejected`/`withdrew`), `recruiter_user`, `hiring_manager_user`, `resume_attachment`, `notes`, `rejection_reason`.
- **Strawman views**: grid (default), kanban-by-stage, form (referral intake).
- **Strawman automations**: `current_stage = offer` → DingTalk notify HR; `aging > 14 days in any stage` → DingTalk warning to recruiter.
- **Critical SME inputs needed**: PII handling (candidate names + emails in template — when does redaction apply? Resume attachment retention?); rejection-reason taxonomy; equal-opportunity considerations (which fields to suppress in default views).

## 5. Sequencing

Lane C **re-entry** to active queue requires:

1. **G-1 through G-7** are all settled (generic inputs).
2. **At least 3 of the 5** templates have a written PM/SME commitment — i.e. a PM owner named (G-1), an SME named with availability, and a written Section A-G spec for each of those 3. Three is the floor that makes the template-library architecture investment worthwhile; fewer than 3 risks the library being a one-off.
3. **T7 rollback decision (G-6)** is recorded.

Once re-entry is granted, the **first C1 implementation PR may ship only 1 of the 3 committed templates** as long as the architecture (template registry, install/dry-run/preview surface, conflict handling) is demonstrated extensible to the other 2 committed templates without rewrite. Subsequent templates land in follow-up PRs. The "3-committed but 1-shipped first" pattern keeps the first PR scope tight while preventing the library from being designed against a single template.

To make "demonstrated extensible" testable, the C1 implementing PR must include either:

- A second template fixture (smaller / placeholder for one of the 3 committed) wired through the same preview / dry-run / install paths; **OR**
- A unit test that exercises the template registry abstraction with a synthetic second template and asserts the same preview / dry-run / install surface accepts it without code change.

Without either, C1 cannot ship even on a single template — the architecture extensibility claim must be code-proven, not asserted.

## 6. PM / SME availability — what to budget

Rough estimate, per template, **assuming PM and SME both engaged**:

| Phase | PM hours | SME hours | Calendar elapsed |
| --- | --- | --- | --- |
| Sections A-C (schema / views / automations) | 4-6 | 6-10 | 1-2 weeks |
| Sections D-E (permissions / lifecycle) | 2-4 | 2-4 | 0.5-1 week |
| Sections F-G (impact / onboarding) | 2-3 | 1-2 | 0.5 week |
| SME review of engineering-authored template fixture | 1-2 | 2-3 | 0.5 week |
| **Per template total** | **9-15** | **11-19** | **~3 weeks calendar** |

For **3 templates** to be ratified before C1 ships: **~27-45 PM hours + ~33-57 SME hours** spread across 6-8 weeks calendar.

If PM / SME cannot commit this, **Lane C should stay deferred** and the operator should explicitly carry that into the unlock checklist.

## 7. What this checklist did NOT do

- Did NOT propose any concrete field set as final (every per-template section is a strawman for SME validation).
- Did NOT modify the TODO Status line for C1 / C2 (still `pending PM / SME assignment`).
- Did NOT propose a PR or worktree.
- Did NOT touch real customer data, real CRM accounts, real candidate names, real contract counterparties.

## 8. Operator decision required

To unblock Lane C, the operator should record:

| Question | Answer routes to |
| --- | --- |
| Q-C1: Who is the PM owner for Lane C? | If named: G-1 is closed. If not: Lane C stays deferred. |
| Q-C2: Which template(s) have SME availability today? | List of templates. Lane C can start on those — others wait. |
| Q-C3: Which rollback strategy for T7? | Transactional / compensating writes / best-effort. Same answer for all templates (preferred) or per-template (more complex). |
| Q-C4: Are PM hours per §6 acceptable, or should the scope shrink? | If yes: proceed with selected templates. If no: drop templates until PM hour budget fits, OR keep Lane C deferred until PM bandwidth opens. |

Until Q-C1 and at least one of Q-C2 answer in the affirmative, Lane C cannot start. T7 (Q-C3) is required regardless of whether one or all templates ship.

## 9. References

- `docs/development/multitable-feishu-phase3-ai-hardening-plan-20260514.md` (Lane C spec)
- `docs/development/multitable-feishu-phase3-ai-hardening-todo-20260514.md` (Lane C1 line 393, C2 line 454 — Status: `pending PM / SME assignment`)
- `docs/development/multitable-feishu-phase3-ai-hardening-review-20260514.md` (Lane C risk + T7 blocker)
- `docs/development/multitable-phase3-unlock-checklist-20260515.md` (companion landed via PR #1568)
- `packages/core-backend/src/multitable/template-library.ts` (existing V1 surface this Lane extends)
- `packages/core-backend/src/multitable/permission-service.ts` (M4 permission code families used in Section D)
