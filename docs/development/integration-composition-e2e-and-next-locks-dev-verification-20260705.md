# Read-source composition E2E + next locks — development & verification — 2026-07-05

## 1. Scope

This document records the 2026-07-05 follow-up batch on the #1709
read-source / system-integration line after the read-only composition arc became
feature-complete in code.

The batch did four things:

1. added an entity-machine composition smoke lane;
2. added the operator runbook for that smoke lane;
3. locked the recursive expansion direction without authorizing implementation;
4. locked the newly discovered BOM/GetList-by-`FItemID` standalone read gap
   without authorizing implementation.

It is a development and verification ledger, not a runtime authorization. It
does not authorize BL1/BL2, recursive expansion runtime, Save/Submit/Audit,
external write, or production write.

## 2. Artifacts merged

| Slice | PR | Merge SHA | Scope |
| --- | --- | --- | --- |
| A1 | #3600 | `bba53d1e3f68b57a268b595231691a7308fd450f` | Composition post-deploy smoke workflow + values-free script for the material -> FItemID -> FBOMNumber chain. |
| A2 | #3598 | `fe378cd4ff7dfe71ca3b85ee8655449917935976` | Entity-machine E2E acceptance runbook for the read-only composition chain. |
| REC-R0 | #3595 | `28136b5c30dffb42ae0afbf062123b9e3ed93cd6` | Recursive expansion direction design-lock, demand-gated and implementation-free. |
| BL0 | #3603 | `a33526b734a3c0ec9e6b2a3633f9e5148425a2bf` | K3 WISE BOM/GetList by material id standalone read design-lock, implementation-free. |

All four PRs merged with the required GitHub checks green:

```text
contracts (strict)=SUCCESS
pr-validate=SUCCESS
DingTalk P4 ops regression gate=SUCCESS
contracts (dashboard)=SUCCESS
contracts (openapi)=SUCCESS
K3 WISE offline PoC=SUCCESS
test (18.x)=SUCCESS
test (20.x)=SUCCESS
after-sales integration=SUCCESS
coverage=SUCCESS
```

## 3. A1 smoke lane

Source:

- `.github/workflows/integration-composition-postdeploy-smoke.yml`
- `scripts/ops/integration-composition-postdeploy-smoke.mjs`

The lane is manually dispatched and values-free by construction. It exercises
the deployed read-only composition lifecycle over HTTP:

```text
save hop-1 read config -> approve
save hop-2 read config -> approve
save composition draft
pre-approve run -> 409 not approved
approve composition
run composition
override-smuggling negative -> 400
retire composition
post-retire run -> 409 not approved
```

The script prints only statuses, booleans, counts, and coarse codes. It leak
scans the evidence surfaces and deliberately does not print the sample key,
resolved intermediate value, final value, row content, read paths, hosts,
credentials, tokens, tenant/system ids, or raw payloads.

This lane validates platform behavior and contract boundaries. A chain that
reaches K3 and fail-closes with a coarse code is still useful diagnostic
evidence, not automatically an end-to-end business PASS.

## 4. A2 entity-machine runbook

Source:

- `docs/development/integration-composition-entity-e2e-runbook-20260705.md`

The runbook is the operator-facing companion to A1. It records:

- required deployed baseline: main at or after the C-R4 client hardening
  (`9d0acd199`) and the composition stack;
- required migrations: `062_create_integration_read_source_configs.sql` and
  `063_create_integration_read_source_composition_configs.sql`;
- K3 credential precondition, based on the previously observed
  `K3_WISE_CREDENTIALS_MISSING` deployment gap on the standalone read line;
- two-account split: write-tier consultant/admin for authoring, read-tier
  operator for the run route;
- API-only composition authoring status: C-R4 shipped the run panel, not a
  dedicated composition-authoring UI;
- values-free acceptance and failure templates.

The runbook is intentionally honest that the shipped UI is a run panel. The two
underlying read-source configs can use the existing consultant read-source
panel, while composition save/approve/retire remains API-only in this batch.

## 5. Entity-machine evidence and the BL0 follow-up

The first entity-machine composition run for the published package produced
useful negative evidence:

```text
packageDeployAndHealth=PASS
runtimeHttp=200
compositionSmoke=FAIL
evidenceOk=false
stepCount=2
step0Ok=true
step1Ok=false
failedStep=1
compositionCode=READ_SOURCE_COMPOSITION_STEP_FAILED
secondHopStandaloneCode=READ_SOURCE_PROBE_REJECTED
materialStandaloneResolver=PASS
materialResolverDataPresent=true
```

The operator then classified the second-hop shape:

```text
secondHopMode=bom_get_list_by_material_id
secondHopInputName=FItemID
secondHopEndpointClass=GetList
classifiedCase=caseB_secondHopShouldBeBomGetListByResolvedMaterialId
samePackageRerunNeeded=false
needNewPackageNow=false
currentCompositionPass=false
```

Interpretation:

```text
deploy/package/health=PASS
firstHopMaterialResolver=PASS
compositionEngineReachedSecondHop=true
failureLayer=missing_second_hop_read_capability
existingMaterialList=Material/GetList only
existingBomRead=BOM/GetDetail by FBillNo only
existingResolverLookup=keyed detail-style read
missingCapability=BOM/GetList by FItemID standalone resolver/read
```

Boundary evidence held:

```text
intermediateResolvedValuesExposed=false
rawPayloadIncluded=false
credentialsIncluded=false
hostSystemTenantIdsIncluded=false
connectionStringsIncluded=false
materialNumberEchoed=false
bomNumberValueEchoed=false
recursiveBomExpansionExecuted=false
SaveSubmitAuditExecuted=false
externalWriteExecuted=false
productionWriteExecuted=false
```

Therefore #3603 locked the missing capability as BL0. The correct sequence is:

```text
BL0=design-lock only (merged)
BL1=contract/config/preset metadata only, no runtime
BL2=standalone BOM/GetList by FItemID runtime
BL3=package + standalone entity-machine smoke
BL4=composition rerun only after standalone PASS
```

No same-package rerun is expected to change the result, and no new package is
needed for BL0 itself.

## 6. REC-R0 recursive expansion lock

Source:

- `docs/development/integration-read-source-recursive-expansion-direction-design-lock-20260705.md`

REC-R0 is a direction lock only. It records the future shape for bounded
multi-level expansion over the same approved, key-only, values-free, read-only
configured-read primitive:

```text
maxDepth <= platform cap
perLevelFanoutCap <= platform cap
totalNodeBudget <= platform cap
cycleDetection=required
capHit=fail_closed
truncatedExpansionReturnedAsSuccess=false
sameReadPrimitive=true
writePath=false
```

It explicitly requires a named customer demand before any implementation starts.
It is not a replacement for the stock-preparation bridge-SQL large-BOM lane and
does not authorize REC-R1.

## 7. Current state after this batch

Code/runtime state:

```text
readOnlyCompositionRuntime=feature_complete
compositionRouteAndUi=shipped
compositionPostdeploySmokeLane=shipped
compositionRunbook=shipped
compositionEntityE2ECurrentResult=negative_but_diagnostic
firstHopMaterialResolver=PASS
secondHopBomListByFItemID=missing_capability_locked_as_BL0
```

Design state:

```text
recursiveExpansionDirection=locked_as_REC_R0
BOMListByMaterialIdDirection=locked_as_BL0
```

Still gated:

```text
BL1_contract_metadata=requires_separate_owner_opt_in
BL2_runtime=requires_BL1_plus_separate_owner_opt_in
BL3_standalone_entity_smoke=requires_package_with_BL2
BL4_composition_rerun=requires_standalone_PASS
REC_R1_recursive_config_model=requires_named_customer_demand_plus_owner_opt_in
recursiveRuntime=false
SaveSubmitAudit=false
externalWrite=false
productionWrite=false
```

## 8. Disposition

This batch closes the immediate post-composition E2E infrastructure and records
the two next design boundaries found by evidence:

- recursive expansion is a future demand-gated line, not folded into
  composition;
- the failed entity-machine composition run is not a package/deploy/credential
  problem, but a missing standalone BOM/GetList-by-`FItemID` read capability.

The next buildable step, if authorized, is **BL1 only**: contract/config/preset
metadata for BOM/GetList by material id, still with no runtime and no K3 call.
The next runtime step is BL2 and must prove standalone before composition is
rerun.
