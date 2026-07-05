# 考勤 humanization batch-1 — 开发与验证记录 — 2026-07-05

> 记录 2026-07-05 凌晨自主开发窗口（owner 事先授权 + goal 固定节奏）在考勤线落地的
> 一个完整批次：2 份 design-lock + 2 个 frontend 切片 + 1 套 staging smoke 工具 +
> bundle 5-smoke 收口。每单经独立对抗审阅（全批 0 P1/P2）+ 本地实跑 + mutation 验证
> 后合并。本 MD 是该批次的 development & verification 账页（惯例同
> `attendance-rd3-mp-ae-development-verification-20260627.md`）；tracker 仍是唯一进度真源。

## 0. 批次口径

- **来源**：考勤线深度审阅（2026-07-05，humanization 残余清单）+ owner 授权的自主执行窗口；
  goal = 以现有开发方案/TODO MD 为目标池、固定节奏、并行车道。
- **管道**：实现（Sonnet 车道，锁定范围）→ 独立对抗审阅（Opus 车道，refute-first +
  mutation）→ 三红线合并判定（0 P1/P2 · docs/tooling/display-only/默认保持 ·
  fresh-green + up-to-date）→ 不满足即留 OPEN。
- **范围红线**：全批零后端行为变更、零 schema、零 wire 字段新增；行为改动半边
  （地理位置采集、meta.outdoor 默认受理、阈值展示等）全部写入锁的 deferred 段留 owner。

## 1. 逐单账页

### 1.1 #3575 — 两份 design-lock（docs）· squash `5f3390fa1`

| 项 | 内容 |
|---|---|
| 产物 | `attendance-caliber-transparency-display-design-lock-20260705.md` + `attendance-punch-outcome-clarity-design-lock-20260705.md` |
| 姿势 | PROPOSED（delegated-execution）；范围硬锁 display-only / frontend-only / 默认保持；owner 可回溯修订 |
| 依据 | benchmark refresh v3 §3.8/§3.1 + 两次 fresh 代码审计（file:line 锚点写入锁内） |

### 1.2 #3578 — 口径透明 display-only（G1/G2/G3）· squash `f197a6d88`

| 项 | 证据 |
|---|---|
| 实现 | G1 records 表头 `:title` 复用字段目录 description（**wire 上本就有** — `resolveAttendanceRecordReportFields` 已发 description，前端仅放宽 TS 类型）；G2 TA legend 口径等式（`availableFormal = scheduled + pendingLeaveTentative`）；G3 口径说明卡（克隆 status-guide 定义列表 idiom，7 条目，不展示阈值数值） |
| 测试 | 新 spec `attendance-caliber-transparency.spec.ts` 7/7；guard 全集 199/199；`vue-tsc -b` clean；已接入 attendance-web-guard（run 列表 + 双 path-filter） |
| mutation | 删 `:title` 绑定 → 有-description 用例翻红；去 `|| undefined` → 空-description 用例翻红（Vue 对空串渲染 `title=""` 的行为被钉死） |
| 审阅 | Opus 对抗审阅 **APPROVE（0 P1/P2/P3）**，2 NIT 均可辩（G3 静态 zh 文案 = 有意为真 en 翻译保留空间；漂移场景已由 spec pin 缓解）；MD `/tmp/pr3578-review-claude-20260705.md` |

### 1.3 #3580 — 打卡结果清晰化 frontend-only（G1/G2/G3）· squash `da09a4e0e`

| 项 | 证据 |
|---|---|
| 实现 | 纯分类器独立模块 `punchOutcome.ts`（`classifyPunchSuccessOutcome`/`classifyPunchErrorOutcome`/`buildPunchRetryWithNotePayload`，enum-strict：未知码返 null 走原通用路径）；G1 202 `pendingApproval` 分支不再误标"已打卡"，best-effort `loadRequests()` 刷新；G2 `OUTDOOR_NOTE_REQUIRED` 就地补备注一键重试（字段名 **`meta.note` 从路由源码实读** index.cjs ~L24202-24211，非猜测）；G3 `LOCATION_RESTRICTED` 死胡同口径化文案、无必败重试按钮 |
| 边界证明 | 不采集地理位置 / 不注入 `meta.outdoor` —— 由 exact-body 测试断言（`not.toHaveProperty`）锁定，非仅代码审读 |
| 测试 | 新 spec 17 用例；guard 全集 195/195；`vue-tsc -b` clean；pre-existing `attendance-record-timeline` 4 失败经 clean origin/main 对照证实与本单无关 |
| mutation | 砍 pendingApproval 分支 → 恰 3 红；错误码判等 always-true → 7 红（enum-strict 负例承重） |
| 审阅 | Opus 对抗审阅 **APPROVE（0 P1/P2）**，3 覆盖 NIT → 已开 test-only follow-up 车道（见 §3）；MD `/tmp/pr3580-review-claude-20260705.md` |

