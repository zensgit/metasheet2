# K3 read/list + external-system read onboarding — development & verification (2026-06-26)

> Status: **buildable development COMPLETE + verified; remaining surfaces GATED (not unfinished)**. This MD records the full development + verification of the K3 read/list/BOM line and its read-onboarding standardization. Per the line's own plan (the C0–C5 ladder + GATEs), every authorized non-gated slice is shipped. C3 LIST-only and C4 single-level BOM read are now shipped after their customer/operator GATEs; C5 resolver, recursive BOM, and writes remain deliberately frozen behind their own customer/owner GATEs.

## 0. Honest scope

The line's plan gates the broader surfaces on purpose. So "complete the unfinished development" resolves to: **finish everything buildable without crossing a GATE (done), and document the gated remainder with its gate reasons.** No customer/owner GATE was crossed to manufacture "completion." C3 LIST-only was opened only after #1709 customer/operator evidence explicitly requested WebAPI LIST; C4 BOM single-level read was opened only after #3399's shape-first GATE-front and a separate owner runtime opt-in. C5 resolver, recursive BOM, and writes remain locked.

## 1. Development delivered (merged, with SHAs)

**Runtime (read-only, single-record):**
- `#1868` (`80c2f7bcd`) — K3 `Material/GetDetail` read-only smoke in the adapter (gated on the material object declaring `operations:['read']`; default stays upsert-only → dormant/read-only/fail-closed; reference-object harvest).
- `#3229` (`5afc0d1c5`) — generic read-smoke preset route `POST /api/integration/external-systems/:id/read-smoke` (built-in preset only, backend credential context, forced single read, values-free evidence).
- `#3231` (`0a46345a6`) — tightened the route to `integration:write` (active credentialed probe + existence signal → operator-only).
- `#3241` (`d63a9c18d`) — non-persisted in-memory read-config overlay (lets a target-side K3 system run the read-smoke without persisting `material` read config; stored system untouched).

