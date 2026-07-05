# 考勤批量排班（bulk-apply）design-lock — 2026-07-05

> **Status: PROPOSED — 等 owner ratify + 两个决策（D1/D2）后才可实现**（本刀比其它
> humanization 微切片大：涉及新交互面 + N-写编排，非 display-only，不适用 delegated-execution）。
> 依据：humanization backlog §4.5「复制/粘贴排班、划线排班」+ 2026-07-05 现状审计（§1 锚点）。

## 1. 审计结论（改变了这刀的形状）

backlog 把它想成"路由已能写、只差 UI 手势"——审计证伪了一半：

| 事实 | 锚点 | 影响 |
|---|---|---|
| **今天无可编辑 user×date 网格**——排班 UI 是逐条表单（User+Shift+起止日期+Create） | `AttendanceSchedulingAdminSection.vue:585-645` → `POST /api/attendance/assignments`（`index.cjs:39191`） | "划线涂抹"要**新建**可编辑网格，非小 affordance |
| **拖选/range-paint 手势零先例** | grep `mousedown/mouseover/shift-click/selectedCells/draggable` = 空 | 涂抹是净新 UX，风险高 |
| 唯一 user×date 矩阵是**只读**的可用性矩阵 | `AttendanceTeamAvailabilitySection.vue:63-75` | 不能直接复用为编辑面 |
| **无 bulk 建 assignment 端点**——只有单条 POST + 批量 publish（不建） | `index.cjs:39191/38811`；publish batch `39721`（只翻状态） | 批量粘贴 = N 次单条 POST |
| **每条 POST 内已跑全部守卫**（edit-window/scheduler-scope/conflict/compliance-cap/slot） | `index.cjs:39191-39300`（`enforceShiftEditWindow`/`assertAttendanceScheduleAssignmentDispatchAllowed`/`findAttendanceScheduleAssignmentConflict`/`enforceShiftComplianceCap`） | N-写复用单条路由=**守卫无法被绕过**，零后端改动 |
| **已验证的多选先例 = batch anomaly**（checkbox-list + 顺序 N 写 + 部分失败） | `batchAnomalyResolution.ts`（MAX=50/顺序/skip-ok/`completed_with_errors`）+ `AttendanceView.vue:9158` 模态 | 直接克隆，低风险 |

## 2. 范围决策（owner 拍板 D1/D2）

### D1：选择模型（MVP 交互面）
| 选项 | 内容 | 代价/风险 |
|---|---|---|
| **D1-A（推荐）checkbox-list 批量套用** | 在既有排班表单旁加"批量套用"：勾选多个目标（user×date 行，或 user + 日期范围展开成行）→ 选一个 shift → 套用。**克隆 batch anomaly** 的多选+顺序 N 写+部分失败模态 | 低——复用成熟 idiom，无新网格/无拖拽 |
| D1-B（defer）drag range-paint 网格 | 新建可编辑 user×date 网格 + 拖选 + copy 一格 shift → paste 到选区 | 高——净新网格 + 净新拖拽手势，是独立大建设 |

### D2：写入目标状态
| 选项 | 内容 | 语义 |
|---|---|---|
| **D2-A（推荐）draft-then-publish** | 批量写 `POST /api/attendance/schedule-drafts/assignments`（`publish_status='draft'`）→ 操作员复核 → 既有 publish batch 生效 | 更安全：批量误操作停在草稿，不即时上线；对齐"发布/草稿"能力 |
| D2-B 即时上线 | 批量写 `POST /api/attendance/assignments`（COALESCE 默认 `published`） | 更快但批量误写即时生效 |

> 我的建议：**D1-A + D2-A**（低风险 checkbox-list + 草稿态），把 drag-grid（D1-B）留作独立 owner-gated 大建设。下面 §3-§5 按 D1-A/D2-A 写；若 owner 选 D1-B/D2-B，§3 相应重写。

## 3. 范围（按 D1-A/D2-A；frontend-only + 复用既有端点）

| # | 改动 | 口径 |
|---|---|---|
| G1 | **批量套用面板**：`AttendanceSchedulingAdminSection.vue` 加多选（勾选 user×date 目标，或 user 多选 × 日期范围 → 展开成 (user,date) 单元集）+ shift 选择 + "批量套用（草稿）"按钮 | 克隆 batch-anomaly checkbox-list；`MAX_CELLS` 上限（≈50，防爆炸半径） |
| G2 | **确认+进度模态**：套用前弹确认（目标数/shift/日期范围 + 通用提示"逐条写入草稿，任一冲突/超限/越权将逐格标错，其余继续"）→ 顺序 N 写 `schedule-drafts/assignments`，**每格独立 `idempotencyKey`**，per-格结果 chip，`completed_with_errors` 部分失败横幅 | 镜像 `runBatchAnomalyResolution` + `summarizeBatchAnomalyOutcome`——**绝不在部分失败时报全成功** |
| G3 | **per-格错误面**：409 conflict / 422 compliance-cap / edit-window / 403 scope 逐格显示各自 coarse 文案（复用既有 responder 的 code），失败格可"重试失败项"（skip 已 ok 格） | enum-strict：未识别 code 落通用失败文案 |

**抽纯模块** `apps/web/src/views/attendance/scheduleBulkApply.ts`（`expandTargets(users,dateRange)→cells` / `canRunBulkApply(count)` / `runBulkApply(cells, submitOne, onProgress)` / `summarizeBulkApplyOutcome`——直接仿 `batchAnomalyResolution.ts`）。

## 4. 硬边界

- **零后端改动**：复用 `POST /schedule-drafts/assignments`（守卫在路由内，N 写不绕过 conflict/cap/window/scope）；不新建 bulk 端点（原子性/大 N 性能 → §6 defer）。
- 顺序写（非并发）——与 batch anomaly 一致，避免同用户锁争用/冲突误判。
- `MAX_CELLS` 硬上限；超过要求缩小选区（不静默截断）。
- 草稿态（D2-A）——批量结果需经既有 publish 流程才生效，本刀不碰 publish。
- zh/en `tr()`；`data-*` testid；复用 batch-anomaly 的模态视觉/选择 idiom。

## 5. 完成口径

- 纯模块 + web 测试：`expandTargets`/cap/`runBulkApply` 顺序与 skip-ok、部分失败 `completed_with_errors`、per-格 409/422/403 错误落位、N 次 `schedule-drafts` POST 的精确 body（草稿态 + 独立 idempotencyKey）、超上限拦截；**mutation 自检**：砍顺序循环的 skip-ok → 重试用例翻红。
- 新 spec 接入 `attendance-web-guard`（run 列表 + 双 path-filter）。
- Opus 对抗审阅 0 P1/P2 后合并；frontend-only 不设 staging 门。
- **泳道**：这是 `AttendanceView.vue`/`AttendanceSchedulingAdminSection.vue` + web-guard 的 FE 实现 → **泳道 A 串行**（排在 half-day runtime 之后，避免并集冲突）。

## 6. Deferred（各自独立 gate）

- **D1-B drag range-paint 可编辑网格**：净新交互面，独立大 arc（owner 决策）；
- **bulk 建 assignment 后端端点**：仅当需原子性 all-or-nothing 或大 N 性能时（后端改动）；
- 即时上线态（D2-B）若 owner 要；rotation/fixed-schedule 的批量套用（本刀只 direct shift assignment）；
- 复制"一格已有 shift"作为来源 buffer（D1-B 的一部分）。
