# Multitable Button / Action Field Scope Gate (B1) - 2026-06-15

Status: docs-only scope gate; runtime, migration, and frontend not started.

Scope: add a new `'button'` multitable field type whose cell renders a clickable
control that, on click, runs **exactly one** pre-configured action on the
button's own row record by **reusing the existing automation single-action
execution engine** — without authoring, persisting, or triggering a full
automation rule.

Grounded on: `origin/main@92fc9726d`.

Companions:

- `multitable-automation-a6-execution-plan-20260601.md`
- `multitable-automation-run-governance-todo-20260527.md`
- `multitable-automation-a6-3-3-branch-local-wait-scope-gate-20260615.md`

## 0. Verdict

### What B1 IS

B1 is a new **value-less field type** (`'button'`). Its field definition stores
*configuration only* — a display label plus **one** bound action chosen from the
already-shipped action set. No per-record data value is ever stored, read, or
written for a button field; the cell is an *affordance*, not a datum.

Clicking the button runs that one bound action against the clicked record by
reusing the existing single-action execution engine (`AutomationExecutor`),
through the existing C1 job/log observability plane, behind the same
permission, record-lock, cross-base, and redaction gates that govern every
other action execution today. The clicker — not a rule owner — is the actor.

The demand signal is a concrete, product-plausible operator flow:

- a row has a `status` field and a `Mark reviewed` button;
- the button is configured with one `update_record(status = 'reviewed')` action;
- a permitted user clicks it; the record's `status` becomes `reviewed`, the run
  is observable as a single C1 job, and a locked or unauthorised record is
  rejected fail-closed.

### What B1 IS NOT

B1 is **not** the automation rule engine wearing a button. It explicitly does
**not** author, persist, trigger, schedule, or chain a rule. There is no
trigger, no condition evaluation, no multi-step sequence, no recurrence. It runs
one action, once, on one record, on an explicit human click.

This document is not an authorization for new action types, multi-action
chains, conditions, triggers, scheduling, a new RBAC tier, any bypass of record
locks / permission gates / automation redaction, cross-base writes beyond the
existing cross-base governance, or any public / unauthenticated trigger
endpoint. Each of those is its own separately-gated opt-in.

## 1. Current Code Grounding

### 1.1 Field-type registry models config-only fields already

- `packages/core-backend/src/multitable/field-type-registry.ts:1` —
  `FieldTypeDefinition` is `{ name, validate(value, fieldId), sanitizeProperty(property), serialize?, deserialize? }`.
  `validate` normalizes a per-record *value*; `sanitizeProperty` normalizes the
  *field definition's* config JSON. Registration is `fieldTypeRegistry.register(name, def)`
  (`field-type-registry.ts:12`).
- `packages/core-backend/src/multitable/field-codecs.ts:6` — `MultitableFieldType`
  is a string union (`'string' | 'number' | ... | 'autoNumber' | 'createdTime' | ...`),
  camelCase, no hyphens. A `'button'` member slots in alongside `'autoNumber'`.
- `packages/core-backend/src/multitable/field-codecs.ts:35` — `MultitableField`
  carries `property?: Record<string, unknown>` — the per-field config JSON column
  (`meta_fields.property`) where select options, link targets, autoNumber prefix,
  etc. live. Button config (label + bound action) lives here.

**Config-only precedent (the cleanest pattern to copy).** `autoNumber` stores no
per-record value, only configuration:

- `packages/core-backend/src/multitable/auto-number-property.ts:1` —
  `NormalizedAutoNumberProperty` is a pure config shape with `readOnly: true`.
- `packages/core-backend/src/multitable/field-codecs.ts:416` — `sanitizeProperty`
  normalizes the autoNumber config; `field-codecs.ts:420` injects `readOnly: true`
  for `SYSTEM_FIELD_TYPES` (`field-codecs.ts:908`).
