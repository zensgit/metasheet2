# K3 WISE BOM material to FBillNo resolver - GATE-front contract & design-lock - 2026-06-30

## Status

**GATE-front design only. No runtime implemented in this PR. No K3 call is made.**

Owner-authorized 2026-06-30 as the GATE-front for the next #1709 slice after C4
single-level BOM read. This PR is docs-only and exists to lock the contract and
operator shape intake for a **read-only material -> FBillNo resolver** before any
runtime is built.

Scope fence for this PR:

- no runtime; no preset; no route; no adapter change.
- no resolver call; no BOM read call; no recursive BOM expansion.
- no Save / Submit / Audit; no K3 write; no production write.
- values-free throughout: keys, types, counts, booleans, and structural paths only.

The resolver runtime remains frozen until both are true:

1. the operator/customer provides the redacted live lookup shape described below, and
2. the owner gives a separate resolver runtime opt-in.

This document does not authorize that runtime.

## Why now

C4 BOM single-level read is shipped and entity-verified:

- #3399 (`c499abe83`) locked the shape-first BOM GATE-front.
- #3405 (`efa832a08`) shipped `k3wise.material-bom.v1`.
- The entity-machine read-smoke PASSed with one owner-approved private `FBillNo`:
  `recordCount=3`, `bomHeaderCount=1`, `bomLineCount=3`, `Data.Page1` header,
  `Data.Page2` lines, and `bomKeyEchoed=false`.

That capability deliberately reads by **BOM bill number**. It does not answer the
next operator question: given a material, which BOM bill number should be used?

The next useful bridge is therefore not recursion and not write. It is a narrow,
read-only resolver:

```text
material key -> FBillNo candidate(s)
```

This is still a separate gate. A BOM read-smoke PASS proves `BOM/GetDetail` works for
an already-known `FBillNo`; it does **not** prove how a live K3 instance maps a material
to a default/current/active BOM bill.

## Current verified baseline

| Surface | State | Boundary |
| --- | --- | --- |
| `k3wise.material-list.v1` | shipped + entity-verified | bounded Material/GetList page read; optional keyed filter; no resolver/write |
| `k3wise.material-bom.v1` | shipped + entity-verified | one `BOM/GetDetail` call by bound `Data.FBillNo`; single-level; no resolver/recursion/write |
| material -> FBillNo resolver | **not built** | this design-lock only |
| recursive BOM expansion | frozen | separate fan-out/request-amplification gate |
| Save / Submit / Audit / write | frozen | separate owner authorization |

## Proposed contract (post-GATE only)

A future resolver slice may add a built-in resolver preset such as
`k3wise.material-bom-resolver.v1`. The exact name is not important; the invariants are.

The resolver is a read-only lookup. It may return values internally for the next server
step, but public evidence must remain values-free.

Allowed post-GATE shape:

```jsonc
{
  "presetId": "k3wise.material-bom-resolver.v1",
  "intent": {
    "object": "material-bom-resolver",
    "mode": "resolve_bom_bill",
    "key": "<owner-approved material key supplied at runtime>"
  }
}
```

Rules:

- `presetId` must be built-in and allowlisted.
- The request may supply only the runtime material key. It must never supply a raw
  endpoint, path, method, filter, field list, body, response path, credential, token, or
  adapter config.
- The preset owns endpoint/path/body/filter/field selection.
- Material key encoding is contingent on the operator-confirmed request shape. It must
  not be copied from C3 LIST or C4 BOM by habit:
  - expression string -> use the confirmed K3 filter escaping strategy;
  - structured JSON field -> bound JSON value, no expression escaping;
  - numeric/internal id -> type-check and bind as the confirmed type.
- The runtime must fail closed on no match, multiple matches without a deterministic
  rule, inactive/non-current candidates, unsupported version semantics, or missing
  required operator inputs.
- The resolver must not automatically execute `BOM/GetDetail` in the first slice. It
  proves lookup only. A later server-side composition slice may chain resolver -> BOM
  read only after a separate owner opt-in.

## Resolver-specific unknowns - blockers for runtime

These must be answered by the redacted live shape before any implementation.

| ID | Question | Why it blocks |
| --- | --- | --- |
| R1 | Exact lookup endpoint path + HTTP method | adapter cannot issue the lookup |
| R2 | Request shape: which field carries the material key; is it a structured body field, filter-expression value, material number, material id, or internal K3 id | safe request builder and key typing cannot be built |
| R3 | Response container path + case for BOM bill candidate rows | extractor cannot locate candidates |
| R4 | Candidate row field keys: FBillNo key, material key/id echo field, active/current/default flag, version/effective-date fields, status fields | runtime cannot choose safely or prove why it held |
| R5 | Multiplicity rule: when multiple BOM bills exist for one material, which one is selected (active/current/default/latest/effective-date/org-specific) | prevents silent wrong-BOM selection |
| R6 | Organization/scope/version inputs: whether org id, use-org, BOM category, version, or effective date is required | prevents cross-org or stale-version lookup |
| R7 | No-match / inactive / ambiguous / invalid-material error envelope | distinct fail-closed evidence and stop rules |
| R8 | Whether the lookup returns just header rows or also line rows | keeps resolver from accidentally becoming BOM read or recursion |

## Operator intake manifest

Requested once from operator/customer, values-free. This can come from a live working K3
lookup or official K3 WebAPI documentation **for this instance**. Prefer a live shape.

Please provide structure only:

