# Data Factory DF-N2-2 — provenance runtime (design, 2026-05-28)

**Docs-only.** Execution design for the **runtime** slice of DF-N2 (per-record provenance), splitting
it into three gated sub-PRs — **DF-N2-2a / 2b / 2c** — instead of one large runtime change. **Not a
build authorization:** each sub-PR is a separate explicit opt-in behind the 阶段二 unlock.

## Basis (build on — do NOT redesign)

- **#1839** `data-factory-nifi-inspired-run-provenance-design` — the `ProvenanceEvent` model + DF-N0..N4
  phasing; the **11 event types** are fixed there (`source_read` / `row_imported` / `row_edited` /
  `mapping_applied` / `validation_failed` / `dry_run_previewed` / `target_write_attempted` /
  `target_write_succeeded` / `target_write_failed` / `row_retried` / `row_exported`).
- **#1882** (merged) — `plugins/plugin-integration-core/lib/provenance-contracts.cjs` (enum-strict
  normalizer + OpenAPI parity) is the **runtime's contract source**: DF-N2-2 validates/normalizes
  through it and adds **no new event shape**.
- **#1877** `data-factory-stage2-execution-plan` — DF-N2 is the first unlock-day move; this expands its
  DF-N2-2 row.
- **#1880** NiFi bounded benchmark — validated **JSONB-on-existing-tables** (NiFi's repo machinery is
  over-engineering at our scale); the one capability NiFi has that we lack is a **retention/aging
  policy** (designed below); `dry_run` + `validation_failed` provenance is our moat.
- **`data-factory-df-n2-task-checklist-20260526.md`** — the task-level checklist; this design
  sub-splits its **DF-N2-2 (runtime)** row into 2a/2b/2c and adds retention/aging + the redaction
  pre-storage gate.

## Storage decision (locked)

**JSONB on existing tables + a by-`rowId` view — NO new event table** (#1874). A JSONB lineage column
on the existing run / `integration_run_log` surface, events tagged by `rowId`; an
`integration_provenance_by_row` view unnests across runs (joining `integration_dead_letters` /
`integration_exceptions`). No new write-path table.

## Redaction — a pre-storage HARD GATE (not optional)

Provenance is **persisted and queryable**, so any secret leak is **durable**. Every event field is
value-scrubbed via `scrubSecretStringValue` **before** it is written — presence flags + safe ids only;
never token / password / connection-string / customer secret / raw error text. This **reuses the same
`scrubSecretStringValue` that the in-flight `fix/df-run-provenance-hardening` is strengthening** (it
value-scrubs dead-letter `errorMessage`); **DF-N2-2b should land after that hardening** so persisted
provenance gets the strengthened scrub, and must not re-implement it. A stored-event redaction test (a
token planted in `attrs` → stripped) is a 2b exit gate.

## Retention / aging (the #1880 gap — REQUIRED here)

NiFi has a provenance retention/aging policy we currently lack; unbounded per-row events + cross-run
accumulation would bloat the JSONB surface. DF-N2-2 must define:
- **Per-row cap** (already in the checklist): a per-row event count / size cap, mirroring the
  `targetWriteSummaries` cap-50 discipline (count-capped with an overflow marker; oldest events trimmed).
- **Aging** (new): a documented retention window (default: keep ≤ N days / ≤ M runs per `rowId`) and a
  prune path. The **prune job itself is out of DF-N2-2 scope**, but the JSONB shape + the window knob
  MUST be designed now so aging is possible later **without a further migration**.

## Sub-split (each a SEPARATE gated opt-in)

- **DF-N2-2a — storage / migration** (schema only, no behavior): the JSONB lineage column + the
  `integration_provenance_by_row` view, via integration-core's own SQL migration (guarded by
  `migration-sql.test.cjs`); back-compat (existing runs → null/empty; the view tolerates it). *Exit:
  migration green, zero runtime behavior change.*
- **DF-N2-2b — runtime write** (the redaction gate lives here): wire `pipeline-runner.cjs` to append a
  **redacted** `ProvenanceEvent` (validated through `provenance-contracts.cjs`) at each lifecycle
  point; per-row capacity guard; redaction hard gate (reuses the hardened `scrubSecretStringValue`).
  *Exit: per-step events appended, redacted, capped; replay does not duplicate events.*
- **DF-N2-2c — read surface**: a by-`rowId` GET route with **OpenAPI parity + RBAC read permission**,
  returning the cross-run timeline; a **wire-vs-fixture route test** (the lineage field survives the
  real route serialization). *Exit: per-row cross-run lineage queryable, read-only.* (Frontend timeline
  is DF-N2-3, separate.)

## Acceptance (impl-time, per sub-PR)

- **2a:** `migration-sql.test.cjs` green; the view tolerates empty/null.
- **2b:** stored-event redaction test (no secret stored); per-step append test; replay-no-duplicate;
  per-row capacity-cap test.
- **2c:** by-`rowId` cross-run timeline test (seed 2 runs for the same `rowId` → ordered); RBAC
  read-permission test; **wire-vs-fixture round-trip** (lineage survives the real route — the
  reachability discipline reinforced by #1970).

## Boundaries

Docs-only design; **no** runtime / migration / route code here. Each of 2a / 2b / 2c is a **separate
explicit opt-in** behind the 阶段二 unlock, in order (2a → 2b → 2c; 2b depends on 2a's column, 2c on
2b's events). No K3 write, no connector behavior, no new event shape (uses #1882's contract). **2b is
gated on the in-flight redaction value-scrub (`fix/df-run-provenance-hardening`) landing first.**
DF-N2-3 (frontend lineage timeline) stays a separate slice after 2c.
