# 退回候选线：验证记录（2026-10-09，定稿 2026-10-10）

- 对象：Draft #6291（前端过滤；head `f28b76dcd6`）、Draft #6293（服务端 `returnableNodeKeys`；head `35190bee03`，基线已改到 main）、Draft #6294（真实浏览器验收；head `91e48ae298`，含对 `35190bee03` 的合并；基线是 #6293 的分支）。
- 开发说明：`docs/development/approval-return-candidates-dev-20261009.md`。
- 时点：所述 PR、分支与 head 的状态截至 2026-10-10 02:11（+0800）；托管 CI 的只读快照时刻在各处另标。
- 约定：同开发说明。命令与数字只抄自门审报告、实现说明和只读快照（均为私有记录），或本文定稿时在本机只读重算（git、node 跑仓库自带的无依赖清单生成器、`gh` 只读）；没有来源可核的写「未核」。测试与变异都在「另一台机器」的独立工作树里跑，本机只做 git 与文件读取；工作树用完即删。
- 变异标号只在各自的轮次内有意义，同一标号在不同轮次可能指不同变异（例如实现方第 0 轮的 `M10` 与门审 r1 的 `m10a / m10b` 无关）。本文一律加前缀：切片一 `R0·`（第 0 轮实现方）、`r1·`（门审 r1）、`F1·`（修复轮 1 实现方）、`r2·`（门审 r2）；切片二 `S2·`、`G2r1·`、`S2F1·`、`G2r2·`（§8）；切片三 `G3r1·`、`G3r2·`、`G3r3·`（§6）。
- 门审的对象 head 与最终 head 不同处：切片一门审 r2 批准的是 `038534f003`，#6291 的最终 head 是 `f28b76dcd6`，二者只差一个提交，且只改验证夹具（§1）。切片二与切片三的最终 head 就是各自最后一轮门审的对象。

## 1. 验证总览

| 轮次 | 对象 head | 判定 | P1 | P2 | P3 | NIT | 说明 |
|---|---|---|---|---|---|---|---|
| 切片一·第 0 轮（实现方自测） | `f6cd25bd84` 视图，登记提交 `78be3bf3dc`；全量车道跑在其前身 `ff966786a5` | 非门审 | — | — | — | — | 新 spec 14 例；§5 |
| 切片一·门审 r1 | `78be3bf3dc` | CHANGES-REQUESTED（NEEDS-FIX） | 0 | 1 | 4 | 2 | P2：一次退回之后游标下游节点仍被提供；§2 |
| 切片一·修复轮 1（实现方） | `038534f003` | 非门审 | — | — | — | — | 新 spec 21 例；14 个变异；§4、§5 |
| 切片一·门审 r2 | `038534f003` | APPROVE | 0 | 0 | 3 | 2 | 只核修复点；全量车道与 approval-web-guard 交托管 CI；§3 |
| 切片一·浏览器夹具重新落座 | `f28b76dcd6`（门审 r2 之后） | 未经门审 | — | — | — | — | 只改验证夹具一个文件；另一台机器 8/8；托管 CI pass；§6 |
| 切片二·门审 r1（#6293） | `5fdd9036c8` | CHANGES-REQUESTED（NEEDS-FIX） | 0 | 1 | 1 | 3 | P2：两条载体的调用点接线没有被测试钉住；P3：字段合同过度声称（两个与查看者无关的拒绝没有镜像）；§8 |
| 切片二·修复轮 r1（实现方） | `35190bee03` | 非门审 | — | — | — | — | +10 个后端用例；§8.5 |
| 切片二·门审 r2 | `35190bee03` | APPROVE | 0 | 0 | 0 | 2 | 另沿用 r1 的 2 条 NIT；§8.7 |
| 切片三·第 0 轮（实现方自测） | `d8fb436e55` | 非门审 | — | — | — | — | 8 个 Playwright 场景；§6.9 |
| 切片三·门审 r1（#6294） | `d8fb436e55` | NEEDS-FIX | 0 | 1 | 2 | 3 | P2：办理节点游标夹具线上不可达；§6.7 |
| 切片三·门审 r2 | `15a5e5dbec` | NEEDS-FIX | 0 | 1 | 1 | 2 | P2：`server-empty` 夹具线上不可达；§6.7 |
| 切片三·门审 r3 | `91e48ae298`（含合并 `35190bee03`） | APPROVE | 0 | 0 | 0 | 2 | 10 个场景；§6.7 |

- `git diff --stat 038534f003 f28b76dcd6`：1 个文件（`apps/web/verification/approval-member-action-dialog-harness.ts`，+10/−4）。视图与 spec 与门审 r2 看过的逐字节相同，所以门审 r2 对视图和 spec 的结论适用于最终 head；夹具那一个文件没有被任何门审看过，但被托管 CI 与另一台机器的运行覆盖（§6）。
- 每一轮门审都是独立的对抗审阅，审阅者与实现者不是同一方；审阅前都核对了工作树 HEAD 等于被审 sha。
- 托管 CI 的状态见 §5.5（#6291）、§8.6（#6293）、§6.9（#6294）。

## 2. 门审 r1：发现与处置

对象 `78be3bf3dcf9c2a680e9879c245325b908017b7e`，merge-base `a16a12aca35d46b6b621ae12f49b380b50b95b48`。审阅期间 main 前进到 `c60805b3ac`，它不碰本分支的 5 个文件，`git merge-tree` 合并干净。

方法：服务端断言读自基线 sha；每一个测试与变异都在另一台机器的独立 detached 工作树里、在被审 sha 上重放（全新的 `pnpm install --frozen-lockfile --prefer-offline`）；另做了一个真实执行器的后端探针来核对「服务端合法集」的断言。

判定：CHANGES-REQUESTED。切片做得扎实，三道门与服务端同源且被钉得很好：14 个变异里 11 个让命名测试变红（含审阅必做的全部 6 个）。但它没有兑现自己的标题「只提供服务端合法的目标 / 没有死按钮」：在最常见的后续流程里，一次退回之后按钮仍带着服务端必拒的选项出现。

| 发现 | 要点 | 修复轮 1 的处置 | 门审 r2 复核 |
|---|---|---|---|
| P2-1 退回（或管理员回退）之后，游标**下游**的节点仍被提供，每个都 409 | `returnEligibleGraphKeys` 只按类型与并行区域过滤；服务端 walker 走到游标即停（`listVisitedApprovalNodeKeysUntil`），下游永不合法。退回行自己的 `nodeKey` 是发起退回的那个节点，`/history` 没有退回下限，历史里仍有下游键。PROBE-A / PROBE-B 复现（开发说明 §1.3）。评为 P2 的理由：退回之后在被退回的节点上操作是这个动词自己的正常流程；提交 `f6cd25bd84` 的标题声称更多；它不是回归（既有行为） | 新增 `upstreamNodeKeys`（从游标沿 `graph.edges` 反向 BFS），`returnEligibleGraphKeys` 只留上游节点；游标为空或不在图内时跳过该过滤。新增 T11（PROBE-A）、T12（PROBE-B）、T15 | 关闭；去掉过滤则 T11、T12 变红 |
| P3-1 漂移：模板槽接受模板的**最新**版本且不查版本，与 T9b 不一致；「丢弃图里没有的键」一条无测试（`r1·m13` 存活） | 版本槽查 `id`（T9b），模板槽只查 id；成员只能用模板槽；`ApprovalTemplateListItemDTO` 已带 `latestVersionId`。门审建议一行回退：模板槽被用且 `latestVersionId` 不等于实例的 `templateVersionId` 时按无图处理（或保留缺失键），再用一个测试钉住 owner 选的行为 | 默认 (a)：`latestVersionId === templateVersionId` 才判；实例无 `templateVersionId` 时无图；新增 T13、T13b、T14；T10 改用真实漂移的模板 | 关闭为默认 (a)；(a) 的代价成为 r2 的 P3-1 |
| P3-2 `usable()` 守卫无测试（`r1·m11` 存活） | 它让缺 nodes / edges 数组的图不在动作栏里抛错；没有证据表明有生产者发这种 DTO，所以不是 P2。建议加一个 `approvalGraph: {}` 的测试，或删掉这个声明 | 守卫与声明删除，注释改为陈述线上合同。建议的测试**写不出来**：实现方把它当临时探针跑过（自有模板、版本 id 匹配、`approvalGraph: {}`，期望旧列表且不抛）：有 `usable()` 时（`78be3bf3dc`）失败，`upcomingTimelineNodes` 经 `buildUpcomingNodes` 读 `map` 抛 TypeError，`nodeLabel` 读 `find` 抛 TypeError（经按钮的 `v-if`）；去掉 `usable()` 后（`038534f003`）仍失败，同样的 `map` 抛错外加 `graph.nodes is not iterable`。页面在既有路径上无论有无守卫都抛，没有测试能隔离它；且 `asApprovalGraph` → `normalizeApprovalGraph` 在 `nodes`、`edges` 不是数组时 `failValidation`，没有生产者发这种 DTO | 读代码核对：确认校验与既有抛错路径，删除是门审给的第二个选项 |
| P3-3 动作响应 + 没有可达的图 + 游标是办理节点：仍提供「退回」并 409 | 动作响应（`toUnifiedApprovalDTO`）从不带 `currentNodeType`；视图在动作后保留该响应，只刷新历史；无图时 `returnCursorNodeType` 为 null。很窄，下一次详情读自愈。另：模板加载完成前列表是旧列表，按钮会先闪一下。本切片不需要改，由后端跟进关闭 | 无代码改动；在 `returnCursorNodeType` 处写注释；默认 (a) 使其变宽，已披露 | 即 r2 的 P3-3；切片二以动作响应上的 `[]` 关闭，切片三 `server-empty` 场景钉住（§6.6） |
| P3-4 (c) 在 P2 修复之后仍未镜像的部分 | 表单改动后不再被解析到的条件分支上的节点仍被提供并 409；管理员前进跳转跳过的轨迹节点合法但从不被提供。都是既有且少见的情形 | 记入 `returnEligibleGraphKeys` 的「NOT mirrored」注释和 spec 头部；无代码 | 即 r2 的 P3-2；切片二在服务端列表存在时关闭 |
| NIT-1 `version.templateId === detail.templateId` 校验无测试（`r1·m12` 存活） | 版本 id 全局唯一，该校验与版本 id 校验冗余；保留作纵深防御，或补一行测试 | 保留；新增 T9c | 关闭；T9c 在 spec 里。实现方的 `F1·mF`（去掉该校验）使 T9c 变红，门审 r2 未重放它 |
| NIT-2 提交与 PR 的标题夸大 | `f6cd25bd84` 的标题与注释块读起来像完整镜像 | 头部注释改为「NOT a complete mirror」并指向残留清单；不改写既有提交标题；建议 squash 标题（开发说明 §7.1） | 关闭 |
| 信息项（不计分） | 提交 trailer 署 `Claude Opus 5.5`，与当时约定的署名行（`Claude Fable 5.1`）不同；实现方在说明里披露了并说明依据，所有提交一致 | 不变；是否修改由合并者或 owner 定 | 即 r2 的 NIT-2 |

门审 r1 的其余核对：

- **同源核对。** (a)：详情读的 `currentNodeType` 来自 `resolveCurrentNodeType`，动作响应则没有，前端先读 DTO 字段再回退到图。(b)：并行状态只在解析出的游标是 fork 时持久化（approve 路径之外还有管理员、超时、退回路径的清除语句），所以「有状态」等价于「游标是 fork」；详情读在 fork 处给 `currentNodeType 'parallel'`，动作响应给 `currentNodeKeys`，前端 `> 0` 的读法与 `currentActiveNodeKeys` 一致，并行 badge 的 `>= 2` 正确地没有被复用，无分歧。(c)：分歧即 P2-1、P3-4、P3-1。
- **历史行的种类。** 自动审批行带审批节点的 key（在轨迹上、合法，被提供，一致）；抄送行带 cc 的 key（被类型过滤去掉）；管理员跳转行不带 `nodeKey`；退回行带的是发起退回的节点（P2-1 的来源）。
- **规格里「服务端合法集」的断言。** 在规格的原样夹具上，真实执行器给 `['approval_1']`，后端探针通过。
- **实现方的其他断言核实为真。** 详情读从不带 `currentNodeKeys`；动作响应从不带 `currentNodeType`；store 把动作响应写进 `activeApproval`；wp1 并行网关测试里的中段形状（`currentNodeKey 'parallel_fork'`、`currentNodeKeys ['compliance_review']`）；`insertParallelGateway` 把 `joinNodeKey` 设成原出边的目标；节点类型里没有 join。
- **CI 登记。** 车道脚本里的新一行在 `set -euo pipefail` 之后的顶层，没有外层块；用仓库自己的 `allVitestTokens` 重算：基线 553 个 token，head 554 个，只多了 `approval-detail-return-candidates`；对其余 553 个 token 双向子串检查无碰撞；该 token 在 apps/web 下只匹配一个被跟踪文件；清单校验 MANIFEST MATCHES（20 条门控调用，554 个 token）；工作流里 spec 路径在两个 `paths:` 块中、token 在 targeted 运行行里，对该行的 JSON reporter 回放显示 spec 被执行（14/14）。守卫是承重的：只删车道行会让 `required-web-lane-token-manifest-guard` 变红；把 token 从车道和守卫行**两处**都删掉会让 `approval-ci-coverage-enumeration` 的 T1「is wired」变红；只从守卫行删则仍绿，因为 T1 接受任一车道，这是预期，不是本 PR 的缺口。
- **范围与卫生。** `git diff --stat` 恰为 5 个文件（工作流、车道脚本、`.tokens`、视图、新 spec），模板与按钮不变，`pinnedGraph` 与 `upcomingTimelineNodes` 未动；diff 里没有主机名、内网 IP 或用户名；实现说明在每一条被核对的事实上都准确，§4 如实披露了 P2-1 的残留，发现针对的是评级，不是诚实度。

