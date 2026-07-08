# 审批路由预览（RP）线 · 设计与验证收尾 —— 2026-07-08

> 设计锁：`approval-route-preview-design-lock-20260707.md`（RATIFIED）。本线 RP-0..RP-3 全部落地。
> 本文陈述 MetaSheet 自身原则。

## 1. 这条线解决什么

设计锁 `approval-route-preview-design-lock-20260707.md`（RATIFIED）具名两个需求门：

- **B3-05（发起人视角）**：提交前不知道「这单会流到谁手里」。动态审批人（直属主管 / 部门负责人 /
  角色 / 连续主管 / 委托替换）只有提交后才可见。
- **B3-06（模板作者视角）**：作者改完条件分支后无法验证「金额 8000 的采购单会走哪条边」，
  只能发真实例试。

治理门（唯一允许的实现形状）：**预览 = 真实创建管线的只读切片**，禁止任何平行实现；
审批人解析必须是 runtime 那一个解析器，条件求值必须是 runtime 那一个求值器。

## 2. As-built 架构

三层，一条管线：

| 层 | 产物 | PR |
|---|---|---|
| 底座 | `assembleCreationContext`（从 `createApproval` 前缀**原文抽取**）+ `previewApprovalRoute` 只读走图 | #3863 (RP-1) |
| 发起人面 | `POST /api/approvals/preview` + 发起页预览条 | #3881 (RP-2) |
| 作者面 | `POST /api/approval-templates/:id/route-preview` + 试运行面板 | #3913 (RP-3) + 本 PR (FE) |

**单源保证**：`createApproval` 与两个 preview 面共享同一个 `assembleCreationContext`；两个 preview
面共享同一个 `walkPreviewRoute`（走图 + 姓名充实）。preview 与 create 不可能语义漂移——因为它们
是同一段代码。

**只读构造性保证**：preview 路径只做 SELECT——不建 instance、不建 assignments、不发通知、
不铸 nodeEntryEpoch。

## 3. owner 三条执行口令 → 如何满足

| 口令 | 落实 |
|---|---|
| ①「RP-1 只做共享底座抽取 + 只读走图 + 真库一致性金测，先别碰两个 UI 面」 | #3863 严格只含底座；两个 UI 面分别在 #3881 / FE 片 |
| ②「RP-2 / RP-3 分开 PR，两者都依赖 RP-1」 | #3881 与 #3913 独立 PR，均在 #3863 之后 |
| ③「B3-05 的 formData 只按模板字段白名单解释；sampleRequesterId 只能出现在 B3-06 管理端点」 | 见下 §4 |

## 4. 硬门③ 的诚实结论（本线最重要的一次自我更正）

**结论：安全性质成立，但「白名单」不是唯一闸——它是冗余的纵深防御。**

实现里 `pruneHiddenFormData` 先把 formData 收敛到「**可见的模板声明字段**」，create 与 preview
两路都跑它；RP-1 加的白名单位于其后，因此在当前顺序下它**删不到任何东西**。

- 判别式金测（非空转）：造一个「条件节点按**未声明字段** `route_secret` 分支」的模板 —— 该键
  确实有 live sink（条件求值器会读它）。
- 证明：**任一层生效即走默认臂；两层同时移除才会漂到被夹带的臂**（mutation 验证 RED）。

原先代码/文档里「移除白名单即漂路由」的说法**不成立**，已在代码注释、测试注释与设计锁中更正。
这条记录的价值：下次有人「优化」掉 `pruneHiddenFormData` 时，白名单仍是唯一屏障。

**sampleRequesterId 的隔离**是结构性的，不只是路由级的：
- 只有 `POST /api/approval-templates/:id/route-preview`（`approvalTemplateAdminGuard`）读它；
- `previewApprovalRoute(request, actor)` 只有两个形参，**结构上无法**接受 requester 覆盖；
- `requesterOverride` 类型收紧为 **identity-only `{ userId, userName? }`** —— 一切 routing 真正
  消费的属性（directoryDepartment / directoryTitle / directoryRoles / manager chain）都由该 userId
  **现查数据库**得到，调用方无法注入组织属性。

## 5. 钉死的契约（易被"优化"成 bug 的地方）

- **wedge fail-closed 422**：模板按 `requester.department` / `requester.title` 路由，而（样例）
  发起人缺该属性 → **422，与真实 create 一致**。preview **不得**优雅降级到默认分支：因为 create
  会**拒绝**这类发起人，而不是把他们路由到默认臂；降级会显示一条真实提交根本不会发生的假路由。
  **保真优先于便利。** dept 与 title 各有金测钉死。
  （role wedge 只在**瞬时读失败**时 fail-closed(503)，genuine-empty 合法地走默认臂，故无确定性 fixture。）
- **§3 输出契约**：两个端点线响应严格 = `{ route, truncated }`；底座内部的 `totalSteps` **不上线**。
  金测断言 `Object.keys(body) === ['route','truncated']` 防漂移。
- **诚实渲染**：解析不出人的节点 → `resolveError: 'EMPTY_ASSIGNEES'` + 前端「（审批人待定）」；
  成环/不可达 → `truncated: true` + 已走部分。**绝不编造**路径。
- **绝不缓存**：组织结构与委托随时变，预览过期即误导。

## 6. 两处已知背离（记录，非缺陷）

1. **草稿 preview 不跑 RA-1b 已策展角色门**（publish 与 formula-condition/dry-run 会跑）。依设计锁
   §4「图校验本就在 authoring 侧把关，preview 不重复校验」。后果：作者可能预览到一条 publish 会
   拒绝的「未策展角色」路由 → 面板提示「以发布校验为准」。
