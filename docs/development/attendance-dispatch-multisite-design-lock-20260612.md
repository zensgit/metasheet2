# 考勤调度 / 多门店 design-lock（2026-06-12）

## 0. Lock

本设计锁把 OPTIONAL 里的「调度 / 多门店」从 0 推进到可实施边界，但不直接写 runtime。目标不是复刻硬件考勤机或薪资成本分摊，而是在现有小组织、排班发布、换班、多班次和 scheduler-scope 底座上，补一个审批驱动的跨门店/跨小组织调度能力。

**Owner decisions locked:**

1. **v1 只做按天调度**：一张申请调度一个员工在一个日期区间内到目标小组织/门店工作，并在审批通过后写入排班事实。批量调度后续可由 UI 批量创建多张申请或另起批量设计；永久调度和小时支援先不混入 v1。
2. **不做硬件/考勤机绑定**：DingTalk 的考勤机绑定部门属于硬件/原生生态，不进入 metasheet2 v1。多门店归属由 `attendance_schedule_groups.department_ref` / `attendance_group_id` 表达。
3. **排班事实仍是 `attendance_shift_assignments`**：调度通过后写 `producer_type='schedule_dispatch'` 的 published direct assignments；effective-calendar、planned-minutes、shiftCompliance 和报表继续读既有 assignment resolver，不新增第二套排班真源。
4. **成员归属是辅助事实**：目标小组织 membership 可以写 `attendance_schedule_group_members.source='schedule_dispatch'` 的有效期 row，供 scoped 管理、查询和后续报表使用；它不单独改变 effective-calendar。
5. **必须走 dedicated route 创建/管理调度申请**：`request_type='schedule_dispatch'` 不允许 generic `/api/attendance/requests` create/update 伪造；create/list/read/cancel 走专用 API。最终审批仍进入 generic approval resolver，但必须执行 dispatch-specific scope/pre-write guards；D3 才打开真正 assignment/member write。
6. **完成口径**：D1–D5 全部落地并 staging smoke PASS 后，才把「调度」从 ⬜/🟡 翻 ✅。设计锁本身只把状态推进到 🟡。

## 1. Pre-flight

D0 review baseline: `88f5f538a`（#2501，#2546 merge-base；已包含 #2545 SO3 closeout）。

查重结果：

- open PR：没有 attendance/dispatch/multisite 调度 PR。
- remote branch：`feat/attendance-scheduling` 存在，但与 D0 review baseline **无 merge-base**，且是旧版大分支（`c41904dc9 feat(attendance): add scheduling with shifts, holidays, and off-day support`）。不复用、不 rebase、不把它当当前并行工作。
- existing substrate:
  - `attendance_schedule_groups` / `attendance_schedule_group_members` 已有 parent/dept、effective window、source、scope guard。
  - `attendance_scheduler_scopes` 已有 `dispatch` action，但它当前是排班写入/自动对班/小组织成员管理权限，不是“人员调度”产品能力。
  - `attendance_shift_assignments` 已有 `slot_index`、publish lifecycle、`producer_type/ref/key/run_id` provenance。
  - `shift_swap` 已证明 request envelope + dedicated route + final-approval writer + producer assignment 的模式可行。

Current landed status（2026-06-12）:

- D1 contract is landed in #2551.
- D2 dedicated create/list/read/cancel API is landed in #2553, including generic final-approval/cancel cleanup guards while the final writer is pending.
- D3 final approval writer is still not landed; the final-approval scope revalidation in this design remains the D3 acceptance lock.

## 2. Scope

### In Scope v1

- `schedule_dispatch` request type。
- 专用 create/list/read/cancel routes。
- admin 创建按天调度申请：选择调度员工、目标小组织、目标班次、日期区间、slotIndex、原因、approvalFlowId。
- final approval writer：事务内锁请求和目标用户，写 published direct assignments，写可选小组织 membership window，并回填 detail row。
- admin/employee UI：管理员在 Advanced scheduling 区域创建/查看调度；员工只读自己的调度状态，不在 v1 自助发起调度。
- scheduler-scope：scope-only actor 必须拥有 `dispatch` 到目标 user + target schedule group + target department 的权限；中央 admin 保持可达。
- real-DB reverse tests + staging smoke。

### Out of Scope v1

- 永久调度（长期组织归属转移）：后续 D6；它会改变 membership 生命周期和历史追踪规则。
- 小时支援：后续 D7；它需要一天内跨门店工时拆分、成本分摊、summary/report 字段扩展，不能塞进按天调度。
- 考勤机绑定部门、设备/Wi-Fi/GPS 原生集成。
- 薪资成本分摊、人件费率、ERP 成本中心写回。
- 多方调度、开放班次市场、自动推荐调度人选。

## 3. Data Model

### D1 table: `attendance_schedule_dispatch_requests`

Add `schedule_dispatch` to the `attendance_requests_type_check` enum and create a detail table:

```sql
attendance_schedule_dispatch_requests (
  request_id uuid primary key references attendance_requests(id) on delete cascade,
  org_id text not null default 'default',
  dispatch_type text not null check (dispatch_type in ('daily')),
  user_id text not null,
  target_schedule_group_id uuid not null references attendance_schedule_groups(id),
  target_attendance_group_id uuid null,
  target_department_ref text null,
  target_shift_id uuid not null references attendance_shifts(id),
  slot_index smallint not null default 0 check (slot_index between 0 and 2),
  start_date date not null,
  end_date date not null,
  publish_status text not null default 'pending',
  source_key text not null,
  assignment_ids uuid[] not null default '{}',
  membership_id uuid null,
  finalized_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (start_date <= end_date)
)
```

Indexes:

- `UNIQUE(org_id, source_key)` for idempotency and duplicate prevention.
- `(org_id, user_id, start_date, end_date)` for list/detail.
- `(org_id, target_schedule_group_id, start_date, end_date)` for admin views.

`source_key` v1:

```text
schedule_dispatch:{userId}:{targetScheduleGroupId}:{startDate}:{endDate}:{slotIndex}
```

Only pending/approved duplicate blocking matters; D2 closes canceled/rejected schedule-dispatch rows by archiving the key with `:archived:{requestId}` so the operator can re-apply.

### `attendance_requests` envelope mapping

`attendance_requests` remains the approval/status envelope and must be written deterministically:

- `id`: request id shared with `attendance_schedule_dispatch_requests.request_id`.
- `org_id`: request org.
- `user_id`: the dispatched employee (`attendance_schedule_dispatch_requests.user_id`), not the admin actor.
- `work_date`: `start_date`. This is the existing single-date anchor used by approval lists; the full range lives only in the detail table.
- `request_type`: `schedule_dispatch`.
- `requested_in_at` / `requested_out_at`: `NULL`.
- `reason`: create-route reason.
- `status`: `pending` on create; final status remains owned by the approval resolver.
- `approval_instance_id`: created with the selected/unique active `schedule_dispatch` approval flow.
- `metadata.scheduleDispatch`: compact snapshot `{ userId, targetScheduleGroupId, targetShiftId, startDate, endDate, slotIndex }` for list rendering only; the detail table is the source of truth.

D1/D2 tests must assert the parent row mapping, especially `user_id = dispatched user` and `work_date = start_date`, so a future route cannot accidentally anchor the request to the admin actor or `end_date`.

## 4. Create Route

Dedicated route:

```text
POST /api/attendance/schedule-dispatch-requests
GET  /api/attendance/schedule-dispatch-requests
GET  /api/attendance/schedule-dispatch-requests/:id
POST /api/attendance/schedule-dispatch-requests/:id/cancel
```

Create validates:

- userId, targetScheduleGroupId, targetShiftId, startDate/endDate, slotIndex, reason.
- target schedule group exists, active, same org.
- target shift exists, same org.
- approvalFlowId, when provided, points to an active `schedule_dispatch` flow; when omitted, exactly one active `schedule_dispatch` flow must exist.
- dates obey `shiftEditPolicy`.
- actor has scheduler-scope `dispatch` to `{ userIds:[userId], scheduleGroupIds:[targetScheduleGroupId], departments:[target.department_ref] }`, unless central admin.
- `target_department_ref` is copied from the reloaded target schedule group, never trusted from client input.
- target date range does not already have a pending/approved dispatch request with the same source key.
- generic `/api/attendance/requests` create/update rejects `schedule_dispatch` with `SCHEDULE_DISPATCH_VIA_DEDICATED_ROUTE`.

The row in `attendance_requests` remains the approval envelope. The detail table is the only structured dispatch source.

## 5. Final Approval Writer

Hook point: the existing `resolveRequest` final approval branch, mirroring `shift_swap`.

Inside the approval transaction:

1. `SELECT ... FOR UPDATE` the `attendance_requests` row and dispatch detail.
2. Reject if already `finalized_at` or assignment ids exist.
3. Lock `attendance_shift_assignments` for the target user via existing per-user assignment lock.
4. Re-load target group and target shift; reject if inactive/missing.
5. Re-run scheduler-scope `dispatch` authorization for the final approving actor against the reloaded `{ userId, targetScheduleGroupId, target.department_ref }`, unless central admin. This is mandatory: `attendance:approve` / approval-flow permission alone is not enough to materialize a schedule write outside the actor's dispatch scope.
6. Re-run `shiftEditPolicy`.
7. Insert one published direct assignment per date or a single date-range assignment:
   - v1 should prefer **one date-range assignment** if the same shift/slot applies for the full interval, because existing assignment conflict and resolver logic support ranges.
   - `producer_type='schedule_dispatch'`
   - `producer_ref_id=request_id`
   - `producer_key='schedule_dispatch:{requestId}:{userId}:{startDate}:{endDate}:{slotIndex}'`
   - `producer_run_id=request_id`
