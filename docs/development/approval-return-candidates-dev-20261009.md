# 退回候选线：服务端合法目标与前端过滤（开发说明，2026-10-09，定稿 2026-10-10）

- 对象：平台（模板运行时）审批实例详情页里「退回」对话框提供的候选节点。
- 切片一：Draft #6291（分支 `fix/approval-return-candidates-filter-20261009`，目标分支 main，head `f28b76dcd6`）。前端按服务端退回闸门的规则过滤候选。门审 r2 APPROVE（对 `038534f003`）；`f28b76dcd6` 只是浏览器验证夹具的重新落座。
- 切片二：Draft #6293（分支 `feat/approval-returnable-node-keys-dto-20261009`，head `35190bee03`，在 `f28b76dcd6` 之上 7 个提交）。服务端在实例 DTO 上下发 `returnableNodeKeys`，详情页优先使用。门审 r1 NEEDS-FIX → 修复轮 → 门审 r2 APPROVE。基线已从切片一的分支改到 main（2026-10-09 23:48 +0800），并于 2026-10-10 01:24 +0800 关闭再重开，让 13 项必需检查都能触发。
- 切片三：Draft #6294（分支 `test/approval-return-candidates-browser-verify-20261009`，head `91e48ae298`，含一次对 `35190bee03` 的合并；基线是切片二的分支）。真实 Chromium 里的 10 个 Playwright 场景，只加测试与登记，生产代码零改动。门审 r1、r2 NEEDS-FIX → r3 APPROVE。
- 核对基线：服务端断言读自 `origin/main`——切片二门审 r1 读 `60fdace92d`，门审 r2 读 `80cb873225`，本文定稿时 `b5a9bb07e7`（2026-10-10）。helper 所镜像的服务端文件（产品服务、图执行器、席位授权、桥接服务、条件公式、节点操作策略、两处后端 DTO 类型、OpenAPI 源、前端类型、审批与历史路由、考勤中心钩子）在切片一的 merge-base `a16a12aca3` 与 `b5a9bb07e7` 之间没有任何变动（只读 `git diff` 为空）。前端断言读自各切片的分支头。
- 验证与门审记录：`docs/development/approval-return-candidates-verify-20261009.md`。
- 约定：引用代码只写符号名，不写行号。「私有记录」指未入库的内部记录，本文不引其路径。「另一台机器」指跑过依赖安装与测试的第二台开发机，本文不记其名称。没有来源可核的断言标「未核」。
- 取舍按两类标注（§6）：「owner 已定」与「实现方默认值，非 owner 裁决」。

## 1. 背景与问题

### 1.1 审阅发现

R63 上机清单的审阅回复（审阅方意见；放在工作区 `reviews/` 下但未纳入 git 跟踪）§2 P2-2，标题为「平台实例的退回候选缺少可执行性过滤，已在组件中复现」。要点：

- 位置：`apps/web/src/views/approval/ApprovalDetailView.vue` 的 `returnableNodes` 与「退回」按钮的 `v-if`。
- 现象：同一平台实例，历史行不带 `nodeKey` 时没有「退回」按钮；历史行带上投影后的 `nodeKey` 后按钮可点，候选依次包含审批、抄送、办理节点。
- 服务端 `dispatchAction` 的 return 分支只接受执行器认定的前序审批节点，另外拒绝并行区域。
- 定性：新暴露的无效操作入口，不是已证明的权限绕过。
- 建议：上机前过滤服务端不支持的目标与情形；至少按本实例对应的图核对节点类型为 approval，并处理服务端禁止的并行情形；未知节点与无法确认图归属的条目不应变成可提交选项；服务端校验保留。
- 证据边界：复现在真实 Vue 组件加 mock 数据（jsdom）里完成，没有调用业务动作接口；真实 HTTP 409 未实跑。

### 1.2 触发机制

- PR #6268（标题 `fix(approval): name each history row's node and mark engine approvals`，2026-10-09 16:15 +0800 合入，合并提交 `11a00d9ded`；只读 `gh pr view` 核对）让 `GET /api/approvals/:id/history` 的平台分支在每一行上投影两个单键：`nodeKey`（仅非空字符串）与 `autoApproved`（仅 `=== true`）。
- 详情页的候选来自 `store.history` 各行的 `metadata.nodeKey`（排除游标、`start`、`end`）。此前平台实例的历史行没有 `nodeKey`，候选恒空，按钮不出现；投影之后，按钮第一次出现在平台实例上。
- 按钮的显示条件：`canDecide && !isMobileLayout && returnableNodes.length > 0 && allowReturn`，即只在桌面布局出现。
- 历史由 `/history` 按 `ORDER BY occurred_at DESC` 返回（读自 `routes/approval-history.ts`），候选顺序因此是「最近发生的在前」。

### 1.3 复现

| 谁 | 在哪里 | 结果 |
|---|---|---|
| 审阅方 | 真实组件加 mock 数据与权限（jsdom） | 历史带 `nodeKey` 后按钮可点，候选依次含审批、抄送、办理节点；未调用动作接口 |
| 实现方（先写测试） | 新 spec 的第 0 轮版本（14 例）对旧视图 | 11 failed / 3 passed（T1、T7、T9 本就应通过） |
| 切片一门审 r1 | 在真实视图上挂载线性图 start → approval_1 → approval_2 → approval_3 → end | PROBE-A：approval_3 退回到 approval_1 后，游标 approval_1，视图提供 `['approval_3','approval_2']`，真实执行器给 `[]`。PROBE-B：approval_1 重新批准，游标 approval_2，视图提供 `['approval_1','approval_3']`，服务端合法集 `['approval_1']` |
| 切片一门审 r1 | 真实执行器的后端探针（临时探针，不入库） | 2/2：规格夹具的合法集是 `['approval_1']`；线性图退回后是 `[]`，再批准后是 `['approval_1']` |
| 切片三门审 r1–r3 | 真实 Chromium，对修复后的视图逐一去掉过滤（变异） | `client-mirror` 场景的下拉随变异多出办理节点、抄送节点、并行分支节点或游标下游节点；去掉办理节点闸 / 并行闸则对应场景的按钮重新出现（验证说明 §6） |

### 1.4 用户可见效果

左两列（修复前对话框里的候选）来自审阅方的 jsdom 复现与切片三门审在真实 Chromium 下的去过滤变异；右列（服务端的回答）按代码核对。真实 HTTP 往返没有人跑过（未核：本线没有带真服务端的浏览器车道，三张 PR 都未合并、未上演示机）。

| 实例状态 | 修复前对话框里的候选 | 点确认后服务端的回答 |
|---|---|---|
| 游标是审批节点，历史里有抄送、办理节点的行 | 含 `cc`、`handler` 节点 | 选到这些节点：409 `APPROVAL_RETURN_TARGET_INVALID` |
| 游标之前有一个已汇合的并行区域 | 含区域内的审批节点 | 409 `APPROVAL_RETURN_TARGET_INVALID` |
| 一次退回之后（游标回到更靠前的节点） | 含游标下游的节点（历史里仍有它们的行） | 409 `APPROVAL_RETURN_TARGET_INVALID` |
| 游标是办理节点 | 任意候选 | 409 `APPROVAL_HANDLER_ACTION_NOT_ALLOWED` |
| 实例处于并行区域 | 任意候选 | 409 `APPROVAL_RETURN_IN_PARALLEL_UNSUPPORTED`（操作者的分支节点恰为办理节点时，先得到办理节点那条 409） |

- 这三个 409 都不是节点操作策略拒绝（`APPROVAL_NODE_OPERATION_DISABLED`）。`submitReturn` 的失败分支经 `memberActionFailure` 把 `error.message` 写进对话框内的错误位，对话框不关闭；`approvalRequestError` 逐字带上服务端的 `error.message`，所以框内是服务端的英文原句。这一段按代码核对，没有在浏览器里看过（未核：切片三的 `submit` 场景用记录器替换 `executeAction`，只钉成功路径的载荷与提示）。
- 即：按钮可点、选项可选、提交必败。这是「死按钮」，不是越权。

### 1.5 路线

R63 上机清单（r3）§0.1 第 6 条列出两个选项：(a) 上机前加一个小的前端过滤，只把服务端会接受的目标放进候选；(b) 按现状发版，以服务端 409 为护栏。owner 选了 (a)：依据是私有记录——实现方对审阅回复的处置建议单第 1 条逐字写明「『退回』候选走 (a)：开一张小 Draft，前端候选只留审批节点且不在已汇合并行域，与服务端判据同源，门审后交 owner 合并（不合并、不 undraft）」，owner 2026-10-09 18:3x +0800 对该建议单回「按建议执行」。这就是 #6291 的路线。后续 #6293 把「判断谁合法」从客户端挪到服务端，#6294 用真实浏览器验收两者，是同一条线的后两步，不改变路线；三者的推送与开 Draft 由 owner 2026-10-09 22:45 +0800 对收口目标文件的「按建议执行」授权（§5）。（这里的 (a) / (b) 是 R63 清单里的路线选项，与 §3.3 的漂移规则 (a) / (b) 无关。）