### 1.4 #3579 — HMR-5 staging smoke set · squash `8fc3307de`

| 项 | 证据 |
|---|---|
| 产物 | `scripts/ops/staging-attendance-manual-missed-punch-reminder-hmr5-smoke.mjs` + 同名 contract tests + bundle §1 第 5 行/§2 代码门 + runbook helper 小节 + tracker §0.6 备注（保持 🟡） |
| 实跑 | contract tests 14/14（node --test）；MP-6 sibling 回归 10/10 |
| 关键发现 | runbook prose 的 `source_key` 形状与 shipped route 漂移——route 追加 `:channel:<channel>` 后缀（index.cjs ~L24994）；helper 按真实形状断言，审阅 P3 → runbook prose 同步修正（`b9e3f042`） |
| 审阅 | Opus 对抗审阅 **APPROVE-with-nits（0 P1/P2）**：5 个 mutation 全红（含故意漂移真实路由证明 contract tests 是接地雷线）；每条 40x 码/顺序声明（replay/conflict-before-stale/scope）逐一对源码复证；MD `/tmp/pr3579-review-claude-20260705.md` |

### 1.5 #3587 — bundle 5-smoke operator-ready 收口 · squash `5c34b2db7`

| 项 | 证据 |
|---|---|
| 触发 | owner 复审 P2：#3579 只按 brief 动了 §1/§2，计划主干仍是 three-smoke 框架（§4 顺序/§7 总扫尾/§8 闭环清单未覆盖 HMR-5） |
| 实现 | 18 处编辑：标题/intro 计数；§4 补 MP-6 第 4 步（GLOBAL `makeupPunchPolicy` 单租户姿势 + restore-verified）与 HMR-5 第 5 步（共享 C5 worker 收尾理由）；§5 stamp 行/settings 归属/三写者口径（真实 `…:recipient:<user>:channel:<channel>` key 形状）；§7 HMR-5 residue 块**逐条镜像 shipped helper 的 `residueCounts()`/`cleanup()` 家族** + owner nit 补 `hmr5_user_roles` 前缀计数（总扫尾自包含）；§8 HMR-5 条件闭环项；§9.5 token 口径 |
| 验证 | 旧口径（"three smokes"/"all three" 类）grep 清零；owner 现场核对 head `f8384eb7c` 后 **APPROVE** |

### 1.6 跨线关联（非考勤，仅索引）

- #3568 C-R2 planner seam 加固（integration 线）· squash `cfd3dcd06` —— 同窗口落地，账页归 integration 线。

## 2. 批次级验证与纠偏

- **三红线全批执行**：每单 0 P1/P2 后合并；共享文件（AttendanceView.vue + attendance-web-guard.yml）冲突按"先落先合、后者 update-branch 解并集"处理——#3580 的 yml 并集在合并前以**合体 guard 全集 202/202 + vue-tsc clean** 复验（195+7 并集）。
- **stale-memory 纠偏**（#2177 类）：深度审阅曾把 "report-records → multitable sync" 列为待建设计锁；fresh 审计证实该线 2026-05-15..19 已建成（对象+双指纹写入器+分页 job 控制面+路由），改出 **#3577 hardening 决策菜单**（PROPOSED，OPEN 等 owner A/B/C 选档：触发模型/孤儿值列/重复 row_key）。深度审阅稿已加 PRE-#3579 SNAPSHOT 标注。
- **CI 盲区口径**：`scripts/ops` contract tests 不在任何 workflow 中运行——本地实跑是唯一闸门（本批 #3579 的 14/14 + sibling 10/10 均为本地证据；审阅侧独立复跑）。
- **过程缺陷与修复**：早期 landing 循环缺 fetch 兜底（PR head 未入本地 → rev-list 失败 → `behind(999)` → 无谓 update-branch 空转）——发现后修正并重启，后续四单均按修正版落地。

## 3. 遗留与后续（各自独立 gate）

| 项 | 状态 | gate |
|---|---|---|
| staging 窗口本体（5-smoke） | 文档已 operator-ready（#3587 后） | operator-run；跑完回填 stamps → 关 #3317 |
| #3577 report-sync 决策菜单 | OPEN | owner A/B/C 选档后 refresh + 落档合并 |
| #3580 G2 状态机覆盖（3 用例） | test-only follow-up 车道进行中 | 同管道（sonnet → opus → 三红线） |
| humanization 剩余（§3.5 备份+不可逆提示 / 排班手势 / half-day helper） | 未开工 | §3.5 涉行为变更 → design-lock 先行 + owner ratify |
| smoke 自动化 workflow_dispatch | 未开工 | 可先出 draft（dispatch 权在 owner） |
| 深水项（多午夜/多段夜班）/ v1-7 payout / OUT 红线 | 冻结 | 按 tracker/池内文档自身 gate |
