# DF-T2 — K3 customer-profile authoring surface (design, 2026-05-28)

## Status / purpose

**Design note — not an implementation or a UI authorization.** DF-T2 is a notch bigger
than DF-T1A, so this locks the boundaries on paper first: what action metadata the
authoring surface consumes, how a working K3 material (GetDetail sample) becomes a
`payloadTemplate` + `fieldRules`, and which fields may only be **replace / preserve /
gated**. Implementation is a later, separately-opted-in slice (decomposed below); no UI is
written from this doc.

DF-T2 adds **no new composition path** — it produces the exact `payloadTemplate` +
`fieldRules` that the **already-shipped DF-T1 preview** consumes, composed through the
**already-shipped** `k3-save-body-composer` (DF-T1-0 parity). It writes nothing to K3.

## What is already shipped (DF-T2 builds only the authoring layer on top)

| Piece | State | DF-T2 use |
|---|---|---|
| `k3-save-body-composer.cjs` (DF-T1-0) | merged | Single source of truth for preview ≡ Save body. DF-T2 never re-implements composition. |
| `buildTemplatePreview` / `buildTargetPayloadPreview` (DF-T1) | merged | Accepts `payloadTemplate` + `fieldRules`; returns `eligibleForSaveOnly`, `unresolvedPlaceholders`, `missingRequiredFields`, `fieldProvenance`, `compositionSource`. DF-T2's output is the **input** to this; readiness is read **from** it. |
| Preview provenance display (DF-T1.5) | merged | Field-source badges DF-T2 reuses for the per-field replace/preserve view. |
| `connector-action-contracts.cjs` (DF-T1A) | merged | DF-T2 consumes action metadata (below); write actions stay gated. |
| `material-k3wise-customer-profile-v1` preset (`lifecycle: 'save-only'`) | merged on main | The reference shape DF-T2 authors toward; the M1-proven field model. |

## (1) Action metadata DF-T2 consumes (DF-T1A contract)

DF-T2 reads `ConnectorAction` metadata; it does **not** issue writes.

- **`k3wise.material.get-detail`** (`operation: read`, runnable): the template *source*. Its
  `output.recordPath` (`Data[0].Data`) locates the working material object in a GetDetail
  response; that object (sanitized) seeds the `payloadTemplate`.
- **`k3wise.material.save`** (`operation: upsert`, `gated:true`): the eventual *target* the
  authored template feeds — surfaced **disabled/annotated only**. DF-T2 reads its
  `request.path`/`output` to label the target; it never executes it (Save-only stays behind
  its own approval gate).
- Only `read`/`preview` actions are runnable from the authoring surface; any `upsert` action
  renders gated (the T1A `gated` flag), consistent with "write actions gated/disabled."

## (2) Generation: GetDetail / working template → `payloadTemplate` + `fieldRules`

Input options (operator picks one) — the **operator-local working sample**:
- **GetDetail sample**: a real, working K3 material fetched via the `get-detail` action (or
  pasted). It carries **real business / reference values** and is **operator-local** — stays on
  the entity machine, never committed to Git, never sent anywhere.
- **Working template**: a previously-authored/known-good material object (same locality rule).

Derivation:
1. The **operator-local working sample (raw, un-redacted)** becomes the **`payloadTemplate`**
   verbatim — whole-object defaults preserved (this is the K3 Save `Data` body shape;
   "bodyTemplate" = this `payloadTemplate`, the body under `bodyKey: 'Data'`). The executable
   template is built from **raw** values, **never** from a redacted copy (see the hard rule below).
2. For each top-level field the operator chooses a **rule** → one `fieldRules[]` entry:
   `{ targetField, sourceType, sourceField?|value?, shape, completeness, required, replacePolicy }`,
   using the DF-T1 enums already in `http-routes.cjs`:
   - `sourceType ∈ {from_staging, from_constant, preserve_template, from_reference_table}`
   - `shape ∈ {scalar, object-passthrough, by-fnumber, by-fid}`
   - `completeness ∈ {none, require-fnumber-fname, require-fid-fname}`
3. The merge (preserve template defaults, replace only declared fields) and readiness
   (`missingRequiredFields`, `unresolvedPlaceholders`, `eligibleForSaveOnly`) are produced by
   the **existing DF-T1 preview** — DF-T2 only assembles the inputs and renders the result.

**No-write merge only**: authoring + preview perform zero external calls; the authored
profile is never auto-saved.

### Redaction boundary (HARD rule — do not conflate the two objects)

