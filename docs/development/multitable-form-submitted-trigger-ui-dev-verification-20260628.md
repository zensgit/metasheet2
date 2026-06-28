# `form.submitted` automation trigger — editor "light-up" — dev & verification (2026-06-28)

> Status: built + verified. Grounding: `origin/main` @ `c5eb20d99`. Candidate-B "light up a BACKEND-ONLY
> trigger" slice, owner-authorized as the next fork after date-reminder. Small by design — no design-lock; the
> intent lives here + in the PR.

## 1. The gap (design intent)

`form.submitted` was a fully-wired backend trigger (in `ALL_TRIGGER_TYPES` / `VALID_TRIGGER_TYPES`, mapped
`multitable.form.submitted → form.submitted`, real-event-chain proven by `multitable-form-submit-trigger.test.ts`)
**but it had no entry in the automation rule editor's trigger dropdown** — a "built but not exposed" item from
the benchmark audit. So "automate on public form submit" (→ notify / update_record / start_approval) was
reachable only via direct API, not the UI. This lights it up.

## 2. What changed (minimal)

`form.submitted` is **config-less** — it fires for any form submission on the sheet (no per-form binding;
`matchesTrigger` falls through to the default `type === eventType`), so the only gap was exposure:
- `MetaAutomationRuleEditor.vue`: one `<option value="form.submitted">` in the trigger select (grouped with the
  record/form event triggers). No config sub-form (it has none). The frontend `AutomationTriggerType` union and
  the `automationTriggerTypeLabel` case ("当表单提交时" / "When form submitted") already existed.
- Submit/round-trip needs nothing new — `buildPayload` only special-cases cron/date_field config; for
  `form.submitted` the trigger persists as `{ type: 'form.submitted', config: {} }` and reloads as-is.

No backend change: the capability already exists and is enforced server-side (`VALID_TRIGGER_TYPES`).

## 3. Verification

- **Editor + labels specs — 108/108** (`apps/web`): trigger-option count 8→9 (updated in place); new
  `form.submitted` is config-less (no `dateFieldId`/`cronPreset`/`intervalMinutes` sub-form renders) and **saves**
  (onSave payload `triggerType === 'form.submitted'`); an existing `form.submitted` rule **backfills** into the
  selector (round-trip). `vue-tsc -b` exit 0.
- **Backend capability re-check — 3/3** (`multitable-form-submit-trigger.test.ts`, real DB): a real form submit
  emits `multitable.form.submitted` → `AutomationService` → `matchesTrigger('form.submitted')` → durable
  execution row; a plain `POST /records` (record.created, not form.submitted) produces no execution. The
  capability the UI now exposes works end-to-end.

## 4. Out of scope (named)

- **`start_approval` action UI** — the natural next pairing ("form submit → start approval"); higher value but
  touches approval templates / field mapping. Separate slice, after this.
- **`delete_record` action UI** — destructive; needs permission + confirm-copy + execution-log + anti-misdelete
  before it's a "cheap" light-up. Deferred.
- DARK rollout / API write-back / realtime co-edit / template / mobile — independent arcs, not light-ups.