- `packages/core-backend/src/multitable/permission-derivation.ts:57` —
  `isFieldAlwaysReadOnly()` treats `formula`/`lookup`/`rollup` and the system
  fields as always read-only, so any attempt to *write a value* to such a field
  is rejected by the record write services.

A `'button'` codec therefore: in `sanitizeProperty`, validate + normalize the
button config (label string + one bound action of the existing action set) and
force `readOnly: true`; in `validate`, reject any non-empty per-record value
(the field stores no datum). This mirrors `autoNumber` exactly.

### 1.2 The action set and the single-action engine

- `packages/core-backend/src/multitable/automation-actions.ts:6` — the action
  union `AutomationActionType`: `update_record`, `create_record`, `delete_record`,
  `send_webhook`, `send_notification`, `send_email`,
  `send_dingtalk_group_message`, `send_dingtalk_person_message`, `lock_record`,
  `wait_for_callback`, `start_approval`, `parallel_branch`, plus `condition_branch`
  (used inside `parallel_branch`). Discriminator field is `type`;
  `AutomationAction = { type, config }` (`automation-actions.ts:191`).
- `packages/core-backend/src/multitable/automation-executor.ts:1338` —
  `private async executeSingleAction(action: AutomationAction, context: ExecutionContext): Promise<AutomationStepResult>`.
- `packages/core-backend/src/multitable/automation-executor.ts:667` —
  `ExecutionContext = { executionId, ruleId, sheetId, recordId, recordData, ruleCreatedBy, actorId?, triggerEvent }`.
- `packages/core-backend/src/multitable/automation-executor.ts:767` — the public
  `execute(rule, triggerEvent, jobLifecycleFactory?)` builds the `ExecutionContext`
  from the trigger event (`executor.ts:798`), optionally evaluates conditions,
  persists a parent execution, and loops the rule's actions through
  `executeSingleAction`. `executeSingleAction` is private; the supported entry is
  `execute`.

### 1.3 The seam that already runs one action without a real trigger

- `packages/core-backend/src/multitable/automation-service.ts:1024` —
  `executeRule(rule, triggerEvent, retryMeta?)`. It selects the C1 path from
  `rule.executionMode === 'workflow_job_v1'` (`automation-service.ts:1029`),
  builds the job lifecycle factory (`automation-service.ts:1033`), calls
  `this.executor.execute(rule, triggerEvent, jobLifecycleFactory)`
  (`automation-service.ts:1036`), then persists the execution log
  (`automation-service.ts:1042`). **One call gives both the per-action C1 job rows
  and the execution-log row.**
- `packages/core-backend/src/multitable/automation-service.ts:1446` — `testRun()`
  is the existing **run-without-a-real-trigger** precedent: it builds a
  `syntheticEvent` (`recordId: 'test_record'`, `data: {}`, `actorId: 'system'`,
  `_triggeredBy: 'manual_test'`) and calls `executeRule(execRule, syntheticEvent)`.
  A button run is the *same shape* but with the **real clicked record** and the
  **live clicker's** id, not `'test_record'`/`'system'`.
- `packages/core-backend/src/multitable/automation-service.ts:1054` —
  `buildJobLifecycle()` wires `onExecutionStarted → logService.record()` and
  `jobService.lifecycleFor()` (the C1 job plane). Full observability requires both
  the job lifecycle **and** the execution-log write — `executeRule` already does
  both. This is why the seam is `executeRule`, not the private `executeSingleAction`.

### 1.4 The C1 job/log plane

- `packages/core-backend/src/multitable/automation-job-service.ts:35` —
  `lifecycleFor(executionId, rule)` returns `{ onStart, onSettled, onSkipped }`
  that insert/update one `multitable_automation_jobs` row per action.
  Deterministic id `${executionId}:job:${stepIndex}` (`automation-job-service.ts:38`);
  statuses are the C1 vocabulary `running`/`resolved`/`failed`/`skipped`/`suspended`;
  result/error are redacted via the **shared** A1 redactor
  (`redactValue`/`redactString`, imported `automation-job-service.ts:23`); the
  hooks are **fail-closed** (throw on DB failure). No second job/status/audit store.