## 2. 服务端真值表

核对于 `origin/main`（切片二门审 r1 `60fdace92d`、门审 r2 `80cb873225`、本文定稿 `b5a9bb07e7`；相关文件在三者之间没有变动）。

### 2.1 `dispatchAction` 对 `return` 的真实检查顺序

| 顺序 | 检查（符号） | 拒绝时 | 与候选集的关系 |
|---|---|---|---|
| 0 | 考勤中心单的 fail-closed 守卫：`guardAttendanceCentralMutationOrThrow`。谓词只看 `workflow_key === 'attendance.request'`，对每一个动词都拒，在取消轮次出口闸**之前** | 409 `ATTENDANCE_CENTRAL_MUTATION_UNSUPPORTED` | 与查看者无关，但切片二的 helper **不**镜像它（切片二门审 r2 NIT-1）：考勤插件创建的实例不带模板与发布定义，helper 对没有冻结图的行本来就不计算；公开的 `createApproval` 把 `workflow_key` 写死为模板产品键，没有调用方能造出「考勤键 + 冻结图」的行。四处字段描述里的「每一个与查看者无关的检查」因此多说了一条不可达的拒绝，是描述层面的残留 |
| 1 | 取消轮次出口闸：`assertCancelRoundActionAllowed`。`isCancelRoundInstance`（`workflow_key = 'approval.cancel-round'`）的实例只允许 approve / reject / revoke / comment；在加载已发布定义**之前**判 | 409 `CANCEL_ROUND_OUTLET_FORBIDDEN` | 与查看者无关。前端靠 `canDecide` 镜像（把取消轮次排除在外）；切片二的 helper 纳入（§4.3 H1） |
| 2 | 没有 `published_definition_id`，或找不到已发布定义 | 409 `APPROVAL_RUNTIME_UNSUPPORTED`；404 `APPROVAL_PUBLISHED_DEFINITION_NOT_FOUND` | 前置条件，不在本线范围 |
| 3 | 席位授权闸：操作者在效力游标节点上没有席位（`revoke` 除外） | 403 `APPROVAL_ASSIGNMENT_REQUIRED` | 按查看者。前端靠 `canDecide`；不进 helper |
| 4 | 办理节点动词闸（Lock-3 §2.2）：效力游标所在节点类型是 `handler`，且动作属于 approve / reject / return / add_sign / reduce_sign | 409 `APPROVAL_HANDLER_ACTION_NOT_ALLOWED` | 检查 (a) |
| 5 | 节点操作策略闸（Lock-5）：`ACTION_POLICY_KEYS` 把 `return` 映射到 `allowReturn`；`isOperationAllowedAtNode` 读冻结图里游标节点的策略，策略显式为 `false` 时先落一条持久的 policy_denied 记录并提交，再抛错 | 409 `APPROVAL_NODE_OPERATION_DISABLED` | 与查看者无关。前端经详情 DTO 的 `nodeOperations.allowReturn` 镜像，即按钮的 `allowReturn`；切片二的 helper 纳入（§4.3 H3） |
| 6 | 状态闸：`instance.status !== 'pending'`。comment / transfer / add_sign / reduce_sign / revoke 的分支在它之前各自返回；approve / reject / handle / return 在它之后 | 409 `INVALID_STATUS_TRANSITION` | 前端 `returnableNodes` 在非 pending 时返回空；helper 在非 pending 时返回「缺省」 |
| 7 | `return` 分支：`isInParallelRegion` | 409 `APPROVAL_RETURN_IN_PARALLEL_UNSUPPORTED` | 检查 (b) |
| 8 | `return` 分支：`targetNodeKey` 为空 | 400 `VALIDATION_ERROR` | 参数校验 |
| 9 | `return` 分支：目标不在 `executor.listVisitedApprovalNodeKeysUntil(currentNodeKey).slice(0, -1)` 里 | 409 `APPROVAL_RETURN_TARGET_INVALID` | 检查 (c) |

- 本文的「三项检查」(a)(b)(c) 专指决定候选集的三个拒绝（顺序 4、7、9）。其余拒绝要么与实例种类或节点策略有关而与查看者无关（顺序 0、1、5），要么是按查看者的席位（顺序 3），要么是前置条件（顺序 2、6）；前端靠 `canDecide`、`allowReturn`、`status === 'pending'` 和桌面布局镜像它们。切片一只镜像 (a)(b)(c)。切片二的 helper 把与查看者无关、且对带冻结图的行可达的几项都纳入（顺序 1、4、5、7、9，加状态），按查看者的席位检查不纳入（§4.3）；顺序 0 因不可达而未纳入（上表）。切片二门审 r1 的对象 `5fdd9036c8` 只有顺序 4、7、9，修复轮补入 1 与 5，门审 r2 对 `35190bee03` 逐项核过同源（验证说明 §8）。
- 效力游标：并行区域内是操作者所在分支的当前审批节点，否则是存储的 `current_node_key`。顺序 4 判的是效力游标，所以并行区域内若操作者的分支节点恰为办理节点，得到的是顺序 4 的错误码，而不是顺序 7 的。无论哪条先触发，退回都被拒。
- 此外还有与候选集无关的校验（例如可选的 `expectedVersion` 前置校验、钉钉卡片通道的投递绑定），从略。

### 2.2 三项检查

| # | 条件（符号） | 备注 |
|---|---|---|
| a | `currentNodeType === 'handler'`：效力游标节点在冻结运行时图里的类型 | 详情 DTO 的 `currentNodeType` 取存储游标的类型，二者在并行区域外相同 |
| b | `isInParallelRegion = Boolean(parallelState && storedCurrentNodeKey === parallelState.parallelNodeKey)`，`parallelState = readParallelBranchStates(instance.metadata)` | 解析器是严格的：任何畸形的分支条目都返回 `null`，按线性处理。approve 路径只在解析出的游标就是 fork 时持久化并行状态，否则清除；管理员、超时、退回路径也各有清除语句。切片一门审 r1、r2 逐处核对过，「有并行状态」等价于「存储游标是 fork」 |
| c | `executor.listVisitedApprovalNodeKeysUntil(currentNodeKey).slice(0, -1).includes(targetNodeKey)` | 见 §2.3 |

### 2.3 执行器轨迹规则（`ApprovalGraphExecutor.listVisitedApprovalNodeKeysUntil`）

- 先调用 `getApprovalNodeConfig(currentNodeKey)`：游标必须是图里的审批节点，否则抛错。
- 从 `start` 出发。`start`、`cc`、`handler` 节点穿过，取首条出边；`condition` 节点经 `resolveConditionTarget` 沿表单（和发起人上下文）解析出的唯一一条分支继续；只有 `approval` 节点进入轨迹。
- 走到游标就返回，游标自己是轨迹的最后一项（所以 `slice(0, -1)` 去掉它）。**游标及其下游永远不是合法目标。**
- `parallel` fork 直接跳到它的 `joinNodeKey`：并行区域内的节点永远不进入轨迹，汇合之后也不进。
- 遇到 `end` 即中断并抛错（游标不可达）；重复访问同一节点抛错（环）；边指向未知节点抛错。
- 推论：历史里可能仍有游标下游的行。退回行自己的 `nodeKey` 是发起退回的那个节点；`/history` 没有按退回设下限。管理员前进跳转跳过的节点，在服务端是合法目标，但历史里没有它的行（跳转行不带 `nodeKey`）。

### 2.4 两条 DTO 载体

| 载体 | 构造 | 路由 | `currentNodeType` | `currentNodeKeys` |
|---|---|---|---|---|
| 详情读 | `ApprovalBridgeService.getApproval` → `toUnifiedDTO` | `GET /api/approvals/:id` | 有：`resolveCurrentNodeType(runtimeGraph, row.current_node_key)`。并行区域内存储游标是 fork，所以是 `'parallel'` | 永远没有（桥接服务文件里没有这个标识符） |
| 动作响应 | `ApprovalProductService.getApproval` → `toUnifiedApprovalDTO` | `POST /api/approvals/:id/actions`（模板运行时实例），以及 `POST /api/approvals`（创建）、取消轮次创建、管理员跳转的响应 | 永远没有 | 并行状态存在时就有：待办前沿（`!complete` 且有 `currentNodeKey` 的分支）；joinMode 为 `all` 的兄弟分支完成后只剩一项 |

- 两个构造都带 `templateVersionId`。切片二之后两个构造都带 `returnableNodeKeys`（§4）；`currentNodeType` / `currentNodeKeys` 的不对称没有改。
- 前端 store 的 `executeAction` 把动作响应写进 `activeApproval`，与详情读是同一个槽位。
- 后果一：并行 badge 的 `isInParallelRegion`（`currentNodeKeys.length >= 2`）在新鲜的详情读上恒为 false；单待办分支的窗口里也漏。
- 后果二：任何一次动作响应之后（例如办理节点上的一条评论），`currentNodeType` 消失；只读 DTO 字段的办理节点闸会重新提供「退回」。切片二用动作响应上的 `returnableNodeKeys: []` 关闭这一条（§4.8），切片三的 `server-empty` 场景钉住它。
- 节点类型只有 `start`、`approval`、`cc`、`condition`、`parallel`、`end`、`handler`，没有 join 类型：画布把并行区域汇合在下一个真实节点（前端 `insertParallelGateway` 把 `joinNodeKey` 设成原出边的目标）。前端的 `collectParallelRegionNodeKeys` 镜像后端同名函数：区域是 fork 与 `joinNodeKey` 之间的分支节点，fork 与汇合点本身不在内。

