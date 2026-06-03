# 排班合规引擎 design-lock（日/周/月工时 cap，超限阻断保存）

> **版本** 2026-06-02 · owner 决策已拍板锁定 · H2 **MUST 招牌**（钉钉最硬护城河）
> **基线** origin/main @ `77ebd86a0`（证据均为 `plugins/plugin-attendance/index.cjs:line`；main 会动，实现分支落地前 re-grep 行号）
> **账本** 本设计是 `attendance-dingtalk-benchmark-target-and-tracker-20260601.md` ③ 项的 design-lock；落地回填账本。
> **前置** pre-flight 2026-06-02 clean（`shift_constraints`/`complianceEngine` 在 main = 0；无 open PR / 近期 commit；老 `codex/...row-cap/highscale` 分支 = 无关的高并发行数上限）。

---

## 0. 一句话

排班保存时，**投影**该用户在受影响的 日/周/月 的**计划工时**（planned minutes），任一窗口超出对应 cap → **阻断保存（422）**。不是报表侧事后预警，是写入时的硬门。

与已有 `comprehensiveHours`（报表侧、**事后累计 `actualMinutes`**、月/季/年 warn）**语义并行但不同**：本引擎是 **保存时、计划 `plannedMinutes`、日/周/月、block**。两者共用底层工时算法，但**不是同一配置对象**。

> **口径修正 2026-06-03（owner 决策 A，S2 amend #2221）：cap = explicit scheduled load，不是 effective-calendar total。** 投影**只统计显式 assignment / rotation / fixed-apply 产生的 planned minutes**，**排除无显式排班的兜底天**（resolver context 的 `assignment` / `rotationAssignment` 引用均为空——用原始引用而非 `source`，避免 calendarPolicy override 改写 `source` 误判）。否则 org 默认工作制（如 Mon–Fri 09:00–18:00 = 2700/周）本身就占满额度，一旦设个真实 weekly cap（如 2400）就会**挡掉所有保存**、像功能坏了。投影**仍复用** resolver primitives（`buildWorkContextPrefetch` + `resolveWorkContextFromPrefetch` + `calculateAttendanceComprehensiveShiftPlannedMinutes`，见 `projectExplicitScheduledMinutesByUser`），只是按显式 assignment 引用过滤掉默认兜底天——非手搓 union。日/周/月统一此口径。

---

## 1. owner 决策（2026-06-02 锁定，不再 re-litigate）

1. **配置 = 新建 `shiftCompliance`，不并入 `comprehensiveHours`。** 理由：时机（save vs report）、口径（planned vs actual）、粒度（日/周/月 vs 月/季/年）都不同，强行复用会让语义混住。
2. **强制点 = 全部 assignment-save 路径**（否则"正门拦、侧门进"，被排班批量应用绕过）：shift POST/PUT + rotation POST/PUT + fixed-schedule apply。**DELETE 不 block**（删除不会增加工时）；**PUT 改日期/范围/启停要算**。
3. **schema 留 `enforcement: warn|block`，首版只交付 `block`。** 默认无 cap 不强制（不回归）。MUST 验收 = "超出禁止保存"（422 + 反向 integration），**不做 UI/报表软提示**（避免和现有 comprehensiveHours warn 口径打架）。`warn` 为预留枚举，v1 解析+持久化但**惰性**（不 block、不提示）——**显式文档化，不是静默 no-op**。

---

## 2. 配置形状（`shiftCompliance`，attendance org-settings JSON，无 DDL）

