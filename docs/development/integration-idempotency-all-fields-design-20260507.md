# Integration Idempotency All Fields Design

## Context

The pipeline runner computes target idempotency keys from
`pipeline.idempotencyKeyFields`. That key decides whether a target adapter write
is a duplicate and, in K3 WISE flows, protects ERP writes from repeated pipeline
runs.

Before this change, `computeRecordIdempotencyKey()` only used the first two
fields:

- field 0 as `sourceId`
- field 1 as `revision`

Any third or later field was silently ignored. For a common ERP/PLM key such as
`materialCode + revision + organization`, two records with the same material
code and revision but different organizations could collapse to the same
idempotency key.

## Change

Keep the existing key shape for one-field and two-field pipelines, so current
pipelines are not re-keyed.

For pipelines with three or more `idempotencyKeyFields`, include every field
after the first two under a stable `dimensions` object before hashing:

```json
{
  "sourceId": "MAT-001",
  "revision": "A",
  "dimensions": {
    "organization": "100",
    "locale": "zh-CN"
  }
}
```

The existing `stableStringify()` hashing path sorts object keys, so the emitted
hash is deterministic.

## Validation

Additional dimensions are treated as required key material. If a configured
third-or-later field is missing or blank, `computeIdempotencyKey` throws a field
specific error such as:

```text
computeIdempotencyKey: dimensions.organization is required
```

The runner already catches idempotency failures per record and writes the record
to dead letter with `IDEMPOTENCY_FAILED`, so this does not crash the whole run.

## Scope

This does not change the K3 WISE adapter, PLM wrapper, REST routes, or staging
schema. It only fixes how the runner turns configured key fields into stable
dedupe keys.

Customer GATE is still required before a live customer PoC. This change makes
the internal pipeline safer for customers whose material uniqueness depends on
more than `code + revision`.
