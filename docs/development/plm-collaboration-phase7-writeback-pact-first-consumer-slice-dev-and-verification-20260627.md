# PLM Collaboration Phase 7 — Governed Write-Back, Pact-First Slice (consumer-only) — Development & Verification

- Date: 2026-06-27
- Repo: **metasheet2 (consumer) ONLY.** YuantusPLM (provider) is **not touched** in this slice.
- Line: Phase 7 governed BOM write-back — **Slice 1 = the consumer-first write pact** (the contract before the code).
- Scope decision: **Option A (consumer-only pact preparation)**, owner-ratified. Build the consumer write contract; do **not** sync to Yuantus, do **not** publish to the broker, do **not** implement provider mutation.

## 0. Why consumer-only (the load-bearing CI constraint)

A consumer-first pact normally relies on the broker's **pending-pacts** feature so a new consumer interaction does not break the provider until the provider implements it. **Yuantus deliberately disabled pending** — its provider verifier (`pytest test_pact_provider_yuantus_plm.py`) is a non-`continue-on-error` CI gate with **no pending/WIP/allowlist mechanism**, and an anti-defang meta-gate (`test_ci_contracts_pact_provider_gate.py`) pins the broker selectors to `mainBranch` with no pending flags. So **syncing a not-yet-implemented write-back interaction into Yuantus would turn its always-on CI red**, and the endpoint that would satisfy it is explicitly out of scope. Therefore this slice ships the contract **consumer-side only**; the Yuantus sync + broker publish + provider verifier are deferred to the (separately authorized) provider-endpoint slice. metasheet2's own consumer CI (`yuantus-pact-consumer.yml`) runs a **static** `test:contract` and does **not** publish to a broker, so this lands green on both sides.

## 1. Decision surface (from the Phase 7 design `#884`)

- **Fork 1 — governed seam:** **(A) route through ECO change control** (owner: "go ECO"). The consumer expresses *intent*; the provider routes it through ECO governance in the deferred endpoint slice.
- **Fork 2 — write authorization (ratified):** permission `"Part BOM"` / `AMLAction.update`; write `feature_key` `bom_multitable_writeback` (app/SKU `plm.bom_multitable_writeback`). A **write-scoped** authorization — never the read embed token.
- **Fork 3 — the write pact:** required, sequenced first = **this slice**.

## 2. What was built (metasheet2 consumer, code-grounded)

All under `packages/core-backend/`:
- **`PLMAdapter.writeBackBomMultitableLine(partId, bomLineId, changes)`** (`src/data-adapters/PLMAdapter.ts`) — relays a governed BOM line-field write-back intent as `PATCH /api/v1/bom/multitable/{partId}/lines/{bomLineId}` via `this.select(..., { method: 'PATCH', data: changes })`, addressed by the stable `bomLineId`. `mockMode` returns `{ ok, bom_line_id }`; non-yuantus → an error without a call. New return type `BomMultitableWriteBackResponse { ok, bom_line_id }` (thin — provider detail like a governed ECO id is the deferred provider slice's to define).
- **Pact interaction** (`tests/contract/pacts/metasheet2-yuantus-plm.json`) — one **success** PATCH interaction: request body `{ quantity: 2, uom: "EA" }` (type-matched), provider-state names a `plm.bom_multitable_writeback` **write-scoped** authorization, `Authorization: Bearer …` (regex-matched) + `x-tenant-id`; response `200 { ok: true, bom_line_id }` (type-matched).
- **Guard updates** (`tests/contract/plm-adapter-yuantus.pact.test.ts`) — added the PATCH entry to `PLM_ADAPTER_PACT_PATHS` (correct order, composed into `PACT_PATHS`) + the path to `endpointsToFind`.
- **Focused unit test** (`tests/unit/plm-adapter-yuantus.test.ts`) — locks the write-back API shape (PATCH to the `/lines/` path, body = the change intent) and that it carries **no read embed-token header**; plus a non-yuantus refusal.

## 3. The four implementation guards — honored

1. **Path/method:** `PATCH /api/v1/bom/multitable/{part_id}/lines/{bom_line_id}` — same namespace as the read `…/context`, consistent with the existing `updateCadProperties` / `updateCadViewState` PATCH writes. ✅
2. **Non-empty success fixture:** the success body carries `{ quantity: 2, uom: "EA" }` (fields all optional in the type, but the fixture is non-empty) so "empty PATCH success" is **not** written into a future provider obligation. ✅
3. **`feature_key` not in body:** `bom_multitable_writeback` is expressed as a **write-scoped authorization** via the provider-state name + the `Authorization` fixture; the body carries **only** the BOM line change intent. ✅
4. **Real symbol:** updated the actual `PACT_PATHS` (via `PLM_ADAPTER_PACT_PATHS`) + `endpointsToFind`. ✅

Negatives (read-token-rejected / unentitled / unpermitted / lifecycle / cross-tenant / replay) are **deliberately NOT in the committed pact** — they are the provider-endpoint slice's verifier responsibility, and adding them now would redden Yuantus's strict always-on gate. The "read token ≠ write token" invariant is enforced **consumer-internally** (the relay), not on the pact wire, and is locked here by the unit test asserting no embed-token header on the write.

## 4. Verification (reproducible)

Worktree off `origin/main` (`342c7160b`); `node_modules` reused from the main checkout via symlink.

```bash
cd packages/core-backend
npx tsc --noEmit                                                   # 0 errors
npm run test:contract                                              # 19/19 green (pact guard: count/order/endpointsToFind)
npx vitest run tests/unit/plm-adapter-yuantus.test.ts             # 25/25 green (23 existing + 2 new write-back)
```
- **Typecheck:** clean (0 TS errors).
- **`test:contract`:** 19/19 — interaction count == `PACT_PATHS.length`, order matches, every path appears in `PLMAdapter.ts`, embed-token doc test intact.
- **Unit:** 25/25 — the 2 new tests lock the write-back shape + no-embed-token-header guard.
- Pact JSON validated (`JSON.parse`).
- Baseline (pre-change) `test:contract` was 19/19 green before the slice (the new interaction + its PACT_PATHS entry keep the count balanced).

## 5. Boundaries / out of scope (deferred, each separately authorized)

- **No Yuantus change** — its committed pact, provider verifier, and broker publication are **untouched** (kept green; no pending-gate fight).
- **No provider mutation** — the governed write endpoint (Fork 1 ECO seam + lifecycle guard + write-token scope/provider-side single-use + audit/idempotency) is the next slice.
- **No broker publish** of this consumer pact until the provider endpoint exists (otherwise Yuantus broker-verify, when active, would pull it and fail).
- **No negatives in the committed pact**; **Phase 6 SSO** remains deferred.

## 6. Re-entry (the next authorized slice)

Provider-endpoint slice: build the Yuantus governed write endpoint routing through ECO (Fork 1), enforcing `is_entitled(bom_multitable_writeback)` + `check_permission("Part BOM", update)` + lifecycle guard + write-token scope + provider-side single-use + audit/idempotency; then **sync** this consumer pact into Yuantus + the provider verifier interaction (+ negatives), and only then publish to the broker. That is the slice that turns this contract into an end-to-end-verified write seam.

## 7. Conclusion

The Phase 7 governed write-back **contract** now exists, consumer-first, in metasheet2 — a thin, owner-ratified success PATCH interaction + the `PLMAdapter` relay method + guard/unit coverage — verified green (`test:contract` 19/19, unit 25/25, tsc clean) **without touching Yuantus, without publishing to the broker, and without implementing provider mutation**. The provider seam, the broker publish, and the negative-path coverage are the deferred, separately-authorized provider-endpoint slice.
