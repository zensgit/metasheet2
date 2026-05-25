# K3 WISE Material Reference Mapping & Authoring Design - 2026-05-25

## Scope

- The convenient-authoring problem for K3 Material **reference fields** (units / unit-groups / accounts): today their normalization is hard-coded, so a new customer's basic-data codes require a code change.
- Builds directly on **PR #1817** (`e11bd84e`, reference payload shaping). #1817 made reference-object *passthrough* work; this design is the upstream **authoring layer** that **populates** those reference objects from staging.
- **Docs-only design.** No runtime, no contract, no migration here. Implementation is a later, separate staged opt-in.

## Background / problem

1. Reference normalization is currently hard-coded as an inline `dictMap` transform — e.g. `uom: { PCS: 'Pcs', EA: 'Pcs', KG: 'Kg' }` in `MATERIAL_FIELD_MAPPINGS` (`k3-wise-document-templates.cjs`). Changing the customer's basic-data codes means editing `.cjs` and shipping a package.
2. #1817 added: scalar reference value → single-key `{ FNumber: value }`, and **already-object values pass through unchanged**.
3. **GATE evidence (2026-05-25, `PASS_SAVE_AND_READBACK`):** the first positive Material Save against the live K3 WISE environment was achieved by **reading an existing Material detail, cloning it, changing only identity fields, and Saving while preserving its full reference objects** (66 reference objects in `{FName, FNumber}` / `{FID, FName}` shapes; Save `FStatus=true`; readback confirmed). **This proves what the deployment actually requires: full reference *objects*, not single-key wraps.** Owner's conclusion: it "validates the direction behind #1817 for reference-object **preservation**," and "the production workflow still needs a supported way to **generate/populate these reference objects from MetaSheet/Data Factory staging** rather than ad hoc direct clone scripting."
4. The F1/F2 from the #1817 review are now settled by evidence:
   - **F1 — CONFIRMED.** Single-key `{FNumber}` is **necessary but not sufficient**; the deployment needs `{FName, FNumber}` / `{FID, FName}` objects.
   - **F2** — #1817 fixes *shape/passthrough*, not *value population*: the correct reference object must arrive in the source record. The clone path sourced it from a K3 read (`Material/GetDetail`); productionizing that population is this document's job.
5. **Goal:** let users **populate full K3 reference objects** from staging **as data** (a maintainable table + relations), not as code — so the 2nd…Nth customer onboarding needs zero PR.

## Design

### Core thesis — object population is the critical path; multitable is the resolution layer

The proven requirement is **full reference-object population**, so that is the critical path — not the single-key wrap. Staging is already a multitable sheet, and multitable has `link` / `lookup` / `rollup` fields, so *resolution* can be expressed with existing multitable relations and **no new server-side resolver**:

```
③ 基础资料对照表 (multitable sheet, per reference domain) — one row = one full K3 reference object
   | sourceCode | k3FNumber | k3FName | k3FID | enabled | description |
        ▲ link
① 主数据表 (staging sheet) ── link → ③ ── surfaces the reference object for each ref field
        │
        └─ pipeline passthrough → #1817 ships the object to K3 intact ──▶ K3 Material/Save
```

Be precise about the two distinct "passthrough" claims:

- **K3-wire passthrough — PROVEN.** #1817 ships an already-formed reference object to K3 unchanged; `PASS_SAVE_AND_READBACK` preserved 66 such objects end-to-end.
- **Multitable-`lookup`-emits-a-structured-object — STILL UNPROVEN, now on the critical path.** A `lookup` field may surface only a display scalar/string, not a `{FName, FNumber}` JSON value. Object population *depends* on this, so it must be **smoke-proven** before the design commits to it. If a lookup cannot carry a structured object, the fallbacks are: (a) author the reference object directly in ① as a structured/JSON cell, or (b) an adapter round-2 that composes the object from the `sourceCode` row at Save time — that is runtime, **frozen** until a named unlock.