## 3. 门审 r2：发现

对象 `038534f003d82644d297c4234bf8e5c25b233f7a`，merge-base 同上。审阅时 `origin/main` 是 `52aae89fc7`；服务端断言读自 `origin/main`，所引用的八个服务端与前端支撑文件在 merge-base 与 `52aae89fc7` 之间都没有变动。门审 r1 之后的两个提交是 `fc07611cf3`（测试）与 `038534f003`（视图），历史没有改写，r1 引用的 sha 仍然有效。

方法：本机只做 git 读取，以及对两份解出的树在临时目录里运行仓库自带、无依赖的清单生成器；每一次 vitest 运行与变异都在另一台机器的独立 detached 工作树里、在被审 sha 上重放（全新安装，退出码 0）。视图只在那里被改，每个变异后从 HEAD 还原并确认工作树干净；工作树与草稿文件最后都已删除。按审阅的分工，完整的 `run-required-web-tests.sh` 与完整的 approval-web-guard targeted 运行行**没有**在门审里跑，交给 Draft PR 的托管 CI。

判定：**APPROVE**，0 P1、0 P2、3 P3、2 NIT。r1 的 P2-1 已关闭：前端现在镜像了执行器「走到游标即停」的规则，两个探针测试（T11、T12）已在 spec 里，去掉过滤则变红。三条 P3 与两条 NIT 都是实现方已在代码注释和说明里披露的承接项，没有一条是对 main 的回归，也没有一条能在不加新后端数据的前提下加前端门。它们记给 owner，不是阻塞项。

### 3.1 三条 P3 的原文要点

**P3-1（r1 P3-1 的延续，现为 (a) 默认值）：对普通成员，只要模板有比实例钉定版本更新的版本，整个图一侧的镜像，包括 P2-1 的上游过滤，都是关的。**

- 位置：`ownApprovalGraph` 在 `template.latestVersionId !== detail.templateVersionId` 时返回 null；`returnEligibleGraphKeys` 随之为 null，`returnableNodes` 回退到旧列表。
- 场景：任何有未发布草稿的模板（管理员开过一次编辑器），或任何在重新发布之前开始的实例；普通成员；一次退回之后，旧列表又提供下游节点，每个都答 `APPROVAL_RETURN_TARGET_INVALID`。办理节点类型的图回退、类型与区域过滤在同一状态下一并关闭。
- 为什么评 P3 而不是 P2：与 main 的行为逐字节相同（无回归）；已在视图注释、spec 头部和说明里披露（含代价一段）；备选 (b) 只覆盖节点被删，会误判改了类型、挪动或重排的节点；干净的解法需要前端没有的后端数据。
- 处理（owner / 后续）：确认 (a)，或改判。门审 r2 原文写的是「翻成 (b)：一行改动加反转 T13 / T13b」；按实现说明 §10.2，这一行改动（去掉 `&& template.latestVersionId === pinnedVersionId`）得到的是「按最新版本的图判」，并不是 (b)：(b) 还需要保留图里没有的历史键的那一臂，并反转 T14（开发说明 §3.3 写了两种翻转）。长期：把冻结图或服务端的合法目标放进实例 DTO（实例 DTO 上的 `formSchema` 已经是冻结的），之后前端可以彻底去掉模板槽——这就是切片二。

**P3-2（r1 P3-4 的延续）：(c) 的两种情形没有前端门能镜像。**

- 访问过、但位于表单已不再解析到的条件分支上的审批节点，仍被提供并 409（`APPROVAL_RETURN_TARGET_INVALID`）；前端不对表单求值。
- 无人到过的轨迹节点（管理员前进跳转跳过）在服务端合法，但候选来自历史，所以从不提供。
- 两者记在视图的「NOT mirrored」注释和 spec 头部。本切片不改动。

**P3-3（r1 P3-3 的延续，被 (a) 放宽）：动作响应之后、没有自己的图时，办理节点游标重新提供「退回」，直到下一次详情读。**

- 动作响应不带 `currentNodeType`；模板漂移（或不可达）时 `returnCursorNodeType` 为 null，「退回」被提供，服务端答 `APPROVAL_HANDLER_ACTION_NOT_ALLOWED`。下一次详情读自愈。记在 `returnCursorNodeType` 处的注释和说明里。

**NIT-1：`F1·mG`（即 `r1·m14`，「模板槽优先于版本槽」）现在是等价变异。** 两个槽都对同一个不可变的版本 id 做身份校验，顺序不能改变结果；T10 仍钉住「模板漂移时冻结版本仍然判」（去掉版本槽使 T10 变红，是 `F1·mH`，门审 r2 未重跑）。无需动作。

**NIT-2：** 五个提交的 trailer 署 `Claude Opus 5.5`，不是当时约定的 `Claude Fable 5.1`；各提交一致，实现方在说明里披露并说明了依据；squash 时的 trailer 由合并者或 owner 定。按当时的约定可接受。

### 3.2 门审 r2 对 r1 处置的逐条复核

| r1 发现 | head 上的处置 | 复核 |
|---|---|---|
| P2-1 游标下游 | `upstreamNodeKeys` + 过滤；T11 / T12 / T15 | `r2·mA` 使 T11、T12 变红（§4） |
| P3-1 漂移；`r1·m13` 无测试 | 默认 (a)；`latestVersionId === templateVersionId`；无版本 id 守卫；T13 / T13b / T14 | `r2·mC` 红 T13，`r2·mD` 红 T13b，`r2·mE` 红 T14 |
| P3-2 `usable()` | 守卫与声明删除，注释陈述线上合同 | 读代码核对，不凭信任：`normalizeApprovalGraph` 在 `nodes`、`edges` 不是数组时 `failValidation`，模板 DTO 的 `approvalGraph` 总经 `asApprovalGraph`，所以没有生产者能发 `{}`；既有抛错路径是 `pinnedGraph`（无身份校验）→ `upcomingTimelineNodes` → `buildUpcomingNodes` 的 `graph.nodes.map`，以及 `nodeLabel` 读模板图的 `nodes.find`（经按钮的 `v-if`）。守卫单独的测试因此写不出来，删除是门审给的第二个选项 |
| P3-3 | 在 `returnCursorNodeType` 处记录；被 (a) 放宽，已披露 | 即本节 P3-3 |
| P3-4 | 记入「NOT mirrored」块和 spec 头部 | 即本节 P3-2 |
| NIT-1 `version.templateId` | 保留；T9c | T9c 在 spec 里；`r2·m3`、`r2·m4` 会让 T9c 变红 |
| NIT-2 标题夸大 | 头部注释写「NOT a complete mirror」；建议 squash 标题 | 已读 |
| 信息项 trailer | 不变 | 即本节 NIT-2 |

### 3.3 门审 r2 对「同源」的手工复核

对游标 `c` 是区域外的审批节点的情形，walker 的轨迹去掉 `c` 恰是「表单解析出的那一条 start 到 `c` 路径上的审批节点，跳过并行区域」。前端集合是「审批节点、区域外、有任何一条边路径通向 `c`」。两者只在两处不同：`c` 上游有条件节点（前端接受全部分支，walker 只走一支，即 P3-2），以及无人到过的轨迹节点（历史给不出来）。门审没能构造出更多的偏差：

- `c` 上游有 fork：分支节点被区域过滤去掉；fork 本身不是 `approval` 类型；fork 的前驱经通向 join 的分支边可达，不需要专门的 fork → join 边。在规格夹具（T4：恰为 `['approval_1']`）与线性退回之后的形状（T11、T12）上核对过。
- 游标在区域内：(b) 在 (c) 之前两边都先拒绝。
- 自动审批行带审批节点的 key，在轨迹上且合法，被提供；cc 行带 cc 的 key，被类型过滤去掉；管理员跳转行带 `fromNodeKey` / `toNodeKey`、不带 `nodeKey`，不会产生候选。
- 退回之后残留的 `parallelBranchStates`（会让前端经 `currentNodeKeys` 隐藏一个合法的退回）：退回分支清除它；approve 只在解析出的游标是 fork 时持久化、否则清除；其余清除点在管理员、超时路径。没有找到会残留的路径。
- 环：walker 抛错；`upstreamNodeKeys` 靠 visited 集合对环安全；发布期校验拒绝环。已发布的图里不可达。

结论：P2-1 已关闭；在实例自己的图可得时，没有剩下的、在合理流程里产生用户可见 409 的情形。图不可得的情形即 P3-1。

漂移规则的可靠性（读自 main）：

- `GET /api/approval-templates/:id` 由 `rbacGuard('approvals:read')` 把守，普通成员可达；它经 `getTemplate` → `loadTemplateBundle(id, undefined, 'latest', actor)`，选 `latest_version_id || active_version_id`。DTO 的 `approvalGraph` 来自**那个**版本，`latestVersionId` 来自同一 bundle 的模板行。所以 `latest_version_id` 非空时，图就是 `latestVersionId` 那个版本的；为空时 DTO 字段为 null、前端永远不匹配（对旧列表 fail-open）。
- 版本不可变：唯一的 `UPDATE approval_template_versions` 只改 `status` 与 `publish_note`；实例钉创建时的 active 版本。`buildRuntimeGraph` 是 JSON 深拷贝加 policy，所以相等意味着逐节点相同。
- 冻结版本接口由 `approvalTemplateAdminGuard` 把守；视图对所有人都请求它，`templateStore.loadVersion` 与 `loadTemplate` 失败时都不清空上一个槽位，所以身份校验是承重的，不是纵深防御：成员身上遗留别的实例或模板的槽位是常态。
- 两个 DTO 构造都带 `templateVersionId`，所以过滤在详情读和动作响应上都生效。
- 代价的披露准确（说明 §3、§10.2 与视图注释）。

### 3.4 门审 r2 的卫生与登记核对

- `git diff --stat a16a12aca3 038534f003` 恰为 5 个文件：`approval-web-guard.yml`（+5/−1）、`run-required-web-tests.sh`（+25）、`.tokens`（+1）、`ApprovalDetailView.vue`（相对基线 +168/−3）、新 spec（+735）；没有 `packages/` 下的文件，也没有任何 OpenAPI 文档。
- 对整份 diff 的主机名、内网 IP、用户名、绝对家目录路径扫描：干净。
- CI 登记本轮没有变，r1 的核对沿用。
- 审阅时 main 在其中两个文件上已前进：`run-required-web-tests.sh`（+12）与 `.tokens`（+1），都是加一个无关的备料 token。head 合入 `origin/main` 的 `git merge-tree` 干净；合并树里两边的 token 都在两个文件里，仓库自带的生成器在解出的合并树上报 MANIFEST MATCHES，20 条门控调用，555 个 token（head 单独是 554）。并集成立，自动合并没有丢 token。
- 说明在 head 上逐条核对均准确；只有一处行号漂移（说明 §10.4 引的 `nodeLabel` 行号，head 上已不同），是装饰性的。

## 4. 变异回放

做法（四轮相同）：在另一台机器的独立工作树里，把变异施加到视图上，跑新 spec，再把视图从提交（或备份拷贝）还原，确认工作树干净，才进入下一个。每个变异的结果是「变红的命名测试」。**四张表按轮次分开，标号带前缀，不跨轮合并。**

### 4.1 第 0 轮·实现方（视图 `f6cd25bd84`；当时 spec 14 例）

