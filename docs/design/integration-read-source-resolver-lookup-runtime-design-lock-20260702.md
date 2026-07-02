# Integration Read Source `resolver_lookup` Runtime Design-Lock — 2026-07-02

## Status

RATIFIABLE DESIGN-LOCK. Runtime is not built by this document.

The external-API read self-service line is complete through S3. Its generic
read executor deliberately rejects `resolver_lookup` with `mode_not_supported`
because resolver selection semantics were not yet designed. This document locks
the missing semantics before any runtime slice may execute resolver configs.

## One-Line Scope

Enable a read-only, approved-config-only resolver lookup that maps one caller
input key to one resolved value under explicit multiplicity rules, with
values-free evidence and no silent first-row fallback.

## Current Ground Truth

- S1 accepts `resolver_lookup` as a configured read mode.
- S3-1 rejects `resolver_lookup` at runtime with `mode_not_supported`.
- S3-2 runtime reads require approved configs and a strict `{ inputs }` body.
- Runtime evidence is values-free; mapped data may contain authorized fieldMap
  values.
- Write/delete, host-allowlist widening, free-form endpoint/body/filter input,
  recursive composition, and production/external writes remain separate gates.

## Resolver Contract

A runtime-capable resolver config MUST declare these fields after R0 expands the
S1 contract:

- `mode: "resolver_lookup"`;
- one source key input declared by `keyField`;
- one or more container paths where candidate rows may appear;
- `fieldMap` with exactly one resolver output target for v1;
- `resolverRule` from the fixed set below;
- rule-specific fields:
  - `first_when_sorted`: `multiplicityRuleField` as the sort field plus
    `resolverSortDirection`;
  - `field_equals`: `multiplicityRuleField` as the discriminator field plus
    `resolverDiscriminatorValue`;
  - `exactly_one`: no `multiplicityRuleField`.

Current S1 requires `multiplicityRuleField` for every `resolver_lookup` config.
R0 must change that: the field becomes rule-specific, not unconditionally
required. This is an intentional contract extension, not a runtime-only change.

The runtime request remains:

```json
{
  "inputs": {
    "key": "<private runtime key>"
  }
}
```

No request-supplied endpoint, filter, body, container path, field map,
multiplicity rule, or raw resolver expression is allowed.

## Multiplicity Rules

v1 supports only these rules:

1. `exactly_one`
   - PASS when exactly one candidate row is present.
   - FAIL when zero or more than one candidates are present.
2. `first_when_sorted`
   - PASS only when the config declares a sort field and sort direction.
   - Runtime sorts candidates by that declared field and returns the first.
   - FAIL when the sort field is missing on any candidate row, types are mixed,
     the sorted order is ambiguous, or the candidate cap was reached before the
     full candidate set was observed.
3. `field_equals`
   - PASS only when exactly one candidate has a declared discriminator field
     equal to a declared enum-like discriminator value.
   - FAIL when zero or multiple candidates match.

Anything else is `resolver_rule_not_supported`.

The default MUST NOT be "take the first row". A config without an explicit rule
is invalid for runtime execution.

`resolverDiscriminatorValue` is config metadata, not runtime data. R0 must bound
it to a short enum-like token (for example the same bounded-identifier family,
or an explicitly reviewed equivalent) and reject host/path/secret/value-shaped
strings. It must never appear in evidence.

## Candidate Shape Rules

- Container resolution reuses the S3-1 own-property dotted walker.
- Prototype keys never resolve.
- A located resolver container MUST be an array of plain objects.
- Scalar entries, arrays inside the candidate list, or mixed row shapes are
  `resolver_shape_mismatch`.
- Candidate count is capped by the existing platform row cap. If the cap is hit
  before a rule can prove uniqueness, the resolver MUST fail closed with
  `resolver_cap_reached`.
- The winning row MUST contain the configured fieldMap source. Missing, null, or
  blank resolved output is `resolver_field_missing`; the resolver must not
  inherit S3-1's generic fail-soft `null` projection for this mode.

## Data Plane

The resolver data plane returns only the configured resolver output target:

```json
{
  "data": {
    "resolver": {
      "target": "<fieldMap target>",
      "value": "<resolved value>"
    }
  }
}
```

No full row, unmapped source field, candidate list, raw container, row key,
sort value, discriminator value, or original runtime key may be returned.

## Evidence Plane

Evidence is values-free and may include only:

- `ok`;
- coarse error code;
- coarse error type;
- `candidateCount`;
- `matchedCount`;
- `containerLocated`;
- container shape `{ type, arrayLength }`;
- `rule`;
- booleans such as `capReached`, `ambiguous`, `resolved`.

These fields do not exist in the current S2-a evidence allowlist. R0 must extend
the canonical server evidence sanitizer and the S3-UI mirror before runtime can
be ratified. A runtime implementation must not rely on a producer-supplied
object that later gets silently clamped or coarsened into a generic failure.

Evidence MUST NOT include:

- runtime key;
- resolved value;
- candidate row values;
- fieldMap source/target names;
- sort/discriminator raw values;
- endpoint/readPath/host;
- credentials or tenant/system identifiers beyond existing coarse route status.

