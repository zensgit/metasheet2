# K3 WISE Reference Mapping — UI Contract Verification - 2026-05-25

## Scope

Verifies the **contract** in `integration-k3wise-reference-mapping-ui-contract-design-20260525.md`. This is a docs-only contract; **no implementation exists yet**, so this document confirms lock conformance and records the **acceptance matrix** the step-2 frontend impl must satisfy. Behavioral verification of the impl is the step-2 PR's own verification doc.

## Lock conformance

- **Files:** 2 docs under `docs/development/`. No runtime, no contract-code, no migration, no `plugins/`, no `apps/` source.
- **Banned-term note:** the terms `Save` / `Submit` / `Audit` / `BOM` / `read/list` / `plugin-integration-core` appear **only as boundary / deferred / scope-exclusion statements**, never as changes. Actual changes to any of those surfaces: **0**.
- **Stage 1 Lock:** unchanged. This contract enables a future frontend + client-side preview only; the frozen surfaces (server/pipeline composition, read/list runtime, Save expansion) are explicitly kept frozen by C3 and the Boundary section.

## Acceptance matrix (what the step-2 frontend impl MUST satisfy)

| # | Requirement | Source |
|---|---|---|
| A1 | ③ uses **multi-column components** (`sourceCode`/`k3FNumber`/`k3FName`/`k3FID`/`enabled`/`description`); **no** "single lookup → object" UI | C1 / #1824 |
| A2 | Lookup consumers treat the value as an **array**; **empty ⇒ unresolved**; `[0]` only after non-empty assertion; never assume 1 link ⇒ 1 entry | C2 / #1824 |
| A3 | Composition runs **client-side preview only**; consumer **declares** its composition home; **no** server/pipeline composition; productionized Save composition deferred to step 3 | C3 |
| A4 | ② persists the **complete** `config.objects.material.schema` array; treats the null-proto public projection as JSON (no prototype/`instanceof` reliance) | C4 / #1824 O4 |
| A5 | Preview lists **unresolved** (no ③ row / missing required component / empty array); the Save guard is **client-side UX only**, not a hard server gate | C5 |
| A6 | **No** K3 write, **no** Submit/Audit/BOM, **no** read/list runtime, **no** new K3 object | Boundary |
| A7 | Preview uses a **bounded sample scan** (sample cap), not a full-table scan | C5 |

## Evidence references

- **#1824 O4 test** — `external-systems.test.cjs §7e` (merge `996bf3c73`): `config.objects.material.schema` (incl. per-field `reference.identifier`) round-trips upsert→store→get; sanitize active but spares the schema.
- **#1824 lookup analysis** — `packages/core-backend/src/routes/univer-meta.ts:1636-1674` (`resolveLookupValues`): array of one target field's value, null/undefined + unreadable skipped.
- **#1792 `PASS_SAVE_AND_READBACK`** — full reference objects required (clone-preservation).
- **#1821** — authoring design (surfaces ①–⑤).

## Boundary

- Verifies contract **intent and lock conformance** only; no behavior exists to test yet.
- The step-2 frontend PR's verification doc will cover impl conformance against A1–A7.
- Rollback procedure and read/list runtime are separate tracks, out of scope here.
