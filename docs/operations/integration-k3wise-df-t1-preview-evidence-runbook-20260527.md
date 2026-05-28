# K3 WISE — DF-T1 target-payload preview evidence runbook (2026-05-27)

Issue: **#1792** (customer GATE). Purpose: before the next M1 Material **Save-only** attempt,
use the **DF-T1 no-write preview** (PR #1945, on the #1936 composition-parity seam) to verify
the **exact target payload** an operator would Save — replacing "blind Save attempts" with
"verify the payload first, then request Save".

> **This runbook does NOT authorize a Save.** It produces *preview evidence* only. Save-only
> approval is a separate, explicit request after this evidence is accepted (see the end).

## Scope / safety

- **No-write only.** The DF-T1 preview makes zero external calls (no login / fetch / Save /
  Submit / Audit / BOM / list / search). It only composes and validates a payload.
- **Proven clone-Save path, not authoring.** `payloadTemplate` is a sanitized `Material/GetDetail`
  clone — the object-preservation path already proven at the GATE — not a hand-built object.
  `fieldRules` v1 replaces **only** the identity fields `FNumber`/`FName` (`from_staging`); every
  reference object stays `preserve_template` + completeness. This is *preview of the proven
  clone-Save*, not a general K3 authoring UI; do not author reference fields one-by-one.
- **Real values stay off Git.** The real `payloadTemplate` (a sanitized `Material/GetDetail`
  clone with the customer's reference objects) and the real staging row are filled **at
  runtime on the entity machine**, never committed. The template in this repo is placeholders
  only.
- **#1792 comments are sanitized.** Post only the redacted acceptance result (below). Never
  paste a raw `FNumber` / `FName` / reference object / customer host / token / authorityCode.

## Prerequisites

- An on-prem package built from `main` at or after #1945 (DF-T1) — it carries the
  `/api/integration/templates/preview` `payloadTemplate` + `fieldRules` mode and the shared
  `k3-save-body-composer`.
- The customer Material profile shape (`material-k3wise-customer-profile-v1`) and a
  **sanitized** `Material/GetDetail` clone to use as the `payloadTemplate` base.
- One real cleansed **staging row** for the material under test.

## Steps

1. **Copy the fillable template off Git** and fill it on the entity machine with the
   customer's real values:
   - `docs/operations/integration-k3wise-df-t1-preview-evidence-template.json`
   - `sourceRecord` ← one real staging row.
   - `payloadTemplate` ← your sanitized GetDetail clone. The template's reference fields are
     **illustrative**; substitute the whole clone (it usually carries more objects, e.g.
     org/stock fields) and leave any value you cannot fill as its `<…>` placeholder — DF-T1
     fail-closes on it. A clone is fine for a quick iteration, but **for #1792 config-track
     evidence the `payloadTemplate` MUST be the persisted `config.objects.material.bodyTemplate`**
     (see *Binding the preview to the pipeline*) — an ad-hoc clone does not count as final
     evidence.
   - `fieldRules` ← keep the provided rules (identity fields `from_staging`; reference objects
     `preserve_template` with the right `completeness`); add a `preserve_template` rule for any
     extra required reference field your clone carries.
   - Save the filled copy as `df-t1-preview-evidence.filled.json` (the name step 2 reads).
2. **Run the no-write preview** (replace host/token at runtime; do not record them):

   ```bash
   curl -sS -X POST "$K3_PREVIEW_BASE/api/integration/templates/preview" \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     --data @df-t1-preview-evidence.filled.json
   ```

3. **Check the acceptance bar** (all must hold):

   | Field | Required value |
   |---|---|
   | `valid` | `true` |
   | `targetPayloadPreview.eligibleForSaveOnly` | `true` |
   | `targetPayloadPreview.unresolvedPlaceholders` | `[]` |
   | `targetPayloadPreview.unresolvedReferenceComponents` | `[]` |
   | `targetPayloadPreview.missingRequiredFields` | `[]` |
   | `targetPayloadPreview.redactionSelfCheck.clean` | `true` |
   | `targetPayloadPreview.compositionSource` | `'k3-save-body-composer'` |

   If any fails: the preview is **not** ready. `unresolvedPlaceholders` lists `<…>` values
   still to fill; `unresolvedReferenceComponents` lists reference fields missing a required
   `FNumber/FName` or `FID/FName`; `missingRequiredFields` lists required fields with no value.
   Fix the template/staging row and re-run. Do **not** proceed to a Save request until the bar
   is green.

   > **Necessary but not sufficient for config-track evidence.** A green bar is an *early
   > structural check* — it proves the template you passed composes cleanly, not that the
   > *pipeline* will Save that body. The **pipeline dry-run cross-check is the authoritative
   > equality gate.** To use this preview as #1792 config-track evidence, the preview's
   > `payloadTemplate` must be the inner object of the persisted pipeline `bodyTemplate`
   > (`bodyTemplate.Data`) **and** the dry-run cross-check must match — see **Binding the
   > preview to the pipeline** below.

## Binding the preview to the pipeline (config-track evidence)

The 7-field bar above proves *composition* — but the DF-T1 preview composes from the
`payloadTemplate` you pass it, while the actual pipeline Save composes from the persisted
`config.objects.material.bodyTemplate`. A green preview on an **ad-hoc clone** therefore does
**not** prove the pipeline will Save that body; with `bodyTemplate` absent (the 2nd Save-only
root cause), the pipeline still emits only the few mapped fields and the row-level Save fails
again. **A green preview on an ad-hoc clone is not acceptable as final evidence.**

To make this preview usable as config-track evidence — the preview is an early structural
check; the dry-run cross-check is the authoritative gate:

1. **Persist first.** Put the operator-reviewed full Material object into
   `config.objects.material.bodyTemplate` (the pipeline's actual Save base) **before** running
   the preview — shaped as `{ "Data": { …full Material object… } }` (the whole-body shape the
   adapter merges; field data lives under the `Data` body key). See *Persisting the
   `bodyTemplate`* below. Do not rely on an ad-hoc clone for evidence.
2. **Preview that template's inner object.** Run the DF-T1 preview with `payloadTemplate` set to
   the **inner object of the persisted `bodyTemplate`** (`bodyTemplate.Data`) — not the whole
   `bodyTemplate`, and not a separate clone. The preview adds the `Data` wrapper itself, so
   passing the whole `{ "Data": {…} }` would double-wrap it.
3. **Pipeline dry-run cross-check (authoritative).** The preview overlay (`fieldRules`) and the
   pipeline overlay (schema projection) are different filters over the same record, so a green
   preview does not *prove* equality — only this step does. Run a pipeline dry-run and compare
   the **adapter-composed Save body** `preview.records[0].targetPayload.Data` against the DF-T1
   preview's `payload.Data` — **field set == field set** (same field names and object shapes;
   names / shape presence only, never values). Compare `targetPayload.Data`, **not**
   `preview.records[0].transformed` (that is the cleaned staging record, not the Save body).

**Config track is closed only when both hold:** the 7-field preview bar is all-green (early
structural check) **and** the pipeline dry-run field-set cross-check matches (the authoritative
equality gate). A green preview alone — even on a real clone — does not close it.

Closing the config track here still **does not authorize a Save** — a Save-only attempt remains
a separate, explicit approval request (see the end of this runbook).

### Persisting the `bodyTemplate`

The `bodyTemplate` lives in the external system's config blob. The upsert **overwrites the whole
config** — a partial POST drops your existing keys (`profile`, `savePath`, `keyField`, …). So
**GET → edit → POST back the whole config** — but mind the redaction trap below.

> **⚠ GET returns a REDACTED projection — do not POST it back blindly.**
> `GET …/external-systems/:id` runs `config` through the secret redactor: any secret-keyed field
> (`password`, `token`, `apiKey`, `secret`, `clientSecret`, `authorization`, `cookie`,
> `connectionString`, `jdbcUrl`, …) comes back as the literal string `[redacted]`. Because the
> upsert overwrites the whole config, POSTing a GET-derived file back **clobbers those real values
> with `[redacted]`** and breaks the system. (The raw values are kept server-side for the adapter;
> the GET projection never exposes them.)

1. **GET the current config** (on the entity machine) — this is the *redacted* view:

   ```bash
   curl -sS "$BASE/api/integration/external-systems/$SYSTEM_ID" \
     -H "Authorization: Bearer $TOKEN" > external-system.json
   ```

2. **Edit locally** — add `bodyTemplate` under `config.objects.material`, keeping every existing
   key. Field data goes under `Data`:

   ```jsonc
   // config.objects.material — keep existing keys, add bodyTemplate
   {
     "profile": "material-k3wise-customer-profile-v1",
     "savePath": "…", "keyField": "FNumber",
     "bodyTemplate": { "Data": { /* full reviewed Material object, real values */ } }
   }
   ```

3. **HARD RULE — scan for `[redacted]` before POSTing.** Search the edited `config` for the string
   `[redacted]`. If **any** `[redacted]` value exists anywhere under `config`, do **not** POST the
   file as-is — restore the real value from the entity-machine secure config source first, **or**
   use an on-box merge helper that patches `bodyTemplate` into the **raw** stored config (not the
   redacted GET). POSTing while `[redacted]` is present overwrites a real secret with that literal
   token.

4. **POST it back** (the whole edited document — only after the scan is clean):

   ```bash
   curl -sS -X POST "$BASE/api/integration/external-systems" \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     --data @external-system.json
   ```

5. **Verify the round-trip** — GET again and confirm `config.objects.material.bodyTemplate.Data`
   is present with the expected field count. This distinguishes "didn't post" from "posted but
   stripped".

The `bodyTemplate` holds **real customer values** — it stays on the entity machine. **Never**
POST it to GitHub or paste/attach the config blob on #1792; evidence stays counts-and-presence
only.

## Template-alignment retry (customer Save template)

If the persisted base is an incomplete `Material/GetDetail` clone, the preview fails completeness
(e.g. `FUnitGroupID` comes back `{FName}`-only) and the pipeline composes a field the customer's
K3 contract doesn't use (e.g. `FBaseUnitID`), so the dry-run cross-check won't match. Prefer the
customer's own working `Material/Save` template as the authoritative base — this **refines the
"GetDetail clone" framing above** for the customer case:

1. **Base = the customer Save template, not a `GetDetail` clone.** Persist
   `config.objects.material.bodyTemplate = { "Data": <customer Material/Save template object> }`
   (operator-reviewed, real values, on-box, off-Git — same persist + `[redacted]` scan rule as
   above). The customer's working template carries complete reference objects (e.g. `FUnitGroupID`
   as `{FName, FNumber}`) that a `GetDetail` clone may lack.
2. **Drop fields the customer contract doesn't use from the pipeline `fieldMappings`.** If the
   customer's Material model has no `FBaseUnitID` (it uses `FUnitID` + the unit family), remove
   the `FBaseUnitID` mapping. `projectRecordForBody` only projects schema fields the staging
   record provides, so dropping the mapping stops the dry-run adding it — **no code change
   needed**.
3. **Preview replaces scalars only; references preserve the template.** Set `fieldRules` to
   replace just the staging-sourced scalars (typically `FNumber`/`FName`/`FModel`/`FPlanPrice`)
   as `from_staging`; keep **every** reference object as `preserve_template` (they come complete
   from the customer template).
4. **Re-run the no-write preview and require full parity:** the 7-field bar green,
   `unresolvedReferenceComponents = 0`, **and** `preview.records[0].targetPayload.Data` field set
   == `payload.Data` field set **including recursive (nested) shape**, not just top-level. A
   top-level match with `recursive shape match: false` is **not** closed.
5. **Post (sanitized):** the 7-field bar + `unresolvedReferenceComponents: 0` + `top-level field
   match: yes` + `recursive shape match: yes` — names / counts / shape-presence only. If fields
   still diverge, post the diverging field **names** only (no values) so the profile/schema/mapping
   can be aligned (a separate change).

This still **does not authorize a Save** — config-track parity proves the Save *body shape* (that
we will Save exactly the customer's own template shape), not that K3 will accept it. The next
Save-only attempt remains a separate, fresh approval.

## What to post on #1792 (sanitized only)

Post the **acceptance result**, not the payload. A safe shape:

```
DF-T1 no-write preview evidence (package <tag>, profile material-k3wise-customer-profile-v1):
- valid: true
- eligibleForSaveOnly: true
- unresolvedPlaceholders: 0 | unresolvedReferenceComponents: 0 | missingRequiredFields: 0
- redactionSelfCheck.clean: true | compositionSource: k3-save-body-composer
- fields composed: <count> (identity from staging; <count> reference objects preserved) — count fieldProvenance, do not paste it
- previewed payloadTemplate = persisted config.objects.material.bodyTemplate.Data: yes
- pipeline dry-run field-set cross-check: matches (`preview.records[0].targetPayload.Data` field set == previewed `payload.Data` field set)
```

Do **not** paste `payload` / `targetRecord` / `bodyTemplate` / `fieldProvenance` values, raw
`FNumber`/`FName`, reference objects, the host, or the token. If you must reference a record,
use a masked key. For the dry-run cross-check, post field **names** and shape presence only.

## After acceptance — Save is a SEPARATE gated request

Once the owner/customer accepts this preview evidence, raise a **separate explicit Save-only
approval request** on #1792 (installed package, approved record count, profile, operator-
reviewed dictionaries confirmed, rollback owner/strategy per the #1830 rollback design).
**This runbook does not authorize any Save / Submit / Audit / BOM / multi-record / production
write** — only the no-write preview above.
