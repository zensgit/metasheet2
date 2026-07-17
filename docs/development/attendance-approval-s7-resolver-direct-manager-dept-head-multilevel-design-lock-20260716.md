# 考勤审批人 resolver·直属上级/部门主管/多级上级(档 A2 / S7)design-lock — 2026-07-16

> **Status: RATIFIED (owner 2026-07-16; status flip, content unchanged).** Owner round-3 verdict:
> APPROVE, 0 P1 / 0 P2, at head ee5634a5d — all round-2 findings substantively closed (three-type
> matching semantics + 12-leg matrix; authoring + both runtime entries fail-closed, admin fallback
> forbidden; discriminated union + level + enum-strict 422 matrix). Runtime remains separately
> opt-in; slice order LOCKED: **S7-0 → S7-1 → S7-2/3/4 → S7-5**; `continuous_managers` stays OUT.
> Non-blocking implementation note (owner): the S7-1 host port should expose the host-resolved
> `MAX_MANAGER_CHAIN_LEVELS` (or a same-source validation method) so the plugin never re-parses
> the env var into a second constant. Owner scope-opening ruling (2026-07-16,
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
>
> **Amendment (2026-07-16, owner round-1 on PR #4356 — CHANGES REQUESTED, 3 P1 / 3 P2, wording taken
> verbatim from the PR review comment).** All six findings are resolved below, each with fresh
> `origin/main` code citations (verified at `d64f0a6d8` core-backend / `plugin-attendance` state, which
> is byte-identical to current `origin/main` for every file cited EXCEPT
> `packages/core-backend/src/index.ts`, which has since drifted +2 lines (an unrelated
> `plmEmbedDiscussionReadRouter` insertion) — the OD-S7-5(d) index.ts citations are exact against the
> pinned basis and land +1/+2 lines later on current main, zero design impact):
> new **§3 Action authorization semantics** (P1 — dynamic/legacy assignment must gate BOTH approve and
> reject, not approve-only, §3.1/§3.2); new **§3.3 org anchor** for the resolver's directory lookup
> (P1 — the kernel's requester-org lookup has no org filter, a locked contract requirement carried into
> §5/§6/§7); **§2.3 / OD-S7-2** is DECIDED (§2.3 amendment note, §6) — v1 ships `manager_at_level` only,
> `continuous_managers` moves to explicitly-OUT-of-v1 (§8) (P1 — quorum semantics gap); new **§3.4
> freeze concretization** — create-time hydration + read-only-snapshot at step-advance (P2); **§7's
> S7-0/S7-1** add a fail-closed 422 gate so a schema-accepted, resolver-less `kind` can never round-trip
> inert (P2); **OD-S7-5** (§6) gains a marked recommended option — a host-injected, org-scoped resolver
> port via `context.services`, mirroring the existing `workdayCalendar` capability (P2). OD-S7-1 and
> OD-S7-2 move from OPEN to DECIDED per explicit owner ruling; OD-S7-3 moves to DECIDED-CONDITIONAL
> (byte-identical inheritance locked, gated on the §3.3 org-anchor fix landing first); OD-S7-4 moves to
> DECIDED (resolve-at-submit inherited, concretized in §3.4 — no gate); OD-S7-5 and OD-S7-6 remain
> OPEN. **Status stays PROPOSED — NOT
> RATIFIED** — this amendment answers the round-1 review; the owner, not this document, ratifies it.
>
> **Amendment round 2 (2026-07-16, owner round-2 on PR #4356 head `db103d5bb` — 2 P1 / 1 P2 + two OD
> rulings).** Resolutions, each with fresh `origin/main` code citations: **§3.2 per-type assignment
> MATCHING semantics** (P1 — "read the active assignments" was under-specified; the check must match
> the actor per `assignment_type` ∈ {user, role, source_queue} using the central engine's authoritative
> predicate, quoted verbatim from `ApprovalBridgeService.ts:359-363`, with admin override applied ONLY
> after that match fails); **§4.1 runtime fail-closed** (P1 — the 422 authoring gate alone leaves a
> window: a dynamic-kind step reached at request creation or step-advance while the flag is off, the
> resolver port is missing, or the resolver is unavailable must fail explicitly BEFORE any
> assignment/instance mutation, never legacy admin fallback; "flag-off ⇒ byte-identical legacy
> behavior" is now scoped to flows containing NO dynamic kind); **§7 S7-1 discriminated-union step
> persistence contract** (P2 — a step is EITHER static OR dynamic, mutually exclusive;
> `manager_at_level` must carry integer `level` ∈ [1, `MAX_MANAGER_CHAIN_LEVELS`], mirroring the
> kernel's enum-strict validation at `ApprovalProductService.ts:512-519`; all malformed shapes 422 at
> authoring; the OD-S7-2 leftover authoring max-N is settled = the same kernel constant). **OD-S7-5 is
> DECIDED = (d)** (context.services narrow org-scoped resolver port; no runtime dependency on the whole
> core package, no resolver copy; missing port ⇒ fail-closed per §4.1) and **OD-S7-6 is DECIDED = (a)**
> (authoring-time explicit warning, no hard save-block; the correctness gate is the runtime
> block-with-error). OD ledger after round 2: OD-S7-1/2/4/5/6 DECIDED; OD-S7-3 DECIDED-CONDITIONAL
> (gated on §3.3 landing). **Status: RATIFIED per the owner 2026-07-16 verdict recorded in the header.**

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
- Resolution: `buildAttendanceApprovalAssignments` (`plugins/plugin-attendance/index.cjs:20549-20586`) — pushes `user`/`role` assignments straight from `approverUserIds`/`approverRoleIds`; when the result is empty it falls back to `role:'admin'` + `source_queue` entries for `ATTENDANCE_APPROVAL_QUEUE_PERMISSIONS = ['attendance:approve','attendance:admin']` (`index.cjs:20583-20588`, constant at `index.cjs:114`). This is the **existing** fail-open-to-admin-queue behavior for the *legacy* empty-approver case — directly relevant prior art for §4. **Separately (amendment, §3): this same function's assignments are never actually checked for authorization on the reject path, and only checked against LEGACY step fields on the approve path — see §3.**
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
baseline this lock proposes attendance inherit byte-for-byte (see OD-S7-3/OD-S7-4, §6) rather than
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
  this was OD-S7-2 (§6). **DECIDED (owner round-1, 2026-07-16): (ii) `manager_at_level` only.** See
  the amendment note immediately below and §6/§7/§8 for the full ruling and its consequences.

**Amendment — OD-S7-2 DECIDED, quorum semantics gap (P1, owner round-1):** Reading A
(`continuous_managers`, chain-as-approver-set) is RATIFIED at the kernel, but its semantics are
inseparable from `approvalMode` (会签 all / 或签 any) — the node's `approvalMode` is what decides how
many of the resolved set must act before the kernel's `ApprovalGraphExecutor` advances the node
(`ApprovalGraphExecutor.ts:44,690,891-898,1160-1167,1266` — `approvalMode` is a first-class field read
at multiple dispatch points, not a decoration). Attendance has no equivalent state: `resolveRequest`
(`index.cjs:28846`) advances a step the instant **any single actor** calls approve — see
`index.cjs:28928` (`isFinalApproval = action !== 'approve' || flowSteps.length === 0 || currentStepIndex
>= flowSteps.length - 1`) and `index.cjs:28935-28955` (a single approve call computes `nextStepIndex`
and immediately replaces the step's assignments with the next step's — there is no count of how many
of the *current* step's assignees have acted, and no schema field to hold one). Wiring
`continuous_managers` onto this engine today would silently collapse 会签/或签 to "first click wins,"
which is not what the kernel's own `continuous_managers` semantics promise and not something this lock
can quietly redefine. **Ruling: v1 scope is `manager_at_level` only** (per-level sequential —
`ApprovalAssigneeResolver.ts:205-225`, no quorum state required, one assignee per step exactly as
attendance's model already assumes). `continuous_managers` moves to **explicitly OUT-of-v1** (§8);
its re-entry condition is a real attendance quorum/count-of-acted-assignees engine, which is its own
gated line, not a byproduct of S7. This also resolves OD-S7-3's "byte-identical semantics" question for
v1: only `direct_manager` / `dept_head` / `manager_at_level` need to inherit kernel semantics
byte-for-byte in this slice — `continuous_managers` is deferred with its dependency named.

---

## 3. Action authorization semantics — resolved/legacy assignment must gate BOTH approve and reject (P1, owner round-1 amendment)

**This section did not exist in the original lock and is the amendment's primary addition.** The
owner's round-1 finding, quoted from the PR #4356 review: *"Dynamic assignments are not authoritative
for attendance actions. `resolveRequest()` first applies the broad attendance RBAC/scheduler-scope
gate, then `isApproverAllowed()` checks only `approverUserIds` / `approverRoleIds`; both empty returns
`true`. The reject path skips that check entirely. Therefore writing a dynamic user into
`approval_assignments` does not stop another scope-authorized actor from approving or rejecting."*
Verified directly against `origin/main`, code and line numbers below.

### 3.1 The gap, as it exists today

- `assertAttendanceRequestApprovalAllowed` (`index.cjs:21655-21677`) is the **broad** gate both actions
  pass through first (`index.cjs:28888`): it checks whether the actor holds *some* active scheduler
  scope that permits the `'approve'` action on requests matching this request's facts (department,
  request type, etc. — `attendanceSchedulerScopeAllowsActorActionFacts`, `index.cjs:21667-21669`). This
  answers "is this person a plausible approver for requests like this one," never "is this person the
  assignee of *this specific pending step*."
- `isApproverAllowed` (`index.cjs:20764-20774`) is the **narrow** gate — but it is called ONLY inside
  `if (action === 'approve')` (`index.cjs:28918-28926`), and it reads exclusively
  `currentStep.approverUserIds` / `currentStep.approverRoleIds` — the LEGACY static step fields
  (`index.cjs:20766-20768`). It never reads `approval_assignments` (the table `buildAttendanceApprovalAssignments`
  actually writes into, `index.cjs:20703-20733`), so a dynamic assignment produced by any future
  S7-2/S7-3/S7-4 resolver is **structurally invisible to this check** even for approve.
- The `if (action === 'approve')` block at `index.cjs:28918-28926` has no counterpart for
  `action === 'reject'` — between the two branches of `resolveRequest` (`index.cjs:28846-29470`) there
  is no `if (action === 'reject')` authorization check at all; execution falls straight through to
  computing `newStatus = 'rejected'` (`index.cjs:28929-28931`). Confirmed structurally: grep of the
  function body shows exactly one `isApproverAllowed(...)` call site, gated on `action === 'approve'`.
- Net effect (owner's framing, confirmed): once S7-2 begins writing `direct_manager`/`dept_head`/
  `manager_at_level` resolutions into `approval_assignments`, ANY actor who passes the broad
  scheduler-scope gate — not just the resolved manager — can still approve (because `isApproverAllowed`
  never looks at the dynamic assignment) and can unconditionally reject (because no check runs at all).
  Writing the correct assignee is necessary but not sufficient; nothing currently *enforces* it.

### 3.2 Locked requirement

> **ERRATUM (owner ruling 2026-07-16, OD-S7-0 scheduler-scope carve-out — NARROW).** The
> assignment-authoritative rule stated in this §3.2 is the DEFAULT and applies to every request
> type **except** one precisely-scoped carve-out. The authorization mode is keyed on the request's
> **creation-frozen** `approvalFlow.steps` snapshot (the same frozen snapshot S7-2..4's freeze reads
> — `requestRow.metadata.approvalFlow.steps`), **NOT** on whether `approval_assignments` rows exist:
> - **`schedule_dispatch` with `flowSteps.length === 0` ⇒ SCOPE-NATIVE.** A zero-step dispatch's only
>   assignments are the legacy `role:'admin'` + `source_queue:'attendance:approve'/'attendance:admin'`
>   fallback, so the per-node assignment predicate below would collapse to "actor holds
>   `attendance:approve`" — meaningless for dispatch. For this case the authoritative gate is the
>   **latest-detail dispatch scope** check (`assertScheduleDispatchRequestScopeAllowed`, throwing
>   `SCHEDULER_SCOPE_FORBIDDEN`), which MUST run for **both approve and reject BEFORE any state
>   write**, mirroring — and additive to — the existing final-approve dispatch revalidation (which is
>   kept). The per-node assignment check is skipped for this case only.
> - **Everything else ⇒ ASSIGNMENT-AUTHORITATIVE (unchanged §3.2 below).** This explicitly INCLUDES
>   `schedule_dispatch` **with non-empty frozen steps** (which must satisfy BOTH the per-node
>   assignment check AND the dispatch scope), and any **unknown/future `requestType`**, which MUST
>   default to assignment-authoritative and never auto-enter the carve-out.
>
> The decision reads the frozen steps, never `SELECT ... FROM approval_assignments`. Nothing else in
> §3.2 (the per-type predicate, `__none__` sentinel, admin-override ordering, symmetry) is broadened
> or changed by this erratum; the carve-out is limited to the zero-step `schedule_dispatch` case.

Both `action === 'approve'` and `action === 'reject'` in `resolveRequest` (`index.cjs:28846`) MUST
authorize the actor against the **active assignment set for the current node**, not the legacy step
fields alone (subject to the §3.2 ERRATUM carve-out above for zero-step `schedule_dispatch`):

- **Authorization source of truth:** the active row(s) in `approval_assignments` for
  `(instance_id = approvalId, node_key = currentNodeKey, is_active = TRUE)` — the same rows
  `replaceAttendanceApprovalAssignments`/`deactivateAttendanceApprovalAssignments`
  (`index.cjs:20703-20742`) already maintain. This set is the union of whatever
  `buildAttendanceApprovalAssignments` produced for the current step — legacy `approverUserIds`/
  `approverRoleIds` **and**, once S7-2..S7-4 land, the resolved dynamic assignee(s) — so extending the
  authorization check to read this table is what makes both sources authoritative uniformly; it also
  means `isApproverAllowed`'s current legacy-only read (`index.cjs:20766-20768`) is superseded, not
  duplicated.
- **Per-type matching semantics (P1, owner round-2 amendment — LOCKED, not implementation detail):**
  "read the active assignments" is not a sufficient specification, because `approval_assignments`
  rows carry `assignment_type ∈ {user, role, source_queue}` — `buildAttendanceApprovalAssignments`
  writes all three today (`user`/`role` from the step at `index.cjs:20574-20581`, `role:'admin'` +
  `source_queue:<permission>` in the legacy-empty fallback at `index.cjs:20583-20588`). The actor
  match MUST therefore be per-type, and it MUST adopt the central engine's authoritative predicate
  **verbatim** — the one the kernel's pending-tab visibility already uses
  (`packages/core-backend/src/services/ApprovalBridgeService.ts:359-363`, under `is_active = TRUE`
  at `:358`):

  ```sql
  (assignment_type = 'user' AND assignee_id = $actorId)
  OR (assignment_type = 'role' AND assignee_id = ANY($actorRoleIds))
  OR (assignment_type = 'source_queue' AND assignee_id = ANY($actorPermissions))
  ```

  i.e. `user` matches on actor identity, `role` matches when `assignee_id` is one of the actor's
  role ids, `source_queue` matches when `assignee_id` is one of the actor's permission strings
  (that is what the kernel binds into the third parameter — `actorPermissions`,
  `ApprovalBridgeService.ts:346-347`; note also the kernel's `'__none__'` sentinel for empty
  role/permission arrays at `:305-306`, so an actor with no roles/permissions can never match via an
  empty-`ANY` accident). **Admin override (`hasAttendanceAdminAccess`) is applied ONLY AFTER this
  per-type match fails** — override is a fallback for a non-matching actor, never a substitute for
  evaluating the match. Failure modes this per-type contract prevents, named explicitly:
  - *Role/queue approvers locked out:* a check that only implements `assignee_id === actorId`
    (user-equality) would 403 every legitimate role-assigned approver and every legacy-fallback
    queue approver (`role:'admin'` / `source_queue:'attendance:approve'` rows,
    `index.cjs:20583-20588`) — breaking today's working legacy flows the moment S7-0 lands.
  - *Anyone-can-act degeneration:* a check that only asserts "an active assignment row EXISTS for
    the current node" without matching it against the actor is vacuously true for every pending
    step (every step has at least one active row — the legacy fallback guarantees it), collapsing
    the authorization back to the broad scheduler-scope gate — the exact P1 this section exists to
    close.
- **Symmetry:** the same check MUST run before both branches take effect — i.e. immediately inside (or
  ahead of) the `if (action === 'approve')` block AND a new equivalent branch for
  `action === 'reject'`, both before `newStatus` is computed (`index.cjs:28929-28931`) and before any
  assignment/instance row is mutated.
- **Explicit admin-override semantics, preserved and made symmetric:** `hasAttendanceAdminAccess`
  (`index.cjs:20491-20495`) already provides the override for approve (`index.cjs:28921-28924`) — an
  admin who is not the resolved assignee may still act. This override MUST apply identically to reject
  (today reject has no check to override, so the admin override is currently moot for reject — fixing
  the gap and preserving the override are the same change). Reuse `hasAttendanceAdminAccess` unchanged;
  do not introduce a second admin-detection path. Ordering per the round-2 lock-down above: per-type
  match first, override only on non-match.
- **Negative real-DB tests, required per slice that touches this path (S7-0, and re-verified by every
  slice that writes a new assignment kind — S7-2/S7-3/S7-4):** a scope-authorized-but-not-assigned actor
  must be rejected (403) on BOTH approve and reject; the resolved/legacy assignee must succeed on
  whichever action they attempt; an admin override must still succeed on both without being the
  assignee; a mutation test must prove the old code path (reject with no check) fails the "unassigned
  actor is rejected" assertion before the fix and passes after. **Round-2 addition: positive AND
  negative tests for ALL THREE `assignment_type` values, each on BOTH approve and reject** — (i)
  `user`: the assigned user succeeds, a different scope-authorized user 403s; (ii) `role`: an actor
  holding the assigned role succeeds, an actor without it 403s; (iii) `source_queue`: an actor holding
  the assigned permission string succeeds, an actor without it 403s — six positive + six negative legs
  minimum, so a user-equality-only implementation and an exists-any-row implementation both fail the
  suite (each would pass a subset; only the correct per-type predicate passes all twelve).

### 3.3 Org anchor for the resolver's directory lookup (P1, owner round-1 amendment)

**Owner's finding, quoted:** *"The proposed kernel reuse is not org-scoped.
`resolveApprovalRequesterOrgRelations(localUserId, query, options)` accepts no attendance `orgId`; its
first query selects the most recently updated linked account across all integrations for that local
user. Binding later joins to that chosen `integration_id` does not prevent selecting an integration
belonging to another org."*

- **Confirmed as described.** The function's signature is exactly `(localUserId: string, query: QueryFn,
  options: { includeManagerChain?: boolean; maxLevels?: number } = {})`
  (`ApprovalDirectoryOrg.ts:168-172`) — no `orgId` parameter anywhere. Its requester-account lookup
  (`ApprovalDirectoryOrg.ts:177-200`) is:
  ```
  FROM directory_account_links l
  JOIN directory_accounts a ON a.id = l.directory_account_id AND a.is_active = true
  ...
  WHERE l.local_user_id = $1 AND l.link_status = 'linked'
  ORDER BY a.updated_at DESC, a.id ASC
  LIMIT 1
  ```
  — this scans every linked directory account for the local user, across every integration the local
  user happens to be linked into, and picks the single most-recently-updated one. Every downstream join
  (manager resolution, dept head, chain walk) is then scoped to *that* account's `integration_id`
  (`ApprovalDirectoryOrg.ts:204,222-257,425-429`) — correct once the account is chosen, but the choice
  itself has no org filter. A local user linked to directory accounts in two different orgs' DingTalk
  integrations can have the wrong org's account picked, and every manager/dept-head/chain answer for
  that approval silently comes from the wrong org's tree.
- **This is a real, exploitable-by-misconfiguration gap for attendance specifically** (not necessarily
  for every existing kernel caller — `ApprovalProductService.ts:3599-3601` calls this same function with
  no `orgId` either, so this is a pre-existing kernel-wide property, not something S7 introduces; S7 is
  the first caller for which "requester's org" is a hard, load-bearing invariant across the whole
  surface — every attendance table this resolver would sit next to is `org_id`-scoped, e.g.
  `attendance_approval_flows` unique on `(org_id, request_type, name)` and `attendance_requests.org_id`
  read at `index.cjs:28908`).
- **`directory_integrations.org_id` already exists and is indexed**, so the anchor is a straightforward
  join, not new plumbing:
  `packages/core-backend/src/db/migrations/zzzz20260324150000_create_directory_sync_tables.ts:16`
  (`org_id` column, `NOT NULL DEFAULT 'default'`) and `:33` (`idx_directory_integrations_org` index).
- **Locked contract:** any resolver path S7 wires through (whichever OD-S7-5 architecture, §6) MUST
  accept the attendance request's `orgId` (already in scope at every creation call site —
  `index.cjs:24970` and the four other `buildAttendanceApprovalInstancePayload` call sites pass `orgId`
  in) and add `JOIN directory_integrations di ON di.id = a.integration_id AND di.org_id = $orgId` (plus
  the same anchor on the department-head and chain-walk queries, which currently trust the
  already-anchored `integrationId` derived from the unscoped pick) to the requester-account lookup
  BEFORE the `ORDER BY ... LIMIT 1` tie-break — so the tie-break only ever competes among accounts
  already inside the calling org. Whether this ships as a new `orgId` field on `options` (backward
  compatible — existing kernel callers that omit it keep today's unscoped behavior) or as a distinct
  exported function is an implementation-time choice; the invariant that is locked here is that
  **no attendance-facing call path may invoke this resolver without an org anchor**, and that
  invariant needs its own real-DB test: two orgs, one local user linked into both, asserting the
  resolved manager/dept-head/chain come from the requesting org's tree only.

### 3.4 Freeze concretization — creation-time hydration, read-only-snapshot at step-advance (P2, owner round-1 amendment)

**Owner's finding, quoted:** *"Resolve-at-submit freezing is not represented in the stated extension
points. The attendance requester snapshot currently carries only `id` / `name`, and next-step
assignments are rebuilt when the previous step advances. The lock must add create-time hydration of
`managerId` / `deptHeadId` / `managerChainIds` and require every later step to read only that frozen
snapshot. Add a test that mutates directory relations between step 1 and step 2 and proves the assignee
does not change."*

- **Confirmed.** `buildAttendanceApprovalInstancePayload` (`index.cjs:20593-20652`) builds
  `requesterSnapshot: { id: userId, name: requesterName || userId }` (`index.cjs:20620-20623`) — exactly
  `id`/`name`, nothing else — and this is the ONLY place a requester snapshot is constructed (5 call
  sites all funnel through it: `index.cjs:24969`, `27529`, `27856`, `28271`, `28775`). Step-advance
  (`resolveRequest`, `index.cjs:28950-28955`) rebuilds the NEXT step's assignments by calling
  `buildAttendanceApprovalAssignments(flowSteps, nextStepIndex)` — purely a function of the static
  `flowSteps` template and the new index; there is no resolved-org-data snapshot to read from yet
  because none is written at creation.
- **Locked extension points:**
  - **Write (creation-time hydration):** `buildAttendanceApprovalInstancePayload`
    (`index.cjs:20593-20652`) is the single funnel point (per the "Confirmed" bullet above, all 5
    creation call sites route through it) — this is where the org-scoped resolver (§3.3) MUST be
    invoked once, using the `orgId`/`userId` already passed into this function
    by every call site, and its result (`managerId`, `deptHeadId`, `managerChainIds`) written into the
    `requesterSnapshot` object alongside `id`/`name` before it is persisted via
    `upsertAttendanceApprovalInstance` (`index.cjs:20654-20701`, which stores it verbatim as the
    `requester_snapshot` JSONB column).
  - **Read (step-advance, every later step):** `resolveRequest` already `SELECT * FROM approval_instances
    ... FOR UPDATE` (`index.cjs:28898-28901`), so `approval.requester_snapshot` is available in-row at
    every step-advance without a second query. The extension of `buildAttendanceApprovalAssignments`
    (`index.cjs:20549-20591`) to resolve `kind:'direct_manager'`/`'dept_head'`/`'manager_at_level'`
    steps (S7-2/S7-3/S7-4) MUST read `managerId`/`deptHeadId`/`managerChainIds` ONLY from this frozen
    `approval.requester_snapshot` value passed in as a parameter — it must never call the org-scoped
    resolver (§3.3) again, and must never re-query `directory_*` at step-advance, dispatch, admin-jump,
    or return, matching the kernel's own posture at `ApprovalDirectoryOrg.ts:9-12` (module doc: this
    seam exists so `ApprovalProductService.createApproval` can "freeze `managerId` / `deptHeadId` into
    the requester snapshot" once, at bake time).
  - This closes OD-S7-4: **DECIDED — (a) yes, inherit resolve-at-submit freezing**, now concretized at
    named extension points rather than left as a general intent.
- **Required test (per owner):** create an approval with a 2+ step flow using a dynamic kind at step 2;
  after step 1 resolves and before step 2's assignment is built, mutate the requester's directory
  relation (e.g. reassign `is_manager` to a different account, or relink the requester to a different
  manager); advance to step 2; assert the resolved assignee is still the ORIGINAL manager captured at
  creation, not the mutated one.

---

## 4. Fail-closed doctrine — OD-S7-1

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

**DECIDED (owner round-1, 2026-07-16): (a) block-with-error is LOCKED** as the v1 fallback behavior
for OD-S7-1, per the owner's explicit posture ("block-with-error by default"). (b) and (c) remain
listed above for their precedent value and because (c) is cited elsewhere in this lock (§1.2, §3.1) as
the existing legacy-empty-approver behavior — that legacy path is UNCHANGED by this ruling; (a) governs
only the NEW dynamic-source-unresolvable case this lock introduces. A missing directory relation at
runtime for a dynamic-kind step (no manager linked, vacant dept head, chain shorter than the configured
level) is a hard block, not a silent skip, silent auto-approve, or silent admin-route.

### 4.1 Runtime fail-closed for an unavailable resolver (P1, owner round-2 amendment)

The 422 authoring gate (§7 S7-1) covers flow **create/update** only. That alone leaves a window the
owner's round-2 P1 names: a dynamic-kind step can already be persisted (authored while the flag was on
and the resolver available) and then be **reached at runtime** under different conditions — the flag
has since been turned off, the OD-S7-5(d) resolver port was never injected in this deployment, or the
resolver call fails. §4's block-with-error ruling covers the *unresolvable-relation* case (resolver ran,
found nothing); this subsection locks the *resolver-unavailable* case with the same posture:

- **Trigger set (any of):** the dynamic-assignee flag is OFF; the `context.services` resolver port
  (OD-S7-5(d), §6) is absent (`context?.services?.<port>` undefined — same presence-check idiom the
  plugin already uses for `workdayCalendar` at `index.cjs:21095`); or the port call throws / is
  otherwise unavailable.
- **Where it must be enforced — BOTH runtime encounters with a dynamic kind:**
  1. **Request creation** — every request-create path that builds assignments for step 0
     (`buildAttendanceApprovalAssignments(steps, 0)` call sites: `index.cjs:24972`, `27537`, `27864`,
     `28279`, `28783`). If any step in the flow (not just step 0 — a flow whose LATER step is dynamic
     must not be allowed to start and then strand mid-flight) carries a dynamic `kind` while the
     trigger set holds, the request-create MUST fail with an explicit error (surfaced as 422 to the
     client, consistent with §7 S7-1's error-code family) **before** the request/instance/assignment
     inserts run.
  2. **Step-advance** — `resolveRequest`'s non-final branch (`index.cjs:28949-28955`), where the next
     step's assignments are rebuilt. If the NEXT step carries a dynamic `kind` while the trigger set
     holds, the advance MUST fail explicitly **before** the `UPDATE approval_instances`
     (`index.cjs:28936-28945`) and before `replaceAttendanceApprovalAssignments` — the check runs
     first, and since the whole branch already executes inside `db.transaction`
     (`index.cjs:28878`), any later-detected failure must still roll back atomically, leaving no
     partial mutation (no advanced `current_step`, no swapped assignments, no appended record).
- **NEVER the legacy admin fallback.** Under no trigger condition may a dynamic-kind step fall
  through to the `role:'admin'` + `source_queue` legacy-empty fallback (`index.cjs:20583-20588`).
  That fallback remains reserved exclusively for LEGACY static steps with empty
  `approverUserIds`/`approverRoleIds`.
- **Flag-off byte-identity, re-scoped:** the §5 "flag-off must be byte-identical to today's behavior"
  boundary applies ONLY to flows containing **no** dynamic kind. A flow that contains a dynamic kind
  has no legacy behavior to be byte-identical to — for such flows, flag-off means explicit failure
  (this subsection), not silent legacy routing.
- **Required tests (owner-named, both paths):**
  - (a) flag ON → author a dynamic-kind flow (accepted) → flip flag OFF → submit a request against
    that flow → request creation fails explicitly; no `attendance_requests` /
    `approval_instances` / `approval_assignments` rows persisted.
  - (b) flag ON → create a request on a flow whose step 2 is dynamic → flip flag OFF → step 1
    assignee calls approve (in this engine the advance to step 2 happens synchronously inside that
    call, `index.cjs:28935-28955`) → the call fails explicitly and the transaction rolls back; the
    instance still shows step 1 pending semantics (no `current_step` bump, no assignment swap, no
    appended approval record, no admin-fallback rows).

---

## 5. Hard boundaries

- **Zero permission-layer changes — RBAC scope only; does not exempt §3's assignment-authorization
  fix.** Resolution determines *who the candidate approver is*; whether that person holds the broad
  `attendance:approve` RBAC/scheduler-scope to act on requests like this one (org admission,
  membership) is unchanged and out of this lock's scope. This bullet is about RBAC — it is NOT a
  carve-out for §3's requirement that approve/reject additionally check the actor against the specific
  active assignment for the current node. §3's fix closes a pre-existing gap (the reject path already
  had zero assignment check before this lock; approve's check already existed but only covered legacy
  fields) that this lock's own dynamic assignments make materially worse if left unfixed — it is a
  locked prerequisite of S7 (§7 S7-0), not new RBAC surface.
- **Org data read-only from `directory_*`.** Whichever architecture OD-S7-5 picks, the new read path
  must mirror the CI-enforced boundary already governing `ApprovalDirectoryOrg.ts`: only `SELECT`s
  against `directory_*`/`directory_account_links`, writes nothing, and never touches
  `approval_*`/`automation_*` convergence-guarded tables from this seam (doctrine + CI enforcement
  cited at `ApprovalDirectoryOrg.ts:14-25`, #2738/#2740/#2742).
- **No cross-org resolution.** Must preserve the existing `integration_id`-scoped binding
  (`ApprovalDirectoryOrg.ts:425-429` — "both sides bind the one requester integration scope"); a
  department's manager in one org/integration must never leak into another's routing. **Amendment
  (§3.3): this bullet is now a concrete, testable contract, not just an inherited posture** — the
  attendance-facing resolver call MUST additionally anchor the requester-account SELECT itself on the
  attendance `orgId` (via `directory_integrations.org_id`), because the unscoped account pick
  (`ApprovalDirectoryOrg.ts:177-200`, no `orgId` parameter today) is upstream of the `integration_id`
  binding this bullet already required — an unscoped pick can choose the wrong integration in the first
  place, which the existing `integration_id`-binding language does not by itself prevent.
- **组织集成平台线（owner 词汇中的「B1」——非本文 §2 里作为 manager_at_level 读法代号的 B1）、multi-org 与 飞书 explicitly OUT.** The org-relation plumbing this lock builds on is
  DingTalk-only today (`ApprovalDirectoryOrg.ts:27` — "Provider shape (DingTalk, the only synced
  provider today)"). S7 inherits that boundary as-is: no Feishu/WeCom directory parsing, no
  multi-org/cross-base resolution, added in this slice.
- **No auto-enable.** Ships behind a default-OFF flag (name TBD at implementation time, e.g.
  `ATTENDANCE_APPROVAL_DYNAMIC_ASSIGNEE_SOURCES_ENABLED`); flag-off must be byte-identical to today's
  `{name, approverUserIds, approverRoleIds}`-only behavior **for flows containing no dynamic kind —
  round-2 re-scoping (§4.1): a flow that DOES contain a dynamic kind has no legacy behavior to be
  byte-identical to; under flag-off it fails explicitly at request creation / step-advance, never
  routes via the legacy admin fallback.** **Amendment (§7 S7-0/S7-1): flag-off does
  NOT mean "inert config accepted silently" — a step authored with a `kind` value that is either
  flag-disabled or has no implemented resolver yet MUST be rejected fail-closed (422) at
  create/update time, never accepted and left dormant (see §7); and per §4.1 the same fail-closed
  posture applies at RUNTIME for dynamic-kind steps already persisted (flag-off / port missing /
  resolver unavailable ⇒ explicit failure before any mutation).**
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

## 6. OD decision points (owner)

| OD | Question | Options | Status |
|---|---|---|---|
| **OD-S7-1** | Fallback behavior for an unresolvable dynamic assignee (§4) | (a) block-with-error · (b) fallback-to-named-role · (c) route-to-admin (existing precedent, `index.cjs:20583-20588`) | **DECIDED (owner round-1, 2026-07-16): (a) block-with-error, LOCKED.** See §4. |
| **OD-S7-2** | Multi-level depth semantics (§2.3) | (i) surface `continuous_managers` only (chain-as-set) · (ii) surface `manager_at_level` only (per-level sequential/B1) · (iii) surface both · plus: attendance-side authoring max-N, independent of the kernel's env-tunable 10/50 cap | **DECIDED (owner round-1, 2026-07-16): (ii) `manager_at_level` only for v1.** `continuous_managers` moves to explicitly-OUT-of-v1 (§8) — quorum-semantics gap, re-entry condition = an attendance quorum/count-of-acted-assignees engine. See §2.3 amendment note and §3. **Round-2 addendum — the leftover authoring max-N is settled: attendance's authoring-side maximum `level` = the kernel's `MAX_MANAGER_CHAIN_LEVELS` constant itself (`ApprovalDirectoryOrg.ts:101`; env-resolved, default 10 at `:76`, hard ceiling 50 at `:79`), NOT an independent attendance-side number — one constant, two surfaces, no drift. See §7 S7-1's discriminated-union contract.** |
| **OD-S7-3** | Department-head / direct-manager definition — already decided at the kernel (§2.1/§2.2, data-source-driven: `is_manager` flag → legacy `leader_in_dept` fallback for manager; `dept_manager_userid_list` for dept head), not role-based. Does attendance's new step kinds inherit this exact definition? | (a recommended) yes, byte-identical semantics regardless of OD-S7-5's answer — two approval surfaces disagreeing about "who is my manager" would be a worse outcome than either being wrong consistently · (b) attendance defines its own (would require its own design rationale; not recommended without a stated reason) | **DECIDED-CONDITIONAL (owner round-1, 2026-07-16): (a) yes, byte-identical — for `direct_manager`/`dept_head`/`manager_at_level` only (OD-S7-2 narrows the kind set), and GATED on the §3.3 org-anchor fix landing first** — byte-identical semantics only holds if the underlying account pick is anchored to the correct org; an unscoped pick could be byte-identical to the WRONG org's kernel answer. |
| **OD-S7-4** | Stale-org-data / resolve-timing posture — already decided at the kernel (§2, "freeze point": resolve-at-submit, frozen into the requester snapshot, never re-queried live at dispatch/admin-jump/return). Does attendance inherit this same point-in-time-freeze? | (a recommended) yes — inherit resolve-at-submit; a manager reorg mid-flight cannot silently change who can approve an in-flight request, matching the kernel's deliberate posture · (b) resolve-at-each-step (more "live," but reopens the exact staleness/race class the kernel closed; would need its own justification) | **DECIDED (owner round-1, 2026-07-16): (a) yes — inherit resolve-at-submit, concretized at named extension points (§3.4).** |
| **OD-S7-5** | **Architecture: does plugin-attendance reuse the kernel's resolver/org-relation code, or reimplement it?** This is upstream of OD-S7-3/OD-S7-4 in practice — if (a) is chosen, those two collapse automatically; if (b), they become hand-verified invariants. | (a) add `@metasheet/core-backend` as a **real runtime** dependency of `plugin-attendance` (pnpm workspace already includes both `packages/*` and `plugins/*`, so a `workspace:*` dependency resolves) and call the existing `resolveApprovalRequesterOrgRelations`/`resolveApprovalAssignees`-equivalent read paths directly — zero logic duplication, automatic parity with the kernel's already-hardened cycle guards/self-exclusion/B3 precedence. **Caveat, verified:** every existing plugin→`@metasheet/core-backend` import found in this repo (`plugin-audit-logger`, `plugin-view-gantt`, `plugin-intelligent-restore`) is `import type` only — compile-time-erased, zero runtime dependency. This would be **the first runtime cross-package import from a plugin**, a new precedent, not an established pattern · (b) duplicate the read-only `directory_*` SELECT + chain-walk logic locally inside `index.cjs`, consistent with the plugin's current fully self-contained packaging (only `zod` as a dependency, no `src/` build step) — but forks ~150 lines of already-hardened logic (cycle guard, self-exclusion, B3 dual-source precedence, dense-chain walk) and creates an ongoing drift risk between the two approval surfaces · (c) don't wire attendance's own resolution this slice — migrate attendance approval-flow creation to route through `ApprovalProductService.createApproval` entirely, retiring `buildAttendanceApprovalAssignments`. Much larger, cross-cutting refactor (touches the whole `attendance_approval_flows` runtime, not just assignee resolution); likely out of scope for a first S7 slice · **(d) [RECOMMENDED, owner round-1, 2026-07-16] host-injected, narrow, org-scoped resolver PORT via `context.services`**, following the EXISTING `workdayCalendar` capability pattern byte-for-byte: `PluginServices.workdayCalendar` is declared as an optional, narrowly-typed port (`packages/core-backend/src/types/plugin.ts:958-980`, the port's `resolve(orgId, asOf)` signature is itself org-scoped by construction — direct precedent for §3.3's org-anchor requirement); the host registers a per-plugin binding at plugin-load time (`packages/core-backend/src/index.ts:1715-1719`, tracked via `registerPluginWorkdayCalendarProvider`, `index.ts:939-949`, unbound on plugin reload/deactivate, `index.ts:951-958`); the CONSUMER checks `context?.services?.<port>?.<method>` before calling (`plugin-attendance/index.cjs:21095-21098`, itself the PROVIDER side of that particular port — S7's new port would run the same shape in the opposite direction: core-backend as PROVIDER, plugin-attendance as CONSUMER). This gets (a)'s "call the kernel's hardened logic directly, zero duplication" property without (a)'s "first runtime cross-package import from a plugin" precedent-break, and without (b)'s ~150-line fork/drift risk — the kernel code stays inside `packages/core-backend`'s own process boundary; only a narrow, typed function crosses via `context.services`, exactly like `workdayCalendar` already does today for the reverse (attendance→approval) direction. | **DECIDED (owner round-2, 2026-07-16): (d) — `context.services` narrow, org-scoped resolver port.** Owner's ruling: the plugin must NOT take a runtime dependency on the whole core package (rules out (a)) and must NOT copy the resolver logic locally (rules out (b)); a dynamic flow encountered while the port is missing fails closed per §4.1 (never legacy admin fallback). (a)/(b)/(c) remain listed as the considered-and-rejected menu. |
| **OD-S7-6** | Unlinked-directory / no-sync precondition. `resolveApprovalRequesterOrgRelations` returns `{}` for any requester with no linked directory account (`ApprovalDirectoryOrg.ts:202`) — meaning every dynamic-source step for a not-yet-synced or purely-local user resolves empty on day one, for every such user, invisibly. Should attendance authoring proactively warn/guard when picking a dynamic-source kind for an org without directory sync configured, or is this left to fall through to OD-S7-1's fallback at runtime? | (a) authoring-time warning only (mirrors A1's existing soft-warning idiom for empty static approvers, `attendanceApprovalSteps.ts:126-141`) — non-blocking, surfaces the risk without hard-gating · (b) no authoring-time signal; rely entirely on the OD-S7-1 runtime fallback · (c) hard-block authoring a dynamic-source step for an org with zero linked directory accounts | **DECIDED (owner round-2, 2026-07-16): (a) — authoring-time explicit warning, NO hard save-block.** The correctness gate is the RUNTIME block-with-error (§4 / §4.1), not the authoring gate — this deliberately allows a configure-first-sync-later rollout (author the dynamic flow before directory sync is wired, warned but not blocked) without ever risking silent reassignment: an unresolvable step still hard-blocks at runtime. Extends the A1 soft-warning idiom (`attendanceApprovalSteps.ts:126-141`). |

OD ledger after round 2 (2026-07-16): **OD-S7-1 DECIDED** (block-with-error, round-1), **OD-S7-2
DECIDED** (`manager_at_level` only, round-1; authoring max-N settled = `MAX_MANAGER_CHAIN_LEVELS`,
round-2), **OD-S7-3 DECIDED-CONDITIONAL** (byte-identical inheritance locked, gated on the §3.3
org-anchor fix landing first), **OD-S7-4 DECIDED** (resolve-at-submit inherited, concretized in §3.4
— no gate), **OD-S7-5 DECIDED** ((d) `context.services` narrow org-scoped resolver port, round-2),
**OD-S7-6 DECIDED** ((a) authoring warning + runtime hard block, round-2). No OD remains OPEN;
OD-S7-3's condition (§3.3 lands first) is the only outstanding gate. **None of this flips the
document's own Status (front matter) to RATIFIED** — that is a separate, owner-only action following
re-review of this amendment.

---

## 7. Slicing

Each slice is independently flag-gated (§5) and ships with real-DB tests mirroring the kernel's
existing test shape (`packages/core-backend/tests/unit/approval-assignee-resolver.test.ts`,
`packages/core-backend/tests/integration/approval-manager-chain.db.test.ts`) plus an adversarial
review with 0 P1/P2 before merge — the same completion bar A1 used
(`attendance-approval-flow-editor-a1-verification-20260708.md` §3-§4).

- **S7-0 — authorization-source hardening (NEW, amendment, prerequisite — blocks S7-1..S7-5).**
  Closes §3.1/§3.2: extend the current-node authorization check in `resolveRequest`
  (`index.cjs:28846-29470`, the branch/mutation logic at `index.cjs:28918-28955`) to read the active `approval_assignments` rows for
  `(instance_id, node_key, is_active = TRUE)` (superseding `isApproverAllowed`'s legacy-only read,
  `index.cjs:20764-20774`) and apply the SAME check symmetrically to both `action === 'approve'`
  (today: `index.cjs:28918-28926`) and `action === 'reject'` (today: no check at all). Preserve
  `hasAttendanceAdminAccess` (`index.cjs:20491-20495`) as the override for both. This slice has value
  independent of S7's new kinds (the reject-path gap is pre-existing against LEGACY `approverUserIds`/
  `approverRoleIds` too) and is a hard prerequisite before S7-2 starts writing dynamic assignments —
  writing a correct dynamic assignee without this fix is exactly the vulnerability the owner's P1
  finding named. **Round-2 lock-down: the check's matching semantics are per-`assignment_type`,
  adopting the `ApprovalBridgeService.ts:359-363` predicate verbatim (§3.2) — `user` on actor id,
  `role` on the actor's role ids, `source_queue` on the actor's permission strings — with the admin
  override applied only after a failed match.** Real-DB tests per §3.2's required-test list
  (unassigned-actor-rejected on both actions, resolved/legacy assignee succeeds, admin override
  succeeds without being the assignee, mutation test proving the pre-fix reject path lets an
  unassigned actor through) **plus the round-2 twelve-leg matrix: positive + negative per
  `assignment_type` ∈ {user, role, source_queue}, each on BOTH approve and reject.**
- **S7-1 — contract + extension point + fail-closed authoring gate (amended).** Implements the
  OD-S7-5(d) architecture (DECIDED, §6 — `context.services` resolver port; the port's TYPE/injection
  seam lands here even though the first consuming resolver arrives in S7-2). Extends the
  `attendance_approval_flows` step JSON contract with an optional `kind` field (backward compatible —
  absent `kind` keeps today's `user`/`role` behavior byte-for-byte); removes the two silent-drop
  layers (`approvalStepSchema` gains the new optional fields — NOT blanket `.passthrough()`, see the
  discriminated union below; `normalizeApprovalSteps` stops reconstructing from a three-key
  allowlist). **Amendment (P2, owner round-1): schema-accepting a
  `kind` value is NOT sufficient — the create (`POST /api/attendance/approval-flows`,
  `index.cjs:30300-30351`) and update (`PUT /api/attendance/approval-flows/:id`, `index.cjs:30353+`)
  route handlers, both of which already call `normalizeApprovalSteps` on the parsed steps before
  persisting, MUST additionally validate every step's `kind` (if present) against the set of kinds
  that are BOTH resolver-implemented AND flag-enabled at that moment. A `kind` outside that set —
  whether because its resolver doesn't exist yet (pre-S7-2/S7-3/S7-4) or because
  `ATTENDANCE_APPROVAL_DYNAMIC_ASSIGNEE_SOURCES_ENABLED` is off — MUST fail the create/update with
  `HttpError(422, 'APPROVAL_STEP_KIND_UNAVAILABLE', ...)` (the existing `HttpError(422, CODE, message)`
  idiom already used throughout this file, e.g. `index.cjs:13250,13256,13266,13271,13274,13300,10528`).
  This is what prevents the exact "unsafe partial state" the owner flagged: a `kind`-tagged step must
  never round-trip inert with no static approvers and no working resolver, silently falling through to
  the legacy admin-queue fallback (`index.cjs:20583-20588`) at runtime. `continuous_managers` is
  EXCLUDED from the acceptable-kind set even once the flag is on and even after any future re-entry
  work (§8) — its exclusion is a v1-scope decision (OD-S7-2), not a flag state.** The authoring gate is
  complemented by the §4.1 RUNTIME fail-closed gate (P1, round-2) for dynamic-kind steps that were
  validly authored and are later reached under flag-off / port-missing / resolver-unavailable
  conditions.

  **Round-2 amendment (P2) — persisted step-shape contract is a DISCRIMINATED UNION, locked:**
  a persisted step is EITHER **static** — `{name?, approverUserIds?, approverRoleIds?}`, NO `kind`
  key — OR **dynamic** — `{name?, kind, ...kind-specific params}`, NO `approverUserIds`/
  `approverRoleIds` keys. The two shapes are mutually exclusive; a step carrying both a `kind` and
  either static approver array MUST 422 at create/update (mixing would create an ambiguous
  precedence question — does the static list back-stop the dynamic resolution? — that this lock
  refuses to leave implicit; a backstop, if ever wanted, is OD-S7-1(b), which the owner did not
  choose). Per-kind params, mirroring the kernel's own discriminated union
  (`packages/core-backend/src/types/approval-product.ts:145-166`):
  - `kind: 'direct_manager'` — no params;
  - `kind: 'dept_head'` — no params;
  - `kind: 'manager_at_level'` — REQUIRED `level`: integer, `1 ≤ level ≤ MAX_MANAGER_CHAIN_LEVELS`
    (the kernel constant, `ApprovalDirectoryOrg.ts:101` — env-resolved via
    `APPROVAL_MANAGER_CHAIN_MAX_LEVELS`, default 10 at `:76`, hard ceiling 50 at `:79`). This
    mirrors the kernel's enum-strict validation byte-for-byte: `ApprovalProductService.ts:512-519`
    rejects a missing / non-number / non-integer / `< 1` / `> MAX_MANAGER_CHAIN_LEVELS` level with
    an explicit validation failure ("never silently defaulted (enum-strictness)", `:513-514`), and
    an unrecognized `kind` falls to the `default:` rejection arm (`ApprovalProductService.ts:529-531`).
    Attendance's authoring gate MUST reject the same five malformed shapes the same way — unknown
    `kind`, missing `level`, non-integer `level`, out-of-range `level`, static/dynamic key mixing —
    all `HttpError(422, ...)`, never coerced, defaulted, or stripped. This also settles OD-S7-2's
    leftover authoring max-N: the attendance-side maximum IS `MAX_MANAGER_CHAIN_LEVELS` — one shared
    constant, no independent attendance cap to drift.
- **S7-2 — 直属上级.** Wires `buildAttendanceApprovalAssignments` to resolve `kind:'direct_manager'`
  steps via the OD-S7-5(d) resolver port (DECIDED, §6), reading ONLY the frozen `requesterSnapshot.managerId`
  hydrated at creation (§3.4) — never a live directory re-query. Real-DB tests: linked requester
  resolves correctly, self-exclusion, unlinked requester triggers OD-S7-1's `block-with-error`
  (§4, now LOCKED), org-anchor two-org/one-local-user test (§3.3), plus the S7-0 authorization tests
  (§3.2) re-run against this kind's assignments specifically.
- **S7-3 — 部门主管.** Same shape for `kind:'dept_head'`, reading `requesterSnapshot.deptHeadId`.
  Real-DB tests: vacant dept head (no `dept_manager_userid_list` entry resolves to a linked user),
  self-exclusion, plus the same org-anchor and authorization re-tests as S7-2.
- **S7-4 — 多级上级, NARROWED (amended per OD-S7-2 DECIDED).** v1 implements `manager_at_level`
  ONLY — per-level sequential resolution of a SINGLE positional level from
  `requesterSnapshot.managerChainIds` (§3.4), authoring N nodes at levels `1..N` composing sequential
  escalation manually (no publish-time auto-expansion, matching the kernel's own posture,
  `ApprovalAssigneeResolver.ts:205-225`). `continuous_managers` (chain-as-approver-set) is NOT part of
  this slice — see §8 for its explicit-OUT status and re-entry condition. Cycle/cap tests mirror the
  kernel's guards (visited-set cycle stop, dense-chain walk-through, `maxLevels` bound) as they apply
  to the chain-walk that builds `managerChainIds` at creation time (§3.4), plus the same org-anchor and
  authorization re-tests as S7-2/S7-3.
- **S7-5 — A1 editor wiring.** `AttendanceApprovalFlowStepsEditor.vue`/`attendanceApprovalSteps.ts`
  gains a step-kind picker offering `direct_manager`/`dept_head`/`manager_at_level` ONLY (NOT
  `continuous_managers` — narrowed per OD-S7-2); preview JSON reflects the new shape; the existing
  empty-approver warning (`stepHasNoApprover`, `attendanceApprovalSteps.ts:122-124`) is extended per
  OD-S7-6's DECIDED posture (§6, round-2: (a) explicit authoring-time warning for dynamic-kind steps
  in an org without directory linkage, NO hard save-block — the runtime block-with-error is the
  correctness gate). Payload-shape discipline from A1
  (`{name,requestType,steps,isActive,orgId}` unchanged at the top level) carries forward unchanged.

**Completion bar per slice (amended round 2):** real-DB tests including (1) a negative/mutation check
for the fallback path locked in OD-S7-1 — an unresolvable-assignee test must fail the OLD way (silent
skip or silent auto-approve) before the fix and pass the NEW way (block-with-error) after; (2) for S7-0
and every kind-resolving slice (S7-2/S7-3/S7-4): the §3.2 authorization negative tests (unassigned
actor rejected on both approve and reject, admin override preserved, mutation test on the pre-fix
reject gap) **including the round-2 twelve-leg per-`assignment_type` matrix (positive + negative for
`user`/`role`/`source_queue`, each on approve AND reject)**; (3) for every kind-resolving slice: the
§3.3 org-anchor two-org/one-local-user test; (4) for every kind-resolving slice: the §3.4 freeze test
(mutate directory relations between step 1 and step 2, assert the assignee does not change); (5) for
S7-1: the fail-closed-422 authoring tests — an unimplemented or flag-off `kind` is rejected at
create/update, not accepted, **plus the round-2 discriminated-union rejection matrix: unknown `kind`,
missing `level`, non-integer `level`, out-of-range `level` (0 and `MAX_MANAGER_CHAIN_LEVELS + 1`), and
static/dynamic key mixing — each 422, each asserted on both create and update routes**; (6) **for the
slice that lands the §4.1 runtime gate (S7-1, and re-verified by S7-2..S7-4): the two owner-named
flag-flip paths — (a) flag-off between authoring and request submission ⇒ request creation fails with
zero persisted rows; (b) flag-off between step 1 approval and the dynamic step 2 advance ⇒ the
approve call fails and rolls back with the instance still pending at step 1**; (7) flag-off
byte-identity test — scoped per §4.1 to flows with no dynamic kind; (8) adversarial review 0 P1/P2;
(9) verification MD.

---

## 8. Explicitly-out + relation to the A1 observation window

**Explicitly OUT of S7 (all slices):**

- 会签/或签/条件/并行/表单 schema authoring in attendance's editor — A1's own §5 already ruled this out
  ("考勤引擎不支持 → 编辑器不呈现，不假装支持"); S7 does not reopen it.
- 考勤请求发起中央模版 + 终态回写闭环 (档 B) — separate, governance-gated, unrelated to resolver work.
- Feishu/WeCom directory-provider parsing (§5).
- Multi-org/cross-base resolution (§5).
- Any RBAC/permission-layer change (§5) — note §3's assignment-authorization fix is NOT an RBAC change
  (see §5's carve-out); it is explicitly IN scope as S7-0.
- Auto-enabling the new capability without an explicit flag flip (§5).
- **`continuous_managers` (chain-as-approver-set multi-level reading) — NEW, amendment, OD-S7-2
  DECIDED (§6).** RATIFIED and SHIPPED at the kernel (§1.1), but explicitly OUT-of-v1 for attendance:
  its semantics depend on `approvalMode` (会签/或签) quorum state (`ApprovalGraphExecutor.ts:44,690,
  891-898,1160-1167,1266`) that attendance's `resolveRequest` does not have — attendance advances a
  step on a single approve call (`index.cjs:28928,28935,28949-28955`). **Re-entry condition:** a real
  attendance quorum/count-of-acted-assignees engine, itself a separate, gated line of work — not
  something a future S7 sub-slice can add as a side effect.
- **An unimplemented-or-flag-off `kind` value landing inert in the schema — NEW, amendment, §7
  S7-1.** Fail-closed 422 at authoring time, never a silent round-trip into a dormant admin-fallback
  step. **Round-2 extension (§4.1): the same fail-closed posture at RUNTIME — a persisted dynamic-kind
  step reached at request creation or step-advance while the flag is off, the resolver port is missing,
  or the resolver is unavailable fails explicitly before any assignment/instance mutation, never the
  legacy admin fallback.**

**Relation to the A1 observation window:** A1's own closeout note recommended the owner watch A1 live
before deciding on A2: *"A1 落地后部署，建议 owner 在 live 环境目视审批流创建界面手感，再决定 A2"*
(`attendance-approval-flow-editor-a1-verification-20260708.md` §6). A1 merged 2026-07-08 (`85c232612`,
#3893). Per this task's own dispatch framing, the owner's 2026-07-16 ruling is what closes that
observation window and opens the S7/A2 line **at the scope level** (naming the three resolver types).
**That is a separate gate from ratifying this document's semantics.** I found no separately-named
"7-day trial" governance artifact beyond A1's own closeout recommendation — I'm treating the dispatch's
framing as authoritative for the scope-opening event, but flagging that this specific search turned up
no standalone trial-window document to cite independently. Either way: **no S7-0..S7-5 implementation
PR should be opened until this lock itself is explicitly owner-RATIFIED** — scope being open is not the
same as this document's OD's (§6) being decided, and this amendment resolving six review findings is
not itself a ratification event.
