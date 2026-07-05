# K3 WISE BOM/GetList by Material Id - Standalone Read Design-Lock - 2026-07-05

## Status

**Design-lock only. No runtime, route, adapter, preset, migration, UI, package, or
K3 call is implemented by this document.**

This lock records the next small #1709 slice discovered by the read-only
composition entity-machine E2E:

```text
materialNumber -> FItemID -> BOM/GetList by FItemID -> FBOMNumber
```

The composition runtime is already feature-complete enough to reach the second
hop. The entity-machine run proved package/deploy health and the first hop, then
failed at the second hop because the intended second hop is a BOM **list**
lookup by material id, not the already-shipped BOM detail read by `FBillNo`.

This is a new read capability. It is not a same-package rerun, not a deployment
issue, and not a recursive BOM expansion.

## Evidence Trigger

Values-free #1709 evidence from the composition E2E package:

```text
releaseTag=multitable-onprem-composition-e2e-20260705-5c34b2db7
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

The operator then classified the failed second-hop config:

```text
secondHopMode=bom_get_list_by_material_id
secondHopInputName=FItemID
secondHopEndpointClass=GetList
classifiedCase=caseB_secondHopShouldBeBomGetListByResolvedMaterialId
samePackageRerunNeeded=false
needNewPackageNow=false
currentCompositionPass=false
```

Boundary evidence also held:

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

## Current Code Ground Truth

The current runtime cannot satisfy this second hop:

- `resolver_lookup` probe/read request construction is keyed detail-style:
  `{ object, filters: { [keyField]: key } }`.
- K3 WebAPI LIST mode currently accepts only the `material` object.
- K3 WebAPI BOM mode currently executes `BOM/GetDetail` by bound `Data.FBillNo`.
- Therefore a second hop that means "BOM/GetList by `FItemID` and resolve
  `FBOMNumber`" is outside the existing capability surface.

This is exactly why the entity-machine run failed at composition step index 1
(the second hop) while the first hop and deployment path passed.

## One-Line Scope

Add, in a later implementation slice, a narrow read-only standalone K3 WISE
BOM-list lookup that takes one platform-derived material id (`FItemID`) and
resolves one BOM number (`FBOMNumber`) under explicit multiplicity rules, with
values-free evidence. Prove it standalone first; only then rerun composition.

## Proposed Post-Lock Capability

A future slice may introduce a built-in read-source shape such as:

```text
preset=k3wise.bom-list-by-material-id.v1
object=material-bom-list
mode=resolver_lookup
inputName=FItemID
endpointClass=GetList
output=FBOMNumber
```

The exact identifiers may change in the runtime PR, but the invariants must not:

- the input key is one scalar material id produced by an approved upstream read
  or supplied to a standalone operator smoke as a private key;
- endpoint, body, filter expression, field list, response containers, and
  resolver rule are preset/config-owned, never runtime-request-owned;
- credentials stay backend-held through the registered external system;
- evidence is values-free and bounded;
- the first proof is standalone, not composition.

## Request Contract Locks

The runtime request may carry only the approved read-source runtime input shape:

```json
{
  "inputs": {
    "key": "<private material id>"
  }
}
```

It must not carry:

- raw endpoint/path/method;
- raw K3 `Filter`, `Fields`, body, response path, or container path;
- credential, token, cookie, authority code, host, tenant, system id, or
  connection string;
- row values, material numbers/names, BOM numbers, or arbitrary payload fields;
- recursion depth, child traversal options, write flags, Save/Submit/Audit flags.

The runtime must type-check the input according to the confirmed K3 contract
before building the K3 request. If the confirmed contract requires numeric
`FItemID`, non-numeric input fails before any K3 call.

## K3 Shape Locks

The implementation slice must lock these K3-facing details in code and tests:

1. endpoint path and HTTP method for BOM list by material id;
2. request field or filter expression that carries `FItemID`;
3. encoding strategy:
   - bound structured JSON value if K3 expects a field;
   - expression escaping only if K3 expects a filter expression;
   - no copy-paste from Material LIST or BOM/GetDetail unless the live contract
     matches it;
4. response container path and case for candidate BOM rows;
5. row field that contains `FBOMNumber`;
6. row field or rule used to prove uniqueness/current/default if multiple BOM
   candidates exist;
7. empty/no-match and ambiguous-match envelopes.

The implementation must not infer "first row wins" from a list response. It must
use the resolver multiplicity rule already defined for `resolver_lookup` and
fail closed when uniqueness cannot be proven.

## Evidence Contract

Success evidence may include only:

```text
ok=true
candidateCount=<bounded count>
matchedCount=<bounded count>
resolved=true
rule=<registered rule>
containerLocated=true|false
containerShape={type,arrayLength}
inputEchoed=false
rawPayloadIncluded=false
credentialsIncluded=false
hostSystemTenantIdsIncluded=false
connectionStringsIncluded=false
```

Failure evidence may include only:

```text
ok=false
errorCode=<registered coarse code>
errorType=<registered coarse type>
candidateCount=<bounded count or null>
containerLocated=true|false
containerShape={type,arrayLength}
```

Evidence must never include:

- `FItemID` value;
- `FBOMNumber` value;
- material number/name/id;
- BOM bill number;
- row values or row keys beyond fixed, reviewed evidence keys;
- K3 message text;
- raw request or response payload;
- endpoint/host/tenant/system id;
- credentials, tokens, cookies, authority codes, connection strings.

## Error Taxonomy

The first runtime slice should use a distinct registered coarse-code family so a
second-hop list failure does not collapse into generic composition failure during
standalone diagnosis:

| Condition | Suggested code |
| --- | --- |
| preset/config missing | `K3_WISE_BOM_LIST_BY_MATERIAL_NOT_CONFIGURED` |
| key missing or wrong type | `K3_WISE_BOM_LIST_BY_MATERIAL_KEY_INVALID` |
| request rejected by K3 | `K3_WISE_BOM_LIST_BY_MATERIAL_REJECTED` |
| network/auth failure | `K3_WISE_BOM_LIST_BY_MATERIAL_FAILED` |
| response container missing/wrong shape | `K3_WISE_BOM_LIST_BY_MATERIAL_SHAPE_MISMATCH` |
| no BOM candidate | `K3_WISE_BOM_LIST_BY_MATERIAL_NOT_FOUND` |
| multiple candidates without a deterministic rule | `K3_WISE_BOM_LIST_BY_MATERIAL_AMBIGUOUS` |
| winning row lacks `FBOMNumber` | `K3_WISE_BOM_LIST_BY_MATERIAL_FIELD_MISSING` |

The exact code names may be shortened before implementation, but they must be
registered exact values, not regex/prefix-through strings. Unknown producer codes
must degrade to a safe generic fallback.

## Standalone-First Gate

This capability must prove itself as a standalone read before composition is
rerun.

Required standalone entity-machine PASS evidence:

```text
bomListByMaterialSmoke=PASS
runtimeHttp=200
evidenceOk=true
inputName=FItemID
endpointClass=GetList
candidateCount=<bounded count>
resolved=true
resolverDataPresent=true
inputEchoed=false
fbomNumberEchoed=false
rawPayloadIncluded=false
credentialsIncluded=false
hostSystemTenantIdsIncluded=false
connectionStringsIncluded=false
recursiveBomExpansionExecuted=false
SaveSubmitAuditExecuted=false
externalWriteExecuted=false
productionWriteExecuted=false
```

Only after that PASS may the existing composition E2E be rerun:

```text
materialNumber -> FItemID -> FBOMNumber
```

The composition rerun must still keep the intermediate `FItemID` and final
`FBOMNumber` out of public evidence.

## Staged Ladder

Each row is a separate owner opt-in.

| Slice | Scope | Runtime opened |
| --- | --- | --- |
| BL0 | This design-lock | None |
| BL1 | Contract/config/preset metadata for BOM list by material id | None |
| BL2 | Adapter/probe/read runtime for standalone BOM/GetList by `FItemID` | One allowlisted read-only lookup |
| BL3 | Package + standalone entity-machine smoke | Operational validation only |
| BL4 | Composition rerun and closeout update | Existing composition path only, no recursion |

No slice may combine design-lock, runtime, composition rerun, and docs closeout
in one PR.

## Negative Controls

The runtime PR must test:

- wrong object or mode fails before adapter read;
- request-supplied raw endpoint/filter/body/field list is rejected;
- missing key fails before K3 call;
- non-scalar key fails before K3 call;
- if the confirmed input is numeric, non-numeric input fails before K3 call;
- no-match returns a registered no-match code;
- ambiguous candidates return a registered ambiguous code and do not select row
  zero;
- winning row missing `FBOMNumber` returns a registered field-missing code;
- values-free evidence does not contain `FItemID`, `FBOMNumber`, material values,
  BOM values, host, tenant, credential, or raw payload;
- list cap is enforced;
- adapter write methods are never called;
- `BOM/GetDetail` is not called by this slice;
- recursive fan-out is not executed.

## Relationship To Nearby Tracks

- #3598 composition E2E runbook records how to run and interpret the composition
  acceptance. This lock scopes the new second-hop capability that the runbook
  exposed as missing.
- #3595 recursive expansion design-lock is about multi-level fan-out. This lock
  is a one-hop list-backed resolver and explicitly excludes recursion.
- Existing `k3wise.material-bom.v1` remains the single-level `BOM/GetDetail` by
  `FBillNo` read. This lock does not change that path.
- Existing write-self-service and K3 write paths remain separate gates.

## Non-Goals

- No recursive BOM expansion.
- No multi-level traversal.
- No `BOM/GetDetail` behavior change.
- No Save / Submit / Audit.
- No external write or production write.
- No arbitrary endpoint/body/filter supplied at runtime.
- No customer-authored JavaScript, SQL, JSONPath, regex, or expression engine.
- No terminal-user free-form API connector.
- No host-allowlist widening.
- No raw payload, row value, material value, BOM value, host, tenant, or
  credential in evidence.

## Disposition

The composition E2E negative result is accepted as useful localization:

```text
package/deploy/health=PASS
firstHop=PASS
compositionEngineReachedSecondHop=true
missingCapability=BOM/GetList by FItemID standalone resolver/read
samePackageRerunNeeded=false
```

The next buildable step is BL1 only after owner opt-in. Until BL2 and BL3 pass,
the composition line must remain **not entity-machine PASS** for the
`materialNumber -> FItemID -> FBOMNumber` chain.