### 1.5 Permission, record-lock, cross-base, and redaction gates

- `packages/core-backend/src/multitable/record-lock.ts:93` —
  `ensureRecordNotLocked(actorId, row, makeError)`: throws unless the record is
  unlocked or the actor is the locker / creator; **no silent admin bypass**
  (`record-lock.ts:45`).
- `packages/core-backend/src/multitable/automation-executor.ts:1801` and `:1900`
  — `executeUpdateRecord` / `executeDeleteRecord` call `ensureRecordNotLocked`
  **inside** the action, before the mutation. `executeCreateRecord` has no lock
  check (new id). So a button bound to `update_record`/`delete_record`
  *automatically* inherits the record-lock gate via the reused executor.
- `packages/core-backend/src/multitable/automation-executor.ts:1559` —
  `evaluateCrossBaseWrite`: same-base writes short-circuit (no gate, zero
  regression, `executor.ts:1574`); cross-base writes require an explicit
  `targetBaseId` claim **and** the actor's `base:write` authority via
  `resolveBaseWritable` (`permission-service.ts:1301`). A null actor fails closed.
  Button runs supply the live clicker as `actorId`, so cross-base writes are
  gated exactly as automation cross-base writes are today.
- `packages/core-backend/src/multitable/sheet-capabilities.ts:71` /
  `:270` — `deriveCapabilities(permissions, isAdminRole)` yields `canEditRecord`;
  `ensureRecordWriteAllowed(...)` enforces it (plus own-write policy). This is the
  record-write capability gate the **run endpoint** must apply at the route layer.
- `packages/core-backend/src/multitable/automation-log-redact.ts` (`redactValue`
  `:162`, `redactString` `:151`) — the single redaction source applied at job/log
  persist time. A button run inherits it because it persists through the same
  `executeRule` → job/log plane.

### 1.6 Frontend grid cell rendering

- `apps/web/src/multitable/components/cells/MetaCellRenderer.vue:2` — cell render
  is a `v-if="field.type === '...'"` dispatch on `field.type` with a catch-all
  fallback (`:166`). The component receives the full `field: MetaField` plus
  `value` (`:183`); `MetaField` carries `property?: Record<string, unknown>`
  (`apps/web/src/multitable/types.ts:57`). The button label is read from
  `field.property` via a resolver, exactly as `rating` reads its `max`
  (`apps/web/src/multitable/utils/field-config.ts:183`).
- `apps/web/src/multitable/components/MetaGridTable.vue:359` — `EDITABLE` set
  lists the value-bearing types; `isEditable()` (`MetaGridTable.vue:584`) excludes
  anything not in it (formula/lookup/rollup/system fields). A `'button'` type left
  out of `EDITABLE` renders read-only and **never opens the cell editor** on
  double-click — the rendering precedent for a value-less interactive cell.

## 2. In Scope

Runtime is split into **three separate named slices**, each its own explicit
opt-in. This document authorizes none of them to start; it fixes their boundary.

### B1-a — `'button'` field type + codec (backend contract)

1. Add `'button'` to `MultitableFieldType` (`field-codecs.ts:6`).
2. Register a `'button'` `FieldTypeDefinition`:
   - `sanitizeProperty` validates + normalizes the button config: a `label`
     (non-empty string) and **exactly one** bound action `{ type, config }` whose
     `type` is a member of the existing `AutomationActionType` set; force
     `readOnly: true`. Reject unknown action types and reject any shape carrying
     more than one action.
   - `validate` rejects any non-empty per-record value (the field stores no datum;
     return `null`).
3. The button is treated as always-read-only for record writes (no per-record
   value), mirroring `autoNumber` (`permission-derivation.ts:57` / the injected
   `readOnly: true`).

### B1-b — row-scoped manual-run endpoint (backend runtime)