Single-key `{FNumber}` / `{FID}` (a scalar column wrapped by #1817 per `reference.identifier`) is retained only as the **degenerate case** for a field the customer confirms accepts it — it is no longer the headline path.

### ② Field-shape selector — persists to runtime config (NOT preview-only)

#1817's adapter reads each field's `reference.identifier` from `config.objects.material.schema` at Save time (`normalizeObjects` → `mergeK3WiseDocumentObject`). The shape selection **must persist into that same config**, not merely frontend preview state — otherwise the UI shows one shape while the real Save emits another (the preview-vs-wire drift flagged as N1 in the #1817 review). The selector is a frontend *widget* whose *effect* is on real Save behavior via config the runtime already consumes.

- **Persistence target / values:** `config.objects.material.schema[*]` — `reference.identifier` `FNumber`/`FID` for the degenerate single-key case, **or a per-field "object passthrough" mode** (the populated `{FName,FNumber}` / `{FID,FName}` object from ③ is shipped intact; not a scalar wrap). Per GATE evidence, object passthrough is the default for most reference fields.
- **Shallow-merge caveat:** `mergeK3WiseDocumentObject` does `{ ...template, ...configured }`, so a configured `schema` **replaces the whole default array**. The frontend must persist the **complete** schema (all fields + overrides), never a partial.
- **Single-source anti-drift:** the dry-run preview MUST read the same persisted config so UI / preview / real Save cannot diverge.
- **Open item (O4):** confirm the config-update API round-trips `config.objects.material.schema` (see Open questions).

### ③ 基础资料对照表 — user-created from a template (NOT auto-install)

- **NOW:** the frontend ships a **template / instructions**; the user **creates or copies** the mapping sheet(s) themselves (one per reference domain: unit, unit-group, account…).
- **Column contract** — **one row = one full K3 reference object** (pin it so implementations don't diverge; the UI-contract PR formalizes it):

  | column | type | required | meaning |
  |---|---|---|---|
  | `sourceCode` | string | yes | the source/our basic-data code (lookup key from ①) |
  | `k3FNumber` | string | cond. | K3 `FNumber` component of the reference object |
  | `k3FName` | string | cond. | K3 `FName` component — needed for `{FName, FNumber}` / `{FID, FName}` |
  | `k3FID` | string | cond. | K3 internal `FID` component — for `{FID, FName}` / `{FID}` |
  | `enabled` | boolean | yes (default true) | toggle a mapping row without deleting it |
  | `description` | string | no | human note (source meaning, owner, etc.) |

  Which components are populated depends on the field's required shape (`{FNumber}` / `{FName,FNumber}` / `{FID,FName}` / `{FID}`). **Rule:** at least one identifier (`k3FNumber` or `k3FID`) required; any `{FName, …}` shape additionally requires `k3FName`.
- **Deferred:** auto-installing ③ by extending `IntegrationStagingInstallResult` touches staging **runtime** → frozen under Stage 1. Auto-install (and GetList-populated dropdowns) is Post-GATE / a later PR.

### ⑤ Pre-Save completeness preview (client-side, bounded)

Before a run, the client lists "源值 *X* 无对照 / 缺组件" so the user fixes data instead of receiving K3's opaque `invalid unit-group parameter`.

- **Reads:** only the staging sheet's reference columns + the user's ③ mapping sheet.
- **Checks:** a sampled reference value is flagged if its ③ row is missing **or** lacks the components its field's shape requires (e.g. `{FName,FNumber}` field with empty `k3FName`).
- **Bounded:** a **sample-capped distinct scan** (reuse the PoC sample limit 1–3, or a stated distinct-value cap) — explicitly **not** a full large-table scan.
- **No new write surface:** pure client comparison over the existing read-only dry-run preview route.

### Authoring surfaces (the 5 tables)

| # | Surface | User writes | Status |
|---|---|---|---|
| ① | 主数据 staging sheet | material/BOM rows | exists |
| ② | field mapping + shape | source col → K3 field; per-ref shape (object passthrough / single-key) | mapping exists; shape selector = new frontend, persists to runtime config |
| ③ | 基础资料对照表 | source code ↔ full K3 reference object (`FNumber`/`FName`/`FID`) | **new (multitable template, user-created)** |
| ④ | connection / 账套 | base URL, auth, tenant scope | exists |
| ⑤ | pre-Save completeness preview | (read-only) unmapped / incomplete list | **new (client, bounded)** |

## Lock conformance (Stage 1)

- **NOW (buildable, lock-safe — frontend / multitable / docs):** ③ object-shaped table template + link/lookup wiring guidance **plus a smoke proving multitable lookup can carry a structured object**; ② shape selector that persists into `config.objects.material.schema` (config the shipped #1817 adapter already reads — no new Save logic); ⑤ bounded client-side preview.
- **FROZEN:** server-side composition / `refMap` in the pipeline runner; **adapter round-2 two-field synthesis (runtime)**; auto-install of ③; new K3 objects beyond material/bom; Save/Submit/Audit/expansion.
- **POST-GATE:** K3 `GetList`/`GetTemplate` auto-populating ③'s components as picked dropdowns (read/list deferred) — turns ③ from hand-filled to selected. Final, most convenient form.

## Relationship to the live GATE (#1792)

The GATE has reached **`PASS_SAVE_AND_READBACK`** (positive Material Save + readback proven 2026-05-25) — but via ad hoc clone scripting that depends on a K3 read. This design **productionizes the owner's stated gap**: populate reference objects from staging instead of cloning. It does not by itself unblock expansion.

**Adjacent owner-gating items — tracked on separate tracks, NOT in this PR:**
- **Rollback procedure** for a wrong K3 save — the owner named "mapping path **AND** rollback" as the expansion gate.
- **K3 READ runtime** (`Material/GetDetail` / read/list, #1593 contract front-loaded) — the clone method's dependency and likely the cleanest *source* of valid reference objects; the save+readback PASS may be the trigger to reopen that discussion.

## Open questions

- **O1** — ③ creation resolved to *user-from-template* for NOW. Ship as an in-app "create from template" action vs a documented manual recipe?
- **O2** — Can a multitable `lookup` emit a structured object end-to-end? Smoke first. If not: ①-authored structured cell vs a frozen adapter round-2.
- **O3** — Per-field shape defaults: object (`{FName,FNumber}`/`{FID,FName}`) is the GATE-evidenced default; single-key only where the customer confirms it is accepted (`FUnitGroupID` shape still slightly uncertain for from-scratch save).
- **O4** — Does the config-update API persist `config.objects.material.schema`? Gates whether ② is pure-frontend, so the next PR's **first step is a contract probe/test**: save a config carrying `objects.material.schema`, reload, assert the schema (and per-field shape) survives round-trip. If it drops, ② needs a (small, lock-assessed) backend config-validation widening first.

## Boundary / non-goals

- No runtime, contract, or migration change in this document; nothing is implemented.
- No new K3 object; BOM reference (`FUnitID`) follows the same pattern later, out of scope here.
- Rollback procedure and K3 READ runtime are separate owner-gating tracks, not in scope here.
- Recommended next link (separate opt-in): a **docs-only + UI-contract PR** that (1) **starts with the O4 config round-trip probe/test**, (2) **smoke-proves the multitable lookup→object mechanism**, then defines ③'s object-shaped column contract, the ② persistence location, and ⑤'s acceptance criteria — **not** the full feature. Server-side resolution stays frozen until a named unlock or GATE PASS.

## See also

- PR #1817 — K3 Material reference payload shaping (`e11bd84e`); review notes (F1/F2/N1) and the K3-wire passthrough this design relies on.
- Issue #1792 — Customer GATE; `PASS_SAVE_AND_READBACK` (2026-05-25) is the evidence that object population, not single-key wrap, is the required path.
- `docs/development/integration-k3wise-staging-field-detail-contract-design-20260429.md` — staging field model this builds on.
- `docs/development/integration-core-k3wise-webapi-read-list-gate-contract-design-20260515.md` — the read/list contract (#1593) whose delivery would source reference objects and enable ③'s auto-populated dropdowns.
