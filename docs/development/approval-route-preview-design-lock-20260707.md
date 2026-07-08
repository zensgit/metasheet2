# 审批路由预览（B3-05 审批人解析预览 + B3-06 模板整流程试运行）· DESIGN-LOCK（RATIFIED）— 2026-07-07

> **状态：RATIFIED（owner 2026-07-07，RP-0 通过）。** owner 执行口令：RP-1 只做底座+只读走图+
> 一致性金测（不碰 UI 面）；RP-2/RP-3 分 PR、均依赖 RP-1；实现硬门=B3-05 formData 只按模板字段
> 白名单解释、sampleRequesterId 只出现在 B3-06 管理端点。
> 出处：benchmark §7.4 将本两项定位为「服务 fusion、优先级高于纯打磨」的 batch-3 对
> （approval-automation-operation-ux-benchmark-20260704.md:108-109,132）；两项共享一个只读底座、
> **分开 opt-in**。
> **committed 文档纪律**：陈述 MetaSheet 自身原则，不出现外部产品名。

## 1. 需求门（demand gate，具名）

- **B3-05（发起人视角）**：员工提交前不知道「这单会流到谁手里」——动态审批人（direct_manager /
  dept_head / role / continuous_managers / 委托替换）只有提交后才可见，填错部门/找错模板要靠
  撤回重来。具名用例：提交页在填单完成时展示「预计路由：张三 → 李四(部门主管) → 财务组」。
- **B3-06（模板作者视角）**：模板作者改完条件分支后无法验证「金额 8000 的采购单会走哪条边」，
  只能发起真实例试。具名用例：authoring 页给样例表单值 → 只读走图 → 高亮命中路径 + 各节点
  解析出的审批人。

## 2. 治理门（governance gate，复用不新建）

**唯一允许的实现形状 = 复用真实创建管线的只读切片，禁止任何平行实现：**
- 审批人解析 = `resolveApprovalAssignees`（ApprovalAssigneeResolver.ts:92，**纯函数**，含委托
  替换与去重语义）+ ApprovalProductService 现有的快照装配路径（requesterSnapshot / directory
  预取，ApprovalProductService.ts:2395 一带）——**抽出共享装配函数供 create 与 preview 双消费**，
  语义单源；preview 不得复制粘贴装配逻辑（漂移即缺陷）。
- 路由走图 = 现有图遍历/条件求值代码路径（graph traversal + condition evaluation 与 runtime
  同源）；条件求值器必须是 runtime 用的那一个。
- **read-only by construction**：不建 instance 行、不建 assignments、不发通知、不铸
  nodeEntryEpoch、不写任何表。preview handler 只允许 SELECT。

## 3. 端点与安全模型

### B3-05 `POST /api/approvals/preview`
- 入参：`{ templateId, formData }`；actor = session 用户（即预览中的 requester，**不可指定他人**——
  指定他人 = 组织结构探测面，拒绝）。
- 守卫：与 createApproval 同门（approvals:create 权限 + 模板可见性）；解析出的审批人姓名本就
  会在提交后对 requester 可见，预览提前展示不扩大信息面。
- 出参：`{ route: [{ nodeKey, nodeLabel, assignees: [{ id, name, assignmentType }], resolveError? }],
  truncated?: bool }`。**逐节点容错**：某节点解析失败 → 该节点带 `resolveError` 人话标记，
  其余节点照常（不整体 500）。
- 委托语义：应用与 create 完全一致的委托替换（同一 extractDelegationMap 路径），预览即所见。

### B3-06 `POST /api/approval-templates/:id/route-preview`
- 入参：`{ sampleFormData, sampleRequesterId? }`；**守卫 = canManageTemplates**（作者面允许指定
  样例 requester——作者本就能看全模板与组织解析结果；普通用户不可达此端点）。
- 出参：命中路径 edge 序列 + 未命中分支列表 + 各节点解析结果（同 B3-05 节点形状）+
  条件求值明细（`conditionSummary` 人话，复用 G-B2-19 的纯函数）。
- 与 B3-05 **同一底座函数**，仅入口守卫与 requester 来源不同。

## 4. 失败与边界语义（锁死）

- 图不可达/成环：返回带 `truncated: true` + 已走部分（图校验本就在 authoring 侧把关，preview
  不重复校验只诚实截断）。
- 解析出零审批人的节点：`assignees: []` + `resolveError: 'EMPTY_ASSIGNEES'` 人话标记（与
  runtime 的空审批人处理语义对齐——ground runtime 现行为后在实现 PR 里钉死一致性测试）。
- formData 缺关键条件字段：条件求值按 runtime 同一缺省语义（不另造 preview 特例）。
- **绝不缓存**：每次实时解析（组织结构/委托随时变，预览过期即误导）。

## 5. 验证计划（实现时执行）

- 真库集成（新 .db.test.ts，两点 CI 接线）：
  - preview(requester R, template T) 的逐节点 assignees === 随后真实 createApproval 的
    assignments（**同库同数据同刻的一致性金测**——底座同源的最硬证明）。
  - 委托生效期内：preview 显示 delegatee（与 create 一致）。
  - 逐节点容错：坏 assigneeSource 配置 → 该节点 resolveError、其余正常。
  - 零写证明：preview 前后 approval_instances/assignments/notifications 行数不变（RED-before：
    在底座里塞一行写 → 该测试红）。
  - B3-06 权限：非 canManageTemplates → 403；B3-05 无 approvals:create → 403。
