# DF-T2c — authoring → real preview wire (verification, 2026-05-28)

Third DF-T2 slice (design #2017; builds on T2a derive #2023 + T2b authoring UI #2027). Wires the
authoring component into the workbench, driven by a **real derived draft** from a **read-only
route that reuses T2a**, so the **preview request truly carries the authored `payloadTemplate` +
`fieldRules`**. Still no K3 write. Left for review.

## Hard acceptance (all met)

| Requirement | How |
|---|---|
| Mount `MetaIntegrationFieldRuleAuthoring` in the workbench | Mounted in the payload-preview panel of `IntegrationWorkbenchView.vue`, fed by the derived draft. |
| Real derived draft, **not fixture-only** | New **read-only** `POST /api/integration/templates/derive` runs the **T2a** helper (`deriveK3MaterialTemplateDraft`) on the operator's pasted `payloadTemplate` → returns the **values-free** `{ fieldRules, gatedFields, evidence }` (**P1: NOT** the raw `payloadTemplate` — `summarizeTemplateForEvidence` strips values; customer values never come back over the wire). **Reuses T2a — no duplication.** |
| Preview request truly carries authored `payloadTemplate` + `fieldRules` | `previewPayload()` sends `request.payloadTemplate` + `request.fieldRules = authoredFieldRules` (the derived **and edited** rules) when present (else the legacy mapping-derive — byte-compatible with #1970). |
| Test asserts the **request body**, not just render | Frontend keystone asserts the preview POST body's `fieldRules` carries the **edited** `FNumber.sourceField = 'materialCode'` + `FUnitID` `preserve_template`. **Negative-controlled** (ignore authored rules → assertion fails). |
| No K3 write; no Submit/Audit/BOM/multi-record | Derive route is pure compute (`requireAccess('read')`, no external call/write); preview is no-write; nothing reachable to Submit/Audit/BOM. |
| `payloadTemplate` values not rendered; only the request path | The **authoring component / provenance display render no `payloadTemplate` values** (rules carry field names + shape only — T2b), and the **derive-route response is values-free** (P1). The raw `payloadTemplate` exists only as the operator's own input textarea (operator-local input) and flows into the derive/preview **request bodies** — not into a value-rendering display panel. |

## What shipped

- **Backend** `http-routes.cjs`: `['POST','/api/integration/templates/derive','templatesDerive']` →
  `requireAccess('read')` · 400 `PAYLOAD_TEMPLATE_REQUIRED` if no object · runs `deriveK3MaterialTemplateDraft`
  and returns the **values-free** `{ fieldRules, gatedFields, evidence }` (`summarizeTemplateForEvidence`; **P1:
  the raw `payloadTemplate` is NOT echoed back**) · **fails closed → 400 `TEMPLATE_DERIVE_REJECTED`** on a
  `TemplateDeriveError` (redaction marker / unfilled placeholder / secret-shaped / outer `{Data:…}` envelope —
  the T2a guards). No write.
- **Service** `workbench.ts`: `IntegrationTemplateDraft` + `deriveIntegrationTemplate(payloadTemplate)` → the route.
- **View** `IntegrationWorkbenchView.vue`: `derive-template-draft` button → `deriveTemplateDraft()` (parses the
  pasted template, calls the route, sets `authoredFieldRules`/`authoredGatedFields`, surfaces `deriveError`) ·
  mounts `<MetaIntegrationFieldRuleAuthoring v-model="authoredFieldRules" :gated-fields>` · `previewPayload()`
  sends the authored rules when present.

## Tests (green; vue-tsc clean for changed files)

- **Backend route** (`http-routes.test.cjs`): unauth → 401/403 · `READ_USER` → 200 with the T2a-derived rules
  (FNumber `from_staging`, FUnitID `preserve_template`, FBaseUnitID gated-excluded) · **P1: asserts the response
  has NO `payloadTemplate`, includes a values-free `evidence`, and contains none of the sample values
  (`Widget`/`PCS`)** · 400 on missing `payloadTemplate` · 400 (`TEMPLATE_DERIVE_REJECTED`) on an outer `{Data:…}`
  envelope **and** a redaction marker.
- **Frontend keystone** (`IntegrationWorkbenchView.spec.ts`, 15/15): paste template → **derive fires the route**
  (request carries `payloadTemplate`) → the **real derived draft** drives the authoring UI (reference `FUnitID`
  locked) → edit `FNumber`'s staging column → click preview → **the preview request body carries
  `payloadTemplate` + the authored `fieldRules`** (`FNumber.sourceField='materialCode'`, `FUnitID` preserved).
  **Negative-controlled**: breaking the authored-rules wiring (re-derive from mappings) fails the request-body assertion.
- Neighbors (T2b component spec, integrationWorkbench service spec, plugin route suite) re-run green.

## Boundaries (held)

Read-only derive route (no write/K3/external call); preview no-write; references preserve-only (#1824);
no Submit/Audit/BOM/multi-record; `payloadTemplate` values stay out of display DOM. DF-T2 (K3 customer-profile
authoring) is now end-to-end: T2a derive → T2b author → **T2c wire to real preview**.

## Files

- `plugins/plugin-integration-core/lib/http-routes.cjs` (derive route + handler) + `__tests__/http-routes.test.cjs`
- `apps/web/src/services/integration/workbench.ts` (`deriveIntegrationTemplate` + `IntegrationTemplateDraft`)
- `apps/web/src/views/IntegrationWorkbenchView.vue` (derive button + mount + `previewPayload` authored rules)
- `apps/web/tests/IntegrationWorkbenchView.spec.ts` (the request-body keystone)