## Failure Semantics

Failures return `data: null` and values-free evidence.

Required coarse codes:

- `READ_SOURCE_RESOLVER_CONTAINER_NOT_FOUND`;
- `READ_SOURCE_RESOLVER_SHAPE_MISMATCH`;
- `READ_SOURCE_RESOLVER_NO_MATCH`;
- `READ_SOURCE_RESOLVER_AMBIGUOUS`;
- `READ_SOURCE_RESOLVER_CAP_REACHED`;
- `READ_SOURCE_RESOLVER_RULE_NOT_SUPPORTED`;
- `READ_SOURCE_RESOLVER_RULE_INVALID`;
- `READ_SOURCE_RESOLVER_FIELD_MISSING`;
- `READ_SOURCE_RESOLVER_FAILED`.

These codes are not in the current S2-a registered coarse-code set or the UI
client mirror. R0 must add them as exact registered values. Prefix matching is
not allowed; unknown resolver-looking codes must still degrade to the generic
safe fallback.

The runtime route may map contract failures to the existing
`READ_SOURCE_READ_CONTRACT_INVALID` only before outbound. Resolver-specific
post-read failures should use the resolver codes above so operators can
distinguish "no match" from "ambiguous".

## Composition Boundary

This design-lock enables resolver lookup as a standalone read mode only.

Chaining a resolver output into another configured read, for example
`material -> FBillNo -> BOM detail`, is a later design-lock because it adds:

- multi-config dependency ordering;
- typed handoff between data planes;
- partial failure semantics;
- evidence stitching without leaking intermediate values;
- retry/idempotency rules across more than one outbound read.

The first runtime slice MUST NOT compose resolver output into another call.

## Authorization

- Config-time save/probe/approve/retire remains integration write tier.
- Runtime resolver read remains integration read tier, but only for approved
  config versions.
- Draft/retired resolver configs return the existing not-approved failure.
- Runtime callers cannot activate probe or config mutation through the read
  route.

## Existing Configs And Probe Semantics

Existing `resolver_lookup` rows saved before R0 do not contain the new
`resolverRule` contract. They must remain non-runtime-consumable until a
consultant re-saves and re-approves them under the new schema. No migration may
auto-approve or silently reinterpret old rows.

The current S2-b probe can locate a resolver container as a shape exercise, but
it does not prove resolver selection semantics. R0/R1 must label this honestly:
shape/probe green is not resolver runtime PASS until the resolver rule evaluator
also passes.

## Demand Gate

Runtime work starts only for a named standalone resolver lookup demand. The
first approved demand must identify the configured source, one runtime input
key, the resolver output target, and the multiplicity rule. It must not require
resolver-to-BOM composition, recursive expansion, or write-back; those remain
separate gates.

## Acceptance Tests For Runtime Slice

The runtime PR that implements this lock must prove:

1. `resolver_lookup` no longer fails with `mode_not_supported` when the config
   declares a supported rule.
2. Missing rule fails closed.
3. `exactly_one` passes for one row and fails for zero/two rows.
4. `first_when_sorted` fails when sort field is absent or ambiguous.
5. `field_equals` fails when zero/multiple candidates match.
6. Candidate cap reached before uniqueness proof fails closed.
7. Scalar candidate entries fail as shape mismatch.
8. Evidence does not include runtime key, resolved value, row values, fieldMap
   names, host/readPath, credentials, or raw container paths.
9. Data contains only the configured resolver output target and value.
10. Runtime body allowlist remains `{ inputs }` only.
11. Draft/retired configs remain 409 not approved.
12. Wrong registered-system kind fails before adapter read.
13. Adapter write methods are never called.
14. Resolver output is not composed into any second read.

## Implementation Slices

R0 — contract and evidence surface extension:

- extend S1 allowlist and validation for `resolverRule`,
  `resolverSortDirection`, and `resolverDiscriminatorValue`;
- make `multiplicityRuleField` rule-specific rather than always required;
- extend S2-a server evidence allowlist and registered coarse-code set;
- extend the S3-UI evidence mirror and leak tests;
- prove old resolver rows without `resolverRule` remain fail-closed.

R1 — pure resolver evaluator:

- no route, no persistence, no adapter;
- takes normalized config + raw candidate container;
- returns `{ evidence, data }` with the rules above.

R2 — runtime executor integration:

- extends S3-1 executor to execute `resolver_lookup`;
- reuses existing outbound/probe builders;
- keeps standalone mode only, no composition.

R3 — route and UI evidence surface:

- route behavior remains approved-only/key-only;
- UI may display only values-free evidence and the authorized data target;
- no free-form resolver expressions.

Each slice requires separate opt-in.

## Non-Goals

- No recursive resolver chains.
- No material-to-BOM composition.
- No resolver output write-back.
- No delete/update/Save/Submit/Audit.
- No customer-authored JavaScript, SQL, JSONPath, regex, or expression engine.
- No terminal-user endpoint/body/filter override.
- No host-allowlist widening.
