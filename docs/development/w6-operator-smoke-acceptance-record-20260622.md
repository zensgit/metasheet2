# W6 operator-smoke — acceptance record (2026-06-22)

The "审批 + 自动化桥接可上线" gate. W6 = the automation → approval bridge: an automation
action (`start_approval`) opens an approval; on the approval's terminal event the
suspended automation tail resumes. This record captures the **acceptance state** so the
gate is explicit rather than implicit.

## 1. Implementation state (on `main`)
- **Bridge runtime** — `start_approval` action + the suspend/resume bridge are on `main`
  (the `multitable_automation_approval_bridges` linkage; completion driven by the
  approval terminal event, not an admin token).
- **In-process seam test `#2974`** (`multitable-automation-start-approval-http.test.ts`,
  squash `42cb8f41e`) — on `main`, and wired into the `Run multitable real-DB integration`
  Postgres job (every PR), so it is not invisible debt.

## 2. Acceptance criteria
An operator-equivalent flow proves: **automation `start_approval` → a real approval is
created → the approver approves over the HTTP boundary → the suspended automation tail
resumes exactly once**, with the negative boundary (unauth approve ⇒ no resume).

## 3. Evidence — IN-PROCESS seam: ✅ PASS (verifiable, on `main`)
`#2974` exercises the chain over the **real HTTP boundary** against real Postgres:
`AutomationService.executeRule(start_approval)` → suspended job + pending approval →
`POST /api/approvals/:id/actions {approve}` (real `authRouter` + `approvalsRouter`:
authenticate + `rbacGuard('approvals','act')` + `dispatchAction`) → completion event →
same-process resume of the tail. Asserted:
- **authenticated approve → 200**, execution resumes to `success`, steps
  `[start_approval:success, send_webhook:success]`, tail ran exactly once;
- **unauthenticated approve → 401**, execution stays `running`, bridge `pending`, tail did
  not run (anti-vacuous: no successful approve ⇒ no resume).

This proves the runtime + auth + route + event-bus + resume wiring is correct **in
process**.

## 4. Deployed operator smoke (`#2480` runbook): ⬜ owner sign-off
What `#2974` does **not** cover: the **deployed** path — `/api` co-tenancy with the SPA,
a real operator's browser session, and cross-process resume on the deployed host. That is
the `#2480` operator-smoke runbook, still unfilled.

## 5. Acceptance decision (owner)
The in-process seam (§3) is green and durable; the open question is whether to **ship on
that evidence** or **require the deployed smoke** first. This is an owner gate — I record
the state, the owner records the decision:

- [ ] **Accept on the in-process seam** (`#2974`) — W6 bridge is ship-ready; the deployed
  `#2480` smoke is recommended-but-not-blocking, tracked separately.
- [ ] **Require the deployed `#2480` operator smoke** — run the runbook on the deployed
  host and fill its PASS before shipping; this record links to that result.

**Owner sign-off:** ______________  **Date:** ____________  **Decision:** ____________

## 6. Notes
Brand-neutral (benchmarked against external OA / mainstream approval platforms). The
in-process evidence is automated + re-run every PR; only the deployed-host check requires a
human operator on the live environment.