1. An **authenticated**, record-scoped endpoint:
   `POST /sheets/:sheetId/records/:recordId/button/:fieldId/run`.
2. The endpoint resolves the button field, reads its bound action from
   `field.property`, re-fetches the live record, and applies the **record-write
   capability gate** at the route layer (`deriveCapabilities`/`ensureRecordWriteAllowed`,
   `sheet-capabilities.ts:71`/`:270`) — the clicker must hold the same write
   permission a normal record write requires (no ready-made `requireRecordWritable`
   middleware exists; the endpoint performs this check explicitly — the only
   route-layer accommodation B1 introduces).
3. It executes the single bound action by **reusing `AutomationService.executeRule`**
   (`automation-service.ts:1024`) with a **synthetic, non-persisted, trigger-less,
   condition-less, single-action execution envelope** (see §4). It does **not**
   create or persist an automation rule.
4. Run is observable through the **existing C1 job/log plane** — one job row + one
   execution-log row — with the existing redaction.
5. Lock, cross-base, and per-action permission gates are inherited **unchanged**
   from the reused write-action executors (`executor.ts:1801`/`:1559`).
6. An idempotency / double-click guard lives at the endpoint + frontend (the
   executor mints a fresh `executionId` per call and will not dedupe — see §4.3).

### B1-c — frontend button cell (frontend)

1. `MetaCellRenderer.vue` (`:2`) renders a `'button'` cell as a clickable control
   labelled from `field.property.label`, read-only to the editor system (`'button'`
   stays out of `EDITABLE`, `MetaGridTable.vue:359`).
2. Click calls B1-b's run endpoint for that row's record; the cell reflects
   in-flight / disabled / result-toast states. No value is written to the cell.
3. The cell is disabled when the row is locked or the user lacks write capability,
   mirroring the existing `isEditable()` gate (`MetaGridTable.vue:584`).

## 3. Out Of Scope

B1 must not add, and explicitly forbids:

- **new action types** — only the already-shipped `AutomationActionType` members;
- **multi-action chains, conditions, or triggers** — that is the automation rule
  engine, not a button; a button binds exactly one action and has no trigger;
- **scheduling / recurring / delayed runs** — a button runs only on explicit click;
- **`wait_for_callback`, `start_approval`, `condition_branch`, `parallel_branch`
  as the bound action in v1** — long-running / suspending / branching actions are
  out of the first cut (a button is a synchronous one-shot); re-entry may open a
  curated subset under its own scope gate;
- **any new RBAC tier or permission code** — the button reuses `canEditRecord` and
  the per-action authority each action already requires;
- **any bypass of record locks, permission gates, or automation redaction /
  governance** — the button inherits them by construction;
- **cross-base writes beyond the existing cross-base governance**
  (`evaluateCrossBaseWrite` / `resolveBaseWritable`);
- **a public / unauthenticated trigger endpoint** — the run endpoint is
  authenticated and record-scoped;
- **a second job/status/audit store** — runs use the existing C1 plane;
- **storing a per-record value on the button field** — it carries no datum;
- **persisting a synthetic rule** as an `automation_rules` row, or surfacing it in
  the rules list / editor — the execution envelope is in-memory only.

Each expansion above is a separately-gated opt-in. The three runtime slices
(B1-a → B1-b → B1-c) are themselves separate opt-ins; landing this scope gate
authorizes none of them to start.

## 4. Runtime Model

### 4.1 Click → run

```text
button cell click (B1-c)
  → POST /sheets/:sheetId/records/:recordId/button/:fieldId/run  (B1-b, authenticated)
  → load button field; read its ONE bound action from field.property
  → record-write capability gate at route (deriveCapabilities / ensureRecordWriteAllowed)
  → re-fetch the live record (recordData, recordId, sheetId)
  → AutomationService.executeRule(syntheticEnvelope, syntheticEvent)   (reuse)
      → AutomationExecutor.execute(...) builds ExecutionContext, runs the one action
        via executeSingleAction; write actions re-check lock + cross-base internally
      → C1 job lifecycle: one job row (running → resolved/failed) + execution-log row
  → respond with the single AutomationStepResult shape
```