### 2.5 冻结版本接口的管理员门控

- `GET /api/approval-templates/:id/versions/:versionId` 由 `approvalTemplateAdminGuard` 把守，即 `rbacGuardAny(['approval-templates:manage', 'approvals:admin-templates'])`。普通成员拿不到冻结版本，所以 `templateStore.activeVersion` 对他们不会装着本实例的冻结版本。
- `GET /api/approval-templates/:id` 由 `rbacGuard('approvals:read')` 把守，成员能读；它走 `getTemplate` → `loadTemplateBundle(id, undefined, 'latest', actor)`，选 `latest_version_id || active_version_id`，可能是未发布的草稿。
- 实例在创建时钉住当时的 active 版本（`assembleCreationContext` 在没有 previewSource 时用 `'active'`）。版本不可变：模板的每次编辑、还原、复制都 INSERT 一个新草稿版本，唯一的 `UPDATE approval_template_versions` 只改 `status`、`publish_note`、`updated_at`。服务端游走的运行时图是 `buildRuntimeGraph(approvalGraph)`，即 JSON 深拷贝加 policy。
- 所以：模板 DTO 的 `latestVersionId` 等于实例的 `templateVersionId` 时，该模板的图逐节点就是服务端游走的图；不等就是漂移，成员无从拿到冻结图。
- 视图对所有人都请求冻结版本，请求失败被吞掉；`loadTemplate` 与 `loadVersion` 失败时都不清空上一个槽位，只设 `error`。所以应用级 store 里留着别的实例或别的模板的图是常态，不是异常。

## 3. 切片一：前端过滤（Draft #6291）

切片一只动前端：详情视图加三道门和一个「本实例自己的图」来源。候选的来源不变（`store.history` 各行的 `metadata.nodeKey`），顺序不变（最近发生的在前）。没有后端和 OpenAPI 改动。

### 3.1 规则：服务端检查 → 前端门 → 测试

`returnableNodes` 的判断次序：实例不是 pending → 空；游标是办理节点 → 空；处于并行 → 空；其余按本实例的图过滤。（切片二在这些门之前又加了一步「服务端列表优先」，§4.7。）

| # | 服务端检查（§2） | 前端门（`ApprovalDetailView.vue`） | 测试（`approval-detail-return-candidates.spec.ts`） |
|---|---|---|---|
| a | 办理节点动词闸 | `returnCursorNodeType === 'handler'` 时候选为空。类型优先取 DTO 的 `currentNodeType`，没有时取本实例自己的图里游标节点的类型 | T5（详情读形状）、T5b（动作响应形状，类型取自图） |
| b | `isInParallelRegion` | `returnBlockedByParallelRegion`：`parallelBranchNodeKeys.length > 0`，或游标类型是 `'parallel'`，候选为空。不复用并行 badge 的 `isInParallelRegion`（`>= 2`），原因见 §2.4 | T6（两个待办分支）、T6b（只剩一个待办分支）、T6c（详情读：游标类型 `parallel`，无 `currentNodeKeys`） |
| c | 执行器轨迹 | `returnEligibleGraphKeys`：候选必须是本实例自己的图里的节点、类型为 `approval`、不在 `collectParallelRegionNodeKeys(graph)` 里、并且在游标上游（`upstreamNodeKeys`：从游标沿 `graph.edges` 反向可达；游标为空或不在图内时跳过该过滤） | T2（cc）、T3（handler）、T4（并行区域，同时断言精确合法集 `['approval_1']`）、T11 / T12（退回之后游标及下游不提供）、T14（图里没有的键）、T15（游标不在图内） |
| — | 正对照 | 游标之前的线性审批节点被提供，按钮出现 | T1 |
| — | 无图 | 旧的未过滤列表，见 §3.4 | T7 |
| — | `currentNodeType` 缺省 | 不当作办理节点 | T8 |
| — | 图身份 | 见 §3.2 | T9、T9b、T9c |
| — | 漂移 | 见 §3.3 | T13、T13b |
| — | 冻结版本仍然判 | 版本槽优先于模板槽 | T10 |

spec 在 `f28b76dcd6` 共 21 例（切片二追加 6 例后为 27 例）。夹具的图是 start → approval_1 → cc_1 → handler_1 → parallel_1 ⇉ {approval_p1, approval_p2} ⇉ approval_2 → approval_3 → end，游标在 approval_2，服务端合法集恰为 `['approval_1']`；T11 / T12 用线性图。按钮与对话框的模板没有改：按钮的 `v-if` 本来就含 `returnableNodes.length > 0`，对话框的选项就是 `returnableNodes`。

### 3.2 图身份

候选只由「本实例自己的图」判断。`ownApprovalGraph` 有两个槽位，各自要证明自己就是这个实例钉住的版本，否则视为没有图：

- 没有 `templateId`，或没有 `templateVersionId`：没有图。
- 冻结版本槽（`templateStore.activeVersion`）：当且仅当 `version.templateId === detail.templateId` 且 `version.id === detail.templateVersionId`。
- 模板槽（`templateStore.activeTemplate`）：当且仅当 `template.id === detail.templateId` 且 `template.latestVersionId === detail.templateVersionId`（漂移规则，§3.3）。

原因：模板 store 是应用级的，加载失败会把上一个模板或版本留在原处（与 `nodeLabel` 已经防过的同类问题），而各模板的默认节点键（`approval_1` 等）会撞名，用别人的图判会误删合法目标或误留非法目标。这一点偏离了直接用 `pinnedGraph` 判（它没有身份校验）的朴素写法；`pinnedGraph` 本身没有改，`upcomingTimelineNodes` 读它，不在本切片范围。

### 3.3 漂移规则 (a) 与代价

- 规则：模板槽里的图是该模板**最新版本**的图。它只在 `template.latestVersionId === 实例.templateVersionId` 时才用来判这个实例，否则视为没有图，候选退回旧的未过滤列表。实例 DTO 没有 `templateVersionId` 时也是没有图；模板 DTO 缺 `latestVersionId` 时不能靠 `undefined === undefined` 匹配（T13b）。
- 为什么相等就意味着是服务端的形状：版本不可变，服务端游走的运行时图是该版本 `approvalGraph` 的深拷贝加 policy（§2.5）。
- 为什么是 (a) 而不是 (b)「保留图里没有的键」：判据是「绝不隐藏 main 会提供、且冻结图接受的目标」。用最新版本的图判，会漏掉后来被删除、改了类型、挪进并行区域的节点；加了上游过滤之后，被重排的节点也会漏。(b) 只修得了删除一种，(a) 全部满足。
- 代价（owner 可见）：实例钉的是创建时的 active 版本，模板的每次编辑都新建草稿版本并移动 `latest_version_id`。所以模板只要有任何未发布的草稿，普通成员在该模板的**每一个**实例上（包括新建的）都得不到过滤；重新发布之后，发布前开始的实例永远得不到过滤。「得不到过滤」就是旧的未过滤列表，与修复前的 main 一致，不是回归。能加载冻结版本的模板管理员不受影响（T10）。切片三的 `client-mirror&template=drifted` 场景在真实浏览器里钉住了这个旧列表（验证说明 §6）。
- 翻转有两种，不要混为一谈：
  - (i) 改为「按最新版本的图判」（修复轮 1 之前的行为）：去掉模板槽条件里的 `&& template.latestVersionId === pinnedVersionId`，并反转 T13、T13b。这样仍会按 T14 的规则丢弃图里没有的键，所以较新版本里被删除、而冻结图仍接受的节点会被隐藏，正是上面的判据所不允许的情形。
  - (ii) 改为 (b)「按最新版本的图判，并保留图里没有的键」：在 (i) 之外，再加上保留图里没有的历史键的一臂（门审 r2 的 `r2·mE` 施加的就是这一臂，它使 T14 变红），并反转 T14。(b) 仍然只覆盖节点被删这一种。
- 干净的解法在后端：把冻结图或服务端算好的合法目标放进实例 DTO（`formSchema` 已经是这样做的），即切片二。切片二落地后，服务端列表存在时漂移规则不再参与判断；它只在字段缺省（旧服务端、无冻结图的桥接实例）时起作用。
- 状态：实现方默认值，非 owner 裁决。门审 r1 把 (a) / (b) 之选留给 owner，门审 r2 把它记为待 owner 确认的决策点，不是阻塞项。

### 3.4 无图回退