| 标号 | 变异 | 变红的测试 |
|---|---|---|
| R0·M1 | 去掉 `type === 'approval'` | T2 T3 T4 T8 T9b T10 |
| R0·M2 | 去掉并行区域过滤 | T4 T8 T9b T10 |
| R0·M3 | 去掉办理节点闸 | T5 T5b |
| R0·M4 | 并行判据改成 badge 的 `isInParallelRegion`（`>= 2`） | T6b T6c |
| R0·M5 | 游标类型不回退到图 | T5b |
| R0·M6 | 用没有身份校验的 `pinnedGraph` 判 | T9 T9b |
| R0·M7 | 去掉版本 id 校验 | T9b |
| R0·M8 | 模板优先于冻结版本 | T10 |
| R0·M9 | 无图时返回 `[]`（fail-closed） | T7 T9 |
| R0·M10 | 缺省 `currentNodeType` 当作办理节点 | T8 |

### 4.2 门审 r1（视图 `78be3bf3dc`；spec 14 例；14 个变异，`m10` 分 a / b 两行）

| 标号 | 变异 | 变红的测试 |
|---|---|---|
| r1·m1（审阅必做） | 去掉办理节点闸 | T5 T5b |
| r1·m2（审阅必做） | 去掉并行闸 | T6 T6b T6c |
| r1·m3（审阅必做） | 去掉 `type === 'approval'` | T2 T3 T4 T8 T9b T10 |
| r1·m4（审阅必做） | 去掉区域过滤 | T4 T8 T9b T10 |
| r1·m5（审阅必做） | 无图 ⇒ `[]` | T7 T9 |
| r1·m6（审阅必做） | 缺省 `currentNodeType` 当作办理节点 | T8 |
| r1·m7 | 游标类型不回退到图 | T5b |
| r1·m8 | 并行判据由 `> 0` 改成 `>= 2` | T6b |
| r1·m9 | 去掉 `'parallel'` 游标类型一臂 | T6c |
| r1·m10a | 去掉版本 id 身份校验 | T9b |
| r1·m10b | 去掉模板 id 身份校验 | T9 |
| r1·m14 | 模板优先于冻结版本 | T10 |
| r1·m11 | 去掉 `usable()` | **无：存活**（P3-2） |
| r1·m12 | 去掉 `version.templateId` 校验 | **无：存活**（NIT-1） |
| r1·m13 | 保留图里没有的历史键 | **无：存活**（P3-1） |

14 个变异中 11 个变红（`m1` 至 `m9`、`m10`、`m14`），3 个存活（`m11`、`m12`、`m13`）。

### 4.3 修复轮 1·实现方（视图 `038534f003`；spec 21 例；14 个变异）

| 标号 | 变异 | 变红的测试 |
|---|---|---|
| F1·mA | 去掉上游过滤 | T11 T12 |
| F1·mB | 游标不在图内时上游集合取空 | T15 |
| F1·mC | 去掉 `latestVersionId` 校验 | T13 |
| F1·mD | 去掉「无 `templateVersionId` 即无图」的守卫 | T13b |
| F1·mE | 保留图里没有的历史键 | T14 |
| F1·mF | 去掉 `version.templateId` 校验 | T9c |
| F1·mG | 模板优先于冻结版本 | **无：存活**，spec 21/21 仍绿（等价变异，见 §4.5） |
| F1·mH | 去掉冻结版本槽 | T10 |
| F1·m1 | 去掉办理节点闸 | T5 T5b |
| F1·m2 | 去掉并行闸 | T6 T6b T6c |
| F1·m3 | 去掉 `type === 'approval'` | T2 T3 T4 T8 T9b T9c T10 T14 T15 |
| F1·m4 | 去掉区域过滤 | T4 T8 T9b T9c T10 T14 T15 |
| F1·m5 | 无图 ⇒ `[]` | T7 T9 T13 T13b |
| F1·m6 | 缺省 `currentNodeType` 当作办理节点 | T8 |

### 4.4 门审 r2（视图 `038534f003`；spec 21 例；基线 21/21 通过；8 个变异）

| 标号 | 变异 | 变红的测试 |
|---|---|---|
| r2·mA | 去掉 `.filter((node) => !upstream \|\| upstream.has(node.key))` | T11 T12 |
| r2·mC | 去掉 `&& template.latestVersionId === pinnedVersionId` | T13 |
| r2·mD | `if (!detail?.templateId \|\| !pinnedVersionId)` 改成 `if (!detail?.templateId)` | T13b |
| r2·mE | 保留图里没有的历史键（`\|\| !ownApprovalGraph.value?.nodes.some(...)`） | T14 |
| r2·m1 | 去掉 `if (returnCursorNodeType.value === 'handler') return []` | T5 T5b |
| r2·m2 | 去掉 `if (returnBlockedByParallelRegion.value) return []` | T6 T6b T6c |
| r2·m3 | 去掉 `node.type === 'approval'` | T2 T3 T4 T8 T9b T9c T10 T14 T15 |
| r2·m4 | 去掉 `!parallelRegion.has(node.key)` | T4 T8 T9b T9c T10 T14 T15 |

门审 r2 的结论：审阅必做的每个变异都让命名测试变红，变红集合与实现说明 §10.1 所列逐项相同（`F1·mA / mC / mD / mE / m1 至 m4`）。`F1·mB`、`F1·mF`、`F1·mG`、`F1·mH`、`F1·m5`、`F1·m6` 由实现方在修复轮 1 跑过，门审 r2 未重放。

### 4.5 存活变异的去向

| 存活的变异 | 去向 |
|---|---|
| r1·m11（`usable()`） | 守卫与声明删除，此变异不再存在（§2 P3-2） |
| r1·m12（`version.templateId` 校验） | 新增 T9c；`F1·mF` 使 T9c 变红 |
| r1·m13（保留图里没有的历史键） | 新增 T14；`F1·mE` 与 `r2·mE` 使 T14 变红 |
| r1·m14，即 `F1·mG`（模板优先于冻结版本） | `r1` 时使 T10 变红；修复轮 1 之后成为**等价变异**：两个槽都对同一个不可变的版本 id 做身份校验，顺序不能改变结果，所以 spec 21/21 仍绿。T10 仍钉住「模板漂移时冻结版本仍然判」（`F1·mH` 去掉版本槽使 T10 变红）。已披露（§3.1 NIT-1） |

### 4.6 先写测试（tests-first）

| 对象 | 内容 | 结果 | 复现 |
|---|---|---|---|
| 第 0 轮 | 只有 spec 的提交 `a608122448` 对旧视图 | 11 failed / 3 passed（T1、T7、T9 本就应通过） | 门审 r1 复现 |
| 修复轮 1 | 只有 spec 的提交 `fc07611cf3` 对修复前的视图 | 4 failed（T11、T12、T13、T13b）/ 17 passed | 门审 r2 复现 |
| 切片二 | 切片一的视图（`f28b76dcd6`）对切片二的 spec（27 例） | 5 failed（TS1、TS2、TS2b、TS3、TS3b）/ 22 passed；T1–T15 与 TS4 仍绿（TS4 钉的是缺省回落，旧视图天然满足） | 实现方探针；切片二门审 r1 的 `G2r1·m1`（忽略服务端列表）在新视图上得到同一组 5 红 |

### 4.7 不同标号指同一变异的对照

- 去掉办理节点闸：`R0·M3` = `r1·m1` = `F1·m1` = `r2·m1`。
- 去掉并行区域过滤：`R0·M2` = `r1·m4` = `F1·m4` = `r2·m4`。
- 去掉 `type === 'approval'`：`R0·M1` = `r1·m3` = `F1·m3` = `r2·m3`（变红集合随 spec 的增长而变大，见各表）。
- 去掉并行闸：`r1·m2` = `F1·m2` = `r2·m2`。
- 无图 ⇒ `[]`：`R0·M9` = `r1·m5` = `F1·m5`。
- 缺省 `currentNodeType` 当作办理节点：`R0·M10` = `r1·m6` = `F1·m6`；它**不是** `r1·m10a / m10b`。
- 游标类型不回退到图：`R0·M5` = `r1·m7`。
- 并行判据：`R0·M4` 一个变异同时覆盖了门审 `r1·m8` 与 `r1·m9` 拆开的两处。
- 去掉版本 id 身份校验：`R0·M7` = `r1·m10a`。
- 模板优先于冻结版本：`R0·M8` = `r1·m14` = `F1·mG`。
- 去掉保留图里没有的历史键一臂：`r1·m13` = `F1·mE` = `r2·mE`。
- 去掉 `version.templateId` 校验：`r1·m12` = `F1·mF`。
- 切片三在真实浏览器里对同一视图施加的同类变异（去上游过滤、去类型过滤、去并行域过滤、去办理节点闸、去并行闸、漂移也认模板）见 §6.8，标号另起。

## 5. 测试计数与 CI

数字只抄自门审报告、实现说明和只读快照；没有来源的写「未核」或「待 CI」。

### 5.1 新 spec 与相邻 spec

| 对象 | 运行 | 结果 | 出处 |
|---|---|---|---|
| `f6cd25bd84` 视图（门审 r1 在 `78be3bf3dc` 上复现） | 新 spec + approval-member-bar-operation-policy + approval-detail-instance-consistency + approval-detail-can-decide-current-node | 4 files / 89 tests passed（新 spec 14） | 实现说明；门审 r1 |
| `038534f003` | 同上四个文件 | 4 files / 96 tests passed（新 spec 21、member-bar 27、instance-consistency 39、can-decide 9） | 实现说明；门审 r2 复现 |
| `35190bee03`（切片二） | 新 spec（27 例）+ can-decide + instance-consistency + approval-detail-record-table | 4 files / 115 tests passed | 切片二门审 r1、r2 |

### 5.2 approval-web-guard 的 vitest 步骤

| 对象 | 步骤 | 结果 |
|---|---|---|
| `ff966786a5`（实现方） | FWB 步骤 | 2 files / 21 tests passed |
| `ff966786a5`（实现方） | targeted 步骤（含 approval-e2e-permissions 的 Return 测试与 approval-e2e-lifecycle） | 114 files / 2372 tests passed |
| `78be3bf3dc`（门审 r1） | targeted 运行行原样 | exit 0，114 files / 2372 tests passed；JSON reporter 回放里新 spec 14/14 |
| `038534f003`（实现方；targeted 行与工作流的 `run:` 核对逐字相同） | Canvas V2 canaries / FWB / targeted | 31 files / 557 passed；2 files / 21 passed；114 files / 2379 passed（2372 加 7 个新测试） |

### 5.3 覆盖守卫与清单

| 对象 | 运行 | 结果 |
|---|---|---|
| `ff966786a5` 与 `78be3bf3dc`（实现方，PyYAML 在 PATH 上） | 五个后端守卫：`approval-ci-coverage-enumeration`、`required-web-lane-token-manifest-guard`、`required-web-lane-registration-shape`、`network-unavailable-copy-ci-wiring`、`stock-prep-web-ci-coverage-enumeration` | 5 files / 474 tests passed |
| `ff966786a5` | `run-required-web-tests-shape` | 5/5 passed |
| `78be3bf3dc`（实现方） | `plugin-tests.yml` 调用的两个车道读取器：`multitable-exact-anchor-ci-wiring.test.mjs`、`elearning-media-ci-wiring.test.mjs` | 43/43；15/15（PyYAML 在 PATH 上；不在时 elearning 在基线与 head 上都报同样 4 个 `PYYAML_MISSING` 失败，是环境原因，不是本改动） |
| `78be3bf3dc`（门审 r1） | `approval-ci-coverage-enumeration` + `required-web-lane-token-manifest-guard` + `required-web-lane-registration-shape` | 3 files / 462 tests passed |
| `038534f003`（实现方） | 同上三个守卫 | 3 files / 462 tests passed |
| `038534f003`（门审 r2） | `tests/unit/approval-ci-coverage-enumeration.test.ts` | 1 file / 399 tests passed |
| `038534f003` | `scripts/ops/required-web-lane-token-manifest.mjs` | MANIFEST MATCHES（20 条门控调用，554 个 token） |
| 门审 r2 时的 main（`52aae89fc7`）与 head 的合并树 | 同一生成器，在解出的树上跑 | MANIFEST MATCHES（20 条门控调用，555 个 token） |
| 定稿时（2026-10-10）`f28b76dcd6`、`35190bee03`，以及二者各自与 `b5a9bb07e7` 的 `git merge-tree` 合并树 | 同一生成器，本机以 node 对 `git archive` 解出的树跑 | 两个 head 单独各 554 个 token MATCHES；两个合并树各 556 个 token MATCHES（main 单独 555：自门审 r2 以来 main 又加了一个备料 token）；并集成立 |