### 4.2 The synthetic execution envelope (key design decision)

The lightest **correct** way to run one action is to call the existing public
`AutomationService.executeRule` with a **synthetic, non-persisted ExecutorRule**
carrying a single action — **not** to reach into the private
`executeSingleAction`.

```ts
// In-memory only. NEVER persisted to automation_rules; never listed/edited as a rule.
const envelope: ExecutorRule = {
  id: `btn_${randomUUID()}`,        // provenance id (see §4.4); not a stored rule id
  sheetId,
  createdBy: clickerId,             // owner = the live clicker (so ruleCreatedBy aligns)
  actions: [boundAction],           // exactly ONE action from field.property
  conditions: undefined,            // trigger-less, condition-less
  executionMode: 'workflow_job_v1', // opt into the C1 job/log plane
}
const syntheticEvent = {
  sheetId,
  recordId,                         // the REAL clicked record (cf. testRun's 'test_record')
  data: liveRecordData,
  actorId: clickerId,               // the LIVE clicker (cf. testRun's 'system')
  _triggeredBy: 'button',
}
const execution = await automationService.executeRule(envelope, syntheticEvent)
```

**Why this path and not the alternatives:**

- **Reuses observability for free.** `executeRule` already wires the C1 job
  lifecycle *and* the execution-log write (`automation-service.ts:1033`/`:1042`).
  The task requires the run be observable via the existing C1 plane; calling the
  private `executeSingleAction` would force re-implementing that wiring.
- **Reuses every governance gate.** Lock (`executor.ts:1801`), cross-base
  (`executor.ts:1559`), per-action permission, and redaction
  (`automation-log-redact.ts`) all live inside the reused executor / persist path.
  A button bound to `update_record` inherits them with zero new code.
- **It is the established `testRun` shape.** `testRun` (`automation-service.ts:1446`)
  already runs one rule with a synthetic event through `executeRule`. The button
  path differs only by using the real record + the live clicker — the engine is
  proven to run from a synthetic trigger.
- **Rejected: private `executeSingleAction`.** It is `private`, returns a bare
  `AutomationStepResult` with no execution/job rows, and pulls `ruleCreatedBy`
  from a rule (`executor.ts:804`). Using it directly would bypass the C1 plane
  and require a bespoke shim re-deriving the context the public path already builds.

This keeps the in-scope/out-of-scope boundary coherent: the envelope is **not a
persisted automation rule** — it has no trigger, no conditions, no chaining, no
rules-list presence. It is a one-shot execution envelope that reuses the executor
engine, which is precisely "run one action without authoring a full rule."

### 4.3 The "value": none

A button field carries no stored data value. `validate` rejects non-empty
per-record writes; the cell never opens an editor; broadcasts carry no value. The
run produces an `AutomationStepResult` (transient response + a persisted C1 job
row), not a cell value.

### 4.4 Idempotency / double-click

`executeRule` → `executor.execute` mints a fresh `executionId` per call
(`executor.ts:772`); it does **not** dedupe. Two clicks = two runs (benign for
`update_record`; a duplicate row for `create_record`). The guard therefore lives
at the endpoint + frontend: the cell disables while a run is in flight, and the
endpoint may short-window-debounce per `(recordId, fieldId, actorId)`. No
executor change.

### 4.5 Provenance discriminator (prereq nuance, see §8)

`multitable_automation_jobs.rule_id` and `multitable_automation_executions.rule_id`
are `TEXT NOT NULL` **with no foreign key** to `automation_rules`
(`zzzz20260530120000_create_automation_jobs_and_execution_mode.ts:24`,
`zzzz20260414100001_create_automation_executions_and_dashboard_charts.ts:22`).
A synthetic, non-persisted `rule_id` therefore satisfies the column and writes
cleanly — there is **no FK to violate**.