- 视图里没有匹配的图时（查看者在模板可见范围之外、加载失败、store 里是别的模板、漂移），候选与修复前的 main 完全一致：除游标、`start`、`end` 之外所有历史节点，按 `store.history` 的顺序。
- 理由：只要拿不到模板就隐藏「退回」，会悄悄把这个动词从可能持有合法目标的成员手里拿走；服务端的 (c) 仍会用 typed 409 拒掉非法目标。(a)(b) 在 DTO 带了对应字段时不需要图。
- 与审阅回复建议的差异：审阅回复建议「无法确认图归属的条目不应变成可提交选项」。本实现在无图时保持旧列表，所以这一类条目仍可提交并被服务端拒绝。这是实现方默认值（§6）；切片二落地后，服务端列表存在时不再依赖这个默认值。
- 模板加载完成之前，列表也是这个旧列表，按钮可能先出现一下再被过滤。已在代码注释里记录，没有改，也没有验证（切片三的夹具等所有加载落定后才改写 store）。

### 3.5 不镜像的残留

(c) 除下面两种情形外都已镜像，前端无法再往前走，因为没有新的后端数据就没有可加的门：

- 条件分支：walker 只走表单解析出的那一支，前端接受所有分支。节点被访问之后表单又被改动、路由不再经过它时，它仍被提供，仍以 `APPROVAL_RETURN_TARGET_INVALID` 被拒。前端不对表单求值。
- 反方向：候选来自历史，管理员前进跳转跳过的轨迹节点在服务端合法，但从不被提供。

还有两个窄的情形：

- 动作响应 + 没有自己的图 + 游标是办理节点：动作响应不带 `currentNodeType`，游标类型未知、被当作非办理节点，「退回」重新出现，服务端回 `APPROVAL_HANDLER_ACTION_NOT_ALLOWED`，到下一次详情读自愈。漂移规则 (a) 把这个情形变宽（漂移的模板对普通成员同样没有图）。
- 由图推出的 `'parallel'` 游标类型，只在服务端今天不会持久化的状态（fork 处前沿为空）下才单独起作用；它被同一个 computed 通过 T5b 的路径覆盖，没有自己的测试。

这四条在服务端列表存在时都由切片二关闭（§4.8）。

### 3.6 既有现象（本切片未改，后续候选）

- 并行 badge、时间线按分支分组、`upcomingTimelineNodes` 的并行跳过都挂在 `isInParallelRegion`（`currentNodeKeys >= 2`）上，所以在新鲜的详情读上永远不出现（桥接 DTO 没有 `currentNodeKeys`）；只在动作响应后出现，并在单待办分支的窗口里又消失。
- `pinnedGraph` 没有身份守卫：模板加载失败后，`upcomingTimelineNodes` 可能走别的模板的图。
- `parallelBranchNodeKeys` 上方的注释说单分支形状「让字段缺省」；动作响应的构造实际上在并行状态存在时一律下发，包括只有一项的前沿。
- 两个 DTO 构造对 `currentNodeType` / `currentNodeKeys` 的分歧：后端让两者都带这两个字段，前端就能去掉 (a)(b) 的图回退。切片二没有做这一项（它另走 `returnableNodeKeys`）。
- 详情视图在办理节点游标照样渲染「通过 / 驳回」，服务端对这两个动词必 409（视图只在退回门读 `currentNodeType`；切片三门审 r2 的观察）。归审批线，不在本线范围。

### 3.7 验证夹具为什么要重新落座

浏览器验证（必需检查 `Approval browser verify (chromium)`）通过 `apps/web/verification/approval-member-action-dialog-harness.ts` 挂载真实的 `ApprovalDetailView`（生产的 Router、Pinia、Element Plus 对话框与焦点陷阱），只在开发 API 填好 store 之后改写确定性的夹具状态。

- 夹具把游标和全部座位钉在开发态模板图（start → approval_1 → approval_2 → end）的第一个审批节点 `approval_1`。按服务端规则，第一个审批节点的上游没有审批节点，所以切片一之后视图在那里正确地不再显示「退回」，验证找不到触发器，必需检查变红：在 `038534f003` 的那次运行里，红的是 `P5-C member-action dialogs use the real accessible grammar` 的桌面与平板两个视口用例（各含一次重试），断言 `getByTestId('approval-return-button')` 可见失败、元素不存在；移动端用例照常通过（只读 CI 日志核对）。此前它能过，靠的恰是服务端会 409 的候选。
- 修法（`f28b76dcd6`）：只改夹具。`currentNodeKey` 与三处座位的 `nodeKey` 从 `approval_1` 移到 `approval_2`，并在夹具头部注释写明原因；合法的退回目标是 `approval_1`；视图与 spec 不变（`git diff --stat 038534f003 f28b76dcd6`：1 个文件，+10/−4）。
- 教训：旧夹具里「退回可见」依赖服务端会拒绝的候选，应当重新落座夹具，而不是削弱过滤。

### 3.8 范围与 CI 登记

- 相对 main 共 6 个文件（+942/−7）：`.github/workflows/approval-web-guard.yml`、`apps/web/scripts/run-required-web-tests.sh`、`apps/web/scripts/run-required-web-tests.tokens`、`apps/web/src/views/approval/ApprovalDetailView.vue`、`apps/web/tests/approval-detail-return-candidates.spec.ts`、`apps/web/verification/approval-member-action-dialog-harness.ts`。没有后端和 OpenAPI 改动。
- 登记：`run-required-web-tests.sh` 在 can-decide 一行之后新增 `npx vitest run approval-detail-return-candidates --reporter=dot`；`.tokens` 按序加入该 token（在 `approval-detail-record-table` 与 `approval-e2e-lifecycle` 之间）；`approval-web-guard.yml` 的两个 `paths:` 块加入 spec 路径，targeted 的 `vitest run` 行加入该 token。清单生成器 `scripts/ops/required-web-lane-token-manifest.mjs` 在 `f28b76dcd6` 的树上报 MANIFEST MATCHES（554 个 token；本文定稿时在本机以 node 对解出的树重跑核对）。
- 与 main 的合并：main 自 `a16a12aca3` 以来在同样两个车道文件上各加了备料相关的 token（`run-required-web-tests.sh` +25、`.tokens` +2）；`f28b76dcd6` 合入 `b5a9bb07e7` 的 `git merge-tree` 干净，合并树上生成器报 MATCHES、556 个 token（main 单独 555，head 单独 554），并集成立。
- 门审 r2 留下的三条 P3（漂移默认值、条件分支与未到过的轨迹节点、动作响应缺节点类型）都是前端切片的固有局限，已在视图注释、spec 头部和本文披露，与 main 的行为相同，不是回归；原文要点见验证说明 §3。

## 4. 切片二：服务端 `returnableNodeKeys`（Draft #6293）

状态（2026-10-10 定稿时的只读核对）：

- 分支已推送，head `35190bee03`（在切片一的 `f28b76dcd6` 之上共 7 个提交，§7.2）。Draft #6293 开于 2026-10-09 22:50 +0800，当时基线是切片一的分支；门审 r1（对 `5fdd9036c8`）NEEDS-FIX，0 P1 / 1 P2 / 1 P3 / 3 NIT；修复轮三个提交后门审 r2（对 `35190bee03`）APPROVE，0 P1 / 0 P2 / 0 P3 / 2 NIT（另有 r1 的 2 条 NIT 沿用，无需动作）。两轮门审都是独立的对抗审阅。发现与处置见验证说明 §8。
- 基线改动：叠在分支上的 PR 跑不到 6 项必需检查（`web-tests`、`test (20.x)`、`stock-prep PowerShell 5.1 acceptance` 所在工作流的 `pull_request` 触发限定 `branches: [main, develop]`，三项 `contracts (…)` 所在工作流限定 `branches: [main]`；读自 `origin/main` 的工作流文件）。因此 2026-10-09 23:48 +0800 把基线改到 main，改基线不触发 `pull_request`，于是 2026-10-10 01:24 +0800 关闭再重开（事件时间读自 GitHub issue events）。改基线后 PR 的 diff 暂时含切片一的 6 个提交（13 个提交、21 个文件），切片一合入 main 后会自动缩回本切片。
- 托管 CI（2026-10-10 02:11 +0800 只读快照）：13 项必需检查全部 pass（含 `contracts (openapi)`、`web-tests`、`test (20.x)`）；全部检查 61 pass / 1 skipping。详见验证说明 §8.6；合并前须按最终 head 重读。
- 合并预览：`35190bee03` 合入 `b5a9bb07e7` 的 `git merge-tree` 干净；合并树上车道清单生成器报 MATCHES、556 个 token。
- 合并序（依据：私有记录）：先 #6291，再合 #6293；#6294 的基线随后改到 main。

### 4.1 为什么

切片一只能用客户端拿得到的图判断；普通成员拿不到冻结版本，只能拿到模板的最新版本，所以客户端过滤天生会漂移，漂移规则 (a) 又在漂移时把过滤关掉。干净的做法是让服务端在实例 DTO 上直接给出结果：服务端游走的就是闸门游走的那张冻结图。

### 4.2 合同

