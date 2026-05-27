# K3 WISE M1 Material Save-only failure fix — Verification (2026-05-27)

Issue: #1792 · Design: `integration-k3wise-m1-material-save-failure-fix-design-20260527.md`

This is the verification companion to a **docs-only design PR**. It (V1) confirms this PR
changes no runtime, (V2) grounds the design's current-state claims against the code on
`main`, and (V3) records how the **implementation** PR will be verified.

## V1. This PR is docs-only

This PR adds exactly two Markdown files under `docs/development/` and changes no runtime,
config, or test:

```
$ git diff --name-only origin/main...HEAD
docs/development/integration-k3wise-m1-material-save-failure-fix-design-20260527.md
docs/development/integration-k3wise-m1-material-save-failure-fix-verification-20260527.md
```

No `plugins/`, `apps/`, `packages/`, or `scripts/` change. No package rebuild. The
runtime fix lands in a separate implementation PR (design §4), after which a patched
package and a **fresh explicit approval** gate any second Save-only attempt.

## V2. Design claims are grounded in current code (not speculation)

The design's "current state" (§2) is verifiable against `main`:

| Design claim | Anchor on `main` |
|---|---|
| Generic `k3wise.material.v1` already declares the unit/account family as `type: reference` | `plugins/plugin-integration-core/lib/adapters/k3-wise-document-templates.cjs:91`, fields `:110–118` (`FUnitGroupID`/`FBaseUnitID`/`FOrderUnitID`/`FSaleUnitID`/`FProductUnitID`/`FStoreUnitID`/`FAcctID`/`FSaleAcctID`/`FCostAcctID`) |
| A row-level Save success gate already exists (#1813) — envelope-200 ≠ success | `k3-wise-webapi-adapter.cjs:172` `getStatusCode`, `:190` `businessRowMessage`, `:204–281` `FStatus`/`IsSuccess`/`businessTextIndicatesFailure` |
| Readback already unwraps nested detail | `k3-wise-webapi-adapter.cjs:546` `const detail = isPlainObject(element.Data) ? element.Data : element` |
| Missing customer fields (G2) — `FErpClsID`/`FUseState`/quality-modes/strategies not in the template | absent from `k3-wise-document-templates.cjs` material field list (`:107–118`) |
| FBaseUnitID-centric default mapping (G4) | `apps/web/src/services/integration/k3WiseSetup.ts`, `apps/web/src/views/IntegrationWorkbenchView.vue` reference `FBaseUnitID` |

This matters: the fix is a **customer-profiled preset + missing fields + per-field shape +
richer sanitized diagnostics + readback confirmation** — not "the template is missing."
Framing the impl PR on the real gaps avoids reworking code that already works (the success
gate correctly *failed* M1).

## V3. How the implementation PR will be verified (test plan)

The impl PR must ship the tests in design §5. Each maps to a boundary or a hard rule:

- **R-OPTIN** → `preset-opt-in`: `material-k3wise-customer-profile-v1` applies only on
  explicit selection; `k3wise.material.v1` byte-stable / unchanged behavior when not opted in.
- **R-REDACT** → `diagnostics-redaction`: on envelope-200-but-row-fail, the persisted
  diagnostic contains only status / code / redacted-message / failed-field-**names**, and a
  string scan asserts it does **not** contain the raw `FNumber`, token, host, `authorityCode`,
  password, or connection string.
- `no-hardcoded-values`: the preset declares structure only; no concrete dictionary value.
- `base-data-object-shaping`: numbered → `{FNumber,FName}`, enum/category → `{FID,FName}`.
- `envelope-200-row-fail`: adapter reports FAIL (mock K3 server extended to return
  200/`Successful` with row `FStatus=false` — it is currently write-success-only).
- `readback-data0-data`: `Data[0].Data` nested shape parsed.
- `save-only-locks`: Submit/Audit/BOM/list/pagination rejected; `autoSubmit=false`/
  `autoAudit=false`; no multi-record.

These run under the existing backend test runner (`__tests__/k3-wise-adapters.test.cjs`,
`scripts/ops/fixtures/integration-k3wise/mock-k3-webapi-server.test.mjs`); no live K3.

## V4. Boundaries (unchanged)

M0 remains PASS. M1 is FAIL-with-diagnostics; **no retry**. The impl PR does not approve or
implement Submit / Audit / BOM Save / list-search / pagination / broad read / server-side
reference resolver beyond the needed Material Save path / production / multi-record / direct
K3 SQL. `autoSubmit=false` and `autoAudit=false` mandatory. The second Save-only attempt is
gated on a merged impl PR **plus** a patched package **plus** a fresh explicit approval on
#1792. This PR is **not merged** — it waits for review.
