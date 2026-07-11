# Entry-identifier identity intake — direction design-lock — 2026-07-06

## Status

**Direction design-lock only. No runtime, no config model, no adapter, no code, no write.** This document
locks the *direction* for classifying, per customer, **what the composition/resolver line's entry
identifier actually is** — is the "物料号" a customer types the ERP (K3) material number, a PLM material
number, a PLM drawing number (图号), or something that maps to the ERP material number through a table, a
transform, or a multi-dimensional key. It authorizes no implementation. Every rung below is a separate,
later, explicitly gated opt-in. Read-only throughout.

It exists because the shipped composition line (materialNumber → internal id → BOM number, #1709) carries
one **implicit** premise: the runtime input key IS the ERP material number, and hop-1 resolves it directly.
Owner decision c126/c127 fixed the *policy* (`inputKeyDecision=require_material_number_to_internal_id_lookup`,
`multiplicityDecision=unique_only_fail_closed`) but left the *semantics of "material number"* unstated. The
2026-07-06 entity-machine probe (#3652) surfaced the first live signal that the premise is not universal:
`bomKeyFieldConfigured=other-token` — the deployed BOM read config's key field is not the naively-assumed
`FItemID`. This lock makes the entry-identifier a **classified intake dimension**, not a default.

## One-line scope

> Before a customer's composition/resolver chain is contracted, **classify the entry identifier** (which
> code the operator types) against a fixed spectrum, and bind the chain shape to that class — identity,
> a config-declared key field, a customer cross-reference dictionary, a format transform, a multiplicity
> hold, or a multi-dimensional key. **Never default to "the input equals the ERP material number."**

## Why this is not already decided

The line already made the input **level** decision (stop at "material number", keep internal ids internal)
and the **multiplicity** decision (unique-only, fail-closed, no auto-select). Neither says *what the entered
code is* relative to the ERP material master. Across customers this varies materially, and getting it wrong
does not fail loud — it silently resolves the **wrong** internal id / wrong BOM (a values-correct-looking
but semantically-wrong answer), which is exactly the class of error the no-guess discipline exists to
prevent. So the entry-identifier class must be an explicit, per-customer, contract-time input.

## The entry-identifier spectrum (fixed classes)

| Class | Customer practice | Chain implication |
| --- | --- | --- |
| **ID (identity)** | PLM 物料号 == ERP (K3) 物料号 — same code | Current depth-2 chain works directly; hop-1 key = ERP material number |
| **DRAW (drawing≠material)** | PLM carries 图号 (drawing) and 物料号 separately; 物料号 == ERP, but the operator's in-hand key is the 图号 | Needs a 图号→物料号 resolution BEFORE hop-1 → a depth-3 chain (separate gate) |
| **XREF (dictionary)** | PLM code ≠ ERP code; a customer-maintained cross-reference maps them | Resolve via the reference-mapping dictionary (`sourceCode → k3FNumber`, existing design) as a pre-hop; not identity |
| **XFORM (format rule)** | ERP code = PLM code under a prefix/suffix/zero-pad/format transform (e.g. `DWG-1234`↔`1234`) | A declared, reversible transform on the key; not a table lookup, not identity |
| **MULTI (multiplicity)** | One 图号/物料 maps to many ERP materials (variants/versions) | Hits `unique_only_fail_closed` → AMBIGUOUS/held; safe, but the chain cannot resolve without an explicit disambiguation input (out of v1) |
| **ORG (org/plant scoped)** | Same material number, but the internal id (FItemID) differs per organization/plant (K3 multi-org) | The single key is insufficient; needs a `{material, org}` multi-dimensional key (separate gate) |

A given customer/system is classified into exactly one primary class at intake (a system may be ID for some
objects and XREF for others — classification is per object/config, not per tenant).

## Architecture disposition per class (reuse, not reinvent)

**Already covered by the shipped config-driven + fail-closed design (no new build):**

- **ID** — the current depth-2 composition. Hop-1's `keyField` is the ERP material number field.
- **XREF** — the entry code is resolved to the ERP material number through the **existing** customer
  cross-reference dictionary (`integration-k3wise-reference-mapping-authoring-design-20260525.md`:
  `sourceCode | k3FNumber | k3FID | k3FName`, customer-maintained, no-guess). This lock **references, does
  not re-derive** that mechanism; XREF-as-a-read-pre-hop is the read-side use of the same dictionary the
  write side uses for object population.
- **XFORM** — expressible as a resolver config whose declared key field / key-encoding already carries the
  format (the resolver config is customer-sample-driven and does not hard-code `FNumber`); a pure declared
  transform, no new runtime path, as long as it stays reversible and values-free.
- **MULTI** — the `unique_only_fail_closed` + `automaticSelectionByStatusVersionDate=false` policy already
  holds this safely: it returns AMBIGUOUS/held rather than silently picking. **This is the correct default**
  — resolving a MULTI case requires an explicit disambiguation input, which is a separate decision, not a
  silent auto-pick.

**Requires a new, separately-gated decision (named here, not designed, not authorized):**

1. **Depth-3 chain (DRAW, and XREF-as-a-pre-hop when modeled as a chain step).** Composition v1 is a
   **fixed depth-2**. A 图号→物料号→内码→BOM path is depth-3. This lock does NOT authorize widening the
   composition depth bound; it names it as a separate opt-in (adjacent to, and distinct from, the REC-R0
   recursion track — depth-3 is a longer *fixed* chain, not unbounded recursion).
2. **Multi-dimensional key (ORG).** The runtime request is a strict **key-only** `{ inputs: { key } }`
   contract. An ORG-scoped customer needs `{ material, org }`. Widening the runtime key contract is a
   **new boundary decision** (it touches the key-only lock that the whole read line rests on) — separate
   opt-in, not authorized here.
3. **Explicit disambiguation input for MULTI** (which variant/version) — separate opt-in; until then MULTI
   stays held (fail-closed), which is acceptable.

## The intake contract (what this changes for BL1 and every future chain)

BL1 (and any composition/resolver contract) **must carry an explicit entry-identifier classification** — it
may not default to ID. Minimal intake fields (values-free):

```text
entryIdentifierClass = ID | DRAW | XREF | XFORM | MULTI | ORG
entryIdentifierMeaning = <coarse token: erp_material_number | plm_material_number | plm_drawing_number | ...>
hop1KeyFieldToken = <the read config's declared key field, coarse token — e.g. the probe's bomKeyFieldConfigured>
requiresPreHop = <true|false>            # DRAW / XREF-as-chain
requiresMultiDimKey = <true|false>       # ORG
multiplicityHeldExpected = <true|false>  # MULTI
```

The live #3652 probe already contributes `hop1KeyFieldToken=other-token` — so this system is **not** the
naive ID case for its BOM hop, and BL1 must encode the actual configured key field, not `FItemID`.

## Staged rungs (each a separate opt-in; none authorized here)

| Rung | Scope | Gate |
| --- | --- | --- |
| **EII-R0** (this doc) | direction: the spectrum, per-class disposition, the intake contract, the two new-boundary names (depth-3, multi-dim key) | docs only |
| **EII-R1** | intake **classification field** added to the composition/read config contract + validator (a coarse enum; drives which chain shape is permitted); no depth-3, no multi-dim key | contract/config-time only; no runtime |
| **(later)** depth-3 chain | fixed-depth-3 composition (DRAW / XREF-pre-hop) | separate opt-in; distinct from REC recursion |
| **(later)** multi-dim key | `{material, org}` runtime key + org-scoped resolution | separate opt-in; touches the key-only lock |

## Relationship to existing docs (referenced, not superseded)

- **Reference-mapping authoring** (`...reference-mapping-authoring-design-20260525.md`) — the XREF
  dictionary mechanism; this lock reuses it for the read pre-hop, does not re-derive it. (It also resolves
  the #1711 relationship-registry overlap: XREF is that registry's read-side application.)
- **Customer-profile FBaseUnitId alignment** (`...m1-customer-profile-fbaseunitid-alignment...`) — precedent
  that per-customer field identity already needs explicit alignment; entry-identifier class generalizes it.
- **Resolver / composition line** (#1709, BL0 #3603, resolver design-locks) — this lock adds the classifier
  in front of hop-1; the owner c126/c127 input-level and multiplicity policies are unchanged.
- **REC-R0 recursion** (`...recursive-expansion-direction-design-lock-20260705.md`) — depth-3 here is a
  *fixed* longer chain, deliberately named separately from unbounded recursion.

## Non-goals (explicit)

- No write / Save / Submit / Audit / external write (a different line; production write customer-barred).
- No depth-3 chain and no multi-dimensional key implementation — both are named, not designed, not authorized.
- No auto-selection for MULTI (stays held / fail-closed).
- No default-to-identity assumption anywhere downstream.
- No new dictionary/registry — XREF reuses the existing reference-mapping design.
- No code, config model, or validator in this doc (that is EII-R1).

## Disposition

Direction locked. Authorizes no code. The immediate, in-gate consequence is a **BL1 constraint**: the
composition/read contract must classify the entry identifier explicitly (`entryIdentifierClass` + the actual
configured key field from the #3652 probe), never defaulting to "input == ERP material number." Depth-3 and
multi-dimensional key remain separate, unopened gates. When opted in, the first implementable rung is
**EII-R1** (the classification field + validator — pure/config-time).
