# 待办中心 B-3 打磨（H-4）— 设计 MD

**状态: PROPOSED.** 本切片是 Sonnet 实现代理（D2）产出；已过 Opus 门审一轮
（`impl-gate-B3-todo-polish-round1-20260922.md`，VERDICT APPROVE-with-hardening，0 P1/2 P2/7 P3/2 NIT）
并由 Sonnet 修复代理（D1 rebase + D2 record fix）按该门审逐条处理，仍未经门审复核，门审前一律按候选
对待。锁文（`todo-center-design-lock-draft-20260915.md` v2.14 RATIFIED）为只读依据，本文档不改锁文正文。

基线（原始）: `origin/feat/todo-center-phase2-fe @ 0a6531b80e6cb362067742ee4b94477842a75965`
（含 B-1 全部提交 + B-2 全部提交 + B-2 修复轮 1-4）。
分支: `feat/todo-center-phase3-polish`（自上述 head 新建）。

**2026-09-22 rebase**：B-2 自己的修复轮把 `run-required-web-tests.sh` 末尾同一处死代码块
（本切片 §2.4 原描述的那处）独立删掉了（`16703f8cfd7a11ac90da8568bc4a1a7846d6dd05`，
"fix(ci): drop the dead token block left after the required-web exec line"），本分支据此
`git rebase --onto 16703f8cf… 0a6531b80…` 到新 B-2 head 之上——见 §4 记录全部核对命令与输出。

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
| ① | 每条渲染 `updatedAt`/`dueAt` | **§3**（本锁定义的接口）：`PendingItem { source; id; title; dueAt?; href; updatedAt }` —— 这两个字段是锁**已经**定义在传输契约里的，只是 B-2 的前端从未消费它们（F-5 如实指出）。渲染已有契约字段不是新增能力。但锁 §4 的前端范围只逐字写"待办中心页（按来源分组、点击 `href` 导航）+ 顶部徽标改读 `todo/count`"，**未要求也未禁止**渲染这两个字段——呈现细节本身锁不裁。 | **门审自纠正（初稿"锁内"是过强声明，见下）**：非新契约（锁 §3 已定义字段）；呈现细节属 owner UX 裁决项，与 ③ 同口径——见 §1.1 |
| ② | C′「仅查看」pill 真机验收 | **§5 判据 C′**（原文）："`actionable` = `resolveCanDecideCurrentNode`……UI 呈现与可办理项不同形" —— 代码与单元/端点级 mutation 早已交付（B-2 步骤，`TodoCenterView.spec.ts` 既有用例）；F-6 记录的缺口是**真实浏览器证据**，不是代码或判据。本切片不改一行 `actionable`/pill 相关代码，只补验收证据。 | **锁内 — 补验收证据，代码零改动** |
| ③ | 来源不可用文案改写（不含内部术语） | **§4**（原文）："迁移后徽标对 `unavailable`/`degraded` 必须有可判别的呈现，不得渲染成 0"；**§5 判据 B**："徽标呈现为可判别的『不可用』态"。锁**要求可判别**，**不锁定具体措辞**——已有的两版原文（徽标 `(数据不可用)`、中心页 `该来源暂时无法查询`）都是 B-2 实现者自行选定的字符串，非锁文逐字。本切片只改中心页那一句的措辞（去掉内部分组概念"来源"），可判别性契约（独立 `data-testid`、独立段落、role="status"）逐字保留，未动一处判据。**未改动徽标层的 `(数据不可用)`**——那句不在本 prompt 点名的"来源不可用"范围（它是"整体徽标"文案，不是"某一来源"文案），改它属于扩大范围，本次不动。 | **门审自纠正（见下）**：锁只钉可判别性，措辞本身**无锁文逐字依据**——见 §1.1 |
| ④ | vitest spec 与 run-required exec 块令牌纪律 | 不是锁文条款，是 `apps/web/scripts/run-required-web-tests.sh` 自身与 `required-web-lane-registration-shape.test.ts` 的结构性要求（"结构由……守：`bash -n` 通过；恰好一条 exec 逻辑行；token 无重复；字母序"）。 | **不适用锁文，适用仓库既有工程纪律；见 §3** |