The **read** path is equally clean (verified, not assumed). The cross-rule runs
list `listExecutions({ sheetId?, ruleId?, status?, limit? })`
(`automation-log-service.ts:111`, exposed at `routes/automation.ts:267`) filters
by `sheet_id` and treats `ruleId` as an **optional** filter with **no join** to
`automation_rules`; per-run detail reads jobs by `execution_id` only
(`listByExecution`, `automation-job-service.ts:228`/`:241`) and the execution by
id (`getById`, `automation-log-service.ts:126`). So a button run — `btn_`-prefixed
`rule_id`, real `sheet_id` — **appears in the existing sheet-scoped runs list and
hydrates detail without a parent `automation_rules` row**. The runs list is
sheet-level, not rule-scoped-only.

To keep these runs distinguishable from real-rule runs in that view, the envelope
id uses a `btn_` prefix (and B1-b may stamp a `source: 'button'` marker on the
execution). No schema change is required to *store* or *list* button runs; the
read-side distinction is a labelling concern for B1-b, not a backbone gap.

## 5. Failure / Permission Semantics

| Case | Expected result |
|---|---|
| unauthenticated caller | `401 UNAUTHENTICATED`; no run |
| caller lacks record-write capability | `403 FORBIDDEN`; no run, no job row |
| record locked (and caller not locker/creator) | `423 LOCKED` (or the existing record-lock error shape); fail-closed inside `executeUpdateRecord`/`executeDeleteRecord`; execution recorded as `failed` |
| target record gone | `404 RECORD_GONE`; no mutation |
| button field misconfigured (no/invalid bound action) | rejected at field save by `sanitizeProperty`; at run time → `409 BUTTON_MISCONFIGURED` |
| bound action is a disallowed type for v1 (wait/approval/branch) | rejected at field save by `sanitizeProperty`; never persisted |
| cross-base write without authority | `403`-style fail-closed via `evaluateCrossBaseWrite`/`resolveBaseWritable` (null/insufficient actor) |
| action runs but fails (e.g. webhook 500) | run returns `200` with `AutomationStepResult.status = 'failed'` + redacted error; C1 job `failed`; no auto-retry |
| double click | second run is a *separate* execution (executor does not dedupe); FE disables in-flight + endpoint debounces (§4.4) |
| attempt to write a value to the button field | rejected by the `'button'` codec `validate` (no datum) |

## 6. Acceptance Scenario (real-DB-testable)

Use a real-DB integration scenario, not only a fixture (the wire must carry the
config and the run must persist a C1 job — hand-built fixtures hide both):

1. Create a sheet with a `status` (string) field.
2. Create a `'button'` field `mark_reviewed` with
   `property = { label: 'Mark reviewed', action: { type: 'update_record', config: { fields: { status: 'reviewed' } } } }`.
   Assert `sanitizeProperty` normalized it and injected `readOnly: true`.
3. Create a record with `status = 'new'`.
4. As a user **with** record-write capability, `POST` the run endpoint for that
   record's button:
   - response is `200` with one `AutomationStepResult` (`status: 'success'`);
   - the record's `status` is now `reviewed`;
   - exactly **one** `multitable_automation_jobs` row exists for that execution
     (`action_type = 'update_record'`, `status = 'resolved'`), plus one
     `multitable_automation_executions` row; `rule_id` is the `btn_`-prefixed
     synthetic id and resolves to **no** `automation_rules` row.
5. As a user **without** record-write capability, `POST` the same endpoint →
   `403`; record unchanged; no new job row.
6. Lock the record (as another actor), then `POST` as a non-locker with write
   capability → fail-closed lock error; record unchanged.
7. Attempt to `PATCH` a value into the `mark_reviewed` cell → rejected by the
   button codec; the field stores no datum.
8. Click twice rapidly → two distinct executions recorded (confirming the
   executor does not dedupe and the guard must live at the edge).

## 7. Required Tests

### B1-a — field type + codec (backend)

