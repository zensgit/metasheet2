# 备料(Stock Preparation)24 小时自主开发计划:设计及验证(2026-09-03)

> owner 离席期间授权按代码难度分派模型(sonnet5/opus5/fable5)自主推进备料线,收工出本设计+验证文档。values-free:本文不含主机名、IP、口令、凭据、客户业务值(项目号 `230920006` 等项目级事实沿用姊妹文档既有纪律,视为已向客户披露的非敏感信息)。
> 基线:`origin/main`(2026-09-03,含 #5442/#5445/#5446/#5447/#5456/#5457/#5458/#5459/#5462 等);#5455/#5460 两支保证型 PR 仍 OPEN,内容以其 PR 分支为准,随时可能因下一轮对抗而变。

---

## 1. 目标与范围

owner 给定的业务流程是四步,评估标准只有一条:**不懂数据库的人能不能独立把这四步走完**——不是"功能是否存在",是"人能不能自己找到入口、点得动、看得懂结果"。

| 步 | owner 的原话对应动作 | 系统内涵 |
|---|---|---|
| ① 搜索项目号 | 一线按项目名/项目号找到自己工厂的项目 | `GET /api/integration/stock-preparation/operator/projects`(#5445 项目目录,按认证主体定租户,不接受 query 里的 tenantId) |
| ② 从 PLM 拉取数据 | 一键把这个项目的 BOM 从 PLM 拉过来,七个 PLM 字段进主表,支持按小时精度分批 | pull-bom 表动作(dry-run → 人工确认 → apply);七字段 = **图号 / 名称 / 材料 / 总用量**(原有四项)+ **父组件图号 / 父组件名称 / 规格**(#5436 快照行、#5446 主表补齐的三项,R2 裁决);小时精度分批 = `readPlan.batchIdentity.mode`(默认 `source_revision`,按小时分批 R7 opt-in,UI 未建,见 §6) |
| ③ 多人填写九列 + 通知下一步 | 生产/采购/仓库各填各的字段,别人看得见;填完点一下"通知下一步",串行接力到终点后并行通知仓库+采购 | 多维表网格编辑 `field_permissions` 列级写权限(#5447,R4);#5442 交接游标,三步 `prep_entry → production → final_review`,终点 `terminal.groupDestinationIds` 并行群通知(R5/R6) |
| ④ 导出 Excel | 仓库/采购按项目号导出物料清单 | `stockPreparationPrepLineExport`,跟随 `action.target` 绑定读主表(或沙箱孪生表),17 列(#5457) |

**明确不在本轮范围内(owner 2026-09-02 裁决)**:
- **钉钉个人待办**:A(工作通知冒充待办)、B(单向待办镜像)两案均评审完毕但**推后**;第③步"通知下一步"当前形态(应用内游标 + 钉钉**群** webhook)已经是**在**范围内的交付,不是待办的替代品,PR 与文档必须说清楚"这不是待办"([[beiliao-dingtalk-todo-decision]] [[beiliao-demo-decisions-20260902]])。
- **推送宜搭**:按钮灰显(R9),等 owner 另一窗口的 `data_sources` 收敛方案落地后再做([[integration-consolidation-plan-20260901.md]])。

---

## 2. 设计

### 2.1 数据模型:两条管线、两套字段名、一个刻意的不合并

同一批 PLM 展开行分叉成两条**完全独立**的落地,只靠"同一次展开"这个事实相连,**没有任何列把两张表 join 起来**(操作员目录靠 `sourceProjectNo` 字符串相等做了一个弱连接,快照腿关闭时这个连接永远是空的):

| | `plm_stock_preparation_main`(主表,操作员真正干活的地方) | `plm_stock_preparation_bom_snapshot_line`(快照行,MVP 九表管线) |
|---|---|---|
| 性质 | 可变工作表,人在上面填字 | **不可变、create-only**,PLM 当时说了什么的版本记录 |
| 权威 | 结构的权威在此(装机后台的实际读写对象) | **值的权威在此**——主表上的父组件图号/名称/规格是反规范化副本,不是权威(模板注释 `stock-preparation-templates.cjs:701-703`) |
| 行键 | `idempotencyKey` = 字面 JSON `{projectNo, componentSourceId, parentSourceId, path}`,项目号天然嵌在键里 | `snapshotLineId = hash(batchId \| pathKey)` |
| 默认是否写入 | 视 apply 门而定(见 2.2) | 默认关(`mvp-persist` 需要 env 开关,工作台那条腿默认关;另有两条无 env 开关、仅 admin 门控的旧入口——"关着"对工作台成立,对整个表族不成立) |

**同一概念、两套字段名**(节选):

| 中文 | 主表 | 快照行 |
|---|---|---|
| 父组件图号 | `parentComponentCode` | `parentDrawingNo` |
| 图号 | `componentCode` | `childDrawingNo` |
| 名称 | `componentName` | `childName` |
| 规格 | `componentSpec` | `spec` |
| 单层用量 | `rawQuantity` | `designQty` |
| 项目 | `projectNo`(业务号) | `projectId`(哈希内部号) |

**为什么不是随意的两套词表,也不合并**:租户 `ext_` 扩展列与冻结模板字段 id 是**互斥命名空间**(`stock-preparation-extension-namespace.cjs`,`FIELD_ID_TEMPLATE_COLLISION` 规则)。出厂客户包已经占了 `ext_parentDrawingNo`/`ext_parentName`/`ext_spec` 这三个扩展列名;主表若把新字段叫 `parentDrawing`/`spec`,任何装了这个包的部署都会在自检时炸。所以主表新增的父组件图号/父组件名称/规格另起了 `parentComponentCode`/`parentComponentName`/`componentSpec` 三个不冲突的 id。**两条管线合并、还是主表补列、还是导出改读快照行**是 owner 2026-09-02 待裁决的第⑦条([[beiliao-two-table-divergence]]);本轮采纳的是"主表补列"(#5436/#5446),导出继续读主表,R2 裁决为最终形态。

### 2.2 沙箱孪生表与 D1=B 裁决

`plm_stock_preparation_main`(canonical)今天在真实部署里**永远拿不到真实数据**,不是没人拉取,是结构性的:

- `assertStockPrepApplySandboxAllowed`(`stock-preparation-table-actions.cjs:1508-1547`)对 canonical objectId **无条件 403**(`STOCK_PREP_APPLY_SANDBOX_ONLY`,`reason: prod_canonical`)——这是故意的 P0 门,代码注释原话:"production apply is a separate owner gate"。
- 唯一能打开这道门的是生产写入策略 `context.config.stockPrepApplyProduction`(P1 策略契约 #3195、P2 受控运行时 #3199 都早已在 main 上且工作正常)。但承接它的**加载器不存在**:`packages/core-backend/src/plugin-runtime-config.ts:98-169`(唯一的 `context.config` 组装点,调用于 `index.ts:2882`)只产出六个键(`tableActions`/`stockPreparationTableActions`/`stockPreparationCustomerPacks`/`stockPreparationExtFieldMapping`/`b2aTrialRegistry`/`c6TestFailureInjection`),**没有 `stockPrepApplyProduction`**。这是"设计,未实现",不是配置写错地方——P4 file loader 是待开工作项(Wave1 W1-7)。

**owner 裁决 D1=B(2026-09-01/2026-09-02,见 #5456)**:222 窗口与首个演示的落地表是沙箱命名空间下的孪生表(`plm_stock_preparation_sandbox*`),**不是** canonical 主表。机制:`STOCK_PREP_SANDBOX_MODE=true` + `STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS` allowlist + action 绑定的 `target.objectId` 三处配置一致即可,**零代码**。孪生表与主表**同一套模板重新盖章**(33 列逐字节相同,只换 objectId),导出/装包/拉取全部跟随 `action.target` 走,不需要为沙箱单独改任何一处读写代码。代价:objectId 名字里带 `sandbox`,allowlist env 没有到期机制,需要人工在窗口结束后清理。

### 2.3 33 列主表模板:20 个 plm_system + 13 个 human_preserved

`STOCK_PREPARATION_MAIN_TABLE_TEMPLATE`(`stock-preparation-templates.cjs:650-825`):

**20 个 plm_system 列**(PLM 刷新时机器写,`assertNoHumanFields` 人列墙保证人写不了这些以外的列不受阻,但反方向——人在网格里改机器列——由列写权限单独保护,见 2.4):
`projectNo / idempotencyKey / componentSourceId / parentSourceId / parentComponentCode / parentComponentName / path / depth / componentCode / componentName / componentSpec / material / sourceVersion / rawQuantity / totalQuantity / active / lastPlmRefreshRunId / lastPlmRefreshAt / lastPlmRefreshDecision / lastPlmConflictSummary`

**13 个 human_preserved 列**(`HUMAN_PRESERVED_FIELD_IDS`,`assertNoHumanFields` 拒绝任何 PLM 刷新写入):owner 原始的九列 `materialType / blankType / stockPreparationStatus / demandDate / leadTimeDays / notes / procurementReply / warehouseConfirmation / makeOrBuy`,加上 #5447 新增的**部门响应波段**四列 `procurementDone / procurementReplyDate / warehouseDone / actualArrivalDate`。

- **自制/外购(`makeOrBuy`)**:调研过把它当 PLM 源侧属性(客户物料字典 `DN_PM_PartExAttrInfo` 73 列/21 启用,**没有**自制/外购这个属性),结论是一个备料时刻的人工决策,`human_preserved`。**它是一个字段,不是一个路由**——模块内没有任何分支读它去决定走哪条路,也没有自动赋值消费它。
- **部门响应波段**:老系统曾是三张 1:1 表(`stock_info` + `purchase_info` + `warehouse_info`),采购与仓库各有一个带类型的完成标记和真实日期;塌缩成一张表后,只有两个自由文本备注(`procurementReply`/`warehouseConfirmation`)活了下来,没有机器可读的完成态,交接/通知流程无从推进。#5447 恢复了这四列的机器可读半边——**只是字段,不是工作流引擎**:没有状态机、没有标记与日期之间的先后约束、没有联动清空,交接信号由 #5442 单独承担。

### 2.4 工作台构成:项目备料页 = 聚合读 + 组合面板 + 深链,不是重写

owner 裁决"项目备料页 = 备料工作台新 tab,不另起炉灶":真正新写的只有 **board 聚合读**,其余全部复用已上线的模块:

| 组件 | 来源 | 备注 |
|---|---|---|
| 搜索 | #5445 目录 + 三态空状态 | 未改 |
| 拉取 | 既有"项目接入"面板 | #5435 大 BOM 进度在里面,**没有 fork** |
| 通知下一步 | #5442 契约 | 未改 |
| 导出 | #5437 客户端 + 同一个下载触发 | 未改 |
| 填写 | 多维表网格深链 | **新写的只是深链拼接**,不是新编辑面 |
| 推宜搭 | 灰显 | R9 |

`GET /api/integration/stock-preparation/projects/:projectNo/board` 是第四个"带值读"(前三个是值回读/导出/操作员目录),按 `stock-preparation-operator-scope.cjs` 头部指示加入既有名单,响应投影是**冻结集合**、逐键构建。它带两族数字且绝不让一族冒充另一族:`pullTargetReady`/`pulledRowCount`/... 来自绑定的 `action.target`(一线自己的拉取),`lastSyncRunId`/`snapshotBatchCount`/... 来自 MVP 快照表(平台管理员的 `mvp-persist`)。

**这一页没有可编辑的单元格,是故意的**:填写留在多维表格子里,列级写权限和人工字段墙已经在那儿;board 页放一个单元格,就是对同一批行开出第二条写路径,而且底下什么都没有。**深链是链接,不是权限判定**:服务端只在表存在且属于本租户时才发句柄,能不能打开是多维表自己的 ACL 答案。

**没有做临时多维表过滤参数**(按项目号在网格视图里筛一遍),因为这个筛选需要跨网格视图模型与 ACL 层的改动;承诺一个没做的筛选比"这张表装着所有项目的行"这句诚实的话更糟(#5460 body)。W1-2(`multitableRoute.ts` + 临时 `filterInfo` 叠加参数)留在 Wave 1 待办,不是本轮交付。

### 2.5 权限:列级写权限 / 值面租户证明 / 部署级绑定表的单租户模型 / 数据面身份委派

**列级写权限**(#5447,`field_permissions`,迁移 `zzzz20260411140100`):`visible` 结构上恒为 `true`(不能藏列——R4 裁决"共享读、只限写"),写门只按角色声明的 `ownsFieldIds` 拒写。**只保护网格/Yjs 写路径**,不管插件自己的服务账号写手(那条走 `assertNoHumanFields` 人列墙单独保护)。这两堵墙保护同一批列但从不相遇。

**值承载读的租户证明**(`stock-preparation-operator-scope.cjs`,#5445 首次落地):模块头部把边界写得很直白——它回答的不是"这个主体能不能调用这条路由"(`requireAccess`/`hasPermission` 已经回答了),而是"这份数据是不是他的"。规则是:**一个带值的读永远只能返回调用者自己租户的数据,一个没有自己租户的主体因此什么都看不到**。第二句是承重的那句——它挡住的正是无租户平台管理员用 `x-tenant-id` 请求头操纵 `tenantId` 的口子(`x-tenant-id 请求头洞`,main 上 `jwt-middleware.ts:~106-109` 在 token 无租户声明时把请求头拷进 `user.tenantId`)。今天落在这份名单里的有四个值承载读(值回读、导出、操作员目录、board)和两个租户证明专属面(handoff 状态/推进)。**主干 `http-routes.cjs` 上仍有一批备料入口走老的 `resolveTenantId`**(`stockPreparationTargetInput`/`SandboxTargetInput`/`MvpTargetInput`/`ProjectListInput`/`SnapshotBatchListInput`/`SnapshotDiffInput`/`SnapshotDiffRowsInput`/`ConfirmReadInput`/`ExportFilename`),这是待起的系统性 PR 的靶子(见 §6)。

**部署级绑定表的单租户拥有模型**:`action.target` 是部署期配置、**全部署共享一份**;`plm_stock_preparation_main` **没有租户列**,表内唯一的行级作用域是 `projectNo`。这不是本轮发明的性质,导出路由头部从上线那天起就这么写。#5459(结转)与 #5460(board)各自独立造出同一个宿主端口 `provisioning.isSheetOwnedByProject(sheetId, projectId)`——**返回布尔,不返回归属者**(第一版曾返回归属项目 id 并靠命名空间守卫收窄,但插件项目命名空间是每插件一个、所有备料租户共用,"收窄过的"答案照样会把租户 B 的项目 id 交给租户 A;布尔把这个预言机去掉,收窄做在 SQL 的 `WHERE project_id = $2` 里)。两条路径证明"是不是你的表"都是**析取**:登记表(`plugin_multitable_object_registry`)说是,或者 sheetId 能从调用方自己的项目哈希出来——任一为真即放行,不是互相替代。

**该模型的两个边界要按它真正成立的样子说,不能说得比数据模型更强**:①不拥有绑定表的调用方,请求根本不会读那张表——对他们,表里真有行的项目号与哪儿都不存在的项目号,响应/状态/时序逐字节相同;②拥有那张表的租户读得到表里**全部**行,因为单一所有者的表里没有"别人的项目号"这回事——这个边界本身**不能**扩展成"多个租户共享同一 target 时彼此隔离",数据模型给不出这个保证(round-1 的自我声明曾说得更强,已被对抗评审否决并撤回)。

**操作员拉取的数据面身份委派**:HTTP 层的门拆开只是第一步,不够——默认源类型 `data-source:sql-readonly` 的主机 facade 按**严格所有者相等**授权,数据面**没有管理员旁路**(`DataSourceManager.assertAccess` 除非 `ownerId === userId` 否则抛),一线操作员永远不是绑定这条 PLM 连接的人,所以直接开放路由只会让一线的每次拉取都静默变成 `status:"failed"`。修法:对**那一个冻结的 actionId**(`plm.stock-preparation.pull-bom.v1`),源读改为以 `config.dataSourceOwnerId`(服务端在 external-systems upsert 时盖章,客户端同名字段被丢弃)的身份执行——**只能替换掉一次必然的失败**(调用方本来就是所有者时值不变、没盖章时不可委派、其它 actionId 一字节不改),审计行同时记 `actor`(一线)与 `principal`(绑定所有者读的谁),两件事分开记。后台大 BOM 任务同理但更严:任务分别记 actor/principal,`run` 路由在适配器加载**之前**拒绝非创建者。`confirmation-decisions/reconcile` 在 #5460 第二轮被折进同一次拆分——不折它,含人工确认行的计划会把一线锁进死循环(reconcile 才是把行放进确认队列的那一步)。

### 2.6 通知:交接游标、至多一次、tenantId 必填、钉钉群工作通知代打待办

#5442 的核心是 `integration_stock_prep_handoff`(每项目一行的游标):事务内**行锁 + `step_index`/`notified_step_index` 双 CAS**,零行更新即 409,防止并发交接产生分叉状态。**至多一次通知**:store 提交先于审计追加与钉钉分发(round-1 F6 发现的原始实现是"先审计后 store",审计失败会把交接烧成"已推进但没通知";已订正为 store-then-audit),dispatch 函数**永不抛**,只返回一个封闭枚举的结果。

**tenantId 必填、fail-closed(不是文档声明单租户就够)**:钉钉目的地 id 是部署级配置,宿主发送时只能证明"这个目的地是管理员管的",证明不了"它属于正在被播报的那个租户"——而一个在两个组织里都活跃的账号 token 不带租户声明,`x-tenant-id` 请求头就能选择用哪个租户身份推进。裁决:handoff 配置文件里 `tenantId` 是**必填**字段;不属于该租户的推进一律返回 **501**,故意与"这个部署根本没配接力"逐字节相同,不让外租户从报错里学到"这里有一条链,只是不是你的"。多租户部署目前**只能服务一条链**(按租户分链是后续工作,见 §6)。

**钉钉群工作通知代打待办**:owner 裁决三方案(A 工作通知冒充待办 / B 单向待办镜像 / C 双向回流)评审一致——A 先上、B 是下一波、C 永不做。本轮交付的正是 A 的底座(`sendDingTalkWorkNotificationActionCard` 群 webhook),终点并行仓库+采购(R5),正文带"(本条由系统发送)"+ 批准人签名(R6)。**没有完成态、没有红点**,这一点必须在 UI 与文档里明说,不能读成"已经是待办"([[beiliao-dingtalk-todo-decision]])。

### 2.7 裁决清单

**R1–R6**(`stock-preparation-overall-plan-20260902.md` §2,不可改的 owner 裁决):

| 编号 | 内容 | 落地 |
|---|---|---|
| R1 | 租户内操作员可见本租户数据 | 备料页/多维表深链只放物理句柄与项目号,不放业务值;目录路由租户由主体决定(#5445) |
| R2 | 主表回填父图号/父名/规格 | #5446 已合;导出保留 `ext_parentDrawingNo`/`ext_parentName`/`ext_spec` 兼容兜底 |
| R3 | make-or-buy 是人工封闭选项,不路由 | #5447 新增 `makeOrBuy` 为 human 列;导出/看板只读它,不据它分流 |
| R4 | 采购/仓库列共享读、只限写 | #5447 `visible` 恒为 `true`(结构上不能隐藏),只写 `read_only` |
| R5 | 串行接力 → 终点并行仓库+采购 | #5442 `terminal.groupDestinationIds` |
| R6 | 系统发、署名谁批 | #5442 正文带"(本条由系统发送)"+ 批准人 |

**2026-09-03 凌晨追加的三条裁决**(#5460 二轮 16 条对抗确证后,`[[beiliao-24h-program-status-20260903]]`):

1. **部署级绑定表单租户拥有**:全部署共享一张表、行级只按项目号、主表无租户列,所以"外租户项目号 404 与未知项目号一致"这条保证在多租户共享同一 target 时是假的;模型改为"只有拥有绑定表的租户能拉/看/导出",非拥有者一律 404/拒绝(apply 写路径那半留给系统性 PR)。
2. **审计行 values-free 只校验封闭列**:`mode`/`subject_id` 才走 `SAFE_STRING_PATTERN`;`project_id`/`workspace_id` 是调用方数据,不能套同一个模式(否则中文项目号导出 422、写路由先写后 422);所有路由停止转发原始 `?workspaceId`。
3. **一线拉取的数据面身份**(2.5 节已详述):默认按调用者身份读会让一线永远失败;仅对冻结的 pull-bom 动作,按服务端记录的绑定所有者读,审计分记 actor/principal;宿主端口统一为布尔 `isSheetOwnedByProject(sheetId, projectId)`(#5459/#5460 同形独立造出,签名已对齐)。

---

## 3. 交付清单

### 3.1 本轮合入 main 的 PR(`gh pr list --state merged --search "merged:>=2026-09-02"`,19 支,按 PR 号升序)

| PR | 合并时间(UTC) | 一句话 |
|---|---|---|
| #5410 | 09-02 00:31 | 考勤 W6 教学场景清理排空(非备料线) |
| #5439 | 09-02 12:54 | automation F4-E 真实触发验证加固(非备料线) |
| #5440 | 09-02 01:41 | 更正两处对客户不实陈述——角色列权限与 `ext_purchase_*` 列并不存在 |
| #5441 | 09-02 02:01 | 集成层收敛方案两份正式文档入库 |
| #5442 | 09-03 00:11 | 通知下一步——备料多人接力有了交接游标和钉钉群提醒(四支保证型 PR 之一,见 3.2) |
| #5443 | 09-02 02:24 | 订正两处与代码相反的模块头注释——生产策略已接线、孤儿任务对账已实现 |
| #5444 | 09-02 01:51 | 副驾按钮不再永久灰掉;项目表"刷新"名副其实 |
| #5445 | 09-02 09:04 | 一线看得见自己工厂的项目——按名检索,不再靠背项目号;`stock-preparation-operator-scope.cjs` 首次落地 |
| #5446 | 09-02 01:56 | 备料主表补齐父组件与规格——导出真的带齐七个字段 |
| #5447 | 09-02 09:55 | 采购/仓库有了完成标记与日期,列级写权限真正落地(33 列主模板成形) |
| #5449 | 09-02 03:21 | 最小方案两处规格澄清(默认 private / connection_id 仅限 sql-readonly) |
| #5450 | 09-02 06:11 | 备料整体方案(代码核对版)——三个守卫缺口、分波工作项、模型分派、owner 待裁决 |
| #5451 | 09-02 14:05 | 审批加时序模式(非备料线) |
| #5453 | 09-02 09:44 | operator-scope 第三轮绊线 S-03d——纯声明主体,座位必须收到解析后的租户 |
| #5454 | 09-02 15:03 | 审批加目录支撑的部门字段(非备料线) |
| #5456 | 09-02 11:12 | 222 窗口落点定为沙箱表(D1=B);更正 P4 无加载器与两处 runbook 请求体/状态错误 |
| #5457 | 09-02 11:18 | 物料导出带上采购/仓库完成标记与自制外购——17 列 |
| #5458 | 09-02 11:33 | demo runner 覆盖 #5447 人工列 |
| #5462 | 09-02 12:14 | demo runner 导出与 17 列导出器对齐 |

### 3.2 四支保证型 PR

| PR | 分支 | 状态 | 对抗轮次 | 备注 |
|---|---|---|---|---|
| #5442 | `feat/stock-prep-notify-next` | **MERGED** | 3 轮(10→13→10 条确证) | merge commit `b274f6798f2c037c786600b729fd7a0a946167ef`,2026-09-03T00:11:49Z |
| #5455 | `fix/stock-prep-field-permissions-reconcile` | OPEN | 3 轮(17→21→11/1 条确证),第三轮改写为单一不变式,**尚待新一轮对抗复核** | 已修到 `0382bc9166a6001b1d59ef816c1625f6fa19752a` 且 CI 绿,按 owner 裁决推到演示后合 |
| #5459 | `fix/stock-prep-carry-target-binding` | **MERGED** | 3 轮(5→6→6 条确证,第三轮 3 条 P1 待修) | merge commit `a3397e0f422c4d4b6f5062cd902e540bf58dc180`,2026-09-03T01:33:46Z |
| #5460 | `feat/stock-prep-project-board` | MERGED | 2 轮(13→16 条确证,含 1 条 P0) | 当前分支头 `23cca1cbd5c8ad4387fcecf9e834a505d1dce61a`(写作时点,非最终)。最终合并 SHA 与合并状态:6ea9b6367(2026-09-03 04:41 合入) |

---

## 4. 验证方法与结果

### 4.1 对抗验证工作流

每支保证型 PR 过 **N 条攻击 lane(opus)× 3 个反驳者(sonnet,默认判 `refuted=true`)** 的独立对抗,外加变异测试员做作者没做过的变异(改语义看测试是否变红),以及一条**固定的 CI 遗漏 lane**(复跑整链、核对 required workflow 是否真的收了新测试)。只留下反驳者一致判"确证"的发现;lane 内没有被确证的项计入该 lane 的 `clean` 计数,作为"打过但没找到"的证据(而非"没打")。模型分派原则:实现者与反驳者不同模型或不同提示角度([[beiliao-demo-decisions-20260902]])。

### 4.2 逐 PR 轮次表

| PR | 轮 | 确证数 | 严重度分布 | 本轮定性 |
|---|---|---|---|---|
| #5455 | R1 | 17 | P1×8 / P2×9 | DELETE 五道收窄多处接错线;`legacy` 归属推断对整个存量为假(裸标记行没有 pack id) |
| #5455 | R2 | 21 | P0×1 / P1×6 / P2×14 | P0:另一个 pack 写的裸标记行被静默删除;运维决定被 upsert "洗白"成 pack 行后可被下一版删除 |
| #5442 | R1 | 10 | P1×3 / P2×7 | CAS 竞态外的三类:`x-tenant-id` 定租户、审计先于 store 烧掉至多一次、终点部分失败仍报"已发送" |
| #5442 | R2 | 13 | P1×2 / P2×11 | 578 行 UI 规格不在任何 CI job 里跑;"重放"与"没通知"在 UI 上分不清 |
| #5442 | R3 | 10 | P1×1 / P2×9 | UI 把"回放"当"没通知"反了方向(G6);迁移 085 注释与自己写的行自相矛盾 |
| #5459 | R1 | 5 | P2×5(另 2 条被反驳) | 结转丢了唯一的租户范围;`T7-j` 变异测试打回原样仍全绿(硬编码 objectId 未被证伪) |
| #5459 | R2 | 6 | P1×2 / P2×4 | 租户墙"绑定形状规则"被以可执行复现推翻(D1);同一道门被 15 个 handler 共用,改窄了会打死另外 6 条本来能工作的路径 |
| #5459 | R3 | 6 | P1×3 / P2×3 | 部署预检对墙本身失明;222 runbook Step 0-7 recompute Path B **不可执行**(`sandbox-target/ensure` 不回 sheetId/fieldIdMap);与 #5460 的同名端口签名分叉(合并顺序地雷) |
| #5460 | R1 | 13 | P1×4 / P2×9(另 3 条被反驳) | 4 条 P1 全在"演示四步走不通":拉取面板套在 `v-if=board`、拉完不刷新、刷新卸载报告、大 BOM 八路由仍 403 |
| #5460 | R2 | 16 | P0×1 / P1×7 / P2×8 | P0:三个新 web 用例在任何 workflow 里都不跑;外租户能读到拥有者共享 target 上的真实行数(K1/B-02 被证伪) |
| #5455 | R3 | 11(另 1 条被反驳) | P1×5 / P2×6 | lane L1/L2/L6(L3/L4/L5 本轮未跑完);P1 集中在装机悄悄取消隐藏/收窄一行且不留痕、以及 univer-meta 分类改动整段无测试覆盖 |
| #5442 | R4 | 0(5 条 incomplete) | P1×2 / P2×3 | 反驳者投票因鉴权故障未跑完,5 条留作演示后跟进,不计入本轮确证数 |

**#5455 R3 确证清单(11 条,titles + severity)**:
- P1 — Sole-pack install silently un-hides and re-denies a legacy row an operator had hidden/relaxed — and reports it nowhere
- P2 — Additive path (no reconcile region) launders a pack-less LEGACY row into the calling pack's marker, with no ledger proof
- P2 — An operator row on an UNDECLARED pair inside the rectangle is reported by the dry-run and by nothing on the install path
- P1 — ATOMICITY IS UNPINNED: moving the classification census out of applyRoleWriteScopes' transaction leaves all 7 branches racy
- P1 — The whole univer-meta.ts operator-stamping change has ZERO tests anywhere
- P1 — "Rehearsal = reality" is unwitnessed: the real service's classifyRoleWriteScopeRegion is never called by any test
- P1 — The "executable SQL model" is vacuous for the classification snapshot: it hardcodes WHERE/SELECT instead of decoding them
- P2 — The one-time backfill script — a REQUIRED deploy step — is outside every static gate in CI, and its CLI entry point has no test
- P2 — Service header attributes the backfill to "migration 083", which does not exist
- P2 — No test ties the plugin's hand-written fake port to the host classifier it stands in for
- P2 — PR body's "见证清单(exactly)" undercounts the bounds suite: says 18 scenarios, suite defines and awaits 19

**#5455 R3 被反驳清单(1 条)**:
- P2 — Integration Guard's guarded-path roster has no packages/core-backend entry, so the guard that keeps the 17-test realdb suite from skip-greening is disabled(反驳者判定不成立)

**#5442 R4 incomplete 清单(5 条,反驳者投票因鉴权故障未跑完,视为演示后跟进项)**:
- P1 — J1 invites a resend the J3 write path can never fulfil: no-notifier deployment shows the banner+button forever, and a two-consecutive-same-handler chain can never advance again
- P1 — tailUnclaimed is wrong whenever two or more hops are unclaimed: the status hides a resend the route accepts and sends — including the completed chain's 仓库+采购 fan-out
- P2 — A hop can go permanently unnotifiable with NO notification_lost row, because the lost-row loop only runs on applied.changed
- P2 — notification_lost rows are appended before the superseding claim is taken, so a resend that wins the claim sends the notice while the trail records it lost forever
- P2 — The resend invitation banner is not gated on can('handoff.advance') while the button it names is

### 4.3 五类漏法(`[[adversarial-verify-guarantee-prs]]`)

1. **假件替真理背书**:mock 把安全语义写死在自己身上,不管真输入说什么都拒写,测试成同义反复。
2. **守卫没接线**:测试文件写得很好但没有任何 CI 会执行它,绊线是死代码。
3. **边界无强制**:保证靠服务端自律成立,没有结构性过滤钉住它,一处配置污染就破。
4. **逐套绿、整链红**:作者逐个套件报绿,但插件测试链是 fail-fast 的,后面几十个套件根本没跑,CI 已红而作者未查(#5447 实证)。
5. **触发条件与边界用了不同的量**:DELETE 的矩形按一个量算,"要不要跑"按另一个量判,某种合法输入让矩形非空而触发为假,保证声称修的 bug 原样活着(#5455 实证,round-2 #1)。

### 4.4 元教训:两轮不收敛就收缩不变式,不要继续打补丁

`#5455` 两轮分别确证 17 条与 21 条(合计 38 条),第三轮不是继续逐条打补丁,而是把保证收窄成**一条**可验证的不变式("这个 pack 的矩形内,reconcile 只能改可证明是这个 pack 的行")并让它覆盖全部分支。**保证面越大,对抗越抓得多**——这不是运气不好,是保证本身的证明面积决定了攻击面积;两轮 38 条时该做的是缩小不变式的范围,不是继续在同一个大保证面上打补丁([[beiliao-24h-program-status-20260903]])。

---

## 5. 运维事实与演示前置

面向 9/4 自机演练与 222 现场部署窗口。

### 5.1 222 runbook 已修正的历史问题(已随 #5456 落地,当前 `origin/main` 上的 runbook 文本已是订正后版本)

- **Step 6-1(dry-run)状态词表**:曾把顶层 `status` 误写成含 `expanded` 值,已订正——顶层 `status` 只有 `not_found | large_bom_bounded | ready | manual_confirm_required | failed` 五个取值,`expanded` **只出现在** 嵌套的 `evidence.expansion.status`;真实行数在 `evidence.expansion.rowsExpanded`,不是不存在的顶层 `rowsExpanded`。
- **Step 6-2(mvp-persist)请求体**:曾误写成带 `confirm`/`dryRunToken` 的形式,已订正为**只接受** `{ parameters }`(`VALID_TABLE_ACTION_MVP_PERSIST_BODY_KEYS`,`http-routes.cjs:1137`);`confirm` 是 `/apply` 路由专属的字段,两条写路径的 body 形状不能混用。
- **§7.2b(沙箱 apply)**:新增小节,明确本窗口实际执行、今天就能跑通的写入路径(D1=B 落地动作),把 §7.2(FOS-4b-3-prod 生产写入,承接键无加载器)标注为"设计,未实现,本窗口不执行"。

### 5.2 仍待随 #5459/#5455 落地的修正(当前 runbook 尚未包含)

- **Step 0-7 绑定重算**:当前文本仍写"改 objectId、留既有 sheetId 不变"——这是 bug:沙箱门只读 objectId,但写入执行器按 sheetId 写;照这条指示配,沙箱门会放行,行却写进 sheetId 指向的正式主表,正是 D1=B 要避免的事。#5459 (R3, C1) 发现 runbook Step 0-7 recompute Path B(`sandbox-target/ensure`)本身**不可执行**(不返回 sheetId/fieldIdMap),修法尚未随 PR 落地到 runbook 正文——objectId 一变必须重算整套绑定(derive 脚本或 ensure 端点配套修复),不能只改半边。
- **Step 3-3a(回填脚本,必做步骤)**:#5455 引入 `packages/core-backend/scripts/backfill-stock-preparation-write-scope-pack-ids.ts`(默认 dry-run,`--apply` 才写),部署前必跑——不跑不会静默出错(customer-pack 安装会带码 422 拒绝并点名这个脚本),但 runbook 正文里的 Step 3-3a 条目要等 #5455 合并后补入。

### 5.3 Step 0-8:handoff 接力链配置(已落地)

`tenantId` 为**必填**字段(2.6 节已述理由);不装这个功能整套行为与没有这个功能逐字节相同(状态读 `configured:false`,推进路由按名报 501,零写库零发消息)——可以整步跳过,不阻塞主线(拉取 → 确认 → 沙箱 apply)。

### 5.3b 通知下一步链:配全或不配,不留半截

`tenantId` + 钉钉 notifier 是一对——222 现场只允许两种姿态之一:**完整配好**(`tenantId` 已填且 `stockPreparationHandoffNotifier` 已接线,群通知真的会发)或**完全不配**(两者都留空,状态读 `configured:false`,推进路由按名报 501)。不允许只填 `tenantId` 不接 notifier,或者只接 notifier 不填 `tenantId`——半配置状态正是 #5442 R4(incomplete)那五条发现的现实基础:notifier 缺席时补发按钮/横幅会永久悬挂,且两个连续步骤同一处理人的接力链会卡死。窗口当天按这条规则二选一,不留中间态。

### 5.4 LEGACY_UNATTRIBUTED:对来历不明的旧行 fail-closed

#5455 之前,`created_by` 里根本没有 pack id——现场每一行都是"裸标记"。裸标记行只有在**装机账本**(`stock-preparation-pack-install-store`,含 `failed` 状态)证明"这块 sheet 上有且只有这一个 pack 装过"时才会被认领(标记或退役);没有这份证明,矩形内的裸标记行是 `UNATTRIBUTED`,安装带码 **422** 拒绝、**一行不动**,留给人跑回填脚本或手工清空——不存在"无主行默认归我"这条静默推断。

### 5.5 projectName 在 mvp-persist 之前是空的

一线自己拉进来的全新项目,在管理员跑过 `mvp-persist` 之前**没有 `projectName`、没有留存快照**。board 会答、行数正确、待确认件数正确、可以导出、可以填写——但项目名是空的,"差异对比"也没有这一批数据。原因:MVP 项目表只由 `mvp-persist` 写,而它按裁决留在平台管理员一侧(`reconcile` 已被折进操作员拆分,因为不折它一线会被锁进死循环;`mvp-persist` 没有这个性质,少了它一线这次运行仍能完整跑完,见 §6 待裁决第 6 条)。

### 5.6 迁移编号:083 → 086

`origin/main` 当前最高的备料审计迁移是 `085`(`084_create_integration_stock_prep_handoff.sql` / `085_extend_stock_prep_audit_handoff_action.sql`,均随 #5442 落地),**没有 `083`**——#5459 与 #5460 各自在自己分支上用的都是 `083`(编号自 `origin/main @ 082` 之后顺延)。审计迁移绊线按"编号最高的那条词汇迁移"做集合相等断言,#5442 先于 #5459/#5460 合入,两支分支下次 rebase 时这条绊线会当场变红,**逼着**改成 `086` 并重列全部动作——这是设计好的安全网,不是巧合(#5460 body)。

### 5.7 pnpm store 事故与 worktree 卫生(简述)

长会话累积的并发 agent worktree 反复出现"junction 被 `git worktree remove --force` 顺藤删掉主检出 `.pnpm` 存储内容"的事故(`pg`/`mssql`/`typescript` 等包目录还在、内容被掏空),本机 pnpm store 目前**不完整**,插件 fail-fast 测试链在本机(含 `main` 自身)会停在第一套、`tsc`/`vue-tsc` 本地也跑不了——**CI 是唯一裁判**,本地绿不算数。已有验证过的批量安全清理配方(阳性对照 + `fsutil reparsepoint delete` 精确拆链 + `cmd /c rmdir /s /q` 不跟随 junction),91 个目录零事故清理过一次。详见 `[[subagent-deletion-boundary]]`、`[[local-pnpm-store-incomplete]]`。

---

## 6. 待 owner 决定

| # | 问题 | 现状 |
|---|---|---|
| 1 | **D1 生产加载器**(P4 file loader) | D1=B(沙箱)只解了 222 窗口;`context.config.stockPrepApplyProduction` 仍无加载器,Wave1 W1-7 未开工,是否/何时补 |
| 2 | **8 个老 tab 是否对操作员放开** | O1' 暂不全开,一线默认只落项目备料页,管理员仍落工作台;是否要给一线更多可见性待裁 |
| 3 | **自制/外购是否要做预填/建议** | 当前明确"只是字段,不是路由",无任何自动派生消费它(R10:开放但只做人工列);若未来要做建议式预填需要新裁决 |
| 4 | **小时精度分批是否默认开启** | R7 opt-in,默认整项目一次拉;W3-2(UI 开关)未建 |
| 5 | **B2a 读授权门默认姿态** | 未设登记表则休眠(不拦);是否要求每次部署强制登记 |
| 6 | **`mvp-persist` 项目行半边并入操作员拆分** | 不并入 ⇒ 一线自拉的新项目 projectName 长期空缺、无差异对比数据(见 5.5);并入是单独一次裁决,`mvp-persist` 不像 `reconcile` 那样有"不并入就死循环"的强制性 |
| 7 | **按租户分交接链** | 当前一次部署只能服务一条 handoff 链;多租户各自独立链是后续工作,范围与时间未定 |
| 8 | **系统性租户 PR 的范围** | 待起,把 `http-routes.cjs` 里所有备料 `*Input` 入口从 `resolveTenantId` 换成 operator-scope,并把 2.5 节"表归属"墙推广到 `apply`/`dry-run`/`mvp-persist`/`reconcile`(目前只有 carry 与 board 有这堵墙,#5459/#5460 body 都明确说"推广到 apply 是另一个决定,本 PR 不做");必须等 #5455/#5459/#5460 三支合完再起(都改 `http-routes.cjs`,并集会互撞)。PR 编号:未开,演示后 |

---

## 7. 附录

- **逻辑地图(Artifact,读结构/关系表用)**:https://claude.ai/code/artifact/05b3319e-4108-43a9-a5cb-084c2f70a5b4 (`备料数据地图`,核对基线 origin/main @ 2026-09-02 `#5447` 合入后)。仓库内副本:`beiliao-data-map.html`(同目录)。
- **对抗验证判决文件**(均在会话 scratchpad,`confirmed[]`/`refuted[]`/`clean[]` 结构):
  `adv5455-verdict.json`、`adv5455r2-verdict.json`、`rc5442-verdict.json`、`rc5442r2-verdict.json`、`rc5442r3-verdict.json`、`adv5459-verdict.json`、`adv5459r2-verdict.json`、`adv5459r3-verdict.json`、`adv5460-verdict.json`、`adv5460r2-verdict.json`
- **引用的记忆条目**:
  `[[beiliao-24h-program-status-20260903]]` `[[beiliao-demo-decisions-20260902]]` `[[beiliao-dingtalk-todo-decision]]` `[[beiliao-two-table-divergence]]` `[[x-tenant-id-header-hole]]` `[[adversarial-verify-guarantee-prs]]` `[[subagent-deletion-boundary]]` `[[stock-prep-legacy-stockorder-zip-assessment]]` `[[plm-source-schema-exattr-dictionary]]` `[[local-pnpm-store-incomplete]]` `[[integration-consolidation-plan-20260901.md]]`
- **引用的仓库文档**:
  `docs/development/takeover-beiliao-20260821/stock-preparation-overall-plan-20260902.md`、`docs/development/takeover-beiliao-20260821/222-deploy-window-runbook-20260901.md`、`docs/development/takeover-beiliao-20260821/decision-register.md`、`docs/integration-consolidation-plan-20260901.md`、`plugins/plugin-integration-core/lib/stock-preparation-templates.cjs`、`plugins/plugin-integration-core/lib/stock-preparation-operator-scope.cjs`、`plugins/plugin-integration-core/app.manifest.json`