### 1.1 不在范围（明确排除，交 owner /后续切片）

- **① 是否渲染 `updatedAt`/`dueAt`，与 ③ 同一口径，同样不是锁内条款**（门审 round 1 P3-1 指出：初稿
  §1 对 ① 用"锁内"、对 ③ 用"owner 裁决"，两套标准判同一类问题——锁只钉 §3 的契约字段与 §5 的判据，
  从未点名"页面是否要呈现某个已有字段"。§0 来源表把 F-5 标成"P3，UX，锁未要求的加项候选"本就是对的，
  §1 的表格现已回头对齐这句话，不再自相矛盾）。
- **③ 的具体措辞是 owner 文案裁决项，不是本锁的判定**（自纠正，初稿曾把它记成"锁内"，是过强声明）：
  锁 §4/判据 B 只钉"必须可判别"，从未点名过任何一句具体中文/英文字符串——本切片选的新字符串
  与 B-2 选的旧字符串地位相同，都是"实现者自行决定，锁不裁"的产物。本仓已有同类先例明确把这类问题
  记成 owner 项而不是锁内条款：`owner-decision-brief-20260916.md:70`，"散文里的『表单』怎么改……
  文案取舍，你定；本切片不动"。代码与本轮新增的钉字符串测试（`TodoCenterView.spec.ts:147`）可以
  保留——按字节钉文案是仓内既有惯例（如 `approvalNavTodoBadge.spec.ts:335` 钉 `(数据不可用)`）——
  但不能对外声称"锁选中了这句话"；真正的裁决权在 owner，门审如果否决这句改写，回退成本是改一处
  字符串常量 + 同步改一处断言，零结构性返工。
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
  `dueAtLabel` 不带 `updatedAtLabel` 那条 `if (stamp === '') return ''` 防御——它唯一的调用点在
  `v-if="item.dueAt"` 内（`:73`），入参恒真值，`formatItemTimestamp` 不可能对它返回 `''`
  （门审 round 1 P3-5：该分支是死代码，本轮删除并加一行注释说明原因，不做行为改变）。
- 模板：**只在 `router-link` 分支**（可导航行）新增 `todo-center__item-meta`，含
  `data-testid="todo-center-item-updated-at"`（恒渲染）与 `data-testid="todo-center-item-due-at"`
  （`v-if="item.dueAt"`）。`unlinkable` 分支（惰性行）**不**渲染这两个字段——D2 初稿曾在两个分支各复制
  一份逐字相同的块，门审 round 1 P2-1 用隔离 2×2 mutation（M1 只删 `:77`/M2 只删 `:56`/M5 删整个
  `:54-57` 块）证明惰性行分支上的那份对既有 15 条用例**零判别力**（M2/M5 均 15/15 全绿，只有 M1 会
  RED）——今天唯一注册的来源恒产出站内相对 `href`（`isSameOriginRelativeHref` 恒真），这条分支的
  生产者不可达，惰性行分支新增的两个 span 没有任何测试守着。二选一里选择**删除**（而非补测试）：
  惰性行是"链接失效时的降级展示"，本就只显示标题；一旦真的有来源产出非站内 href 触发这一支，`title`
  之外的信息本来就更不重要，把它加回来的成本远小于长期维护一份不可达代码路径的测试。见验证 MD
  §1.1 的完整隔离网格与还原记录。
- CSS：新增 `.todo-center__item-main`（flex column 包住 title+meta）与 `.todo-center__item-meta`
  （flex row，12px 次要色），零覆盖既有 `.todo-center__item-link` 布局（后者仍是最外层 flex
  space-between，pill 仍是它的直接子元素，位置不变）；`.todo-center__item-main` 在两个分支都保留
  （惰性行分支只是不再往里塞 meta 内容），两支布局容器形状一致。

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

### 2.4 ④ run-required-web-tests.sh —— 现已零改动（B-2 独立完成了同一处清理）

