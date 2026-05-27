# K3 WISE M1 Material Save-only failure fix — Design (2026-05-27)

Issue: #1792 (Customer GATE). Scope: **M1 Material Save-only failure fix only.**
This PR is **docs-only** — design + verification. **No runtime change in this PR.**
Owner-directed Material Save-path remediation (the sanctioned GATE-blocking carve-out
of the K3 Stage-1 lock); a separate implementation PR follows, then a patched package,
then a **fresh explicit approval** before any second Save-only attempt.

## 1. Context — what happened

- **M0 (read-only Material/GetDetail dry-run): PASS** on the entity machine (#1792).
- **M1 (1–3 record Material Save-only): executed once (human-approved) and FAILED** the
  row-level success gate — K3 returned envelope `StatusCode=200` / `Message=Successful`,
  but the row-level Save did not succeed. No retry; readback correctly skipped; no
  Submit/Audit/BOM/multi-record. The failure was *detected*, which is correct behavior.
- **Root cause** (sanitized triage of the customer's Java K3 sample): the customer K3
  WISE environment does **not** accept a minimal `FNumber`/`FName` Material Save. It
  requires a fuller Material object whose base-data fields are **objects**, sourced from
  operator-reviewed K3 dictionaries — not the minimal payload M1 sent.

## 2. Current state (accurate baseline — grounded in code)

The current code is **not** "missing the Material template." What exists today:

- `plugins/plugin-integration-core/lib/adapters/k3-wise-document-templates.cjs:91`
  defines a generic `k3wise.material.v1` template that **already declares** unit-family
  and account fields as `type: 'reference'` (`K3_REFERENCE_BY_NUMBER`):
  `FUnitGroupID`, `FBaseUnitID`, `FOrderUnitID`, `FSaleUnitID`, `FProductUnitID`,
  `FStoreUnitID`, `FAcctID`, `FSaleAcctID`, `FCostAcctID` (`:110–118`).
- The Save adapter `k3-wise-webapi-adapter.cjs` **already** has a row-level success gate
  (the #1813 evidence discipline): `getStatusCode` (`:172`), `businessRowMessage`
  (`:190`), `FStatus`/`IsSuccess`/`success` checks (`:204–281`), `businessTextIndicatesFailure`.
  This gate is what correctly **failed** M1 instead of trusting envelope-200.
- Readback **already** unwraps the nested detail: `const detail = isPlainObject(element.Data)
  ? element.Data : element` (`:546`).

So the real gaps the M1 failure exposes are narrower and more precise:

| Gap | Detail |
|---|---|
| **G1 No customer-profiled preset** | The generic `material.v1` is a thin skeleton; there is no preset that binds operator-reviewed dictionary values to populate the required base-data objects for this customer env. M1 sent the minimal `FNumber`/`FName` payload (the M0 dry-run scope), which this env rejects. |
| **G2 Missing fields in the template** | The skeleton declares units + accounts, but **lacks** the customer-required `FErpClsID`, `FUseState`, `FTrack`, `FDefaultLoc`, `FDSManagerID`, `FPlanPrice`, strategy fields (`FPlanTrategy`, `FOrderTrategy`), and quality-mode fields (`FInspectionLevel`, `FProChkMde`, `FWWChkMde`, `FSOChkMde`, `FWthDrwChkMde`, `FStkChkMde`, `FOtherChkMde`). |
| **G3 Shape mismatch** | All current reference fields use by-**number** (`{FNumber,FName}`). The customer sample uses `{FNumber,FName}` for *numbered* base data but `{FID,FName}` for *enum/category* fields (e.g. `FErpClsID`, `FUseState`, quality modes). Per-field shape selection is needed. |
| **G4 FBaseUnitID-centric default** | The setup/config default (`apps/web/src/services/integration/k3WiseSetup.ts`, `IntegrationWorkbenchView.vue`) leans on `FBaseUnitID`; the customer requires the `FUnitGroupID`/`FUnitID` family populated. |
| **G5 Diagnostics too thin** | The gate fails correctly but does not persist enough **sanitized** row-level detail to explain *why* (which field/validation failed). |
| **G6 `Data[0].Data` parse coverage** | The *read* path handles `element.Data` (`:546`), but the *Save-response* parsers (`extractBusinessRows:238`; `responseMessage`/`Code`/`FailureCode`/`BillNo`/`ExternalId`) probe only `Data[0].X`, never `Data[0].Data.X` — so a `Data[0].Data`-nesting customer **may** hit a parse-induced false-negative in diagnostics (distinct from, and possibly alongside, the missing-fields rejection). |

## 3. Design (per the 6 scoped points)

1. **Customer-profiled preset — explicit, opt-in, never the default.** Add a new template
   with a concrete id/version **`material-k3wise-customer-profile-v1`** in
   `k3-wise-document-templates.cjs`, **distinct** from the generic minimal template
   `k3wise.material.v1`. **Hard rule (must not regress):** the customer profile applies
   **only** when an external-system config *explicitly* selects it by id; the default
   Material template is **never silently swapped** to the customer-specialized one. The
   generic `k3wise.material.v1` stays byte-unchanged. A consumer that does not opt in keeps
   exactly today's behavior. (Guarded by the preset-opt-in test in §5.)
2. **Structure/shape only — no hardcoded customer values.** The preset declares the
   *field set and per-field shape* (`reference` + identifier kind). Actual dictionary
   values (unit codes, account codes, use-state IDs, etc.) come from operator-reviewed
   config at runtime and are **never** committed to Git or posted to the issue.
   **Fail-closed (mandatory):** any unreplaced placeholder (`<fill-outside-git>` /
   `<placeholder>` / `<…>`) in a required field must **fail validation before the HTTP
   Save** — it must never reach the Save body or the K3 wire. A half-configured preset
   yields a clean validation error, not a corrupt K3 write. (Guarded by the
   fail-closed-placeholder test in §5.)
3. **Base-data object fields**, especially the unit family `FUnitGroupID` / `FUnitID` /
   `FOrderUnitID` / `FSaleUnitID` / `FProductUnitID` / `FStoreUnitID`, plus G2's missing
   fields. Each declared with its correct shape (G3): numbered → `{FNumber,FName}`,
   enum/category → `{FID,FName}`.
4. **Row-level Save diagnostics — sanitized only.** `envelope StatusCode=200 /
   Message=Successful` must **never** be treated as confirmed write success (already true;
   keep it). On envelope-200-but-row-fail, persist **only** these sanitized fields:
   row-level **status**, response **code**, a **redacted** validation/error message, and
   the **failed field key names** (the field *names* such as `FUnitGroupID` — never their
   values). **Must NOT record**: raw `FNumber` or any record-identifier value, token,
   host, `authorityCode`, password, or SQL connection string. **Conservative row-key
   disposition:** if a per-row correlation key is persisted at all, it is a **mask/hash**
   token, never the raw `FNumber` / K3 ref code; a `sourceId` is persisted in full **only**
   when it is a confirmed MetaSheet internal row UUID, otherwise it is masked/hashed too
   (default to masking when in doubt). The redacted validation message goes through
   `scrubSecretStringValue`. The diagnostic captures *which fields/validations failed*, not
   *what the customer's data was*. (Guarded by the diagnostics-redaction test in §5.)
5. **`Data[0].Data` — readback AND Save-response parse.** The *read* path already
   unwraps `element.Data` (`:546`). The *Save-response* parse path does **not**:
   `extractBusinessRows` (`:238`) and the path helpers `responseMessage` /
   `responseCode` / `responseFailureCode` / `responseBillNo` / `responseExternalId`
   probe only `Data[0].X` / `Data.X`, never `Data[0].Data.X`. For a customer that
   nests per-row content under `Data[0].Data`, this **can** (not necessarily did)
   produce a parse-induced false-negative in the row diagnostics — a real success
   read as failed, *and* a real failure message missed. We do **not** assert M1's
   failure was this rather than the missing-fields rejection (§1 / G1–G3); the two
   can coexist. Fix: **one** unwrap of `row.Data` in `extractBusinessRows` (mirroring
   `:546`) + **targeted** `Data.0.Data.*` probes appended to the five path helpers
   (after the existing `Data.0.*`, so flat-shape customers are unaffected; no
   double-fix in the row-driven helpers). This makes nested **success and failure**
   both legible, so a genuine K3 rejection is distinguishable from a parse miss.
6. **No second Save-only attempt** until (a) the implementation PR merges, (b) a patched
   package is produced, and (c) a **fresh explicit approval** is posted on #1792.

### Hard rules (impl PR must honor — non-negotiable)

- **R-OPTIN — template stays opt-in.** The customer profile is a new, explicitly-named id
  **`material-k3wise-customer-profile-v1`**, applied **only** when a config selects it by id.
  The default Material template (`k3wise.material.v1`) is **never silently turned into** the
  customer-specialized one. A consumer that does not opt in behaves exactly as today.
- **R-REDACT — diagnostics are sanitized-only.** Row-level Save diagnostics persist **only**
  sanitized status / response code / redacted validation message / failed field **names**.
  They **never** record a raw `FNumber` (or any record-identifier value), token, host,
  `authorityCode`, password, or SQL connection string. Any persisted per-row correlation
  key is **mask/hashed** (never the raw `FNumber` / ref code); `sourceId` is full only when
  a confirmed MetaSheet internal UUID, else masked/hashed.
- **R-FAILCLOSED — no unreplaced placeholder reaches K3.** Any `<fill-outside-git>` /
  `<placeholder>` / `<…>` left in a required field must fail validation **before** the HTTP
  Save; it must never enter the Save body. A half-configured preset errors cleanly rather
  than writing corrupt data to K3.

## 4. Implementation plan — files the NEXT (impl) PR will change

> This PR changes **none** of these. Listed so the impl PR's surface is pre-agreed.

| File | Change |
|---|---|
| `plugins/plugin-integration-core/lib/adapters/k3-wise-document-templates.cjs` | Add the customer-profiled Material preset (new id; full field set incl. G2; per-field shape G3). Generic `material.v1` untouched. |
| `plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs` | Per-field base-data object shaping (by-number vs by-ID); richer **sanitized** row-level Save diagnostics (G5) with conservative mask/hash row keys; **Save-response `Data[0].Data` parse** — one `row.Data` unwrap in `extractBusinessRows` + targeted `Data.0.Data.*` probes on the five path helpers (G6); **fail-closed placeholder validation** before the HTTP Save. |
| `apps/web/src/services/integration/k3WiseSetup.ts` | Move default unit mapping off `FBaseUnitID`-centric toward the unit family; preset selection (G4). Structure only. |
| `apps/web/src/views/IntegrationWorkbenchView.vue` | Per-field shape selector surface for the preset (operator picks shape; values stay operator-supplied). |

## 5. Tests the impl PR will add — and the boundary each guards

| Test (file) | Guards |
|---|---|
| preset-opt-in (`__tests__/k3-wise-adapters.test.cjs`) | `material-k3wise-customer-profile-v1` applies **only** when explicitly selected; the default Material template is byte-stable / behavior unchanged when not opted in. (point 1) |
| no-hardcoded-values (`k3-wise-adapters.test.cjs`) | Preset declares field **structure** only; no concrete dictionary value baked in. (point 2) |
| fail-closed-placeholder (`k3-wise-adapters.test.cjs` + mock save server) | A preset with an unreplaced `<fill-outside-git>`/`<placeholder>` in a required field → `upsert` **fails validation and issues ZERO Save HTTP calls** for that row (mock save endpoint receives nothing); a fully-substituted preset proceeds. **Negative control:** remove the guard → the placeholder reaches the mock save body, proving the guard blocks it. (point 2 / R-FAILCLOSED) |
| base-data-object-shaping (`k3-wise-adapters.test.cjs`) | Each field emits the correct `{FNumber,FName}` / `{FID,FName}` shape. (points 3, G3) |
| envelope-200-row-fail (`k3-wise-adapters.test.cjs` + mock `mock-k3-webapi-server.mjs` returning 200/Successful with row `FStatus=false`) | Adapter reports FAIL, not success. (point 4) |
| diagnostics-redaction (`k3-wise-adapters.test.cjs`) | Persisted diagnostic keeps only status / code / redacted-message / failed-field-**names**; asserts it does **NOT** contain the raw `FNumber`, token, host, `authorityCode`, password, or connection string; any persisted row-correlation key is **mask/hashed** (raw `FNumber` string absent from the serialized diagnostic); a non-UUID `sourceId` is masked too. (point 4 redaction rule) |
| readback-data0-data (`k3-wise-adapters.test.cjs`) | `Data[0].Data` parsed in **both** the readback and the **Save-response** path: a nested-success response → judged succeeded; a nested-failure response → message/code resolved; flat `Data[0].X` unchanged (regression). **Negative control:** revert the `extractBusinessRows` unwrap → the nested-success test fails, proving the fix. (point 5) |
| save-only-locks (`k3-wise-adapters.test.cjs`) | Submit/Audit/BOM/list/pagination still rejected; `autoSubmit=false`/`autoAudit=false`; no multi-record. (boundaries) |
| secret-scan (existing redaction tests) | General backstop: no sanitized artifact echoes raw secret/host/identifier values. |

The mock K3 server is currently **write-success-only**; the impl PR extends it with an
envelope-200-but-row-level-fail Material/Save response so the diagnostic path is testable
offline.

## 6. Boundaries — remain LOCKED (impl PR must not touch)

Submit · Audit · BOM Save · list/search · pagination · broad read · server-side K3
reference resolver/composition beyond the explicitly-needed Material Save template path ·
production use · multi-record beyond a separately-approved 1–3 record test · direct writes
to K3 core SQL tables. `autoSubmit=false` and `autoAudit=false` remain mandatory.

No second Save-only attempt until patched package **and** a fresh explicit approval on
#1792. See the companion verification doc:
`integration-k3wise-m1-material-save-failure-fix-verification-20260527.md`.