1. **Endpoint** - material-to-BOM lookup path + HTTP method.
2. **Request skeleton** - body keys / filter keys; mark the material-key field; mark
   whether it is a structured JSON value, filter expression, internal id, or other typed
   value. Redact the value.
3. **Required scope fields** - org id, use-org, BOM category, version/effective date, or
   other flags if required. Redact values.
4. **Response skeleton** - top-level keys + types; candidate row container path + case +
   type + arrayLength.
5. **Candidate row field keys + types** - especially the FBillNo field, active/current
   flag, version/effective-date fields, material key/id echo field, status, and org/scope
   fields. No values.
6. **Multiplicity examples** - values-free counts only:
   - one material -> zero candidate rows;
   - one material -> exactly one current/active candidate;
   - one material -> multiple candidates, with the field that determines the selected
     one.
7. **Error envelope** - keys/codes for invalid material, no BOM, inactive BOM, and
   ambiguous version.

Redaction rules:

- Do not include material numbers/names/ids, BOM bill numbers, row values, messages, raw
  payloads, credentials, tokens, cookies, authority codes, connection strings,
  host/system/tenant ids, or arbitrary response keys beyond the requested skeleton.
- Allowed evidence is structural: field names, types, booleans, counts, container paths,
  enum-like error codes, and array lengths.

Ready-to-post operator request:

```text
Next operator/customer step: material→FBillNo resolver GATE-front.
Please provide one redacted live material-to-BOM lookup request/response SHAPE.

Structure only, no values:
- endpoint path + HTTP method
- request skeleton; mark the material-key field and whether it is a structured JSON
  value, filter-expression value, material number/id, or internal K3 id
- required scope fields: org/use-org/BOM category/version/effective date/etc.
- response skeleton: top-level keys+types; candidate row container path+case+type+
  arrayLength
- candidate row field keys+types: FBillNo, active/current/default/status, version/
  effective-date, org/scope, material echo field if present
- multiplicity rule: zero/one/multiple candidate row counts and which field selects the
  default/current bill
- error envelope keys/codes for invalid material, no BOM, inactive BOM, ambiguous version

Redact all material numbers/names/ids, FBillNo values, row values, raw payloads, messages,
credentials/tokens/cookies/authority codes, connection strings, host/system/tenant ids.
Boundary: shape request only. No resolver runtime, no BOM call, no recursion, no
Save/Submit/Audit/write.
```

## Error taxonomy (post-GATE)

A distinct prefix keeps resolver evidence separate from BOM read and write paths.

| Condition | Code |
| --- | --- |
| resolver endpoint not configured | `K3_WISE_BOM_RESOLVER_NOT_CONFIGURED` |
| material key missing / invalid | `K3_WISE_BOM_RESOLVER_KEY_INVALID` |
| transport / HTTP error | `K3_WISE_BOM_RESOLVER_FAILED` |
| candidate container not located | `K3_WISE_BOM_RESOLVER_CONTAINER_UNLOCATED` |
| no BOM candidate for material | `K3_WISE_BOM_RESOLVER_NOT_FOUND` |
| multiple candidates, no deterministic rule | `K3_WISE_BOM_RESOLVER_AMBIGUOUS` |
| K3 business error in response | `K3_WISE_BOM_RESOLVER_BUSINESS_ERROR` |

Resolver errors must not fall through to `K3_WISE_BOM_READ_*` or Save / Submit / Audit
paths.

## Boundary and non-goals

- No runtime in this PR.
- No K3 call in this PR.
- No automatic resolver -> BOM read composition in the first resolver slice.
- No recursive BOM expansion.
- No material master search beyond the specific resolver shape.
- No Save / Submit / Audit; no K3 write; no external/production write.
- No UI.
- No migration.
- No credential or external-system config mutation.
- No values in docs, fixtures, logs, PR text, comments, or issue evidence.

## Post-GATE implementation ladder

Each row is a separate opt-in.

| Slice | Scope | Runtime opened |
| --- | --- | --- |
| R0 | This design-lock + operator shape ask | None |
| R1 | Resolver contract normalizer + preset metadata tests | None |
| R2 | Resolver read-smoke runtime for material -> FBillNo lookup only | One allowlisted read-only lookup |
| R3 | Optional composition: resolver output feeds `k3wise.material-bom.v1` in one server action | Separate opt-in; still read-only |
| R4 | Recursive BOM expansion | Separate fan-out gate |
| R5 | Any write path | Separate owner authorization |

No slice may combine resolver contract + runtime + composition in one PR. No slice may
include Save, Submit, Audit, K3 write, production write, or recursive fan-out.

## Acceptance locks for the first runtime slice

When R2 is opened, it must prove:

- request cannot supply raw endpoint/path/method/body/filter/response path;
- unknown preset/object/mode fails closed before adapter creation;
- missing material key fails closed before K3 is called;
- no-match and ambiguous-match outcomes hold, not guess;
- values-free success evidence: `candidateCount`, `resolved=true|false`,
  `ambiguous=true|false`, `selectedRule=<enum>`, `keyEchoed=false`;
- values-free failure evidence: enum-like error code/type only, no message or raw payload;
- resolver does not call `BOM/GetDetail`;
- resolver does not call Save / Submit / Audit or any write;
- persisted external-system config is not mutated;
- route remains operator-gated (`integration:write`) if exposed via read-smoke.

## Disposition

This document opens only the **GATE-front**. The actual resolver remains frozen until the
operator shape arrives and the owner explicitly opts into the runtime slice.

The already verified C4 BOM read remains what it is: one-call single-level read by known
`FBillNo`. It is not a material-to-BOM resolver and it does not authorize server-side
composition.
