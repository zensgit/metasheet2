# R13-C — Retention↔Reset 保留窗口内共存 + 大规模恢复异步化 — DESIGN LOCK (PROPOSED)

- **Status**: **PROPOSED — 2026-07-13. NOT ratified. Design-first, ZERO code/flag.** Per owner R13 ruling「**C 先做设计锁和真实数据量基准，避免直接改高风险恢复事务**」。此锁只定义语义、给出 OD 决策与基准方法学；**不改任何恢复事务**。owner ratify §5 (OD-C1…OD-C4) + 真实基准跑完，才进实现。
- **Provenance**: primary-source @ `origin/main`；每处 file:line 已读非推。R13/R14 线的 C 车道（[[multitable-timemachine-r13-r14-revision-completeness-and-parity-design-verification-20260713]] §4）。**依赖 R13-A**：保留窗口内「可恢复」的前提是 revision 链完整（否则窗口内的 T 本身在 8 条未捕获路径上就是错的——见 R13-A #4187）。

## §0 两个问题（owner R13-C）

1. **retention 与 Reset 现为互斥**。`univer-meta.ts:10276` `PIT_RESET_RETENTION_BLOCKED = () => MULTITABLE_META_REVISION_RETENTION_ENABLED === '1'` ⇒ retention 一开，**所有** reset-preview/execute 返回 **409 `RESET_RETENTION_CONFLICT`**（`:10277`）。这是 PIT_RESET STOP-SHIP 的保守实现：retention 会老化 revisions，reset 依赖 revisions 重建，故一刀切禁掉。**代价**：生产上一旦开 retention（规模化必需），PIT Reset 完全不可用。**目标**：在**保留窗口内**让两者共存——只要目标 T 的重建输入仍被保留，reset/restore 就该允许。
2. **超过 5000 条的恢复 fail-closed 拒绝**。`SHEET_REVERT_MAX_RECORDS`（默认 5000，`restore-caps.ts:15`）⇒ 记录数超限的 revert/reset **422 拒绝**（`univer-meta.ts:9930/9933/9980`；退型 revert 同类 `:6390`）。**目标**：超限转**异步任务**，提供 progress / 失败 / 取消语义。

## §1 问题 1 设计：保留窗口内共存

### 1.1 安全不变量（红线，不可协商）
**绝不 reset/restore 到一个「重建输入已被 retention 剪除」的 T。** 那会产出**不完整/错误**的重建（reconstructRecordsAtT 缺少 ≤T 的必要 revision）⇒ 把当前记录改写成一个从未存在过的半状态 = **数据销毁**。当前的一刀切 409 之所以存在正是为守这条；共存设计**必须以逐 T 判定替换一刀切，而非放松红线**。

### 1.2 「保留窗口内」的精确语义 —— 因 policy 而异（关键难点）
retention 两种 policy（`meta-revision-retention.ts:30`），窗口语义**不同**：
- **`keep-days`（时间窗）**：保留 `now - DAYS`（默认 365，floor 30）之后的 revisions。窗口 = `[now - DAYS, now]`。**判定可行且干净**：`T ≥ now - DAYS` ⇒ 该 T 的 revisions 未被时间剪除 ⇒ 允许。**但仍需逐记录校验**：每条记录在 ≤T 必须有一条**存活的** revision（floor 保底：keep-days 也可能因 keep-n floor 交互而更早剪）。
- **`keep-last-n`（版本数窗）**：**per-record 保留最近 N 版**（默认 200，floor 10）——**不是时间窗**。一条高频编辑的记录，其第 3 版可能几分钟前就被剪；一条冷记录的第 3 版可能一年后仍在。**故「保留窗口」在 keep-last-n 下不是一个全表统一的 T**，而是**逐记录**的。一个跨记录一致的 reset-to-T 在 keep-last-n 下，可能对记录甲的 T 可重建、对记录乙的 T 已剪。

### 1.3 设计（逐 T、逐记录 completeness gate）
把「retention 开 ⇒ 禁 reset」换成「**reset-to-T 前，验证 T 对本次 scope 内每条记录都可完整重建**」：
- **preview 阶段新增 `reconstructabilityCheck(sheetId, T, scopeRecordIds)`**：对 scope 内每条记录，确认在 ≤T 存在其重建所需的 revision 链（至少最近一条 ≤T 的非空快照；delete 记录另按 delete-revision 判存亡）。
- **任一记录 T 不可重建 ⇒ preview 报 `RESET_T_BEYOND_RETENTION`（新 code），列出受影响记录数**（不列 id，避免 count-oracle，沿用 G5 教训 [[finding_multitable_permission_bypass_20260708]]）。**execute 前再校验一次**（TOCTOU：retention janitor 可能在 preview→execute 间又剪了；[[feedback_toctou_needs_constructed_race]]）。
- **与 anchor/floor 交互**：4c-2/4c-3 的 tombstone retention floor（`meta-revision-retention.ts:223`）保护活 trash 行锚定的 tombstone 组；本 gate 只判 record-revision 可重建性，**不放松 floor**，两者叠加（都满足才允许）。
- **retention flag 不再无条件 block**：`PIT_RESET_RETENTION_BLOCKED` 从「retention 开即 409」改为「T 超出可重建范围才 409」——**但这是 OD-C1，owner 裁**（保守派可能仍要求 retention 开时 reset 需额外 flag）。

## §2 问题 2 设计：大规模恢复异步化（>5000）

### 2.1 复用既有异步 job 基座（不新造）
`multitable_ai_bulk_job`（`zzzz20260622120000`）+ `automation-job-service.ts` + `workflow-job-contract.ts` 已提供 **status（queued/running/suspended/…）/ total / progress 计数 / cancel / resumable-crash-safe** 的成熟范式。**大规模 revert/reset 异步 job 应镜像它**，不另起炉灶。