| | |
|---|---|
| 字段 | `UnifiedApprovalDTO.returnableNodeKeys` |
| 类型 | `string[]`，可选；服务端从不发 `null`（前端类型写 `string[] \| null`，沿用前端对可选数组的惯例） |
| 值 | `dispatchAction` 的 `return` 分支**此刻**会接受的目标，按轨迹顺序（start → 游标），由实例的**冻结**运行时图（`approval_published_definitions.runtime_graph`）算出 |
| 边界 | 与查看者无关、对带冻结图的行可达的拒绝都镜像（§4.3 的五项）；**按查看者**的席位检查（`APPROVAL_ASSIGNMENT_REQUIRED`）不镜像：`nodeOperations` / `canDecideCurrentNode` 为当前查看者回答它们，前端在 `allowReturn`、`canDecide`、列表非空三者同时成立时才提供「退回」。考勤中心单的 fail-closed 守卫（§2.1 顺序 0）不镜像，对带冻结图的行不可达 |
| `[]` | 没有合法目标，客户端隐藏「退回」 |
| 缺省 | **没有计算**：旧服务端、实例不是 pending、桥接或遗留实例没有冻结图、没有游标、或 walker 无法对这张图求值。客户端保留自己的回退（切片一的镜像），**绝不把缺省读成空** |
| 载体 | 详情读（`ApprovalBridgeService.getApproval` → `toUnifiedDTO`，带 `withReturnableNodeKeys`）与每一个经 `ApprovalProductService.getApproval` → `toUnifiedApprovalDTO` 构造的响应：动作响应，以及创建、取消轮次创建、管理员跳转的响应（后三者走同一个 `getApproval`，语义相同：新实例在首个审批节点为 `[]`，取消轮次实例按 H1 为 `[]`） |
| 不带 | 列表响应（`GET /api/approvals` 等）。列表路径与详情读共用 `toUnifiedDTO`，但不传这个开关，输出字节级不变 |
| 权威 | 只用于展示；闸门自己的 409（`CANCEL_ROUND_OUTLET_FORBIDDEN`、`APPROVAL_HANDLER_ACTION_NOT_ALLOWED`、`APPROVAL_NODE_OPERATION_DISABLED`、`APPROVAL_RETURN_IN_PARALLEL_UNSUPPORTED`、`APPROVAL_RETURN_TARGET_INVALID`）仍是权威 |

后端有两处 `UnifiedApprovalDTO` 声明（`approval-bridge-types.ts` 是详情读的，`types/approval-product.ts` 是产品服务的），都加了该字段；前端类型在 `apps/web/src/types/approval.ts`。四处字段描述（两处后端类型、前端类型、OpenAPI）在 `35190bee03` 上写的载体是「详情读与动作响应，列表从不」：少列了创建 / 取消轮次创建 / 管理员跳转三处（切片二门审 r2 NIT-2），「每一个与查看者无关的检查」多说了顺序 0 那条不可达的拒绝（NIT-1）。两条都是描述层面，门审建议并入下一次 OpenAPI 改动（需要重新生成 dist）。

### 4.3 helper 语义（`computeReturnableNodeKeys`，`approval-return-targets.ts`）

入参：冻结运行时图、原始 `form_snapshot`、`requester_snapshot`、存储游标、`status`、`metadata`，以及修复轮新增的 `workflowKey`（两个构造都从 `row.workflow_key` 传入）。

按 `dispatchAction` 应用它们的顺序，镜像每一个与查看者无关、可达的拒绝（本表的 H1 至 H5 是 helper 内部的编号，与 §2.2、§3.1 的 (a)(b)(c) 不是一套；helper 源码里的注释用 (a)–(e) 编号，对应 H1–H5）：

| # | `dispatchAction`（§2.1 的顺序） | 409 | helper |
|---|---|---|---|
| — | 状态 | — | `status !== 'pending'` → 缺省；没有游标（不是非空字符串）→ 缺省 |
| H1 | 取消轮次出口闸（顺序 1） | `CANCEL_ROUND_OUTLET_FORBIDDEN` | 同一个谓词 `isCancelRoundInstance({ workflow_key })` → `[]`。在图检查**之前**，所以取消轮次即使没有冻结图也答 `[]`（闸门也不需要图） |
| — | — | — | 没有图，或图不是 `{ nodes[], edges[] }` → 缺省 |
| H2 | 办理节点动词闸（顺序 4） | `APPROVAL_HANDLER_ACTION_NOT_ALLOWED` | 存储游标所在节点类型是 `handler` → `[]` |
| H3 | 节点操作策略闸（顺序 5） | `APPROVAL_NODE_OPERATION_DISABLED` | 同一张 `ACTION_POLICY_KEYS` 表里 `return` 的键，同一个 `isOperationAllowedAtNode`，同一张冻结图，在**游标节点**上；只有显式的 `false` 才拒（缺省等于允许）→ `[]`。目标节点自己的策略不参与：退回「到」一个节点不是在它「上」的操作 |
| H4 | `isInParallelRegion`（顺序 7） | `APPROVAL_RETURN_IN_PARALLEL_UNSUPPORTED` | `readParallelBranchStates(metadata)`（与 `dispatchAction` 同一个严格解析器）非空，且存储游标等于 `parallelNodeKey` → `[]` |
| H5 | 执行器轨迹（顺序 9） | `APPROVAL_RETURN_TARGET_INVALID` | 用与 `dispatchAction` 相同的选项构造执行器，调用 `listVisitedApprovalNodeKeysUntil(游标).slice(0, -1)`。构造时用 `formSnapshot = 原始 form_snapshot \|\| {}`，`requesterContext` 取自 `requester_snapshot` 的 `directoryDepartment`、`directoryTitle`、`directoryRoles`（空值默认与 `dispatchAction` 一致）。`dispatchAction` 还传的分配解析器、指定兜底解析器只在分配解析时读，walker 从不读，所以这里不传 |

- 与 `dispatchAction` 的差别在读法：helper 的 H2 / H3 读**存储**游标，`dispatchAction` 的顺序 4 / 5 读**效力**游标（并行区域内是操作者的分支节点）。并行区域内存储游标是 fork（类型 `parallel`），helper 由 H4 返回 `[]`；两边结论一致（拒绝 / 空），只是 `dispatchAction` 在分支节点恰为办理节点时先给出的是顺序 4 的错误码。
- 不镜像、有意为之：按查看者的席位检查（顺序 3，`APPROVAL_ASSIGNMENT_REQUIRED`）。不镜像、因不可达：顺序 0。
- 门审 r1 的对象 `5fdd9036c8` 只有 H2、H4、H5 三项；其 P3-1 指出 H1 与 H3 也是与查看者无关的拒绝，字段合同因此过度声称。修复轮采纳了门审推荐的「镜像」（而不是把四处字段描述收窄为「必要而不充分」），见 §6。门审 r2 对 H1–H5 逐项核过与闸门同源（同一谓词、同一表、同一解析器、同一执行器选项），并以变异证实每一项都被命名测试钉住（验证说明 §8）。

### 4.4 缺省与 `[]` 的区分，以及读失败

- `[]` 是肯定的回答（服务端算过，没有合法目标）；缺省是「没算」。前端用 `Array.isArray` 判断，不用真值判断。两个构造都用 `...(returnableNodeKeys ? { returnableNodeKeys } : {})` 展开：空数组是真值，所以 `[]` 原样下发，只有 `undefined` 才缺键。
- 详情读和动作响应都不能因为这个字段失败：计算里的**每一个**抛出都被吞掉，字段缺省。执行器会在图畸形（没有 start 节点、有环、边指向未知节点、游标不是审批节点或不可达）时抛，存储的公式可能抛带类型的 `ServiceError`，公式运行时错误（例如除零）也抛。修复轮给两个构造各补了一个无 start 节点的图用例（字段键不存在、不抛）。
- 只在 debug 级别记录游标 key 和错误信息，不记录表单值。
- 存储的图只做结构性准入（`nodes`、`edges` 是数组），不做发布期的 `asRuntimeGraph` 重新校验；`policy` 从不被 walker 读。闸门走的是归一化之后的图，所以只在「当前归一化器会拒绝的存储图」上两边有分歧，而那样的实例上每个动词在 dispatch 就都失败了。两轮门审都认为这个披露正确，保持。

### 4.5 两条载体与列表路径

- 详情读：`toUnifiedDTO` 新增 `options.withReturnableNodeKeys`，只有详情读的调用传 `{ withReturnableNodeKeys: true }`；列表路径的调用不传任何选项，输出不变，没有任何列表端点的成本变化（列表本来就为脱敏加载了运行时图）。
- 动作响应：`toUnifiedApprovalDTO` 新增第四个参数（冻结运行时图），在字段可计算时展开。动作响应必须带它：前端 store 把动作响应写进与详情读相同的槽位，不带的话，用户一动作字段就变回缺省、退回客户端回退。
- 产品 `getApproval` 现在只要实例有 `published_definition_id` 就读一次冻结图，供 `returnableNodeKeys` 与按查看者作用域的 `nodeOperations` 共用；以前这次读取放在 `viewerUserId && published_definition_id` 之后。产品服务里 `this.getApproval(…)` 的 17 个调用点都传查看者，所以新增的读取只发生在无查看者的调用形状，只有单测夹具用它。
- walker 读**原始** `form_snapshot`，不读 bridge 为 DTO 构造的脱敏回显：条件分支按存储的表单路由，隐藏字段也算，与闸门一致。
- `toUnifiedDTO` 与 `toUnifiedApprovalDTO` 现在 `export`，仅作无 DB 的测试缝，调用方不变。
- 门审 r1 的 P2-1 指出两个调用点的接线（详情读传开关、产品 `getApproval` 传冻结图）曾没有任何测试钉住，弄坏任何一个，所有测试和 CI 仍绿；修复轮补了 bridge 路由的 HTTP 用例（详情体带列表、同一行在列表响应里没有该键）和产品 `getApproval` 用例（字段在 DTO 上、冻结图只读一次）。门审 r2 重放两个变异各得 1 红（验证说明 §8）。

