# K3 WISE Material Reference Shape-Selector Persistence (A4) — Design - 2026-05-25

## Scope

- **A4** from the #1826 UI contract: a per-Material-reference-field **Save shape selector** that persists into `config.objects.material.schema`. Frontend impl + tests + this MD.
- **No** integration-core runtime change, K3 write, Submit/Audit/BOM, read/list, or server gate.
- Two-step (user-mandated): **(1) route-fidelity probe FIRST; (2) frontend selector only if the route preserves the schema.**

## Step 1 — route-fidelity probe (RESULT: PASS)

**Concern:** does the real HTTP upsert route preserve `config.objects.material.schema[*].reference.identifier`, or strip it via route / requestBody / sanitizer / validator? (#1824's O4 covered only the *registry* layer.)

**Finding (code):** `externalSystemsUpsert` → `externalSystems.upsertExternalSystem(scopedInput(req, requestBody(req)))`; `requestBody` returns raw `req.body`; `scopedInput` does `{ ...input, tenantId, workspaceId }` (spread — no field pick/strip); no plugin-level body schema. `config.objects` is already an established persisted shape (the staging adapters read `config.objects`).

**Proof:** `http-routes.test.cjs` → `testExternalSystemUpsertPreservesObjectSchema` (isolated harness) asserts the route forwards `config.objects.material.schema` (incl. each field's `reference.identifier`) **verbatim** to the store AND in the response. PASS ⇒ route is faithful ⇒ **pure-frontend** (no backend widening needed).

## Step 2 — frontend shape selector

- `K3WiseReferenceShape = 'FNumber' | 'FID' | 'object'`.
- Form: `materialReferenceShapes: Record<string, K3WiseReferenceShape>` (default: every material reference field → `'FNumber'`).
- `buildK3WiseMaterialReferenceSchema(shapeByField)`: returns the **COMPLETE** material schema array (all fields; non-reference fields preserved unchanged), each reference field's `reference` set per shape — `FNumber`/`FID` → `{ identifier }`; `'object'` → `{ identifier: 'FNumber', passthrough: true }` (scalar-fallback identifier + declared object intent).
- `buildK3WiseSetupPayloads`: writes `config.objects.material.schema = buildK3WiseMaterialReferenceSchema(form.materialReferenceShapes)` — the **whole** array (the config merge replaces the schema array, so a partial would drop sibling fields — contract **C4**).
- View: a selector section over `materialReferenceFields`; each is a `<select>` (`{FNumber}` / `{FID}` / object-passthrough) wired via `:value` + a typed `@change` setter that narrows the value to the union before assigning (avoids the v-model `string`→union friction and validates the input).
- **Restore-on-load (persistence closure):** `applyExternalSystemToForm` calls `parseMaterialReferenceShapesFromSchema(material.schema)` — restoring each field's shape (`passthrough → object`, `identifier 'FID' → FID`, else `FNumber`) **merged over the defaults** (every reference field stays present; fields absent from the saved schema remain `FNumber`). Without this, a reload + re-save would silently downgrade earlier choices to `FNumber`. `createDefaultK3WiseSetupForm` and the restore both use the shared `defaultMaterialReferenceShapes()`.

## Note on `object` passthrough

`'object'` records the operator's **intent** that the field will carry a full reference object. The shipped #1817 adapter already passes object values through regardless of identifier, so the `passthrough` flag changes **no** adapter behavior today — it is forward-intent that the downstream composition / S3 work will consume. A4 does **not** itself produce two-field `{FName,FNumber}`/`{FID,FName}` objects.

## Lock / boundary

- Frontend + **one** integration-core **test** (the route probe) + docs. **No** integration-core runtime change; no K3 write / Submit/Audit/BOM / read/list; no server gate.

## See also
- #1826 — UI contract (A4 / C4); #1824 — O4 registry round-trip + lookup analysis; #1828 — S2 preview; #1817 — adapter reads `reference.identifier`.
