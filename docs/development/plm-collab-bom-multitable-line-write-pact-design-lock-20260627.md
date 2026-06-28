# Design-Lock — PLM-COLLAB P3 BOM Multitable Line Write-Back Consumer Pact (方案1)

Date: 2026-06-27
Status: LOCKED (consumer contract) — provider endpoint NOT yet built (downstream obligation, see below)
Consumer: `Metasheet2`  ·  Provider: `YuantusPLM`
Branch: `claude/plm-bom-multitable-line-write-pact-20260627`

## 1. Decision

Owner selected **方案1 — the thinnest consumer contract**: a single line-addressed PATCH that
locks only the minimal SUCCESS shape of a BOM multi-table cell edit. Nothing beyond that minimal
surface is added to the broker artifact in this slice.

The P3 multi-table surface was read-only until now (`getBomMultitableContext` →
`GET /api/v1/bom/multitable/{partId}/context`). This adds the **first write-back method** on that
surface, as a consumer Pact only.

## 2. Locked contract

**Path (line-addressed):**
```
PATCH /api/v1/bom/multitable/{part_id}/lines/{bom_line_id}
```
- `bom_line_id` selects the specific line; `part_id` is the **context boundary** only.
- The provider must (in a future slice) validate that the line belongs to the part. This consumer
  pact does NOT lock that validation — it locks the minimal success contract only.

**Request body — whitelist of exactly four editable business cells, all optional:**
```
{ "quantity", "uom", "find_num", "refdes" }
```
- These are exactly the editable cells of `BomMultitableLine` (`quantity` numeric in the read model;
  `uom` / `find_num` / `refdes` strings). The consumer patch type accepts `number | string | null`
  for `quantity` (editor hands a string pre-coercion); `null` is a legitimate "clear this cell" edit.
- The local adapter **rejects an empty body** (a PATCH that changes nothing) BEFORE issuing any
  request, and **strips any key outside the whitelist** so it can never reach the provider.

**Response — thinnest envelope:**
```
{ "ok": true, "bom_line_id": "..." }
```
- `eco_id` / `source_version` / `applied` are **DEFERRED** to the real provider endpoint design and
  are deliberately NOT part of this consumer contract.

**Scope: SUCCESS interaction ONLY.**
- No 403 / unauthorized / error interaction is added. Rationale: a 403 interaction would widen the
  YuantusPLM provider-verifier surface, and the consumer does not yet depend on that error shape.
  Permission / unauthorized handling waits until the provider endpoint or the UI write path truly
  arrives.

## 3. Implementation

- `packages/core-backend/src/data-adapters/PLMAdapter.ts`
  - New consumer types `BomMultitableLinePatch` and `BomMultitableLineUpdateResult`.
  - New method `updateBomMultitableLine(partId, bomLineId, patch)`:
    1. builds payload from ONLY the four whitelisted keys that are `!== undefined`;
    2. if payload has 0 keys → returns `{ data: [], error }` with the fixed message
       `updateBomMultitableLine requires at least one of quantity, uom, find_num, refdes`,
       BEFORE any mock/network branch;
    3. mockMode → `{ data: [{ ok: true, bom_line_id }], metadata: { totalCount: 1 } }`;
    4. `apiMode !== 'yuantus'` guard (legacy/mock-non-yuantus unsupported affordance, no request);
    5. `this.select<...>(`/api/v1/bom/multitable/${partId}/lines/${bomLineId}`, { method: 'PATCH', data: payload })`.
  - The method body contains the exact path template literal so the pact drift-guard passes.
- `packages/core-backend/tests/contract/pacts/metasheet2-yuantus-plm.json`
  - New success interaction INSERTED between `.../context` and `.../embed-token` (so JSON order ==
    concatenated `PACT_PATHS` order). Fresh part/line ids `01H000000000000000000000P4` /
    `01H000000000000000000000R8`. Headers mirror context/embed-token (Authorization Bearer + regex
    matcher, `x-tenant-id: tenant-1`, plus `Content-Type: application/json` on the request body).
    `type` matchers on the four request cells and on response `$.ok` / `$.bom_line_id`.
- `packages/core-backend/tests/contract/plm-adapter-yuantus.pact.test.ts`
  - PATCH appended to END of `PLM_ADAPTER_PACT_PATHS`; callsite template added to `endpointsToFind`;
    one new `it()` locking method=PATCH, provider-state present, request keys exactly
    `['find_num','quantity','refdes','uom']`, response exactly `{ ok:true, bom_line_id:'…R8' }`
    (asserts NO `eco_id`/`source_version`/`applied`), and EXACTLY ONE interaction for this path with
    status 200 (success-only).
- `packages/core-backend/tests/unit/plm-adapter-bom-multitable.test.ts`
  - Load-bearing runtime verification (the pact test only does string `.includes` on the source).
    New cases: empty / only-undefined patch → error + `select` NOT called; unknown-key stripped
    (only whitelisted keys reach `select`); valid yuantus patch → `select` called once with
    method `PATCH`, the `/api/v1/bom/multitable/P4/lines/R8` path, and only whitelisted keys; `null`
    cell kept (real clear edit); mock + legacy affordances issue no request.

## 4. Deferrals / downstream obligations

- **Provider verifier expectation for an endpoint that does not exist yet.** Landing this consumer
  pact adds a YuantusPLM provider-verifier expectation for `PATCH .../lines/{bom_line_id}`. This is
  consciously **minimized to success-only** so the provider surface stays as small as possible until
  the real endpoint is designed. The provider side must implement the route and satisfy this state.
- Provider must validate `line ∈ part` (NOT in this consumer contract).
- `eco_id` / `source_version` / `applied` left to the provider endpoint design.
- The HTTP route and the UI write path are NOT built in this slice.
- Capability-manifest gating for the write is DEFERRED.
- 403 / unauthorized contract DEFERRED (success-only by design).

## 5. Verification (local, `/tmp/ms2-bompact`)

- Pact contract test: `vitest run tests/contract/plm-adapter-yuantus.pact.test.ts` → 16/16 pass
  (order oracle + provider-state + drift-guard + new success-only it() all green).
- Adapter unit test: `vitest run tests/unit/plm-adapter-bom-multitable.test.ts` → 17/17 pass
  (10 existing read cases + 7 new runtime write cases).
- Typecheck: `pnpm --filter @metasheet/core-backend run type-check` (`tsc --noEmit`) → exit 0.

## 6. CI (`.github/workflows/yuantus-pact-consumer.yml`) — observed, NOT modified

- Triggers on PR-to-main (both `PLMAdapter.ts` and `tests/contract/**` paths are touched).
- Does NOT hard-fail when broker secrets are absent: the publish step runs only on `push` to
  `refs/heads/main` (never on PR), is `continue-on-error: true`, and shell-guards `exit 0` when
  `PACT_BROKER_BASE_URL` is unset — it no-ops/skips as designed. The only failure path is
  base-url-set-but-token-empty (misconfiguration, not absence).
- Not a required check (repo branch protection requires `contracts (strict/dashboard/openapi)`,
  `pr-validate`, `test (20.x)`; `yuantus-pact-consumer` is not among them).
- Note: this workflow's PR run executes `test:contract` (covers the new pact test) but for unit only
  runs `plm-adapter-yuantus.test.ts` — it does NOT run `plm-adapter-bom-multitable.test.ts`; those
  new runtime cases are exercised by the required `test (20.x)` job instead.
