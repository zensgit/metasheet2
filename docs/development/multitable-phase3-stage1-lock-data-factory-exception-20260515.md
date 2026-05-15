# Stage-1 Lock Exception Record — Data Factory Staging-Install Path

- Date: 2026-05-15
- Author: Claude (Opus 4.7, 1M context), interactive harness; post-merge exception record. **No code change. No runtime change. No new feature work. No A1 implementation.**
- Operator-authored decision; this document only records the decision and the constraints around it.
- Triggering PR: **#1572** `fix(integration): normalize staging install project scope`
- Merge commit: `3dd5a20a2`
- Main HEAD at write time: `3dd5a20a2` (just-merged)

## 1. Why this record exists

The K3 PoC stage-1 lock recorded in `project_k3_poc_stage1_lock.md` and
`docs/development/integration-erp-platform-roadmap-20260425.md` §4-§5 has been in continuous force since 2026-04-26. Its first rule is unambiguous:

> ❌ Touches `plugins/plugin-integration-core/*`? → blocked. K3 PoC path must remain stable.

PR #1572 modified four files under `plugins/plugin-integration-core/`:

- `lib/http-routes.cjs` (substantive logic — staging-install project-scope normalization)
- `lib/staging-installer.cjs` (substantive logic — new `STAGING_INSTALL_EMPTY` error path + plugin-safe project ID derivation under `${tenantId}:integration-core` namespace)
- `__tests__/http-routes.test.cjs`
- `__tests__/staging-installer.test.cjs`

Per the strict reading of the lock, #1572 should have been blocked. It was merged on 2026-05-15 because the operator judged the change as a **kernel polish on a shipped feature** (Data Factory + K3 WISE setup), not as opening a new product战线. This record documents that judgment so future contributors can interpret subsequent PRs against a written precedent rather than ad-hoc memory.

## 2. What this record IS NOT

This record is **not**:

- A retroactive ratification of #1572's content. The operator's review approved it; this doc just writes down the lock-rule interpretation.
- A lift of the stage-1 lock. The lock remains in force for every other path the rule covers.
- A blanket permission for any future PR touching `plugins/plugin-integration-core/*`. Each future PR must justify its own exception, or wait.
- An admission of a process violation. The lock has always allowed kernel polish on shipped features; the exception language below clarifies the boundary.

## 3. Exception scope (what was allowed)

