# Memory Refresh + Stage 2 Lane Prep — 2026-04-26

## Scope

Two parallel tracks during the K3 PoC waiting window:

- **T1** — refresh the 3 stale project memories (last touched
  2026-04-13) to reflect 2 weeks of substantial progress.
- **T2** — produce a dormant-until-PASS Stage 2 vendor-abstraction lane
  plan, ready to trigger Wave A the moment the K3 PoC GATE answer
  arrives.

Both are pure planning / hygiene — no code, no战线 opening, no
integration-core touch. 阶段一约束 fully respected.

## T1 — Project memory refresh

Three project memories rewritten to reflect current reality:

### `project_metasheet2.md`

Appended a new section: **"Recent additions (April 2026, Wave 1-10)"**
listing what landed since 2026-04-13:

- Approval Wave 2 closure (WP1-WP5 + observability follow-ups)
- Multitable monolith decomposition M0-M5 (univer-meta.ts shrunk from
  7000+ lines to a thin router)
- Observability layer: correlation-id pipeline + post-auth enrichment +
  event-bus context propagation
- Integration-core plugin (new core subsystem, full 9-PR stack landed
  + K3 WISE Live PoC tooling)
- DingTalk P4 closeout

Plus a pointer to the active strategic direction
(`integration-erp-platform-roadmap-20260425.md`) and the K3 PoC stage-1
lock.

### `project_3month_roadmap.md`

Rewrote completely. The April-13 plan (Phase 1 platform / Phase 2
multitable / Phase 3 approval) is documented as **substantially
executed** ahead of timeline. Replaced with the 4-stage ERP integration
platform roadmap as the current strategic direction:

| Stage | Goal | Status |
|----|----|----|
| 阶段一 K3 PoC 跑通 | Validate PMF | **Current**, locked |
| 阶段二 抽离 + 第2 ERP | Prove "通用" via reuse | Dormant, planning ready |
| 阶段三 平台化基建 | Vendor profile / catalog / builder | Future |
| 阶段四 Marketplace + SaaS | Ecosystem | Future |

### `project_roadmap.md`

Sprint 8 outcomes updated — most items shipped:

- ✅ WebSocket real-time metrics (#1135)
- ✅ Idempotency mechanism (in `plugin-integration-core` runner)
- ✅ RPC / business metrics (multiple `apigw_*` / `automation_*` /
  `approval_sla_*` Prometheus families)
- 🟡 Canary routing — primitives in place, full impl deferred behind
  ERP track

Branch debt reduced from 55+ to ≤2 (PR pool drained 2026-04-25/26).
Active strategic track now points to ERP integration platform.

### `MEMORY.md` index

Updated descriptions for `project_metasheet2.md` and
`project_3month_roadmap.md`. Added entry for `project_roadmap.md`
(previously orphaned — not in index despite existing on disk). Index now
has 9 lines (was 6 before this session, then 9 after wave-9 + memory
adds).

## T2 — Stage 2 lane plan

Output: `docs/development/stage2-vendor-abstraction-lanes-20260426.md`.

### Decomposition

5 lanes derived from
`integration-vendor-abstraction-checklist-20260425.md` and grounded in
read-only inspection of `plugins/plugin-integration-core/*`:

| Lane | Scope | Effort | Parallelism |
|---|---|---|---|
| **V1** | Per-vendor preflight rules — split monolithic K3 preflight | 1.5 人天 | ✅ pure parallel |
| **V2** | Adapter lifecycle declarative (`getLifecycle()`) | 2.0 人天 | ✅ pure parallel |
| **V3** | Vendor-scoped error dictionary | 1.0 人天 | ✅ pure parallel |
| **V4** | Vendor profile metadata (lite, JSON-only) | 1.0 人天 | ✅ pure parallel (with one caveat) |
| **V5** | Vendor-agnostic contract regression test | 0.5 人天 | 🔴 sequential — after V1-V4 |

**Total**: 6.0 person-days; **wallclock ~2.5 days** with 4 parallel
devs (matches roadmap 4-6 人天 budget at upper edge).

### Recommended second-ERP target

**金蝶 K3 Cloud / 星空** — same vendor family as K3 WISE (preserves
field-mapping intuition: `FNumber` / `FName`, material / BOM), but
fundamentally different auth (REST + signed token vs. session cookie).
Validates abstraction reuse before spending budget on truly different
ERPs (SAP / 用友) where a failure would conflate "abstraction is wrong"
with "this ERP is genuinely different."

### Three pre-PASS ambiguities flagged

The agent surfaced three items needing design judgement before Wave A
starts:

1. **V4 validation location** — registry (`external-systems.cjs`) or
   runner (`pipeline-runner.cjs`)? Recommend registry-side to preserve
   V2/V4 disjointness.
2. **`erp-feedback.cjs` hardcoded `FNumber`** (lines 143, 165) — not
   covered by V3's error-string scope; recommend folding into V4 via
   vendor-profile `keyField`.
3. **Adapter `kind` vs. profile `vendor` naming** — `erp:k3-wise-webapi`
   (adapter) vs. `k3-wise` (profile). Decide convention before V4.

These are documented in §6 and §8 of the lane plan as a checklist for
the user / second engineer to resolve when activating Stage 2.

## Verification

### T1

```bash
ls /Users/chouhua/.claude/projects/-Users-chouhua-Downloads-Github-metasheet2/memory/
# 9 memory files + MEMORY.md (3 new today + 5 pre-existing + 1 index)

cat /Users/chouhua/.claude/projects/-Users-chouhua-Downloads-Github-metasheet2/memory/MEMORY.md
# 10 lines: 1 user_profile + 5 project + 4 feedback / reference
```

Each project memory file's frontmatter (`name`, `description`, `type`)
is current. The `**Why:**` / `**How to apply:**` structure is preserved
where applicable. No stale "Phase1 platform foundation" references.

### T2

```bash
ls /Users/chouhua/Downloads/Github/metasheet2/docs/development/stage2-vendor-abstraction-lanes-20260426.md
# File exists, 8 sections, lane table + wave plan + second-ERP recommendation + pre-PASS checklist + out-of-scope.
```

Lane plan grounded in actual reads of `lib/contracts.cjs`,
`lib/pipeline-runner.cjs`, `lib/external-systems.cjs`,
`lib/erp-feedback.cjs`, `lib/adapters/k3-wise-webapi-adapter.cjs`,
`scripts/ops/integration-k3wise-live-poc-preflight.mjs` — agent reported
file-by-file disjointness verification.

## Roadmap-stage compliance

All actions in this slice respect 阶段一 lock:

- ✅ no new战线 — Stage 2 plan is dormant, only activates on PASS
- ✅ no `plugins/plugin-integration-core/*` source changes (read-only
  inspection by the planning agent)
- ✅ no platform-化 work
- ✅ pure planning + memory hygiene

## Recommended next steps

1. **Wait for human review approval** on #1172 (the only open PR).
2. **Wait for K3 PoC customer GATE answer** — the macro blocker.
3. **When PASS is announced**:
   - Resolve the 3 pre-PASS ambiguities flagged in
     `stage2-vendor-abstraction-lanes-20260426.md` §6 / §8.
   - Launch Wave A: V1 + V2 + V3 + V4 in parallel worktrees
     (4 devs / 4 agents — exact pattern matches recent wave 8/9 cycles).
   - V5 (regression gate) follows after Wave A completes.
4. **Memory will compound across sessions** — future Claude sessions in
   this project will inherit the refreshed memories on startup.

This is a natural pause point. Queue at 1 PR, K3 PoC pending,
Stage 2 plan dormant-and-ready, memory current.
