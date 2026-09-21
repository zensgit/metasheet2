# 待办中心 B-3 打磨（H-4）— 设计 MD

**状态: PROPOSED.** 本切片是 Sonnet 实现代理（D2）产出，尚未经 Opus 门审。锁文
（`todo-center-design-lock-draft-20260915.md` v2.14 RATIFIED）为只读依据，本文档不改锁文正文。

基线: `origin/feat/todo-center-phase2-fe @ 0a6531b80e6cb362067742ee4b94477842a75965`
（含 B-1 全部提交 + B-2 全部提交 + B-2 修复轮 1-4）。
分支: `feat/todo-center-phase3-polish`（自上述 head 新建，不 rebase）。

## 0. 范围来源

驱动本切片的三项工作，均取自既有真实验收报告
`todo-center-real-browser-acceptance-20260920.md` 记录的、B-2 交付时点尚未落地或
NOT-RUN 的条目：

| 工作项 | 来源 | 报告原文摘录 |
|---|---|---|
| ① updatedAt / dueAt 呈现 | 发现 **F-5**（P3，UX，锁未要求的加项候选） | "待办中心每条只渲染标题，`updatedAt` / `dueAt` 都没用上"、"对标飞书待办，这样的列表可用性偏低" |
| ② C′「仅查看」pill 真机验收 | 发现 **F-6** | "判据 C′「仅查看」pill 在真实浏览器里 NOT-RUN"、"本报告不对这一格给结论" |
| ③ 来源不可用文案产品化 | 无既有发现直接点名；见 §1 的锁覆盖论证 | — |
| ④ vitest spec + run-required exec 块令牌纪律 | 本 prompt 直接指派的工程纪律项，非产品功能 | — |

## 1. 锁覆盖矩阵

逐项核对锁文 v2.14 的哪一条款授权了本切片要做的事；凡本表判"锁外"的，一律不做，改列入 §2。

| # | 工作项 | 锁文依据（逐字/逐条） | 判定 |
|---|---|---|---|
| ① | 每条渲染 `updatedAt`/`dueAt` | **§3**（本锁定义的接口）：`PendingItem { source; id; title; dueAt?; href; updatedAt }` —— 这两个字段是锁**已经**定义在传输契约里的，只是 B-2 的前端从未消费它们（F-5 如实指出）。渲染已有契约字段不是新增能力，是补齐既有契约的前端半边。 | **锁内 — 补齐既有字段呈现，非新契约** |
| ② | C′「仅查看」pill 真机验收 | **§5 判据 C′**（原文）："`actionable` = `resolveCanDecideCurrentNode`……UI 呈现与可办理项不同形" —— 代码与单元/端点级 mutation 早已交付（B-2 步骤，`TodoCenterView.spec.ts` 既有用例）；F-6 记录的缺口是**真实浏览器证据**，不是代码或判据。本切片不改一行 `actionable`/pill 相关代码，只补验收证据。 | **锁内 — 补验收证据，代码零改动** |
| ③ | 来源不可用文案改写（不含内部术语） | **§4**（原文）："迁移后徽标对 `unavailable`/`degraded` 必须有可判别的呈现，不得渲染成 0"；**§5 判据 B**："徽标呈现为可判别的『不可用』态"。锁**要求可判别**，**不锁定具体措辞**——已有的两版原文（徽标 `(数据不可用)`、中心页 `该来源暂时无法查询`）都是 B-2 实现者自行选定的字符串，非锁文逐字。本切片只改中心页那一句的措辞（去掉内部分组概念"来源"），可判别性契约（独立 `data-testid`、独立段落、role="status"）逐字保留，未动一处判据。**未改动徽标层的 `(数据不可用)`**——那句不在本 prompt 点名的"来源不可用"范围（它是"整体徽标"文案，不是"某一来源"文案），改它属于扩大范围，本次不动。 | **锁内实现细节的措辞调整，可判别性契约未变；徽标文案保持不变，不扩大范围** |
| ④ | vitest spec 与 run-required exec 块令牌纪律 | 不是锁文条款，是 `apps/web/scripts/run-required-web-tests.sh` 自身与 `required-web-lane-registration-shape.test.ts` 的结构性要求（"结构由……守：`bash -n` 通过；恰好一条 exec 逻辑行；token 无重复；字母序"）。 | **不适用锁文，适用仓库既有工程纪律；见 §3** |

