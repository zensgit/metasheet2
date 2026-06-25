# FOS-4b-3-prod — production apply runbook (2026-06-25)

> Status: **runbook (docs-only)**. This is the **procedure** for the first production canonical write. Following it requires a **separate, explicit owner authorization** (P4) **and** a configured server-side production policy. **This runbook does not authorize or open production apply.** Until P4 is authorized and a policy is configured, production apply is CLOSED and the canonical (`plm_stock_preparation_main`) is unwritable.
> Grounding: design-lock `data-factory-fos-4b-3-prod-apply-gate-design-lock-20260625.md`; P1 policy contract (#3195, `931c018e2`); P2 guarded runtime (#3199, `aedc7dbf6`, dormant-by-default); sandbox validation COMPLETE (#3093 / §9 of the verification MD).

## 0. Scope / non-goals

- **Procedure only.** Defines operator steps, authorization template, evidence template, rollback, and stop rules for one bounded production run.
- **Not an authorization.** Existence of this doc, P1/P2 on main, a package release, or the sandbox PASS is **not** authorization (design-lock §4).
- **Dormant until configured.** P2 is dormant by default; the canonical becomes writable only when an owner configures `context.config.stockPrepApplyProduction` for a bounded window. No env switch exists.
- **Closed throughout:** external writes, K3 Save/Submit/Audit/BOM, UI unlock, scheduled/batch rollout.

## 1. Prerequisites (all required before any step)

```text
☐ sandbox validation COMPLETE on record (#3093 / verification MD §9): Path 1 + Path 2 + Windows deploy PASS
☐ P1 (policy contract) + P2 (guarded runtime) on main
☐ explicit owner authorization for THIS run (§2)
☐ a bounded production policy ready to configure (§3): canonical target, single action, bounded route + maxCleanRows + short expiry
☐ rollback/evidence plan reviewed (§6) and an operator who can execute + revert
☐ credentials only via the credential store (never request/preset/browser)
```

## 2. Step 0 — Owner authorization (record before configuring)

The owner authorization must state (values-free; do not paste real ids/values):

```text
productionApplyAuthorized=true
authorizationId=<opaque id>
target=prod_canonical_stock_preparation
allowedRoute=<small|large|both>
allowedActionId=plm.stock-preparation.pull-bom.v1
maxCleanRows=<reviewed count>
expiresWithin=<short window, <= 7 days>
manualConfirmRowsMustStayHeld=true
rollbackPlanApproved=true
valuesFreeEvidenceRequired=true
stopRulesAccepted=true
k3SaveAuthorized=false  k3SubmitAuthorized=false  k3AuditAuthorized=false  k3BomWriteAuthorized=false
externalWriteAuthorized=false
```

## 3. Step 1 — Configure the production policy (server-side only)

Set server config (NOT request/env), then restart/reload:

```text
context.config.stockPrepApplyProduction = {
  enabled: true,
  authorizedTargetObjectId: 'plm_stock_preparation_main',  // canonical; P1 rejects any non-canonical
  authorizationId: '<opaque id>',
  allowedActionId: 'plm.stock-preparation.pull-bom.v1',
  allowedRoute: '<small|large|both>',
  maxCleanRows: <reviewed count>,
  expiresAt: '<strict ISO-8601, within 7 days>',  // P1: strict ISO + bounded window
  requireFreshDryRun: true,
}
```

```text
☐ verify the gate engaged: the canonical is now writable ONLY for this policy's target/route/action
☐ verify a NON-matching apply still rejects (wrong route/action/target → STOCK_PREP_PRODUCTION_APPLY_DENIED)
☐ verify removing the config returns to dormant (canonical rejected) — the off-switch works
```

## 4. Step 2 — Preflight (values-free)

```text
☐ canonical target ready; sandbox validation evidence on record
☐ #3093 source-registry nuance handled: sourceRegistryScopeAdjustedByOmittingWorkspaceQuery=true / sourceLookupSucceeded=true
☐ no credentials / object ids / row values printed in any evidence
```

## 5. Step 3 → Step 4 — Fresh dry-run, then apply (bounded, clean-only)

```text
Step 3 (fresh dry-run): run the real action dry-run → fresh dryRunToken + values-free plan counts
☐ status=ready; dryRunToken present (not printed)
☐ cleanCount (add+update) <= maxCleanRows  (else STOP — exceeds authorized bound)
☐ manual_confirm rows present? they MUST stay held
Step 4 (apply): run the authorized route ONLY, with the fresh token; acceptManualConfirmHold acknowledgement-only
☐ canonicalWriteExecuted only under the production policy; route gate observed
☐ manualConfirmRowsWritten=0 (held); cleanDecisionCountsWritten=<= maxCleanRows>; failed=0
☐ no external write / K3
```

## 6. Step 5 → Step 6 — Verify + rollback

```text
Step 5 (verify): re-pull idempotency (re-run dry-run → add=0/skip=N) + human-field preservation on >=1 edited row
Step 6 (rollback if requested): identify the run by values-free run id / authorizationId; reverse or mark
  inactive (active=false) the newly-created rows; review failed/dead-letter rows values-free
☐ rollback evidence captured even if the run was all-adds
```

## 7. Stop rules (stop before/at apply on any)

```text
production policy missing/disabled/expired/expiry-too-far/malformed; authorizationId absent/mismatched;
target not canonical or not explicitly named; route/action not authorized; dry-run token missing/stale/mismatched;
cleanCount > maxCleanRows; manualConfirmRowsWritten > 0; canonicalWriteExecuted without production policy;
externalWriteExecuted or any K3 write; clean-row failures suggesting a route-gate/writer bug; evidence would
print credentials/tokens/object/sheet/workspace ids/project no/row values/raw payloads/raw SQL
```

## 8. Step 7 — Exit / re-disable

```text
☐ after the run: remove context.config.stockPrepApplyProduction (or let it expire) → P2 dormant again, canonical rejected
☐ archive the values-free run evidence + rollback record
```

## 9. Evidence template (values-free; the ONLY fields to report)

```text
authorizationIdHash, routeKind, targetKind=prod_canonical, planFresh,
cleanDecisionCountsWritten/Skipped/Failed, manualConfirmRowsHeld, manualConfirmRowsWritten,
rePullIdempotencyAddCount/SkipCount/UpdateCount, humanFieldPreserved,
rollbackPlanAttached, stopRuleTriggered(code-only|null), valuesFreeEvidence=true
```

## 10. Red lines / boundary

```text
firstProductionCanonicalWrite = owner-gated (P4); only under a bounded server-config production policy
manual_confirm/held rows never written; requireFreshDryRun enforced (no stale/sandbox token)
no external write; no K3 Save/Submit/Audit/BOM; values-free evidence only
dormant by default — removing the config closes production again
this runbook is the procedure, not the authorization
```