- FE（各自 opt-in 的消费切片里验证）：ApprovalNewView 填单完成触发预览展示路由条；
  authoring 页试运行面板。

## 6. 切片阶梯（ratify 后各自独立 opt-in）

- ✅ **RP-0** ratify（owner 2026-07-07）
- ✅ **RP-1** 共享底座抽取——本 PR：assembleCreationContext（create 前缀原文抽取，preview 永不漂移）+ previewApprovalRoute 只读走图（逐节点容错/诚实截断）+ formData 白名单硬门（仅 preview 路径）+ 真库金测 6/6（preview===create/零写 RED-before/委托一致/容错/白名单）
- ✅ **RP-2** B3-05 端点 + ApprovalNewView 预览条 —— as-built：POST `/api/approvals/preview`（与 create 同门链 authenticate+rbacGuard approvals:write，body 仅进只读底座），服务端批量姓名充实（users/roles 单次只读查询，缺行诚实回退 id），发起页流程卡内「按当前表单预览路径」（compute-at-click；race-guard 抽为 `routePreviewController`——飞行中改表单/连点均按 generation 作废旧响应，陈旧路径永不回填；未解析节点渲染「（审批人待定）」）；路由级真库测试（401/403/400/404/200+零写入按模板 scope）+ FE 摘要矩阵 + controller race 单测；守卫突变验证 RED（门链 write→read、充实回退、preview 偷换 create）
  - **对账修正（gate ③ 语义诚实化）**：owner 硬门③的「白名单」在实现里位于 `pruneHiddenFormData` 之后，而后者已把 formData 收敛到「可见的模板声明字段」——故白名单是**冗余的纵深防御**而非唯一闸。安全性质（未声明/组织探测键不进走图）在 create+preview 两路都成立；证明用一个「条件节点按未声明字段 `route_secret` 分支」的判别式金测：任一层生效即 low 臂，**两层同时移除**才漂到 high 臂（已 mutation 验证 RED）。原「移除白名单即漂路由」的说法不成立，已在代码注释与测试注释更正。
  - **§3 输出契约对齐**：端点线响应严格等于 §3 的 `{ route, truncated }`——底座内部返回的 `totalSteps` 不上线（不转发），并有金测断言 `Object.keys(body)===['route','truncated']` 锁死防漂移。
- 🟦 **RP-3 端点 as-built（本 PR，backend）**：POST `/api/approval-templates/:id/route-preview`，守卫 `approvalTemplateAdminGuard`（canManageTemplates）——**唯一接受 `sampleRequesterId` 的面**（owner 硬门③：组织探测面仅管理端点可达；B3-05 面永不接受 requester 覆盖）。复用 B3-05 同一只读走图+姓名充实（抽 `walkPreviewRoute` 私有helper，`previewApprovalRoute`/`previewTemplateRoute` 共享——无平行实现）。两处扩展只在 preview 侧生效、create/B3-05 字节不变：①`previewSource:'draft'` 用 publish 同一 `buildRuntimeGraph` 编译 LATEST/草稿版本（作者可试运行未发布编辑，跳过 409 published 门）；②`requesterOverride` 只从 sampleRequesterId 的 userId 现查 org 关系/目录角色（客户端不可喂 roles/dept）。入口 `actor` 仍负责模板可见性鉴权。真库测试 8/8（401/403非管理/400/404/草稿预览+样例发起人驱动路由A≠B/省略回退actor/§3+零写scope）；突变 RED（draft-compile 关→409；sampleRequester 断线→A/B 失效）；create 路径回归 14/14（requester role/dept/title/manager-chain/delegation）。
  - **wedge 契约钉死**：模板按 `requester.department/title/role` 路由而样例发起人缺该属性时，底座 wedge guard **fail-closed 422/503**（与真实 create 同）——preview **不**优雅降级到默认分支（那会显示一条 create 实际会拒绝的假路由，违背 preview===create 保真）。FE 面板据此提示「此样例发起人缺少部门，真实提交会被拒」。已金测钉死（dept-routing 草稿 + 无部门样例 → 422 APPROVAL_REQUESTER_DEPARTMENT_REQUIRED）。
  - **两处已知背离（记录，非缺陷）**：①草稿 preview **不跑** RA-1b 已策展角色门（publish 与 formula-condition/dry-run 会跑）——依 §4「preview 不重复校验」，故作者可能预览到一条 publish 会拒的未策展角色路由；FE 面板应提示「以发布校验为准」。②`previewSource:'draft'` 载入**最后保存**的版本，非编辑器未保存改动——面板流程是「保存后试运行」。
- ⬜ **RP-3 FE 试运行面板** —— authoring 页消费上端点：样例发起人 picker（复用 directory/users）+ 样例表单 → 高亮命中路径 + 各节点解析人 + 条件人话（复用 G-B2-19 `conditionSummary`）；wedge 422/未策展角色/保存后预览三态提示如上。可交 Sonnet。

## 7. Out of scope

- 预览结果持久化/分享、跨模板批量试运行、模拟多轮退回/加签路径（只预览首过路由）、
  移动端预览面（随移动线各自 ballot）。

---

**一句话**：把「提交后才知道流向谁」变成「填单即所见」，实现上只做真实创建管线的只读切片
（纯函数解析器 + 同源走图 + 零写构造），一致性金测钉死 preview===create。**待 owner ratify
后按 RP-1→RP-2/RP-3 实现。**
