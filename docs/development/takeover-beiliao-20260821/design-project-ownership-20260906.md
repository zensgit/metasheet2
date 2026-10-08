> **文档状态**:第四轮定向修订稿。三轮 opus 对抗复核记录见附录 [`design-review-appendix-20260906.md`](./design-review-appendix-20260906.md)。基线 `origin/main` = `f26a3395c`。**未经 owner 拍板,不代表决策。** values-free。

---

# 设计稿 1(第四轮稿 / 处理第三轮复核):备料「项目归属」与按人限制

**基线**:`origin/main` = `f26a3395ca1f0efaaa2100953c842f448c4453ee`(本轮再次 `git fetch origin` 确认与第二、三轮同一提交,无漂移)。本稿每一处 `文件:行号` 均在本轮用 `git show origin/main:<path>` 重新逐条核实。只读产出,未改仓库任何文件。values-free。

**本稿相对第二轮的性质**:两路反驳共 7 条 blocker,**5 条全额采纳**(路由清单缺 dry-run/apply、「apply 每个项目都会跑」被证伪、归属键与共享目标表不同量纲、confirm 谓词与审计次序冲突、PR-8 的 P-13 守卫账记漏),**2 条采纳并加强**;13 条 minor 里 11 条吸收、2 条给出行号反证不采纳。**推荐链因此重写**:认领点与守门点必须是同一组路由(反驳指出的「主认领点装在没有门的路由上」是本轮最重的一条),PR 拆分与工时随之重排。末尾 §7 是逐条处置表。

**本稿相对第三轮的性质(第四轮)**:第三轮两路复核共 3 条 blocker,**全部采纳**——(a) 免责句「三案都只对 `integration:admin` 持有者仍开着」在新增的两个守门点上写强了,已改成**逐路由的旁路层级表**(§2 前置事实 1、§3 免责 1);(b) PR-5 漏了 `tenant-scoped-write-guard` 源码派生集的 carve-out 账,已补进 §2.5 (b) 与 PR-5 工时(1.0d→**1.4d**);(c) 「仅在配了 sandbox 或 production 策略的部署上真写」对 canonical 目标表不成立,已按 `stock-preparation-table-actions.cjs` 的两条分支改写 §1.4-1、§2 B 代价、§7 M-f。11 条 minor **全部采纳**(无未采纳项)。**推荐链不变、章节编号不变**;工时合计由 5.1d 上调到 **5.6d(不含两支可选)**,其中 +0.4d 是 PR-5 的 carve-out、+0.1d 是把 §6 的注释支正式并入 PR-2(此前被记了两次账、又一次都没进合计)。文末新增「第四轮变更表」。

---

## 0. 一句话结论(重写)

数据模型里**没有任何一处**记录「这个项目是谁的」;`confirmedBy` 是确认之后才写的落款,不是归属。真正需要被归属收住的不是一条路由而是**四个写面入口**——**在写面上**调用者能自己交进 `projectNo` 的只有 `dry-run` / `apply` / `reconcile` / `大 BOM expansion-start`(**读面另有 list / export / board 三条也按调用者给的号定位,只是不写,见 §1.3d 与 Q0/Q4**),其中 **`apply` 是唯一形状上直写客户目标表的那条**,而它在前两轮的稿子里连行号都没有。**它今天能不能真写那张表,取决于部署有没有服务端 production 策略配置——见 §1.4-1 的两分支改写与 Q8。**第二轮那个「把认领写在 apply 成功之后」的方案,恰好把主认领点放在了一条**没有门**的路由上:非归属人跑 apply 时写照样发生,`insert + 23505` 还会把认领静默记到原主名下,账本看起来是对的。所以本稿的硬结论是:**认领点 ⊆ 守门点**,两者必须同批上线;要么按这个形状做认领制(C),要么承认没有归属、删门只留审计(B)。#5516 的判据在任何一支里都不再单独改动。

---

## 1. 现状精确盘点

### 1.1 账本里没有「作者」这一列(成立,未改)

`plugins/plugin-integration-core/lib/stock-preparation-templates.cjs:835-871` —— 账本 `plm_stock_preparation_confirmation_decision` 的字段表在 `:853-870`,共 **16** 列:

| 列 | 行号 | 带 | 说明 |
|---|---|---|---|
| `projectNo` | :856 | plm_system | **唯一的项目维度**(必填项在 `:846`) |
| `confirmedBy` / `confirmedAt` | :867 / :868 | plm_system | 只在 confirm 成功后写(`stock-preparation-confirmation-decisions.cjs:1306-1307`);PENDING 行**恒为空** |
| `resolutionAction` / `resolvedValue` / `resolvedAuxValue` / `notes` | :863-866 | human_preserved | 人填的字段 |

**没有 `openedBy` / `ownerUserId` / 任何作者列。** 一行 PENDING 决定,系统查不出是谁的对账把它开出来的。

### 1.2 操作员项目目录是「按租户给」,不是按行给(成立)

- `stock-preparation-operator-project-directory.cjs:212` `listOperatorProjectDirectory` —— 按 `scope.tenantId` 推出的 staging project 读整租户;`projectNo` 只是**项目表上的一个过滤器**(`:205-210` 自陈 *"It is a FILTER ON THE PROJECT SHEET"*),不是所有权判断。
- 同文件 `:379-384` 自陈:*"It is not a per-PERSON check … two operators of the same factory see the same projects and this gate cannot tell them apart."*
- **同文件 `:386-390` 还有一句两轮稿子都没引的**:*"NOR IS IT A PROPERTY OF THE LEDGER AS A WHOLE. This narrows ONE route. The confirmation-decision LIST … and CONFIRM … still admit on tier + tenant with no per-project check of their own."* —— 这是代码自己写下的、与本设计同一结论的陈述。
- `stock-preparation-operator-scope.cjs:157-159` 自陈:*"It is NOT per-row."*
- **【第四轮改:回到 `operator-project-directory.cjs`,不是上一条的 `operator-scope.cjs`】** `stock-preparation-operator-project-directory.cjs:396-424` `assertOperatorMaySeeProject` 只有两条放行:`directory_match`(`:411-412`)与 `archive_empty`(`:414-415`),其余 403 `STOCK_PREPARATION_RECONCILE_PROJECT_NOT_VISIBLE`(`:419-423`)。
- 同文件 `stock-preparation-operator-project-directory.cjs:121-134` `projectArchiveIsEmpty` —— 判「项目表**有没有行**」,不是「表存不存在」。
  > 这两处上一轮写成裸行号,紧跟在 `operator-scope.cjs` 之后,读起来像同一文件;**`operator-scope.cjs` 全文只有 393 行**,不可能有 `:396-424`。全稿的前端引用同理:`workbenchAccess.ts` / `plainLanguage.ts` 的完整路径是 `apps/web/src/services/integration/stockPreparation/`,`StockPreparationConfirmationQueueView.vue` 的是 `apps/web/src/components/integration/stockPreparation/`(§6.5)。

### 1.3 调用者能自己交进 `projectNo` 的入口(完整清单 —— 第二轮缺两条,本轮补齐)

#### 1.3a 四步主线三条 —— **dry-run 与 apply 是本轮新增,apply 是最重的一条**

`stock-preparation-workbench-access.cjs:250-354` 的操作员步骤表一共 **11** 条,不是八条:`dry-run`(`:251-256`,legacyGate `'read'`)、`apply`(`:257-262`,legacyGate **`'write'`**)、大 BOM 八条(`:280-327`)、`reconcile`(`:348-353`,legacyGate `PLATFORM_ADMIN_GATE`)。

| 路由 | 定义 | 处理器 | 权限门 | 租户推导 | 调用者给 projectNo | 写什么 |
|---|---|---|---|---|---|---|
| `POST /table-actions/:actionId/dry-run` | `http-routes.cjs:63` | `:5734-5840+` | `requireTableActionAccess(…,'read',…)` `:5738` | 值路径 `resolveOperatorValueScope` `:5767-5774`;非值路径 `resolveTenantId(req,{})` `:5785` | **是** —— body 默认键集含 `parameters`(`:1557` + `:1919` 默认参数) | 无(纯试算) |
| `POST /table-actions/:actionId/apply` | `:65` | `:6128-6185` | `requireTableActionAccess(…,'write',…)` `:6130` | `resolveTenantId(req, {})` `:6133` | **是** —— 键集 `VALID_TABLE_ACTION_APPLY_BODY_KEYS = {'parameters','confirm'}` `:1562`,解析 `:6131`,原样下传 `:6148`(`dryRunToken` `:6149`) | **写客户目标表**(`applyStockPreparationAction` `:6146`)。**【第四轮改:上一轮此格写「仅在 `sandboxPolicy` `:6171` / `productionPolicy` `:6174` 已配的部署上真写」,把两条策略当成并列的两把钥匙,对 canonical 表不成立】** 实际是**一个门两条分支**:无 production 策略 → 沙箱门对 canonical **无条件 403**;唯有 server-config-only 的 production 策略能打开 canonical。完整依据与行号见 **§1.4-1**,部署实况见 **Q8** |
| `POST /table-actions/:actionId/confirmation-decisions/reconcile` | `:81` | `:5842-6005` | `requireTableActionAccess(…,'admin',…)` `:5844` → `:988-1014`;操作员分支经 `operatorMayRunStockPrepPull`(`workbench-access.cjs:421-424`,动作 id `:243`) | 写目标 `resolveAuthUserTenantId` `:5851`;门内**另起一次** `resolveOperatorValueScope` `:5923-5928` | **是** —— `reconcileProjectNo` 在 `:5906` 已算好 | 写账本(孤儿清扫、supersede、reopen) |

> **这三条与 #5516 的关系**:#5516 只装在 reconcile 上(`:5916`)。dry-run 与 apply **没有任何按项目的判断**,一条都没有。

#### 1.3b 大 BOM 后台通道八条(第二轮已补,本轮复核无误)

`workbench-access.cjs:263-327` 的注释 `:272-276` 自陈 *"These are the SAME pull under the same frozen action id … The apply-side members reach the SAME `assertStockPrepApplyAllowed` sandbox/production gate"*:

| # | 步骤 | 路由 | 处理器 | legacyGate | 调用者给 projectNo |
|---|---|---|---|---|---|
| 1 | `large-bom-expansion-start` `:281` | `:66` | `:6187-6210` | `'read'`(门 `:6192`) | **是** —— 键集 `:1563`,`normalizeActionParameters(body.parameters)` `:6196` |
| 2 | `large-bom-expansion-get` `:287` | `:67` | `:6212` | `'read'` | 否(jobId) |
| 3 | `large-bom-expansion-run` `:293` | `:68` | `:6226` | `'read'` | 否(jobId) |
| 4 | `large-bom-expansion-plan` `:299` | `:69` | `:6314` | `'read'` | 否(jobId) |
| 5 | `large-bom-apply-start` `:305` | `:70` | `:6356-6377` | **`'write'`**(门 `:6361`) | 否(承载 job 上的 parameters) |
| 6 | `large-bom-apply-get` `:311` | `:71` | `:6379` | `'read'` | 否 |
| 7 | `large-bom-apply-run` `:317` | `:72` | `:6395-6435` | **`'write'`**(门 `:6397`;`assertStockPrepApplyAllowed` `:6412-6414`) | 否(jobId + applyJobId) |
| 8 | `large-bom-expansion-cancel` `:323` | `:73` | `:6437` | `'write'` | 否 |

八条的租户推导都经 `largeBomJobScope`(`:1266-1272`)→ `scopedInput`(`:1247-1253`)→ **`resolveTenantId` `:1250`**。

#### 1.3c 账本 / 值面一族与其余

| 路由 | 定义 | 处理器 | 权限门 | 租户推导 | 按项目校验 |
|---|---|---|---|---|---|
| `GET …/confirmation-decisions`(list) | `:238` | `:8054-8077` | `requireAccess(req, STOCK_PREP_READ)` `:8057` | **`resolveTenantId(req, input)` `:8067`**(见 §1.4b) | 无(`projectNo` 必填 `:8063-8066`) |
| `POST …/confirmation-decisions/confirm` | `:233` | `:8131-8194` | `STOCK_PREP_OPERATE` `:8136` | `resolveOperatorValueScope` `:8156-8161` | **无 —— 请求体里没有 `projectNo`**(键集 `:1601-1608`) |
| `GET …/confirmation-decisions/value-entry`(**值内容**) | `:237` | `:8083-8129` | `STOCK_PREP_OPERATE` `:8093` | scope `:8115-8120` | 无(按 `decisionId`,键集 `:1600`) |
| `GET …/prep-lines/export`(**值内容**) | `:181` | `:8210-8294` | `STOCK_PREP_OPERATE` `:8211` | scope `:8232-8237` | 无;目标表是 deploy 级配置(`project-board.cjs:589-590` 明说 export 头里早就这么写) |
| `GET …/operator/projects` | `:189` | `:8331-8380` | `STOCK_PREP_OPERATE` `:8332` | scope `:8342-8347` | 不适用(整租户列表) |
| `GET …/projects/:projectNo/board` | `:206` | `:8941-9044`(**不是 `:9017`**,见 §6.5) | `STOCK_PREP_OPERATE` `:8942` | scope `:8950` | 有「双库存在性」判断,见 §1.7 |
| `POST …/handoff/advance` | `:198` | `:8625+` | `STOCK_PREP_OPERATE` `:8626` + scope `:8676` | scope | 有**名册**门(`stock-preparation-handoff.cjs:504-510`),按 **step** 不按项目 |
| `POST …/carry/confirm` | `:164` | `:7465+` | `requireAccess(req,'admin')` `:7466` | scope `:7485` | 平台管理员专属,不在一线爆炸半径内 |

#### 1.3d 汇总:归属谓词只有四个可能的落点

**写面上**,`projectNo` 由**调用者交进来**的入口只有 **`dry-run` / `apply` / `reconcile` / `expansion-start`** 四条;写面的其余路由全部按 `jobId`(job 上存的 parameters)或 `decisionId`(账本行的 `projectNo` 列,`confirmation-decisions.cjs:1046` 写入)间接绑定。**一个只管 reconcile / confirm 的谓词,旁边留着 apply 这条按 `projectNo` 直写客户目标表的完整通道。**

