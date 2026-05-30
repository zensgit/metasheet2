# DF-T3b dual-binding picker — sheet binding + sourceCode-column binding — development verification (2026-05-30)

> The **binding half** that completes operator-facing from_reference_table (owner sequence: 2d authoring
> → this picker). Binds **both** halves the resolver needs, owner-locked so it can't ship sheet-only:
> **(1)** `referenceMappingSources` (domain → staging system/object — which sheet each domain reads) via a
> structured picker that **replaces the #2080 JSON textarea**; **(2)** `rule.sourceField` (the sourceCode
> **column** the resolver looks up) authored per from_reference_table rule. **Frontend-only, read-only.**

## Why both — and why sheet-only would be a half-product

The preview path reads the source code at `getPath(input.sourceRecord, rule.sourceField)`
(`http-routes.cjs:721`), and `normalizeFieldRules` defaults `sourceField` to `targetField` when absent —
so **without binding `sourceField`, the resolver reads the wrong column** (the K3 field name, not the
material's source code). A sheet-only picker would look bound but resolve wrong. Hence both bindings here.

## What shipped (frontend-only)

- **Binding #2 — sourceCode column (`workbench.ts` + `MetaIntegrationFieldRuleAuthoring.vue`):**
  `setFieldRuleReferenceSourceField(rule, sourceField)` (keeps sourceType/domain/shape/completeness;
  empty → drop). The from_reference_table reference control now has a `sourceField` input (data-testid
  `field-rule-source-code-*`) + a "需填写 sourceCode 列" hint. `setFieldRuleReferencePreserve` also drops
  `sourceField`.
- **Binding #1 — sheet picker (`IntegrationWorkbenchView.vue`):** the #2080 JSON textarea is replaced by a
  **structured picker** that auto-lists the **distinct from_reference_table domains** from the authored
  rules; per domain, a **staging-system `<select>`** (names → id; `kind === 'metasheet:staging'` only —
  matches the route's P1 guard) + an **object text input**. `previewPayload` assembles
  `referenceMappingSources` from these bindings for **only the currently-authored domains** (stale
  bindings for removed domains are dropped; incomplete bindings skipped).

## Key decisions

- **Object = text input, not a dropdown.** The friction the owner named was the **`systemId`** (names
  shown, id hidden) — the system `<select>` closes that. Object names are already discoverable
  (source-object dropdown, staging descriptors), so a text input avoids per-row `listExternalSystemObjects`
  loading/caching for no friction gain. An object dropdown is future polish.
- **Domains derive from authored rules; stale dropped at send.** The picker shows exactly the distinct
  from_reference_table domains currently authored; a binding for a domain no longer present is dropped
  when assembling `referenceMappingSources` (the send loop iterates the **current** domains, not the
  bindings map — tested both ways: present→sent, and reverted-to-preserve→dropped).
- **Shared domain = one sheet binding, per-rule sourceCode column.** Two from_reference_table rules on the
  same domain (e.g. `FUnitID` + `FStoreUnitID` → `unit`) share **one** sheet binding (one sheet per
  domain, #2036) but each carries its **own** `sourceField` (its own sourceCode column). Intended model.

## Reachability — now resolvable end-to-end (in preview)

With 2d (authoring) + this slice (both bindings) + #2073 (route + bulk-read), an operator can mark a
field from_reference_table, pick a domain, bind the sourceCode column **and** the staging sheet, and the
preview resolves the reference per-material. (Backend resolution consuming `sourceField` is verified in
the merged backend; the route's staging-kind + duplicate guards live in #2073.)

## Tests + negative control

`MetaIntegrationFieldRuleAuthoring.spec.ts` + `IntegrationWorkbenchView.spec.ts` (28 passed). The
**dual-binding keystone** (in the DF-T2c flow test): author FUnitID → from_reference_table + domain +
sourceField, bind the picker (system dropdown + object) → the preview POST carries **both** —
`referenceMappingSources: [{domain:'unit', systemId, object}]` **and** the FUnitID rule with
`sourceType:'from_reference_table'` + `domain` + `sourceField:'unitSourceCode'`. **Negative control**:
neutering the sourceCode-column handler (sheet binds, `sourceField` never set) → the keystone fails —
proving the second binding is load-bearing, not just the sheet. vue-tsc clean for changed files.

## Next (gated, separate opt-in)

- **DF-T3b-2c** — real-Save compose-before-`upsert` (changes K3 Save bytes), with its recorded checklist
  (per-row fail-closed → dead-letter/provenance, same bindings as preview, I/O failure its own category).
- Optional later polish: an object dropdown (loaded per system) in place of the object text input.
