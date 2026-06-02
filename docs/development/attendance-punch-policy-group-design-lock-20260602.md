# 考勤打卡策略组 design-lock（仅设计 / 不写码）

> Date: 2026-06-02 · Status: **DESIGN-LOCK — 设计冻结，待显式 opt-in 才实现，本文不含代码**
> 执行账本：`docs/development/attendance-dingtalk-benchmark-target-and-tracker-20260601.md`（H2 项 ②「打卡策略组」= 外勤审批 + 内外勤合并 + 未排班打卡策略）。
> Owner 决策已拍板（2026-06-02，见 §9）。证据 `file:line` re-grep @ origin/main `93732c82f`；实现期 main 推进则先 rebase + 重新 re-grep（symbol 名为稳定锚）。

## 0. Hard constraints

- **仅设计、不开工**：任何代码另起 opt-in。
- **不动中央 RBAC / auth / integration-core**；只在 `plugin-attendance` 内做本地配置 + 强制。
- **配置粒度 org 级 v1**：`punchPolicy` 入 attendance org settings（镜像现有 `geoFence`/`ipAllowlist`，`index.cjs:16012-16016`）。**per-考勤组覆盖 = follow-up**，等 punch→user→group→policy 解析链路确有需要再补，不把第一刀拖重。
- **默认全部保持现状 = 不回归底线**：每个新配置项 unset/默认 = 当前行为；强制只对显式开启的 org 生效。
- **`require_approval` / 外勤 pending 不得提前暴露**：这两个能让打卡进入"待审批/不算考勤"的开关，**只有在外勤审批切片（S3）真正接线后才可对外配置**；在那之前 schema 里可预留但 UI/写入不暴露，杜绝"配了却半生效"。
- **punch 是热路径**（`/api/attendance/punch` `index.cjs:18453`，`withPermission('attendance:write')`）：任何强制点都在写库前 fail-safe，错误显式 `4xx`（不抛 HttpError 让路由 catch 变 500——沿用排班修改窗 #2197 的显式-res 教训）。

## 1. Current state @ `93732c82f`（greenfield 核实）

| Area | 现状 | Evidence |
|---|---|---|
| punch-policy 配置 | **0**：`outdoor_punch_policy`/`punchPolicy`/`punchMergePolicy`/`allowUnscheduledPunch` 均无 | grep 0 |
| 已有 org punch 约束 | `geoFence`(lat/lng/radiusMeters) + `ipAllowlist` 在 settingsSchema | `index.cjs:16012-16016` |
| 打卡方式抽屉 #2097 | **只读展示**，无配置写入 | `AttendanceView.vue:4023` |
| punch 路由 | `/api/attendance/punch` | `index.cjs:18453` |
| 审批体系 | `attendance_approval_flows` + attendance_requests(5 类) 已在 | （benchmark 前序） |
| "某用户某日是否已排班" 原语 | **不存在**（无 `isScheduled`/`scheduledForDate` helper） | grep 0 |

## 2. 共享配置基座 `punchPolicy`（一个对象，三件子能力都挂它）

org settings 增一个 `punchPolicy`（zod，全 optional，unset=现状）：

```
punchPolicy: {
  unscheduled: { mode: 'allow' | 'block' | 'require_approval' }?,   // 默认 allow；v1 只实现 allow/block
  merge:       { internalWinsOnIn: boolean, externalWinsOnOut: boolean }?,  // 默认 = 现状合并
  outdoor:     { requireApproval, requireNote, requirePhoto: boolean, approvalFlowId: string }?  // 默认全 false
}
```

> 三件子能力**共用这一个对象**，避免各做各的配置打架（intra-plan 漂移）。`require_approval` 与 `outdoor.*` 在对应切片接线前不对外暴露（§0）。

## 3. 共享原语：`isUserScheduledForDate(orgId, userId, date)`（跨切片，先建一次）

「某用户某日是否已排班」——**未排班打卡（S1，punch-time）与账本 ⑤ 未排班提醒（scan-time）同一判断**。本设计要求**先建成单一共享函数**，⑤ 直接复用（否则 punch 拒卡与提醒扫描会对"谁未排班"各执一词）。

定义（沿用 ⑤ 设计）：仅对 `attendance_type='scheduled_shift'`（排班制）考勤组成员；该日**既无排班组归属**（`attendance_schedule_group_members` 覆盖 date）**又无直接班次分配**（`attendance_shift_assignments` 覆盖 date）= 未排班。排休=已排（不拦）；固定班/自由工时组不适用。

## 4. 三件子能力（config × 强制点 × 默认 × 切片）