**【第四轮改:这句话上一轮写成了不带「写面」限定的绝对句,而反证就在它上面的 §1.3c 表里】** **读面另有三条同样由调用者给号定位的路由**,它们不写、但都按这个号取数:

| 读面路由 | 号从哪来 | 行号 |
|---|---|---|
| `GET …/confirmation-decisions`(list) | query,且**必填** | `http-routes.cjs:8063-8066`(handler `:8054-8077`) |
| `GET …/prep-lines/export`(**带值**) | 请求参数 | 路由 `:181`,handler `:8210-8294` |
| `GET …/projects/:projectNo/board` | **路径参数** | 路由 `:206`,取值 `:8949`,handler `:8941-9044` |

外加 `handoff advance` 按 `(tenant, project_no)` 推进游标(migration `084:99-100`),它的号来自请求而不是 job/decision。**所以正确表述是:写面四条 + 读面三条(+ handoff)共七至八条按调用者给的号定位,本设计的谓词只覆盖写面四条中的三条;读面收窄是 Q0 与 Q4 的内容,不被 §0 的一句话结论覆盖。**

> 注:账本模块里**九处** `assertAdminPermission(permission)`(`confirmation-decisions.cjs:436/461/911/1134/1194/1226/1439/1475/1546`,`grep -c` = 9)是**服务端对自己托管表的能力**,不是调用者层级——路由自己在 `http-routes.cjs:8018-8020` 写明了。

### 1.4 会影响**他人项目/他人填写**的写路径(按危害重排 —— apply 从第 5 升到第 1)

1. **apply / 大 BOM apply 写客户目标表** —— `http-routes.cjs:6146`(小 apply)、`:6395-6435`(大 BOM apply-run)。操作员可达(`workbench-access.cjs:257-262` / `:304-321`),`projectNo` 由调用者给(小 apply `:6148`;大 BOM 承 job 上的 parameters)。目标表是 **deploy 级共享配置且没有 tenant 列**(`project-board.cjs:585-588`)。

   **【第四轮改:上一轮写的「仅在配了 `sandboxPolicy`(`:6171`)**或**`productionPolicy`(`:6174`)的部署上真写」,对本条点名的那张表是错的】** 两条策略**不是并列的两把钥匙**。单一 apply 门 `assertStockPrepApplyAllowed` 在 `stock-preparation-table-actions.cjs:1836-1857`,两个写入口共用(小 apply 在 `applyStockPreparationAction:1872-1878`,`route:'small'`;大 BOM apply-run 在 `http-routes.cjs:6412-6418`,`route:'large'`),它按 **`productionPolicy` 的在场**分岔(`:1838`):

   - **没有 production 策略 → 落到沙箱门**(`:1854-1855` → `:1781-1797`)。沙箱门对 canonical objectId **无条件 403**,与策略内容无关:`:1785-1788` 抛 `STOCK_PREP_APPLY_SANDBOX_ONLY` / reason `prod_canonical`,注释 `:1785` 自陈 *"the prod canonical target is never appliable on the sandbox path, regardless of policy"*;并且 `:1784` 把**缺 `objectId`** 的 target 也按 canonical 处理(默认取 `STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId`)。而 canonical 正是 `plm_stock_preparation_main`(`stock-preparation-templates.cjs:652`),**就是本条上一句引 `project-board.cjs:585-588` 说「deploy 级共享、无 tenant 列」的那张表**。→ **在这类部署上,一线对该表的 apply 今天已经是 403 fail-closed。**
   - **配了 production 策略才可能授权它**,而 production 策略是 **server-config only、刻意没有 env 开关**(`:1818-1827`,`:1821` *"there is deliberately no env switch"*),并且还要连过 `:1838-1852` 四关:格式(`:1839`)、未过期(`:1840`)、**显式**且等于 `policy.authorizedTargetObjectId` 的 objectId(`:1841-1845`,注释 `:1842` 明写「省略/默认的 objectId 不得授权生产写」)、route 与 actionId 匹配(`:1846-1851`);过门之后还有行数上限(`:1859-1865`)。
   - 「sandbox 已配」这一半**打不开这张表**,它只能打开 allowlist 里的**非 canonical 沙箱副本**(`:1789-1796`)——那是另一种风险量级,不是本条说的共享目标表。

   **对本设计的后果(不改推荐,改论据强度)**:apply 在本清单里排第 1,依据是**它的形状**——唯一一条按调用者给的 `projectNo` 直写客户目标表的操作员可达路由,也是三个认领点里覆盖「非 held」分支的那个;**不是**「它今天敞着」。在没有服务端 production 配置的部署上,谓词上 apply 属于**纵深防御 + 留下认领事实**,不是堵一条正在漏的主写路径;只有在配了 production 策略的部署上,它才同时是一道真正的写面收窄。

   > **【owner 问句 Q8,只读复核无法代答】** 目标部署(含 222)是否带 `context.config.stockPrepApplyProduction` 服务端配置?答「否」→ PR-5 的 apply 一支是纵深防御,可以按此排优先级;答「是」→ 它是本设计里唯一真正在拦客户目标表写入的门,优先级应高于 PR-6/PR-7。
2. **reconcile 的孤儿清扫** `confirmation-decisions.cjs:1058-1085` —— 把该 `projectNo` 下所有 `stableDecisionKey` 不在本次候选集里的 PENDING 行改判 `superseded`(`:1080-1084`)。范围由**请求体里的 projectNo** 圈定。这是归属真正能收窄的那条:**它决定「谁的队列被重写」**。
3. **reopen 清空人填字段** `:1009-1040` —— 指纹回摆(A→B→A)时把行改回 PENDING,并把 `resolutionAction / resolvedValue / resolvedAuxValue / notes / confirmedBy / confirmedAt` 全部置 null(`:1029-1034`)。**这不是「B 的代价」,是 owner 已裁决的默认**:`:1013-1022` 明写 *"(Q5-A: the owner confirmed this conservative default on 2026-08-29 — a parked or decided row on stale input must be re-confirmed, never silently re-armed)"*,并点名 Q5-B(自动结转)是被 owner 否决的那一个。reopen 由**任何一次 reconcile** 触发,包括归属人自己那一次。**三个方案没有一个关掉这条路。**
4. **指纹变更 supersede** `:998-1008` —— 关闭同 key 的 live 行(pending + confirmed)。
5. **confirm** `:1225-1332` —— 定位只用 `decisionId`(`:1256`),同租户内任意项目的任意 PENDING 行都能被盖章;审计行(`http-routes.cjs:8167-8179`)记 `subjectId = decisionId`,**不记 projectId**。
6. **handoff advance** —— 按 `(tenant, project_no)` 推进游标(migration `084:99-100`),名册门(`handoff.cjs:504-510`)只问「你是不是这一步的 handler」,不问「这个项目是不是你的」。
7. **carry confirm** `http-routes.cjs:7465-7466` —— 管理员门,不在一线半径。

### 1.4b 租户底座分档(精确版 —— 反驳的「唯一」措辞已限定)

**账本/值面四条里,list 是唯一没迁的,这一句成立且只在这四条里成立**:value-entry(`:8115`)、confirm(`:8156`)、export(`:8232`)在 #5445 已迁到 `resolveOperatorValueScope`;list 仍用 `resolveTenantId(req, input)`(`:8067`)。该 helper 定义在 `:1023-1047`,自陈(`:1040-1045`):*"Everything above compares the request's tenant against `user.tenantId` — which the auth middleware fills from the `x-tenant-id` HEADER when the verified token carries no tenant claim, so on a claimless deployment those comparisons can be header against header."* 只有 `assertVerifiedTenantClaim`(`:1045`,受 `MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED` 控制,`:1313`)打开才补上。

**但表外确实还有同形状的,反驳这条对**:table-action 一族的 apply(`:6133`)、大 BOM 八条(经 `:1250`)、dry-run 的非值路径(`:5785`)都用 `resolveTenantId`。**两族的差别是实的,必须说清**:table-action 一族的**操作员分支**在进入处理器之前已经被 `requireTableActionAccess` 跑过一次 `resolveOperatorValueScope`(`:1007-1012`),`:1004-1006` 明写 *"the routes' own `resolveTenantId` cannot now differ from it for any caller who got this far"*;而 list 的门是 `requireAccess(req, STOCK_PREP_READ)`(`:8057`),**没有任何等价物**。所以:
- 对 **stock-prep 操作员**:list 的底座是裸的,table-action 一族被上游 scope 的拒绝挡了一层;
- 对 **legacy `integration:*` 持有者**:两族都是裸的(legacy 分支 `:993-1000` 在 scope 之前返回)。

### 1.5 现有可用作「归属」的物料(以及它们各自的坑)

| 候选 | 位置 | 坑 |
|---|---|---|
| `plm_stock_preparation_project.owner` | `templates.cjs:892`(human_preserved),写入自 `stock-preparation-readonly-intake.cjs:173`(`owner` / `createdBy`) | ① 只有 mvp-persist 归档过的行才有;② 客户 PLM 侧项目级 owner 不保证存在;③ **目录路由**已断言不外泄(`__tests__/stock-preparation-operator-scope-tripwires.test.cjs:488-504` S-02b,`:496` 断 `serialized.includes('"owner"') === false`)——是路由级断言,不是全局断言 |
| 审计表 `integration_stock_prep_audit` | migration `066:18-33`,`project_id` 可空(`:22`)+ `actor`(`:30`) | **全仓真正把 projectNo 写进 `project_id` 的 append 只有两处**:export(`http-routes.cjs:8269`)与 handoff advance(`:8801` / `:8833`)。reconcile(`:5986-5993`)**没填**、confirm(`:8167-8179`)**没填**;**board 是刻意不填的**——`:9018-9021` 明写 *"project_id stays NULL and the projectNo appears nowhere … on the one route that is ABOUT a single project"*,miss 分支 `:8999-9014` 同样不填。(`:8509` 也出现 `projectId: projectNo`,但那是 `audit.list` 的**过滤条件**,不是写入。) |
| `integration_stock_prep_handoff.updated_by` | migration `084:67`,唯一键 `(tenant_id, project_no)` `084:99-100` | 有「这个项目最近是谁推的」这一事实;但 `COMMENT ON TABLE`(`084:102-103`)写死 *"A VISIBLE TURN SIGNAL, not a permission record and not an approval instance"*——**拿它回填归属,是把一张明确声明自己不是权限记录的表当权限来源**。且只在配了交接链的部署上有行 |
| `field_permissions`(角色 × 列写权) | `packages/core-backend/src/services/stock-preparation-field-permissions.ts:22-29` | 只管**列**,不管行/项目;结构上只能限写不能限读(`:25-29`:`visible` 被钉成字面量 `true`,*"STRUCTURALLY incapable of emitting a read restriction"*) |

**关于 `migration 083`**:`http-routes.cjs:9020` 援引的 `migration 083` 在 `packages/core-backend/migrations/` 里**确实不存在**(082 之后直接是 084,最高 086)。但那条理由**不是查无实据**——它在 `086_extend_stock_prep_audit_project_board_read_action.sql:20-22`,同文件 `:36` 的小标题 *"WHY 086 AND NOT 083, WHICH IS WHAT THIS FILE WAS NUMBERED WHEN IT WAS WRITTEN"* 自己解释了改号原因(`:38-43`)。这是**一处编号漂移的注释**(收进 §6.4),不是一条无据的规则。

**并且这条规则不是全局禁令**:086 的理由是**针对 board 这条 miss/hit 会成为存在性预言机的读路由**(`:23-25`);export 早已用 `projectId: projectNo`(`:8269`)且带自己的理由(`:8264-8266`)。**reconcile 的 projectNo 来自调用者自己的请求体**,写回审计不向任何人泄露新信息——这就是 PR-1a 成立的原因。审计写入端本身对 `project_id` **不做形状门**(`audit-store.cjs:20-22`:*"project_id / workspace_id / actor carry caller data and are NOT shape-gated … their discipline lives at the ROUTES"*),所以 PR-1a 的正确说法是「与 export `:8269` 同口径」。

### 1.6 #5516 那道门的限制(逐条重核)

- **开关**:`http-routes.cjs:1341-1343`,仅当 env 恰为 `'true'`;理由长注释 `:1316-1340`。
- **限制一**:目录按租户给 → 最强只能做到「限本租户的项目」(`:1320-1324` 与 `operator-project-directory.cjs:379-384` 双份自陈)。
- **限制二**:放行判据是 `archive_empty`;项目行只由 mvp-persist 写(平台管理员 + 开关双限,且**不在**操作员步骤表里,`workbench-access.cjs:356-364`),一线四步拉取第 4 步本来就 SKIP。**于是本租户一旦归档过任一项目,一线对一个从未归档的新项目发起首次对账就 403**(`:1326-1332` 与 `operator-project-directory.cjs:366-374` 双份自陈)。
- **限制三**:`hasPermission(user,'admin')` 在 `:891-907` 里**包含 `integration:admin`**(`:901`)。门的条件 `:5916` 以 `!hasPermission(user, 'admin')` 短路,所以**租户内的 `integration:admin` 持有者从不受这道门约束**。这与 `isTenantlessPlatformAdmin`(`:914-918`)是两回事。
- **#5516 引入的是两样东西**:(a) 受开关控制的可见性收窄(`:5916-5936`);(b) **不受开关控制**的 `projectNo` 畸形 400(`:5908-5915`,P-13f 在 `:1170-1177` 断言它 *"whatever the flag says"* `:1173`)。「关时等同 main」只对 (a) 成立,`:1334-1340` 自己也是这么写的。(b) 是请求格式的答复,不是权限收窄,任何方案都应保留。
- **轨迹级断言的出处**:P-13 注释头 `__tests__/stock-preparation-operator-pull-gate.test.cjs:887-929`;**P-13f 在 `:1096-1180`**,「关时零目录读」`:1141-1145`(消息在 `:1144`),「操作员轨迹与管理员逐项相等」`:1150-1158`。