### 5.4 全量车道与类型检查

| 对象 | 运行 | 结果 |
|---|---|---|
| `ff966786a5`（实现方） | 全量 `apps/web/scripts/run-required-web-tests.sh` | exit 0；20 条门控调用；628 个测试文件；最后的 `exec` 块 524/524 |
| `78be3bf3dc`（门审 r1） | 同上 | exit 0；20 条门控调用；628 个测试文件 / 11162 个测试；最后的 `exec` 块 524 个文件；没有失败摘要 |
| `038534f003` | 同上 | **没有跑**。实现方的理由：登记未变（同一 spec 文件、同一 token，车道脚本、`.tokens`、工作流本轮都没改）；门审 r2 也没跑，交托管 CI（`web-tests` 在 `f28b76dcd6` 与 `35190bee03` 上都 pass，§5.5、§8.6） |
| `ff966786a5` | apps/web 的 `vue-tsc -b` | exit 0，零 `error TS` |
| `038534f003` | web 包的 `type-check` 脚本（`vue-tsc -b` 加两个验证配置，堆 4 GB，与 CI 相同） | exit 0，零 `error TS` |

### 5.5 托管 CI：#6291，head `f28b76dcd6`

只读的 `gh pr checks` / `gh pr view`。PR 是 Draft、OPEN，目标分支 main，head `f28b76dcd6`。

- **2026-10-09 23:27（+0800）：13 项必需检查全部 pass。** 全部检查（含非必需）：24 项 pass、1 项 skipping（`Strict E2E with Enhanced Gates`）。更早的一次快照（23:02 至 23:04）里，`test (20.x)` 还是 pending，其余 12 项必需检查已是 pass。
- **2026-10-10 01:55（+0800）重读：不变**（24 pass / 1 skipping；13 项必需检查 pass），GitHub 报 `mergeable: MERGEABLE`、`mergeStateStatus: CLEAN`。

| 必需检查（共 13 项） | 状态 |
|---|---|
| Approval browser verify (chromium) | pass |
| attendance-web-guard | pass |
| contracts (dashboard) | pass |
| contracts (openapi) | pass |
| contracts (strict) | pass |
| integration-guard | pass |
| observation-kit contract (read-only SQL census + runbook gating) | pass |
| ssh host-key pin contract (fail-closed known_hosts) | pass |
| stock-prep PowerShell 5.1 acceptance | pass |
| test (20.x) | pass |
| pr-validate | pass |
| recovery-schema-drift | pass |
| web-tests | pass |

- `Approval browser verify (chromium)` 在夹具重新落座之前（`038534f003`）是红的，在 `f28b76dcd6` 上为 pass（§6）。
- 合并前须按最终 head 重读；实现方和门审都没有在本地跑修复轮之后的完整车道，所以全量车道在 `038534f003` 及之后的结论完全来自托管 CI。
- 合并预览（定稿时本机只读重算，对 main `b5a9bb07e7`）：`git merge-tree` 干净；与 main 重叠的文件只有车道脚本和 `.tokens`（main 侧自 merge-base 以来 +25 / +2，都是备料 token），合并树的车道清单 MATCHES、556 个 token（§5.3）。合并本身待 owner 点名；main 若再前进，预览须重跑。

## 6. 浏览器验证

### 6.1 这条验证是什么

- 必需检查 `Approval browser verify (chromium)`（工作流 `Approval Browser Verify`；它的 `pull_request` 触发没有基线限制，所以叠在分支上的 PR 也跑）。
- 切片一涉及的 Playwright 规格是既有的 `apps/web/verification/approval-member-action-dialog.spec.ts`，夹具 `apps/web/verification/approval-member-action-dialog-harness.ts`（同名 `.html` 为入口）。切片三新增 `approval-return-candidates.spec.ts` 与同名 harness（§6.6）。
- 夹具挂载真实的 `ApprovalDetailView`（生产的 Router、Pinia、Element Plus 对话框、焦点陷阱与响应式 composable），只在开发 API 把 store 填好之后改写确定性的夹具状态；对话框的渲染与交互仍是生产代码。
- member-action 规格共 8 个用例（读规格文件所得）：桌面与平板两个视口各一个「依次点开各个动词的对话框」用例，其中包括 `approval-return-button` 打开的「退回审批」对话框，需要必填输入时在「选择退回目标节点」里选第一个可用选项，再验证焦点陷阱与可达性，最后按 Esc 关闭；三个移动端用例（只保留支持的动作、驳回必填理由、评论对话框焦点）；一个过程证据上传器用例；桌面与平板各一个后加签对话框用例。该规格**不点退回的确认**，所以没有 409 往返。移动端用例断言「退回」按钮是隐藏的。

### 6.2 红的根因

- 夹具把游标和全部座位钉在开发态模板图（start → approval_1 → approval_2 → end）的第一个审批节点 `approval_1`。
- 按服务端规则，第一个审批节点的上游没有审批节点；切片一的过滤因此在那里正确地不再显示「退回」，验证找不到触发器，必需检查变红。此前它能过，靠的恰是服务端会 409 的候选。
- 具体是哪个用例红（只读 CI 日志核对，`038534f003` 上的那次运行）：`P5-C member-action dialogs use the real accessible grammar` 的桌面与平板两个视口用例，各失败一次再重试失败一次；断言是 `expect(getByTestId('approval-return-button')).toBeVisible()`，报 element(s) not found。移动端、上传器、后加签用例都通过；其余 approval 规格也都通过。

### 6.3 修法（`f28b76dcd6`）

- 只改夹具：`currentNodeKey` 与三处座位的 `nodeKey` 从 `approval_1` 改为 `approval_2`；夹具头部的注释写明了原因；合法的退回目标是 `approval_1`。
- 视图和 spec 不变（`git diff --stat 038534f003 f28b76dcd6` 只有夹具一个文件，+10/−4）。
- 教训：旧夹具里「退回可见」依赖服务端会拒绝的候选；应当重新落座夹具，而不是削弱过滤。

### 6.4 结果

| 运行 | 结果 | 出处 |
|---|---|---|
| 另一台机器上同一 Playwright 规格（chromium） | 8/8 通过 | PR #6291 的评论与私有记录；8 项的构成见 §6.1；该次运行的日志是私有记录 |
| 托管 CI 的 `Approval browser verify (chromium)`，head `f28b76dcd6` | pass（2026-10-09 22:13 +0800 起的运行） | 只读 `gh run list` / `gh pr checks` |
| 切片三各轮（另一台机器）重跑同一规格 | 每轮 8/8（§6.9） | 切片三实现说明与三轮门审 |

### 6.5 这条验证覆盖什么、不覆盖什么

- 覆盖：游标在合法位置（`approval_2`）时「退回」按钮出现、对话框能打开、能选到第一个可用的目标，以及对话框的焦点陷阱与可达性。
- 不覆盖：候选只含合法节点；办理节点与并行区域内没有「退回」；服务端列表优先于本地图；点确认之后服务端的回答（该规格不点确认）。前三项由切片三补上（§6.6 至 §6.10）；最后一项仍无覆盖（§7）。

### 6.6 切片三：真实浏览器里的候选规则（Draft #6294）

规格 `apps/web/verification/approval-return-candidates.spec.ts`，夹具 `approval-return-candidates-harness.ts` / `.html`。夹具照 member-action 的方式在同一条详情路由上挂真视图、钉 zh-CN，等开发态 API 把详情、历史、模板、钉住版本都加载完之后，改写 `store.activeApproval` / `store.history` 与模板 store 的 `activeTemplate` + `activeVersion`；`?scenario=` 选夹具，`&template=drifted` 让模板出现更新版本且钉住版本不可加载。夹具的图是 start → approval_1 → cc_1 → handler_1 → parallel_1 ⇉ {approval_p1, approval_p2} ⇉ join_1（cc 节点）→ approval_2 → approval_3 → end，节点名全部换成开发态模板里没有的名字，下拉里出现这些名字即证明视图按 harness 的图起名。规格每个场景一条用例，桌面 1440×960，读 Element Plus 下拉里真实渲染出的选项，按「精确、有序」断言；隐藏场景用 `toHaveCount(0)`；每个场景先断言「转交」按钮可见（与退回共用 `canDecide` 与桌面布局门）作为正控。

| 场景（`?scenario=`） | 夹具 | 预期 | 钉住的生产规则 |
|---|---|---|---|
| `server-list` | #6293 详情读：游标 approval_2，观看者席位在 approval_2，`returnableNodeKeys: ['approval_1']` | 退回可见；选项恰为 approval_1 的名字 | DTO 带数组时它就是候选列表 |
| `server-empty`（`&template=drifted`） | #6293 在办理节点游标的**动作响应**：观看者在 handler_1 发评论后的响应，无 `currentNodeType`、`returnableNodeKeys: []`；历史含到 cc_1 的第一轮与那条评论行；模板漂移 | 无退回按钮 | 无图时旧列表本会端上 cc_1 与 approval_1，只有 `[]` 能藏住按钮 |
| `server-list-wins` | #6293 详情读，配管理员前进跳转的历史（发起 + jump 行，jump 行线上无 `metadata`），历史里从未出现 approval_1 | 退回可见；选项恰为 approval_1 | 图在时服务端列表压过零候选的镜像 |
| `client-mirror` | 删掉 `returnableNodeKeys`，即 #6293 之前的详情读 | 选项恰为 approval_1 | 镜像的四条过滤（类型、并行域、上游、图内）与游标排除：cc_1 / handler_1 / approval_p1 / approval_3 / approval_2 全被删 |
| `handler-cursor` | #6293 之前的详情读：游标、`currentNodeType: 'handler'`、席位都在 handler_1；第一轮历史（含上游的 approval_1） | 无退回按钮 | 游标在办理节点即隐藏（DTO 类型与自己的图一致） |
| `parallel-state` | 动作响应：游标在 parallel_1，`currentNodeKeys` 两条，无 `currentNodeType`；历史到观看者在 handler_1 办理为止 | 无退回按钮；并行中徽标 | 并行门 |
| `submit` | server-list + 把 store 的 `executeAction` 换成记录器（不发 HTTP） | 选中选项、确认后对话框关闭、成功提示；记录的请求恰为 `{ action: 'return', targetNodeKey: 'approval_1' }` | 发出去的是选项的 KEY，`submitReturn` 的载荷形状 |
| `server-list&template=drifted` | #6293 详情读 + 模板漂移 | 选项恰为 approval_1 | 无图时服务端列表照样决定 |
| `client-mirror&template=drifted` | 旧服务端 + 模板漂移 | 选项恰为旧列表六项，按给定的 `/history` 顺序 | 漂移即无图，回到过滤前的旧列表（切片一漂移规则 (a) 的代价） |
| `handler-cursor&template=drifted` | handler-cursor + 模板漂移 | 无退回按钮 | 无图时 DTO 的 `currentNodeType` 单独隐藏退回 |

登记点全是通配（工作流分类器 `apps/web/verification/approval-*`、Playwright 配置 `testMatch '**/approval-*.spec.ts'`、tsconfig 的 harness 与 spec 通配、按盘枚举的 wiring 守卫与覆盖枚举守卫），新文件自动被覆盖；按惯例补的只有两处文件头注释与截图上传的 `rc-*.png` 通配。相对 `35190bee03` 共 5 个文件（+703/−0），没有 `src/` 下的文件。

### 6.7 切片三的三轮门审