2. **`previewSource:'draft'` 载入最后保存的版本**，非编辑器未保存改动 → 面板流程是「保存后试运行」，
   dirty 时禁用按钮。

## 7. 验证证据（全部真库、全部 mutation 反证）

**每一条守卫都做了 RED-before**（改坏 → 对应金测变红 → 精确还原 → 复绿）：

| 守卫 | mutation | 结果 |
|---|---|---|
| B3-05 门链 `approvals:write` | 改 `read` | RED（403 守卫失效） |
| 姓名充实 | 恒回退 id | RED |
| preview 不得建实例 | `previewApprovalRoute` 换成 `createApproval` | RED |
| 硬门③ | 白名单 + `pruneHiddenFormData` **同时**移除 | RED（路由被夹带） |
| 角色姓名充实（advisor 发现的盲区） | roles 查询指向错表（`.catch` 会静默吞掉） | RED |
| B3-06 草稿编译 | `previewSource:'active'` | RED（草稿 409） |
| B3-06 样例发起人 | 断开 `requesterOverride` | RED（A/B 塌成同一人） |
| B3-06 管理员门 | 移除 `approvalTemplateAdminGuard` | RED（`approvals:read` 用户拿到 200） |
| wedge 422 | `if(false && …)` | RED（漂成假默认路由） |

**回归面**（RP-3 改的是**每次 createApproval 都会跑**的快照装配，故回归面必须宽）：
- 创建路径：requester role / department / title / manager-chain / delegation-seam / subform /
  nofm-threshold / parallel-gateway / amount-total-check / pack1a-lifecycle / node-timeout-effects
  (auto-approve cascade) / direct-manager / postgate-acceptance —— 全绿。
- 预览三套（RP-1 底座 6 + RP-2 wire 8 + RP-3 wire 10）—— 全绿。
- `preview === create` 同库同刻金测：预览逐节点 assignees ≡ 随后真实 create 落库的 assignments。
- 零写：按模板 scope 的行数对账（全局 COUNT 会被并发测试文件污染）；RP-3 另经独立复核扩到
  `approval_published_definitions` —— 草稿编译不落库。

**独立对抗审阅**：#3881 四镜头 workflow（5 候选 → 4 证伪，1 NIT 已修）；#3913 adversarial-reviewer
判定 **APPROVE，0 P1 / 0 P2**，四个承重守卫全部 discriminating，四条 NIT 已全部修掉
（不可达死分支 + 死错误码、日志打错 id、override 类型过松、title wedge 补钉）。

## 7b. 作者面 FE（试运行面板）as-built

`canManageTemplates` 才可见。样例发起人 picker + 按 formSchema 渲染的样例表单（`detail` / `attachment`
**诚实跳过并就地标注**，不伪造控件）。compute-at-click，**复用 RP-2 的 `routePreviewController`**
（该模块改为泛型 `<Req>`，默认类型参数使 RP-2 调用点零改动——预览面**只有一套竞态守卫**，与「禁止平行实现」
的治理门一致）。样例数据 / 样例发起人 / 草稿 dirty 任一变化 → `invalidate()`，陈旧路径永不回填。

错误映射抽为纯模块 `routePreviewErrors.ts`，**按 `error.code` 而非 HTTP status 分派**（状态码日后若变，
语义不跟着漂）。它覆盖底座实际会抛的 **5 个** wedge code —— 而不是想当然的 3 个：

| code | 状态 | 语义 |
|---|---|---|
| `APPROVAL_REQUESTER_DEPARTMENT_REQUIRED` / `..._TITLE_REQUIRED` | 422 | 目录读成功但该属性为空 → **此人真实提交也会被拒** |
| `..._DEPARTMENT_UNRESOLVED` / `..._TITLE_UNRESOLVED` / `..._ROLE_UNRESOLVED` | 503 | 目录读取**瞬时失败** → 可重试，不是样例发起人的错 |

（`APPROVAL_REQUESTER_ROLE_NOT_CURATED` 属 publish / formula-dry-run 的策展门，草稿预览按 §4 不跑它，
故不在此表——见 §6 背离①。role 没有 `_REQUIRED`：genuine-empty 合法地走默认臂。）

## 8. 本线之外（未做，需各自 opt-in）

预览结果持久化/分享、跨模板批量试运行、模拟多轮退回/加签路径（只预览首过路由）、
草稿 preview 跑策展角色门（若要与 publish 完全对齐，需单独 ratify）。

## 9. 过程教训（写给下一个人）

1. **「非判别式金测」比没有金测更危险**——它给你一个绿勾，却什么都没证明。硬门③ 的第一版测试
   用线性模板，白名单关掉照样绿。判据：**把守卫改坏，测试必须变红**。
2. **`.catch(() => empty)` 会把「查询坏了」伪装成「查无此人」**。角色姓名充实整条路径当初零真库
   覆盖，坏了也只会静默显示原始 id。凡是有静默兜底的分支，必须有一条真库金测钉住它。
3. **改共享底座，回归面 = 所有消费者**，不是你改的那个方法。RP-3 只加了两个 preview-only 选项，
   但它改的是每次 create 都会跑的快照装配 —— 回归必须扫到 auto-approval / parallel / subform /
   amount / lifecycle。
4. **preview 的优雅降级可能是不诚实的**。当 create 会拒绝时，preview 显示一条"能走通"的默认路径
   就是在撒谎。保真 > 便利。
5. **全局 `COUNT(*)` 做零写证明是脆的**——共享 Postgres 上别的测试文件会污染它。按 scope 计数。