### 1.1 不在范围（明确排除，交 owner /后续切片）

- **徽标层 `(数据不可用)` 文案** — 本 prompt 只点名"来源不可用文案"，指中心页按来源分组的那一句；徽标是"整体"文案，且 `(数据不可用)` 与仓内其它多处"XX 不可用"文案（`meta-automation-labels.ts`、`AttendanceView.vue`）共享同一措辞家族，动它是跨面文案统一决策，不属本切片。
- **dueAt 的真实数据源** — 今天唯一注册的审批源（`approval-pending-source.ts`）不产出 `dueAt`（审批实例没有"截止时间"字段）。本切片只保证**呈现路径**存在、被单测覆盖（含 mutation 与 Invalid-Date 边界），真机验收对 `dueAt` 的证据止于"该分支不渲染"（因为今天没有数据能触发它）——如实记录为**产品数据缺口**，不是本切片能力缺口，见验证 MD 的 NOT RUN 清单。
- **评论 / 云课堂 / 任务来源接入** — 锁 §4 明列"不做"，本切片同样不做。
- **`source_queue` 席位是否应该存在** — 锁 §7-2″ 已就此单列 owner 待裁项，本切片只是复用它做真机验收夹具（一次性、可逆的直接 SQL），不改变其产品定义。

## 2. 实现

### 2.1 ① updatedAt / dueAt（`apps/web/src/todo/views/TodoCenterView.vue`）

- 新增 `formatItemTimestamp(value, locale)`：镜像 `approvals/detailField.ts` 的 `formatDisplayDate`
  （`new Date(x).toLocaleString(locale)`，解析失败时原样返回而非泄露 `Invalid Date`），本文件独立实现
  而非导出复用——`formatDisplayDate` 是那个模块的私有函数、且只服务一个新调用方，复制四行比新导出一个
  共享 util 更省（同一文件已有的成本核算先例）。改为按 `isZh` 取 locale（`zh-CN`/`en-US`），因为本页
  每一处文案都已按 `isZh` 分支，`detailField.ts` 那版是单一 zh-CN 写死的。
- `updatedAtLabel`/`dueAtLabel`：包一层"更新于 {stamp}"/"截止 {stamp}"（`Updated`/`Due`）。
- 模板：两个 item 分支（`unlinkable` 与 `router-link`）各自的 `<span class="todo-center__item-title">`
  之后新增 `todo-center__item-meta`，含 `data-testid="todo-center-item-updated-at"`（恒渲染）与
  `data-testid="todo-center-item-due-at"`（`v-if="item.dueAt"`）。
- CSS：新增 `.todo-center__item-main`（flex column 包住 title+meta）与 `.todo-center__item-meta`
  （flex row，12px 次要色），零覆盖既有 `.todo-center__item-link` 布局（后者仍是最外层 flex
  space-between，pill 仍是它的直接子元素，位置不变）。

### 2.2 ② C′ pill 真机验收 — 零代码改动

`actionable`/pill 的产品代码在 B-2 已交付（`approval-pending-source.ts` 的 `resolveCanDecideCurrentNode`
调用、`TodoCenterView.vue` 的 pill 分支）且被单元/端点级 mutation 覆盖（`TodoCenterView.spec.ts`
"renders a view-only pill for actionable:false…"、锁 §5 判据 C′ 的端点级与单元级两条 mutation）。
本切片唯一动作是**构造一个真实场景**并在真实浏览器里跑一遍——见验证 MD §3。

设计要点（为何选 `source_queue` 座位，而不是别的构造法）：

- 产品路径下，一个实例在任意时刻只为**当前节点**惰性创建 `user`/`role` 座位（实测：两节点模板提交后
  `assignments` 数组只有 1 行，`node2` 无座位）——所以"活跃座位但不在当前节点"这个反例**在产品路径下
  构造不出**。