| 轮次 | 对象 | 判定 | 发现与处置 |
|---|---|---|---|
| G3r1 | `d8fb436e55`（3 个提交，5 文件 +550） | NEEDS-FIX 0 P1 / 1 P2 / 2 P3 / 3 NIT | **P2-1** `handler-cursor` 夹具线上不可达：DTO 说办理节点，而身份成立的自图在游标 approval_2 处是审批节点，线上两者永远一致（详情读的 `currentNodeType` 由冻结图在存储游标处解析）。修法：游标、类型、席位都搬到 handler_1，历史改成到达该游标的第一轮；另加 `handler-cursor&template=drifted`。**P3-1** 去掉服务端列表的变异下 `server-list` 与 `submit` 仍绿（镜像恰好同值），浏览器里没有「图在、服务端列表与镜像不同、服务端赢」的用例。修法：加 `server-list-wins`，但不用门审示例里的 `approval_p1`（walker 跳过并行分支，真服务端不会列它），改用管理员前跳的真实分歧。**P3-2** `parallel-state` 的历史与 DTO 叙事不自洽。修法：历史截到观看者在 handler_1 的办理为止，席位改为两条分支各一。**NIT-1** trailer 署 Opus 5.5。**NIT-2** 历史行 metadata 比写入路径薄——实现方反驳并反向修正：`/history` 只投影五个单键（`attachmentIds`、`cancellationOutcome`、`cancelRoundCloseReason`、`nodeKey`、`autoApproved`），其他键从不到客户端，夹具按线上形状去掉了多余键，并补上同事务写的 cc@join_1 与系统 `sign` 行。**NIT-3** server-list 夹具缺 `canDecideCurrentNode` / `canAttachProcessEvidence`——补上，取 true / true（席位在可决节点） |
| G3r2 | `15a5e5dbec`（6 个提交，5 文件 +655） | NEEDS-FIX 0 P1 / 1 P2 / 1 P3 / 2 NIT | r1 的 P2-1、P3-1、P3-2 都核实关闭（m6 两条红、m1 三条红、并行历史自洽）。**P2-1** `server-empty` 夹具线上不可达：身份成立的图上，游标 approval_2 的详情读永远带 `['approval_1']`，服务端发 `[]` 的每一种状态（办理节点游标、并行态、轨迹首个审批节点）下镜像也为空，所以「`[]` 压过会给出候选的镜像」只在无图时成立，而那条形状车道里零覆盖；「`[]` 当缺省」的变异只靠这条不可能的夹具变红。修法：改成 #6293 在办理节点游标的动作响应配模板漂移。**P3-1** 办理节点的两条用例用「通过」按钮做正控，而服务端在办理节点拒绝通过（视图只在退回门读 `currentNodeType`，是既有缝隙）。修法：正控只留「转交」。**NIT-1** trailer。**NIT-2** 「每个夹具都是服务端可达状态」的声明对 `server-empty` 不成立 |
| G3r3 | `91e48ae298`（先合并 `35190bee03`，再两个测试提交） | **APPROVE** 0 P1 / 0 P2 / 0 P3 / 2 NIT | r2 的 P2-1 按修法闭合并被重新证实：可达链逐环读代码核过（观看者在 handler_1 有席位、评论动词在办理节点放行、评论分支写带 `nodeKey` 的记录并返回 `getApproval`、产品 `getApproval` 读冻结图、helper 规则 (b) 给 `[]`、构造器把空数组原样展开、动作响应无 `currentNodeType` 且无 `currentNodeKeys`、前端把响应发布进详情槽后只重拉历史、漂移下旧列表 = cc_1 + approval_1）；`G3r3·m2` 唯一红的就是它。P3-1 闭合（spec 全文零处 `approval-approve-button`，正控 = 每个场景的转交断言）。NIT-2 两处措辞改为「是某个服务端能处的状态，并写明是哪个服务端」，对全部夹具成立。合并只带来基线改动：`git diff --name-status 35190bee03 91e48ae298` = 5 文件；合并提交对这 5 个文件零改动；两个新提交只碰 harness.ts 与 spec.ts（+70/−22）；diff 与提交信息的主机名 / 局域网 IP / 账号扫描无命中。剩 **NIT-1** trailer（沿用，交 owner）与 **NIT-2** 隐藏按钮的三条用例靠就绪标记与转交按钮证明夹具在场，没有场景专属的正信号（可选加固；m1 / m2 / m6 都让它们变红，所以不是真空绿） |

三轮都是独立的对抗审阅；每轮都在另一台机器自己的分离工作树里全新安装（`pnpm install --frozen-lockfile --prefer-offline` rc=0），`CI=1`、`--retries=0`、`--workers=1`，每批 Playwright 前确认车道端口无人监听；变异用字节副本还原（没有 `git checkout --`），每条结束 `cmp` 一致，工作树用完 `git worktree remove --force`。

### 6.8 切片三的变异回放（`ApprovalDetailView.vue`；每次精确单锚替换，锚点在文件里恰好出现一次）

| 标号 | 变异 | G3r1（8 场景） | G3r2（10 场景） | G3r3（10 场景） |
|---|---|---|---|---|
| m1 | 忽略服务端列表（`if (false && Array.isArray(serverKeys))`） | 2 红：server-empty、drifted server-list；**server-list、submit 绿**（P3-1） | 3 红：server-empty、server-list-wins、drifted server-list | 3 红：server-empty (drifted)、server-list-wins、drifted server-list |
| m2 | `[]` 当缺省（`&& serverKeys.length > 0`） | 1 红：server-empty | 1 红：server-empty（不可达夹具，P2-1） | 1 红：server-empty (drifted)，按钮出现——**线上可达的夹具** |
| m3 | 去上游过滤（`.filter(() => true)`） | 1 红：client-mirror 多出 approval_3 | 1 红：同左 | 1 红：client-mirror |
| m4 | 去类型过滤（只留并行域过滤） | 1 红：client-mirror 多出 handler_1、cc_1 | 1 红：client-mirror 多出 join_1、handler_1、cc_1 | 未重跑（r2 已跑，本轮两个提交没碰该分支） |
| m5 | 去并行域过滤（只留类型过滤） | 1 红：client-mirror 多出 approval_p1 | 1 红：同左 | 未重跑（同上） |
| m6 | 去办理节点闸（`if (false) return []`） | 1 红：handler-cursor | 2 红：handler-cursor、handler-cursor & drifted | 2 红：同左；server-empty 仍绿（服务端分支在办理节点闸之前返回） |
| m7 | 去并行闸（`if (false) return []`） | 1 红：parallel-state | 1 红：parallel-state | 1 红：parallel-state |
| m8 | 漂移也认模板（`latestVersionId === pinnedVersionId` → `true`） | 1 红：drifted client-mirror 少 4 项 | 1 红：drifted client-mirror 少 5 项 | 未重跑 |
| m9 | 去游标排除（删 `nk !== currentNodeKey &&`） | — | 1 红：drifted client-mirror 多出 approval_2 | 未重跑 |

三轮都没有存活变异。实现方在每轮修复后也跑了同一组（第 0 轮 7 个，修复轮 r1 8 个，修复轮 r3 9 个），红集合与门审逐条一致；修复轮 r3 另做了一个临时探针（跑完即删）：m2 之下打开 `server-empty&template=drifted` 的退回对话框，下拉恰为 cc_1 与 approval_1 两项。

### 6.9 切片三的运行记录与 CI

| 对象 | 运行 | 结果 | 出处 |
|---|---|---|---|
| `9d0561a6cc` | 新 spec；既有 member-action 规格；`type-check:verification-approval` | 8 passed；8 passed；rc=0 | 实现方 |
| `d8fb436e55` | 新 spec + member-action 同跑；新 spec `--repeat-each=3`；web 包 `type-check`；wiring 守卫第 2、3 条；覆盖枚举守卫；`delete-fallback.spec.ts` | 16 passed；24 passed；rc=0；pass（第 1 条分类器在临时仓库里执行 `git config user.*`，按规则未跑，改为离线求值同一组模式）；402/402（第一次因另一台机器负载高、子进程超时而加载失败，第二次通过）；57/57 | 实现方 |
| `d8fb436e55` | 新 spec；member-action；`playwright --list`；web `type-check` | 8 passed；8 passed；新 spec 8 条 / 车道 62 tests 9 files；rc=0 | G3r1 |
| `9881f6061c` / `288e728279` / `15a5e5dbec` | 新 spec（三个提交各跑） | 9 passed；10 passed；10 passed；`288e728279` 上 member-action 8 passed、`type-check` rc=0、`--list` 10 条 / 64 tests 9 files | 实现方 |
| `15a5e5dbec` | 新 spec；member-action；`--list`；web `type-check` | 10 passed；8 passed；10 条 / 64 tests 9 files；rc=0，`error TS` 0 | G3r2 |
| `db80a6b013` / `91e48ae298` | 新 spec（两个提交各跑）；`91e48ae298` 上 member-action、web `type-check`、`--list` | 10 passed；10 passed；8 passed；rc=0；64 tests 9 files | 实现方 |
| `91e48ae298` | 新 spec；member-action；web `type-check`；`--list` | 10 passed；8 passed；rc=0，`error TS` 0；新 spec 10 条 / 64 tests 9 files | G3r3 |
| 托管 CI，head `d8fb436e55` | `Approval browser verify (chromium)` | success（2026-10-09 23:42 +0800 起的运行） | 只读 `gh run list` |
| 托管 CI，head `91e48ae298` | `Approval browser verify (chromium)` | success（2026-10-10 01:47 +0800 起的运行）；日志里新 spec 的 10 条用例逐条通过，整条车道 64 passed | 只读 `gh run view` 日志 |
| 托管 CI，head `91e48ae298`，2026-10-10 01:55 +0800 | 全部检查 | 13 项 pass（叠在分支上的 PR 能触发的全部，含 `Approval browser verify (chromium)`、`attendance-web-guard`、`integration-guard`、`pr-validate`、`recovery-schema-drift` 等）；GitHub 报该分支没有必需检查（基线不是 main），`mergeStateStatus: CLEAN` | 只读 `gh pr checks` / `gh pr view` |

6 项只在 main 基线上触发的必需检查（`web-tests`、`test (20.x)`、`stock-prep PowerShell 5.1 acceptance`、三项 `contracts`）要等 #6293 合入 main、#6294 改基线之后再跑（§8.6 的原因分析同样适用）。

### 6.10 切片三覆盖什么、不覆盖什么

- 覆盖：服务端列表原样展示（含管理员前跳后历史里从未出现的轨迹节点）；`[]` 隐藏按钮且是线上可达的形状；缺省回落到镜像；镜像的四条过滤与游标排除；办理节点闸（DTO 类型来自详情读，或无图时单凭 DTO 类型）；并行闸；漂移下的旧列表与顺序；提交的载荷形状。
- 不覆盖：服务端列表**少于**镜像的情形（条件节点：镜像接受每个分支，walker 只走一支）——需要带条件节点的图，没有加，由 helper 的条件分支单测覆盖；`parallel-state` 同时触发两条理由（前沿非空、按自图游标类型为 parallel），浏览器分不出是哪一条；动作响应形状下「按自图推出办理节点」（单测 T5b）；合并带来的两条服务端规则（取消轮次实例、`allowReturn: false`）没有浏览器用例，它们只决定服务端发不发 `[]`；真服务端、真 HTTP 409（开发态 mock API + store 改写，服务端列表的值是按 walker 代码推得的夹具值）；模板加载完成之前的瞬时状态；移动端（member-action 规格已钉住隐藏）。
- harness 会话带管理员角色，而漂移段落描述的是普通成员的 store 状态；退回路径既不读角色也不读版本端点（只读 store 槽与 DTO），三轮门审都接受这个建模。

## 7. 未验证项

| 项 | 现状 |
|---|---|
| 生产或演示机上的真机验收 | 没做（未核）。R63 还没有打包点，三张 PR 都未合并、未上演示机；R63 清单（私有记录）里这一项仍写着「浏览器与真实 HTTP 无人跑过」，其中「浏览器」一半现已由 #6294 在真实 Chromium（开发态 mock API）里覆盖，「真实 HTTP」一半仍未 |
| 真实 HTTP 的 409 往返 | 从来没人跑过（未核）：审阅回复写明实际 HTTP 409 未实跑；切片一门审 r1 用的是真实执行器探针，不是 HTTP；两条 Playwright 规格都不向真服务端提交（member-action 不点确认，切片三的 `submit` 用记录器） |
| 对话框里错误文案的实际呈现（服务端英文原句、对话框不关闭） | 按代码核对（`submitReturn` → `memberActionFailure`，`approvalRequestError` 逐字带服务端 message），没有在浏览器里看过（未核：没有带失败响应的浏览器场景） |
| #6293 的终态 CI | 定稿快照见 §8.6（13 项必需检查全部 pass）；合并前须按最终 head 重读 |
| #6294 的 6 项 main 基线必需检查 | 待 #6293 合入、改基线后再跑（待 CI） |
| `038534f003` 及之后的完整 `run-required-web-tests.sh` | 实现方和门审 r2 都没有在本地跑；结论来自托管 CI（`web-tests` 在 `f28b76dcd6`、`35190bee03` 上都 pass） |
| 夹具那一个文件 | `f28b76dcd6` 的夹具改动在门审 r2 之后，没有被任何门审看过；由另一台机器的 8/8（含切片三每轮重跑）和托管 CI 覆盖 |
| 漂移默认 (a) 在真实模板、真实普通成员账号上的覆盖面 | 只按构造验证（T13、T13b；切片三的漂移场景也是 store 改写，会话是管理员角色）；没有在真有草稿的模板、真成员账号上观察过（未核） |
| 模板加载完成之前按钮先闪一下 | 记录在视图注释里；没有验证（未核：两个 harness 都等加载落定后才改写夹具） |
| 取消轮次实例上退回的可达性（该模板至少两个审批节点） | 切片二门审 r1 记为 UNVERIFIED，r2 未改判（未核）；helper 的镜像不依赖它 |
| 条件分支不再命中的节点；管理员前进跳转跳过的节点（切片一门审 r2 P3-2） | 前端没有门可测；服务端列表存在时关闭：后者由单测 TS3b 与切片三 `server-list-wins` 覆盖，前者只有 helper 单测 |
| 动作响应之后办理节点游标重新提供「退回」（切片一门审 r2 P3-3） | 服务端列表存在时关闭：切片三 `server-empty` 场景在真实浏览器里钉住 |
| 后端切片的真实库（DB）集成测试与完整车道 | 实现方与门审都没有在本地跑，留给 CI；#6293 改基线到 main 后 13 项必需检查都已跑并 pass（§8.6） |
| 审阅回复的复现 | 发生在真实 Vue 组件加 mock 数据（jsdom）里，是组件级复现；本线的 jsdom spec 同样是组件级验证（挂载真实视图，store 与模板 store 被 mock）；切片三把它提升到真实 Chromium + 生产 Router / Pinia，但仍是 mock API |