`sanitizeIntegrationPayload` replaces sensitive shapes with `[redacted]`. Treating an
**already-redacted** object as the executable template would freeze `[redacted]` into the
`payloadTemplate`/`bodyTemplate` and reproduce the redaction round-trip footgun just fixed in
#1882. DF-T2 therefore keeps **two distinct objects that never cross**:

| Object | Contents | Use | Git / export |
|---|---|---|---|
| **operator-local working sample** | real business / reference values, **raw** (un-redacted) | the **only** source of an executable `payloadTemplate` / profile | **never** committed or exported |
| **redacted evidence / export** | `sanitizeIntegrationPayload` output | display, issues, docs, run evidence **only** | safe to show; **must not** seed an executable template |

- **The executable `payloadTemplate`/`bodyTemplate` must fail closed**: if it contains
  `[redacted]`, `<redacted>`, or any unreplaced `<…>` placeholder, it is **rejected** from
  entering preview/profile (it is not a usable Save body). Reuse the composer's existing
  fail-closed placeholder scan; extend the sentinel set with the redaction markers.
- `sanitizeIntegrationPayload` is for **display / export / evidence only** — it is **never** the
  function that produces the executable template.
- Secrets (host/account/token/authority) are still forbidden in a sample: a secret-shaped value
  **rejects the sample outright** rather than being redacted into a template.

## (3) Per-field model — replace / preserve / gated (grounded in the M1 preset)

The M1-proven `material-k3wise-customer-profile-v1` schema maps cleanly:

