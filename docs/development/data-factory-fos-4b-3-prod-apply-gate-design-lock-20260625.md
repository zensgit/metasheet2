# Data Factory FOS-4b-3-prod — production apply gate design lock (2026-06-25)

> Status: **design-lock only / not authorized / no runtime change**. This document defines the production gate that may follow the completed sandbox validation. It does **not** authorize production apply, canonical writes, external writes, K3 Save/Submit/Audit/BOM, or any deployment action.
>
> Prerequisite evidence: FOS-4b-3 sandbox validation is complete and recorded on `origin/main` via #3166 (`168f85d85`): Path 1 single-shot sandbox apply PASS, Windows first-hop deploy PASS, and Path 2 large-BOM checkpoint route-gate sandbox PASS. #3093 was closed as sandbox validation complete. That evidence is a prerequisite, **not** production authorization.

## 0. One Sentence

FOS-4b-3-prod is a separate owner gate that introduces a controlled, fail-closed exception to the current sandbox rule: the production canonical stock-preparation target remains rejected by default, and becomes writable only for a bounded, explicitly authorized production run with a recorded target scope, rollback/evidence plan, and stop rules.

## 1. Grounding

Current runtime guard:

```text
assertStockPrepApplySandboxAllowed(target, policy)
  objectId omitted => prod canonical
  prod canonical => reject(reason=prod_canonical)
  sandbox mode missing/disabled => reject
  target not in sandbox allowlist => reject
```

The guard is enforced at both real write entry points:

```text
small-BOM  : applyStockPreparationAction(...) before token consume / recompute / write
large-BOM  : tableActionLargeBomApplyJobRun(...) before checkpoint writer
```

This is the correct production-protection default. FOS-4b-3-prod must not weaken it by "just removing the canonical rejection." It must add an explicit production policy path with its own fail-closed checks and evidence.

## 2. Non-Goals

```text
noRuntimeChangeInThisDesign=true
noProductionAuthorization=true
noCanonicalWriteNow=true
noExternalWriteNow=true
noK3SaveSubmitAuditBom=true
noScheduledOrBatchRollout=true
noUiUnlock=true
```

This document is not a release note, operator authorization, or apply runbook. It is the security contract that must be ratified before any implementation slice can exist.

## 3. Production Gate Model

### 3.1 Default posture

Production apply remains fail-closed unless all production gates are satisfied. Missing config, stale evidence, target mismatch, route mismatch, unreviewed plan, or absent owner authorization must all reject before any write.

### 3.2 Controlled canonical exception

The implementation must introduce a production policy distinct from the sandbox policy, for example:

```text
stockPrepApplyProduction.enabled=true
stockPrepApplyProduction.authorizedTargetObjectId=plm_stock_preparation_main
stockPrepApplyProduction.authorizationId=<owner-approved opaque id>
stockPrepApplyProduction.expiresAt=<bounded timestamp>
stockPrepApplyProduction.allowedActionId=pull-bom-to-stock-preparation
stockPrepApplyProduction.allowedRoute=<small|large|both>
stockPrepApplyProduction.maxCleanRows=<reviewed bound>
stockPrepApplyProduction.requireFreshDryRun=true
```

The exact config shape is an implementation detail, but the semantic contract is not:

- the production policy is server-side only;
- the browser/request never supplies the target, authorization, or plan;
- canonical is writable only when the production policy explicitly allows it;
- the policy is bounded by time, action, route, target, and clean-row count;
- sandbox policy must not be accepted as production policy;
- production policy must not permit arbitrary non-canonical targets.

### 3.3 Token and revision fence

Production apply must use a fresh dry-run/apply token from the real table-action lifecycle. A sandbox token, old token, mismatched target token, stale target revision, or stale source/plan revision must reject. No blind apply.

### 3.4 Route parity

Both write entry points must be covered:

```text
small-BOM  : production gate before token consume / recompute / write
large-BOM  : production gate at route before checkpoint writer
```

The large-BOM route was the historical bypass site. A production design that gates only the small-BOM writer is incomplete.

### 3.5 Manual-confirm rows

Production apply must preserve the standing writer invariant:

```text
manual_confirm rows are held, not written
acceptManualConfirmHold=true is acknowledgement only
```

The production gate may allow clean decisions to apply, but it must not authorize held/manual-confirm/duplicate-expanded-key rows to write.

### 3.6 Values-free evidence

Production evidence may include only:

```text
authorizationIdHash
routeKind
targetKind=prod_canonical
planFresh=true|false
cleanDecisionCountsWritten
cleanDecisionCountsSkipped
cleanDecisionCountsFailed
manualConfirmRowsHeld
manualConfirmRowsWritten
rePullIdempotencyAddCount
rePullIdempotencySkipCount
rePullIdempotencyUpdateCount
rollbackPlanAttached=true|false
stopRuleTriggered=<code-only|null>
```

Evidence must not include project number, source row values, component names/codes, raw PLM payloads, workspace/object/sheet ids, credentials, tokens, connection strings, or raw SQL.

## 4. Required Owner Authorization

Before implementation can be enabled for a production run, the owner authorization must state:

```text
productionApplyAuthorized=true
authorizationId=<opaque id>
target=prod_canonical_stock_preparation
allowedRoute=<small|large|both>
allowedActionId=pull-bom-to-stock-preparation
maxCleanRows=<reviewed count>
manualConfirmRowsMustStayHeld=true
rollbackPlanApproved=true
valuesFreeEvidenceRequired=true
stopRulesAccepted=true
k3SaveAuthorized=false
k3SubmitAuthorized=false
k3AuditAuthorized=false
k3BomWriteAuthorized=false
externalWriteAuthorized=false
```

Authorization must be explicit for the chosen route. A sandbox validation PASS, closed issue, merged doc, package release, or previous apply token is not authorization.

## 5. Rollback / Recovery Plan

The production runbook must include a rollback or recovery plan before any production apply:

- identify the production run by values-free run id / authorization id;
- record pre-apply row counts and clean decision counts;
- preserve per-row apply result statuses;
- define how newly created rows can be reversed or marked inactive if owner requests rollback;
- define how failed rows and dead letters are reviewed without exposing values;
- require a re-pull idempotency check after apply;
- require human-preserved field verification on at least one edited row if updates are in scope.
- carry forward the #3093 source-registry operator nuance: `sourceRegistryScopeAdjustedByOmittingWorkspaceQuery=true` / `sourceLookupSucceeded=true` must be checked values-free before production.

Rollback evidence is required even if the expected run is all-adds.

## 6. Stop Rules

Implementation and operator runbooks must stop before or during apply when any of these occur:

```text
production policy missing/disabled/expired
authorizationId absent or mismatched
target is not prod canonical
target is prod canonical but production policy does not explicitly allow it
sandbox policy is used as a production policy
route is not included in allowedRoute
dry-run token missing/stale/mismatched
plan target differs from authorized target
manualConfirmRowsWritten > 0
cleanDecisionCountsFailed suggests route-gate/writer bug
canonicalWriteExecuted=true without production policy
externalWriteExecuted=true
k3SaveSubmitAuditBomWriteExecuted=true
evidence contains source values / ids / credentials / tokens / raw payloads
```

Stop-rule evidence must be values-free and code-only.

## 7. Implementation Slices

All slices remain gated and require owner ratification before starting.

1. **P0 design-lock** — this document. Docs-only, no runtime.
2. **P1 production policy contract** — normalize/validate production policy, add negative-control tests, no apply enabled.
3. **P2 guarded production apply runtime** — wire the production policy into both small-BOM and large-BOM entry points. Fail-closed by default; canonical stays rejected without policy.
4. **P3 production runbook** — exact operator steps, evidence template, rollback path, and stop rules.
5. **P4 first production apply** — one owner-authorized run only, bounded target/route/count, values-free evidence, re-pull idempotency.

No slice may combine "contract" and "first production write" in one PR.

## 8. Negative Controls

The implementation must test at least:

```text
no production policy => canonical rejected before write
expired production policy => rejected before write
sandbox policy only => canonical rejected
authorizationId mismatch => rejected
target omitted => treated as prod canonical and rejected unless production policy explicitly allows it
non-canonical target with production policy => rejected
small-BOM path covered
large-BOM checkpoint route covered
manual_confirm rows held and unwritten
request-supplied target/authorization/plan ignored or rejected
values-free evidence excludes ids/values/tokens/credentials/raw payloads
```

## 9. Acceptance For This Design-Lock

```text
docsOnly=true
opensNoProductionApply=true
controlledCanonicalExceptionDefined=true
bothWriteEntryPointsRequired=true
ownerAuthorizationShapeDefined=true
rollbackEvidenceRequired=true
stopRulesDefined=true
valuesFreeEvidenceDefined=true
implementationSlicesGated=true
```

## 10. Current State After This Document

If this document lands, the state becomes:

```text
sandbox validation COMPLETE
production gate design-locked
production apply still CLOSED
next step requires owner ratification of P1 production policy contract
```

The production gate exists as a contract only. The canonical production target remains unwritable until the separate implementation and first-run gates are explicitly authorized and verified.