与 `punchPolicy`(#2203)/`shiftEditPolicy`(#2197) 同列，挂在 attendance 组织设置 JSON：

```
shiftCompliance: {
  enforcement: 'block',     // 'block' | 'warn'（warn 预留，v1 惰性）
  dailyMaxMinutes: null,    // null = 未设 = 该粒度不强制（不回归）
  weeklyMaxMinutes: null,
  monthlyMaxMinutes: null,
}
```

- `normalizeShiftComplianceSetting(raw)`：复用 `comprehensiveHours` 的 `normalizeCap`（正整数分钟，否则 null）；`enforcement ∈ {block,warn}` 否则回落 `'block'`。镜像 `normalizePunchPolicySetting`/`normalizeAttendanceComprehensiveHoursSettings` 的"任何 unset/partial/malformed 都不改变行为"。
- `DEFAULT_SETTINGS.shiftCompliance`（全 null + block）+ `mergeSettings` per-key 浅合并（本对象一层即可，无需 punchPolicy 的两层嵌套）。
- `settingsSchema`（PUT 输入）：`shiftCompliance: z.object({ enforcement: z.enum(['block','warn']).optional(), dailyMaxMinutes/weeklyMaxMinutes/monthlyMaxMinutes: z.number().int().positive().nullable().optional() }).optional()`。

---

## 3. 投影模型（**keystone** — 复用既有 resolver，不手搓两表 union）

**投影源 = `loadAttendanceComprehensivePlannedMinutesByUser(db, orgId, [userId], { from, to })`（`index.cjs:13163`）。** 它内部：prefetch（`buildWorkContextPrefetch`）→ 逐日 `resolveWorkContextFromPrefetch`（**effective-per-day resolver，跨 shift+rotation+override+holiday 拥有 day-level 优先级** — 见 `index.cjs:7883` 注释）→ `buildAttendanceComprehensivePlannedMinutesFromDays` → 每日 `plannedMinutes` 求和。

为什么用它而非手搓 union：
- **零漂移**：与 `comprehensiveHours` 报表用的是**同一套** planned-minutes 计算（`calculateAttendanceComprehensiveShiftPlannedMinutes`）。引擎 enforce 的分钟数 = 日历/报表 compute 的分钟数。手搓第二套两表 union 就是 wire-vs-fixture 漂移陷阱的上一层。
- **绕开共存歧义**：rotation 在独立表 `attendance_rotation_assignments`；resolver 已拥有 day-level 精度，不需要我们判"同日 shift+rotation 谁赢"。（且 `findAttendanceScheduleAssignmentConflict` 是**跨 kind** 的 `index.cjs:8825` → 同一用户同日至多一条 active 派班，跨两表；进一步保证逐日 ≤1 班。）

**Cap 对象 = `plannedMinutes`（计划），不是 actual（实打）。** 这是排班合规（约束**计划**不越界），与 comprehensiveHours 的 actual 报表口径互补。

**强制机制 = 事务内、写后、提交前**（各 save 路由已有 `db.transaction(trx => …)`，见 `29488`/`29618`）：
1. 在既有事务里执行 INSERT/UPDATE（写入待持久状态）；
2. 对每个**已设 cap** 的粒度，调 `loadAttendanceComprehensivePlannedMinutesByUser(trx, orgId, [userId], { from, to })`（传 **trx** → 读到未提交的写后状态）：
   - daily：`{from: D, to: D}`（仅受影响的那些日）；
   - weekly：`{from: 周一, to: 周日}`（受影响日所在周，org tz，ISO 周一起）；
   - monthly：`{from: 月初, to: 月末}`（受影响日所在自然月，org tz）；
3. 任一窗口 `plannedMinutes > maxMinutes` → **throw 一个有类型的 `ShiftComplianceCapExceeded`** → 事务回滚（写被撤销）→ 路由 catch 映射为 **422**。
4. 全部窗口 ≤ cap → 正常提交。

> PUT 的"排除自身旧值"**自动成立**：trx 已是 UPDATE 后状态，resolver 读到的是新派班，旧值已被覆盖——无需手算 delta。这正是用 trx-内投影而非内存 overlay 的收益。

---

## 4. 强制点（全部，line @ 77ebd86a0 — 实现前 re-grep）

| 路由 | 行 | 处置 |
|---|---|---|
| shift assignment **POST** `/api/attendance/assignments` | `29445` | 事务内写后投影；紧贴现有 `enforceShiftEditWindow`(`29473`)/conflict-finder 之后 |
| shift assignment **PUT** `/api/attendance/assignments/:id` | `29538` | 同上；trx 含 UPDATE 后状态 |
| rotation assignment **POST/PUT** `/api/attendance/rotation-assignments[/:id]` | `21452` 起 | 同机制；resolver 已能展开 rotation pattern（`attendance_rotation_rules.shift_sequence`） |
| **fixed-schedule apply** `/api/attendance/groups/:id/fixed-schedule/apply` → `applyAttendanceGroupFixedSchedule` | `27818` / `9193` | **批量**：对 plan 内**每个受影响用户**逐一投影；任一超限 → 整个 apply 回滚 422（不可半应用） |
| GET（list）`/api/attendance/assignments` | `29353` | 读，**不拦** |
| DELETE / soft-deactivate | — | **不拦**（删除不增工时） |

**共享 guard** `enforceShiftComplianceCap(trx, res, { orgId, userId, affectedDates })`：镜像 `enforceShiftEditWindow` 的 `if (!access) return` 形态（throw→rollback→catch→422）。一处实现，五个 hook 共用。

---

## 5. 422 契约

```
422 { ok:false, error:{ code:'SHIFT_COMPLIANCE_CAP_EXCEEDED',
  message, granularity:'daily'|'weekly'|'monthly', capMinutes, projectedMinutes, periodStart, periodEnd } }
```
路由 catch 增一分支：`error instanceof ShiftComplianceCapExceeded → 422`（与现有 `isDatabaseSchemaError→503` / else `500` 并列，`index.cjs:29527`）。不可走 500。

---

## 6. 不回归 + 边界（lock 进文档）

- **默认不强制**：任一 `maxMinutes=null` → 该粒度跳过；全 null → 引擎完全惰性 = 当前行为。
- **org 时区 + 周起**：日/周/月边界用 **org tz**（复用打卡 workDate 的 tz 处理，勿用 server UTC）；**周一起（ISO）**，org 可配周起 = 延后。
- **开口派班**（`end_date = null`）：只投影**本次变更触及的**周期（受影响日 + 其所在周/月），**不投影 all-time**（否则月 cap 对开口派班无界）。
- **PUT 排除自身**：靠 trx-内投影自动成立（§3）。
- **rotation pattern 展开**由 resolver 负责，引擎不另写展开逻辑。
- **性能**：月窗口 prefetch 受 §"仅触及周期"约束有界；trx 内投影会延长行锁持有（已有 `acquireAttendanceScheduleAssignmentLock`），v1 规模可接受，宽窗口 perf 作 S2 验证项。

---

## 7. ⛔ 完成口径（partial-MUST bar — 防"切片充数"）

**③ 排班合规引擎仅在以下全部满足时才算 ✅：daily **且** weekly **且** monthly 三粒度，**全部** save 路径（shift/rotation/fixed-apply）均运行时 block + 每条强制点有真 DB route-level 反向 integration + 1 条 staging 联调。**

- **daily-only 的 S1 是一个切片，不是"引擎完成"。** 账本 ③ 不得在仅日 cap 时打 ✅。
- 同 #2203 的"无半成品"纪律 + 关闭过的 P2 漏洞（warning-only 充当 MUST）。`warn` 惰性预留也不得被当作"已交付 warn 模式"。

---

## 8. 实现切片（各独立 gated opt-in；CONTRACTS/默认不回归先行）

- 🔒 **S0 latent config**：`DEFAULT_SETTINGS.shiftCompliance` + `normalizeShiftComplianceSetting` + `mergeSettings` 接线 + `settingsSchema` 暴露（enforcement warn|block + 三 maxMinutes）。**latent，无强制**，node --check + unit（normalize 边界）。镜像 punch-policy S0(#2204)。
- 🔒 **S1 daily cap**：`enforceShiftComplianceCap` 共享 guard（事务内投影，仅受影响日窗口）+ 接入**全部** save 路径 + `dailyMaxMinutes` block + unit + **真 DB route-level integration**（PUT 设 cap → 保存超限 → 422 + 无行持久 → 窗内 → 200）。derisk 机制（in-txn 投影/rollback/422/全路径）于最小窗口。
- 🔒 **S2 weekly + monthly cap**：扩 guard 到周/月窗口（受影响日所在周/月，org tz，开口派班仅触及周期）+ `weeklyMaxMinutes`/`monthlyMaxMinutes` block + 全路径 + integration（含跨派班累计：他派班占周前段 + 本次占后段 → 周和超限）。**S2 合入后③才满足完成口径（§7）。**
- （`warn` 模式 = 预留，v1 不建；未来单独 slice 建 warn 通道时再激活。）

> **schema-batch 提醒**（账本 §"成组迁移"）：本引擎 config + 投影**无需 DDL**（投影读既有派班/班次行）。若未来某 slice 真要给热表 `attendance_shift_assignments`/`rule_sets` 加 `shift_constraints` 列，须与 edit-window/publish/multi-slot 的待迁 ALTER 协调一次性迁。

---

## 9. 反漂移

- 投影**只**经 `loadAttendanceComprehensivePlannedMinutesByUser` / `resolveWorkContextFromPrefetch`；**禁止**手搓第二套两表 union（漂移陷阱）。
- 任何新强制点（未来若新增 save 路径）须同样接 `enforceShiftComplianceCap`，否则即 §1 决策2 的"侧门"。
- enforcement=`block` 是 v1 唯一生效模式；`warn` 惰性必须**显式注释**（解析+存但不动作），不得静默。
- 每条强制点的反向 integration 是合入前置（非 fast-follow）—— #2209 教训：enforcement 的 helper unit test 不足，须 wire 级（settings→getSettings→workDate/period→route→422→无写）证明。