| Class | Rule | Fields (M1 preset) | Why |
|---|---|---|---|
| **replace** (operator-mapped) | `from_staging`, `scalar` | `FNumber`* `FName`* `FModel` `FPlanPrice` | Business scalars from the cleansed staging row (FNumber←materialCode, FName←materialName, …). `*` = required. |
| **preserve** (keep template) | `preserve_template`, `object-passthrough`, `require-fnumber-fname` | unit family + accounts + warehouse + manager: `FUnitGroupID` `FUnitID` `FOrderUnitID` `FSaleUnitID` `FProductUnitID` `FStoreUnitID` `FAcctID` `FSaleAcctID` `FCostAcctID` `FDefaultLoc` `FDSManagerID` | Full `{FNumber,FName}` reference objects. A single staging lookup yields one scalar, **not** a 2-field object (#1824 probe) — so v1 keeps the working template's object verbatim. |
| **preserve** (keep template) | `preserve_template`, `by-fid` / `object-passthrough`, `require-fid-fname` | category/enum/inspection family: `FErpClsID` `FUseState` `FTrack` `FPlanTrategy` `FOrderTrategy` `FInspectionLevel` + 6 inspection modes (`FProChkMde` `FWWChkMde` `FSOChkMde` `FWthDrwChkMde` `FStkChkMde` `FOtherChkMde`) | Full `{FID,FName}` objects, same composition limit. |
| **gated / locked** (not authorable in v1) | — | lifecycle (`autoSubmit`/`autoAudit` forced off by `save-only`); Submit / Audit / BOM / multi-record; **`FBaseUnitID`** | Save-only is non-overridable; the M1 contract **omits `FBaseUnitID`** (default-projecting it caused the failed-Save / dry-run mismatch) — authoring must not re-introduce it. Placeholders (`<…>`) fail closed before Save. |

Rules the authoring surface must enforce (UI + on the produced rules):
- A **reference object** field defaults to `preserve_template` and may not be downgraded to a
  raw scalar replace in v1 (would drop the `{FNumber,FName}`/`{FID,FName}` shape). Operators
  may only swap which working-template object is preserved, or supply a fully-formed object.
- `from_reference_table` stays **scalar-component only** (#1824) until a server-side
  composition path is separately unlocked — it cannot synthesize a 2-field reference object.
- The **customer profile is opt-in**; the default Material template is never silently
  switched to it (carries the DF-T1-0 opt-in test invariant forward).
- The authored profile is **Save-only**; the surface shows the Save target as gated and never
  offers Submit/Audit/BOM/multi-record.

**⚠️ v1 limitation — uniform reference defaults (the key trade-off to weigh first).** Because
reference objects are **preserve-only**, every material saved through one profile inherits the
**same** reference objects (unit family / accounts / warehouse / manager) from the single
working sample the profile was authored from. **Per-material reference _variation_ is not
possible in v1** — it requires the deferred server-side composition (#1824). This is adequate
when the target customer's materials share standard units / accounts / warehouse; it is
**insufficient** if those vary per material (such a row needs a different reference object than
the template carries). DF-T2 v1's customer fit should be decided on this before T2b.

**Why completeness still applies to a preserved ref:** even though a GetDetail object arrives
complete, `require-fnumber-fname` / `require-fid-fname` guards against a sample that was *itself*
incomplete (a working material missing an `FName` on some reference). It confirms the preserved
object is Save-ready; it does **not** re-compose it.

## Authoring flow (operator)

1. Select the K3 WISE Material package + a connector profile (read actions only).
2. Provide a working material: fetch via `get-detail`, or paste a sanitized sample (secrets
   rejected).
3. Surface derives the `payloadTemplate` + a default rule per field (scalars→replace,
   references→preserve, gated→locked).
4. Operator maps replace fields to cleansed staging columns; confirms/edits preserve objects.
5. No-write **preview** (DF-T1) shows final payload + `missingRequiredFields` +
   `unresolvedPlaceholders` + `eligibleForSaveOnly` + per-field provenance (DF-T1.5).
6. Operator exports the profile (non-secret manifest) — Save remains a separate approval.

## Proposed decomposition (each a separate opt-in)

- **DF-T2a** — *derive*: **raw operator-local** GetDetail/working sample → `payloadTemplate` +
  default per-field rules (built from raw values, **fail-closed on redaction markers** — see the
  redaction boundary); pure helper + unit tests; no UI write path yet.
- **DF-T2b** — *author*: per-field replace/preserve UI producing `fieldRules`; gated fields
  locked; reference fields default-preserve and shape-protected.
- **DF-T2c** — *readiness*: wire the authored `payloadTemplate`+`fieldRules` into the existing
  DF-T1 preview; render readiness/provenance; **wire-vs-fixture test** that the real preview
  request carries the authored template (the #1968 reachability lesson).

Sequence T2a → T2b → T2c; each gated on its predecessor + explicit opt-in.

## Non-goals / boundaries (carry into every DF-T2 PR)

- No new composition path (reuse `k3-save-body-composer` + DF-T1 preview); preview ≡ Save.
- No K3 write; no Save-only/Submit/Audit/BOM/multi-record execution; write actions gated.
- No server-side reference-object composition (preserve-only per #1824) until separately unlocked.
- No secrets in samples/manifests; sample passes shared redaction before becoming a template.
- No customer **business data** in Git either (not only secrets): a GetDetail sample's
  reference objects are real customer unit / account / warehouse codes — non-secret but
  customer-owned. Authored profiles + exported manifests keep those reference **values** out of
  Git (v1 is in-session / export-only; the export format is exactly where they would leak).
- No raw SQL / user JavaScript / generic HTTP client.
- Customer profile stays opt-in; default template never silently switched.

## Validation plan (for the implementation slices)

- Unit: derive produces a `payloadTemplate` equal to the **raw operator-local** sample; scalars
  default to replace, references to preserve; gated fields are locked.
- **Redaction boundary (T2a — the P1 footgun-guard, three classes):**
  - a **redaction marker** in the source (`[redacted]` / `<redacted>` / unreplaced `<…>`) →
    the sample is **rejected** from becoming an executable template (never frozen in);
  - a **secret-shaped value under a benign key** → **rejected**, never landed in the executable
    template (not silently redacted-then-kept);
  - **safe reference-object values** may be retained in the **operator-local** template, but the
    PR / docs / evidence show **only field names + shape presence** (never the reference values).
- Reference-shape: a `preserve_template` reference round-trips its `{FNumber,FName}`/`{FID,FName}`
  object through the composer unchanged; a reference downgraded to scalar is refused.
- Readiness/wire: the authored template drives the **real** DF-T1 preview request (asserted on
  the wire, not a fixture); `eligibleForSaveOnly` reflects `missingRequiredFields` /
  `unresolvedPlaceholders`.
- Opt-in: default Material authoring never auto-selects `material-k3wise-customer-profile-v1`.
- Redaction: preview output + any exported manifest pass shared redaction.

## Open questions (resolve at T2b/T2c scoping)

- Manifest import/export format (overlaps DF-T3 reference-mapping-sheet templates) — keep DF-T2
  to authoring + export of the payload profile; defer dictionary-sheet creation to DF-T3.
- Whether `FPlanPrice`/numeric scalars need a typed input vs free string (lean: reuse staging
  column typing).
- Where the authored profile is persisted (pipeline options vs a template store) — defer to
  DF-T4 pipeline-template binding; DF-T2 v1 produces an in-session/exported profile only.