8. Run `findAttendanceScheduleAssignmentConflict` and `enforceShiftComplianceCap` in the same transaction after insert, before commit. If the guard runs after insert, it must exclude the just-inserted assignment id, mirroring the shift-swap pattern; an equivalent pre-insert conflict guard is also acceptable if it proves the same wire behavior.
9. Insert optional schedule group membership window:
   - `source='schedule_dispatch'`
   - `effective_from=startDate`
   - `effective_to=endDate`
   - only if it does not overlap an existing identical target membership window; otherwise reuse existing membership as context.
10. Update detail with assignment ids, membership id, `finalized_at`.

If any guard fails, the approval stays pending and no assignment/membership row is persisted.

## 6. Semantics

- The dispatched schedule is visible through effective-calendar because it is a normal published direct assignment with provenance.
- `isUserScheduledForDate`, planned-minutes, comprehensive-hours preview, shiftCompliance and reports must not add a dispatch-specific resolver path.
- Source assignments are **not** deactivated. Dispatch is an overlay/new direct schedule fact; existing conflict guard decides if it can coexist. This is intentionally different from `shift_swap`, which replaces two exact source rows.
- Multi-shift day: allowed only when `multiShiftDay.enabled=true` and target slot/window does not conflict; otherwise slot must be 0 and normal conflict rules reject overlap.
- Temporary shift and shift-swap rows are protected: v1 does not dispatch over `assignment_kind='temporary'` or `producer_type IN ('shift_swap','auto_shift_match')` unless a future design explicitly allows generated-row dispatch.

## 7. UI

Admin:

- Advanced scheduling / 调度 tab.
- Create form: user, target small organization, target shift, date range, slot index when multi-shift enabled, approval flow, reason.
- Read-only list with status, target group, date range, finalized assignment id(s), no-silent-caps pagination.

Employee:

- Employee view entry for “调度申请”.
- Shows own pending/approved/rejected/canceled requests.
- v1 is read-only for employees; creating a dispatch request remains an admin/scoped-dispatch action to avoid self-service target-group escalation.
- v1 does not support counterparty consent; approval flow owns the decision.

Copy must say “按天调度” and avoid claiming hourly support or cost allocation.

## 8. Tests

Already covered by landed D1/D2 (#2551/#2553):

- D1 contract: DB check constraint, runtime request-type constants/labels, typed DB union, approval-flow request-type support, OpenAPI source + generated artifacts all include `schedule_dispatch`.
- generic `/requests` create/update `schedule_dispatch` -> 422, no detail row.
- approval-flow create/list/select supports `requestType='schedule_dispatch'`; create route rejects missing/ambiguous/inactive flow.
- parent `attendance_requests` row maps `user_id` to dispatched user and `work_date` to `start_date`.
- create route with no scope -> 403 for scope-only actor.
- create route with target schedule group + user + target department dispatch scope -> 201.
- generic final approve rechecks stored dispatch scope and then fails closed with `SCHEDULE_DISPATCH_FINAL_WRITER_PENDING`; generic reject/cancel closes the detail row and archives `source_key`.

D3 final-writer required tests before assignment/member writes can be called complete:

- final approve with `attendance:approve` but no matching `dispatch` scope -> 403 and rollback before write; matching dispatch scope or central admin may proceed to the D3 writer.
- final approve writes exactly one `producer_type='schedule_dispatch'` assignment and optional membership row.
- repeat/replay final approve does not duplicate assignment/membership.
- conflict guard: existing published assignment same slot/date -> 409/422 and approval rollback.
- shiftCompliance cap exceeded -> 422 and approval rollback.
- `shiftEditPolicy` exceeded -> 422 and approval rollback.
- multi-shift disabled rejects non-zero slot; enabled accepts non-overlapping non-zero slot.
- effective-calendar and planned-minutes see the dispatch assignment with no special resolver path.
- staging smoke: create target group/shift/user, create dispatch request, approve, assert effective-calendar shows target shift, provenance exact, membership window present/reused, cleanup residue=0.

## 9. Slice Plan

- D0 design-lock (this PR) — docs only.
- D1 latent schema + request type enum + runtime constants/labels + typed DB union + approval-flow support + OpenAPI/SDK generated contract + generic `/requests` rejection — landed #2551.
- D2 dedicated create/list/read/cancel API and route-level tests — landed #2553.
- D3 final approval writer + conflict/edit-window/compliance/scope guards.
- D4 admin/employee UI.
- D5 staging smoke harness/runbook + staging closeout.
- D6 permanent dispatch design-lock (optional, later).
- D7 hourly support/cost split/report design-lock (optional, later).

## 10. Risks

- **Name collision**: “dispatch” already exists as scheduler-scope action. Runtime code must use `schedule_dispatch` for request/provenance and reserve “dispatch” for permission action.
- **Generated-row ambiguity**: dispatching over shift-swap/auto/temp rows can double-overlay schedules. v1 rejects generated-row sources unless later design proves safe.
- **Membership truth vs schedule truth**: membership helps organization/scoping, but assignments remain the schedule truth. Docs/UI must not imply membership alone changes the work calendar.
- **Hourly support temptation**: current records/reporting are day-level with first/last and optional multi-slot schedule visibility. Hourly support needs separate work allocation semantics.