## 8. 后端切片（#6293）的验证

本节里的「门审 r1」「门审 r2」指切片二的门审，与 §2、§3 的切片一门审无关。标号前缀：`S2·`（切片二实现方在门审前的探针）、`G2r1·`（切片二门审 r1）、`S2F1·`（切片二修复轮 r1 的实现方探针）、`G2r2·`（切片二门审 r2）。

### 8.1 状态

- #6293：Draft，OPEN，head `35190bee03`（在 `f28b76dcd6` 之上共 7 个提交）。开 PR 时（2026-10-09 22:50 +0800）基线是 #6291 的分支，head `5fdd9036c8`；修复轮的三个提交于 23:47 +0800 前后推上；23:48 +0800 基线改到 main；2026-10-10 01:24 +0800 关闭再重开（§8.6）。
- 门审 r1（对 `5fdd9036c8`）：CHANGES-REQUESTED，0 P1 / 1 P2 / 1 P3 / 3 NIT（§8.2 至 §8.4）。
- 修复轮 r1：head `35190bee03`，§8.5。
- 门审 r2（对 `35190bee03`）：**APPROVE**，0 P1 / 0 P2 / 0 P3 / 2 NIT，另沿用 r1 的 NIT-2、NIT-3（§8.7）。
- 判据（收口目标文件）：门审 0 P1 / 0 P2；实现者与审阅者不是同一方；推送与开 Draft 之后 CI 全绿——三条都已满足（§8.6）。

### 8.2 门审 r1：发现与处置

对象 `5fdd9036c8`（在 `f28b76dcd6` 之上的 4 个提交）。审阅时 `origin/main` 是 `60fdace92d`；`git diff f28b76dcd6 origin/main` 在 helper 所镜像的五个文件（`ApprovalProductService.ts`、`ApprovalGraphExecutor.ts`、`approval-seat-authorization.ts`、`ApprovalBridgeService.ts`、`ApprovalConditionFormula.ts`）上为空，即基线与 main 在这些文件上逐字节相同。方法：对工作树和 `origin/main` 只读；所有构建与测试都在另一台机器的独立 detached 工作树里、在 `5fdd9036c8` 上跑（全新安装，退出码 0），顺序、定向，没有跑完整车道（交 CI）；工作树用完即删。

判定：CHANGES-REQUESTED。helper 对它点名的三条规则同源，错误策略在读代码和变异下成立，前端原样优先服务端列表，SDK dist 与重新生成逐字节相同，所有合同检查和类型检查都绿。阻止 APPROVE 的两件事：两条载体的调用点接线没有被测试钉住（弄坏任何一个，所有测试和 CI 仍绿，这是「未被测试的守卫」的 P2），以及字段合同对两个与查看者无关的闸门拒绝过度声称（前端有缓解，所以是 P3）。

| 发现 | 要点 | 修复轮 r1 的处置 | 门审 r2 复核 |
|---|---|---|---|
| P2-1 两条载体的调用点接线没有被钉住，弄坏它们全部测试仍绿 | 位置：详情读的 `getApproval` 传 `{ withReturnableNodeKeys: true }`，产品 `getApproval` 把 `frozenRuntimeGraph` 传给 `toUnifiedApprovalDTO`。证据：除新增的两个单测文件外，该字段不出现在任何测试、夹具或脚本里；`approvals-bridge-routes.test.ts` 从不 mock `approval_published_definitions`，详情路由在那里没有图，字段按构造缺省；载体测试直接调用导出的构造函数，证明的是接缝，不是 HTTP 路径。变异：`G2r1·m9`（详情读的选项改成 `{}`）35/35 仍通过；`G2r1·m10`（产品 `getApproval` 传 `null`）195/195 仍通过。失败场景：任何一次对这两个冗长、常改的方法的重构丢掉选项或实参，生产就不再发该字段，前端悄悄回落到切片一的客户端镜像，而没有任何红。建议：(a) 在 bridge 路由测试里 mock 冻结图，断言详情 body 的字段，并断言列表行没有该键；(b) 在 product-service 测试里让 `SELECT runtime_graph` 返回图，断言动作响应上的字段；重放两个变异，须变红 | 新增 bridge 路由的 HTTP 用例（待办详情读，游标在第三个审批节点：`returnableNodeKeys` 为 `['approval_1','approval_2']`，同时有 `currentNodeType`；列表里同一行有 `currentNodeType` 而**没有** `returnableNodeKeys` 键；mock 连接池新路由三条语句：`loadRuntimeGraphs` 的那条、Lock-10 S1 准入查询、取消轮次投影读）与产品 `getApproval` 用例（字段在 DTO 上，且冻结图只读一次）。重放：`S2F1·m9` 1 红 / 39 绿，`S2F1·m10` 1 红 / 199 绿 | **关闭**。`G2r2·m9` → 1 红 / 29 绿，`G2r2·m10` → 1 红 / 189 绿，各恰为新用例 |
| P3-1 同源偏差：两个与查看者无关的拒绝没有镜像，字段合同过度声称 | Lock-5 节点操作策略（`allowReturn` 显式为 false 时，先落 policy_denied 记录并提交，再抛 409 `APPROVAL_NODE_OPERATION_DISABLED`，在 return 分支之前）；取消轮次出口（`workflow_key = 'approval.cancel-round'` 的实例直接拒绝 return）。helper 没有它们，所以在这样的节点或实例上，服务端会发出**非空**的列表，其中每个目标都 409。评 P3 的理由：唯一的消费者 `ApprovalDetailView.vue` 被本切片之外的谓词保护：按钮的 `v-if` 要求 `allowReturn`（来自按查看者作用域的 `nodeOperations`，两条载体都发）与 `canDecide`（排除取消轮次），没有发现会先提供「退回」再被拒的前端路径。缺陷在字段对其他 SDK 消费者的**声明语义**，以及说明里「穷尽镜像」的说法。取消轮次的可达性（该模板至少两个审批节点）未核；节点策略这一半在任何作者设了 `allowReturn: false` 的模板上都可达。建议：优先「镜像」，即在办理节点规则之后加节点操作策略的检查，并经新的 `workflowKey` 输入加取消轮次的谓词，各配一个单测并作为变异重放；备选：把四处描述收窄为「必要而不充分」 | 采纳「镜像」：helper 加取消轮次一项（图检查之前）与节点操作策略一项（游标节点，同一张 `ACTION_POLICY_KEYS` 表），两个构造传 `workflowKey`；四处字段描述改为列出五项，并写明不含按查看者的席位检查。单测与载体测试各增。重放：各去掉一项各得 3 红（`S2F1·mA`、`S2F1·mC`）。取消轮次可达性仍未核，镜像不依赖它 | **关闭**（门审推荐的镜像）。`G2r2·mA`、`G2r2·mC` 各 3 红；两项与闸门同源逐项核过（同一谓词出自同一个零引入的叶模块；同一张表、同一个 `isOperationAllowedAtNode`、同一张冻结图、同一游标、缺省等于允许） |
| NIT-1 载体层「读失败不抛」只靠读代码 | 载体测试没有覆盖畸形图通过任一构造；读代码可见 helper 的 `try` 之外没有会抛的调用，`G2r1·m6`（重新抛出）4 红证明 helper 层。建议每个构造加一个无 start 节点的图用例，断言字段键不存在 | 采纳：两个构造各一个用例 | **关闭**。`G2r2·m6` → 6 红（4 个 helper 用例 + 两个构造的畸形图用例） |
| NIT-2 没有重做 `asRuntimeGraph` 归一化（已披露，可接受） | 闸门走 `asRuntimeGraph(runtime.runtime_graph)`，helper 走原始存储块；只在「当前归一化器会拒绝的存储图」上有分歧，而那样的实例上每个动词在 dispatch 就都失败。说明 §3 的披露正确，保持 | 不需要动作 | 沿用（已记录） |
| NIT-3 漂移下前端的标签残留 | 服务端列表原样提供，但标签来自成员能加载的模板版本（最新版本）；在较新版本里被重命名或删除的节点显示「节点已变更」占位。服务端提供它是对的；说明里应记录这个标签残留（修法是 `nodeName` 载体，或让成员访问冻结版本，不在本切片） | 记入开发说明 §4.9 | 沿用（已记录） |

门审 r1 的 owner 可见建议：P3-1 用「镜像」而不是收窄描述（它是对已有数据的两行，且让字段的承诺保持字面成立）；列表端点：同意不带；导入环：接受为延迟绑定（`tsc` 的 CommonJS 构建和三种加载顺序都绿）。

### 8.3 门审 r1 的核对表

| 项 | 判定 | 要点 |
|---|---|---|
| A 同源：三条规则 + 执行器构造 | PARTIAL | 办理节点、并行、执行器轨迹三条与闸门同源：存储游标与效力游标在并行区域外相同，区域内由并行规则先答、闸门也拒绝；并行规则经同一个 `readParallelBranchStates`；执行器用 `formSnapshot = toNullableRecord(form_snapshot) \|\| {}` 与相同的 `requesterContext` 推导构造，分配解析器与指定兜底解析器不被 `listVisitedApprovalNodeKeysUntil` 读取。游标缺失：闸门抛错（500），helper 给缺省；自动审批的节点两边都在轨迹上；退回之后游标等于目标，两边一致。**偏差：** 节点操作策略与取消轮次（P3-1）。状态：闸门对非 pending 给 409，helper 给缺省 |
| B 读失败不让读取失败 | PASS（读代码 + helper 测试；NIT-1） | `try` 覆盖每个会抛的调用；`catch` 记 debug 并返回缺省；两个构造只在有定义时展开；`G2r1·m6` → 4 红 |
| C 两条载体都接线；列表成本不变；只在有定义时展开 | 行为 PASS，测试覆盖 FAIL（P2-1） | 详情读传开关，列表不传（列表本来就为脱敏加载了运行时图，没有新成本）；产品 `getApproval` 读图一次并复用于 `nodeOperations`；新增的读取只在无查看者的调用形状，17 个生产调用点都传 `actor.userId`，路由走 bridge |
| D OpenAPI 与 SDK dist 一致；合同检查 | PASS | 重新生成后 `git status --porcelain packages/openapi` 为空；`contracts (openapi)` 用例 rc=0；`strict`、`dashboard` 不读本切片改动的任何东西（门审未重跑，实现方跑过）。前端类型 `string[] \| null` 沿用 `currentNodeKeys` 的惯例，服务端从不发 `null`。（任务文本把 schema 指到另一个路径文件；实际 `UnifiedApprovalDTO` 在 `base.yml`） |
| E 前端原样优先；`[]` 隐藏；缺省回落；变异 | PASS | web 4 files / 115 passed（候选 spec 27/27，含 TS1、TS2、TS2b、TS3、TS3b、TS4）；`G2r1·m1` → 5 红，`G2r1·m2` → 2 红 |
| F 卫生 | PASS | 16 个文件都在声明的范围内；没有 migrations、路由或开关文件；diff 里没有机器名、内网或部署 IP、用户名；四个提交都带 trailer；没有 DTO 键的普查；说明在 head 上逐条核对，除 §1 / §2 的过度声称（P3-1） |

### 8.4 门审 r1 的测试与变异记录（另一台机器，独立工作树，`5fdd9036c8`）