**Contract track (C0–C2 + lock):**
- `#3242` (`37db9ba2b`) — **C0** design-lock: next-slice contract/evidence/boundary; LIST/BOM/etc. contract-only.
- `#3245` (`815a27005`) — **C1** contract normalizer + preset allowlist metadata (reconciles `{presetId,key}` ⇄ `{presetId,intent}`; lock-safe, unwired).
- `#3246` (`12028e5da`) — **C2** wired the normalizer into the route (both shapes → one read; migrated #3229's inline body validation).
- `#3247` (`517b07ed0`) — **C3 acceptance lock**: `buildReadSmokeRequest` must consume `contract.object/mode` before any multi-object/mode widening.
- `#3330` — **C3 LIST-only**: explicit `k3wise.material-list.v1` preset + bounded Material/GetList route/adapter wiring. Single page, preset-owned `Top/PageSize/PageIndex`, rows parsed from `response.Data.DATA`, optional key mapped only to the internal `FNumber` prefix filter, route-only internal marker required before adapter LIST execution, no request-supplied raw filters/cursor/watermark/limit/path/method/payload, values-free evidence, no BOM/resolver/write.
- `#3399` (`c499abe83`) — **C4 BOM GATE-front**: docs-only, redacted live shape intake for BOM read; explicitly no runtime/no BOM call.
- `#3405` (`efa832a08`) — **C4 BOM single-level read runtime**: explicit `k3wise.material-bom.v1` preset + `POST /K3API/BOM/GetDetail`; request body `Data.FBillNo` as a bound JSON value (not `k3_freeform` / not raw Filter); extracts `Data.Page1` header count + `Data.Page2` line rows; one call, no recursion, no material-to-FBillNo resolver, no Save/Submit/Audit/write.

**Standardization:**
- `#3257` (`2f7f82323`) — K3 read/list **GATE v2** + reusable values-free evidence checklist.
- `#3260` (`c0966702c`) — general **external-system read onboarding template** (system-agnostic G0–G5 playbook; K3 as the worked reference).

## 2. Verification

**Focused automated tests (green in these slices):** `read-smoke.test.cjs` (catalog, detail + LIST request builders, route-only LIST marker, preset pins `readListBodyKey:Data`, values-free extraction, prototype-key, C4 BOM preset, BOM success/error evidence sanitizer, leak-bait scrub), `read-smoke-contract.test.cjs` (detail shapes reconcile, LIST-only explicit intent, optional-key-to-internal-filter mapping, fail-closed, raw/injection fields rejected, values-free), `http-routes.test.cjs` `testReadSmokeRoute` (compat + intent success, bounded LIST success, optional-key mapping, preset pins the approved `Data.*` body container over stale stored config, C4 BOM route evidence preservation, no-key BOM 400 before system load, fail-closed paths, write-gate 403, read-failure values-free), `k3-wise-adapters.test.cjs` (#1868 detail read + C3 bounded Material/GetList read + C4 BOM read, route-only LIST/BOM marker, `Top/PageSize/PageIndex`, `Data.DATA`/`Data.Data`, internal `FNumber` filter, `Data.FBillNo` body, `Data.Page1/Page2` extractor, one-call/no-recursion guard). Full plugin suite remains a CI merge gate. *(Independent clean-room re-run through C2: see §2a; C3/C4 add the focused suites above.)*

**Adversarial reviews (per slice, all APPROVE):**
- `#3229` — 9-point battery: values-free (all paths), no-write reachable, fail-closed, prototype-key safe, preset-only, backend credential context, forced single read, system untouched, non-vacuous.
- `#3231` — non-vacuous write-gate guard (READ_USER→403; reverting to `'read'` fails it).
- `#3241` — in-memory overlay (clone, no mutation; non-vacuous).
- `#3245` (C1) — 6-point: no raw-config injection (incl. `__proto__`/prototype keys), reconciliation, fail-closed (LIST/BOM can't enter via intent), values-free, lock-safe/zero-drift, non-vacuous.
- `#3246` (C2) — full route-level: backward-compat, forward shape (same single read), values-free incl. the new 400 path, fail-closed *before* the credentialed call, no-write, backend credential context, write-gated, non-vacuous.
- `#3405` (C4 BOM) — shape-first runtime: `Data.FBillNo` bound JSON value (no expression escaping), `Data.Page1/Page2` extraction, no-key fail-closed before system load, route-only marker, one call/no recursion, no resolver, no Save/Submit/Audit/write, values-free success/error evidence.

**Entity-machine evidence (#3241 retest, values-free):** persisted `material` read config absent → backend restarted → missing-key guard fail-closed → read-smoke HTTP 200, `recordPresent=true` → no raw payload / key / host / token / credential / connection string → no Save/Submit/Audit/BOM/LIST → no production write.

**Entity-machine evidence (C3 LIST, values-free):** #3390 on-prem package reruns PASS for no-key and keyed Material/GetList. No-key: `recordPresent=true`, `recordCount=10`, `dataRowCount=30134`, `dataDataPresent=true`, `listShapeProbe.dataPascalData=true`. Keyed: `recordPresent=true`, `recordCount=1`, `dataRowCount=1`, `sampleKeyEchoed=false`, `presetOwnedFilterShapeWorks=true`. No raw Filter, no row values, no BOM/resolver/write.

**Entity-machine evidence (C4 BOM, values-free):** on-prem release `multitable-onprem-k3-c4-bom-read-20260630-efa832a08` (package provenance `gitCommit=efa832a08d560e3ddd983da0096ce89cf4c213ae`) deployed and healthchecked; exactly one C4 BOM read-smoke with owner-approved private `FBillNo` PASSed: `httpStatus=200`, `responseOk=true`, `apiOk=true`, `presetId=k3wise.material-bom.v1`, `mode=bom`, `bomKeyEchoed=false`, `recordPresent=true`, `recordCount=3`, `bomHeaderCount=1`, `bomLineCount=3`, `bomShapeProbe.dataPage1=true`, `bomShapeProbe.dataPage2=true`, `bomResponseShapeProbe.fixedContainers.dataPage1.type=array length=1`, `bomResponseShapeProbe.fixedContainers.dataPage2.type=array length=3`. No raw payload, no row values, no material/BOM key echo, no resolver, no Save/Submit/Audit/write.

**Boundaries verified:** read-only; write-gated (operator-only); values-free on success/failure/validation-error; dormant/fail-closed by default; preset/allowlist-only (no request-supplied raw path/method/payload/config); backend credential context (never the public response); in-memory overlay (stored system role/config untouched); both detail request shapes reconcile to one read; C3 LIST consumes the normalized `contract.object/mode` and dispatches only to the allowlisted bounded Material/GetList preset; adapter LIST execution requires the internal read-smoke marker so persisted `readMode:list` cannot activate LIST from other read paths; C4 BOM consumes the same normalized contract, dispatches only to the allowlisted `material-bom` preset, uses bound `Data.FBillNo`, and performs no recursion/resolver/write.

### 2a. Independent clean-room verification (pre-C3 baseline)

A separate adversarial pass re-verified the C0–C2 baseline on fresh `origin/main` (own throwaway worktree, full re-run) — **all dimensions PASS, no discrepancy**. That historical pass is kept here as the baseline before C3 LIST and C4 BOM were authorized. It verified the write gate, values-free validation/error evidence, in-memory overlay, no persistence, and no write/BOM/runtime widening at the time. The later C3 LIST-only and C4 BOM single-level runtimes are covered by their focused tests, CI, reviews, package evidence, and entity-machine reruns in §2.

## 3. Gated / not built (with reasons) — NOT unfinished-buildable

| Surface | State | Gate reason |
| --- | --- | --- |
| C3 — WebAPI LIST | shipped (LIST-only) | opened by #1709 customer/operator GATE; bounded Material/GetList only, values-free |
| C4 — BOM read | shipped (single-level read only) | opened by #3399 shape-first GATE-front + owner runtime opt-in; one `BOM/GetDetail` call only, values-free |
| BOM recursive multi-level expansion | frozen (locked) | separate fan-out/request-amplification gate; single-level C4 PASS does not authorize recursion |
| material→FBillNo resolver / server-side composition | frozen (locked) | explicit owner unlock + named demand; not inferred from BOM read-smoke |
| C5 — resolver / server-side composition | frozen (locked) | explicit owner unlock + named demand |
| Save / Submit / Audit / production / external write | frozen | separate owner authorization (FOS-P4-style write gate); a read GATE never authorizes a write |
| Live K3 beyond the verified read-smokes | gated | customer GATE packet / owner opt-in for each new surface; C3 LIST and C4 single-level BOM read are the only live read-smokes recorded here |

## 4. Conclusion

The K3 read/list/BOM line is **developed and verified through C4 single-level BOM read** (single-record Material/GetDetail read-smoke + bounded Material/GetList no-key/keyed + one-call BOM/GetDetail, write-gated, values-free, dormant/fail-closed), and the read-onboarding pattern is **standardized** (GATE v2 + reusable evidence checklist + general template). The remaining surfaces are **gated by the plan**, not undone development — advancing them requires external authorization (recursive BOM, resolver/server-side composition, and any write), not further coding. No resolver/write gate was crossed to reach this state.