The Data Factory + K3 WISE setup line, including its server-side `staging-installer.cjs` / `http-routes.cjs` plumbing, is **shipped** (PR #1521 reframed the workbench, PR #1522/#1525/#1528 added discovery + export + postdeploy smoke, PR #1559/#1560 hardened drift detection + on-prem package, PR #1561/#1566 added save-gate + readiness, etc.). The path is therefore considered a kernel polish target under the lock's existing exception:

> ✅ Ops/observability打磨 on shipped features (correlation-id, SLA leader-lock, breach notify channels) → permitted.

PR #1572's content fits this category because:

- **No new adapter** — only the existing `metasheet:staging` install path is rewritten.
- **No new pipeline runner behavior** — error paths and tenant-scope derivation only.
- **No K3 PoC adapter touch** — `lib/adapters/k3-wise-*` files are not in the diff.
- **No migration, no new manifest, no new package script** — runtime contract unchanged for K3 PoC scenarios.
- **Adapter contract still 5-method** — `testConnection / listObjects / getSchema / read / upsert` shape is intact.
- **Behavior change is fail-closed** — the new `STAGING_INSTALL_EMPTY` error turns a previous silent false-positive success into a hard error. This is a strict improvement; it cannot regress a working install path, only refuse an already-broken one more loudly.

## 4. What this exception does NOT cover

The exception is narrow. The lock continues to block:

- Any change under `lib/adapters/k3-wise-*` — the K3 PoC adapter code remains frozen.
- Any change to the 5-method `adapter contract` in `plugins/plugin-integration-core/lib/contracts.cjs`.
- Any change to `pipeline-runner.cjs` / `idempotency.cjs` / `watermark.cjs` / `dead-letter.cjs` / `run-log.cjs` substantive logic.
- Any new vendor adapter, new pipeline action type, or new pipeline lifecycle hook.
- Any change opening a new product战线: AI surface, formula AI, template / industry solution center, marketplace, multi-tenant SaaS.
- Any change that introduces a new database migration.
- Any change to the multitable, K3, Attendance, DingTalk, or Approval **runtime** paths beyond the Data Factory subgraph.
- Lane A1 / A2 / A3 / B1 / B2 / D2 / D3 of Phase 3 — these all remain `deferred` per the TODO Activation Gate.
- Lane C1 / C2 — these remain `pending PM / SME assignment` per the TODO.

## 5. Criteria for future similar exceptions

Future PRs that touch `plugins/plugin-integration-core/*` and want to claim the same exception family must, in their PR body, affirmatively state:

1. **Which shipped feature** the change polishes (e.g. "Data Factory staging install", "K3 WISE postdeploy smoke", "vendor adapter metadata", etc.).
2. **Why no K3 PoC adapter code is touched** (cite by file path or `grep` evidence that `lib/adapters/k3-wise-*` is not in the diff).
3. **Why no new product战线 is opened** (cite by enumeration that no AI / formula / template / marketplace / new-adapter / new-action surface is added).
4. **Why no migration / new manifest / new package script is needed** — or, if any of these IS needed, explain why the change still qualifies (most do not).
5. **Why the change is fail-closed at runtime** — i.e. cannot regress a working K3 PoC scenario.

A PR that cannot honestly answer all five becomes a candidate for `blocked under stage-1 lock; defer until K3 GATE PASS or explicit打破阶段一约束`.

## 6. What this PR (the one landing this doc) does NOT do

- Does NOT revert #1572.
- Does NOT modify any file changed by #1572.
- Does NOT modify any other file under `plugins/plugin-integration-core/*`, `lib/adapters/k3-wise-*`, K3 PoC runtime, multitable runtime, or any deferred Phase 3 lane.
- Does NOT lift the stage-1 lock.
- Does NOT modify any TODO Status line.
- Does NOT touch real secrets, real K3 endpoints, or real customer data.
- Does NOT propose any implementation PR for A1 / A2 / A3 / B1 / B2 / C1 / C2 / D2 / D3.

The PR landing this doc is **docs-only**, single-file, under `docs/development/`.

## 7. Cross-references

- `project_k3_poc_stage1_lock.md` (memory) — the lock rule this exception interprets.
- `docs/development/integration-erp-platform-roadmap-20260425.md` §4-§5 — the roadmap that records the lock and the 4-stage path.
- `docs/development/multitable-feishu-phase3-ai-hardening-todo-20260514.md` Activation Gate — the per-lane lock status table.
- `docs/development/multitable-phase3-unlock-checklist-20260515.md` — the per-lane unlock checklist landed via PR #1568.
- `docs/development/multitable-phase3-lane-a1-ratification-table-20260515.md` — the A1 ratification matrix landed via PR #1571.
- PR #1572 (`3dd5a20a2`) — the PR this record retroactively explains.
- Related Data Factory + K3 setup hardening PRs already on `main`: #1521, #1522, #1525, #1528, #1557 (the earlier minimal `metasheet:staging` metadata exception), #1559, #1560, #1561, #1563, #1566, #1567.

## 8. How to read this in three months

If you are reading this in 2026-08 and wondering "did the stage-1 lock get lifted in May 2026?", the answer is **no**. The lock was in force for the entire Phase 3 active queue window (D0 / D1 / D4 implementation + #1562 / #1564 log viewer hardening + #1568 / #1571 audit-and-checklist docs landing). A narrow set of Data Factory + K3 WISE setup PRs were merged under the kernel-polish exception articulated in §3 of this document, with the boundaries written in §4 and the criteria for future similar exceptions written in §5.

A1 / A2 / A3 (AI), B1 / B2 (Formula), D2 (perf), D3 (permissions matrix), and the Lane C (templates) work all remained deferred. Lifting any of those requires either (a) operator announcing `K3 GATE PASSED`, or (b) operator explicitly invoking `打破阶段一约束` per `project_k3_poc_stage1_lock.md` — neither of which had occurred at the time this doc landed.