### 4.6 OpenAPI

`packages/openapi/src/base.yml` 的 `UnifiedApprovalDTO` 在 `currentNodeKeys` 旁加 `returnableNodeKeys`（string 数组；描述列出五项与查看者无关的检查、写明不含按查看者的席位检查、空数组、缺省、载体、列表不带、只用于展示）；重新生成 `dist/openapi.yaml`、`dist/openapi.json`、`dist/combined.openapi.yml`、`dist-sdk/index.d.ts`（四个 dist 文件各含该键一次）。`contracts (openapi)` 这个 CI 用例在 dist 漂移时变红；它在 #6293 改基线到 main 之后已跑，pass（验证说明 §8.6）。描述的两处残留见 §4.2 末段。

### 4.7 前端优先服务端列表

`returnableNodes` 在所有门之前先看 `approval.returnableNodeKeys`：

- 是数组：原样作为候选（标签仍走 `nodeLabel`），绕过切片一的全部镜像；`[]` 让按钮的 `v-if` 隐藏「退回」。
- 是 `null` 或缺省：落回切片一的逻辑，一字不改。
- 顺序是服务端的轨迹顺序（start → 游标），不再是 `store.history` 的最近优先。这是用户可见的顺序变化；对话框不预选任何项（`openReturnDialog` 清空 `returnTargetNodeKey`，确认按钮在选中前禁用），所以顺序变化没有行为后果。
- 因为不看本地图和历史，切片一会丢弃的键（例如并行区域内的 `approval_p1`，若服务端提供）、历史里从没出现过的轨迹节点（管理员前进跳转）只要在服务端列表里，就会被提供。
- 修复轮没有改视图，只改了类型的文档注释（视图相对 `f28b76dcd6` 共 +15 行，全部来自门审前的提交）。

### 4.8 设计上关闭的残留（门审 r2 与切片三已确认）

- 漂移（切片一门审 r2 的 P3-1）：服务端用冻结图算，不依赖客户端能不能拿到图。切片三 `server-list&template=drifted` 场景：无图时服务端列表照样决定。
- 条件分支与未到过的轨迹节点（P3-2）：服务端对表单求值，列表按轨迹给出。后者由单测 TS3b 与切片三 `server-list-wins` 场景（管理员前跳后历史里从未出现过 approval_1，服务端仍提供它）钉住；前者由 helper 的条件分支单测钉住，没有浏览器用例。
- 动作响应缺节点类型（P3-3）：动作响应也带列表，办理节点游标处是 `[]`。切片三 `server-empty` 场景正是这个形状：观看者在办理节点发评论后的动作响应（无 `currentNodeType`、`returnableNodeKeys: []`）配模板漂移，旧列表本会端上两个节点，只有 `[]` 能藏住按钮。
- 以上只对带该字段的服务端成立；对旧服务端，前端仍落回切片一的行为。

### 4.9 实现注记与残留

- 导入环：`ApprovalGraphExecutor` 从 `ApprovalBridgeService` 引入 `ServiceError`；bridge 现在引入 helper，helper 构造执行器。三条边都只在函数体里用，不在模块加载时用，所以在 CommonJS 构建和 vitest 加载器下，无论哪个先加载都惰性成立（门审 r1：`tsc` 的 CommonJS 构建和三种加载顺序都绿；门审 r2：同一次 `vitest run` 里五种加载顺序都绿；接受为延迟绑定）。这是仓库里第一个经过 bridge 的**运行时**环（此前执行器在 bridge 一侧的引入都是仅类型）。备选是把 `ServiceError` 移出 bridge，对一个字段来说改动过宽。
- 标签残留（门审 r1 NIT-3）：视图原样提供服务端的键，但标签来自成员能加载的模板版本（最新版本）；在较新版本里被重命名或删除的节点，会显示「节点已变更」这个占位。服务端提供它是对的；修法是在 DTO 上加 `nodeName` 载体，或让成员访问冻结版本，是另外的后续，不在本切片。
- 描述残留（门审 r2 NIT-1、NIT-2）：见 §4.2 末段；可选的一行加固是在 H1 之后对考勤键也返回 `[]`，门审建议下次改 OpenAPI 时一并处理。
- 没有 DDL，没有开关，没有新路由。改动面 17 个文件（+1308/−7）：helper 与其单测、两个 DTO 构造、两处后端 DTO 类型、OpenAPI 源文件与四个 dist、前端类型、视图、spec、载体测试、bridge 路由测试、产品服务测试。

## 5. 后续

| 项 | 内容 | 状态（2026-10-10 定稿时） |
|---|---|---|
| 切片一收口 | 必需检查全绿、门审 APPROVE、三条 P3 披露、owner 的合并词 | 门审 r2 APPROVE；三条 P3 已披露（§3.8）；13 项必需检查在 `f28b76dcd6` 上全部 pass（24 pass / 1 skipping，2026-10-10 01:55 +0800 重读仍如此，GitHub 报 mergeable 且 CLEAN）；对 `b5a9bb07e7` 的合并预览干净（§3.8）；合并词待 owner |
| 真实浏览器验收 | Playwright 真组件加真 Pinia：平台实例的退回候选只含合法节点；办理节点与并行区域内没有「退回」；服务端列表优先于本地图。新验证 spec 登记进 approval browser verify，本地与 CI 通过 | 已交付：Draft #6294，head `91e48ae298`，10 个场景（验证说明 §6）；三轮独立门审 r1 NEEDS-FIX（0/1/2/3）→ r2 NEEDS-FIX（0/1/1/2）→ r3 APPROVE（0/0/0/2）；托管 CI 在该 head 上 13 项检查全部 pass，其中 `Approval browser verify (chromium)` 的运行里新 spec 10 条全部通过（整条车道 64 passed）；6 项只在 main 基线上触发的必需检查要等 #6293 合入、基线改到 main 之后再跑 |
| 前端简化 | 切片二合入 main 之后：删掉模板图一侧的过滤和版本一致性规则，只留「服务端列表 / 缺省回退旧列表」，删对应测试；有服务端列表时行为不变 | G-4 更新（2026-10-10）：本地已实现，未推送、未开 Draft，待门审。分支 `refactor/approval-return-candidates-server-list-only-20261010`，叠在切片三的 `91e48ae298` 上（另以合并带入本文与验证说明），在切片二合入 main 之前提前开工（§6.4 行 24），合并仍排在 #6293、#6294 之后；改动与运行见验证说明 §9。`returnableNodes` 只剩三支：非 pending → 空；字段是数组 → 原样；字段缺省 → 旧列表。实现方原先补的前提（§6.4 行 25）没有保留：字段缺省时候选就是修复前的未过滤列表，即目标文件 G-4 写明的「缺省回退 legacy」，非法目标由服务端的 409 拒绝 |
| R63 清单 r4 | 登记新的打包候选 SHA（待切片一、切片二合入之后）与 P5 开关规则的变更；r4 落文后，打包点仍由 owner 点名 | 未开始（收口目标 G-6）。本文核对：审阅回复 P2-1（P5 用一条正则判开关为关会误判）已在清单 r3 吸收为逐 reader 判据；r4 待跟进的 P5 变动是清单 r3 预告的那条——撤销入口闸的 reader 随 Draft #6274 合入时改为精确匹配（#6274 定稿时仍 OPEN）。具体内容以私有清单为准 |

- 审阅回复 §4 第 1 条的建议（审阅方意见，不是 owner 裁决）：若把退回候选修复并入 R63，以这个小修复的后继 SHA 冻结最终包并重验；任何候选 PR 合入打包点之后，差异与 CI 都按新点更新，不借用旧证据。
- 合并任何 PR、undraft、R63 打包点与迁移授权、部署、开关，不在授权范围内，需 owner 另行点名（依据：私有记录，收口目标 §0 / §4）。
- 合并序（依据：私有记录）：先 #6291，再 #6293（基线已是 main），#6294 随后改基线到 main 再跑六项 main 基线的必需检查。

## 6. 取舍清单

标注规则：「owner 已定」只用于 owner 点名过、或目标文件逐字列出并经 owner 授权执行的项；其余一律「实现方默认值，非 owner 裁决」。审阅方的意见、门审的建议、实现方的推荐都不算 owner 裁决。

### 6.1 路线与范围

