# DF-T1A — connector action metadata contract (verification, 2026-05-28)

First slice of the DF-T template-composition line after DF-T1-0/T1/T1.5 shipped. A
**latent contract** (mirrors #1882's `provenance-contracts.cjs`): it describes and
gates connector actions; it is **not wired to any runtime**, route, or HTTP client.

## Scope (owner-locked)

- A connector **action** = one safe, named operation exposed by a connector profile,
  expressed as metadata around an **existing** adapter method.
- New `lib/connector-action-contracts.cjs` + OpenAPI `ConnectorAction` /
  `ConnectorActionInput` / `ConnectorActionOperation` (parity-locked, **no path** — #1882
  precedent) + the **first K3 sample** + tests + this MD.
- **Latent only**: authorizes no generic HTTP client, no user JavaScript, no SQL, no new
  connector runtime. Does **not** unlock Submit / Audit / BOM / multi-record. Write
  actions are annotated **gated/disabled**, never enabled here. Leave for review.

## Contract + invariants (`normalizeConnectorAction`)

Shape: `actionId` · `connectorKind` · `operation` (enum) · `label?` ·
`request{method, path, inputs{path,query,header,body}}` · `output{recordPath, successPath,
successValue?, errorPath}` · `safety{readOnly, allowBatch, maxRowsPreview, requiresApproval}`
· derived `gated` · `help?`. Three hard invariants:

1. **enum-strict `operation`** — `read` / `preview` / `upsert` / `export` only.
2. **relative-path only** — `request.path` must be `/…`; scheme (`http:`),
   protocol-relative (`//host`), backslashes, and **query (`?`) / fragment (`#`)** are
   rejected → blocks a generic HTTP client / SSRF and forces query/header/body through
   `inputs` (not the endpoint path). (Standalone check; the contract carries no adapter dependency.)
3. **no inline secrets** — inputs reference data by `source` (e.g. `record.FNumber`); an
   inline `value` on any input is rejected (secrets come from the profile's `secretsRef` at
   runtime). `help` free-text is scrubbed through the shared `sanitizeIntegrationPayload`.
4. **write-gating** — the **write set** is `{upsert}` (NOT `!== 'read'`, so the no-write
   `preview`/`export` are not over-gated). A write op MUST set `requiresApproval:true` and
   cannot be `readOnly`; conversely a **non-write op (read/preview/export) MUST set
   `readOnly:true`** (it may not pose as mutating). `gated` is derived `true` for any write
   op or explicit approval. Submit/Audit/BOM are intentionally NOT modeled — they stay
   gated outside this contract.

## First K3 sample (`K3_WISE_MATERIAL_ACTIONS`)

The **existing** K3 WISE WebAPI Material adapter operations, as metadata (output paths
match the adapter's real envelope — `StatusCode`/`Message`; save success via
`Result.ResponseStatus.IsSuccess`):

- `k3wise.material.get-detail` — `read`, `POST /K3API/Material/GetDetail`, body `Number`
  ← `record.FNumber`, **runnable** (`gated:false`).
- `k3wise.material.save` — `upsert`, `POST /K3API/Material/Save`, **gated/disabled**
  (`gated:true`, `requiresApproval:true`) — Save-only stays behind its own approval.

## Tests (`__tests__/connector-action-contracts.test.cjs`, green)

- **OpenAPI parity (load-bearing)**: `ConnectorActionOperation`/`ConnectorAction`/
  `ConnectorActionInput` present; `enum === CONNECTOR_ACTION_OPERATIONS`; `operation.$ref`
  reuses the enum; `additionalProperties:false`; `required` set matches.
- Sample catalog: read runnable / save gated; no inline `value` in sample inputs.
- enum-strict · relative-path (4 rejects incl. `http://`, `//host`, backslash, no-leading-`/`)
  · no-inline-secret (header `value` rejected) · write-gating (upsert without
  `requiresApproval` rejected; write can't be readOnly) · **over-gating guard** (`preview`
  and `export` are NOT gated; write set is `upsert` only) · redaction self-check (a
  `postgres://erp:…@` value in `help` is scrubbed, not stored raw).
- **Negative control (verified)**: reintroducing the buggy `operation !== 'read'` gating
  predicate makes the `preview not gated` assertion fail — proving the over-gating guard is
  load-bearing (the advisor-caught case).
- Re-ran neighbors (provenance-contracts / adapter-contracts / payload-redaction /
  k3-wise-adapters) green — additive change, no breakage.

## Files

- `plugins/plugin-integration-core/lib/connector-action-contracts.cjs` (new, latent)
- `packages/openapi/src/base.yml` (+3 components) · `packages/openapi/dist/*` (regenerated, additive)
- `plugins/plugin-integration-core/__tests__/connector-action-contracts.test.cjs` (new) +
  `package.json` (test chain + `test:connector-action-contracts`)

## Still gated (separate opt-ins, not started)

- **DF-T2** — K3 customer-profile authoring UI (the product surface; consumes this contract).
- DF-T3..T6. The contract is **not imported by any runtime** — wiring it (into preview/
  authoring) is a later opt-in. No K3 write capability added.
