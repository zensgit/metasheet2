# DF-T2 — K3 Material customer-profile authoring (operator runbook, 2026-05-29)

Closeout for the DF-T2 chain (T2a derive #2023 · T2b authoring UI #2027 · T2c real-preview wire
#2032). This is the **operator procedure** to turn a working K3 Material into a Save-only
`payloadTemplate` + `fieldRules`, preview it with byte-fidelity, and decide it is ready — **without
any Save / Submit / Audit / BOM**. No new capability; it documents the shipped flow.

## What this does / does NOT do

- **Does:** derive a draft from a working K3 material → author replace/preserve per field → run a
  **no-write** preview that is byte-identical to the Save body.
- **Does NOT:** call K3, write anything, Submit, Audit, push BOM, or process multiple records. Every
  step here is read-only / pure compute. Save-only push is a **separate, explicitly-gated** action,
  out of scope for this runbook.

## Before you start

- A K3 WISE WebAPI connector exists (read).
- You have **one working K3 Material** as a starting point — either:
  - a `GetDetail` result for a real, valid material — **only the innermost material object**. K3
    typically returns it at `Data[0].Data`; paste **just that inner object** (the one with `FNumber` /
    `FName` / `FUnitID` … at its top level). Do **not** paste the full response, the `{ Data: … }`
    Save body, or the `Data[0]` wrapper object — those are outer envelopes and the derive step will
    reject them (step 2). **Or**
  - a known-good working template object (the same inner-object shape).
- That object is **operator-local**: keep it on your machine. It carries real customer reference
  values (units / accounts / warehouse / manager). It must **never** be committed to Git or pasted
  into an issue — see *Evidence* at the end.
- The sample must be **raw**: no secrets (host / account / token / authorityCode / connection
  strings) and no redaction markers (`[redacted]`, `[redacted-jwt]`, …). The derive step fails
  closed on those (below).

## Steps

1. **Paste the working material** into **目标模板 JSON** (`payload-template`). Paste the inner
   material object (raw values).
2. **Derive the draft** — click **从模板派生字段规则草案** (`derive-template-draft`). This calls the
   read-only derive route, which classifies each field and fills the authoring panel.
   - **Fail-closed**: if you see a derive error, the sample was rejected — fix it and re-derive:
     - *redaction marker* → you pasted a redacted/evidence copy; paste the **raw** operator-local object;
     - *unfilled `<…>` placeholder* → resolve the placeholder first;
     - *secret-shaped value* → remove the secret (secrets come from the connector profile, never the template);
     - *outer `{ Data: … }` envelope* → paste the **inner** material object, not the Save body / GetDetail envelope.
3. **Author per field** in the authoring panel:
   | Class | What you can do | Fields (M1 Material profile) |
   |---|---|---|
   | **Replace / preserve** (editable) | choose **替换(staging)** + a cleansing-table column, or **保留(template)** | scalars: `FNumber` `FName` `FModel` `FPlanPrice` |
   | **Preserve-only** (locked) | stays `preserve_template`; **cannot** be changed to a scalar replace in v1 | reference objects `{FNumber,FName}`: unit family / accounts / warehouse / manager · reference objects `{FID,FName}`: category / enum / inspection modes |
   | **Gated** (locked, not authorable) | not editable; produces no rule | `FBaseUnitID`; lifecycle (autoSubmit / autoAudit); anything tied to Submit / Audit / BOM / multi-record |

   Why references are preserve-only: a single staging lookup yields one scalar, not a 2-field
   reference object — so v1 keeps the working template's reference object verbatim. (Per-material
   reference *variation* is a future, separately-gated capability.)
4. **Preview** — click **生成 JSON 预览** (`preview-payload`). This is a **no-write** compute that
   builds the payload through the **same composer the Save path uses** (preview ≡ Save body).

## Ready criteria (all must hold)

Read these from the preview result shown in **Payload 预览** (`payload-preview`), under
`targetPayloadPreview`:

- `eligibleForSaveOnly` is **true**;
- `missingRequiredFields` is **empty** (every required field — `FNumber`, `FName` — has a value);
- `unresolvedPlaceholders` is **empty** (no `<…>` left in the body);
- `redactionSelfCheck` reports **clean** (no secret-shaped value reached the body);
- every preserved **reference** object is complete — `{FNumber, FName}` or `{FID, FName}` present
  (the completeness check), so no half-formed reference goes out.

If any fails, fix the authored fields (or the working template) and re-preview. **Do not treat a
preview with `eligibleForSaveOnly: false` as ready.**

## Boundaries (hold these)

- This runbook ends at a **ready preview**. It performs **no Save / Submit / Audit / BOM /
  multi-record**, and makes no external/K3 call.
- Save-only push (and Submit / Audit / BOM) are **separately gated** with their own approval and
  fresh K3 evidence — not part of DF-T2.

## Evidence — paste only values-free output

When attaching to an issue, ticket, or customer evidence:

- ✅ Paste the **字段来源** panel (`preview-provenance`) — it shows **field names + sources only,
  not values** (the UI states "仅显示字段名与来源，不含字段值"). The derive route's `evidence`
  (field name + shape presence) is equally safe.
- ❌ Do **not** paste the **Payload 预览** JSON (`payload-preview`). It contains the **composed
  payload with real customer reference values** (units / accounts / warehouse). It is for the
  operator's local verification only.
- ❌ Do **not** commit or share the working template / `GetDetail` sample. It stays operator-local.

This keeps customer business data off Git and out of shared artifacts, consistent with the DF-T2
redaction boundary.