| # | 取舍 | 当前取值 | 标注 | 备注 |
|---|---|---|---|---|
| 1 | R63 上机前先做小的前端过滤，还是原样发版、以服务端 409 为护栏 | 前端过滤（切片一） | owner 已定（依据：私有记录——处置建议单第 1 条逐字写明走 (a)，owner 2026-10-09 18:3x +0800「按建议执行」） | R63 清单当时列的两个选项是 (a) 前端过滤、(b) 原样发版 |
| 2 | 切片二的范围：两条 DTO 载体都带；OpenAPI 加字段并重新生成 SDK；详情页有列表就用，`[]` 隐藏，缺省回退切片一的逻辑；读失败不抛 | 如左 | owner 已定（依据：私有记录——收口目标文件 G-2 逐字列出该范围，owner 2026-10-09 22:45 +0800「按建议执行」） | 授权的动作限于推送与开 Draft，不含合并、undraft、打包点、迁移、部署、开关 |
| 2b | 切片三的范围：真实浏览器验收三类规则（候选只含合法节点；办理节点与并行区域无退回；服务端列表优先于本地图），登记进 approval browser verify | 如左 | owner 已定（依据同上，G-3） | 同上 |

### 6.2 切片一

| # | 取舍 | 当前取值 | 标注 | 翻转方式 / 备注 |
|---|---|---|---|---|
| 3 | 漂移默认：模板最新版本不是实例钉定版本时，视为无图 | 已随 G-4 删除（此前为 (a)，见 §3.3） | 实现方默认值，非 owner 裁决 | 两轮门审都留给 owner 过目。两种翻转见 §3.3：(i) 按最新版本的图判 = 去掉 `&& template.latestVersionId === pinnedVersionId`，反转 T13 / T13b；(ii) 备选 (b) = (i) 再加保留图里没有的键一臂，并反转 T14。(b) 只覆盖节点被删。切片二落地后只在字段缺省时起作用。G-4 删掉整个客户端镜像，这条规则随之消失：字段缺省时一律给旧列表，与图在不在、是否漂移无关 |
| 4 | 无图时的候选 | 旧的未过滤列表，而不是隐藏「退回」 | 实现方默认值，非 owner 裁决 | 与审阅回复建议不同（§3.4）；T7、T9、T13、T13b 钉住；切片二的服务端列表存在时不再依赖 |
| 5 | 图身份守卫，偏离直接用 `pinnedGraph` 判的朴素写法 | `ownApprovalGraph`（§3.2） | 实现方默认值，非 owner 裁决 | `pinnedGraph` 本身没有改；T9、T9b、T9c |
| 6 | 图里没有的历史键 | 丢弃 | 实现方默认值，非 owner 裁决 | 在默认 (a) 下精确，因为此时的图就是冻结图；T14 |
| 7 | `currentNodeType` 缺省 | 不当作办理节点 | 实现方默认值，非 owner 裁决 | 缺省出现在旧服务端和动作响应上；T8 |
| 8 | (b) 的读法 | `currentNodeKeys` 非空，或游标类型是 `'parallel'`；不用 badge 的 `>= 2` | 实现方默认值，非 owner 裁决 | 由 §2.4 的载体差异推出；T6b、T6c |
| 9 | 游标不在图内 | 只跳过上游过滤，类型与区域过滤照常 | 实现方默认值，非 owner 裁决 | 对服务端守卫 fail-open，不让一个不一致的游标清空列表；T15 |
| 10 | 图形状守卫 `usable()` 及其注释声明 | 删除 | 实现方默认值，非 owner 裁决 | 门审给的两个选项之一；无法写出能隔离它的测试，且没有生产者会发这种 DTO（验证说明 §2） |
| 11 | `version.templateId` 校验 | 保留，作纵深防御 | 实现方默认值，非 owner 裁决 | T9c |
| 12 | PR 标题与提交 trailer | PR 标题是 `fix(approval): stop offering 退回 targets the server's return gate always refuses`；前五个提交 trailer 署 Opus 5.5，第六个署 Fable 5.1 | 实现方默认值，非 owner 裁决 | squash 时由 owner 或合并者统一 trailer；已有提交标题不改写历史 |

- G-4 之后，行 5–11 涉及的镜像代码（`ownApprovalGraph`、`returnCursorNodeType`、`returnBlockedByParallelRegion`、`upstreamNodeKeys`、`returnEligibleGraphKeys`）与钉住它们的 T2–T15 都已删除，这几行只作记录。行 4 的取值仍然成立，而且不再以「无图」为条件：字段缺省时就给旧列表，现由 L1、TS4 与浏览器 `legacy` 场景钉住。

### 6.3 切片二

| # | 取舍 | 当前取值 | 标注 | 翻转方式 / 备注 |
|---|---|---|---|---|
| 13 | 列表端点是否也带 `returnableNodeKeys` | 不带 | 实现方默认值，非 owner 裁决 | 目标文件把它列为需 owner 另行点名；两轮门审都同意不带。翻转：在 `ApprovalBridgeService.listApprovals` 的列表调用上传 `{ withReturnableNodeKeys: true }`，并改 OpenAPI 描述 |
| 14 | 候选顺序 | 服务端轨迹顺序（start → 游标），不沿用最近优先 | 实现方默认值，非 owner 裁决 | 用户可见的顺序变化；对话框不预选，无行为后果 |
| 15 | 非 pending 的实例 | 缺省，不是 `[]` | 实现方默认值，非 owner 裁决 | 前端在非 pending 时本来就给空 |
| 16 | helper 在运行时图、表单、游标、状态、元数据之外多读 `requester_snapshot` | 读 | 实现方默认值，非 owner 裁决 | 可逆；`requester.*` 条件公式靠它才与闸门同路 |
| 17 | 导出两个 DTO 构造函数作无 DB 测试缝 | 导出 | 实现方默认值，非 owner 裁决 | 可逆；没有测试钉这两个模块的导出清单 |
| 18 | 导入环 | 以延迟绑定接受 | 实现方默认值，非 owner 裁决 | owner 可以偏好把 `ServiceError` 移出 bridge 的重构 |
| 19 | 产品 `getApproval` 读冻结图 | 不再以查看者为前提，读一次共用 | 实现方默认值，非 owner 裁决 | 只有无查看者的调用形状多一次读取 |
| 20 | 取消轮次出口闸与节点操作策略闸是否纳入 helper | 纳入（镜像），而不是把四处字段描述收窄为「必要而不充分」 | 实现方默认值，非 owner 裁决 | 采纳的是门审 r1 推荐的方案；可逆：去掉这两项与它们的测试，并把四处描述收窄 |
| 21 | 按查看者的席位检查是否纳入 helper | 不纳入 | 实现方默认值，非 owner 裁决 | `nodeOperations` / `canDecideCurrentNode` 为当前查看者回答；前端在 `allowReturn`、`canDecide`、列表非空三者同时成立时才提供「退回」 |
| 22 | helper 额外读 `row.workflow_key`（`workflowKey` 输入） | 读，两个构造传入 | 实现方默认值，非 owner 裁决 | 取消轮次谓词的输入 |
| 22b | 考勤中心单守卫（§2.1 顺序 0）是否纳入 helper；载体描述是否补列创建 / 取消轮次创建 / 管理员跳转 | 都未做，只披露 | 实现方默认值，非 owner 裁决 | 门审 r2 的两条 NIT：前者可一行镜像或把「每一个」收窄为「五项」；后者改描述；两者都要重新生成 dist，建议并入下一次 OpenAPI 改动 |
| 22c | 基线改到 main 并关闭重开，让 13 项必需检查都触发 | 已做 | 实现方默认值，非 owner 裁决 | 改基线后 PR diff 暂含切片一；切片一合入后自动缩回 |

### 6.4 后续

