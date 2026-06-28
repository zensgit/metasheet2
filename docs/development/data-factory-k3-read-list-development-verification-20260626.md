# K3 read/list + external-system read onboarding — development & verification (2026-06-26)

> Status: **buildable development COMPLETE + verified; remaining surfaces GATED (not unfinished)**. This MD records the full development + verification of the K3 read/list line and its read-onboarding standardization. Per the line's own plan (the C0–C5 ladder + GATEs), every authorized non-gated slice is shipped. C3 LIST-only is now shipped after the customer/operator GATE; C4/C5/writes/live remain deliberately frozen behind their own customer/owner GATEs.

## 0. Honest scope

The line's plan gates the broader surfaces on purpose. So "complete the unfinished development" resolves to: **finish everything buildable without crossing a GATE (done), and document the gated remainder with its gate reasons.** No customer/owner GATE was crossed to manufacture "completion." C3 LIST-only was opened only after #1709 customer/operator evidence explicitly requested WebAPI LIST while keeping C4 BOM, C5 resolver, and writes locked.

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
- `#3324` — **C3 LIST-only**: explicit `k3wise.material-list.v1` preset + bounded Material/List route/adapter wiring. Single page, preset-owned `PageIndex/PageSize`, no request-supplied filters/cursor/watermark/limit/path/method/payload, values-free evidence, no BOM/resolver/write.

**Standardization:**
- `#3257` (`2f7f82323`) — K3 read/list **GATE v2** + reusable values-free evidence checklist.
- `#3260` (`c0966702c`) — general **external-system read onboarding template** (system-agnostic G0–G5 playbook; K3 as the worked reference).

## 2. Verification

**Focused automated tests (green in this slice):** `read-smoke.test.cjs` (catalog, detail + LIST request builders, values-free extraction, prototype-key, frozen), `read-smoke-contract.test.cjs` (detail shapes reconcile, LIST-only explicit intent, fail-closed, raw/injection fields rejected, values-free), `http-routes.test.cjs` `testReadSmokeRoute` (compat + intent success, bounded LIST success, fail-closed paths, write-gate 403, read-failure values-free), `k3-wise-adapters.test.cjs` (#1868 detail read + C3 bounded Material/List read). Full plugin suite remains a CI merge gate. *(Independent clean-room re-run through C2: see §2a; C3 adds the focused suites above.)*

**Adversarial reviews (per slice, all APPROVE):**
- `#3229` — 9-point battery: values-free (all paths), no-write reachable, fail-closed, prototype-key safe, preset-only, backend credential context, forced single read, system untouched, non-vacuous.
- `#3231` — non-vacuous write-gate guard (READ_USER→403; reverting to `'read'` fails it).
- `#3241` — in-memory overlay (clone, no mutation; non-vacuous).
- `#3245` (C1) — 6-point: no raw-config injection (incl. `__proto__`/prototype keys), reconciliation, fail-closed (LIST/BOM can't enter via intent), values-free, lock-safe/zero-drift, non-vacuous.
- `#3246` (C2) — full route-level: backward-compat, forward shape (same single read), values-free incl. the new 400 path, fail-closed *before* the credentialed call, no-write, backend credential context, write-gated, non-vacuous.

**Entity-machine evidence (#3241 retest, values-free):** persisted `material` read config absent → backend restarted → missing-key guard fail-closed → read-smoke HTTP 200, `recordPresent=true` → no raw payload / key / host / token / credential / connection string → no Save/Submit/Audit/BOM/LIST → no production write.

**Boundaries verified:** read-only; write-gated (operator-only); values-free on success/failure/validation-error; dormant/fail-closed by default; preset/allowlist-only (no request-supplied raw path/method/payload/config); backend credential context (never the public response); in-memory overlay (stored system role/config untouched); both detail request shapes reconcile to one read; C3 LIST consumes the normalized `contract.object/mode` and dispatches only to the allowlisted bounded Material/List preset.

### 2a. Independent clean-room verification (pre-C3 baseline)

A separate adversarial pass re-verified the C0–C2 baseline on fresh `origin/main` (own throwaway worktree, full re-run) — **all dimensions PASS, no discrepancy**. That historical pass is kept here as the baseline before C3 LIST was authorized. It verified the write gate, values-free validation/error evidence, in-memory overlay, no persistence, and no write/BOM/runtime widening at the time. The C3 LIST-only runtime added by `#3324` is covered by the focused and full plugin test runs in §2, not by this older clean-room pass.

## 3. Gated / not built (with reasons) — NOT unfinished-buildable

| Surface | State | Gate reason |
| --- | --- | --- |
| C3 — WebAPI LIST | shipped (LIST-only) | opened by #1709 customer/operator GATE; bounded Material/List only, values-free |
| C4 — BOM read | frozen (locked) | BOM-specific request/response + relationship semantics; own slice (must not ride a Material PR) |
| C5 — resolver / server-side composition | frozen (locked) | explicit owner unlock + named demand |
| Save / Submit / Audit / production / external write | frozen | separate owner authorization (FOS-P4-style write gate); a read GATE never authorizes a write |
| Live K3 (any of the above, executed for real) | gated | customer GATE packet (credentials/network/PLM source/field mapping) |

## 4. Conclusion

The K3 read/list line is **developed and verified through C3 LIST-only** (single-record read-smoke + bounded Material/List, write-gated, values-free, dormant/fail-closed), and the read-onboarding pattern is **standardized** (GATE v2 + reusable evidence checklist + general template). The remaining surfaces are **gated by the plan**, not undone development — advancing them requires external authorization (customer GATE evidence for C4/C5, owner authorization for any write), not further coding. No locked BOM/resolver/write gate was crossed to reach this state.
