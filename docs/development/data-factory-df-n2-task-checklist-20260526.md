# Data Factory DF-N2 (Provenance) — task-level checklist (gated) - 2026-05-26

> **图例:** 🔒 blocked-by-gate · ⬜ ready-when-unlocked · ✅ done
> **Gated:** the whole chain touches `plugin-integration-core` → blocked behind **Gate 0** (K3 PoC GATE PASS + 阶段二 unlock) + a **separate per-PR opt-in**. Not passed today.
> **Scope:** task/sub-PR-level expansion of the **DF-N2** row in `data-factory-stage2-execution-plan-20260526.md` (and its TODO). **Execution-planning only — NOT new design, NOT a build authorization.** ProvenanceEvent is already designed in #1839; this only breaks the phase into tasks. Preference (#1874): **JSONB on existing tables + a by-`rowId` view, NOT a new event table.**

DF-N2 is the **recommended first move** on unlock day (lowest risk, zero new connector behavior, deepens the "对接成功/失败记录" goal to per-record-across-runs lineage).

## DF-N2-1 — contracts 〔lane: contracts〕
- [ ] 🔒 Define `ProvenanceEvent` TS type `{ runId, rowId, eventType, at, attrs }` (attrs = safe fields / presence flags only)
- [ ] 🔒 11 event-type enum: `source_read` / `row_imported` / `row_edited` / `mapping_applied` / `validation_failed` / `dry_run_previewed` / `target_write_attempted` / `target_write_succeeded` / `target_write_failed` / `row_retried` / `row_exported`
- [ ] 🔒 Redaction contract: allow presence flags + safe ids; forbid token / password / connection-string / customer secret
- [ ] 🔒 OpenAPI component: `ProvenanceEvent` + the by-`rowId` query response schema
- [ ] 🔒 Tests: OpenAPI↔TS parity · invalid `eventType` rejected · redaction unit (attrs carrying a token → stripped)
- ▸ Exit: contract frozen, zero runtime change

## DF-N2-2 — runtime + migration 〔lane: runtime〕
- [ ] 🔒 Pick storage: a JSONB lineage column on the existing DB table `integration_runs`, events tagged by `rowId` — **no new write-path table**; `integration_run_log` / `integration_exceptions` are staging multitable objects, not the DB storage anchor
- [ ] 🔒 Plugin SQL migration (integration-core's own SQL, guarded by `migration-sql.test.cjs`): add the JSONB column + an `integration_provenance_by_row` **view** (unnest across `integration_runs`; optional context may join real DB tables such as `integration_dead_letters`, not staging object names)
- [ ] 🔒 Wire `lib/pipeline-runner.cjs` to append a **redacted** event at each lifecycle point (normalize through `provenance-contracts.cjs`; prove the shared scrubber removes secret-shaped values before persistence)
- [ ] 🔒 Capacity guard: per-run/per-row event count / size cap while writing the current run (mirror the `targetWriteSummaries` cap-50 discipline; do not prune old run JSONB by scanning every historical `rowId`)
- [ ] 🔒 Retention/aging: run-level retention window (`integration_runs.created_at` / `finished_at`, <= N days or <= M newest runs per pipeline) + bounded read-window parameters on the by-`rowId` route
- [ ] 🔒 Back-compat: existing runs have no events → the view tolerates empty/null
- [ ] 🔒 Tests: redaction (stored events carry no sensitive field) · correct event appended per step · **by-`rowId` cross-run timeline** (seed 2 runs for the same rowId, assert ordered) · **real-wire round-trip** (the lineage field survives real API serialization — wire-vs-fixture guard) · `migration-sql.test.cjs` green · replay does not wrongly duplicate events
- ▸ Exit: per-record events queryable across runs, redacted
- ▸ **Design (sub-split 2a storage / 2b runtime-write / 2c read-route + retention/aging + redaction pre-storage gate):** `data-factory-df-n2-2-provenance-runtime-design-20260528.md` — each sub-PR a separate opt-in.

## DF-N2-3 — frontend 〔lane: frontend〕
- [ ] 🔒 `apps/web/src/services/integration/workbench.ts`: read-only types + by-`rowId` provenance read (client over the new GET route)
- [ ] 🔒 `IntegrationWorkbenchView`: per-row **lineage timeline** expandable (reuse the DF-N1 expand pattern + stable `data-testid`)
- [ ] 🔒 Render the event timeline (eventType + timestamp + safe summary), read-only, no secret
- [ ] 🔒 Tests: timeline renders · **no replay / no write affordance** (read-only lock, mirrors DF-N1) · no secret shown · empty state (row with no lineage)
- ▸ Exit: per-row end-to-end history visible read-only in 运行监控

## Chain discipline (DF-N2 as a 3-lane mini-chain)
- [ ] 🔒 Order: N2-1 contracts → N2-2 runtime (depends on the contract) → N2-3 frontend (depends on the read route); **each a separate opt-in**
- [ ] 🔒 New GET by-`rowId` route: OpenAPI parity + RBAC read permission
- [ ] 🔒 Whole chain touches integration-core → stays behind **Gate 0** (K3 unlock)

## See also
- `data-factory-stage2-execution-plan-20260526.md` (this expands its DF-N2 row) · `data-factory-stage2-todo-20260526.md`.
- #1839 (ProvenanceEvent design + DF-N0..N4 phasing) · #1838 + addendum #1874 (JSONB-on-existing-tables preference) · #1848 (DF-N1 read-only monitoring this builds on) · #1857 (DF-N1.5 replay).