本切片**没有新增 vitest spec 文件**（① ② ③ 的用例都补进已注册的 `TodoCenterView.spec.ts`，该文件的
`TodoCenterView` 令牌早在 B-2 落地时已加入 `run-required-web-tests.sh` 与 `approval-web-guard.yml`
两个登记点，两点纪律不需要新增）。

D2 初稿在这里做过一次清理：文件末尾有一份**死代码重复块**——`exec npx vitest run \` 之后的活令牌表
之后，紧跟着同一张表的旧快照（比活表少 `todoApi`/`TodoCenterView`/`todoCountsRealtime` 三个令牌），
`bash` 的 `exec` 在活表结束处就替换了进程，第二份表从未被任何 shell 执行到。D2 删除了它。

**2026-09-22**：B-2 自己的一个独立修复轮（`16703f8cfd7a11ac90da8568bc4a1a7846d6dd05`，
"fix(ci): drop the dead token block left after the required-web exec line"）删的是**逐字节相同**的
398 行（`git diff … | grep '^-' | md5` 两侧一致，见验证 MD §2）。本分支 rebase 到那个新 head 之上后，
两次删除天然幂等——**本 PR 现在对 `run-required-web-tests.sh` 的 diff 是零字节**（`git diff
16703f8cf… -- apps/web/scripts/run-required-web-tests.sh` 空输出）。D2 初稿在删除之外还加了一段
"H-4 cleanup" 说明性注释，rebase 后这段注释描述的是 B-2 已经做完的事、归属误导（读起来像本 PR 自己做的
删除），修复轮 2 里已删掉（只删，不改写成别的说法）。

`required-web-lane-registration-shape.test.ts`"恰一条 exec 逻辑行"这条形状不变量今天成立，且被本轮
重新核对（验证 MD §2）——但门审 round 1 P3-2 指出一个先存事实：**这个检查文件当前不接入任何
GitHub Actions workflow**（`grep -rn "required-web-lane-registration" .github/` 零命中），它今天
18/18 只是本地实跑的信号，不是 CI 强制闸；本切片不引入也不修复这一点，仅如实登记。

## 3. 与既有代码的接口面

零改动文件（供门审快速核对"未越界"）：
- `packages/core-backend/src/**` 全部未动（本切片纯前端 + CI 脚本）。
- `apps/web/src/todo/api.ts`、`apps/web/src/approvals/components/ApprovalTodoBadge.vue` 未动。
- `.github/workflows/*.yml` 未动（两点纪律的第二登记点 `approval-web-guard.yml` 已含
  `TodoCenterView`/`todoApi`/`todoCountsRealtime` 三令牌 —— 校验见验证 MD §2）。

改动文件清单（相对新 B-2 head `16703f8cf…`，命令：`git diff --numstat 16703f8cf… -- <file>`，
本轮机械重跑，不手写）：
- `apps/web/src/todo/views/TodoCenterView.vue` — **+84/-3**
- `apps/web/tests/TodoCenterView.spec.ts` — **+83/-0**，`grep -cE "^\s*it\(" `：新 B-2 基线 **11**
  条 → 本切片头 **15** 条，即本切片新增 **4** 个 `it`
- `apps/web/scripts/run-required-web-tests.sh` — **零 diff**（rebase 后与新 B-2 逐字节相同，见 §2.4）

（本设计 MD 与同目录验证 MD 自身的 diffstat 不在此表——文档在写作过程中持续变化，任何此刻贴的数字
下一次编辑就会过期，故不记自指快照；读者需要时可自行 `git diff --stat` 现跑。）

## 4. 修复轮 2（D1 rebase + D2 record fix，2026-09-22）—— 按门审 round 1 逐条处理

对象门审：`impl-gate-B3-todo-polish-round1-20260922.md`（VERDICT APPROVE-with-hardening，
0 P1 / 2 P2 / 7 P3 / 2 NIT）。

### 4.1 Rebase（`git rebase --onto`，`-c user.name=zensgit -c user.email=…noreply.github.com`）

B-2 自己的一个独立修复轮把本切片同样清理过的死代码块删掉了（`16703f8cfd7a11ac90da8568bc4a1a7846d6dd05`）。
`git rebase --onto 16703f8cfd7a11ac90da8568bc4a1a7846d6dd05 0a6531b80e6cb362067742ee4b94477842a75965 HEAD`
——两条 B-3 自有提交（`ae7e065ec`/`7601a7eeb`）**均自动应用，零冲突**（三方合并识别出两侧对
`run-required-web-tests.sh` 做了逐字节相同的 398 行删除，视为已应用）。

| 断言 | 命令 | 结果 |
|---|---|---|
| 新 head | `git rev-parse HEAD` | `2e99240b2206215a6e0b82cc53e5af916b767396` |
| 新 B-2 是祖先 | `git merge-base --is-ancestor 16703f8cf… HEAD` | YES |
| #5857/旧 B-2 是祖先 | `git merge-base --is-ancestor 0a6531b80… HEAD` | YES |
| 与 main 零重复 | `git cherry origin/main HEAD \| grep -c '^-'` / `grep -c '^+'` | `0` / `74` |
| exec 逻辑行 | `grep -n '^exec npx vitest run' apps/web/scripts/run-required-web-tests.sh` | 恰一处，`:1257` |
| exec 前缀行数 | `grep -c '^exec ' …` | `1` |
| 文件行数 | `wc -l …` | `1658`（与新 B-2 相同） |
| token 集合 = 新 B-2 集合 | `node scripts/ops/required-web-lane-token-set-diff.mjs origin/feat/todo-center-phase2-fe HEAD` | `SET IDENTICAL`（400/400 两侧） |
| token 集合 = 旧 H-4 head 集合 | 同脚本，`7601a7eeb… HEAD` | `SET IDENTICAL`（400/400 两侧） |
| author/committer 全干净 | `git log --format='%H %an <%ae>' origin/main..HEAD \| grep -v 'zensgit <77236085'` | 恰两行，均 `Merge Rehearsal <rehearsal@local.invalid>`（`03c276cc2…`/`9fa446dd3…`）——**#5857 的既有提交，非本切片引入**（门审 P3-3；归 #5857 合并前处理，本 PR 不动） |

### 4.2 P2-1（惰性行分支 meta 块零覆盖）—— 见 §2.1，选择删除

隔离网格与还原记录见验证 MD §1.1。

### 4.3 P2-2（≥8 处手写数字）—— 全部改为命令重生成或删除

见验证 MD 各节内联的命令+输出；本设计 MD 自己的 §3 文件清单同样改为现跑数字。已改正/删除的行：
「原 9 条+新增 6 条」（→「原 11 条+新增 4 条」）、`:228`（→`:247`）、`run-required-web-tests.sh`
净变更行数（该文件现对新 B-2 零 diff，"清理前/清理后"两个行号的整段叙事已随之删除——rebase 后
这处清理不再是本 PR 自己的动作，见 §2.4）、`found 3`（→ 复跑得 `found 2`，见验证 MD §2）。

### 4.4 P3 处置登记

| # | 处置 |
|---|---|
| P3-1 | 见 §1 row ①、§1.1——判定改为与 ③ 同口径，§0/§1 不再互相矛盾 |
| P3-2 | 见 §2.4——`required-web-lane-registration-shape.test.ts` 不在任何 workflow 里，本轮 18/18 为本地实跑，如实标注，不当 CI 绿 |
| P3-3 | 见 §4.1 表格——两条 `Merge Rehearsal` 作者提交登记为 #5857 既有，本 PR 不修 |
| P3-4 | 见验证 MD §3.1——中止机制改述为 `:612` 独立调用 + `:473` 的 `set -euo pipefail` |
| P3-5 | 见 §2.1——`dueAtLabel` 死分支已删 |
| P3-6 | 已披露的取舍，维持不升级（`formatItemTimestamp` 的 locale 实参零覆盖） |
| P3-7 | `/todo` 导航在 1280px 下被裁——`App.vue` 本 PR 零改动，机制属 #5857（B-2 step 11），登记为 #5857 范围，不阻塞本 PR |