- `sanitizeProperty` accepts a valid `{ label, action }` and injects `readOnly: true`;
- `sanitizeProperty` rejects: empty/non-string label; missing action; unknown
  action `type`; more than one action; a disallowed v1 action type
  (`wait_for_callback`/`start_approval`/`condition_branch`/`parallel_branch`);
- `validate` rejects any non-empty per-record value and returns `null`;
- a button field is reported always-read-only for record writes (no value path).

### B1-b — run endpoint (backend, real-DB)

- happy path: `update_record` button run mutates the record and persists exactly
  one C1 job + one execution-log row through `executeRule`;
- **wire round-trip**: the bound action read from `field.property` is the one
  actually executed (assert against the persisted job `action_type`/result, not a
  hand-built fixture — wire-vs-fixture drift guard);
- unauthenticated → `401`; lacks write capability → `403` with no job row;
- locked record (non-locker) → fail-closed; execution recorded `failed`/rejected;
- record-gone → `404`;
- misconfigured / disallowed-action button → `409`/save-time rejection;
- cross-base write without authority fails closed via the reused gate;
- failing action → `200` with `status: 'failed'` + **redacted** error in the job
  row (assert the shared redactor scrubbed a secret-shaped value);
- the synthetic `rule_id` is non-null, `btn_`-prefixed, and resolves to no
  persisted rule; the run is **not** present in the rules list;
- two rapid runs produce two distinct executions (no executor-level dedupe).

### B1-c — button cell (frontend)

- a `'button'` cell renders the configured label and a clickable control;
- the cell is **not** in `EDITABLE`; double-click does not open the cell editor;
- click invokes the run endpoint for the row's record;
- in-flight disables the control; success/failed states are surfaced (toast),
  with no value written to the cell;
- the control is disabled when the row is locked or the user lacks write
  capability (mirrors `isEditable()`).

## 8. Re-Entry

Runtime implementation requires separate explicit build PRs after this scope
gate lands, in order, each its own opt-in:

1. **B1-a** — `'button'` field type + codec (backend contract + unit tests). No
   migration (config lives in the existing `meta_fields.property` JSON; no new
   column, since the `rule_id` columns are already nullable-of-FK / NOT NULL-only).
2. **B1-b** — the row-scoped run endpoint reusing `executeRule`, with real-DB
   tests. This is where the route-layer record-write capability check and the
   `btn_`/`source: 'button'` provenance labelling land.
3. **B1-c** — the frontend button cell + cell-interaction tests.

**Prereq note (no backbone gap).** The action backbone supports a single-record
manual run cleanly on **both** the write and read sides: `executeRule` + a
synthetic `workflow_job_v1` envelope reuses the executor, the C1 plane, and every
lock/cross-base/redaction gate; the `rule_id` columns are `TEXT NOT NULL` with
**no foreign key**, so a non-persisted synthetic id stores without violation; and
the C1 read path (sheet-scoped `listExecutions`, `execution_id`-keyed
`listByExecution`/`getById`) surfaces and hydrates button runs **without** a
parent `automation_rules` row (§4.5). The only accommodations B1 introduces are at
the **edges**, not the engine: (a) the run endpoint performs the record-write
capability check explicitly because no `requireRecordWritable` middleware exists
today (the read counterpart `requireRecordReadable` does — `univer-meta.ts:3045`);
(b) `canEditRecord` is gated uniformly at the route — exact for write actions, a
deliberate strict over-approximation for `send_*` actions (the executor does no
internal same-base write-permission check, so the route must gate it); and (c) the
runs view should label `btn_`-prefixed runs to distinguish button runs from
real-rule runs. None of these requires changing `AutomationExecutor` or the
job/log services.

This scope gate does not authorize new action types, multi-action / conditional /
triggered / scheduled runs, suspending or branching bound actions, a new RBAC
tier, any gate bypass, cross-base writes beyond existing governance, a public
trigger endpoint, or persisting the synthetic envelope as a rule.
