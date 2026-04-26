# Stage 2 (阶段二) Vendor Abstraction Lanes — Plan — 2026-04-26

## 1. Triggering Condition

This plan is **dormant** until the user announces "K3 WISE Live PoC PASS."
No lane in this doc activates pre-PASS — abstracting before validating
the K3 baseline risks baking wrong assumptions into the framework. The
moment GATE PASS is announced, Wave A launches.

## 2. Stage 2 Goals (recap from `integration-erp-platform-roadmap-20260425.md` §4)

> **目标**：用真实复用证明"通用"不是 PPT
> 1. 完成 §2.2 抽离工作（4-6 人天，详见 vendor-abstraction-checklist）
> 2. 接 1 家 ERP 验证可复用性
> 3. 第 2 家 ERP 的接入时间应 ≤ 3 周（如果 ≥ 4 周说明抽离不够好，回流改）
> **决策门槛**：第 2 家 ≤ 3 周成功 = 进入阶段三

This lane plan covers **goal 1 only** (the 4-6 人天 abstraction work).
Goal 2 (the second ERP adapter) is a separate downstream effort, not
decomposed here.

## 3. Lane Inventory

| Lane | Scope | Primary files | Effort | Deps | Parallelism | Validation |
|---|---|---|---|---|---|---|
| **V1 — Per-vendor preflight rules** | Split monolithic K3 preflight script into vendor-agnostic base + per-vendor rule files; add `--vendor=<id>` CLI flag | `scripts/ops/integration-live-poc-preflight.mjs` (new base, vendor split out of existing `integration-k3wise-live-poc-preflight.mjs`); new `scripts/ops/live-poc-preflight-rules/{k3-wise,sap-s4,kingdee-cloud,yonyou-u8}.mjs` | 1.5 人天 | none | ✅ pure parallel | All 8 existing K3 preflight tests green; empty `sap-s4.mjs` loads without error |
| **V2 — Adapter lifecycle declarative** | Add **optional** `getLifecycle()` to adapter contract; runner branches: lifecycle-aware path when declared, fallback to `upsert()` when not. K3 adapter NOT modified in this lane | `plugins/plugin-integration-core/lib/contracts.cjs`, `plugins/plugin-integration-core/lib/pipeline-runner.cjs`, `plugins/plugin-integration-core/__tests__/pipeline-runner.test.cjs` (new mock-adapter cases) | 2.0 人天 | none | ✅ pure parallel | New "lifecycle-aware mock adapter" test passes; existing `e2e-plm-k3wise-writeback` test unchanged green; existing `pipeline-runner.test.cjs` cases green (regression) |
| **V3 — Vendor-scoped error dictionary** | Move user-visible error translations out of K3 adapter & ERP feedback into `lib/error-dictionary/`; provide `translateError(vendor, code, ctx)` with safe fallback | New `plugins/plugin-integration-core/lib/error-dictionary/{index.cjs,k3-wise.json,sap-s4.json,kingdee-cloud.json,yonyou-u8.json}`; edit `plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs`; edit `plugins/plugin-integration-core/lib/erp-feedback.cjs` | 1.0 人天 | none | ✅ pure parallel | `grep` shows no user-facing error text in adapters/erp-feedback; `translateError('unknown', code, ctx)` returns safe fallback (no throw); `k3-wise-adapters.test.cjs` & `erp-feedback.test.cjs` green |
| **V4 — Vendor profile metadata (lite)** | Per-vendor profile JSON (capabilities, requiredConfigKeys, defaultSafety, lifecycle); strict validation only on 3 critical edges (status→active, testConnection, runPipeline) — drafts always saveable | New `plugins/plugin-integration-core/lib/vendor-profiles/{index.cjs,k3-wise.json,sap-s4.json,kingdee-cloud.json,yonyou-u8.json}`; edit `plugins/plugin-integration-core/lib/external-systems.cjs`; edit `plugins/plugin-integration-core/lib/http-routes.cjs` | 1.0 人天 | none — see flag in §6 | ✅ pure parallel (with caveat) | Draft `upsertExternalSystem({status:'inactive', config:{}})` succeeds; `status:'active'` with empty config rejects with missing-key list; `runPipeline` against incomplete-config system writes `invalid-system-config` dead-letter |
| **V5 — Vendor-agnostic contract regression** | New test file asserting base layer (contracts/runner) contains no vendor strings; full `pnpm -F plugin-integration-core test` regression | New `plugins/plugin-integration-core/__tests__/vendor-agnostic-contract.test.cjs`; runs all existing tests | 0.5 人天 | **V1+V2+V3+V4** | 🔴 sequential — gate after Wave A | All existing tests green unchanged; new test asserts `pipeline-runner.cjs`/`contracts.cjs` source contains no `'k3-wise'`/`'sap'`/etc.; `e2e-plm-k3wise-writeback` green; `pnpm validate:plugins` green |

**Total person-day work**: 6.0 人天 (vs. roadmap's 4-6 人天 budget — at
upper edge, justified by V4's added critical-edge validation rigor).

## 4. Recommended Wave Plan

```text
Wave A (parallel, ~2 wallclock days @ 1 dev each):
  V1 (1.5d) || V2 (2.0d) || V3 (1.0d) || V4 (1.0d)
  Wave A wallclock = max(1.5, 2.0, 1.0, 1.0) = 2.0 days

Wave B (sequential gate, 0.5 day):
  V5 — full regression + vendor-agnostic contract test + PR review buffer

Total wallclock: ~2.5 days with 4 parallel devs
Total person-days: 6.0 (matches roadmap upper bound)
```

The checklist's "Day 1 → Day 5" was calendar-style (1 dev sequential = 6
wallclock days). The wave plan above assumes 4 devs available
concurrently. If only 1-2 devs are free, fall back to sequential
ordering: V1 → V2 → V3 → V4 → V5 (V2 first if only 2 devs, since it's
the longest and touches the runner).

