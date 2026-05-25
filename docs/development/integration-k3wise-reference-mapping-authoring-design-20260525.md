# K3 WISE Material Reference Mapping & Authoring Design - 2026-05-25

## Scope

- The convenient-authoring problem for K3 Material **reference fields** (units / unit-groups / accounts): today their normalization is hard-coded, so a new customer's basic-data codes require a code change.
- Builds directly on **PR #1817** (`e11bd84e`, reference payload shaping). #1817 made the *shape* correct; this design is the upstream **authoring layer** that feeds correct *values* into #1817's wrap/passthrough.
- **Docs-only design.** No runtime, no contract, no migration here. Implementation is a later, separate staged opt-in.

## Background / problem

1. Reference normalization is currently hard-coded as an inline `dictMap` transform — e.g. `uom: { PCS: 'Pcs', EA: 'Pcs', KG: 'Kg' }` in `MATERIAL_FIELD_MAPPINGS` (`k3-wise-document-templates.cjs`). Changing the customer's basic-data codes means editing `.cjs` and shipping a package.
2. #1817 added: scalar reference value → single-key `{ FNumber: value }`, and already-object values pass through unchanged. Two gaps remain (the F1/F2 from the #1817 review):
   - **F1** — only single-key `{FNumber}`, hard-coded on every Material reference field; cannot synthesize `{FID, FName}` / `{FName, FNumber}` from a scalar.
   - **F2** — fixes *shape*, not *value-resolution*: it wraps but does not map a source internal id into the K3 code/object. A positive Save still depends on the source record carrying the correct K3 reference identifier.
3. **Goal:** let users author the source→K3 reference correspondence **as data** (a maintainable table), not as code — so the 2nd…Nth customer onboarding needs zero PR.

## Design

### Core thesis — multitable *is* the reference-resolution layer

The integration's staging source is already a multitable sheet (`IntegrationStagingInstallResult` creates sheets with `sheetIds`/`viewIds`/`openLinks`). Multitable already has `link`, `lookup`, and `rollup` field types. So reference resolution needs **no new server-side resolver** — it is expressed with existing multitable relations:

```
③ 基础资料对照表 (multitable sheet, per reference domain)
   | sourceCode | k3FNumber | k3FID | enabled | description |
        ▲ link
① 主数据表 (staging sheet) ── link field → ③ ── lookup field surfaces the K3 identifier (scalar)
        │
        └─ pipeline fieldMappings (passthrough) → #1817 wraps the scalar with the configured identifier ──▶ K3 Material/Save
```

**NOW guarantee (proven path): single-key only.** The staging column holds a **scalar** K3 identifier (FNumber or FID, surfaced via lookup), the pipeline passes it through, and #1817 wraps it as `{ <identifier>: value }` per the field's configured `reference.identifier` (see ②). This works with mechanisms already shipped.

