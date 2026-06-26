# K3 WISE WebAPI read/list next-slice contract - C0 design-lock - 2026-06-26

## Status

C0 design-lock only. Runtime is not built in this slice.

This document records the next safe shape for #1709 after the single-record
`Material/GetDetail` read-smoke was implemented and validated on the entity
machine. It does not unlock WebAPI LIST, BOM, multi-record expansion,
pagination, master-code resolution, server-side composition, Save, Submit,
Audit, or production write.

## 1. Current baseline

The completed baseline is intentionally narrow:

- PR #3229 added a built-in read-smoke preset route for K3 WISE
  `Material/GetDetail`.
- PR #3231 tightened the route to `integration:write`, because the route is an
  active credentialed outbound probe and an existence signal.
- PR #3241 added a non-persisted in-memory read-config overlay for
  `k3wise.material-detail.v1`, so the route can use an existing K3 WebAPI
  target-side system without requiring the operator to persist `material` read
  config.
- The entity-machine retest for #3241 passed with values-free evidence:
  persisted `material` read config absent, backend restarted, missing-key guard
  fail-closed, read-smoke HTTP 200, `recordPresent=true`, no raw K3 payload, no
  key/host/token/credential/connection string, no Save/Submit/Audit/BOM/LIST,
  and no production write.

The completed scope is therefore:

```text
completedScope=single_record_material_get_detail_read_smoke
readOnlyFirst=true
integrationWriteRequired=true
valuesFreeEvidence=true
credentialsInBackendContext=true
```

## 2. Owner/customer boundary for the next slice

The next #1709 slice must remain narrow, read-only, and fail-closed.

Allowed for the next slice:

- contract shape for K3 WebAPI read/list inputs and outputs;
- built-in preset/allowlist shape;
- values-free smoke evidence shape;
- negative controls proving no raw endpoint/path, raw payload, credential, or
  write can be supplied by the request.

Still locked unless separately authorized by owner/customer GATE evidence:

- WebAPI LIST execution;
- BOM read;
- multi-record expansion;
- pagination;
- broad filtering;
- master-code resolver;
- server-side composition;
- Save / Submit / Audit;
- production write.

## 3. Contract shape to lock before runtime

The next contract must be declarative and allowlisted. A request may identify a
known preset and a minimal, typed read intent. It must not carry a raw K3 path,
HTTP method, endpoint fragment, response JSON, credential, token, or arbitrary
adapter config.

Recommended neutral contract shape:

```jsonc
{
  "presetId": "k3wise.material-detail.v1",
  "intent": {
    "object": "material",
    "mode": "single_record_detail",
    "key": "<explicit key supplied at runtime>"
  }
}
```

Rules:

- `presetId` must resolve to a built-in preset.
- `object` must be one of the preset's allowlisted objects.
- `mode` must be one of the preset's allowlisted modes.
- `key` is runtime input for the active probe only; it must never be copied into
  GitHub evidence, docs, logs, test fixtures, or PR text.
- Raw endpoint/path/method/headers/body/response extraction keys are preset-owned
  or customer-GATE-owned, not request-owned.
- C1/C2 must explicitly reconcile this forward-looking `{ presetId, intent }`
  shape with the shipped read-smoke `{ presetId, key }` subset: either preserve
  the subset for `k3wise.material-detail.v1` single-record detail reads or migrate
  the strict body validation in a dedicated runtime slice. The two shapes must not
  silently diverge.

## 4. Values-free evidence contract

Evidence may include only bounded metadata:

```text
presetId=<built-in preset id>
object=<allowlisted object>
mode=<allowlisted mode>
httpStatus=<coarse status>
apiOk=<true|false>
recordPresent=<true|false>
referenceObjectCount=<count>
errorCode=<coarse code only>
errorType=<coarse type only>
rawPayloadIncluded=false
saveSubmitAuditBomListExecuted=false
productionWriteExecuted=false
```

Evidence must not include:

- material key or BOM key;
- raw K3 request or response payload;
- host, tenant, token, authority code, cookie, password, credential, or SQL
  connection string;
- K3 business row values;
- stack traces carrying submitted values;
- server-side credential store identifiers.

## 5. LIST and BOM are contract-only until separately authorized

The term "read/list contract" does not itself authorize LIST execution.

For now:

```text
webApiListDefault=defer_by_default
bomDefault=locked
multiRecordExpansionDefault=locked
paginationDefault=locked
```

LIST can only move from contract to runtime when all of the following are true:

- owner/customer GATE evidence explicitly requires WebAPI LIST rather than the
  existing SQL read channel;
- the customer supplies redacted list request/response shape;
- pagination/filtering semantics are known;
- the runtime slice has its own review, negative controls, and values-free
  entity-machine smoke.

BOM can only move when the BOM-specific request/response and relationship
semantics are confirmed. It must not ride on a Material-detail smoke PR.

## 6. Implementation ladder

This is the intended sequence. Each row is a separate opt-in.

| Slice | Scope | Runtime opened |
| --- | --- | --- |
| C0 | This design-lock: next-slice contract/evidence/boundary | None |
| C1 | Contract normalizer and preset metadata tests, if needed | None |
| C2 | Narrow values-free read-only smoke extension, if owner/customer opts in | Single allowlisted read only |
| C3 | LIST runtime, only if WebAPI LIST is explicitly required | LIST only |
| C4 | BOM runtime, only after BOM contract evidence | BOM read only |
| C5 | Resolver/composition, only after explicit owner unlock | TBD |

No slice may combine contract definition with broad runtime expansion. No slice
may include Save, Submit, Audit, K3 write, or production write.

## 7. Acceptance locks for C1/C2

When the next implementation slice is opened, it must prove:

- request cannot supply raw endpoint/path/method/headers/body;
- request cannot supply adapter config, credential material, or a raw K3 payload;
- unknown preset/object/mode fails closed before adapter creation;
- missing key fails closed before K3 is called;
- read-smoke evidence is values-free;
- persisted external-system config is not mutated by preset overlay behavior;
- Save/Submit/Audit/BOM/LIST code paths are not called unless the slice
  explicitly authorizes that path;
- read users cannot trigger the credentialed probe if the route remains
  operator-gated.

## 8. Non-goals

- No runtime code in this C0.
- No migration.
- No UI.
- No external-system credential change.
- No K3 Save / Submit / Audit.
- No BOM.
- No WebAPI LIST runtime.
- No production write.
- No server-side composition or master-code resolver.

## 9. Issue disposition

#1709 remains open/on-hold for broader read/list. The backend-safe
single-record `Material/GetDetail` read-smoke is complete. Every broader runtime
surface listed above requires a separate owner opt-in and customer GATE evidence.