**Disjointness verification** (file-conflict matrix grounded in code reads):

- V1 touches only `scripts/ops/...` — disjoint from V2/V3/V4
- V2 touches `pipeline-runner.cjs` + `contracts.cjs` (additive
  `getLifecycle`) — checklist explicitly states K3 adapter unchanged
- V3 touches `adapters/k3-wise-webapi-adapter.cjs` + `erp-feedback.cjs`
  — neither touched by V2 or V4
- V4 touches `external-systems.cjs` + `http-routes.cjs` — disjoint from
  V1/V2/V3

## 5. Recommended Second-ERP Target

**金蝶 K3 Cloud / 星空** (Kingdee Cloud Galaxy).

Rationale: Same vendor family as K3 WISE — field-mapping intuition
(`FNumber` / `FName` family), object names (material / BOM), and customer
ergonomics carry over. Auth model is REST + signed token (cleaner than
K3 WISE's session cookie), giving us a chance to exercise the new
`getLifecycle()` declaration path without re-confronting K3 WISE's
quirks. Validates "abstraction works for the next vendor in the same
lineage" before spending budget on a fundamentally different ERP
(SAP / U8) where a failure would conflate "abstraction is wrong" with
"this ERP is genuinely different." If 金蝶云星空 接入 ≤ 3 weeks,
abstraction is proven; the 4-week threshold from the roadmap then
applies cleanly. SAP S/4 and 用友 U8 belong to the second slot in Stage
2 (or Stage 3) once the first reuse is validated.

## 6. Pre-PASS Checklist (confirm before Wave A starts)

- [ ] **K3 PoC PASS announcement received** in writing from customer
  GATE.
- [ ] **V4 ambiguity resolved**: confirm whether the runPipeline-time
  `requiredConfigKeys` check is implemented inside `external-systems.cjs`
  (registry-side, lazy validation when `getExternalSystem` is called by
  the runner) **or** inside `pipeline-runner.cjs` (runner-side explicit
  `validateAgainstProfile` call). The checklist locates V4's runPipeline
  check in `external-systems.cjs` / `http-routes.cjs`. If implementation
  drifts into `pipeline-runner.cjs`, V2 and V4 become 🟡 partial overlap
  (file conflict) and need ordering. **Recommended**: keep validation in
  the registry layer to preserve V2/V4 disjointness.
- [ ] **erp-feedback `FNumber` leak**: V3 covers user-facing error-string
  translations, but `lib/erp-feedback.cjs` lines 143 & 165 hardcode
  `FNumber` as a key-field fallback. Decide before Wave A whether
  key-field genericization is in V3, V4 (vendor profile `keyField`
  lookup), or a follow-up. Recommend folding into V4 (key-field comes
  from vendor profile, with fallback to existing behavior for backwards
  compat).
- [ ] **Adapter registration in `index.cjs`**: confirm V4's profile
  loading does NOT change the existing
  `registerAdapter('erp:k3-wise-webapi', ...)` wiring — adapter `kind`
  and profile `vendor` may differ (`erp:k3-wise-webapi` adapter kind vs.
  `k3-wise` profile id). Decide naming convention before V4 starts.
- [ ] **Test infra**: `pnpm -F plugin-integration-core test` baseline
  green on the PoC-PASS commit (snapshot for V5 regression).
- [ ] **Runbook update**: `packages/core-backend/claudedocs/integration-plm-k3wise-mvp.md`
  (#1155 runbook) referenced in roadmap §7 — verify it links to this
  lane plan once Wave A starts.

## 7. Out of Scope for Stage 2 (Stage 3+)

Explicitly **NOT** in this plan, deferred per roadmap §2.3:

- Vendor profile **registry** (heavy version: web UI, runtime CRUD,
  tenant-scoped overrides) — Stage 2 ships only static JSON files.
- Schema catalog full population (per-vendor field dictionaries beyond
  skeletal `schema` arrays) — Stage 3.
- Adapter Builder (visual no-code REST adapter generator) — Stage 3.
- Adapter marketplace (third-party adapter publishing / install /
  version) — Stage 4.
- Multi-ERP simultaneous-connection scope isolation — Stage 3.
- Second ERP's actual adapter implementation (金蝶云星空 adapter
  package) — separate Stage 2 sub-effort downstream of V5.

## 8. Open ambiguities flagged for design call

Three items from the agent recon that need a quick design judgement
before Wave A:

1. **V4 validation location**: registry-side (`external-systems.cjs`) or
   runner-side (`pipeline-runner.cjs`). Affects V2/V4 parallelism.
   Recommend registry-side.
2. **`erp-feedback.cjs` hardcoded `FNumber` (lines 143, 165)**: not
   covered by V3's translation scope; recommend folding into V4 via
   vendor-profile `keyField` lookup with backwards-compat fallback.
3. **Adapter `kind` vs. profile `vendor` naming**: `erp:k3-wise-webapi`
   (adapter) vs. `k3-wise` (profile). Decide convention before V4.

## Critical files for implementation (read-only baseline reference)

- `plugins/plugin-integration-core/lib/contracts.cjs`
- `plugins/plugin-integration-core/lib/pipeline-runner.cjs`
- `plugins/plugin-integration-core/lib/external-systems.cjs`
- `plugins/plugin-integration-core/lib/erp-feedback.cjs`
- `plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs`
- `scripts/ops/integration-k3wise-live-poc-preflight.mjs`
