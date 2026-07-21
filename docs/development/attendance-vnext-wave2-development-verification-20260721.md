# 考勤 vNext UX 线 Wave 2 — 开发与验证记录（2026-07-21）

> Charter: `attendance-vnext-dingtalk-benchmark-ux-development-charter-20260720.md`（§14 步骤 4-5、§15 Wave 2 行）。
> Design lock: `attendance-employee-overview-task-first-design-lock-20260716.md`（**RATIFIED** owner 2026-07-21，#4370 = `d430601e6`，OD-O1..O4 全按推荐值）。
> 本文按 lock §11 完成定义交账；证据 = 本地真跑 + 真栈真浏览器 + CI，合成 fixture，无客户数据。
> 模型分工：实现=Sonnet 车道、对抗审=Opus 车道、三视口证据与编排=Fable 主循环。

## 1. 已交付

**PR #4501（squash `8112810cd`）**：issue #4355 员工总览 task-first 重构 + `AttendanceEmployeeWorkspace.vue` 首次抽取。6 文件 +1776/-509（回填 +37/-1）：
- `attendanceOverviewPriority.ts`（新纯模块，OD-O1 first-match 优先级推导，19 腿 spec）
- `AttendanceEmployeeWorkspace.vue`（新组件：Today/attention/tools 布局，纯 `defineProps`/`defineEmits`，零 apiFetch/router/store——§6.2 边界经对抗审核实）
- `AttendanceView.vue` overview 区重接线（-690/+530；API、route sync、punch/request handler 全留父层）
- dashboard spec 40→46 腿；attendance-web-guard run-list + 双 path-filter 接线（§8.1.4）

**锁条文落地对照**：OD-O1 = §4.2 first-match（punch_failure > anomaly > pending > …，attention 带单一主操作）；OD-O2 = 历史筛选 `<details>` 默认折叠、展开不重置不重发（reports 模式不变）；OD-O3 = requests→actions→annual-balance→rules(弱化不删)；OD-O4 = 直接 rollout、无 flag、无并行旧模板。锁 §1 five state derivations（activeWorkbenchRecord 等）复用非重造（对抗审 grep 核实无平行推导）。

## 2. 门禁（章程 §8.1 对照）

| 项 | 结果 |
|---|---|
| 纯模块/挂载 spec | priority 19/19；dashboard 46/46（含审后回填两腿）|
| guard current-head | 27 文件 run-list 原命令 **546/546**（新 spec 被点名收集）|
| §8.1.4 | run-list 显式 pattern + pull_request/push 双 filter（对抗审实证）|
| vue-tsc / build | 双净 |
| 承重 mutation | **6 刀全被杀**：实现方 3（precedence 交换 / unknown_status 折叠 / OD-O3 卡序交换）+ 审阅方 2（absent 精度 / details open 默认态）+ 回填 1（M3 statusSource 放宽——审阅中逃生，回填负向腿后恰好该腿红）|
| selector/deep-link/API 兼容 | 对抗审核实；唯一裁撤 `data-selfservice-action="recommended"` 系 §4.2 合并竞争性主操作的授权删除，全仓零引用（7→6 已披露）|

## 3. 对抗审（Opus，refute-first）

**APPROVE，0 P1 / 0 P2**（MD /tmp/pr4501-w2-review-claude-20260721.md）。两个实现级判断均裁决正确：statusSource 把「actionable punch failure」限定在 punch 自身三个 catch 分支（其余 setStatus 位点 source=null，逐点核实）；「最近被拒申请」沿既有排序语义成立。越界审查：AttendanceView 改动仅 overview/共享状态/punch 域，管理面/组工作台/审批面不碰。P3-a（statusSource 负向测试缺失）与两 NIT 均已在合入 head 回填/披露（见 §2 mutation 行与 PR 门禁 comment 5029163136）。

## 4. 三视口真浏览器证据（真栈 + 种子数据；全部拍前真在场断言 + 人工目检）

截图 4 张入 `assets/w2-vnext-20260721/`（01 总览 1440 · 02 OD-O2 展开 1440 · 03 总览 1024 · 04 总览 390）：
- **1440**：Today 带（时钟+双打卡钮+我的状态）→ attention 带（种子 pending 请求驱动 first-match=`request_pending`）→ OD-O3 卡序（DOM 事实与断言一致）；OD-O2 折叠行不入首屏 + 展开态实拍（筛选/汇总/日历/补卡/异常随披露展开）。
- **1024**：布局收敛正常，main 收边。
- **390**：单列、页级 scrollWidth=390=viewport；顶部时钟 + 全宽双打卡钮完整（首拍截屏竞态，带稳定等待重拍并目检）。
- 三档考勤 `<main>` 内容区全部收边；桌面页级 64px 溢出仍为壳层 dev 导航旧账（Wave 1 MD 已记，范围外）。

## 5. 已知项（honest，不阻断）

1. 合成用户无 org membership 时「我的考勤规则」卡透传英文 API 错误串——环境产物 + 既有错误展示行为（非本波引入）；真实租户不触发；候选后续 i18n 化。
2. focused/desktopOnly、壳层导航溢出等 Wave 1 已知项状态不变。
3. `AttendanceView.vue` 本波净变 -160 行（首个减债波）；下一抽取点按章程 §6.2 顺延。

## 6. 剩余（口径）

- **Wave 3**（issue #4353 / #4414 re-port）：§14 步骤 5——Wave 2 已合，即可 reclaim #4414 业务意图（禁直接合旧 stacked head）。
- **Wave 4 onboarding / Wave 5 explainability**：DESIGN-LOCK-GATED / DATA-CONTRACT-GATED（owner 门）。
- lock §11 其余完成项（真实租户视觉复核等 operator 项）不由本文替代。
