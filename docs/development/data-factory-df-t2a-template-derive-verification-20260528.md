# DF-T2a — template derive helper (verification, 2026-05-28)

First implementation slice of the DF-T2 chain (design = #2017). **Pure derivation helper /
service-layer capability only** — no authoring UI, no K3 write, no new shaper (reuses the
shipped `k3-save-body-composer` + DF-T1 preview vocabulary). Latent: not wired to any route/UI
(that is T2b/T2c). Leave for review — **do not auto-merge** (see the decision to ratify below).

## What shipped

`plugins/plugin-integration-core/lib/connector-template-derive.cjs`:
- **`deriveTemplateDraft(rawSample, {gatedFields})`** → `{ payloadTemplate, fieldRules, gatedFields }`.
  `payloadTemplate` = the **raw operator-local sample** verbatim; `fieldRules` = a per-field draft
  classified by value **shape**:
  - scalar → `from_staging` / `scalar` (draft suggests the same-named staging column);
  - `{FNumber,FName}` object → `preserve_template` / `object-passthrough` / `require-fnumber-fname`;
  - `{FID,FName}` object → `preserve_template` / `object-passthrough` / `require-fid-fname`;
  - other object/array → `preserve_template` / `object-passthrough` / `none`.
  Gated fields are excluded from authorable rules (returned as `gatedFields`).
- **`summarizeTemplateForEvidence(draft)`** → values-free view (field name + sourceType + shape +
  completeness + `isReference`/`hasValue` booleans) for docs / PR / run evidence. **Never the values.**
- **`deriveK3MaterialTemplateDraft`** + **`K3_MATERIAL_GATED_FIELDS = ['FBaseUnitID']`** (the
  M1-proven gated set — `FBaseUnitID` stays non-authorable; default-projecting it broke the M1 Save).
  It also **fails closed on an outer `{ Data: … }` K3 body/response envelope** — the operator must
  pass the inner material object, never the Save body / GetDetail envelope.

## P1 redaction boundary, realized (the #1882 round-trip footgun)

The executable `payloadTemplate` is built from **raw** values; `assertSampleExecutable` **fails
closed** before a sample can seed a template:
- **any shared-scrubber redaction marker** (`[redacted]` / `[redacted-jwt]` / `[redacted-secret-id]` /
  any `[redacted-*]` / `<redacted…>`, anywhere incl. nested) → reject — matched by a regex, not a
  literal list, so a future scrubber marker is covered;
- **unfilled `<…>` placeholder** → reject (reuses the composer's `findUnfilledPlaceholders`);
- **secret-shaped value** → reject (uses `scrubSecretStringValue` for **detection**, never to scrub
  a secret into a template).

`sanitizeIntegrationPayload` is **not** used here to produce a template — only
`summarizeTemplateForEvidence` (display/export) strips values. Customer reference values stay
operator-local (kept in `payloadTemplate`, absent from the evidence view).

## ⚠️ Decision to ratify (the reason this must not auto-merge)

**Class 2 is implemented as "reject the WHOLE sample on any secret-shaped string"** — the safe,
fail-closed reading of "secret-shaped benign value 不落模板". The alternative reading is "blank
only the offending value and keep the rest." This doc proposes **reject-whole-sample** (fail
closed beats partial). **Cost to accept:** one **false positive** (a legitimate value matching a
DSN / `token=` / `Bearer` pattern — e.g. a URL/remark field on a generic object, since
`deriveTemplateDraft` is reusable beyond K3) **discards the operator's whole working sample** with
no partial-recovery path. This is the same false-positive surface the #1882 matrix guards. Please
ratify reject-whole-sample (vs. blank-offending-value) before T2b builds UX on top.

## Tests (`__tests__/connector-template-derive.test.cjs`, green)

- Positive: `payloadTemplate` === raw sample; scalars → replace, references → preserve with the
  right completeness; gated `FBaseUnitID` excluded.
- **Vocabulary pin**: every emitted `sourceType`/`shape`/`completeness` is within the DF-T1 enum
  sets (those Sets are route-local in `http-routes.cjs`; this fails *here* if derive drifts
  out-of-vocab, rather than silently at the T2c preview wire).
- **P1 class 1** — every shared-scrubber marker form (`[redacted]` / `[redacted-jwt]` /
  `[redacted-secret-id]` / `<redacted…>` / embedded) → reject (top-level **and nested**
  `FUnitID.FName`); unfilled placeholder → reject. **Negative-controlled**: disabling the marker
  check makes the class-1 reject assertion fail.
- **K3 outer-envelope guard** — `deriveK3MaterialTemplateDraft` fails closed on an outer
  `{ Data: {…} }` / `{ Data: [{…}] }` body/response (object & array; incl. with a `StatusCode`
  envelope); the operator must pass the inner material object. The **generic** `deriveTemplateDraft`
  does not envelope-reject a `Data` field (K3-specific guard only).
- **P1 class 2** — secret-shaped value under a benign key → reject (top-level **and nested**).
- **P1 class 3** — evidence summary has field names + shape presence but **none** of the
  operator-local values; the same values **do** live in the operator-local `payloadTemplate`.

Wired into the plugin test chain + `test:connector-template-derive`.

## Boundaries (held)

Pure helper, **no UI / route / K3 write / new shaper**; reuses composer detection + DF-T1
vocabulary; references stay preserve-only (#1824); no Submit/Audit/BOM/multi-record. Latent —
T2b (authoring UI) and T2c (wire into DF-T1 preview + wire-vs-fixture test) are separate opt-ins.

## Files

- `plugins/plugin-integration-core/lib/connector-template-derive.cjs` (new)
- `plugins/plugin-integration-core/__tests__/connector-template-derive.test.cjs` (new) +
  `package.json` (test chain + `test:connector-template-derive`)
