# W6 operator-smoke — `form.submitted → start_approval` acceptance record (2026-06-29)

> **Scope of the PASS below: the IN-PROCESS automatable seam only.** This record delivers
> a CI-wired harness + a runbook + an in-process ✅ PASS + a fillable deployed-record
> template. It does **not** constitute a deployed/staging operator run — that leg
> (`/api` co-tenancy on the live host, a real operator browser session, cross-process
> resume) remains **owner-gated** (§5). Read "✅ PASS" as scoped to §4, not as "the
> deployed smoke is done."

This is the operator-entry counterpart to
`w6-operator-smoke-acceptance-record-20260622.md`. That record proved the
`record.created → start_approval → approve → resume` seam (#2974). **The gap this closes:**
the operator's actual entry point is a **form submit** (#3336 `form.submitted` trigger +
#3339 `start_approval` action, editor-exposed) — and no single test chained
`form submit → a real approval instance → the approver's todo` end-to-end. This record
captures that chain's acceptance state so the gate is explicit.

## 1. Implementation state (on `main`)
- **`form.submitted` trigger** (#3336) and **`start_approval` action** (#3339, editor-exposed)
  are on `main`; `start_approval` opens the suspend/resume approval bridge
  (`multitable_automation_approval_bridges`), completion driven by the approval terminal
  event (the same bridge runtime the 06-22 record accepts).
- **New in-process seam test** —
  `tests/integration/multitable-form-submit-start-approval-smoke.test.ts`, wired into the
  `Run multitable real-DB integration` Postgres lane in `plugin-tests.yml` (runs every PR
  with `DATABASE_URL` set), so it is automated debt-free, not a one-off.

## 2. Acceptance criteria
An operator-equivalent flow proves: **submit a form → the `form.submitted` rule fires →
`start_approval` creates a real approval instance → the approver has a pending todo**, over
the real HTTP submit boundary against real Postgres.

## 3. Real event chain exercised
```
POST /api/multitable/views/:id/submit            (real HTTP boundary)
  → eventBus 'multitable.form.submitted'
    → AutomationService subscription → matchesTrigger('form.submitted')
      → executeRule(start_approval)  [executionMode workflow_job_v1 → suspended job]
        → multitable_automation_approval_bridges row (status='pending', approval_instance_id)
          → approval_instances row (non-terminal)
            → approval_assignments row for the approver (is_active=true)  ← the "待办出现"
```

## 4. Evidence — IN-PROCESS seam: ✅ PASS

`multitable-form-submit-start-approval-smoke.test.ts` — **2/2 green** (real DB, `TS=…`):
- the submit returns `200`;
- a `start_approval` execution + a **pending** bridge with a non-null `approval_instance_id`
  appear from the `form.submitted` rule;
- the `approval_instances` row exists and is **non-terminal**;
- the approver has an **active** `approval_assignments` row (the todo).

Representative captured run (local `metasheet_test`; the test cleans up after itself, so
these IDs are an illustrative sample, not a persisted fixture — re-run with `SMOKE_KEEP=1`
to retain rows for inspection):

| Field | Value |
|---|---|
| **env** | in-process Express mounting `univerMetaRouter()` → real Postgres (`metasheet_test`; CI: `:5432`, local: `:5435`). **Not** the deployed host. |
| **rule** | `atr_84409637-2f8b-4e90-8282-5e3886d8dd5a` — trigger `form.submitted`, action `start_approval`, `execution_mode=workflow_job_v1` |
| **template** | `5099703b-75c1-46c2-b35e-004d9e24e12f` (published; `formSchema.summary` required; graph `start → approval_1{mode:any, static_user:approver} → end`) |
| **trigger input** | `POST /api/multitable/views/:id/submit` body `{ data: { <number field>: 5 } }` |
| **automation run (execution)** | `axe_9e9c58fb-5b13-4084-bea8-8d896ab7806b` status `running` (job **suspended**, awaiting the approval terminal event — resume is the 06-22 record's scope) |
| **bridge** | `aab_7759d9ba-f9ed-47d7-9807-598ea10f494a` status `pending` |
| **approval instance** | `14291efe-57ae-49e8-a7c8-d842247f70a0` status `pending` |
| **approver todo (active assignment)** | `49badfdc-dcc8-4396-b172-99974cc4f284` (`is_active=true`) |

This proves the trigger → action → bridge → instance → assignment wiring is correct
**in process**. The resume tail (approver approves → suspended job resumes exactly once,
incl. the unauth-approve negative boundary) is already covered by #2974 and accepted in the
06-22 record; this record deliberately stops at "the approver has a todo".

## 5. Deployed operator smoke: ⬜ owner sign-off (gated)
What §4 does **not** cover: the **deployed** path — `/api` co-tenancy with the SPA, a real
operator's browser session, and cross-process behaviour on the deployed host. That is the
`automation-start-approval-operator-smoke-runbook-20260613.md` operator runbook (`#2480`
family), and it requires a human operator on the live environment (staging `:8082` has a
distinct `JWT_SECRET` and its deploy lane does not auto-mirror `main` — preflight the bundle
fingerprint + auth round-trip first). To be filled by the operator:

| Field | Value (operator fills) |
|---|---|
| env / host | ______ |
| rule id | ______ |
| template id | ______ |
| trigger input (form view + payload) | ______ |
| approval instance id | ______ |
| automation run (execution) id | ______ |
| approver todo visible? | ______ |
| result | ⬜ PASS / ⬜ FAIL |

## 6. Acceptance decision (owner)
The in-process seam (§4) is green + durable + re-run every PR. The open question is whether
to **accept on that evidence** or **require the deployed smoke (§5)** first:

- [ ] **Accept on the in-process seam** — the `form.submitted → start_approval → todo` chain
  is sign-off-ready; the deployed `#2480` smoke is recommended-but-not-blocking, tracked
  separately.
- [ ] **Require the deployed operator smoke (§5)** — run the runbook on the deployed host and
  fill its PASS before sign-off.

**Owner sign-off:** ______________  **Date:** ____________  **Decision:** ____________

## 7. W7 state after this record
This record no longer gates the already-shipped W7 approved-path result writeback. Since the
original W6/W7 planning text, main has shipped the approved-path `resultWriteback` runtime and
editor UI (`statusField` / `approverField` / `completedAtField`) as separate, verified slices.

What this record still does: it closes the missing **form-submit entry** proof for W6's in-process
operator seam, and leaves the deployed/staging smoke as an owner sign-off decision (§5/§6).

What it does **not** authorize or close: W7 rejection backwrite, cross-base backwrite, or a
person-shaped approver writer. Those remain independent owner-gated follow-ups with their own
business/security semantics.

## 8. Notes
- **`formDataMapping` interpolation gotcha (operator trap).** Mapping values are rendered by
  `renderMappedValue` and **only emit interpolated content** — a bare literal renders
  **empty**, which fails required-field validation (`Approval form data is invalid`, the
  bridge stays instance-less). Use a `{{…}}` expression, e.g.
  `{ summary: 'Approval for form submission {{recordId}}' }`, not a bare string. The seam test
  encodes this.
- Brand-neutral (benchmarked against mainstream OA / approval platforms; states MetaSheet
  principles, no external brand names in the contract).
- The in-process evidence is automated + re-run every PR; only the deployed-host check (§5)
  requires a human operator on the live environment.
