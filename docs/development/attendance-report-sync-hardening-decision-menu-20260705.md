# 考勤报表同步（attendance_report_records）hardening 决策菜单 — 2026-07-05

> **Status: PROPOSED（decision menu，不含实现授权）**。2026-07-05 深度审阅曾把
> "report-records → multitable sync" 列为下一个战略设计锁候选；随后的 fresh
> `origin/main` 审计证实**该同步线早已建成并合入**（2026-05-15..19 的完整 PR 链），
> 旧的"待开发"框架作废。本文档做两件事：① 钉死"已建成"的现状对账（防止未来再把它
> 当 greenfield 重规划——#2177 类陷阱）；② 把审计发现的**三个真实残余缺口**整理成
> owner 决策菜单。每个选项都是独立 gated opt-in，本文不授权任何实现。

## 1. 现状对账（已建成，勿重开）

| 层 | 现状 | 锚点 |
|---|---|---|
| 报表对象 | `attendance_report_records`（row_key/org/user/work_date + 双指纹 + synced_at 骨架 + catalog 驱动的动态值列）+ 孪生 `attendance_report_period_summaries` | `plugins/plugin-attendance/index.cjs` ~L2252-2411（描述符），~L2553（值列） |
| 写入器 | `syncAttendanceReportRecords`：queryRecords-by-row_key → `source_fingerprint`+`field_fingerprint` 双指纹比对 → skip / create / patch；只经 `context.api.multitable`，绝不裸写 `meta_*` | ~L2718-2870 |
| 幂等键 | `row_key = orgId:userId:workDate`（~L2577）；指纹含加班三段输入（~L4578） | — |
| 控制面 | `plugin_attendance_report_sync_jobs`（分页 `manual_step` run-next-page、`(org_id, idempotency_key)` 部分唯一）+ 路由 `/api/attendance/report-sync-jobs*`、直连 `/report-records/sync`、`/report-period-summaries/sync`；发 `attendance.report_records.synced` 事件 | 迁移 `zzzz20260519070000_*`；路由 ~L40694-40943 |
| 边界 | attendance_* 唯一事实源；对象注释原文即锁："本对象只存可重建报表快照, 经 multitable 插件 API, 不裸写 meta_*" | ~L2250-2251 |
| 关系澄清 | RD 报表订阅 digest 是**正交**通知路径（只写 C5 outbox，无快照表），不是本线先例 | RD design-lock 20260626 |

## 2. 三个真实残余缺口 → 决策菜单

### 缺口 A：触发模型（最大的一个）
现状：同步只有 operator/HTTP 触发 + 分页手动 job；`mode:'enqueue'` 的 job 路径**在 main
上没有 worker**。报表对象的新鲜度完全依赖人工/外部调用。

| 选项 | 内容 | 代价/风险 |
|---|---|---|
| A1 保持现状 | 报表快照 = 按需/操作型产物；文档口径写明"非实时" | 零代码；用户看到旧数据的解释成本 |
| A2 调度批量 | 挂 `AttendanceScheduler` 第 N 个 job（既有 leader-elected/env-gated 基座），如每日/每小时批量 sync 活跃 org | 复用成熟基座；tick 成本与批量边界要定；与 digest producer 的 tick 关系要定 |
| A3 push-on-recompute | record-compute 后事件驱动 enqueue（先补 enqueue worker） | 最新鲜；但把写放大引入热核路径，需要防抖/合批设计，属重刀 |

**倾向（供参考，不预设）**：A2 是"成熟基座 + 可控爆炸半径"的中点；A3 建议等真实客户
对新鲜度的具体诉求再开。

### 缺口 B：孤儿值列
catalog 删除字段码后，报表对象上的对应值列残留（代码内已承认的 P2，~L2549）。
选项：B1 记录为已知限制（现状）；B2 sync 时检测并 null 化/标记孤儿列；B3 提供
operator 清理动作（复用 job 控制面）。B2/B3 均小刀，但涉及"删列 vs 置空"的数据
保留口径，需 owner 定。

### 缺口 C：重复 row_key 行
写入器对 duplicate row_key **计数但不去重**（~L2830）。选项：C1 保持计数+告警可见
（现状）；C2 sync 时收敛（保留最新指纹行，软删其余）——需要先回答"重复行从哪来"
（并发首写？历史遗留？），建议先加一个只读诊断（哪些 org 有 dup、量级）再定。

## 3. 与其它线的关系

- **不阻塞** staging 窗口 / humanization 切片 / #3317 收口。
- 若选 A2：与 RD digest（同为 scheduler 消费者）共享"谁拥有 tick"的答案，宜同一
  design-lock 说清楚。
- 报表"反超"叙事（考勤事实进多维表自由分析）**的地基已在**——本菜单只是把地基的
  运维成熟度补齐，不是新地基。

## 4. 处置

owner 从 A/B/C 各选一档（或全部现状保持）后，另起正式 design-lock 再实现；本文档
不授权任何 runtime 改动。