| # | 取舍 | 当前取值 | 标注 | 备注 |
|---|---|---|---|---|
| 23 | 切片二保留切片一的镜像作回退 | 保留到 G-4；G-4 删除镜像，字段缺省时回退旧列表 | owner 已定（依据：私有记录，目标文件对切片二的描述；G-4 的删除与「缺省回退 legacy」逐字出自同一目标文件的 G-4 项，授权同行 2） | 只在字段缺省时起作用 |
| 24 | 删除镜像（前端简化）的起点 | 计划为切片二合入 main 之后；实际在合入之前于本地开工（2026-10-10，叠在 #6294 的头上，不推送），合并仍排在 #6293、#6294 之后 | 实现方默认值，非 owner 裁决 | 目标文件的流水线把它排在切片二合入 main 之后，授权的动作只是开 Draft；这个顺序是计划，不是 owner 点名的取舍。提前开工是执行安排（依据：私有记录，收口目标的运行日志），同样不是 owner 点名的取舍 |
| 25 | 删除镜像的前提 | 前端所连的每个服务端都带该字段；G-4 没有把它当作前提 | 实现方默认值，非 owner 裁决 | 目标文件只规定了先后顺序（行 24），这条前提是实现方的补充。G-4 按目标文件的「缺省回退 legacy」实现：字段缺省时就是修复前的列表。合并序 #6293 → #6294 → G-4 让带 G-4 的提交也带 #6293；部署工作流（`docker-build.yml`）用同一个镜像标签拉起 backend 与 web，所以只有单独部署 web 镜像时，前端才会连到不带该字段的服务端 |
| 26 | 切片三的 `server-empty` 夹具形状 | 办理节点游标上的动作响应（评论之后）配模板漂移，而不是图在手时的 `[]` | 实现方按门审 r2 修法；非 owner 裁决 | 图在手时服务端发 `[]` 的每一种状态下镜像也为空，对「`[]` 当缺省」的变异不判别；只有无图时 `[]` 才承重 |
| 27 | 切片三隐藏按钮场景的正控 | 只用「转交」按钮（服务端在办理节点放行的动词，与退回共用 `canDecide` 与桌面布局门），不用「通过」 | 实现方按门审 r2 修法；非 owner 裁决 | 视图在办理节点仍渲染服务端必拒的「通过」，是既有缝隙（§3.6），不拿它做正控 |
| 28 | 切片三跟进切片二的新 head | `git merge` 而不是 rebase（不 force-push） | 实现方默认值，非 owner 裁决 | 分支已在 Draft 上；合并带来的两条服务端规则（取消轮次、`allowReturn: false`）没有浏览器用例，它们只决定服务端发不发 `[]`，前端对 `[]` 的处理已由 `server-empty` 钉住 |
| 29 | 切片三的提交 trailer | 9 个提交（含合并提交）署 Opus 5.5 | 实现方默认值，非 owner 裁决 | 三轮门审都作 NIT 披露；是否改写交 owner（改写 = 非快进，门审任务禁止） |

## 7. 提交与分支清单

### 7.1 Draft #6291（目标分支 main）

分支 `fix/approval-return-candidates-filter-20261009`，基于 main 的 `a16a12aca3`（merge-base）。六个提交，由旧到新：

| # | sha | 标题 | 阶段 |
|---|---|---|---|
| 1 | `a608122448` | test(approval): pin 退回 candidates against the server's return gate | 第 0 轮：先写测试 |
| 2 | `f6cd25bd84` | fix(approval): offer only server-legal 退回 targets on the detail view | 第 0 轮：视图 |
| 3 | `78be3bf3dc` | ci(approval): wire approval-detail-return-candidates into the web lanes | 第 0 轮：CI 登记；门审 r1 的对象 |
| 4 | `fc07611cf3` | test(approval): pin 退回 candidates to the cursor's upstream and the pinned version | 修复轮 1：先写测试 |
| 5 | `038534f003` | fix(approval): keep 退回 candidates upstream of the cursor, judged by the pinned version only | 修复轮 1：视图；门审 r2 的对象 |
| 6 | `f28b76dcd6` | test(approval): seat the member-action browser harness at the second approval node so 退回 has a legal target | 门审 r2 之后：浏览器验证夹具 |

- 第 6 个提交在门审 r2 之后提交，只改验证夹具一个文件（`git diff --stat 038534f003 f28b76dcd6`：1 个文件，+10/−4），未经门审；视图与 spec 与门审 r2 看过的逐字节相同。
- 第 3 个提交是 `ff966786a5` 的修订形式，只改了车道脚本注释里「已验证为绿」那句话的措辞，使它如实说明那次隔离运行发生在哪里。引用 `ff966786a5` 的数字（全量车道）见验证说明 §5。
- 提交历史没有改写，门审引用的 sha 全部有效。
- Co-Authored-By：前五个提交署 `Claude Opus 5.5`，第六个署 `Claude Fable 5.1`（只读 `git log` 核对）；squash 时的 trailer 由 owner 或合并者定（§6 第 12 行）。
- PR 标题：`fix(approval): stop offering 退回 targets the server's return gate always refuses`，即门审 r1 的 NIT-2（标题夸大）之后、修复轮 1 里建议的 squash 标题：被过滤掉的每个目标都是服务端闸门一定拒绝的，标题不声称被拒的每个目标都被过滤（§3.5 的残留仍在）。
- PR 评论里有两条记录：夹具变红的根因与修法（2026-10-09 22:13 +0800），门审 r2 的结论（22:18 +0800）。

### 7.2 Draft #6293（目标分支 main；改基线前是 #6291 的分支）

分支 `feat/approval-returnable-node-keys-dto-20261009`，在 `f28b76dcd6` 之上七个提交，由旧到新：

| # | sha | 标题 | 阶段 |
|---|---|---|---|
| 1 | `756830fdc7` | feat(approval): compute server-legal 退回 targets from the frozen runtime graph | helper 与其纯单测 |
| 2 | `dd4c09e395` | feat(approval): ship returnableNodeKeys on both instance DTO carriers | 两个构造、两处后端 DTO 类型、提前的冻结图读取、载体测试 |
| 3 | `2bf2bd7267` | fix(approval): prefer the server's 退回 target list over the client mirror | 前端类型、视图、spec（TS1–TS4） |
| 4 | `5fdd9036c8` | docs(openapi): declare returnableNodeKeys on UnifiedApprovalDTO | OpenAPI 源文件与四个 dist；门审 r1 的对象 |
| 5 | `3045f73100` | fix(approval): mirror the cancel-round and node-operation-policy refusals in returnableNodeKeys | 修复轮：H1、H3，`workflowKey` 输入，四处描述，单测 |
| 6 | `66f71b74d9` | test(approval): pin returnableNodeKeys at both carriers' call sites | 修复轮：bridge 路由 HTTP 用例、产品 `getApproval` 用例、载体的畸形图与 `[]` 用例 |
| 7 | `35190bee03` | docs(openapi): returnableNodeKeys mirrors every viewer-independent return refusal | 修复轮：OpenAPI 源文件与四个 dist；门审 r2 的对象 |

- 改动面 17 个文件（+1308/−7），其中视图与 spec 两个文件与切片一重叠；改基线到 main 后 PR 显示 13 个提交、21 个文件，切片一合入后缩回。
- 七个提交都署 `Claude Fable 5.1`（只读 `git log` 核对）。
- PR 标题：`feat(approval): ship server-computed 退回 targets (returnableNodeKeys) on the instance DTO; the detail view prefers them`。
- PR 评论里有两条记录：门审 r1 → r2 的结论（2026-10-09 23:47 +0800），改基线到 main 的原因（23:48 +0800）。
- 没有 DDL、没有开关、没有新路由。

### 7.3 Draft #6294（目标分支是 #6293 的分支）

分支 `test/approval-return-candidates-browser-verify-20261009`。先叠在 `5fdd9036c8` 上，后以 `git merge` 跟进 `35190bee03`；相对 `35190bee03` 共 5 个文件（+703/−0）：`.github/workflows/approval-browser-verify.yml`（+6，文件头登记）、`apps/web/playwright.approval-verification.config.ts`（+6，文件头登记）、`apps/web/verification/approval-return-candidates-harness.html`（+12）、`approval-return-candidates-harness.ts`（+493）、`approval-return-candidates.spec.ts`（+186）。没有 `src/` 下的文件。九个提交，由旧到新：

| # | sha | 标题 | 阶段 |
|---|---|---|---|
| 1 | `6f678d60c6` | test(approval): browser harness for the 退回 candidate list on a cc/handler/parallel graph | 第 0 轮 |
| 2 | `9d0561a6cc` | test(approval): real-browser 退回 candidate scenarios at 1440 | 第 0 轮 |
| 3 | `d8fb436e55` | ci(approval): register the 退回 candidate harness in the approval browser lane | 第 0 轮；门审 r1 的对象 |
| 4 | `9881f6061c` | test(approval): put the 退回 handler fixture at handler_1 and give each scenario its own wire-shaped history | 修复轮 r1 |
| 5 | `288e728279` | test(approval): browser scenario where the server's 退回 list beats a disagreeing client mirror | 修复轮 r1 |
| 6 | `15a5e5dbec` | test(approval): scope the 退回 harness's wire-fidelity claim to what the return path reads | 修复轮 r1；门审 r2 的对象 |
| 7 | `765c134ccf` | Merge commit '35190bee03' into test/approval-return-candidates-browser-verify-20261009 | 合并切片二的新 head（父提交 `15a5e5dbec` 与 `35190bee03`） |
| 8 | `db80a6b013` | test(approval): use only the 转交 control in the 退回 hidden-button scenarios | 修复轮 r3 |
| 9 | `91e48ae298` | test(approval): make the 退回 server-empty fixture a reachable [] the legacy list disagrees with | 修复轮 r3；门审 r3 的对象 |

- 九个提交（含合并提交）都署 `Claude Opus 5.5`（只读 `git log` 核对）。
- PR 标题：`test(approval): real-browser verification of the 退回 candidate rules (server list, client mirror, handler/parallel, submit)`。
- PR 评论里有一条记录：三轮门审的结论（2026-10-10 01:47 +0800）。
- 登记点全是通配（工作流分类器的 `apps/web/verification/approval-*`、Playwright 配置的 `testMatch '**/approval-*.spec.ts'`、tsconfig 的 harness 与 spec 通配、派生枚举的守卫），唯一显式改动是截图上传的 `rc-*.png` 通配与两处文件头注释。
