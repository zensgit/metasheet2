# 考勤外勤审批 S3 design-lock（仅设计 / 不写码）

> Date: 2026-06-05 · Status: **DESIGN-LOCK — 设计冻结，待显式 opt-in 才实现，本文不含代码**
> 执行账本：`docs/development/attendance-dingtalk-benchmark-target-and-tracker-20260601.md`（H2 MUST「打卡策略组」中的 S3 外勤审批）。
> Parent design-lock：`docs/development/attendance-punch-policy-group-design-lock-20260602.md`（#2203；#2211 已修正顺序为 **S1→S3→S2**）。
> Evidence re-grep @ `origin/main` = `694fb14b0`（#2302 后）。实现期 main 推进时，先 rebase + 重新 re-grep；symbol 名优先于行号。

## 0. Hard Constraints

- **仅设计、不开工**：本文只钉 S3 口径；任何代码另起 opt-in / PR。
- **默认不回归**：`punchPolicy.outdoor.requireApproval=false` 或 unset 时，现有 punch / geoFence / summary / request 行为不变。
- **org 级 v1**：继续沿用 #2203 owner 决策，`punchPolicy` 在 attendance org settings；per-考勤组策略留 follow-up。
- **复用 `attendance_approval_flows`**：不新建审批流模型、不新建中央 RBAC。外勤审批是 attendance request 的一个新 request type。
- **S3 必须先于 S2**：S2 内外勤卡合并依赖 S3 建立“外勤打卡”事实类型。S3 不实现 S2 merge policy。
- **不做原生 app / 防作弊 / 人脸 / AI / 真实照片鉴伪**：`requirePhoto` 仍保持 latent，不在 S3 v1 暴露为可配项，避免假安全。首版只暴露 `requireApproval`、`requireNote`、`approvalFlowId`。
- **不能把 pending 当有效打卡**：外勤 punch 在 requireApproval=true 时先生成 pending request，不写 `attendance_events`，不更新 `attendance_records`；只有 final approve 才落有效打卡。
- **wire-vs-fixture discipline**：合前必须有 real-DB / route-level integration 覆盖 punch→pending→approve/reject 全链路；不能只写 helper fixture。

## 1. Current State @ `694fb14b0`

| Area | 现状 | Evidence |
|---|---|---|
| `punchPolicy.outdoor` latent defaults | 已有 `{ requireApproval:false, requireNote:false, requirePhoto:false, approvalFlowId:'' }`，但 runtime/UI 不读 | `plugins/plugin-attendance/index.cjs:110-117` |
| settings normalize/deep-merge | 已保留 `outdoor` 子对象，partial update 不清空 sibling | `plugins/plugin-attendance/index.cjs:10932-10999` |
| PUT settings schema | 目前只暴露 `punchPolicy.unscheduled.mode=allow|block`；`outdoor.*` 尚未 wire-settable | `plugins/plugin-attendance/index.cjs:16343-16444` |
| geoFence | 目前围栏外直接 `LOCATION_RESTRICTED`，不保留为外勤事实 | `plugins/plugin-attendance/index.cjs:14793-14806` |
| punch route | 现有路由直接 INSERT `attendance_events` + upsert `attendance_records` | `plugins/plugin-attendance/index.cjs:18866-18979` |
| request type enum | `attendance_requests.request_type` 仅 `missed_check_in/missed_check_out/time_correction/leave/overtime` | `packages/core-backend/src/db/types.ts:1054-1069` |
| request type DB CHECK | 迁移约束同样只含上述 5 类 | `packages/core-backend/src/db/migrations/zzzz20260120110000_add_attendance_request_types.ts:1-22` |
| approval resolve hook | final approve 已在 `resolveRequest` 事务内处理补卡/请假/加班；可新增 `outdoor_punch` branch | `plugins/plugin-attendance/index.cjs:20237-20535` |
| approval flow CRUD | `attendance_approval_flows.request_type` 为 string，适合复用新 request type | `plugins/plugin-attendance/index.cjs:21272-21499` |
| duplicate guard | 当前按 `org/user/workDate/requestType` 去重，同一天同 request type 只能一条 pending/approved | `plugins/plugin-attendance/index.cjs:8414-8438` |

## 2. Owner Decisions Locked By This Delta

1. **Request type = `outdoor_punch`**。只新增一个 request type；具体上/下班卡存在 `metadata.outdoorPunch.eventType`。
2. **同日上/下班不能互相挡**。S3 必须改 outdoor duplicate/lock 口径：`outdoor_punch` 的唯一业务键 = `orgId + userId + workDate + eventType`，而不是现有 `orgId + userId + workDate + requestType`。同一天 `check_in` 和 `check_out` 两条外勤 pending 可以并存；同一天同 `eventType` 的第二条 pending/approved 应 409。
3. **外勤候选来源 v1**：
   - `geoFence` 配置存在且 punch location 在围栏外；
   - 或客户端显式传 `meta.outdoor === true` / `meta.outdoorPunch === true`。
   默认 off 时这些信号不改变现状；只有 `punchPolicy.outdoor.requireApproval=true` 才进入 pending 逻辑。