- 中心决策门 `assignmentMatchesActor`（`approval-seat-authorization.ts:71-84`）只认 `user`/`role`
  两种座位类型，`source_queue` 座位恒被拒绝（`:83` 非 user/role 一律 false）；但共享待处理查询的第三条
  臂（`approval-pending-query.ts` 的 `assignee_id = ANY($3)`，$3 = 权限数组）会把它计入待处理数。这正是
  锁 §7-2″ 定义的产品行为："`source_queue` 席位……计入 + `actionable=false` 标记"。
- 生产代码从未写入 `assignment_type='source_queue'` 的行（`grep` 全仓 `ApprovalProductService.ts` 只见
  `'user'`/`'role'` 两种插入）——这是锁自己的 A0 验收表（class ⑥）在后端真库测试里已经用的构造法，
  本切片把同一构造法搬到真机层面，而非发明新机制。

### 2.3 ③ 来源不可用文案（`apps/web/src/todo/views/TodoCenterView.vue`）

- `该来源暂时无法查询` → `暂时无法查看，请稍后重试`
- `This source could not be checked right now` → `Can't be shown right now — please try again shortly.`
- 去掉的词是"该来源"/"this source"——`PendingSourceRegistry`/"来源分组"是本系统的内部建模概念
  （§0："各域各自暴露一个……查询"），组标题（`sourceLabel()` 渲染"审批"/"Approvals"）已经把用户看得懂
  的域名摆在上面，正文没必要再重复一遍抽象分组名。
- **契约不变**：仍是独立 `<p>`、独立 `data-testid="todo-center-group-unavailable"`、`role="status"`、
  与 `todo-center-group-empty` 互斥渲染——锁 §5 判据 B 的负控（"两种响应与两种徽标态都不同形"）逐字维持。

### 2.4 ④ run-required-web-tests.sh 清理

本切片**没有新增 vitest spec 文件**（① ② ③ 的用例都补进已注册的 `TodoCenterView.spec.ts`，该文件的
`TodoCenterView` 令牌早在 B-2 落地时已加入 `run-required-web-tests.sh` 与 `approval-web-guard.yml`
两个登记点，两点纪律不需要新增）。

排查过程中发现该分支自身携带一处遗留缺陷（与本切片工作项无关，但落在"恰一逻辑块"这条要求的范围内，
顺手收口）：文件末尾有一份**死代码重复块**——`exec npx vitest run \` 之后按字母序排列的完整令牌表
（1258–1658 行）之后，紧跟着同一张表的**旧快照**（1659–2056 行，比活表少 `todoApi`/`TodoCenterView`/
`todoCountsRealtime` 三个令牌），显然是某次 rebase 冲突残留。`bash` 的 `exec` 在第一份表结束处就替换
了进程，所以第二份表**从未被任何 CI 执行到**——`required-web-lane-registration-shape.test.ts` 的"恰一
条 exec 逻辑行"检查没抓到它，因为死代码那份缺少 `exec` 前缀，不构成"第二条 exec 逻辑行"。已删除
（`diff` 逐令牌核对：除那三个令牌外完全相同，无遗漏其它内容），文件回到与 `origin/main` 一致的单块
形状。

## 3. 与既有代码的接口面

零改动文件（供门审快速核对"未越界"）：
- `packages/core-backend/src/**` 全部未动（本切片纯前端 + CI 脚本）。
- `apps/web/src/todo/api.ts`、`apps/web/src/approvals/components/ApprovalTodoBadge.vue` 未动。
- `.github/workflows/*.yml` 未动（两点纪律的第二登记点 `approval-web-guard.yml` 已含
  `TodoCenterView`/`todoApi`/`todoCountsRealtime` 三令牌 —— 校验见验证 MD §2）。

改动文件清单：
- `apps/web/src/todo/views/TodoCenterView.vue`（+79/-3，模板+脚本+样式）
- `apps/web/tests/TodoCenterView.spec.ts`（+64，新增 3 个 `it`）
- `apps/web/scripts/run-required-web-tests.sh`（净 -401 行：删除死代码块 + 加一段说明注释）