**Unproven (must smoke before promising): object / two-field passthrough.** Emitting a composed object (`{FNumber, FName}` / `{FID, FName}`) from a multitable **lookup** column is *not yet confirmed* — lookup fields may surface only a display scalar/string, not a structured object. Until a frontend+runtime smoke proves a lookup can carry a JSON object end-to-end (staging → pipeline → #1817 passthrough → K3), the two-field shape is **deferred** to either that smoke or an adapter round-2 (two-field synthesis). Do **not** design on the assumption that lookup emits objects.

### ② Field-shape selector — persists to runtime config (NOT preview-only)

#1817's adapter reads each field's `reference.identifier` from `config.objects.material.schema` at Save time (`normalizeObjects` → `mergeK3WiseDocumentObject`). Therefore the shape selection **must persist into that same config**, not merely into frontend preview state — otherwise the UI shows `{FID}` while the real Save still emits `{FNumber}` (the exact preview-vs-wire drift flagged as N1 in the #1817 review). The selector is a frontend *widget*, but its *effect* is on real Save behavior via config the runtime already consumes — which is the point.

- **Persistence target:** the external system's `config.objects.material.schema[*].reference.identifier`, values `FNumber` (default) / `FID` / (future) two-field.
- **Shallow-merge caveat:** `mergeK3WiseDocumentObject` does `{ ...template, ...configured }`, so a configured `schema` **replaces the whole default array**. The frontend must persist the **complete** schema (all fields + the per-field overrides), never a partial — a partial would silently drop the other reference fields.
- **Single-source anti-drift:** the dry-run preview MUST read the same persisted config so UI / preview / real Save cannot diverge.
- **Open item for the contract PR:** confirm the existing external-system config-update API already round-trips `config.objects.material.schema`. If it must widen its accepted/validated config to carry schema overrides, that widening is a small backend change to assess against the Stage 1 Lock (config-validation, not new Save logic).

### ③ 基础资料对照表 — user-created from a template (NOT auto-install)

- **NOW:** the frontend ships a **template / instructions**; the user **creates or copies** the mapping sheet(s) themselves (one per reference domain: unit, unit-group, account…).
- **Column contract** (pin it here so implementations don't diverge; the UI-contract PR formalizes it):

  | column | type | required | meaning |
  |---|---|---|---|
  | `sourceCode` | string | yes | the source/our basic-data code (lookup key from ①) |
  | `k3FNumber` | string | yes* | K3 reference FNumber (the usual `{FNumber}` value) |
  | `k3FID` | string | no | K3 internal FID, only for fields configured to `{FID}` |
  | `enabled` | boolean | yes (default true) | toggle a mapping row without deleting it |
  | `description` | string | no | human note (source meaning, owner, etc.) |

  *`k3FNumber` required unless the field's shape is `{FID}`, in which case `k3FID` is required.
- **Deferred:** auto-installing ③ by extending `IntegrationStagingInstallResult` touches staging **runtime** → frozen under Stage 1. Auto-install (and GetList-populated dropdowns) is Post-GATE / a later PR.

### ⑤ Pre-Save completeness preview (client-side, bounded)

Before a run, the client lists "源值 *X* 无对照" so the user fixes data instead of receiving K3's opaque `invalid unit-group parameter`.

- **Reads:** only the staging sheet's reference columns + the user's ③ mapping sheet.
- **Bounded:** a **sample-capped distinct scan** (reuse the PoC sample limit 1–3, or a stated distinct-value cap) — explicitly **not** a full large-table scan. Acceptance: given a sampled row whose reference value is absent from ③, the preview flags it; given full coverage, it reports ready.
- **No new write surface:** pure client comparison over the existing read-only dry-run preview route.

### Authoring surfaces (the 5 tables)

| # | Surface | User writes | Status |
|---|---|---|---|
| ① | 主数据 staging sheet | material/BOM rows | exists |
| ② | field mapping + shape | source col → K3 field; per-ref `reference.identifier` | mapping exists; shape selector = new frontend, persists to runtime config |
| ③ | 基础资料对照表 | source code ↔ K3 FNumber/FID | **new (multitable template, user-created)** |
| ④ | connection / 账套 | base URL, auth, tenant scope | exists |
| ⑤ | pre-Save completeness preview | (read-only) unmapped-value list | **new (client, bounded)** |

## Lock conformance (Stage 1)

- **NOW (buildable, lock-safe — frontend / multitable / docs):** ③ table template + link/lookup wiring guidance; ② shape selector that persists into `config.objects.material.schema` (config data the shipped #1817 adapter already reads — no new Save logic); ⑤ bounded client-side preview. None add `plugin-integration-core` Save/transform logic.
- **FROZEN:** server-side table-backed transform (e.g. a `refMap` primitive) in the pipeline runner; auto-install of ③ via the staging installer; object/two-field lookup passthrough until smoke-proven; new K3 objects beyond material/bom; Save/Submit/Audit/expansion.
- **POST-GATE:** K3 `GetList`/`GetTemplate` auto-populating ③'s K3 identifier as picked dropdowns (read/list deferred until GATE) — turns ③ from hand-filled to selected. Final, most convenient form.

## Relationship to the live GATE (#1792)

This does **not** block the pending positive Material Save retest. That retest still feeds codes/objects manually (probe-style). This design is the *convenience layer* that makes the next customer onboarding code-free — sequenced **after** the GATE proves the shape, not before.

## Open questions

- **O1** — ③ creation resolved to *user-from-template* for NOW (auto-install deferred). Remaining: ship the template as an in-app "create from template" action vs a documented manual recipe?
- **O2** — Object-shaped references: prove lookup→object via smoke (route a) or commit to an adapter round-2 two-field synth (route b)? NOW promises neither.
- **O3** — Per-field shape defaults: start all `{FNumber}`, override only on customer evidence (ties to #1817 F1).
- **O4** — Does the config-update API already persist `config.objects.material.schema`? This gates whether ② is pure-frontend, so the next PR's **first step is a contract probe/test**: save an external system config carrying `objects.material.schema`, reload, assert the schema (and per-field `reference.identifier`) survives round-trip with no drop. If it drops, ② needs a (small, lock-assessed) backend config-validation widening before any UI work.

## Boundary / non-goals

- No runtime, contract, or migration change in this document; nothing is implemented.
- No new K3 object; BOM reference (`FUnitID`) follows the same pattern later, out of scope here.
- Recommended next link (separate opt-in): a **docs-only + UI-contract PR** that (1) **starts with the O4 config round-trip probe/test** (decides pure-frontend vs needs backend widening), then defines ③'s column contract, the ② shape-selector persistence location, and ⑤'s acceptance criteria — **not** the full feature. Server-side resolution stays frozen until a named unlock or GATE PASS.

## See also

- PR #1817 — K3 Material reference payload shaping (`e11bd84e`); review notes (F1/F2/N1) the persistence-drift point derives from.
- Issue #1792 — Customer GATE: K3 WISE live PoC intake and dry-run signoff.
- `docs/development/integration-k3wise-staging-field-detail-contract-design-20260429.md` — staging field model this builds on.
- `docs/development/integration-core-k3wise-webapi-read-list-gate-contract-design-20260515.md` — the read/list contract whose post-GATE delivery enables ③'s auto-populated dropdowns.