### 2.2 设计
- `SHEET_REVERT_MAX_RECORDS` 超限时，**不再 422 拒绝**，而是**入队一个 `multitable_recovery_job`**（镜像 ai-bulk-job 表：status/total/processed/failed/error/created_at/cancel 标志），返回 **202 + jobId**。
- **进度**：`GET /recovery-jobs/:jobId` 返回 total/processed/failed/status。**取消**：`POST /recovery-jobs/:jobId/cancel` 置 cancel 标志，worker 在批边界检查并优雅停（已处理的批已提交、可恢复；未处理的不动）——**恢复是幂等的分批**，取消 = 停在一致点，非回滚。**失败**：单批失败记 error，job 转 `failed`，已提交批保留（同 restore 的分批幂等语义）。
- **分批事务边界**：**每批一个事务**（N 条/批，N=SHEET_REVERT_MAX_RECORDS 或更小），批间可中断。**不是一个巨事务**——巨事务持锁过久、超时即全丢。这是与 §1「不改高风险恢复事务」的张力点：异步分批**改变了原子性粒度**（从「整 sheet 一个事务」到「每批一个事务」），**故必须 owner 单独裁（OD-C3）**：整表 reset 的原子性是否可降为「分批 + 一致中断点」？飞书「一键恢复」是否要求全或无？

## §3 真实数据量基准（owner「真实数据量基准」，方法学 + 首测）

**方法学**（进实现前必须真跑，先在 staging-scale 数据上）：
| 维度 | 种子 | 测量 |
|---|---|---|
| 记录规模 | 1k / 10k / 50k / 100k 条 × 每条 5/20/50 版 revision | reconstructRecordsAtT(T) 墙钟；reset preview 墙钟；reset execute 事务时长 + **锁持有时长**（`meta_records` 行锁 + `pg_stat_activity`） |
| retention 窗判定 | 上述 × retention on（keep-days / keep-last-n） | §1.3 reconstructabilityCheck 的额外开销 |
| 异步阈值验证 | 扫 5000 附近 | 同步 reset 在何规模下事务时长/锁时长越过可接受阈值（定 async 触发点是否 5000 合理，还是应更低/更高） |

**阈值（建议，owner 定 OD-C4）**：单次同步恢复事务**锁持有 > ~2s** 或**墙钟 > ~10s** 即应异步——`SHEET_REVERT_MAX_RECORDS=5000` 是否落在该阈值内需**实测校准**，不拍脑袋。

**基准运行状态**：本锁只交付**方法学 + 阈值口径**（design-first）；**真实基准跑是 ratify 前的独立前置**，需 staging 真数据 + 真硬件（scratch DB 上的 indicative 数字对锁/墙钟阈值不具代表性，故不在此充数）。owner 红线「先做真实数据量基准」即指此——**基准未跑 ⇒ 不进实现**。

## §4 出界（本锁不做）
- **不改任何恢复事务**（owner 明令）。§1/§2 是设计，实现待 ratify + 基准。
- 不改 retention janitor 本身。
- base-wide 原子恢复（R14 方案 A）是另一条线，本锁只处理「保留窗口共存 + 单 sheet 异步化」。

## §5 OD 决策（owner ratify）
| OD | 决策点 | 建议 |
|---|---|---|
| **OD-C1** | retention 开时 reset 的门：一刀切 409 → **逐 T reconstructability gate**（§1.3），还是保留一层显式 flag（retention 开 + reset 需第二 flag）？ | 逐 T gate（红线由不变量守，非由一刀切守）；但 owner 可要求过渡期加 flag |
| **OD-C2** | keep-last-n 下「保留窗口」是 per-record 的（§1.2）——跨记录一致的 reset-to-T 若对部分记录 T 已剪，是 (a) 整体拒绝 (b) 部分恢复+报告 (c) 只支持 keep-days 下的窗内 reset？ | **(a) 整体拒绝**（保守，避免部分状态）；keep-days 是窗内 reset 的一等场景 |
| **OD-C3** | 异步分批把整表 reset 的原子性从「全或无」降为「分批+一致中断点」（§2.2）。可接受？飞书一键恢复要全或无吗？ | 分批+一致中断点（大规模全或无不现实）；但**与 R14 base-wide 原子恢复决策耦合**——若 R14 选方案 A 要真原子，异步语义要重议 |
| **OD-C4** | async 触发阈值 = 5000 条固定，还是按 §3 实测的锁/墙钟阈值校准？ | 按实测校准（5000 是占位，非实证） |

## §6 验证义务（实现阶段，mutation-proven goldens，对齐「最终验收」#3）
- **保留窗口 gate**：retention on + T 在窗内 ⇒ reset 成功；T 超窗 ⇒ `RESET_T_BEYOND_RETENTION`（preview + execute 双点，TOCTOU race golden：preview 后 janitor 剪 → execute 拒）；红线 golden：**绝不**对不可重建 T 执行（突变 gate → 数据销毁可复现）。
- **异步 job**：进度/取消/失败/crash-resume 各 golden（镜像 ai-bulk-job 测）；分批一致中断点 golden（取消后已提交批完好、未处理批不动）；幂等重跑 golden。
- **基准**：§3 真跑归档（staging-scale），阈值校准证据。

**收官口径**：本锁 design-only；**retention 窗共存 + 异步化在 owner ratify OD-C1..C4 + 真实基准跑完前不进实现**（owner 红线：不直接改高风险恢复事务）。