4. **geoFence 顺序调整**：当 `requireApproval=true` 且位置在围栏外时，不再直接 `LOCATION_RESTRICTED`，而是生成 pending outdoor request；当 `requireApproval=false` 时，围栏外仍按现状拒绝。
5. **Approval flow selection**：
   - 若 `approvalFlowId` 非空：必须存在、active、同 org、`request_type='outdoor_punch'`，否则 422 `OUTDOOR_APPROVAL_FLOW_REQUIRED`。
   - 若 `approvalFlowId` 为空：加载该 org active `outdoor_punch` flow；若没有唯一可用 flow，422 `OUTDOOR_APPROVAL_FLOW_REQUIRED`。
   - 不允许 silently fall back 到无审批步骤后自动 approved。
6. **首版不暴露 `requirePhoto`**：字段可继续 normalize，但 PUT schema / UI 不开放；等附件/照片存证 contract 另起 design-lock。`requireNote` 可暴露并强制非空 note。

## 3. Data Model Delta

S3 需要一个小 DDL：

- 更新 `attendance_requests_type_check`：加入 `'outdoor_punch'`。
- 更新 `packages/core-backend/src/db/types.ts` 的 `AttendanceRequestsTable.request_type` union。
- OpenAPI / SDK / frontend 类型同步（若当前生成链要求）。

不新增表。外勤事实放在 `attendance_requests.metadata.outdoorPunch`：

```json
{
  "outdoorPunch": {
    "version": 1,
    "eventType": "check_in",
    "occurredAt": "2026-06-05T09:05:00.000Z",
    "workDate": "2026-06-05",
    "timezone": "Asia/Shanghai",
    "source": "mobile",
    "location": { "lat": 31.2304, "lng": 121.4737 },
    "note": "客户现场",
    "detection": "outside_geofence"
  },
  "approvalFlow": {
    "id": "...",
    "name": "...",
    "steps": [],
    "currentStep": 0
  }
}
```

`requested_in_at` / `requested_out_at` 仍用于现有 request UI 的时间展示：

- `eventType='check_in'` → `requested_in_at = occurredAt`, `requested_out_at = null`
- `eventType='check_out'` → `requested_in_at = null`, `requested_out_at = occurredAt`

## 4. Runtime Flow

### 4.1 Punch-time

1. Validate existing `punchSchema` and resolve `userId/orgId/occurredAt`.
2. Load settings once for constraints + punch policy.
3. Apply IP / future / min-interval constraints as today.
4. Resolve final `workDate/timezone` through existing default-rule + `resolveWorkContext` path.
5. Determine `outdoorCandidate`:
   - outside `geoFence`, or
   - explicit outdoor marker in `meta`.
6. If not outdoorCandidate: continue existing INSERT event + upsert record path.
7. If outdoorCandidate and `requireApproval=false`: existing behavior stays intact. For outside geoFence this means `LOCATION_RESTRICTED`; for explicit meta only, the meta is ignored and normal punch continues.
8. If outdoorCandidate and `requireApproval=true`:
   - require note when `requireNote=true`;
   - resolve active `outdoor_punch` approval flow;
   - acquire outdoor-specific lock including `eventType`;
   - reject duplicate same-day same-eventType pending/approved with 409;
   - create `approval_instance` / assignments and an `attendance_requests` row with `request_type='outdoor_punch'`, `status='pending'`;
   - return `202 Accepted` with `{ pendingApproval: true, request }`;
   - **do not** insert `attendance_events`;
   - **do not** update `attendance_records`;
   - emit `attendance.outdoorPunch.requested` only after DB commit.

### 4.2 Approval-time

In `resolveRequest` final-approval branch:

- `request_type='outdoor_punch'` + final approve:
  - read `metadata.outdoorPunch`;
  - insert exactly one `attendance_events` row with original `eventType` (`check_in` / `check_out`), `source='outdoor_approval'`, original `occurredAt`, location, and metadata `{ requestId, requestType:'outdoor_punch', outdoor:true }`;
  - upsert `attendance_records` in append mode using original punch time and existing resolved work context;
  - do **not** write the generic `adjustment` event for this request type.
- final reject/cancel:
  - request status changes only;
  - no event / no record update.
- multi-step approval:
  - non-final approve keeps request pending;
  - no event / no record update until final approve.

Status guard remains the idempotency layer: re-approve already resolved request returns `400 INVALID_STATUS` and writes no second event.

## 5. Admin UI / Config

S3 complete means frontend configurable, not API-only:

- Add an attendance admin policy card for outdoor approval, preferably near existing punch / policy settings in `AttendanceView.vue`.
- Save with a **top-level PUT payload only**:

```json
{
  "punchPolicy": {
    "outdoor": {
      "requireApproval": true,
      "requireNote": true,
      "approvalFlowId": "..."
    }
  }
}
```

- `toEqual` lock the request body in web tests so unrelated settings keys (`shiftCompliance`, `compTimeFromOvertime`, `unscheduled`, etc.) cannot leak into the save.
- UI copy must be honest: “外勤打卡需审批后计入考勤”。Do not claim photo/anti-cheat/location proof.
- `requirePhoto` remains hidden / disabled with explanatory admin copy only if needed; it is not an active control in S3 v1.

## 6. Tests Required Before Merge

Backend real-DB integration must cover:

1. **Default no regression**: `punchPolicy.outdoor` unset/default keeps current behavior. Outside geoFence still returns `LOCATION_RESTRICTED`; normal in-fence punch still writes event + record.
2. **Pending path**: `requireApproval=true` + outside geoFence creates one pending `outdoor_punch` request and approval instance; no `attendance_events`; no `attendance_records` first/last update.
3. **Approval path**: final approve writes exactly one actual punch event (`check_in` or `check_out`) with `source='outdoor_approval'` and updates record; no generic duplicate `adjustment` event.
4. **Reject path**: final reject leaves no event and no record update.
5. **Same-day eventType key**: same day `check_in` and `check_out` outdoor pending can coexist; duplicate `check_in` while pending/approved returns 409.
6. **Flow guard**: `requireApproval=true` without a usable active `outdoor_punch` flow returns 422 and writes nothing.
7. **Note guard**: `requireNote=true` without note returns 400/422 and writes nothing.
8. **Settings wire**: PUT→GET round-trip for `punchPolicy.outdoor` fields; partial update preserves `unscheduled` and `merge`.

Frontend tests must cover:

1. card renders existing config;
2. save sends only `{ punchPolicy: { outdoor: ... } }`;
3. no in-app text promises photo/AI/anti-cheat;
4. approval-flow picker filters or validates `requestType='outdoor_punch'`.

Staging smoke before ✅:

1. deploy S3 build to staging;
2. create/activate one `outdoor_punch` approval flow;
3. enable `punchPolicy.outdoor.requireApproval=true`;
4. seed geoFence, send outside-location check-in;
5. assert pending request + no event/record;
6. approve; assert one event + record update;
7. send same scenario and reject; assert no event/record;
8. cleanup all smoke rows/settings and record residue.

## 7. Gated TODO

**Design**

- ✅ S3-D1 pre-flight @ `694fb14b0`: no open attendance/outdoor PR; S0/S1 already landed; S2 still blocked on S3.
- ✅ S3-D2 lock request type / duplicate-key / pending-vs-approved state flow.
- ✅ S3-D3 lock frontend and staging completion bar.

**Implementation（全 🔒，须显式 opt-in）**

- 🔒 S3-0 DDL/types/OpenAPI: add `outdoor_punch` request type.
- 🔒 S3-1 backend runtime: settings schema exposure, outdoor candidate detection, punch→pending, approval→effective punch.
- 🔒 S3-2 frontend config UI: org-level outdoor approval card + approval flow selector.
- 🔒 S3-3 real-DB + web tests + staging smoke; only after staging passes can tracker row flip ✅.
- 🔒 S2 in/out merge remains after S3; do not bundle unless owner explicitly widens scope.

## 8. Claude Implementation Goal

If handing implementation to Claude, use this exact scope:

```text
Implement attendance punch-policy S3 outdoor approval, following docs/development/attendance-outdoor-approval-s3-design-lock-20260605.md and parent #2203.

Do not implement S2 in/out merge, C5 external notifications, native app/photo/AI/anti-cheat, or per-group policy.
Default behavior must not change when punchPolicy.outdoor.requireApproval is false/unset.

Required:
- add outdoor_punch request_type DDL/types/OpenAPI if needed;
- expose only requireApproval/requireNote/approvalFlowId under punchPolicy.outdoor;
- outside geoFence or explicit outdoor marker + requireApproval=true creates pending attendance request and no attendance event/record;
- final approve creates exactly one effective punch event and updates record;
- reject/cancel creates no event/record;
- duplicate key includes eventType so same-day outdoor check_in and check_out can coexist;
- route-level real-DB tests for default, pending, approve, reject, duplicate, missing flow, note guard;
- frontend config card with toEqual PUT body test;
- PR body lists staging smoke steps and deferred S2/C5/photo items.
```

## 9. References

- Parent design-lock: `docs/development/attendance-punch-policy-group-design-lock-20260602.md`
- Tracker: `docs/development/attendance-dingtalk-benchmark-target-and-tracker-20260601.md`
- S0 latent settings: #2204
- S1 unscheduled punch: #2209
- ⑤ scheduler reminder closeout: #2294 / #2302