| 运行 | 结果 |
|---|---|
| core-backend 的 `approval-return-targets.test.ts` + `approval-return-targets-carriers.test.ts` | 2 files / 23 passed |
| core-backend 的 `approval-graph-executor.test.ts` + `approvals-bridge-routes.test.ts`（邻居；新导入环的「执行器先加载」顺序） | 2 files / 98 passed |
| core-backend 的 `approval-product-service.test.ts`（连同载体测试，在 `G2r1·m10` 之下；「服务先加载」顺序） | 195 passed |
| web 的 `approval-detail-return-candidates` + `approval-detail-can-decide-current-node` + `approval-detail-instance-consistency` + `approval-detail-record-table` | 4 files / 115 passed |
| `G2r1·m1` 前端忽略服务端列表 | 5 红 |
| `G2r1·m2` 前端把 `[]` 当缺省 | 2 红 |
| `G2r1·m3` helper 去掉 `.slice(0, -1)`（按代码行，不是文档注释） | 8 红 |
| `G2r1·m4` helper 去掉办理节点规则 | 1 红 |
| `G2r1·m5` helper 去掉并行规则 | 1 红 |
| `G2r1·m6` helper 重新抛出 | 4 红（畸形图、未知游标、环、公式错误） |
| `G2r1·m9` 详情读的 `getApproval` 不传开关 | **0 红**（35 绿）：P2-1 |
| `G2r1·m10` 产品 `getApproval` 传 `null` 而不是冻结图 | **0 红**（195 绿）：P2-1 |
| openapi 包 `generate:sdk` 之后的 `git status --porcelain packages/openapi` | 空（dist 逐字节一致） |
| `attendance-run-gate-contract-case.sh openapi` | rc=0 |
| core-backend 的 `tsc --noEmit` | rc=0，零 `error TS` |
| web 包的 `type-check` 脚本 | rc=0，零 `error TS` |

每个变异都用 `git show HEAD:<路径>` 还原，每步之后与最后工作树都是干净的。新增的后端单测文件由 core-backend 的 `test` 脚本（`vitest`）纳入；web spec 已在两个 approval-web-guard 运行清单、车道脚本与 `.tokens` 里（#6291 的登记）。

### 8.5 修复轮 r1：实现方自测

实现方在另一台机器的独立 detached 工作树里跑，在 `5fdd9036c8` 上全新安装（退出码 0）；顺序、定向，没有跑完整车道。

新增的测试（均为纯函数或 mock 连接池，不需要数据库）：helper 单测 +4（共 21）；载体测试 +4（共 10）；bridge 路由测试 +1（共 30）；product-service 测试 +1（共 190）；web spec 不变（27/27；视图没改，只改了类型的文档注释）。

| 对象 | 运行 | 结果 |
|---|---|---|
| 修复轮的源码提交（不含四个 dist 文件，没有单测读它们） | core-backend 的 approval-return-targets、approval-return-targets-carriers、approvals-bridge-routes、approval-product-service | 4 files / 251 passed（21、10、30、190） |
| 同上 | web 的 `approval-detail-return-candidates` | 27 / 27 passed |
| 同上 | openapi 包的 `generate:sdk` | exit 0；恰好四个被跟踪的 dist 文件变化；差异以补丁带回，扫描过机器路径（无），应用后并入 OpenAPI 提交 |
| `35190bee03`（干净检出） | `attendance-run-gate-contract-case.sh openapi`（即 `contracts (openapi)` 的命令） | rc=0；之后工作树干净（重新生成与已提交的 dist 逐字节相同） |
| — | `contracts (strict)`、`contracts (dashboard)` | **没有重跑**：它们不读本轮改动的任何东西，上一个 head 在相同输入上都通过；托管 CI 已在 #6293 上跑过并 pass（§8.6） |
| `35190bee03` | core-backend 的 `tsc --noEmit`；web 包的 `type-check` 脚本 | 均 rc=0，零 `error TS` |

| 标号 | 变异（`35190bee03`） | 变红 |
|---|---|---|
| S2F1·m9 | 详情读的 `getApproval` 传 `{}` 而不是 `{ withReturnableNodeKeys: true }` | 1 红 / 39 绿：恰为「`returnableNodeKeys` 随 `GET /api/approvals/:id` 而来、从不随 `GET /api/approvals` 的行而来」（门审 r1 时是 0 红） |
| S2F1·m10 | 产品 `getApproval` 传 `null` 而不是 `frozenRuntimeGraph` | 1 红 / 199 绿：恰为「`getApproval` 从实例的冻结运行时图发出 `returnableNodeKeys`」（动作响应载体的调用点；门审 r1 时是 0 红） |
| S2F1·mA | 取消轮次一项失效（`if (false && isCancelRoundInstance(…))`） | 3 红 / 28 绿：helper 的取消轮次用例 + 两个载体的「按种类 / 按策略为 `[]`」用例 |
| S2F1·mC | 节点操作策略一项失效（策略键判断改为 `false`） | 3 红 / 28 绿：helper 的 `allowReturn === false` 用例 + 同样两个载体用例 |

实现方记下的夹具限制：bridge 路由测试里的假连接池，其管理员准入（Lock-10 S1）的处理只建模了 `users.role = 'admin'` 一支，没有建模 `is_admin`，抄送记录一支也没建模；这是 mock 连接池的限制，由处理函数按完整谓词文本取键来钉住（谓词改了会落到「未处理 SQL」的抛错，而不是被假连接池悄悄重写）；谓词本身的权威仍是真实库的 S1 测试。

先前（`5fdd9036c8`，门审前）实现方还跑过一轮探针，标号 `S2·m1` 至 `S2·m6`：去掉 `.slice(0, -1)` 红 8 个、去掉办理节点一臂红 1 个、去掉并行判据红 1 个、去掉执行器选项里的 `requesterContext` 红 1 个、bridge 走脱敏回显红 1 个，以及把切片一的视图放到新 spec 下红 5 个（TS1、TS2、TS2b、TS3、TS3b；T1 至 T15 与 TS4 仍绿）。其中 `S2·m1` 第一次探针锚到了 helper 文档注释里的同一段文字，代码没被改动，那次 17/17 的绿是探针缺陷，不是测试缺口；改成按代码行锚定后重跑。

### 8.6 #6293 的托管 CI

- 2026-10-09 23:27（+0800），head `5fdd9036c8`、基线是 #6291 的分支：出现的检查 46 项全部 pass（含 `Approval browser verify (chromium)`），GitHub 报该分支没有必需检查，13 项必需检查里 6 项没有出现：`contracts (dashboard)`、`contracts (openapi)`、`contracts (strict)`、`stock-prep PowerShell 5.1 acceptance`、`test (20.x)`、`web-tests`。
- 为什么没触发（读 `origin/main` 的工作流文件核对）：`web-tests` 所在的工作流与 `test (20.x)`、PowerShell 验收所在的工作流的 `pull_request` 触发写着 `branches: [main, develop]`，三项 `contracts (…)` 所在的工作流写着 `branches: [main]`；叠在分支上的 PR 不满足任何一个。`Approval browser verify` 的 `pull_request` 触发没有分支限制，所以它能跑。
- 处置：23:48（+0800）基线改到 main（GitHub issue 事件 `base_ref_changed`）。改基线不触发 `pull_request`，私有记录里那次只跑了 7 项必需检查；2026-10-10 01:24（+0800）关闭再重开（事件 `closed` / `reopened`，相隔 3 秒），完整的一组检查启动。
- 2026-10-10 01:55（+0800）快照，head `35190bee03`，基线 main：13 项必需检查里 12 项 pass，`test (20.x)` 仍在跑；全部检查 61 项：59 pass / 1 pending / 1 skipping。
- **2026-10-10 02:11（+0800）终态快照：13 项必需检查全部 pass；全部检查 61 pass / 1 skipping。** pass 的必需检查包括 `contracts (openapi)`（dist 漂移检查，本切片最相关的一项）、`contracts (strict)`、`contracts (dashboard)`、`web-tests`、`test (20.x)`、`stock-prep PowerShell 5.1 acceptance`、`Approval browser verify (chromium)`。01:55 时 GitHub 报 `mergeable: MERGEABLE`、`mergeStateStatus: BLOCKED`（Draft，待审查）。合并前须按最终 head 重读。
- 改基线后 PR 的 diff 暂含 #6291 的 6 个提交（PR 页显示 13 个提交、21 个文件）；#6291 合入 main 后缩回本切片的 7 个提交、17 个文件。
- 合并预览（定稿时本机只读重算）：`35190bee03` 合入 `b5a9bb07e7` 的 `git merge-tree` 干净；合并树的车道清单 MATCHES、556 个 token（§5.3）。

### 8.7 门审 r2（对 `35190bee03`）：核对结果

审阅时 `origin/main` 是 `80cb873225`；`git diff f28b76dcd6 origin/main` 在 helper 所镜像的十个文件上为空，基线与 main 的唯一差异是 `ApprovalDetailView.vue`（切片一自己的改动）。方法同 r1（本机只读；另一台机器独立 detached 工作树，`35190bee03`，全新安装 rc=0；每个变异 `perl -pi` 施加、`git diff --stat` 确认恰好 1 个文件、`git show HEAD:<path>` 还原、porcelain 0；工作树用完即删）。

判定：**APPROVE**，0 P1 / 0 P2 / 0 P3 / 2 NIT（另沿用 r1 的 NIT-2、NIT-3，无需动作）。

| # | 核对项 | 结果 |
|---|---|---|
| 1 | 同源（五项）：helper 与 `dispatchAction` 的 `return` 臂 | **PASS**。(a) 取消轮次：同一谓词 `isCancelRoundInstance`，出自同一个零引入的叶模块；(b) 办理节点：`nodeTypeAt` 对应闸门的 `currentNodeType === 'handler'`；(c) 策略：同一张 `ACTION_POLICY_KEYS` 表、同一个 `isOperationAllowedAtNode`、同一游标、缺省等于允许；(d) 并行：同一个 `readParallelBranchStates`；(e) 轨迹：`formSnapshot = toNullableRecord(form_snapshot) \|\| {}` 与 `requesterContext` 推导逐字相同，分配解析器与指定兜底解析器只被分配解析读。并行区域内闸门的效力游标移到分支节点，但 (d) 两边都先拒绝。游标不在图内：闸门抛 `Error`（500），helper 缺省。自动审批节点两边都在轨迹上。退回后游标等于目标。非 pending：闸门 409，helper 缺省。**唯一分歧**：考勤中心单的 fail-closed 守卫先于这五项拒绝一切动词，helper 不镜像；对带冻结图的行不可达（考勤插件创建的实例不带模板与发布定义；公开的 `createApproval` 把 `workflow_key` 写死为模板产品键）——**NIT-1**，四处描述里的「每一个与查看者无关的检查」因此多说了一条 |
| 2 | 缺省与 `[]` 的边界 | **PASS**（读代码 + 单测 + 载体测试）：非 pending、无游标、无冻结图、图不是 `{nodes, edges}`、执行器抛错 → 缺省；取消轮次（即使没有图）、办理节点游标、策略禁止、fork 游标 → `[]`；已关闭的取消轮次保持缺省；前端 `Array.isArray` |
| 3 | 读失败不抛，两个构造 | **PASS**。`try` 覆盖 `nodeTypeAt`、`isOperationAllowedAtNode`、`readParallelBranchStates`、执行器构造（遍历 `nodes` / `edges`，`null` 条目在 `try` 内抛）与游走；`catch` 记 debug 并返回缺省；`asWalkableRuntimeGraph` 只做 `isRecord` + `Array.isArray`（不会抛）；两个构造只在有定义时展开；两个构造各有无 start 节点的用例。`G2r2·m6`（重新抛出）→ 6 红 |
| 4 | 两条载体一致且接线被钉住；列表路径不变 | **PASS**。详情读传开关，列表不传（HTTP 用例同时断言列表行无该键）；产品 `getApproval` 读图一次复用于 `nodeOperations`（用例断言恰好一次读取）；`G2r2·m9` → 1 红 / 29 绿，`G2r2·m10` → 1 红 / 189 绿；`G2r2·m11 / m12`（两个构造无条件展开）→ 3 红 / 2 红 |
| 5 | walker 读原始表单快照与冻结的 requester 上下文 | **PASS**（同第 1 项 (e)） |
| 6 | 并行状态的严格解析 | **PASS**（同一个解析器） |
| 7 | 导入环 | **PASS**：同一次 `vitest run`（按文件隔离）里五种加载顺序都绿；环上的边只在函数体里使用；接受为延迟绑定 |
| 8 | 产品 `getApproval` 的冻结图读取提前 | **PASS**：有查看者时 `nodeOperations` 行为不变；只有无查看者的调用形状多一次读取，只有一个单测夹具用它 |
| 9 | OpenAPI：源与 dist 一致；四处描述与实现一致 | **PASS**，两条描述残留：schema 在 `base.yml` 紧邻 `currentNodeKeys`；`dist/openapi.yaml`、`dist/combined.openapi.yml` 带同一段，`dist/openapi.json`、`dist-sdk/index.d.ts`（`returnableNodeKeys?: string[]`）一致；另一台机器在 head 上重新 `generate:sdk` → `git status --porcelain packages/openapi` 为空；`attendance-run-gate-contract-case.sh openapi` rc=0；porcelain 0。**NIT-2**：描述里的载体清单少列了创建、取消轮次创建、管理员跳转三处响应（它们走同一个 `getApproval`，语义相同），「从不在列表响应」那一半为真 |
| 10 | 前端：服务端列表原样、`[]` 隐藏、缺省回落、顺序、标签残留 | **PASS**：`Array.isArray(serverKeys)` 先于每个镜像；按钮 `v-if` 三条件；对话框不预选（打开时清空 `returnTargetNodeKey`，确认按钮在选中前禁用），所以顺序变化无行为后果；spec 的 `detailRead` / `actionResponse` 夹具默认不带该字段，T1–T15 仍走镜像；web 4 files / 115 passed；`G2r2·m1` → 5 红（TS1、TS2、TS2b、TS3、TS3b），`G2r2·m2` → 2 红（TS2、TS2b）；标签残留已记录 |
| 11 | 变异：helper 每一项与前端优先分支 | **PASS**：`G2r2·m3`（去 `.slice(0, -1)`，代码行）→ 11 红 / 10；`m4`（办理节点规则）→ 1 红；`m5`（并行规则）→ 1 红；`mA`（取消轮次）→ 3 红 / 28；`mC`（策略）→ 3 红 / 28 |
| 12 | mock 连接池的夹具限制 | 接受：按完整谓词文本取键，谓词改动落到未处理 SQL 的抛错；真实库 S1 测试仍是谓词的权威 |
| 13 | CI | 见 §8.6：13 项必需检查全部 pass |
| 14 | 真机 | 切片三 `server-list-wins`、`server-empty`、两条漂移场景覆盖「服务端列表优先于本地图」（§6.6）；真服务端与真 HTTP 仍未（§7） |
| 15 | 切片一的三条 P3 在服务端列表存在时是否关闭 | **成立**（第 1 项的同源核对 + 切片三的浏览器场景；开发说明 §4.8） |