| 切片 | 子能力 | 配置 | 强制点 | 默认 |
|---|---|---|---|---|
| **S1** | 未排班打卡策略 | `punchPolicy.unscheduled.mode` | punch 路由 `18453`：`!isUserScheduledForDate` 且 `mode==='block'` → 显式 4xx 拒卡（`PUNCH_UNSCHEDULED_BLOCKED`）。`require_approval` 预留不实现 | `allow`（不回归） |
| **S2** | 内外勤卡合并 | `punchPolicy.merge` | record-write/summary：内/外勤打卡谁赢上/下班卡 | 现状合并逻辑 |
| **S3** | 外勤审批 | `punchPolicy.outdoor` | 外勤打卡→（requireApproval 时）经 `attendance_approval_flows` 进 pending，approved 才算考勤；报表只算 approved。**复用 attendance approval，不新建 flow 表/状态机** | 全 false |

**切片序**（各独立 gated opt-in，CONTRACTS/默认不回归先行）：**S1 未排班打卡（最简、建共享原语、清晰 allow/block）→ S2 内外勤合并 → S3 外勤审批（最重，碰审批流）**。`require_approval`/外勤 pending 的对外配置随 S3 一起开放。

## 5. 默认 / 不回归锁（钉死）

1. **所有 `punchPolicy` 项 unset/默认 = 当前行为**；无任何 org 配置时 punch/合并/报表行为与今日逐字节一致。
2. **`require_approval` 与 `outdoor.*`** 在 S3 接线前**不可对外配置**（schema 可预留，写入/UI 不暴露）。
3. 强制点全部写库前 fail-safe + 显式 4xx（非 throw-into-catch）。

## 6. 强制点汇总
- punch 路由 `18453`：S1 未排班拒卡 + S3 外勤→pending。
- record-write / summary：S2 内外勤合并。
- 报表/统计：S3 只算 approved 外勤。

## 7. 测试 / 验收
- 共享原语 `isUserScheduledForDate`：排班制组×有/无排班组归属×有/无直接班次×排休×固定班组（单测）。
- S1：未排班+block→4xx 拒卡且不写 punch；未排班+allow（默认）→正常打卡（不回归）；已排班→正常。
- S2：内外勤各组合的上/下班卡归属；默认=现状（不回归基线）。
- S3：外勤+requireApproval→pending 不算考勤；approved 后算；report 过滤 approved；默认 off→现状。
- 每片：org 无配置时的不回归基线测 + 反向（拒/pending）真实路径测（非 mock-only；真 DB integration）。

## 8. Gated TODO

**设计阶段**
- ✅ D1 pre-flight @ `93732c82f`：punch-policy greenfield、punch 路由/审批流/原语缺位坐实。
- ✅ D2 锁定一个 `punchPolicy` 基座 + 一个共享原语 + 三段切片序。
- ✅ D3 钉死默认全保持现状 + `require_approval`/外勤 pending 仅随 S3 暴露。

**实现阶段（全 🔒，须显式 opt-in）**
- 🔒 S0 `punchPolicy` settings schema + normalize + deep-merge（latent，默认现状，require_approval/outdoor 不暴露）。
- 🔒 S1 `isUserScheduledForDate` 共享原语 + 未排班打卡 allow/block 强制（punch 路由）+ 测试。
- 🔒 S2 内外勤卡合并策略 + 强制 + 测试。
- 🔒 S3 外勤审批（复用 attendance_approval_flows）+ pending/approved 报表过滤 + 暴露 require_approval/outdoor 配置 + 测试。

## 9. Owner 决策（LOCKED 2026-06-02）
1. **配置粒度 = org 级 v1**（镜像 geoFence/ipAllowlist；per-group follow-up）。
2. **未排班默认 = allow**（不回归底线；v1 只实现 allow/block，require_approval 预留不暴露）。
3. **外勤审批 = 复用 `attendance_approval_flows`**（不新建审批体系）。
4. 默认全保持现状；`require_approval`/外勤 pending 仅在 S3 接线后可对外配置。

## 10. References
- 执行账本：`docs/development/attendance-dingtalk-benchmark-target-and-tracker-20260601.md`
- 排班修改窗（同套显式-res 4xx 教训）：#2197（`2d4808fe0`）
- enforcement design-lock（同体例）：`docs/development/attendance-scheduler-scope-enforcement-design-lock-20260530.md`（#2134）
- punch 路由 `index.cjs:18453` · settings 配置范式 `index.cjs:16012-16016` · 打卡方式抽屉 `AttendanceView.vue:4023`
