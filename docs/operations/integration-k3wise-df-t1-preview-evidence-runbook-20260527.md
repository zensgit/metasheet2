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
     fail-closes on it.
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

## What to post on #1792 (sanitized only)

Post the **acceptance result**, not the payload. A safe shape:

```
DF-T1 no-write preview evidence (package <tag>, profile material-k3wise-customer-profile-v1):
- valid: true
- eligibleForSaveOnly: true
- unresolvedPlaceholders: 0 | unresolvedReferenceComponents: 0 | missingRequiredFields: 0
- redactionSelfCheck.clean: true | compositionSource: k3-save-body-composer
- fields composed: <count> (identity from staging; <count> reference objects preserved) — count fieldProvenance, do not paste it
```

Do **not** paste `payload` / `targetRecord` / `fieldProvenance` values, raw `FNumber`/`FName`,
reference objects, the host, or the token. If you must reference a record, use a masked key.

## After acceptance — Save is a SEPARATE gated request

Once the owner/customer accepts this preview evidence, raise a **separate explicit Save-only
approval request** on #1792 (installed package, approved record count, profile, operator-
reviewed dictionaries confirmed, rollback owner/strategy per the #1830 rollback design).
**This runbook does not authorize any Save / Submit / Audit / BOM / multi-record / production
write** — only the no-write preview above.