门审 r2 的测试与变异记录（另一台机器，独立工作树，`35190bee03`）：

| 运行 | 结果 |
|---|---|
| core-backend `approval-return-targets` · `approval-return-targets-carriers` · `approvals-bridge-routes` · `approval-product-service` · `approval-graph-executor`（邻居；执行器先加载的顺序） | 5 files / **320 passed**（21 · 10 · 30 · 190 · 69） |
| web `approval-detail-return-candidates` · `approval-detail-can-decide-current-node` · `approval-detail-instance-consistency` · `approval-detail-record-table` | 4 files / **115 passed**（候选 spec 27） |
| `G2r2·m1` 前端 `if (false && Array.isArray(serverKeys))` | 5 failed / 22（TS1、TS2、TS2b、TS3、TS3b） |
| `G2r2·m2` 前端 `Array.isArray(serverKeys) && serverKeys.length > 0` | 2 failed / 25（TS2、TS2b） |
| `G2r2·m3` helper 去 `.slice(0, -1)`（代码行） | 11 failed / 10 |
| `G2r2·m4` helper 办理节点规则 → `if (false)` | 1 failed / 20 |
| `G2r2·m5` helper 并行规则 → `if (false)` | 1 failed / 20 |
| `G2r2·m6` helper `catch` 重新抛出 | 6 failed / 25 |
| `G2r2·mA` helper 取消轮次规则 → `if (false)` | 3 failed / 28 |
| `G2r2·mC` helper 策略规则（`returnPolicyKey !== null` → `false`） | 3 failed / 28 |
| `G2r2·m9` bridge 详情 `{ withReturnableNodeKeys: true }` → `{}` | **1 failed / 29**，恰为新的 HTTP 用例（r1 时 0 红） |
| `G2r2·m10` 产品 `getApproval` 传 `null` | **1 failed / 189**，恰为新的调用点用例（r1 时 0 红） |
| `G2r2·m11` bridge 无条件展开 / `G2r2·m12` 产品无条件展开 | 3 failed / 7；2 failed / 8 |
| `pnpm --filter @metasheet/openapi run generate:sdk` → `git status --porcelain packages/openapi` | rc=0，空 |
| `scripts/ops/attendance-run-gate-contract-case.sh openapi` | rc=0，porcelain 0 |
| core-backend `tsc --noEmit`；web `type-check` | 均 rc=0，0 `error TS` |

卫生：17 个文件都在声明范围内；没有 `migrations/`、`routes/`、开关文件；diff 与七条提交信息的机器名 / 局域网与部署 IP / 用户名 / 家目录路径扫描无命中；7/7 提交带 trailer；没有 `UnifiedApprovalDTO` 键的普查需要更新；实现说明 §10 的声明在 head 上全部属实，唯二不准的是上面两条 NIT 对应的描述。每个变异 `git diff --stat` = 1 个文件、1 行增 1 行删；porcelain 每步与最后都为 0。

门审 r2 的 owner 可见建议：列表端点不带（同意）；NIT-1 建议一行镜像（与规则 (a) 同一个叶模块），收窄描述也可接受；NIT-2 只改描述，并入下一次 OpenAPI 改动；导入环接受为延迟绑定。

## 9. G-4：只留服务端列表与旧列表（删除客户端镜像）

- 对象：分支 `refactor/approval-return-candidates-server-list-only-20261010`，叠在 #6294 的 `91e48ae298` 上，并以合并 `134f6daad4` 带入本文与开发说明（`998e6e7b2e`，只有这两份 MD）。代码提交两个：`a8ce598a6c`（视图与 jsdom spec）、`50167870cb`（浏览器 spec 与 harness）；其后只有本文档提交，只改 `docs/development/` 下的两份 MD，所以下面在 `50167870cb` 上的运行就是最终 head 的代码。未推送、未开 Draft、未经门审。依据：收口目标 G-4（开发说明 §5、§6.4 行 23–25）。
- 改动（相对 `91e48ae298`，4 个代码文件 +198/−618）：
  - `ApprovalDetailView.vue`（+13/−177）：`returnableNodes` 只剩三支。非 pending → 空；`returnableNodeKeys` 是数组 → 原样（服务端的轨迹顺序，`[]` 隐藏按钮）；否则旧列表：除游标、`start`、`end` 之外的历史节点键，按 `store.history` 里首次出现的顺序（`/history` 最新在前）。删除 `ownApprovalGraph`、`returnCursorNodeType`、`returnBlockedByParallelRegion`、`upstreamNodeKeys`、`returnEligibleGraphKeys` 与它们的注释块（这一段从 193 行缩到 30 行），以及 `ApprovalNodeType`、`collectParallelRegionNodeKeys` 两个导入；`parallelBranchNodeKeys` 另有四处读者，保留。按钮的 `v-if` 与对话框不动。
  - jsdom spec：27 例 → 11 例。删 T2–T15（20 例，钉的是镜像的过滤、图身份与漂移规则）；留 T1（正控）与 TS1、TS2、TS2b、TS3、TS3b、TS4（TS4 改为期望旧列表）；新增 L1（字段缺省，自图已加载，历史含下游、并行分支、办理、抄送与重复键 → 旧列表六项）、L2（同一历史，`[]` → 无按钮）、L3（非 pending → 无按钮）、L3b（非 pending 且带列表 → 无按钮，钉住状态检查在服务端列表之前）。
  - 浏览器：10 条 → 6 条。退役 `client-mirror`、`handler-cursor`、`parallel-state`、`client-mirror&template=drifted`、`handler-cursor&template=drifted`；新增 `legacy`（#6293 之前的详情读，自图与钉定版本都已加载），选项恰为 总经理终审、会签结果抄送、法务会签、资料补正办理、抄送人事、部门经理初审（approval_3、join_1、approval_p1、handler_1、cc_1、approval_1，按给定的 `/history` 顺序）。`server-list`、`server-empty&template=drifted`、`server-list-wins`、`submit`、`server-list&template=drifted` 的夹具与期望不变，只改说明文字。
  - 登记不动：Playwright 配置、两个工作流、车道脚本与清单、覆盖守卫都按文件名或通配匹配，两个 spec 文件名不变。退役的场景名作为场景名只出现在本文与开发说明的历史段落（其他文件里同形的词另有所指）。
- 运行（另一台机器，独立 detached 工作树，`50167870cb`；依赖安装 `--frozen-lockfile` 完成，锁文件未变；运行前、每个变异还原后与收尾时 porcelain 都为 0）：

| 运行 | 结果 |
|---|---|
| web vitest：`approval-detail-return-candidates` · `approval-member-bar-operation-policy` · `approval-detail-instance-consistency` · `approval-detail-can-decide-current-node` | 4 files / **86 passed**（11 · 27 · 39 · 9） |
| Playwright（`playwright.approval-verification.config.ts`，`--retries=0`）：`approval-return-candidates.spec.ts` + `approval-member-action-dialog.spec.ts` | **14 passed**（6 + 8） |
| web `type-check`（`vue-tsc -b` 与两个 verification tsconfig） | rc=0，0 个 `error TS` |
| core-backend `approval-ci-coverage-enumeration` | 1 file / **402 passed** |

- 变异（`ApprovalDetailView.vue`；每次精确单锚替换，锚点恰好出现一次；`git diff --shortstat` 确认只动 1 个文件；跑完用 `git show HEAD:<path>` 的副本还原，porcelain 每步为 0）：

| # | 变异 | jsdom spec（11 例） | 浏览器（只跑候选 spec，6 条） |
|---|---|---|---|
| `G4·m1` | 不读服务端列表（`false && Array.isArray(serverKeys)`） | 6 红：L2、TS1、TS2、TS2b、TS3、TS3b | 5 红：`server-list`、`server-empty`（drifted）、`server-list-wins`、`submit`、drifted `server-list`；`legacy` 绿 |
| `G4·m2` | `[]` 当缺省（`&& serverKeys.length > 0`） | 3 红：L2、TS2、TS2b | 1 红：`server-empty`（drifted） |
| `G4·m3` | 旧列表不排除游标 | 2 红：L1、TS4 | 1 红：`legacy` |
| `G4·m4` | 去掉状态检查 | 2 红：L3、L3b | 未跑（浏览器没有非 pending 场景） |
| `G4·m5` | 状态检查挪到服务端列表之后（#6293 时的顺序） | 1 红：L3b | 未跑（同上） |
| `G4·m6` | 在旧列表上加回客户端图过滤（只留自图里的审批节点） | 2 红：L1、TS4 | 1 红：`legacy` |
| `G4·m7` | 服务端列表与历史取交集 | 1 红：TS3b | 1 红：`server-list-wins` |

- 相对 #6291 + #6293 的行为差异：字段是数组时不变（非 pending 却带列表的 DTO 现在给空；#6293 的服务端不发这种形状，L3b 只作纵深防御）。字段缺省时不再有任何客户端闸：图过滤（类型、并行域、上游）和只读 DTO 的办理节点闸、并行闸（`currentNodeType`、`currentNodeKeys`）都没有了。受影响的只有两种情形：(1) 前端连到 #6293 之前的服务端（只在单独部署 web 镜像时出现，开发说明 §6.4 行 25）；(2) #6293 的服务端没能为一个 pending 的平台实例算出列表（无游标、图形状不对、执行器抛错）。桥接 / 旧实例没有冻结图（DTO 也不带 `currentNodeType`），在 #6291 下本来就给旧列表。两种情形下非法目标由服务端的 409 拒绝（`APPROVAL_HANDLER_ACTION_NOT_ALLOWED`、`APPROVAL_RETURN_IN_PARALLEL_UNSUPPORTED`、`APPROVAL_RETURN_TARGET_INVALID`）。
- 残留：四个登记文件里的注释仍按镜像描述候选规则（`playwright.approval-verification.config.ts` 与 `approval-browser-verify.yml` 的文件头、`approval-web-guard.yml` 两处路径注释、`run-required-web-tests.sh` 该 token 的说明块）。G-4 按「登记不动」没有改它们；它们只是注释，不影响任何匹配，可在后续只改注释的提交里更新。
- 未跑：全量车道与托管 CI（推送后交 CI）；真服务端与真实 HTTP（同 §7）。
- 提交 trailer：G-4 的四个提交（含合并提交与本文档提交）都署 `Claude Opus 5.5`（实际执行模型）。
