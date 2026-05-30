# DF-T3b-2d — from_reference_table authoring opt-in (reference → resolve-via-mapping) — development verification (2026-05-29)

> The **authoring half** of operator-facing from_reference_table (owner sequence A: authoring-first,
> then picker). Lets a reference field opt into "resolve via mapping sheet" (`from_reference_table` +
> `domain`) in `MetaIntegrationFieldRuleAuthoring`, lifting the DF-T2b "references locked to preserve"
> **only for the resolve-via-mapping case** (NOT a scalar downgrade — the v1 no-downgrade rule holds).
> **Frontend-only. No backend change. No mapping-sheet read.**

## Reachability — authorable, NOT yet resolvable end-to-end (honest framing)

This makes from_reference_table **authorable**. It does **not** make it **resolvable** for the operator.
Resolution still needs, beyond this slice: (1) the **binding picker** (`referenceMappingSources` — which
staging sheet each domain reads, the next slice); (2) the **sourceCode-column binding** — `rule.sourceField`,
i.e. which staging column holds the material's source code the resolver looks up (2d authors the domain
but not this); and (3) the #2073 route. So after 2d an operator can mark a field `from_reference_table` +
pick a `domain`, but the preview won't resolve it until the picker **and** the sourceCode column are
bound. 2d is the authoring half — the picker is the *next* half, not the last.

The intermediate **half-state** (`from_reference_table` with no `domain` yet) is **safe**: the backend
resolver fail-closes a domain-less rule (no index → unresolved), never silently picks. The UI flags it
("需选择 domain").

## Locked scope (owner-set)

- A reference field can switch **preserve_template ↔ from_reference_table**; switching to the latter
  requires picking a **domain**.
- `domain` only from the **T3a 12 templates** (`DF_T3_REFERENCE_DOMAINS`, mirrors the backend).
- `shape` stays **object-passthrough** (never scalar); `completeness` stays `require-fnumber-fname` /
  `require-fid-fname`.
- **Gated fields stay locked** and **win** over reference-editability (e.g. `FBaseUnitID` stays closed).
- ❌ no mapping-sheet read / no backend capability; ❌ no real Save / pipeline runner / K3 write.

## What shipped (frontend-only)

- `apps/web/src/services/integration/workbench.ts`:
  - `IntegrationFieldRule` += `domain?`; `DF_T3_REFERENCE_DOMAINS` (the 12, mirrors `K3_REFERENCE_MAPPING_TEMPLATES`;
    backend validates unknown → 400, so a stale list is non-correctness).
  - `fieldRuleEditability`: a reference is now **reference-editable** (`{editable:true, reason:'reference',
    isReference:true}`), no longer locked — **gated check stays first** (gated wins).
  - reference setters `setFieldRuleFromReferenceTable(rule, domain)` (keeps shape + completeness; empty
    domain → half-state) + `setFieldRuleReferencePreserve(rule)` (back to preserve, domain dropped). The
    scalar setters now also drop `domain`.
- `apps/web/src/components/integration/MetaIntegrationFieldRuleAuthoring.vue`: three render branches —
  gated (locked label) / **reference** (mode select 保留↔从映射表解析 + a required `domain` select with
  "需选择 domain" hint) / scalar (existing replace/preserve). `onModeChange`/`onSourceFieldChange` now
  guard `isReference` (a reference can never reach the scalar setters).
- Tests: `MetaIntegrationFieldRuleAuthoring.spec.ts` extended; `IntegrationWorkbenchView.spec.ts` DF-T2c
  assertion updated (reference is now editable, not locked).

## Tests + negative control

`MetaIntegrationFieldRuleAuthoring.spec.ts` + `IntegrationWorkbenchView.spec.ts` (26 passed): reference
is editable (mode select, no locked label, no scalar source input); switch→mapping emits the
`from_reference_table` **half-state** (shape + completeness kept, domain absent); the domain picker shows
the 12 + placeholder and picking emits the `domain`; a **gated reference stays locked**; `DF_T3_REFERENCE_DOMAINS`
pinned to the exact 12 (sorted `deepEqual`). **Negative control**: reordering `fieldRuleEditability` so
the reference check precedes the gated check → the gated-reference tests fail (proves gated-wins is
load-bearing — the `FBaseUnitID`-stays-closed invariant). vue-tsc clean for changed files.

## Next (gated, separate opt-in)

- **Binding picker** — `referenceMappingSources` per from_reference_table domain (which staging
  system/object holds the mapping sheet) so the authored rules resolve in the preview. **Note for that
  slice's scope:** it must also bind the **sourceCode column** (`rule.sourceField`) — the picker's sheet
  binding alone is not sufficient for the resolver to read the right field.
- **DF-T3b-2c** — real-Save compose-before-`upsert` (separate; its recorded checklist).