### 1.7 第一轮的「关键发现 F0」——保持撤回(精简保留)

F0 主张把 `archive_empty` 换成项目看板的**双库析取**判据。**方向相反**,四条独立证据:

1. **四步顺序**:`apps/web/src/services/integration/stockPreparation/projectSync.ts:23-28` 逐行列出 `1. 试算(dry-run) / 2. 确认(reconcile) / 3. 写入(apply) / 4. 批次存档(mvp-persist)`;后端同一张表 `workbench-access.cjs:251-262`(dry-run/apply)与 `:348-353`(reconcile)、`:356-364`(mvp-persist 留平台管理员);前端 `workbenchAccess.ts:354-357` 同。
2. **双库的第二条析取项由第 3 步写**:`project-board.cjs:574-575` 明写 pull target 是 *"the rows `apply` wrote, which is the ONLY store an operator's own four-step run touches"*。
3. **于是全新项目首次 reconcile 时两条析取全假** → 403 → apply 永远到不了 → pull target 永远没有行 → **该项目永久死锁**。比 #5516 今天更糟。
4. **这正是 C13 当初要破的闭环**:`workbench-access.cjs:328-336` 自陈 *"Every door in the room was painted on"*。

**三条实现级反证,任何一条都足以否掉它**:门在 `:5916-5936`,`action.target` 的取得在其**之后**(`:5938`);门的位置被 P-13 case-2 的硬断言钉死(`:1005-1007`,理由 `:915-917`);要用的 `resolveOwnBoundSheet` / `readPullTargetRowFacts` 只在 `project-board.cjs:687-694` 的 `__internals`(测试专用口)。

**代码里早就写着对这一族改法的反对意见**:`operator-project-directory.cjs:371-374` —— *"Broadening the predicate to 'the ledger has pending rows for this number' would NOT be the fix either … The real fix is a project-ownership store, which does not exist yet."*

**顺带**:`project-board.cjs:585-588` 自陈 `action.target` 是 **deploy 级配置、全部署共享**,`plm_stock_preparation_main` **没有 tenant 列**,行级唯一 scope 就是 `projectNo`;`:602-606`(**WHAT THIS DOES NOT CLAIM**)明确拒绝对「多租户共用一个 target」的场景做隔离断言。**但边界不是零**:`:593-600` 说明 `resolveOwnBoundSheet` 证明调用者自己的 staging project 就是该 sheet 的拥有者,非拥有者根本读不到它(B-13 双向钉住)。

---

## 2. 三方案对比

### 三案共同的前置事实

- **legacy `integration:*` 旁路三案都关不掉,而且宽度**逐路由不同**——【第四轮改:上一轮统一写成「三案都只对 `integration:admin` 持有者仍开着」,这句只对 reconcile 成立;本轮新加的两个守门点门更宽】**

  两个机制叠在一起:① `requireTableActionAccess` 的 **legacy 早返回在 `http-routes.cjs:993-1000`**,它在 operator 分支(`:1001-1012`)**之前** `return user`(`:999`),中间只有 `assertVerifiedTenantClaim(req)`(`:998`,且仅当 `MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED` 打开才非空转);② `hasPermission(user, legacyGate)`(`:891-907`)对不同 gate 认不同的码。逐路由展开:

  | 守门点 | legacyGate | 出处 | 旁路它需要的权限 | 依据 |
  |---|---|---|---|---|
  | `reconcile` | `PLATFORM_ADMIN_GATE` = `'admin'` | `workbench-access.cjs:352`(常量 `:81`) | `role:admin` **或** `integration:admin` | `:901` 放行这两个,`:902` 对 `'admin'` 一律 `return false` |
  | **`apply`** | `'write'` | `workbench-access.cjs:257-262`(路由门 `http-routes.cjs:6130`) | `role:admin` / `integration:admin` / **`integration:write`** | `:901` + `:906`(`'write'` 落到 `permissions.includes('integration:write')`) |
  | **`expansion-start`** | `'read'` | `workbench-access.cjs:280-285`(`legacyGate` 在 `:284`;路由门 `http-routes.cjs:6192`) | 上列三者 + **`integration:read`** | `:901` + `:903-905`(`'read'` = `integration:read` ∪ `integration:write`) |
  | (`dry-run`,若 Q4 决定守门) | `'read'` | `workbench-access.cjs:252-255`(门 `:5738`) | 同上 | 同上 |

  **所以按 §2.5 (a) 把谓词装在「操作员分支」上时,真实的残余口子是**:任意 `integration:write` 持有者仍可对任意项目号跑 `apply`(即全稿称为「唯一形状上直写客户目标表」的那条,写在 `:6146`),任意 `integration:read` 持有者仍可对任意项目号跑 `expansion-start`,**且两者都不落归属行**(legacy 分支根本走不到认领代码)。按上一轮的措辞签字,owner 会以为写面残余只剩 `integration:admin`。

  **修法二选一,请 owner 明选**:(i) **接受这张层级表**——写进裁决书,三案的正确表述是「对 stock-prep operator 关掉;对 legacy 分支按上表逐路由开着」;(ii) **谓词对非 admin 的 legacy 分支也生效**——但要当面写明这一档的强度:legacy 分支**从不解析 operator scope**,租户只剩 `resolveTenantId`(`:1023-1047`,自陈 `:1040-1045` 在无租户声明的部署上是 header 对 header),actor 只剩 `user.id`,即这道门在那一档上是「用请求头声明的租户 + 未经背书的 actor」做归属判断。要连 `integration:admin` 一起拦,则必须改 `:993-1000` 的早返回本身——那会波及**每一条** table-action 路由,不属本设计范围。
- **reopen 清空别人填的值,三案都关不掉**(§1.4-3,Q5-A 已裁决)。归属只换触发者。
- **归属本身的产生与改派,必须自带审计动作 + 一支迁移**。词表是 DB CHECK + 代码双份冻结:`stock-preparation-audit-store.cjs:49-88` 现有 **14 个**动作,`:210-212` 对不在 `ACTION_SET` 的动作直接 **422 fail-closed**。**A 与 C 都必须占两个迁移号:087(表)+ 088(审计动作)。**
  **088 的真正风险不是「撞号」,是静默抹掉**:`086:31-34` 写明 store 常量与迁移必须 SET-EQUAL,且断言按「**最高编号**的那支词表迁移」由 DISCOVERY 解析(`__tests__/stock-preparation-audit-migration.test.cjs:28` `:32-35` `:75`);`086:36-49` 逐字复盘过这件事——原本编号 083 的那支被后合入的 085 全量 re-list 静默抹掉,*"the symptom … would not be a failed migration: it would be every board read 500ing"*(`:42-43`)。**所以 088 必须 re-list 全部 15 个动作;若期间有更高号的词表迁移合入,先红的是那支 set-equality tripwire,不是部署。**
- **四个 projectNo 入口**(§1.3d):谓词不上 `apply` 与 `expansion-start`,归属就只是「队列归属」,不是「项目归属」。

---

### 方案 A —— 项目归属表 + 管理员分配

**表结构/迁移**(migration `087_create_integration_stock_prep_project_ownership.sql`,照 `084` 形制):

```
integration_stock_prep_project_ownership
  id          TEXT PK
  tenant_id   TEXT NOT NULL
  project_no  TEXT NOT NULL
  owner_kind  TEXT NOT NULL CHECK (owner_kind IN ('user','group'))
  owner_id    TEXT NOT NULL          -- 用户 id / 组 id,都是 handle
  source      TEXT NOT NULL CHECK (source IN ('assign','claim','import'))
  assigned_by TEXT
  created_at / updated_at TIMESTAMPTZ
UNIQUE (…)   -- ⚠ 见 §4 Q3:唯一键的形状本身就是待裁决项,不要在 DDL 里预答
INDEX  (tenant_id, owner_id)
```

values-free by construction(全是 handle 与小枚举)。表名前缀符合 `lib/db.cjs:25` 的 `integration_` 白名单。
**外加 migration `088`**:审计动作 `project_ownership_set`,**re-list 全部 15 个**(照 `086:51-60` 的 DROP/ADD 形制),否则分配动作一 `append` 就 422(`audit-store.cjs:210-212`)。

**⚠ 键的量纲问题(反驳指出,采纳)**:`(tenant_id, project_no)` 这把键对**账本**是可证的——账本落在按租户推出的 staging project 里(`resolveIntegrationStagingProjectId(scope.tenantId, undefined)`)。但谓词一旦接到 `apply` / `expansion-start` 上,被保护的对象是 `plm_stock_preparation_main`,那是 **deploy 级共享配置、没有 tenant 列**(`project-board.cjs:585-588`),`:602-606` 明确不保证多租户共用一个 target 时分得开。**所以裁决书必须写明:归属对账本可证,对共享目标表是一条按 `projectNo` 的约定,不是被 schema 证明的边界。** 缓和事实是 `:593-600`:非拥有该 sheet 的租户读不到它,所以跨租户重名只在「一个部署把多个租户指向同一 target」时才成为真问题。

**写入来源三选**:
- *PLM 目录字段* —— **不可行**。项目级 owner 不保证存在;PLM 账号 → MetaSheet 用户 id 的映射 seam 在代码里**不存在**。
- *管理员分配* —— 可行,但要新增分配路由 + 名册 UI,并且在名册建立之前跟 #5516 一样会误 403。
- *首次拉取即认领* —— 那是方案 C。

**门语义**:一个共享谓词 `assertOperatorMayActOnProject({ tenantId, projectNo, actorId })`。它**只需要 (tenantId, projectNo, actorId)**,不需要 `action.target` —— 所以**可以留在各路由的门位置**(reconcile 上就是 `:5916` 原位),P-13 case-2 的**三条**「拒绝前什么都没碰」断言(`operator-pull-gate.test.cjs:1005` adapterPrincipals / `:1006` loadPrincipals / `:1007` auditAppends)在 reconcile 上继续成立。**【第四轮改:上一轮写「四条(`:1005-1007`)」,数字与范围对不上——`:1004` 是那条 403 状态断言,不在「什么都没碰」这一组;要么写「三条 `:1005-1007`」,要么写「四条 `:1004-1007`」,本稿取前者。】** 这是它与被撤回的 F0 在实现上的关键差别。

**对 222 现有数据的影响**:表空 = 没有任何归属声明。必须先定义空表语义——fail-open(等于今天)还是 fail-closed(全线 403)。**建议 fail-open + 一次性回填**,但回填源只有两个,都有坑(§1.5)。

**对四步一线流程的影响**:第 4 步本就 SKIP,A 不改四步;但**新项目第一次跑时归属表里没有行**,又回到 #5516 的坑,除非先回填或允许认领。这是 A 单靠「分配」不成立的根本原因。

