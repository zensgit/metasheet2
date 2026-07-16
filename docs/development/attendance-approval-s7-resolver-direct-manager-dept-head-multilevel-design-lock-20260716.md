# 考勤审批人 resolver·直属上级/部门主管/多级上级(档 A2 / S7)design-lock — 2026-07-16

> **Status: PROPOSED — NOT RATIFIED.** This document is drafted for owner review; it does not
> self-ratify. Implementation (S7-1..S7-5, §6) may not start until this lock carries an explicit
> owner ratification status flip (mirroring the `docs(approval): … lock — RATIFIED (owner …); status
> flip, content unchanged` idiom used for #4196/#4203/#4239). Owner scope-opening ruling (2026-07-16,
> per dispatch): v1 (A1, #3893) closed; vNext first slice = S7 resolver support for 直属上级
> (direct manager) / 部门主管 (department head) / 多级上级 (multi-level up-chain). "A1 编辑器已经落地，
> 底层 ApprovalAssigneeResolver 也已存在，产品价值比继续做视觉微调更高."
>
> **Headline finding from this survey (verified against `origin/main`, not memory or the tracker's
> stale line numbers): the "resolver" the owner is pointing at is not net-new work.**
> `packages/core-backend/src/services/ApprovalAssigneeResolver.ts` already implements
> `direct_manager`, `dept_head`, `continuous_managers`, and `manager_at_level` LIVE, hardened, and
> (mostly) RATIFIED — see §1. The actual gap is that `plugins/plugin-attendance` runs a **second,
> fully independent** approval engine that has zero reference to that resolver, zero reference to
> `directory_*`, and a two-layer silent-drop (zod schema without `.passthrough()` + a hand-rolled
> normalizer that reconstructs steps from an allowlist of three keys) that strips any `kind` field
> before it ever reaches persistence. This lock is about **wiring**, not **inventing**.

---

## 1. Scope

### 1.1 What already exists (kernel side — the "审批中心" / `ApprovalProductService` surface)

All three relationship types the owner named are LIVE in `ApprovalAssigneeResolver.ts`, each as a
`switch` case inside `resolveApprovalAssignees()`:

| Owner's term | Kernel `assigneeSource.kind` | Code | Design-lock status |
|---|---|---|---|
| 直属上级 | `direct_manager` | `ApprovalAssigneeResolver.ts:163-174` | shipped #2852; `docs/design/approval-direct-manager-assignee-source-design-20260618.md` |
| 部门主管 | `dept_head` | `ApprovalAssigneeResolver.ts:175-186` | two-PR shape (sync-plumbing + resolver), shipped; `docs/design/approval-dept-head-sync-plumbing-design-20260618.md` |
| 多级上级 (chain-as-set) | `continuous_managers` | `ApprovalAssigneeResolver.ts:187-204` | **RATIFIED + SHIPPED** #2893 (plumbing) / #2907 (resolver), 2026-06-19; `docs/design/approval-continuous-managers-assignee-source-design-20260618.md` |
| 多级上级 (per-level sequential, "B1") | `manager_at_level` | `ApprovalAssigneeResolver.ts:205-225` | owner ratified reading B1 2026-06-20; code is LIVE despite the design doc's header still literally reading "PROPOSED" (`docs/design/approval-reading-b-manager-at-level-design-20260620.md:1`) — **doc/code drift**, flagging honestly rather than treating the stale header as current status |

The org-relation data these four kinds consume (`managerId` / `deptHeadId` / `managerChainIds`) is
baked read-only from `directory_*` by `packages/core-backend/src/services/ApprovalDirectoryOrg.ts`
at approval-create time and frozen into the requester snapshot (see §2).

### 1.2 What does not exist (the actual S7 target — `plugins/plugin-attendance`)

Attendance's own approval-flow system is a **second, parallel implementation**, not a caller of the
kernel above:

- Table: `attendance_approval_flows` (`packages/core-backend/src/db/migrations/zzzz20260120113000_create_attendance_approval_flows.ts`) — `steps` is a flexible JSONB column, org-scoped, unique on `(org_id, request_type, name)`. **No migration is needed to carry a new step shape.**
- Step model as persisted/consumed today: `{name?, approverUserIds?, approverRoleIds?}` only.
- Resolution: `buildAttendanceApprovalAssignments` (`plugins/plugin-attendance/index.cjs:20549-20586`) — pushes `user`/`role` assignments straight from `approverUserIds`/`approverRoleIds`; when the result is empty it falls back to `role:'admin'` + `source_queue` entries for `ATTENDANCE_APPROVAL_QUEUE_PERMISSIONS = ['attendance:approve','attendance:admin']` (`index.cjs:20583-20588`, constant at `index.cjs:114`). This is the **existing** fail-open-to-admin-queue behavior for the *legacy* empty-approver case — directly relevant prior art for §3.
- This function's output shape (`{assignmentType, assigneeId, nodeKey, sourceStep, metadata}`) is **byte-identical** to the kernel's `ResolvedApprovalAssignment` type (`ApprovalAssigneeResolver.ts:9-15`) because both write into the **same shared tables** — `approval_instances`/`approval_assignments` (`index.cjs:20656`, `20705-20737`, and every `buildAttendanceApprovalAssignments(...)` call site: `24972`, `27537`, `27864`, `28279`, `28783`, `28953`). This is the "桥接迁移" (bridge migration) the A1 lock's §2 describes: *"考勤与审批中心共用 `approval_instances` 表…但同池 ≠ 同一流程定义系统"* (`attendance-approval-flow-editor-a1-design-lock-20260708.md:16`). **The convergence already happens at the instance/assignment layer; it stops one layer short — at source-kind resolution.**
- The two silent-drop layers the tracker flagged (`docs/development/attendance-benchmark-remaining-plan-20260708.md:32`) are real and confirmed on current `origin/main` (line numbers differ from the tracker's stale citation — verified fresh):
  - `normalizeApprovalSteps` (`index.cjs:20515-20528`) reconstructs each step as `{name, approverUserIds, approverRoleIds}` **only** — any other key is dropped before zod ever sees it.
  - `approvalStepSchema` (`index.cjs:24732-24736`) is a zod object with exactly those three fields and **no `.passthrough()`** — zod's default behavior strips unknown keys even if the normalizer above didn't.
  - Net effect: a `kind: 'direct_manager'` field is unrepresentable end-to-end today, confirmed by direct read of both functions.
- Dependency isolation: `plugins/plugin-attendance/package.json` depends on **only** `zod`. `index.cjs` (42,612 lines) is hand-authored CommonJS, not a TS build output (no `src/` dir; only a sibling `engine/`). Grep for `directory_accounts|directory_departments|directory_account_links|directory_account_departments` across the whole file returns **zero hits**. plugin.json declares only coarse permissions (`database.read/write/transaction, http.addRoute, events.emit`) — no table-scoped grant.

### 1.3 Plug-in point

The extension point for all three new step kinds is `buildAttendanceApprovalAssignments`
(`index.cjs:20549-20586`) plus its two upstream gatekeepers (`normalizeApprovalSteps`,
`approvalStepSchema`). No schema/migration change to `attendance_approval_flows` or to the shared
`approval_instances`/`approval_assignments` tables is required — only the step-JSON contract and the
resolution function.

### 1.4 A1 editor surfacing

A1 (`AttendanceApprovalFlowStepsEditor.vue` + `apps/web/src/views/attendance/attendanceApprovalSteps.ts`,
MERGED `85c232612`, #3893) is the FE half of this same surface. Its step type is already
`{name?, approverUserIds?, approverRoleIds?, [key: string]: unknown}`
(`attendanceApprovalSteps.ts:7-14`), and `normalizeStep`/`toPayloadSteps` preserve unmodeled keys
verbatim (`attendanceApprovalSteps.ts:37-44`, `145-153`) — a deliberate fail-closed round-trip
built for exactly this future extension (A1 lock §4: *"防未来漂移…保留原值不丢"*,
`attendance-approval-flow-editor-a1-design-lock-20260708.md:41-42`). A1's own §5 names this work
explicitly as OUT-of-A1: *"直属上级 / 部门主管 / 多级上级 resolver = A2(动考勤引擎路由 + 运行时兜底语义，
独立设计锁 + 反向测试)"* — this document is that lock. **The FE is not the blocker; only the backend
(§1.2) is.**

---

## 2. Resolution semantics per type

These are the kernel's **already-decided, already-shipped** semantics (§1.1). They are the reference
baseline this lock proposes attendance inherit byte-for-byte (see OD-S7-3/OD-S7-4, §5) rather than
re-derive.

### 2.1 直属上级 (`direct_manager`)

- **Data source, dual with precedence (B3):** first, any membership row for the requester's primary
  department flagged `directory_account_departments.is_manager = true` (a normalized, product-set
  relation — admin-set on a LOCAL org, not provider-parsed); if the department has **no** such
  flagged row, fall back to the legacy DingTalk parse of `directory_accounts.raw.leader_in_dept`
  (`ApprovalDirectoryOrg.ts:207-257`, precedence rule documented at `:210-221`). DingTalk-synced rows
  never set `is_manager`, so a DingTalk-only org's routing is bit-identical whichever branch exists.
- **Tie-break:** when the normalized gate has more than one flagged row, deterministic pick ordered
  by `external_user_id ASC, account id ASC` (`:422-423`, `:450`) — not first-in-heap-order like the
  legacy `.find`.
- **Self-exclusion:** enforced at the resolver, not the data layer — a manager that resolves to the
  requester's own id is dropped and treated as unresolved (`ApprovalAssigneeResolver.ts:168-173`).
- **Scope:** both account and department rows are bound to the SAME `integration_id` as the requester
  (`:425-429`) — a repeated `external_department_id` in a different integration cannot leak across.
- **Freeze point:** resolved once, at approval-create, into the requester snapshot `managerId`; never
  re-queried live during dispatch/admin-jump/return (module doc, `ApprovalDirectoryOrg.ts:9-12`).

### 2.2 部门主管 (`dept_head`)

- **Data source:** the requester's primary department's `directory_departments.raw.dept_manager_userid_list`
  (provider department-**detail** field — sync-plumbing prerequisite documented in
  `docs/design/approval-dept-head-sync-plumbing-design-20260618.md`) — first external id in that list
  (excluding the requester) that resolves to a **linked** local user wins (`ApprovalDirectoryOrg.ts:259-270`).
- **Tie-break:** list order (first-linked-wins), not a separate deterministic sort — a different rule
  from §2.1's normalized-manager tie-break, because this source has no product-settable normalized
  equivalent yet.
- **Self-exclusion:** filtered at the source-list stage (`:262-263`) AND again at the resolver
  (`ApprovalAssigneeResolver.ts:180-185`).
- **Freeze point:** same as §2.1 — snapshot field `deptHeadId`, resolved once at create.

### 2.3 多级上级 (multi-level up-chain — two existing readings)

- **Chain build (shared by both readings):** `resolveManagerChain` walks `leader_in_dept` hop-by-hop
  from the requester (`ApprovalDirectoryOrg.ts:377-407`). Three independent termination guards so a
  malformed org graph cannot loop or run away: a visited-external-id set stops cycles, a hop with no
  leader stops at top-of-tree, and a hard `maxLevels` bound stops runaway walks. The chain is
  **dense** — unlinked hops are walked *through* (so the walk can continue past them) but not
  included in the returned array — and self-exclusion is enforced on the requester's **local** id
  (not just their starting external id, to catch alt-accounts: `:368-375`).
- **Depth cap:** `MAX_MANAGER_CHAIN_LEVELS`, env-tunable via `APPROVAL_MANAGER_CHAIN_MAX_LEVELS`
  (default `10`, hard ceiling `50`, invalid/missing input falls back to default —
  `ApprovalDirectoryOrg.ts:75-101`). This bounds the *walk cost*; a per-source `levels`/`level`
  parameter (below) slices into the already-built chain.
- **Perf posture:** the chain is only built when a caller opts in (`includeManagerChain: true`,
  `:280-284`, `:285-295`) — i.e. only when a published graph actually uses a chain-consuming source —
  so the extra per-hop queries are not paid on every approval.
- **Reading A — `continuous_managers` (chain-as-approver-set):** resolves levels `1..source.levels`
  as a single node's approver **set**; the node's `approvalMode` (会签 all / 或签 any) governs how many
  of them must act (`ApprovalAssigneeResolver.ts:187-204`). RATIFIED + SHIPPED.
- **Reading B1 — `manager_at_level` (per-level sequential / "逐级"):** resolves a SINGLE positional
  level (`source.level`, 1 = direct manager) from the same dense chain; authoring N nodes at levels
  `1..N` composes sequential escalation manually — **no publish-time auto-expansion**
  (`ApprovalAssigneeResolver.ts:205-225`; owner explicitly rejected auto-expansion in
  `docs/design/approval-sequential-escalation-design-20260619.md`, carved out as its own reading).
- **Which reading does "多级上级" mean?** The owner's phrasing is compatible with either or both —
  this is OD-S7-2 (§5): does attendance surface chain-as-set, per-level-sequential, or both, and what
  authoring-side max-N does the attendance UI allow (independent of the kernel's 10/50 env cap)?

---

## 3. Fail-closed doctrine — OD-S7-1

**Constraint restated from the dispatch:** an unresolvable dynamic assignee (no manager linked, vacant
department head, chain shorter than the configured level) must **not** silently skip the step or
silently auto-approve. Three candidate behaviors, all with real precedent in this codebase already:

| Option | What it does | Precedent |
|---|---|---|
| **(a) block-with-error** | Approval create/advance fails with an explicit error naming the exact cause (no manager linked / vacant dept head / chain too short) | Mirrors the kernel's `EmptyAssigneePolicy = 'error'` default (`packages/core-backend/src/types/approval-product.ts:18`, validated `ApprovalProductService.ts:395-404`) |
| **(b) fallback-to-named-role** | Step author configures an explicit backstop role/user, used only when the dynamic source resolves empty | New persisted field + new authoring UI; no direct precedent in either surface today |
| **(c) route-to-admin** | Reuse the *existing* legacy-empty fallback unchanged — `role:'admin'` + `source_queue` for `ATTENDANCE_APPROVAL_QUEUE_PERMISSIONS` | Already the plugin-attendance behavior for the OLD `approverUserIds`/`approverRoleIds`-both-empty case (`index.cjs:20583-20588`) |

**Why this is a genuine open decision, not just a pick-one-of-three:** (c) is the path of least
implementation effort (dynamic-empty falls through the same code as static-empty), but it also means
a requester whose directory account simply isn't linked (a purely-local user, or a not-yet-synced
account) gets silently admin-routed on *every* dynamic step, indistinguishably from a genuinely
misconfigured org chart — there is no signal distinguishing "this person really has no manager" from
"the org data isn't wired for this person yet." (a) surfaces that distinction loudly but blocks the
requester outright. **Note:** the kernel's own `auto-approve` policy value, if attendance were to
adopt an equivalent, would technically satisfy neither the letter nor spirit of "must not silently
auto-approve" when paired with an *unresolvable* dynamic source — this lock does not propose adding
an attendance-side auto-approve-on-empty option; if the owner wants one, it must be an explicit,
logged, non-default choice, not a default fallback.

---

## 4. Hard boundaries

- **Zero permission-layer changes.** Resolution determines *who the candidate approver is*; whether
  that person can act (`attendance:approve` RBAC, org admission, membership) is unchanged and entirely
  out of this lock's scope.
- **Org data read-only from `directory_*`.** Whichever architecture OD-S7-5 picks, the new read path
  must mirror the CI-enforced boundary already governing `ApprovalDirectoryOrg.ts`: only `SELECT`s
  against `directory_*`/`directory_account_links`, writes nothing, and never touches
  `approval_*`/`automation_*` convergence-guarded tables from this seam (doctrine + CI enforcement
  cited at `ApprovalDirectoryOrg.ts:14-25`, #2738/#2740/#2742).
- **No cross-org resolution.** Must preserve the existing `integration_id`-scoped binding
  (`ApprovalDirectoryOrg.ts:425-429` — "both sides bind the one requester integration scope"); a
  department's manager in one org/integration must never leak into another's routing.
- **组织集成平台线（owner 词汇中的「B1」——非本文 §2 里作为 manager_at_level 读法代号的 B1）、multi-org 与 飞书 explicitly OUT.** The org-relation plumbing this lock builds on is
  DingTalk-only today (`ApprovalDirectoryOrg.ts:27` — "Provider shape (DingTalk, the only synced
  provider today)"). S7 inherits that boundary as-is: no Feishu/WeCom directory parsing, no
  multi-org/cross-base resolution, added in this slice.
- **No auto-enable.** Ships behind a default-OFF flag (name TBD at implementation time, e.g.
  `ATTENDANCE_APPROVAL_DYNAMIC_ASSIGNEE_SOURCES_ENABLED`); flag-off must be byte-identical to today's
  `{name, approverUserIds, approverRoleIds}`-only behavior.
- **Zero runtime in this PR.** This lock is docs-only. No changes to `index.cjs`,
  `ApprovalAssigneeResolver.ts`, `ApprovalDirectoryOrg.ts`, or the FE editor land here.
- **Checked for cross-lock constraints, found none.** Per the dispatch's request, I grepped the three
  most-recently-ratified approval-line locks — `docs/development/approval-automation-retry-action-classification-designlock-20260712.md`
  (#4196), `docs/development/approval-form-writeback-fwb0-designlock-20260712.md` (#4203), and
  `docs/development/approval-line-completion-design-and-verification-20260713.md` (#4239) — for any
  mention of `resolver`/`assignee`/`direct_manager`/`dept_head`/`manager_at_level`/`continuous_managers`.
  **Zero hits in all three.** Those three locks govern a separate subsystem (durable event delivery /
  outbox / retry classification / form-writeback), not assignee resolution. Recorded here as a
  checked-negative rather than assumed.

---

## 5. OD decision points (owner)

| OD | Question | Options |
|---|---|---|
| **OD-S7-1** | Fallback behavior for an unresolvable dynamic assignee (§3) | (a) block-with-error · (b) fallback-to-named-role · (c) route-to-admin (existing precedent, `index.cjs:20583-20588`) |
| **OD-S7-2** | Multi-level depth semantics (§2.3) | (i) surface `continuous_managers` only (chain-as-set) · (ii) surface `manager_at_level` only (per-level sequential/B1) · (iii) surface both · plus: attendance-side authoring max-N, independent of the kernel's env-tunable 10/50 cap |
| **OD-S7-3** | Department-head / direct-manager definition — already decided at the kernel (§2.1/§2.2, data-source-driven: `is_manager` flag → legacy `leader_in_dept` fallback for manager; `dept_manager_userid_list` for dept head), not role-based. Does attendance's new step kinds inherit this exact definition? | (a recommended) yes, byte-identical semantics regardless of OD-S7-5's answer — two approval surfaces disagreeing about "who is my manager" would be a worse outcome than either being wrong consistently · (b) attendance defines its own (would require its own design rationale; not recommended without a stated reason) |
| **OD-S7-4** | Stale-org-data / resolve-timing posture — already decided at the kernel (§2, "freeze point": resolve-at-submit, frozen into the requester snapshot, never re-queried live at dispatch/admin-jump/return). Does attendance inherit this same point-in-time-freeze? | (a recommended) yes — inherit resolve-at-submit; a manager reorg mid-flight cannot silently change who can approve an in-flight request, matching the kernel's deliberate posture · (b) resolve-at-each-step (more "live," but reopens the exact staleness/race class the kernel closed; would need its own justification) |
| **OD-S7-5** | **Architecture: does plugin-attendance reuse the kernel's resolver/org-relation code, or reimplement it?** This is upstream of OD-S7-3/OD-S7-4 in practice — if (a) is chosen, those two collapse automatically; if (b), they become hand-verified invariants. | (a) add `@metasheet/core-backend` as a **real runtime** dependency of `plugin-attendance` (pnpm workspace already includes both `packages/*` and `plugins/*`, so a `workspace:*` dependency resolves) and call the existing `resolveApprovalRequesterOrgRelations`/`resolveApprovalAssignees`-equivalent read paths directly — zero logic duplication, automatic parity with the kernel's already-hardened cycle guards/self-exclusion/B3 precedence. **Caveat, verified:** every existing plugin→`@metasheet/core-backend` import found in this repo (`plugin-audit-logger`, `plugin-view-gantt`, `plugin-intelligent-restore`) is `import type` only — compile-time-erased, zero runtime dependency. This would be **the first runtime cross-package import from a plugin**, a new precedent, not an established pattern · (b) duplicate the read-only `directory_*` SELECT + chain-walk logic locally inside `index.cjs`, consistent with the plugin's current fully self-contained packaging (only `zod` as a dependency, no `src/` build step) — but forks ~150 lines of already-hardened logic (cycle guard, self-exclusion, B3 dual-source precedence, dense-chain walk) and creates an ongoing drift risk between the two approval surfaces · (c) don't wire attendance's own resolution this slice — migrate attendance approval-flow creation to route through `ApprovalProductService.createApproval` entirely, retiring `buildAttendanceApprovalAssignments`. Much larger, cross-cutting refactor (touches the whole `attendance_approval_flows` runtime, not just assignee resolution); likely out of scope for a first S7 slice |
| **OD-S7-6** | Unlinked-directory / no-sync precondition. `resolveApprovalRequesterOrgRelations` returns `{}` for any requester with no linked directory account (`ApprovalDirectoryOrg.ts:202`) — meaning every dynamic-source step for a not-yet-synced or purely-local user resolves empty on day one, for every such user, invisibly. Should attendance authoring proactively warn/guard when picking a dynamic-source kind for an org without directory sync configured, or is this left to fall through to OD-S7-1's fallback at runtime? | (a) authoring-time warning only (mirrors A1's existing soft-warning idiom for empty static approvers, `attendanceApprovalSteps.ts:126-141`) — non-blocking, surfaces the risk without hard-gating · (b) no authoring-time signal; rely entirely on the OD-S7-1 runtime fallback · (c) hard-block authoring a dynamic-source step for an org with zero linked directory accounts |

No option above is pre-selected by this document. All are open pending owner ratification.

---

## 6. Slicing

Each slice is independently flag-gated (§4) and ships with real-DB tests mirroring the kernel's
existing test shape (`packages/core-backend/tests/unit/approval-assignee-resolver.test.ts`,
`packages/core-backend/tests/integration/approval-manager-chain.db.test.ts`) plus an adversarial
review with 0 P1/P2 before merge — the same completion bar A1 used
(`attendance-approval-flow-editor-a1-verification-20260708.md` §3-§4).

- **S7-1 — contract + extension point.** Resolves OD-S7-5 (architecture) first, since it gates
  everything downstream. Extends the `attendance_approval_flows` step JSON contract with an optional
  `kind` field (backward compatible — absent `kind` keeps today's `user`/`role` behavior byte-for-byte);
  removes the two silent-drop layers (`approvalStepSchema` gains the new optional fields or
  `.passthrough()` scoped correctly; `normalizeApprovalSteps` stops reconstructing from a
  three-key allowlist). No resolution behavior change yet — a `kind`-tagged step round-trips but is
  not yet resolved dynamically. Flag-gated, off by default.
- **S7-2 — 直属上级.** Wires `buildAttendanceApprovalAssignments` to resolve `kind:'direct_manager'`
  steps via the OD-S7-5 path chosen in S7-1. Real-DB tests: linked requester resolves correctly,
  self-exclusion, unlinked requester triggers OD-S7-1's chosen fallback.
- **S7-3 — 部门主管.** Same shape for `kind:'dept_head'`. Real-DB tests: vacant dept head (no
  `dept_manager_userid_list` entry resolves to a linked user), self-exclusion.
- **S7-4 — 多级上级.** Implements the reading(s) chosen in OD-S7-2 (chain-as-set and/or per-level
  sequential); authoring-side depth parameter; cycle/cap tests mirroring the kernel's guards
  (visited-set cycle stop, dense-chain walk-through, `maxLevels` bound).
- **S7-5 — A1 editor wiring.** `AttendanceApprovalFlowStepsEditor.vue`/`attendanceApprovalSteps.ts`
  gains a step-kind picker (existing static user/role vs. the three new dynamic kinds); preview JSON
  reflects the new shape; the existing empty-approver warning (`stepHasNoApprover`,
  `attendanceApprovalSteps.ts:122-124`) is extended per OD-S7-6's chosen posture. Payload-shape
  discipline from A1 (`{name,requestType,steps,isActive,orgId}` unchanged at the top level) carries
  forward unchanged.

**Completion bar per slice:** real-DB tests including a negative/mutation check for the fallback path
chosen in OD-S7-1 (an unresolvable-assignee test must fail the OLD way — silent skip or silent
auto-approve — before the fix, and pass the NEW way after); flag-off byte-identity test; adversarial
review 0 P1/P2; verification MD.

---

## 7. Explicitly-out + relation to the A1 observation window

**Explicitly OUT of S7 (all slices):**

- 会签/或签/条件/并行/表单 schema authoring in attendance's editor — A1's own §5 already ruled this out
  ("考勤引擎不支持 → 编辑器不呈现，不假装支持"); S7 does not reopen it.
- 考勤请求发起中央模版 + 终态回写闭环 (档 B) — separate, governance-gated, unrelated to resolver work.
- Feishu/WeCom directory-provider parsing (§4).
- Multi-org/cross-base resolution (§4).
- Any RBAC/permission-layer change (§4).
- Auto-enabling the new capability without an explicit flag flip (§4).

**Relation to the A1 observation window:** A1's own closeout note recommended the owner watch A1 live
before deciding on A2: *"A1 落地后部署，建议 owner 在 live 环境目视审批流创建界面手感，再决定 A2"*
(`attendance-approval-flow-editor-a1-verification-20260708.md` §6). A1 merged 2026-07-08 (`85c232612`,
#3893). Per this task's own dispatch framing, the owner's 2026-07-16 ruling is what closes that
observation window and opens the S7/A2 line **at the scope level** (naming the three resolver types).
**That is a separate gate from ratifying this document's semantics.** I found no separately-named
"7-day trial" governance artifact beyond A1's own closeout recommendation — I'm treating the dispatch's
framing as authoritative for the scope-opening event, but flagging that this specific search turned up
no standalone trial-window document to cite independently. Either way: **no S7-1..S7-5 implementation
PR should be opened until this lock itself is explicitly owner-RATIFIED** — scope being open is not the
same as this document's OD's (§5) being decided.
