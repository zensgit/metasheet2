# K3 WISE Material Reference Shape-Selector Persistence (A4) — Verification - 2026-05-25

## Scope

Verifies the A4 implementation against contract **A4** and the user-mandated two-step gate.

## Step 1 — route-fidelity gate (PASS)

- `testExternalSystemUpsertPreservesObjectSchema` (`plugins/plugin-integration-core/__tests__/http-routes.test.cjs`, isolated harness): the HTTP upsert route forwards `config.objects.material.schema[*].reference.identifier` **verbatim** to the store call AND in the response. **PASS** ⇒ the route does not strip the schema ⇒ A4 stays **pure-frontend** (no backend widening). Had it stripped, the procedure was to STOP and report (front+back contract change) — not triggered.

## Contract mapping (A# / C# → artifact + evidence)

| Item | Artifact / evidence | Status |
|---|---|---|
| **A4** ② persists complete `config.objects.material.schema` | `buildK3WiseMaterialReferenceSchema` (complete array) + `buildK3WiseSetupPayloads` injects it under `config.objects.material.schema`; test asserts complete array + per-field `reference.identifier` | ✅ |
| **C4** complete-schema (shallow-merge replaces whole array) | helper returns the WHOLE material schema (non-reference fields preserved); payload writes it whole; test asserts `schema.length === material template schema length` | ✅ |
| null-proto / JSON safety | schema is plain objects; test `JSON.parse(JSON.stringify(full)).toEqual(full)` | ✅ |
| selector options `{FNumber}` / `{FID}` / object-passthrough | `<select>` over `materialReferenceFields` via `:value` + typed `@change` setter; `'object'` → `{identifier:'FNumber', passthrough:true}` | ✅ |
| **persistence CLOSURE** — reload restores shapes (no silent downgrade) | `applyExternalSystemToForm` calls `parseMaterialReferenceShapesFromSchema(material.schema)`, merged over defaults; round-trip test: saved `{FAcctID:{identifier:FID}}` + `{FBaseUnitID:{identifier:FNumber,passthrough:true}}` → form shapes restored (`FID`/`object`), absent field stays `FNumber`, and re-save re-emits the COMPLETE schema unchanged | ✅ |

## Local verification

- `pnpm --dir plugins/plugin-integration-core test:http-routes` (incl. the route-fidelity probe) → **PASS**.
- `vitest run tests/k3WiseSetup.spec.ts` → **63 passed** (55 prior + 8 new: `buildK3WiseMaterialReferenceSchema` / payload persistence / **reload-restore closure** / garbage-safe parse).
- `vue-tsc --noEmit` → **exit 0, 0 errors**.
- Secret-shape sweep on added lines: clean.

## Boundary

- Frontend + **one** integration-core test (route probe) + docs. **No** integration-core runtime change, K3 write, Submit/Audit/BOM, read/list runtime, or server gate.
- `'object'` is declared intent only; it does **not** itself produce two-field reference objects (composition / S3 still required).

## See also
- design: `integration-k3wise-shape-selector-persistence-design-20260525.md`
- #1826 (contract), #1824 (O4), #1828 (S2 preview).