**UI 改动**:工作台项目卡片加「负责人」;管理员分配抽屉;确认队列 worklist 加「我的/全部」筛选(`apps/web/src/components/integration/stockPreparation/StockPreparationConfirmationQueueView.vue:184-194`);403 文案(`plainLanguage.ts:642-655` 已有 #5516 那道门的说明段,可照抄形制)。代价见 §2.5 (c)。

**回滚**:整支 revert;表留着无害(无人读)。

**工时 / 可上线时间**:opus **工时 4.4–4.9d**(第四轮 +0.4d:A 的「守门那一半照做不误」,同样要付 §2.5 (b) 的 apply carve-out 账);**可上线时间还要 + owner 裁决 + 一轮人工核对回填结果**。sonnet 不建议独做——跨迁移/插件/前端三层且是权限语义。

---

### 方案 B —— 不做归属,删门,只靠租户级 + 审计

**改动**:删 `http-routes.cjs:1316-1343`(开关)与 `:5916-5936`(调用);**保留** `:5902-5915` 的 400(它不是收窄,见 §1.6)。完整删除面:

- `http-routes.cjs:619` 的 `assertOperatorMaySeeProject` 导入;
- `operator-project-directory.cjs:431` 的导出、`:317-424` 函数本体及其大段注释;
- 随之变成死代码的 `projectArchiveIsEmpty`(`:121-134`)与 `listOperatorProjectDirectory` 的 `includeArchiveEmptiness` 形参(`:212`)——后者目前唯一的调用方就是这道门(`:403-410`);
- `plainLanguage.ts:642-655` 的 403 文案段;
- `operator-pull-gate.test.cjs` 里 P-13 的 armed 半边:**删 case 1 `:971-987`、case 2 `:989-1012`、case 3 `:1014-1026`、case 4 `:1028-1055`**,并**保留** case 5(400,`:1057-1077`)、dry-run/apply 未被收窄那段(`:1079-1093`)与 P-13f(`:1096-1180`)的等价性断言作为回归基线;
  > **【第四轮改:上一轮写成「删 `:964-1094`,保留 case 5」,照行号执行会把要保留的一起删掉】** 这五个 case 与那段收尾**同在一个函数体内**——`theOperatorReconcilesOnlyProjectsItCanSeeArmed` 起于 `:968`、止于 `:1094`(`:964-966` 是它的 flag 包装 `theOperatorReconcilesOnlyProjectsItCanSee`)。所以正确的写法是**拆函数**:把 case 5 与 `:1079-1093` 移进一个不依赖开关的留存函数,再删 case 1-4;而不是按行号区间整段删。
- **G9 两处**:`handoff.test.cjs:2984` 的 `callSites === 11` 要改成 10,**并且**同文件 `:2985-2987` 的 marker 循环点名了 `tableActionConfirmationDecisionsReconcile`——表头一删它就红,两处必须同一支 PR 里改(反驳的 minor,采纳)。

**「靠审计」今天不成立**,B 必须带最小补齐:reconcile 审计补 `projectId`(`:5986-5993`,`reconcileProjectNo` 在 `:5906` 已在手,白拿)。**confirm 半边不能同样处理**,见 §5 PR-1b。

**表结构/迁移**:无。**222 影响**:零。**四步流程影响**:零。
**回滚**:单支 revert。
**工时 / 可上线时间**:sonnet **工时 ~1d**;可上线时间 = 工时(无裁决、无影子期)。

**代价(第四轮按 apply 门的真实分支重写)**:同租户内任何持 `stock-prep:operate ∧ read` 的人,可以
- 对任意项目号发起对账,从而**作废别人项目的待确认行**(§1.4-2)—— 这条**与部署配置无关,今天就是敞开的**,是 B 最实的代价;
- 走大 BOM 通道对任意项目号发起展开(`expansion-start`),消耗源侧读与后台配额;
- **对任意项目号跑 `apply`** —— **但这条要分两种部署说**(§1.4-1):
  - **没有服务端 `stockPrepApplyProduction` 配置**(默认态):对 canonical 的 `plm_stock_preparation_main` **今天已经 403**(`table-actions.cjs:1785-1788`,`regardless of policy`;`:1784` 连缺 objectId 的 target 也按 canonical 判)。此时 B 在这条上的代价**不是**「写进共享目标表」,只是「写进 allowlist 里的非 canonical 沙箱副本」(`:1789-1796`),而这需要沙箱模式已开。
  - **配了 production 策略**(server-config only,`:1818-1827`):canonical 才可能被写,且还要过 `:1838-1852` 的四关。**只有在这类部署上**,「同租户任意操作员可对别人的项目号写客户主表」才是 B 的真实代价。
  - → **B 的答案因此取决于 Q8**。若 owner 答「目标部署不带 production 配置」,B 的代价清单实际上只剩前两条,B 相对 C 的差距比上一轮写的小。

至于「清空别人已填的处理动作/录入值/备注」(§1.4-3),**那是 Q5-A 已裁决的行为,三案都保留,不构成 B 相对 A/C 的劣势**。

---

### 方案 C —— 认领制(首次写即认领,管理员可改)

**表结构/迁移**:与 A 同一张 `087` + `088`,首批行 `source='claim'`;审计动作 `project_ownership_set`,`mode` 区分 `claim` / `reassign`。

**并发写法**:`handoff-store` 的 23505 分支(`:52-55`)与 `SELECT … FOR UPDATE`(**调用在 `:245`**,散文在 `:173` 与注释 `:243-244` —— 反驳的行号更正,采纳)是**游标的 compare-and-set**;migration `084:91-98` 自己说 *"THIS INDEX IS NOT, BY ITSELF, THE CONCURRENCY STORY"*。**一张只做 claim 的表不需要这套。** 但也不能用 `db.cjs` 的 `upsertOne`:`:270-272` 明确拒绝「没有可更新列」的调用(*"use insertOne for insert-only writes"*),而若为绕过它把 `updated_at` 塞进 `updateColumns`,`ON CONFLICT DO UPDATE`(`:276-277`)会连 `owner_id` 一起覆盖 —— **那就是抢占别人的认领**。正确写法是 **`insertOne` + 23505 catch**(照 `handoff-store.cjs:52-55` 的 `isUniqueViolation` 形制)。

**认领点与守门点必须是同一组 —— 这是本轮最重的修正**

反驳指出:第二轮把主认领点放在 `apply` 上,却没给 `apply` 装门。那样非归属人跑 apply 时**写照样发生**,而 `insert + 23505 swallow` 会让认领静默落到原主名下——账本看起来是对的。**修法:凡认领的路由必先守门。**

- **守门点(enforce 时全部装谓词)**:`apply`(`:6128-6133`)、`reconcile`(`:5916` 原位)、`expansion-start`(`:6187-6196`)。
- **认领点(守门通过后写)**:同上三条。
- **`dry-run` 不作认领点也暂不守门**:它无写、会被反复点、是「看看有没有数据」的探查动作;要不要一并守门是 **Q4**。
- **`confirm` 的守门是独立一支**,因为它撞审计次序(见 PR-6c 与 Q7)。
- **jobId / decisionId 键控的路由不单独装门**:它们绑定在创建时已过门的 job / 已有 `projectNo` 的账本行上。

**【第四轮补:代码里有一条与「谓词上 apply」正面相反的既有立场,必须当面引一次】**

`operator-pull-gate.test.cjs:1079-1080` 的注释写着 *"...and the OTHER two steps of the operator's own four-step run are NOT narrowed by this: only reconcile carries a projectNo whose ledger rows another person owns"*,`:1082` 的循环对 `[DRY_RUN, APPLY]` 各跑一次外部项目号,断言 `notEqual(code, 'STOCK_PREPARATION_RECONCILE_PROJECT_NOT_VISIBLE')`(消息 `:1091` *"dry-run and apply keep the behaviour they had"*)。

- **它当时为什么成立**:#5516 那道门保护的是**账本行**——「别人拥有的 PENDING 行会被这次 reconcile 改判」。dry-run 不写;apply 写的是目标表而不是账本,当时也没有人把目标表当成需要按项目收窄的对象。在那个问题定义下,这句话是对的。
- **它现在为什么不成立**:本设计要收窄的对象换了——不是「谁的账本行被重写」,而是「**谁被记为这个项目的负责人**」。而认领事实的三个来源里,apply 覆盖「非 held」那条分支、`expansion-start` 覆盖大 BOM 通道,两者都不经过 reconcile(§2 C「覆盖面」)。**认领点 ⊆ 守门点**这条组织原则一旦成立,这句注释描述的不变式就是 PR-5 要终结的那一条。
- **守卫上的后果(记在 PR-5 头上)**:若归属 403 **复用**同一 `STOCK_PREPARATION_RECONCILE_PROJECT_NOT_VISIBLE`(前端文案表里只有这一条,`plainLanguage.ts:652-655`),enforce 时 `:1082-1092` 直接红;若**另起新 code**,该断言按字面仍绿——**但那是假绿**:行为变了而断言没测到。两种走法都要求 PR-5 **重写 `:1079-1080` 的注释并把该循环改成正向断言**(apply 带外部项目号被新 code 拒、dry-run 不被拒),而不是靠「默认 shadow 所以现在是绿的」蒙过去。

**覆盖面(反驳证伪的地基句,已改正)**

第二轮写「apply 是操作员必经且每个项目都会跑」。**这句是假的。** `projectSync.ts:759-767`:`if (held) { /* Deliberately NOT applying with acceptManualConfirmHold */ record(result(3,'apply','skip','WRITE_HELD_FOR_CONFIRMATION',…)); record(result(4,…)); return done() }`,而 `held` 正是 `:722` 定义、`:723-724` 用来决定跑不跑 reconcile 的那个条件。**正确表述**:

> 在一次四步跑里,**reconcile 与 apply 互斥**:计划被扣住(held)的项目走 reconcile、不到 apply;没被扣住的项目跳过 reconcile、走 apply(`:768-772` 的 `WRITE_NO_PLAN` 是第三种落空)。**两者并集覆盖两条分支**,`expansion-start` 覆盖大 BOM 通道。**没有任何单点覆盖全部项目。**

补充:`held` 项目在人把队列清完之后,下一轮 dry-run 可能不再 held,那时才会跑到 apply——所以「谁跑了这个项目」在时间上仍会由这三个点之一先记下。

**还有一条独立证据说明为什么不能只押 reconcile**:确认队列里那颗「重新扫描」按钮**一线看不见** —— `StockPreparationConfirmationQueueView.vue:145-153` 的 `v-if="can('confirmationQueue.reconcile')"`,而该 capability 的 code 是 `PLATFORM_ADMIN_GATE`(前端 `workbenchAccess.ts:245-249`、后端 `workbench-access.cjs:194-200`,两侧被 F-01 钉成深等)。一线触发 reconcile 的唯一路径是四步面板的 held 分支。

**门语义**(比 A 多一条放行):
1. 归属行命中 → 放行;
2. **该项目在归属表里一行都没有** → 认领 + 放行(新项目首次永不 403);
3. 其余 → 403,文案是「这个项目现在归 X,点这里申请加入」而不是「不存在」。

**与 #5516 `archive_empty` 的区别**:后者判的表由**平台管理员**写(mvp-persist)、一线永远碰不到;前者判的表由**一线自己的动作**写。这正是当初那条判据失效的原因。

**占坑面**:`dry-run` 不设门时,`apply` 仍需 token(`:6149`),`reconcile` / `expansion-start` 会真的读源——所以枚举抢注是「贵但可行」。shadow 期能观察到;enforce 后需要一条附加条件(见 Q6)。

**对 222 现有数据的影响**:第一次跑 r14 会把当时在场的操作员写成归属人。**必须有影子期**:`shadow` 只记录、只计数、永不 403,跑够一轮再切 `enforce`。

**对四步一线流程的影响**:四步不变;第 2/3 步后多一次幂等写(单行 insert + 23505 catch,可忽略)。

**UI 改动**:项目卡片显示「负责人:我 / 某某」;非负责人的按钮 disabled + 申请文案;管理员改派抽屉 + **后端改派路由**。见 §2.5 (c)。

**工时 / 可上线时间**:opus **工时 4.3d**(第四轮由 3.9d 上调,+0.4d 是 PR-5 的 apply carve-out,§2.5 (b);不含 confirm 收窄与读面收窄两支可选);**可上线时间还要 + 一轮 r14 影子期观测**。

---

### 2.5 三案都要付的守卫账(本轮补第 6 条)

**(a) `G9` 十一处调用点计数守卫 + 表头点名 —— 源码级,改一处就红**
`__tests__/stock-preparation-handoff.test.cjs:2971` 数 `http-routes.cjs` 里 `resolveOperatorValueScope({` 的出现次数(现为 11:`:1007 / :5768 / :5923 / :7485 / :8115 / :8156 / :8232 / :8342 / :8428 / :8676 / :8950`),`:2984` `assert.equal(callSites, 11, …)`;`:2985-2987` 的 marker 循环还要求 `operator-scope.cjs` 表头逐个点名 `stockPreparationHandoffStatus / stockPreparationHandoffAdvance / stockPreparationOperatorProjectBoard / tableActionDryRun / tableActionConfirmationDecisionsReconcile`(现枚举第 10 条起于 `operator-scope.cjs:108`)。

- **B 删门** → 11 → 10,**红**;并且 `:2985` 的 marker 仍点名 reconcile,**表头条目一删也红** —— 两处必须同批改。
- **C/A**:apply 与 expansion-start 各需在操作员分支另起一次 scope(不能复用 `requireTableActionAccess` 内那次,`:1004-1006` 说明它不外传),reconcile 上的 `:5923` 可复用但要移出 #5516 的 flag 分支 → **11 → 13**,**红**;表头要新增两条并说明。**注意:G9 只是这两条新 scope 的第一笔账,不是全部——它们同时把两个 handler 拖进 (b) 的源码派生集,那笔账见下。**
- **不要试图「合并成一次 scope 解析」省掉计数**:那会让 legacy 分支也多一次 host membership 调用,把今天能过的调用者变成可能被拒 —— 是行为变化,不是重构。

**(b) 逐 handler 源码扫描守卫 —— 决定「list 能不能被收窄」**
`__tests__/stock-preparation-tenant-scoped-write-guard.test.cjs` 的 value-bearing 集合从源码**派生**(`:394` + `:396`,派生规则 = 谁调了 `resolveOperatorValueScope`),然后对每个成员断言:`:482-488` 不得出现 `resolveTenantId(`、`:491-497` 不得出现裸 `user.tenantId`。

→ list 想加谓词就得调 scope;它一调就进派生集合,而它现在恰恰用 `resolveTenantId`(`:8067`)——立刻红。**但守卫自带一条例外通道**(反驳的 minor,采纳):`:444-446` 的 `VALUE_BEARING_READS_WITH_GATED_LEGACY_TENANT` 允许一个 handler 在 gated 三元里调**恰好一次** `resolveTenantId`(断言 `:468-480`,`:475-479`),`tableActionDryRun` 就是靠这条留在集合里的(源码形态 `:5785`,理由 `:427-442`)。所以 **Q0 是三选一**,不是二选一。

**【第四轮补:同一笔账 PR-5 也要付,而且落在必做支上 —— 上一轮只为 list(可选支)记了,把 apply 漏了】**

派生规则是**源码扫描**:`:315-325` 用 `/\n {4}async ([A-Za-z0-9_$]+)\(req, res\) \{/` 逐个取出 4 空格缩进的 handler,**只要函数体里出现 `resolveOperatorValueScope(` 就入集**;`:394` 是派生结果,`:404-412` 断言**派生集必须逐项等于 PINNED 集**(现有 10 名,`:328-392`)。`tableActionApply`(`http-routes.cjs:6128`)与 `tableActionLargeBomExpansionJobStart`(`:6187`)**都是 4 空格缩进的 handler**,所以 PR-5 一往它们体内加 scope,立刻发生两件事:

1. **两者进派生集 → `:404-412` 红**,必须显式写进 PINNED。这一步是可接受的、也是守卫设计的本意(*"a new value-bearing read must be pinned here"*)。
2. **`tableActionApply` 随即吃到 `:482-488` 的通杀断言**——「value-bearing 成员不得出现 `resolveTenantId(`」——而 apply 自己 `:6133` 就是 `const applyTenantId = resolveTenantId(req, {})`(其结果又在 `:6139` / `:6182` 被用两次)。**直接红。**

**上一轮为 list 列的三条出路,在 apply 上只剩一条**:

- ✗ (i)「不收窄」不适用:守门点已定为 apply。
- ✗ (ii)「先做 #5445 形状迁移,把租户推导整体换成 scope」**在 apply 上不可用**:legacy `integration:write` 持有者在 `:993-1000` 早返回、根本不过 scope(见 §2 前置事实 1 的层级表),把 `:6133` 整体换成 scope 会改变他们今天的行为——那是行为变化,不是重构。
- ✓ (iii) **唯一可行:把 `tableActionApply` 加进 `:444-446` 的 `VALUE_BEARING_READS_WITH_GATED_LEGACY_TENANT`**,并按 `:468-480` 的形制把 `:6133` **逐字**改写成 gated 三元(`:472` 断言的是**精确源码串**,`:475-479` 断言 `resolveTenantId(` 在该 handler 体内**恰好出现一次**)。形如 `const applyTenantId = applyScope ? applyScope.tenantId : resolveTenantId(req, {})`,且这个字面串要同步写进 map 的 value。

**`tableActionLargeBomExpansionJobStart` 只需进 PINNED**:它体内没有 `resolveTenantId(` 字面量(租户经 `largeBomJobScope`→`scopedInput`→`:1250` 间接推导),`:482-488` 可过;但 `:491-497`(不得直读 `user.tenantId`)与 `:499-504`(必须解析 operator scope)同样会对它生效。

**所以 PR-5 的准确描述不是「另起一次 scope」**,而是:**改 apply 值路径的租户推导形态 + 新增一条 carve-out 条目 + 两处 PINNED 补录 + G9 两处**。这四件事上一轮的 1.0d 与其 PR 描述都没有覆盖 —— 本稿据此把 PR-5 上调到 **1.4d**(见 §5)。

**并且要分清两类账的红法**:(a)(b) 是**源码级守卫**,PR-5 合入即刻红,**与三态开关无关**;(d) 与 P-13 一族是**行为级守卫**,默认 `shadow` 时不红、`enforce` 时才红。不要用「默认 shadow」去回答 (b) 的红。

**(c) `F-04` presence == grant 等式 —— 决定「按钮禁用」怎么做**
`apps/web/tests/stockPrepPermissionMatrix.spec.ts:283-284` 断言前端 `STOCK_PREP_WORKBENCH_CAPABILITIES` 与后端逐项深等;`:24` 的 F-04 要求「渲染出来的 control id == 授予的 control」**双向相等**,`:368` 是它的实现。而 `workbenchAccess.ts:204-209` 明写:运行时另有门控的控件必须 `control: null`,否则「F-04 会为一个正确的 UI 报红」;`apps/web/tests/StockPreparationHandoff.spec.ts:10-16` 与 `:305`(H-00)就是 handoff 为此另写的一整套见证。

→ **「非负责人按钮禁用」正是运行时门控**。UI 那一支不是「加一行 capability」,而是:manifest 两侧同步 + `control: null` + **另写一套 `StockPreparationOwnership.spec.ts` 见证**。

**(d) `P-13` armed 半边 —— 全部记在 PR-8 头上(反驳指出的记漏,采纳)**
第二轮写「本稿 PR-2 不再动判据,所以这些在 A/C 路线上保持绿」,但 PR-8 自己写着 enforce 时把 `archive_empty` 换成归属谓词——账只是从 PR-2 挪到了 PR-8,并没有消失。换判据会红的:

- case 1 `:971-987`:「目录里有这个号 ⇒ 不被 NOT_VISIBLE 拒」—— 归属人是同事的项目会被拒 ⇒ **红**;
- case 2 `:989-1012`:「目录里没有这个号 ⇒ 403 NOT_VISIBLE」—— C 的第 2 条放行会放行 ⇒ **红**;
- `:1009-1012` 的正控制 `assert.ok(projectSheetLookups(refused) > 0, '…so P-13f\'s "zero lookups" measures the flag')` —— 归属谓词读的是 SQL 归属表、不再 lookup 项目 sheet ⇒ 变 0 ⇒ **红**,且这条一红,P-13f `:1141-1145` 的「零目录读」度量基准同时失效;
- case 4 两条 `:1028-1039` / `:1041-1055`(空档案放行)—— 语义仍成立但拒绝码与读的表都变了,断言消息与前置需要重写。
- **【第四轮补,上一轮漏了同一函数的最后一段】** `:1079-1093`(注释 `:1079-1080`,循环 `:1082`,消息 `:1091`)钉着「dry-run 与 apply **不**被这道门收窄」。**这段的账记在 PR-5 而不是 PR-8**(PR-5 才是给 apply 装门的那支),两种走法及其「复用 code 直接红 / 新 code 假绿」的分辨见 §2 C 末尾那段;**PR-8 切 enforce 时它会第二次成为焦点**,因为那才是拒绝真正发生的时刻。

**所以 PR-8 不是一行改默认值,它要重写 P-13 armed 半边并重新给 P-13f 找一个「门没跑」的度量。**

**(e) `S-02a/S-02b` 目录响应双冻结(仅当 UI 经目录路由取「负责人」时会红)**
`operator-scope-tripwires.test.cjs:469-486`(S-02a:顶层 6 键集 `:473-480` + 每行十键投影 `:482-485`)与 `:488-504`(S-02b:`owner` 值 `:493` 与 `"owner"` 字段名 `:496` 都不得出现)。→ 项目卡片的「负责人」**必须走新的归属路由**,不能给目录路由加字段。

**(f) 【本轮新增】staging 推导形态被逐字钉死 —— 谓词的实现写法不自由**
同一份 `tenant-scoped-write-guard.test.cjs`:

- `:458-463` 把 `tableActionConfirmationDecisionsReconcile` 的 staging 推导**钉成恰好两种形态**(`resolveIntegrationStagingProjectId(reconcileScope.tenantId, undefined)` 与 `…(tenantId, undefined)`),断言 `:507-520`(`:516-519`:*"grew a staging derivation nobody reviewed"*)。→ 归属谓词若在 reconcile 里再推一个 staging project,**直接红**;归属表是 SQL 表、不经 staging,这条因此可过,但实现必须刻意避开。
- **【第四轮补:同一处断言还有一条方向相反的要求,它打的是 PR-8 而不是 PR-4】** `:511` 断 `calls.length > 0`、**`:512-515` 断 `calls.includes(expected[0])`** —— 即 `resolveIntegrationStagingProjectId(reconcileScope.tenantId, undefined)` 这个字面形态**必须在场**。而 reconcile 里这个形态**只有一处**:`http-routes.cjs:5932`,就在 `assertOperatorMaySeeProject(…)` 的调用参数里(`:5929-5935`)。**PR-8 把 `archive_empty` 换成读 SQL 归属表,就是把这次调用连同 `:5932` 一起拿掉 → `:512-515` 立刻红。** 出路有二:①enforce 后仍保留一次 reconcileScope 的 staging 推导(需要有真实用途,不能为过测试而留);②把 `:458-463` 的期望对改成新形态,并在 PR 里说明为什么这次改动是被审阅过的。**记入 PR-8 的守卫清单,与 §2.5 (d) 同一支。**
- `:523-532` 对 `VALUE_BEARING_READS_WITH_INLINE_STAGING` 成员(含 `stockPreparationConfirmationDecisionsConfirm` `:422`)断言**每一处** staging 推导必须逐字是 `resolveIntegrationStagingProjectId(scope.tenantId, undefined)`。→ PR-6c 若要在 confirm 里读账本行拿 `projectNo`,那次读的 staging 推导**必须写成这一个字面形态**,否则红。

---

### 对比小结

| | A 分配制 | B 删门 | C 认领制 |
|---|---|---|---|
| 新表/迁移 | **2**(087 表 + 088 全量 re-list 词表) | 0 | **2**(同 A) |
| 归属来源可信吗 | ✗ 需要一个不存在的维护流程 | — | ⚠ **「谁跑了这个项目的第一次写」是真实事实**,但必须 `apply ∪ reconcile`(互斥双分支)`∪ expansion-start` 三点并集;单点都不覆盖 |
| 新项目首次会不会误 403 | 会(除非回填) | 不会 | 不会(第 2 条放行) |
| 能否分开同厂两个同事 | 能 | 否 | 能(取决于 `owner_kind`) |
| 能否关掉「作废别人待确认行」(§1.4-2) | 对 operator 能;**对 legacy `integration:admin` 否**(reconcile 的旁路层级) | 否 | 同 A |
| 能否关掉「对别人项目号 apply 写目标表」(§1.4-1) | 需谓词上 apply + 大 BOM;**对共享 target 是约定不是证明**;**且旁路层级降到 `integration:write`**(§2 前置事实 1) | 否 —— **但无 production 配置的部署上,canonical 表今天已被 apply 门 403(§1.4-1、Q8)** | 同 A |
| 能否关掉「清空别人填的值」(§1.4-3) | **否** | **否** | **否** —— Q5-A 已裁决 |
| 守门点数量 | 3(apply / reconcile / expansion-start),confirm 与 dry-run 待裁决 | 0 | 同 A |
| 触发的源码级守卫(§2.5) | (a)11→13 +(c)+(f)[+(b) 若收窄 list][+(d) 若 enforce 换判据] | (a)11→10 + marker +(d) 整段删 | 同 A |
| 222 上线风险 | 中(回填口径) | 无 | 中低(影子期可控) |
| **工时** | opus 4.4–4.9d | sonnet ~1d | opus 4.3d |
| **可上线时间** | 工时 + owner 裁决 + 一轮人工核对回填 | = 工时 | 工时 + 一轮 r14 影子期 |

---

## 3. 推荐与理由(重写)

**推荐:C(认领制),按「守门点 ⊇ 认领点」的形状做;第一步仍是补审计、不动 #5516。**

**第 1 步(立刻,与裁决无关)**:只做 **PR-1a** —— reconcile 审计补 `projectId`(`:5986-5993`,取 `:5906` 已算好的 `reconcileProjectNo`,与 export `:8269` 同口径)。#5516 的门**原地不动、保持默认关**。

> **为什么不先删门**:「一个默认关、放行判据还是错的门是负资产」这句话在**不做归属**时成立,在**要做归属**时不成立 —— C 的谓词恰好装在同一位置(`:5916`),删了又装要付两次 G9 计数(§2.5 (a))与 P-13 半边的账(§2.5 (d))。所以这是一个**条件分支**:
> - **owner 裁 C(或 A)** → 门留着不动,零代码成本;在 PR-8 里一次性把 `archive_empty` 换成归属谓词并重写 P-13 armed 半边。
> - **owner 裁 B** → 这时才整段删门,按 §2 B 的完整删除清单 + §2.5 (a)(d) 的守卫账。

**第 2 步(裁决后)**:上 C 的影子模式,跑一轮 r14 再切 enforce。

**理由**:

- 归属这件事今天**没有任何可信来源**:PLM 没有项目级 owner;管理员没有在维护名册;账本没有作者列(§1.1);唯一有「谁动过这个项目」的两处审计(export `:8269`、handoff `:8801`/`:8833`)覆盖不到拉取本身。**唯一真实、每个跑过的项目都会发生的事实是「谁跑了它的第一次写」——而那是 `apply`(非 held)或 `reconcile`(held)之一,再加大 BOM 的 `expansion-start`。** 那就是认领。
- A 需要先凭空建一套名册,并且在名册建立之前跟 #5516 一样误 403;这是把成本前置到最忙的时候。
- B 单独不够:「同租户任意操作员可对任意项目号发起对账、作废别人的待确认行」这条**与部署配置无关,今天就是敞开的**。至于第三轮稿加的第二条「**可对任意项目号跑 apply,把行写进 deploy 级共享目标表**」,**第四轮按 apply 门的真实分支降级了它的强度**:在没有服务端 production 策略配置的部署上,canonical 的 `plm_stock_preparation_main` 今天已被 `table-actions.cjs:1785-1788` 无条件 403(见 §1.4-1 与 §2 B 代价)。**这条论据只在答 Q8 = 「带 production 配置」时才成立**;推荐仍是 C,但 B 与 C 的差距取决于 Q8。
- **但请注意**:第一轮拿来否定 B 的主要论据「清空别人填的值」(§1.4-3)**是错的** —— 那是 Q5-A 已裁决的保守默认,三案都保留。
- 如果 owner 认为单厂单班的现实里这些都不是问题,**B 仍是完全正当的选择**,而且是三案里唯一「可上线时间 = 工时」的那个。

**三案共同的、必须写进裁决书的两条免责**:

1. **没有一个方案能挡住 legacy `integration:*` 旁路,而且宽度逐路由不同**——**【第四轮改,上一轮只写了 `integration:admin`,在新增的两个守门点上把保证写强了】**:`reconcile` 的旁路要 **`integration:admin`**(legacyGate `'admin'`,`workbench-access.cjs:352` + `http-routes.cjs:901-902`);**`apply` 只要 `integration:write`**(legacyGate `'write'`,`workbench-access.cjs:261` + `:906`);**`expansion-start`(以及 Q4 若决定守门的 `dry-run`)只要 `integration:read`**(legacyGate `'read'`,`workbench-access.cjs:284` / `:255` + `:903-905`)。三者都在 `requireTableActionAccess` 的 legacy 早返回 `:993-1000` 里 return,**走不到操作员分支,也走不到认领代码**——即这些调用者既不被谓词拦,也不会落归属行。**完整层级表与两条修法(接受层级 / 让谓词覆盖非 admin legacy 分支,并写明那一档只有 header 级租户 + 未背书 actor)在 §2 前置事实 1,请 owner 明选一条写进裁决书。** 要连 `integration:admin` 一起拦,得改 `:993-1000` 的早返回本身,那是另一份设计。
2. **归属对账本可证,对 `plm_stock_preparation_main` 只是约定**:目标表是 deploy 级共享、无 tenant 列(`project-board.cjs:585-588`、`:602-606`)。在一个部署把多个租户指向同一 target 的场景里,按租户键的归属行表达不了「这些行归谁」。

---

## 4. Owner 需要回答的问题

**Q0(必须先答)**:**读面要不要一起收窄?** list(`:8054-8077`)今天的租户底座就比同族弱一档(§1.4b)。要在它上面加谓词有**三条路**(§2.5 (b)):(i) 不收窄读面,只收窄写面 —— Q0 就此关闭,PR 少一支;(ii) 先做一次 #5445 形状的 scope 迁移,再接谓词;(iii) 按 `tableActionDryRun` 的 gated-ternary 形制进 `VALUE_BEARING_READS_WITH_GATED_LEGACY_TENANT` 例外,并说明为什么 list 也配得上那个例外。**建议 (ii)**,因为 list 不像 dry-run 那样有「legacy read 一族必须保住」的理由。

1. **备料项目的归属,是一个人,还是一个班组/部门?** 两班倒时同班组要不要自动互相接手?(决定 `owner_kind`,以及 C 会不会锁死同事)
2. **归属由谁产生:一线自己认领(先到先得),还是由计划/技术指派?**(决定 A vs C)
3. **一个项目允许几个负责人同时在?交接期怎么表达?** —— **唯一键的形状就是这个问题的答案**,请先答再定键。**并且请一并答:共享目标表上跨租户重名怎么办**(§2 A 的键量纲问题;若部署只有一个租户指向该 target,答「不适用」即可)。
4. **`dry-run` 要不要一起守门?** 它无写,但它是「有没有这个项目的数据」的探查。守门 = 更严、G9 再 +1 且要给 legacy `integration:read` 分支留路;不守门 = 非归属人可以试算但不能写。**非负责人对别人的项目,应该是「看不见」「看得见但不能动」还是「能动但留痕」?** 这同时决定 Q0 与 value-entry / export 这两条**带值的读**要不要一起收窄。
5. **222 上已有项目的归属,允许系统自动回填吗?** 回填源只有两个且都有坑:`handoff.updated_by`(表自己声明「不是权限记录」,`084:102-103`)与审计 `actor`(只覆盖 export / handoff)。
6. **认领的抢注面怎么防?** `reconcile` / `expansion-start` 可枚举。选一:(i) 认领只在本人已成功 dry-run 过的项目上成立;(ii) 每人每日认领次数上限;(iii) 不防,靠影子期观测 + 事后改派。
7. **(新增)`confirm` 要不要按归属收窄?** 收窄的代价是明确的(见 PR-6c):要在审计 intent 行**之前**插一次账本读,而 confirm 的注释 `:8154-8155` 与 `:8165-8166`、`:8175-8176` 三处正好把「拒绝前不留痕」与「畸形请求仍留痕」两条不变式钉在那个位置。本稿给出了一个能同时保住两条的写法(软查找),但**语义后果要 owner 拍**:收窄后,同班组同事不能替不在场的负责人清队列。
8. **(第四轮新增;B 与 C 的取舍直接压在它上面)目标部署(含 222)带不带 `context.config.stockPrepApplyProduction` 服务端配置?** 只读复核代答不了,而它决定 apply 今天是不是真的能写 canonical 的 `plm_stock_preparation_main`:**不带** → 该表的 apply 今天已 403 fail-closed(`stock-preparation-table-actions.cjs:1785-1788`,*"regardless of policy"*;沙箱那一半只能打开 allowlist 里的**非** canonical 副本,`:1789-1796`),于是谓词上 apply 是纵深防御 + 留认领事实,B 的代价清单少一条(§2 B 代价);**带** → 它是本设计里唯一在拦客户主表写入的门,PR-5 的优先级应高于 PR-6/PR-7。顺带请确认 `stockPrepApplySandbox` 是否配、allowlist 里有哪些 objectId(仍是 values-free 的 id,不涉及数据)。

---

## 5. 最小 PR 拆分(采用 C;每支可独立合、默认关)

| # | 内容 | 模型 | 工时 | 默认行为 | 回滚 |
|---|---|---|---|---|---|
| **PR-1a** | reconcile 审计行补 `projectId: reconcileProjectNo`(`http-routes.cjs:5986-5993`;取值在 `:5906`)+ 1 条断言。理由与 board 的 `project_id = NULL` 不冲突(§1.5 末段),与 export `:8269` 同口径;`audit-store.cjs:20-22` 明写该列不做形状门、纪律在路由侧 | sonnet | 0.3d | **权限与拒绝语义无变化;审计行内容有变化**(reconcile 行由 `project_id` NULL 变为带 projectNo,而审计有自己的读路由 `:208`、且 `:8507-8512` 已按 `project_id` 过滤读回) | revert |
| **PR-1b** | **confirm 的 projectId —— 单独一支,形状要改**。`:8167-8179` 的 `audit.append` 刻意排在 `confirmConfirmationDecision`(`:8180`)之前(`:8165-8166`),`:8175-8176` 另写明「请求畸形时审计行仍然落地」。→ **改成:在 confirm 成功之后追加一条 `projectId` 已知的审计行**(`mode: 'confirmation_decision_committed'`),原 intent 行一字不动。**【第四轮补:与 PR-6c 互斥,不要两支都做】** PR-1b 的整个立论是「confirm 在 `:8167` 之前拿不到 `projectNo`」;而 PR-6c 恰恰要在 `:8167` **之前**做一次 `decisionId → projectNo` 的软查找。**若 Q7 答「confirm 也收窄」,`projectNo` 在 intent 行之前就已在手,PR-1b 这条追加行即为冗余** → 那时应改为直接把 `projectId` 填进原 intent 行,PR-1b 被 PR-6c 吸收(工时并入 PR-6c,合计 −0.5d);Q7 答「不收窄」时 PR-1b 按本行独立做 | opus | 0.5d | 多一条审计行 | revert |
| **PR-2** | **条件分支,由 owner 裁决决定**:<br>· 裁 C/A → **只改注释与文档**,#5516 原地不动;**并正式吸收 §6 的五处注释修正**(第四轮:§6 末尾原来单独记了 sonnet 0.2d、PR-2 又写「顺带修」,两个数字一个都没进合计;现统一由 PR-2 承担,C 分支 0.1d→**0.2d**)<br>· 裁 B → **整段删门**,按 §2 B 的完整删除清单(**注意是拆函数保留 case 5 `:1057-1077` 与 `:1079-1093`,不是按 `:964-1094` 整段删**)+ §2.5 (a) G9 `:2984` 11→10 **且** `:2985-2987` marker 同改 + §2.5 (d) P-13 armed 半边 case 1-4 删 | sonnet | **0.2d** / 1d | 二选一,不并存 | revert |
| **PR-3** | migration `087`(归属表,唯一键待 Q3 定)+ migration `088`(审计动作 `project_ownership_set`,**re-list 全部 15 个动作**,照 `086:51-60`;风险是被更高号词表迁移静默抹掉,先红的是 `audit-migration.test.cjs:75`)+ store(**`insertOne` + 23505 catch**,照 `handoff-store.cjs:52-55`;**不要** `upsertOne`,`db.cjs:270-272`) | sonnet | 0.7d | **无任何路由调用**,纯新增 | revert;表留着无人读 |
| **PR-4** | 谓词 `assertOperatorMayActOnProject({tenantId, projectNo, actorId})` + 三态开关 `MULTITABLE_STOCK_PREP_PROJECT_OWNERSHIP=off\|shadow\|enforce`(默认 `off`)。**先只接 reconcile 一条**,装在 `:5916` 原位置(不需要 `action.target`,P-13 case-2 的**三条**「什么都没碰」断言 `:1005-1007` 保持绿)。含 §2.5 (a) G9 与表头、§2.5 (f) 不得新增第三种 staging 推导(`tenant-scoped-write-guard.test.cjs:507-520`),**且必须保住 `:5932` 那个字面形态在场(`:512-515`)** | opus | 0.7d | `off` 时轨迹与 PR-3 后逐项相等 | 开关回 `off` |
| **PR-5** | **守门 + 认领同批**:谓词接 **`apply`**(`:6128-6133`)与 **`expansion-start`**(`:6187-6196`);三条路由(apply / reconcile / expansion-start)在**守门通过后**幂等认领。**【第四轮:守卫账补齐,描述与工时随之改】** 这一支不是「另起一次 scope」那么轻,四件事必须一起做:① **G9 11→13** + `operator-scope.cjs` 表头新增两条;② 两个 handler 进 `tenant-scoped-write-guard.test.cjs` 的 **PINNED 集**(`:404-412` 断言派生集 == PINNED,派生规则 `:315-325` 是源码扫描,两个 handler 都是 4 空格缩进,加了 scope 就自动入集);③ **`tableActionApply` 必须加进 `:444-446` 的 `VALUE_BEARING_READS_WITH_GATED_LEGACY_TENANT`,并把 `http-routes.cjs:6133` 的 `const applyTenantId = resolveTenantId(req, {})` 逐字改写成 gated 三元**——否则 `:482-488` 的通杀断言立刻红,而「先做 #5445 形状迁移」这条出路在 apply 上不可用(legacy `integration:write` 持有者在 `:993-1000` 早返回、根本不过 scope,整体换成 scope 会改他们的行为);`:472` 断精确源码串、`:475-479` 断 `resolveTenantId(` 在该 handler 内恰好一次;④ **重写 `operator-pull-gate.test.cjs:1079-1093`**(注释 `:1079-1080` + 循环 `:1082` 钉着「dry-run 与 apply 不被收窄」,正是本支终结的不变式;复用同一 error code 直接红,另起新 code 则是**假绿**,两种都要求重写而不是绕过)。再含 Q6 裁决的抢注限制。**注意 ①②③ 是源码级守卫,合入即刻红,与三态开关无关**(§2.5 (b)) | opus | **1.4d**(原 1.0d + 0.4d carve-out/pin/断言重写) | 仍 `shadow`(只记录不拒绝) | 开关 |
| **PR-6** | **管理员改派路由** + 审计 `project_ownership_set` / `mode: 'reassign'`。**【第四轮补:先定它解不解析 scope】** 改派路由若调 `resolveOperatorValueScope`,G9 计数再 +1 且它自己也进 `tenant-scoped-write-guard` 的派生集(要 PINNED、要过 `:482-488`/`:491-497`);**建议做成平台管理员门(`requireAccess(req,'admin')`)、不解析 operator scope**,则 G9 与派生集都不动。PR 描述里必须写明选了哪一条 | opus | 0.5d | 受同一开关 | 开关 |
| **PR-6c** | **仅当 Q7 答「confirm 也收窄」**:谓词接 confirm。**必须按这个形状写**:① 检查放在 `:8167` 的 audit intent **之前**(与 `:8154-8155` 的既有先例一致:scope 的拒绝也在 append 之前,拒绝不留痕);② 由 `decisionId` 解 `projectNo` 的那次读**必须是软的** —— 匹配到恰好 1 行且归属他人才 403,0 行/多行**不判**、原样落到今天的路径,这样 `:8175-8176` 的「畸形请求仍留痕」与模块自己的 404/409(`confirmation-decisions.cjs:1260-1266`)全部保留;③ 那次读的 staging 推导必须逐字写成 `resolveIntegrationStagingProjectId(scope.tenantId, undefined)`(§2.5 (f),`tenant-scoped-write-guard.test.cjs:523-532`);④ 账本模块**需要新增一个正式导出**(现有 `module.exports` `:1574-1608` 不含按 decisionId 读 `projectNo` 的口,`readCell`/`resolveScopedLedger` 只在 `__internals` `:1599-1607`);⑤ **【第四轮补:软查找必须连「这次读本身失败」一起软掉】** ② 只覆盖了 0 行 / 多行,没覆盖读**抛错**。今天 confirm 在 multitable 不可用时仍会先落 intent 审计行(`:8167-8179` 排在 `:8180` 之前,理由 `:8165-8166`);把账本读插到 `:8167` 之前后,一次 multitable 故障会把「有审计行 + 5xx」变成「无审计行 + 5xx」——正是 `:8175-8176` 那条不变式的同族。所以规则是 **fail-open on lookup**:该次读抛错也放行,**只有「恰好 1 行且归属他人」才 403**;并加一条断言钉住它 | opus | 0.7d | 受同一开关 | 开关 |
| **PR-6b** | **仅当 Q0 答「读面也收窄」**:list 从 `resolveTenantId`(`:8067`)按 Q0 选定的路子处理(建议 #5445 形状迁移),再接谓词。含 §2.5 (b):list 进派生集合后 `:404-412` 要补 PINNED、`:482-488` / `:491-497` 必须同时变绿。**【第四轮补:G9 预算要接上】** 若 PR-5 已把计数推到 13,本支让 list 调 scope 就是**第 14 处**——`handoff.test.cjs:2984` 的 `assert.equal(callSites, 11, …)` 与 `:2985-2987` 的表头 marker 要**再改一次**(PR-5 改过一次、这里第二次),PR 描述里写明当时的基数 | opus | 0.7d | 迁移本身无行为变化(claim flag 关时);谓词受开关 | revert / 开关 |
| **PR-7** | UI:项目卡片负责人(**走新的归属路由,不给目录路由加字段** —— §2.5 (e))、非负责人按钮禁用 + 申请文案、管理员改派抽屉;manifest 两侧同步 + **`control: null`**(§2.5 (c))+ **另写一套 `StockPreparationOwnership.spec.ts` 见证**(照 `StockPreparationHandoff.spec.ts:305` H-00 形制) | opus | 0.8d | 无归属数据时退化为今天的界面 | revert |
| **PR-8** | 裁决后:`off → shadow → enforce`;enforce 时把 #5516 的 `archive_empty` 判据换成归属谓词。**这一支带守卫账**:重写 P-13 armed 半边 case 1 `:971-987`、case 2 `:989-1012`、case 4 `:1028-1055`,并为 P-13f `:1141-1145` 的「零目录读」另找一个「门没跑」的度量(原来的正控制 `:1009-1012` 会失效);`:1079-1093` 在这里第二次成为焦点(拒绝真正发生的时刻,若 PR-5 已重写则复核其仍然成立)。**【第四轮补,方向与 §2.5 (f) 前半相反的一条】** `tenant-scoped-write-guard.test.cjs:512-515` 断言 `resolveIntegrationStagingProjectId(reconcileScope.tenantId, undefined)` **必须在场**,而 reconcile 里这个形态只有 `http-routes.cjs:5932` 一处、就在被换掉的 `assertOperatorMaySeeProject(:5929-5935)` 的参数里 → 换判据即红;二选一:保留一次有真实用途的 reconcileScope staging 推导,或改 `:458-463` 的期望对并说明。runbook 补前置表 | opus | 0.5d | 改回 `shadow` | 开关 |

**工时合计(C 路线,不含 PR-6b / PR-6c)**:**约 5.6d**;含两支可选 = **7.0d**。**可上线时间** = 工时 + 一轮 r14 影子期。

> **【第四轮的两处合计变动】** 0.3(PR-1a)+ 0.5(PR-1b)+ **0.2**(PR-2 C 分支,吸收 §6)+ 0.7(PR-3)+ 0.7(PR-4)+ **1.4**(PR-5)+ 0.5(PR-6)+ 0.8(PR-7)+ 0.5(PR-8)= **5.6d**。相对第三轮的 5.1d:**+0.4d 是 PR-5 的 apply carve-out**(§2.5 (b) 的守卫账,第三轮记漏),**+0.1d 是把 §6 的注释支正式并入 PR-2**(第三轮里 §6 末尾与 PR-2 各记了一次、合计里一次都没算)。若 Q7 答「confirm 收窄」,PR-1b 被 PR-6c 吸收,可选两支的净增是 1.4 − 0.5 = **+0.9d**。

**若改采 A**:PR-1a/1b/2/3 不变;PR-5 换成「管理员分配路由 + 导入 + 回填 dry-run 脚本(输出报告供人工确认后再写)」,但**守门那一半照做不误——包括 §2.5 (b) 的 apply carve-out 那 0.4d**;PR-4/6/7/8 结构不变;**PR-8 的 enforce 前置多一条:回填结果已人工核对**。

**迁移号提醒**:C(与 A)同时占 `087` 与 `088`。现存最高是 `086`,`083` 空缺(见 §6.4)。**088 的风险不是撞号,是被更高号的词表迁移全量 re-list 静默抹掉**(`086:36-49`),所以 088 必须 re-list 全部 15 个动作,并在 PR 描述里写明这条。

---

## 6. 顺手记下的注释/文档不一致(不属本设计范围,但会误导下一个读代码的人)

1. **路由表注释与代码相反**:`http-routes.cjs:227-230` 写 *"Reconcile … also stays platform-admin … this PR does not move it"*,但 reconcile 早已在操作员步骤表里(`workbench-access.cjs:348-353`,C13 裁决),`requireTableActionAccess` 的操作员分支会放行。
2. **同一路由两条租户推导**:reconcile 的写目标用 `resolveAuthUserTenantId`(`:5851`),门内用 `resolveOperatorValueScope`(`:5923`)。**正确的说法是两条门槛不同**:`resolveAuthUserTenantId`(`:1075-1087`)读 `user.tenantId`,只有 `assertVerifiedTenantClaim`(`:1085`)在 flag 打开时才补验;`resolveOperatorValueScope` 优先信已验声明、拒绝矛盾的携带值、拒绝无自有租户的主体、并要求 host 为 (user, tenant) 背书。flag 打开后,scope 会拒绝一批 `resolveAuthUserTenantId` 放行的调用者。
3. **两处过时的计数注释**:`audit-store.cjs:23` 写 *"closed action vocabulary (9 actions)"*、`http-routes.cjs:5982` 写 *"migration-frozen (9 actions)"*,而 `audit-store.cjs:49-88` 现在是 **14 个**。
4. **一处编号漂移的注释**:`http-routes.cjs:9020` 援引 `migration 083`,该文件不存在;理由实际在 `086:20-22`,而 `086:36` 自己解释了为什么它不叫 083。
5. **【本轮新增】一处路径易误导**:确认队列组件在 `apps/web/src/components/integration/stockPreparation/StockPreparationConfirmationQueueView.vue`,不在 `views/`;引用时请带全路径(本稿已改)。

以上五条合起来是一支纯注释改动(sonnet 0.2d),与任何裁决都不冲突,可以先合。**【第四轮改:记账口径统一】** 上一轮这里记了 0.2d、PR-2 又写「顺带修」,两处各记一次而合计里一次都没进。**现由 PR-2 的 C 分支正式承担(0.1d→0.2d),本节不再单独计工时**;若 owner 裁 B(PR-2 走删门分支),这五条另开一支 sonnet 0.2d 并计入。

---

## 7. 第二轮变更表(blocker → 处置)

| # | 来源 | Blocker 摘要 | 处置 |
|---|---|---|---|
| **B1** | 复核1·B1 / 复核2·B1 | 路由清单仍缺 `dry-run` 与 `apply`,而 apply 是唯一直写客户目标表的操作员可达路由;PR-5 把主认领点放在一条没有门的路由上,非归属人跑 apply 时写照样发生、认领还会静默落到原主名下 | **全额采纳,并升为本稿的组织原则**。§1.3a 新建三行表(dry-run `:63`/`:5734`/`:5738`/`:5785`;apply `:65`/`:6128-6185`/`:6130`/`:6133`/`:1562`/`:6131`/`:6148`/`:6146`/`:6171`/`:6174`;reconcile);§1.3d 新增「四个 projectNo 入口」小节;§1.4 把 apply 从第 5 提到**第 1**;§2 C 新增「认领点 ⊆ 守门点」段;§5 PR-5 改为「守门 + 认领同批」,工时 0.7d→1.0d;对比表新增「守门点数量」「能否关掉 apply 写」两行;C 总工时 4.4d→5.1d |
| **B2** | 复核1·B2 / 复核2·B2 | 「apply 是操作员必经且每个项目都会跑」被 `projectSync.ts` 的 held 分支证伪 | **全额采纳**。§2 C「覆盖面」重写并引 `:759-767`(`if (held) { … 'WRITE_HELD_FOR_CONFIRMATION' … return done() }`)、`:722`、`:723-724`、`:768-772`;§3 理由段改成「谁跑了它的第一次写 = apply(非 held)∪ reconcile(held)∪ expansion-start,互斥双分支、并集完备,**没有任何单点覆盖全部项目**」;对比表「归属来源可信吗」一格同步改写 |
| **B3** | 复核1·B3 | 归属键 `(tenant_id, project_no)` 与被保护的共享目标表不同量纲 | **采纳,并补一格缓和事实**。§2 A 新增「⚠ 键的量纲问题」段,引 `project-board.cjs:585-588`(deploy 级、无 tenant 列)与 `:602-606`(WHAT THIS DOES NOT CLAIM);**同时补上反驳没说的 `:593-600`**:非拥有该 sheet 的租户根本读不到它(B-13 双向钉住),所以跨租户重名只在「一个部署把多个租户指向同一 target」时才成问题。§3 末尾列为**第二条必须写进裁决书的免责**;§4 Q3 追加此问 |
| **B4** | 复核1·B4 | PR-6 把谓词接到 confirm,与稿子自己为 PR-1b 论证过的审计次序不变式冲突,却没给答案 | **采纳,并给出可执行答案**,拆出独立的 **PR-6c**:① 检查放在 `:8167` **之前** —— 这与 confirm 自己的先例一致,`:8154-8155` 明写 scope 的拒绝就排在 append 之前、*"a refused caller writes no audit row"*,与 P-13 `:1005-1007` 同取向;② 那次 `decisionId → projectNo` 读**必须是软的**(恰好 1 行且归属他人才 403;0/多行不判,落回今天的路径),这样 `:8175-8176` 的「畸形请求仍留痕」与 `confirmation-decisions.cjs:1260-1266` 的 404/409 都保住;③ **本轮新发现的额外约束**:那次读的 staging 推导必须逐字写成 `resolveIntegrationStagingProjectId(scope.tenantId, undefined)`(`tenant-scoped-write-guard.test.cjs:523-532`,confirm 在 `:422` 的 INLINE_STAGING 集合里);④ 账本模块要**新增正式导出**(`module.exports:1574-1608` 无此口,内部件只在 `__internals:1599-1607`)。语义后果单列为 **Q7** 交 owner |
| **B5** | 复核2·B3 | PR-8 换判据会红掉 P-13 armed 半边,C 路线的守卫账系统性记少一支 | **全额采纳**。§2.5 (d) 整段重写,逐条列 case 1 `:971-987`、case 2 `:989-1012`、正控制 `:1009-1012`、case 4 `:1028-1039`/`:1041-1055`,并指出 `:1009-1012` 一红会连带 P-13f `:1141-1145` 的度量基准失效;PR-8 从「— / —」补上 **opus 0.5d** 与完整守卫清单;C 总工时相应上调 |
| **M-a** | 复核1·m1 / 复核2·m3 | 088 不只是「照形制」,必须 re-list 全部动作,风险是静默抹掉不是撞号 | 采纳。§2 前置事实第 3 条与 PR-3 改写,引 `086:31-34`(SET-EQUAL + 按最高编号 DISCOVERY)、`086:36-49`(083 被 085 抹掉的复盘,症状是「操作员一开看板就 500」)、`audit-migration.test.cjs:28`/`:32-35`/`:75`;§5 末尾「撞号提醒」改写为「静默抹掉提醒」 |
| **M-b** | 复核1·m2 / 复核2·m2 | §2.5(b) 漏了守卫自带的 carve-out,Q0 应是三选一 | 采纳。§2.5 (b) 补 `:444-446` 的 `VALUE_BEARING_READS_WITH_GATED_LEGACY_TENANT`、断言 `:468-480`/`:475-479`、`tableActionDryRun` 的源码形态 `:5785` 与理由 `:427-442`;§4 Q0 改为三选一并给出建议 |
| **M-c** | 复核1·m3 | G9 还有第二半:marker 循环点名 reconcile | 采纳。§2.5 (a) 与 §2 B 删除清单、PR-2 三处都补上 `handoff.test.cjs:2985-2987`,并写明「表头一删它就红,两处必须同批改」 |
| **M-d** | 复核1·m4 / 复核2·m1 | 「list 是这一族里唯一没迁的」偏强 | 采纳并加精度。§1.4b 限定为「账本/值面四条里唯一」,并列出表外同形状的 apply `:6133` / 大 BOM 经 `:1250` / dry-run 非值路径 `:5785`;**同时给出两族的实质差别**:table-action 一族的操作员分支在 `requireTableActionAccess:1007-1012` 已跑过一次 scope(`:1004-1006` 自陈二者不可能不同),list 的门 `:8057` 没有任何等价物 |
| **M-e** | 复核1·m6 | PR-1a 取值可更直接 + 与 export 同口径 | 采纳。PR-1a 改用 `:5906` 的 `reconcileProjectNo`,并写明「与 export `:8269` 同口径;`audit-store.cjs:20-22` 明写 project_id 不做形状门、纪律在路由侧」 |
| **M-f** | 复核1·m7 | 大 BOM apply 只在配了策略的部署上真写,估爆炸半径要写上 | **采纳,但第四轮发现当时的写法是错的并已改写。** 上一轮写成「仅在配了 `sandboxPolicy`(`:6171`)**或** `productionPolicy`(`:6174`)的部署上真写」,把两条策略当成并列的两把钥匙。实际是**一个门两条分支**(`stock-preparation-table-actions.cjs:1836-1857`,按 `productionPolicy` 的**在场**分岔于 `:1838`):无 production 策略 → 沙箱门,对 canonical objectId **无条件 403**(`:1785-1788`,*"regardless of policy"*;`:1784` 连缺 objectId 也按 canonical),而 canonical 就是 `plm_stock_preparation_main`(`stock-preparation-templates.cjs:652`)——也就是本稿引 `project-board.cjs:585-588` 说「deploy 级共享、无 tenant 列」的那张表;有 production 策略(**server-config only、无 env 开关**,`:1818-1827`)才可能授权它,且要过 `:1838-1852` 四关 + `:1859-1865` 行数上限。沙箱那一半只能打开 allowlist 里的**非** canonical 副本(`:1789-1796`)。→ **§1.4-1、§2 B 代价、本行三处已按两分支改写**;`:6171`/`:6174` 保留为「策略从哪来」的引用,`:6412-6418`(大 BOM,`route:'large'`)与 `applyStockPreparationAction:1872-1878`(小,`route:'small'`)保留为「两入口共用同一门」的引用;新增 **Q8** 交 owner 答部署是否带 production 配置 |
| **M-g** | 复核2·m4 | PR-1a「无行为变化」措辞不准 | 采纳。改成「权限与拒绝语义无变化;审计行内容有变化」,并补审计读路由 `:208` 与既有的按 `project_id` 过滤读回 `:8507-8512` |
| **M-h** | 复核2·m5 | `FOR UPDATE` 行号偏一格 | 采纳。改为「调用在 `handoff-store.cjs:245`,散文在 `:173` 与注释 `:243-244`」 |
| **M-i** | 复核2·m6 | 两处路径/范围不精确 | 采纳。(a) Vue 全路径改为 `apps/web/src/components/integration/stockPreparation/…`,并收进 §6.5;(b) board 处理器范围由 `:8941-9017` 改为 **`:8941-9044`**(`:9017` 只是 try/catch 结束,成功审计在 `:9022-9042`),与 §1.5 引的 `:9018-9021` 不再自相矛盾 |
| **M-j** | 复核2·m2(附带) | dry-run 走的是 gated 形态 | 已并入 §1.3a 与 §2.5 (b),源码形态 `:5785`、scope 分支 `:5767-5774` |
| **N-1** | 本轮自查(两路反驳都没提) | staging 推导形态被逐字钉死,直接约束谓词怎么写 | **新增 §2.5 (f)**:reconcile 的两种形态被钉死(`:458-463` + 断言 `:507-520`),confirm 等 INLINE_STAGING 成员的每一处推导必须逐字相同(`:523-532`);PR-4 与 PR-6c 各引一条 |
| **N-2** | 本轮自查 | 代码里已有一句与本设计同结论的自陈,两轮都没引 | **新增 §1.2 第三条**:`operator-project-directory.cjs:386-390` *"NOR IS IT A PROPERTY OF THE LEDGER AS A WHOLE … LIST … and CONFIRM … still admit on tier + tenant with no per-project check of their own."* |

### 未采纳(给出行号反证)

| 来源 | 主张 | 反证 |
|---|---|---|
| 复核1·m5(第 1 项) | 「Broadening the predicate … The real fix is a project-ownership store」实为 `operator-project-directory.cjs:370-373`,稿写 `:371-374` 有误 | **不采纳,稿子是对的**。`:370` 是 *"caller keeps this behind a default-off flag rather than arming it: on by default it would refuse a"*;`:371` 才是 *"floor operator's first reconcile of every new customer project. Broadening the predicate to \"the"*;整句止于 `:374` *"The real fix is a project-ownership store, which does not exist yet."* → 引用范围应为 **`:371-374`**,保持原样 |
| 复核1·m5(第 2 项) | 同文件「WHAT THIS DOES NOT CLAIM」起于 `:378` | **不采纳**。`:378` 是空注释行 ` *`;标题在 **`:379`**,整段止于 `:384`(`:385` 又是空注释行)。本稿改用 **`:379-384`**(比第二轮的 `:379-385` 更紧,但起点不变) |
| 复核1·m5(第 3 项) | `project-board.cjs` 的「WHAT THIS DOES NOT CLAIM」实为 `:603-607` | **部分采纳**。标题在 **`:602`**,段落止于 `:606`(`:608-610` 是另一段讲 suite 的);本稿改用 **`:602-606`** —— 起点用稿子的,终点用反驳的 |
| 复核1·m5(第 4 项) | `operator-scope.cjs` 表头第 10 条起于 `:108` | **采纳**,已改(稿子原写 `:110-126`) |
| 复核1·B3(第二轮遗留) | 「`migration 083` 那条理由查无实据,PR-1 必须先解决」 | **仍不采纳**。理由存在且完整,在 `086:20-22`;同文件 `:36-49` 自陈本文件写就时编号为 083、因 #5442 先合带来 084/085 而改号。这是**一条注释里的陈旧编号**(§6.4),不构成 PR-1a 的前置条件 |

---

## 8. 第四轮变更表(blocker → 处置)

**范围声明**:本轮只处理第三轮两路复核列出的 blocker 与 minor,**每处改动限于该处段落**;未新增章节、未重写推荐链(推荐仍是 **C**,第 1 步仍是 PR-1a)、未扩展设计范围。所有行号在本轮用 `git show origin/main:<path>` 重新核实,基线仍是 `f26a3395`(本轮 `git fetch origin` 确认无漂移)。

### Blocker

| # | 来源 | Blocker 摘要 | 处置 | 改动落点 |
|---|---|---|---|---|
| **B-a** | 复核1·B1 | 「三案都只对 `integration:admin` 持有者仍开着」的免责句,在本轮新增的两个守门点上把保证写强了:apply 的 legacyGate 是 `'write'`、expansion-start 是 `'read'` | **全额采纳,按各门真实宽度改写成逐路由的旁路层级表**。依据:legacy 早返回 `http-routes.cjs:993-1000`(`:999` return,`:998` 的声明校验仅在 `MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED` 打开时非空转),在操作员分支 `:1001-1012` **之前**;`hasPermission` `:891-907` 对 `'admin'` 只认 `role:admin`/`integration:admin`(`:901`,`:902` 其余一律 false)、对 `'write'` 认 `integration:write`(`:906`)、对 `'read'` 认 `integration:read ∪ integration:write`(`:903-905`)。gate 出处:reconcile `workbench-access.cjs:352`(常量 `PLATFORM_ADMIN_GATE='admin'` 在 `:81`)、apply `:257-262`(路由门 `:6130`)、expansion-start `:280-285`(`legacyGate` 在 `:284`,门 `:6192`)、dry-run `:252-255`(门 `:5738`)。**残余口子的准确表述**:任意 `integration:write` 可对任意项目号 apply(写在 `:6146`)、任意 `integration:read` 可对任意项目号 expansion-start,**且都不落归属行**。给出两条修法请 owner 明选:(i) 接受层级表;(ii) 谓词覆盖非 admin legacy 分支,并当面写明那一档只有 `resolveTenantId`(`:1023-1047`,自陈 `:1040-1045` header 对 header)+ `user.id` | §2 前置事实 1(整条重写 + 新增层级表);§3 免责 1(同口径改写);对比表两格加注 |
| **B-b** | 复核2·B1 | PR-5 的守卫账漏了 `stock-preparation-tenant-scoped-write-guard.test.cjs` 的**源码派生集** carve-out | **全额采纳,补进 §2.5 (b) 并上调 PR-5 工时 1.0d→1.4d**。依据:派生规则 `:315-325`(4 空格缩进 handler,函数体含 `resolveOperatorValueScope(` 即入集)、派生结果 `:394`、`:404-412` 断言派生集 == PINNED(现 10 名 `:328-392`);`tableActionApply`(`http-routes.cjs:6128`)与 `tableActionLargeBomExpansionJobStart`(`:6187`)**均为 4 空格缩进**(已实测),PR-5 加 scope 即入集。入集后 apply 立刻吃 `:482-488` 的通杀断言,而它 `:6133` 正是 `const applyTenantId = resolveTenantId(req, {})` → 红。**「先做 #5445 形状迁移」在 apply 上不可用**(legacy `integration:write` 在 `:993-1000` 早返回、不过 scope,整体换会改其行为),唯一出路是进 `:444-446` 的 `VALUE_BEARING_READS_WITH_GATED_LEGACY_TENANT` 并按 `:468-480` 逐字改写成 gated 三元(`:472` 精确源码串、`:475-479` 恰好一次)。expansion-start 体内无 `resolveTenantId(` 字面量,只需进 PINNED。并写明 **(a)(b) 是源码级、合入即红,与三态开关无关**;(d) 一族是行为级、随开关 | §2.5 (b) 追加一整段;§2.5 (a) 加一句指向;PR-5 描述重写 + 工时 1.0→**1.4d**;§2 C 工时 3.9→**4.3d**;§2 A 工时 4–4.5→**4.4–4.9d**;对比表工时行;§5 合计 5.1→**5.6d**(另 +0.1d 见 m-r2-4) |
| **B-c** | 复核2·B2 | 「仅在配了 `sandboxPolicy` 或 `productionPolicy` 的部署上真写」这一前提,对稿子自己点名的 canonical 表不成立 | **全额采纳,按复核给的行号在三处改写成两分支版本**。依据:单一门 `stock-preparation-table-actions.cjs:1836-1857`,按 `productionPolicy` **在场**分岔(`:1838`);无 production → 沙箱门 `:1854-1855`→`:1781-1797`,对 canonical **无条件 403**(`:1785-1788`,`STOCK_PREP_APPLY_SANDBOX_ONLY` / reason `prod_canonical`,注释 `:1785` *"regardless of policy"*),`:1784` 连缺 objectId 也按 canonical;canonical = `plm_stock_preparation_main`(`stock-preparation-templates.cjs:652`)= 稿子引 `project-board.cjs:585-588` 的那张表;有 production(**server-config only、无 env**,`:1818-1827`,`:1821` *"deliberately no env switch"*)才可能授权,还要过 `:1838-1852` 四关 + `:1859-1865` 行数上限;沙箱那一半只能开 allowlist 里的**非** canonical 副本(`:1789-1796`)。**结论改写**:无 production 配置的部署上,一线对该表的 apply **今天已是 403 fail-closed**,谓词上 apply 是**纵深防御 + 留认领事实**,不是堵一条敞开的主写路径;apply 仍排危害第 1,但依据换成**它的形状**(唯一按调用者 projectNo 直写目标表的操作员可达路由 + 覆盖非 held 分支的认领点),不是「它今天敞着」。**新增 Q8** 交 owner 答部署(含 222)是否带 `stockPrepApplyProduction` | §1.4-1(整条重写 + Q8 引子);§2 B「代价」(按两分支重排);§7 M-f 行(重写);§4 新增 **Q8**;§0 与 §3 理由第 3 条各加一处指向(仅指路,不改推荐) |

### Minor(第三轮共 11 条,**全部采纳**)

| # | 来源 | 摘要 | 处置 | 落点 |
|---|---|---|---|---|
| m-r1-1 | 复核1·m1 | §2.5(f) 只警告「多推一个 staging 会红」,漏了同一断言要求那个形态**必须在场** | 采纳。`:511` `calls.length > 0`、**`:512-515` `calls.includes(expected[0])`**;reconcile 里该形态**只有 `http-routes.cjs:5932` 一处**,就在被 PR-8 换掉的 `assertOperatorMaySeeProject(:5929-5935)` 参数里 → 换判据即红;给两条出路 | §2.5 (f) 新增一条;PR-8 守卫清单;PR-4 加一句「必须保住 `:5932` 在场」 |
| m-r1-2 / m-r2-1 | 复核1·m2、复核2·m1 | P-13 armed 半边 `:1079-1093` 钉着「dry-run 与 apply 不被这道门收窄」,而 PR-5 正好动这两条 | 采纳,**并按复核建议在 §2 C 正面引一次并说明「当时为什么成立、现在为什么不成立」**。注释 `:1079-1080`、循环 `:1082`、消息 `:1091`;前端文案表只有一条 `STOCK_PREPARATION_RECONCILE_PROJECT_NOT_VISIBLE`(`plainLanguage.ts:652-655`)→ 复用同码直接红,另起新码则**假绿**(断言按字面仍过但行为已变),两种走法都要求 PR-5 重写该段而不是靠「默认 shadow」蒙过 | §2 C 新增一段;§2.5 (d) 补一条(并注明账记在 **PR-5**,PR-8 时第二次成为焦点);PR-5 描述第 ④ 项 |
| m-r1-3 | 复核1·m3 | §1.3d 的绝对句与它上面的 §1.3c 表自相矛盾 | 采纳,**限定为「写面」并补出读面三条**:list 从 query 取且必填(`:8063-8066`,handler `:8054-8077`)、export 按号带值导出(路由 `:181`,handler `:8210-8294`)、board 从**路径参数**取(路由 `:206`,取值 `:8949`,handler `:8941-9044`),外加 handoff advance 按 `(tenant, project_no)`(`084:99-100`)。并写明读面收窄属 Q0/Q4,不被 §0 的结论句覆盖 | §1.3d 新增一张读面小表 + 改写结论句;§0 同步加「写面」限定与指向 |
| m-r1-4 | 复核1·m4 | PR-6c 的「软查找」只覆盖 0 行/多行,没覆盖「这次读本身失败」 | 采纳,新增第 ⑤ 条:**fail-open on lookup** —— 该次读抛错也放行,只有「恰好 1 行且归属他人」才 403,并加断言。理由:今天 intent 行 `:8167-8179` 排在 `:8180` 之前(`:8165-8166`),插一次会读的查找会把「有审计行 + 5xx」变成「无审计行 + 5xx」,与 `:8175-8176` 同族 | PR-6c 行新增 ⑤ |
| m-r1-5 | 复核1·m5 | §2 A 的「四条『拒绝前什么都没碰』断言(`:1005-1007`)」计数与行号对不上 | 采纳。实测该范围恰好三条(adapterPrincipals `:1005` / loadPrincipals `:1006` / auditAppends `:1007`),`:1004` 是 403 状态断言、属另一组 → 全稿统一为「**三条 `:1005-1007`**」 | §2 A 门语义;PR-4 行 |
| m-r1-6 | 复核1·m6 | §2 B 的删除清单按行号执行会误删 | 采纳。实测 `theOperatorReconcilesOnlyProjectsItCanSeeArmed` 起 `:968` 止 `:1094`(`:964-966` 是 flag 包装),case 5 在 `:1057-1077`、dry-run/apply 段在 `:1079-1093`,与 case 1-4 同在一个函数体内 → 清单改写成「**拆函数**,把 case 5 与 `:1079-1093` 移进不依赖开关的留存函数,再删 case 1-4」 | §2 B 删除清单该条;PR-2 的 B 分支加同一提醒 |
| m-r2-2 | 复核2·m2 | G9 计数预算只算到 13,后面两支没接 | 采纳。PR-6b 让 list 调 scope 是**第 14 处**,`handoff.test.cjs:2984` 与 `:2985-2987` 要**再改一次**;PR-6 的改派路由**建议做成平台管理员门、不解析 operator scope**(则 G9 与派生集都不动),并要求 PR 描述写明选了哪条 | PR-6b 行;PR-6 行 |
| m-r2-3 | 复核2·m3 | PR-1b 与 PR-6c 互相拆台 | 采纳。写明 **Q7 答「收窄」时两支合一**:`projectNo` 已在手,PR-1b 的追加行冗余,应改为直接填进原 intent 行,PR-1b 被 PR-6c 吸收(合计 −0.5d);Q7 答「不收窄」时 PR-1b 独立做 | PR-1b 行;§5 合计说明 |
| m-r2-4 | 复核2·m4 | §6 的五处注释被记了两次账,而合计里一次都没进 | 采纳。**统一由 PR-2 的 C 分支承担,0.1d→0.2d**;§6 末尾改为「不再单独计工时」,并注明裁 B 时另开一支 sonnet 0.2d | PR-2 行;§6 末尾;§5 合计(+0.1d) |
| m-r2-5 | 复核2·m5 | 两处引用归属不明,与 §6.5 自立的「引用带全路径」规矩不一致 | 采纳。实测 `stock-preparation-operator-scope.cjs` **全文 393 行**,故 `:396-424`(`assertOperatorMaySeeProject`)与 `:121-134`(`projectArchiveIsEmpty`)均在 `stock-preparation-operator-project-directory.cjs`(438 行),已补全路径并加一句说明;并补记前端全路径 `apps/web/src/services/integration/stockPreparation/{workbenchAccess.ts,plainLanguage.ts}` 与 `apps/web/src/components/integration/stockPreparation/…` | §1.2 两条 + 一条注 |

### 本轮未采纳

**无。** 第三轮两路复核的 3 条 blocker 与 11 条 minor 全部采纳。

### 本轮为保持自洽而做的两处最小连带改动(非复核点名,已尽量克制)

| 位置 | 改了什么 | 为什么必须动 |
|---|---|---|
| §0 一句话结论 | 加「写面」限定 + 一句指向 §1.4-1/Q8 的括注 | m-r1-3 与 B-c 改掉的正是这句话依赖的两个前提;不动会让 §0 与 §1.3d、§1.4-1 自相矛盾。**结论本身(认领点 ⊆ 守门点、C 或 B 二选一)一字未改。** |
| §3 理由第 3 条 | B 的代价拆成「与配置无关的两条」+「取决于 Q8 的一条」 | 该条原文直接复述了 B-c 判定为错的前提。**推荐仍是 C、第 1 步仍是 PR-1a、条件分支逻辑一字未改**,只把这一条论据的强度限定到 Q8 上。 |
