# 备料拉取:项目目录子树桥接 + 定时拉取 —— 设计记录与对抗审查(2026-09-05)

> 来源:只读调研(sonnet×2)→ 设计(opus)→ 对抗审查(opus×2)。审查两路均 refuted=true,其发现被裁定为**实现前必修项**(见 §0)。本文是实现的规格依据。

## 0. 裁定:实现前必修的三项(来自对抗审查)

1. **越界防护(安全级)**:子树遍历的**每一次** `read(plan.pathInfo.object, {parent: node})` 与 `read(plan.bomHead.object, {path_id: node})` 都必须用 `matchesByField` 做后置过滤,只保留真正匹配过滤键的行——与订单路径 :911 处的做法一致。原因:`bridge:legacy-sql-readonly` 源可能返回 `filtersApplied:false`(全表),`readAll` 不校验过滤是否生效;不后置过滤,一次 BFS 会把全库 PathInfo 当成子节点,继而读到其它项目/共享零件库的 BOM。`visited` 与 `maxSubtreeDepth` 对此无效。
2. **去重必须覆盖全部已展开零件,不只是根**:维护"本次已展开的 componentSourceId 集合"(含子件),子树根命中即跳过并计数 `subtreeRootsSkippedAlreadyExpanded`。原因:零件 B 既是订单根 A 的子件、又是子树根时,`idempotencyKey` 分别为 `{P,B,"A",["A","B"]}` 与 `{P,B,null,["B"]}`,规划器视为两行,写入后导出双算。另:同一零件在子树内有多张表头(600028853 有 2 张)→ 按 `part_id` 去重并按版本择一,否则同键两根必然 `duplicate_expanded_key` 挂起。
3. **读预算要真的存在**:`maxReadCount`/`maxElapsedMs` 是可选项,222 未设即不生效;`maxPages` 是每次 `readAll` 内部归零的分页数,不是总量。要求:`maxSubtreeDepth ≤ 4`、`maxSubtreeNodes ≤ 2000`、`maxSubtreeRoots ≤ 500` 做**代码硬顶**(normalize 时超顶即拒);**启用 `projectSubtree` 时强制要求计划带 `maxReadCount`**,否则 normalize 报错。超限一律 global error(`subtree_node_limit_exceeded`/`subtree_root_limit_exceeded`/`subtree_cycle_detected`),不进 `LARGE_BOM_BOUNDED_ERROR_TYPES`。

## 1. 子树桥接方案

**推荐**:把「项目→文件夹子树→BomHeadInfo.path_id→以 part_id 为根」做成读取计划里的一个**可选块** `projectSubtree`(默认缺省=关闭),在展开器里作为**订单循环之后追加的第二段根发现**实现,复用现有的 readPart / rowFromPart / pushRow / expandChildren,一行订单逻辑不动。预检侧不要把 project-subtree 当成第三个「独占载体」塞进 detectedBridge 的判定——那会撞上 planAssumedBridge/matchesConfigured 与「声明与实测矛盾」;正确做法是:值词表加 project-subtree(让 declaredBridge 能合法承载它),把既有的矛盾判定**收窄到独占对 [order-module, design-bom]**(对这两个值逐字节等价),再给子树轴**新增它自己的实测反证**(bomHead 样本里有没有 path_id 列、非空占比),声明了但数据否认就出新 blocker。这样「人可以声明,但不能声明出数据否认的拓扑」这条规矩在新轴上照样成立。默认计划(PLM_STOCK_PREPARATION_BOM_READ_PLAN)**不加**这个块,合成夹具守卫因此不受默认路径影响,「关掉=逐字节不变」是结构性的而不是靠自觉。

### 1.1 语义规则
- 【去重是能不能 apply 的前提,不是优化】订单根与子树根若指向同一个零件,两行的 idempotencyKey 逐字节相同——makeIdempotencyKey(C:/Users/zhou/Downloads/dev/metasheet/plugins/plugin-integration-core/lib/stock-preparation-bom-expansion.cjs:467)只吃 {projectNo, componentSourceId, parentSourceId:null, path:[id]},两条路径这四项完全一致。冲突规划器按 idempotencyKey 分组(stock-preparation-conflict-planner.cjs:485-499),重复组 defaultPolicy 是 'hold'(:758-761)→ 整个计划变 manual_confirm、canApply=false。所以规则必须写死:**订单根先跑并登记 rootsBySourceId,子树根命中已登记的 componentSourceId 就跳过并计数 subtreeRootsSkippedByOrder**。
- 【根数量】没有订单明细就没有 rawQuantity。建议 rawQuantity=totalQuantity=1,并在 summary/evidence 里加计数 rootQuantitySource:{orderDetail:N, subtreeDefault:M}(是计数,不是行上的业务值,值面不泄漏)。绝不能传 null/'' 走 parseQuantity:该函数的 hold-not-zero 规矩(:429-448)会把空值判成 invalid_quantity。若 owner 拒绝默认 1,替代姿态是发 rowError missing_root_quantity —— 但那样 222 上一行都拉不出来。
- 【深度】新增 maxSubtreeDepth(默认 1,建议硬上限 ≤4),与 BOM 的 maxDepth(:17 DEFAULT_MAX_DEPTH=20)是**两个互不相干的深度**:一个数文件夹层级,一个数 BOM 层级。默认 1 正好覆盖 222 实测形态(项目 2-20231625 的 6 个 BOM 表头挂在深度 1 的子节点上)。另加 includeSelf(默认 true):项目节点自身也查一次 bomHead,代价是 1 次读。
- 【读预算自动接入,不写新预算代码】子树的每一次 read 都走同一个闭包 read() → readAll(:351)→ assertReadBudget(:334-350),所以 maxPages / maxReadCount / maxElapsedMs 原样生效。另加 maxSubtreeNodes(默认 200)与 maxSubtreeRoots(默认 200)两个**结构性**上限,超限发 global error subtree_node_limit_exceeded / subtree_root_limit_exceeded。
- 【新上限的错误类型不许进 LARGE_BOM_BOUNDED_ERROR_TYPES】照 READ_CURSOR_BROKEN_ERROR_TYPE 的先例(:24-38 的整段说明):那四个类型的含义是「BOM 太大,改走后台任务」,把子树节点超限塞进去,只会让一线被指引去重跑一次必然再撞同一个上限的读。
- 【超限必须是 global error,不能是 rowError】planner 的 missingFromPlmPolicy 恒为 'mark_inactive'(stock-preparation-conflict-planner.cjs:212-222):根集合被截断一半,等于把上一次拉进来的行大面积置为无效。global error → errors.length>0 → status 'failed' → canApply=false,是唯一安全姿态;rowError 会让一次残缺的根发现「成功」落库。
- 【环】现有 cycle_detected(:876-879)只看 BOM 的 pathTokens。DN_PDM_PathInfo 是 OBJ_ID/Parent_OBJ_ID 自引用树,子树 BFS 必须自带 visited Set,命中即 global subtree_cycle_detected。
- 【子树根的子件靠既有 expandChildren,代价要说清】expandChildren 会用根件 part 的 SysVer 再查一次 bomHead(:819-822 headFilters 带 versionField)。若子树发现的表头 SysVer 与 part.SysVer 不一致,这个根件会**一个子件都没有**。复用既有函数就必须接受这条,所以要在 evidence 里加 subtreeRootsWithoutChildren 计数,让「拉出来 6 个光杆根件」这件事可见而不是无声。
- 【读对象集合不变】子树只读 plan.pathInfo.object 与 plan.bomHead.object,两者已在既有七对象内。summary.readObjects 是去重集合(:989 区段),b2a 的 objectScope 是结构化遍历 plan 里所有 `object` 键(b2a-trial-registry.cjs:386-408),preflight 的探测名单也从计划取(source-preflight.cjs:560-602)。所以只要 projectSubtree 块**复用同名对象、不引入新表名**,授权面与探测面都无需放宽。
- 【关掉=逐字节不变】块缺省时 normalize 不产出 projectSubtree 键,展开器第二段一个 if 就整段跳过:不多一次读、不多一个 summary 键(计数键也只在启用时出现,照 createRow 的 conditional-key 纪律 :585-596)。这一条要有测试钉死(见 tests)。
- 【预检:三个轴,不是三个载体】detectedBridge 保持「哪个表拿生产 BOM 行」的独占语义不变(planAssumedBridge :688-690 只看 orderDetail.object;matchesConfigured 不变,否则 :1533-1545 的 TOPOLOGY_MISMATCH 会因为一个加法特性把所有人拦住)。project-subtree 是**根发现轴**,加法而非替代,报告里放在 topology.subtree = {configured, declared, columnPresent, populatedRows, rowCap, measured}。

### 1.2 逐文件改动
- **plugins/plugin-integration-core/lib/stock-preparation-bom-expansion.cjs**
  - 改什么:(1) 默认计划 :177-234 **不动**——projectSubtree 不进默认计划,默认关闭因此是结构性的。(2) normalizeStockPreparationBomReadPlan(:239)新增可选块 projectSubtree:pathInfo.parentIdField(必填,走既有 normalizeObjectFields :164)、bomHead.pathIdField(必填)、maxSubtreeDepth/maxSubtreeNodes/maxSubtreeRoots(positiveInteger :143)、includeSelf(布尔);块缺省则整个键不出现。assertNoForbiddenPlanKeys(:97-110)自动覆盖新块,sql/where/join 仍被拦。(3) 新增内部 discoverSubtreeRoots():从 pathId 起对 plan.pathInfo.object 做 BFS(filters {[parentIdField]: nodeId}),每个节点读 plan.bomHead.object(filters {[pathIdField]: nodeId}),表头过 isActiveBomHead(:383),取 parentPartField 作为 rootSourceId,自带 visited Set 与两个结构上限。(4) 在 :904-960 的订单循环**之后**追加第二段 for 循环:对每个未被订单占用的 rootSourceId 调 readPart(:801)→ rowFromPart(:679,rawQuantity=totalQuantity=1)→ pushRow → expandChildren(:816)。(5) makeSummary(:536)与 summarizeBomExpansionForEvidence(:1000)在启用时透传 subtree 计数块。(6) 导出新错误类型常量供测试引用。
  - 为什么:所有新逻辑都在订单段之后追加,订单段的每一行都不改;新读走同一个 read() 闭包,预算/读诊断/值面纪律全部沿用,不新造第二条读路径。
- **plugins/plugin-integration-core/lib/stock-preparation-source-preflight.cjs**
  - 改什么:(1) BRIDGES(:254-261)加 PROJECT_SUBTREE:'project-subtree' —— SOURCE_PREFLIGHT_BRIDGES 由 Object.values 派生,值面闭包(:1736-1739 的 bridge/detectedBridge/configuredBridge/measuredBridge 词表)自动跟随。(2) 新增 EXCLUSIVE_CARRIER_BRIDGES=[ORDER_MODULE, DESIGN_BOM];把 :1286-1291 的 declarationContradicts 收窄为「declaredBridge ∈ EXCLUSIVE 才计算」——对既有两个值逐字节等价。declarationResolves(:1291)同样只对独占轴生效。(3) DECLARABLE_BRIDGES(:287)加 project-subtree;同时新增 measureProjectSubtreeCarrier():用已有的 rowsOf('bomHead')(:1109)样本行与 observation.columns(:524-551)测「bomHead 有没有 pathIdField 列 / 样本里非空行数」,门槛沿用 BRIDGE_MIN_LINES(:159)。(4) 新增 blocker DECLARED_SUBTREE_CONTRADICTS_MEASUREMENT(进 SOURCE_PREFLIGHT_BLOCKER_CODES 与 SOURCE_PREFLIGHT_BLOCKER_CODE_ORDER,排在 bridge 系之后):声明了子树但列缺失或零非空 → 拦。(5) topology 增加 subtree 子对象;matchesConfigured / planAssumedBridge 不动。
  - 为什么:既满足「词表加 project-subtree 且可声明」,又让「声明与实测矛盾」这条规矩在新轴上有牙齿:老轴的判定一字不改(回归可证),新轴有自己的实测反证,而不是靠给它开一个永不矛盾的后门。
- **plugins/plugin-integration-core/lib/http-routes.cjs**
  - 改什么:无逻辑改动。预检路由的 declaredBridge 校验(:6128-6136)本来就是 DECLARABLE_BRIDGES.includes(...),查询键白名单在 :1421;新值随词表自动生效。仅需确认路由测试里的允许值断言同步。
  - 为什么:把「加一个可声明值」的成本压到只改一处词表,是这条路线相对「新开一个 declaredRootDiscovery 查询参数」的主要好处。
- **plugins/plugin-integration-core/lib/stock-preparation-table-actions.cjs**
  - 改什么:无改动。normalizeSource(:169-186)对 readPlan 是整体 cloneJson 透传,新块自动可通过 INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON 配置;HARD_APPLY_BLOCKING_ROW_ERROR_TYPES(:80)也不需要动——新错误是 global 而非 rowError。
  - 为什么:确认「配置驱动」这条不需要在动作层写任何代码,是本方案能做到只增不改的关键一环。
- **plugins/plugin-integration-core/fixtures/stock-preparation-synthetic-sql-source/01-schema.sql**
  - 改什么:DN_PDM_PathInfo 增列 Parent_OBJ_ID、DN_PDM_BomHeadInfo 增列 path_id,并新增一份种子(如 05-seed-subtree-roots.sql):一个项目 path 节点 + 一个子节点 + 挂在子节点上的表头,其 part_id 是一个**订单里没有**的零件。注意这会同时踩到夹具守卫的两个方向,必须与测试同批改。
  - 为什么:现有夹具里 pathinfo 只有 obj_id、bomheadinfo 没有 path_id(见该文件的建表段),不加列就无法在无数据库的情况下把子树路径跑起来;而 222 上的客户测试库本身跑不完整链(docs/development/takeover-beiliao-20260821/222-rehearsal-full-run-20260904.md:23-27),合成夹具是唯一能自证的地方。

### 1.3 测试
- 【会红·必须同批修】C:/Users/zhou/Downloads/dev/metasheet/plugins/plugin-integration-core/__tests__/stock-preparation-synthetic-sql-fixture.test.cjs:365 的 sections 七件套硬编码、:369 的 assert.equal(schema.size, sections.length)、:400-414 的反向断言「DDL 不许声明计划从不读的列」。一旦给夹具加 parent_obj_id / path_id 就会红。修法二选一:把 subtree 段并入 sections(从一个**启用了子树的**归一化计划取字段),或把两列登记进 :63 的 SCHEMA_COLUMNS_NOT_READ_BY_PLAN 并写明理由。推荐前者。
- 【新增·把默认关闭钉死】同一文件里加一条正面断言:normalizeStockPreparationBomReadPlan(PLM_STOCK_PREPARATION_BOM_READ_PLAN).projectSubtree === undefined。没有这条,「默认关闭」只是当下事实而不是保证。
- 【已核对不会红】stock-preparation-structure-exact-rehearsal.test.cjs:342 的 summary.rootMatches===1 与 __tests__/stock-preparation-demo-runner.cjs:369 —— rootMatches 仍是 pathExAttr 的命中数(展开器 :989 区段),子树根不改这个数;stock-preparation-bom-expansion.test.cjs 的既有断言也不动,因为默认计划没变。
- 【新增·逐字节不变】关闭态回归:同一份夹具数据,带/不带 projectSubtree 块跑两次,断言 calls 数组(对象+过滤字段+顺序)、rows 序列、summary 的键集合三者完全相同。这是「只增不改」唯一可证的形式。
- 【新增·只有子树能出根】库里零订单明细、6 个表头挂在深度 1 → 6 个 depth 0 根,rawQuantity===1,summary.subtree.rootQuantitySource.subtreeDefault===6。
- 【新增·订单优先去重】同一根件既在订单明细里又在子树表头上 → 只出 1 行、summary.subtree.rootsSkippedByOrder===1,并直接断言 duplicateExpandedKeyDiagnosticsForRows(result.rows)===undefined(把「不会触发 hold」钉在合同上,而不是靠推理)。
- 【新增·截断即失败】maxSubtreeNodes 超限 → errors 里是 subtree_node_limit_exceeded,且 isLargeBomBoundedExpansion(result)===false(钉住「不会被误路由到后台任务」),status==='failed'。
- 【新增·文件夹自环】Parent_OBJ_ID 指回祖先 → global subtree_cycle_detected,读次数有界。
- 【新增·SysVer 错配】子树表头的 SysVer 与 part.SysVer 不一致 → 根行落地但无子件,summary.subtree.rootsWithoutChildren===1。
- 【新增·预检三条】(a) declaredBridge='project-subtree' 且 bomHead 样本 path_id 有值 → 不出 DECLARED_BRIDGE_CONTRADICTS_MEASUREMENT,detectedBridge 仍是实测的 order-module;(b) 同样声明但 bomHead 无 path_id 列 → 新 blocker DECLARED_SUBTREE_CONTRADICTS_MEASUREMENT;(c) 回归:__tests__/stock-preparation-source-preflight.test.cjs:744(customerShapedSource + declaredBridge:'order-module')与 :715-731 的两条判定原样通过。
- 【测试链】优先把新用例塞进已有的 stock-preparation-bom-expansion.test.cjs / stock-preparation-source-preflight.test.cjs / stock-preparation-synthetic-sql-fixture.test.cjs,不新建测试文件——新文件要挂 plugins/plugin-integration-core/package.json 的 scripts,而那正是并发 PR 的 O(n²) 冲突源。

### 1.4 设计自述风险
- 【配置翻转是破坏性的】关掉子树后的下一次拉取,会把子树来的行按 missingFromPlm 全部置为无效(conflict-planner.cjs:212-222 的 mark_inactive 是 v1 唯一允许值)。人工列会保留,但备料状态会变。这不是 bug,是语义,必须写进文档并由 owner 认可。
- 【dry-run token 会 fail-closed】token 绑定 revision;在 dry-run 与 apply 之间改这段配置 → TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH。行为正确,但现场会困惑,改配置必须在没有在飞 token 时做。
- 【快照与批次身份全变】根集合变大 → batchId 变、snapshot diff 全量变化,历史快照与新快照不可直接比。
- 【222 测试库的真实数据会大面积报缺料】文档已实测:子树里挂 BOM 的项目 2-20231625,根零件下 40–60% 子件不在物料表(docs/development/takeover-beiliao-20260821/222-rehearsal-full-run-20260904.md:24)。这些会变成 rowError missing_component(不是 HARD blocking —— HARD 只有 missing_child_bom,table-actions.cjs:80),但 canApply 由 hasGlobalErrors/plan.valid 共同决定,**必须在 222 上真跑一次**才敢说能演示,不能靠推断。
- 【读放大】6 个根各带一棵 BOM,再加文件夹 BFS,读次数明显上升;若部署已把 maxReadCount 配得紧,会更早撞 read_count_exceeded,被判为 large BOM 而路由到后台任务路径(那条路径只能靠人 POST 推进,见 B 部分)。
- 【预检的两轴要在报告里说清】detectedBridge 仍会是 order-module,而实际根来自子树。若消费方(人或脚本)把 detectedBridge 读成「行从哪来」,就会读错。topology.subtree 必须显式,且文档要写明这两个轴各回答什么问题。

## 2. 定时拉取(替代委派)

**可行**:True

可行,但**不是**在插件里加定时器 —— 那一环确实缺,而且缺的是授权面而不是调度器。可行且零插件改动的做法是:**222 上的系统 cron(或 systemd timer)拿服务账号 token,顺序打两个既有路由** POST /api/integration/table-actions/plm.stock-preparation.pull-bom.v1/dry-run → .../apply(路由表 http-routes.cjs:63,65)。

为什么进程内调度不可行(三条实证):(1) 插件里没有任何调度器 —— 字符串 'cron' 在整个 plugin 只出现一次,就是 pipelines.cjs:28 的词表本身,没有任何代码产出 triggeredBy:'cron'(pipeline-runner.cjs:908 默认 'manual',http-routes 全用 'api');(2) 所谓「后台任务」也不是后台 —— runLargeBomBackgroundExpansionJob 的唯一调用点是 http-routes.cjs:5842,必须有人 POST 才推进一步;(3) 拉取链路整条是 req-shaped:requireTableActionAccess(:987-1006)、assertB2aStockPreparationReadAuthorized(:4073-4092)、scopedInput(:1140-1146)都以请求对象为输入,无 req 的进程内调用只能伪造请求主体 —— 那是一条新的鉴权绕过面,不该为演示开。平台侧确实有调度器(packages/core-backend/src/multitable/automation-scheduler.ts,cron + leader lock),但它的动作类型表里没有「调用插件路由」这一项(automation-actions.ts:6-33,只有 send_webhook 等),要用它得先新增动作类型,那是核心改动。

身份:必须是**租户绑定**的服务账号,不能是无租户平台管理员 —— 后者可以用 x-tenant-id 请求头指定租户(resolveTenantId 的既有能力),正是那个跨租户洞。数据面不需要给它任何 PLM 凭据:resolveTableActionReadPrincipal(http-routes.cjs:4143-4160)对 pull-bom 这**一个** actionId 用服务端登记的 config.dataSourceOwnerId 去读 PLM,且该值来自服务端、请求改不动。

幂等:apply 必须携带 dry-run 发的**一次性 token**(前缀与 30 分钟 TTL 见 table-actions.cjs:76-77),apply 会重新展开并比对 revision,源在两枪之间变了就 fail-closed。因此脚本天然是「同一次运行里连打两枪」,不能拆成两个 cron。脚本**不要**传 acceptManualConfirmHold / acceptDuplicateResolution —— 冲突必须留给人。

落点:apply 默认仍只允许沙箱目标(stock-preparation-production-policy.cjs:1-16,productionPolicy 只能来自服务端配置),定时化不会绕过 prod gate。

一线界面「上次同步时间」:**不需要任何新写入**。冲突规划器给每一行都写 lastPlmRefreshAt(conflict-planner.cjs:1077-1084 runPatch),模板里就是「最近刷新时间」(stock-preparation-templates.cjs:740);看板已经把这个项目在绑定表里的每一行都扫过一遍(stock-preparation-project-board.cjs:370-417),在同一次扫描里取 max 就得到 lastPulledAt,前端照抄 lastExportText 的写法即可。

### 2.1 改动
- **scripts/ops/(新增,如 stock-preparation-scheduled-pull.cjs)+ 222 crontab**:一个运维脚本:读服务账号 token → POST dry-run → 取 dryRunToken 与计数 → 决定是否 POST apply(建议第一波只跑 dry-run) → 把两次响应的 JSON(值面本来就是计数与枚举)落到 222 的日志文件,非零退出触发运维告警。
  - 为什么:插件里没有调度器也没有无 req 的授权路径,外部定时器是唯一不新开授权面的做法;两枪必须在同一次运行里,因为 dry-run token 一次性且 30 分钟过期。
- **plugins/plugin-integration-core/lib/stock-preparation-project-board.cjs**:冻结投影 STOCK_PREPARATION_PROJECT_BOARD_KEYS(:143-161)加 lastPulledAt;readPullTargetRowFacts(:370-417)在已有的逐行扫描里顺带取 max(row.data[binding])。绑定必须按**可选**字段解析:REQUIRED_EXPORT_FIELD_IDS 只有 projectNo/active(stock-preparation-prep-line-export.cjs:172),显式 fieldIdMap 未绑 lastPlmRefreshAt 时降级为 null,**绝不能**像缺 scope 列那样返回 PULL_TARGET_NOT_READY。
  - 为什么:看板已经在扫这些行了,取一个最大值是零额外读、零新写入、零迁移;而 lastSyncRunId 走的是 mvp-persist(平台管理员路径),一线自己拉的时候永远是 null(该文件 :64-77 的整段说明)。
- **apps/web/src/services/integration/stockPreparation/projectBoard.ts**:类型加 lastPulledAt: string | null(挨着 :68 的 lastExportAt)。
  - 为什么:投影是冻结键集合,前后端类型必须同批加。
- **apps/web/src/components/integration/stockPreparation/StockPreparationProjectBoardView.vue**:照抄 lastExportText 的 computed(:528-535)加一个 lastPullText,在拉取状态那一格旁边(模板 :113-123)加一行「上次同步」。
  - 为什么:现成的时间格式化与 zh/en 双语写法就在同一文件里,直接复用,不引入新样式或新组件。
- **plugins/plugin-integration-core/lib/stock-preparation-audit-store.cjs**:(可选,需 owner 拍板)在 STOCK_PREP_AUDIT_ACTIONS(:49-88)新增一条拉取动作,并配一支数据库 check 约束迁移(照 080/082/085/086 的先例;:260-300 明说进程内词表与数据库约束是两回事)。之后看板可用 lastExportAtFor(:216-233)同款查询给出权威的「上次同步时间」。
  - 为什么:今天没有任何审计动作记录拉取本身,所以定时任务的成败在产品里看不见;行级 lastPlmRefreshAt 只能证明**成功写入**的那一次,记不下失败的那次。

### 2.2 风险
- 无人值守 apply 会写沙箱表:PLM 删了一行,对应备料行就被置为无效(mark_inactive)。人工列虽保留,但状态会在没人知情的情况下变。**强烈建议第一波只定时 dry-run**,把「有变化」当提醒,apply 仍由人按。
- token 一次性 + 30 分钟 TTL:两枪必须在同一次运行里完成,拆成两个 cron 必然失败。
- 服务账号 token 落在 222 磁盘上,轮换与泄漏是新的运维风险面;且该账号必须是租户绑定主体,配错成无租户平台管理员就把跨租户能力交给了一个定时脚本。
- 产品内不可见:没有拉取审计动作 → 谁在什么时候拉的、失败了几次,都查不到。lastPulledAt 只能反映最后一次**成功**的写入。
- 若某项目被判为 large BOM(读预算超限),定时脚本拿不到可 apply 的结果——那条路径要靠人 POST 一步步推进后台任务(http-routes.cjs:70-72),脚本必须识别 status==='large_bom_bounded' 并退出报警,而不是重试。
- 把调度做进进程内(automation 新动作类型 + 无 req 的授权路径)会重新打开 B2a / operator-scope 两道授权面,为演示做这件事不划算;真要做,应当作为独立的一波并配对抗式评审。

## 3. 对抗审查原文

### [safety] refuted=True

**理由**:

方案在这四个角度上都有可核实的破绽。按严重度排:

【1. 读预算的核心论断是假的】方案说「子树的每一次 read 都走同一个闭包 read() → readAll → assertReadBudget,所以 maxPages/maxReadCount/maxElapsedMs 原样生效」。代码不是这样:
- maxReadCount/maxElapsedMs 是**可选**的 —— stock-preparation-bom-expansion.cjs:713-714 用 optionalPositiveInteger,缺省即 undefined;assertReadBudget(:334-349)两条都写着 `if (options.maxXxx !== undefined)`,undefined 时整段是空操作。
- 动作层同样缺省无值:stock-preparation-table-actions.cjs:290-291 `positiveInteger(input.maxReadCount, ..., undefined)`。222 的 action JSON(222-deploy-window-runbook-20260901.md §0/§2026-09-03 r7)没有配这两项;全仓 docs 里也只有验证文档提过它们。
- 唯一常开的 maxPages 是**每次 readAll 调用内部的翻页数**(:352-358,`for (let page = 0; ...)` 每次调用从 0 开始),它不计读取次数。
结论:在方案要落地的那个部署里,子树打开后没有任何读次数上限、没有任何时间上限,唯一终止条件是 maxRows=10000(:18)。而且方案新增的 maxSubtreeDepth/Nodes/Roots 走 positiveInteger(:139-146),**没有上界**,「建议硬上限 ≤4」只是注释;配置里写 maxSubtreeNodes:100000 会被原样接受。

【2. 读放大是量级的,不是「明显上升」】展开器没有全局零件 visited 集合,环检测只看单条路径(`pathTokens.includes(childSourceId)`,:876-879)。每个子树根都从 [rootSourceId] 重新起路径,共享子 DAG 会被**每个根重走一遍**。222 实测 887 个零件 / 143 张表头 / 1319 行明细(runbook:115)本来就高度共享。原来订单路径最多 7 个根,方案默认 maxSubtreeRoots=200。每行至少 3 次读(bomHead+bomDetail+part),10000 行上限意味着一次同步 HTTP 请求里可以打出 3 万次以上 PLM 往返,且无 elapsed 上限。

【3. 越界:B2a 的项目授权在这条轴上完全失效】assertB2aReadAuthorization 第 4 步(b2a-trial-registry.cjs:1237-1244)只按 `dataScopeRef` 授权,而 dataScopeRef 就是**请求里的 projectNo**(http-routes.cjs:4082)。第 5 步对象域(:1247-1259)因为子树复用同名对象而必然通过 —— 方案把「授权面无需放宽」当成优点,恰恰是问题:读到的**数据**变了而**对象名**没变,B2a 在这条轴上没有任何控制点。没有任何下游代码校验「发现的根属于被授权的项目」。证据里仍然写着 dataScopeRef=那一个项目号。

【4. 子树的「不越界」是对数据的断言,不是代码强制】BFS 留在项目文件夹树内,完全依赖数据源真的执行了 `{Parent_OBJ_ID: nodeId}` 这个 filter。readAll 只**记录** filtersApplied(:385)、从不**强制**;bridge 适配器可以合法返回 filtersApplied:false(adapters/bridge-agent-readonly-adapter.cjs:469,测试 __tests__/bridge-agent-readonly-adapter.test.cjs:169/195),而 bridge:legacy-sql-readonly 是被允许的 sourceKind(:40-43)。既有代码只对 pathInfo 和 part 做了客户端二次过滤(matchesByField,:904-918、:801-813),bomHead/bomDetail 都没有(:819-822、:838)。方案的 discoverSubtreeRoots 也**没提** matchesByField。visited Set 救不了(每个节点只见一次,不触发 subtree_cycle_detected),maxSubtreeDepth=1 也救不了(越界发生在深度 1 那一次读)。

【5. 第二段缺 errors 守卫】订单段每层都有 `if (errors.length > 0) break/return`(:817、:905、:932、:943…)。方案改动(4)只写「对每个未被订单占用的 rootSourceId 调 readPart→…」,没写这条守卫。订单段以 max_rows_exceeded(pushRow :746-752)或 cycle_detected 收场后,子树段照跑,继续读,并且每个根重复 push 一次同样的 global error。

【6. 去重不够】idempotencyKey 撞车判断是对的(:467 只吃四项;planner groupByKey :487-501 + defaultPolicy 'hold' :758)。但方案只去重「子树根 vs 订单根」。**两个不同文件夹节点上的 bomHead 指向同一个 part_id,就是两个逐字节相同的子树根**,143 张表头对 887 个零件,重复很可能。而且 222 上订单的 7 个 part_id 全都不在 PartLibraryInfo(runbook:116),rootsBySourceId 是空集,这条去重在 222 上保护不了任何东西。

【7. rawQuantity=1 是伪造的业务值】createRow 把 rawQuantity/totalQuantity 写在行上(:583-584),totalQuantity 还会乘到每个子件(:871)。子树根的 1 与真实订单数量 1 在目标表里逐字节不可区分,方案又明确拒绝行级来源标记。「值面不泄漏」这条纪律是防止源值进计数,不是给伪造值免除来源标注 —— 备料是采购数量件。

【8. 预检 topology.subtree 会把整条预检路由打挂】assertSourcePreflightValuesFree 按**叶子字段名**分类,任何未分类字符串叶子直接 refuse(:1772-1779)。方案写的 `{configured, declared, columnPresent, populatedRows, rowCap, measured}` 里 configured/declared/measured 三个名字既不在 CLOSED_VOCABULARY_LEAF_FIELDS(:367-378),也不在 SERVER_AUTHORED_LEAF_FIELDS(:404-406)、IDENTIFIER_LEAF_FIELDS(:414-427)。一旦这些位置出现字符串,SOURCE_PREFLIGHT_VALUES_FREE_SELF_CHECK_FAILED,**所有**数据源的预检都 500,包括从没开过子树的部署。

【9. declaredBridge 是一个标量,承载不了两条轴】http-routes.cjs:6128 `firstString(input.declaredBridge)`,查询键白名单 :1421。一个部署无法同时声明 order-module(解 undecidableAtCap,:1291)和 project-subtree。222 上更直接:当前 verdict 就是 no-go,blocker 是 bom_store_signals_conflict/volume-undecidable-at-cap,runbook 明写「**这个僵局没有声明参数可用**(declaredBridge 只覆盖 order-module/DesignBom 这条桥)」(222-deploy-window-runbook-20260901.md:112)。另外 DECLARABLE_BRIDGES 会被回显给一线:NO_BOM_BRIDGE 的 `declarableBridges`(:1526)和 400 文案「declaredBridge must name one of the two bridge candidates」+ `allowed`(http-routes.cjs:6133-6135)。加第三个值等于把一个**证明上解不了该 blocker**的选项摆进修复清单,并让产品文案变成假话 —— 这不是「路由测试断言同步」。

【10. 那两列在仓库里没有任何证据】仓库自己的 222 列对照表记的是 `DN_PDM_PathInfo | OBJ_ID`、`DN_PDM_BomHeadInfo | part_id, bom_id, SysVer, bom_able`(222-rehearsal-full-run-20260904.md:79-86);唯一记录在案的 Parent_OBJ_ID 属于 **PathExAttrInfo**(同表;runbook:115)。没有任何文件记录 BomHeadInfo.path_id、也没有「2-20231625 的 6 张表头挂在深度 1」「137 张无项目祖先」。方案的默认 maxSubtreeDepth=1 建立在我在仓库里找不到的实测上,而它自己提的 DECLARED_SUBTREE_CONTRADICTS_MEASUREMENT 按已记录的目录形态就会触发。

【11. 夹具守卫的方向说反了】testSchemaCoversReadPlan(__tests__/stock-preparation-synthetic-sql-fixture.test.cjs:363-420)断言:恰好 7 张表(`assert.equal(schema.size, sections.length)`)、默认计划每个字段都有列、以及「nothing in the DDL that the plan never reads」—— 后者是对 **PLM_STOCK_PREPARATION_BOM_READ_PLAN**(方案刻意不放子树进去的那个)算的。于是 Parent_OBJ_ID / path_id 只能**永久**登记进 SCHEMA_COLUMNS_NOT_READ_BY_PLAN,而那份清单自己的断言是 `assert.ok(!required.has(key), '… stale — the plan DOES read it')`。被当成「唯一能自证的地方」的守卫,最后是在给这两列出具「永不被读」的证明。

【12. rowError 不拦 apply,222 的风险比方案写的更坏】canApply = `!hasGlobalErrors && !hasHardRowErrors`(table-actions.cjs:1251),hasHardRowErrors 只认 missing_child_bom(:80、:1300-1301)。所以「根零件下 40–60% 子件不在物料表」不会阻止 apply,而是**静默丢掉 40–60% 的 BOM 再把剩下的写进去**。方案把它当作待验证的未知,代码已经给出答案,且是更危险的那个答案。

【13. 定时拉取:确实等于把借来的管理员数据权固化】resolveTableActionReadPrincipal(http-routes.cjs:4143-4157)让 PLM 读以 config.dataSourceOwnerId 身份跑,覆盖 stored principal。交互式是人点一次借用一次;cron 是无人值守的常驻借用。叠加方案自己承认的「没有任何审计动作记录拉取」以及 lastPlmRefreshAt(conflict-planner.cjs:1077-1084)只记成功写入 —— 事后无法回答「谁、以谁的身份、拉了什么、失败几次」。另外 HTTP 门比方案说的软:requireTableActionAccess(:986-1005)在 `hasPermission(user, legacyGate)` 时**直接 return**,跳过 operatorMayRunStockPrepPull 和 resolveOperatorValueScope(operator-scope 租户校验);调用点 legacyGate 就是 'read'/'write'/'admin'(:5744、:5945、:5987)。按常规给服务账号 integration write 就绕过了那道租户校验,只剩 resolveTenantId 的 isTenantlessPlatformAdmin 分支(:1013-1031)兜底。方案的「必须租户绑定」因此是承重条件,必须是发放时的强制校验,不能只写在 runbook 里。

【14. lastPulledAt 会静默偏旧】readPullTargetRowFacts(project-board.cjs:383-417)按 offset 翻页、无排序、到 PULL_TARGET_MAX_PAGES 就返回 bounded:true。在这个循环里取 max,是对一个被截断且无序子集取 max;而子树轴恰恰是把项目行数推过这个上限的那个特性。

方案中**经核实成立**的部分(应保留):对象集合不变,故 readPlanSourceObjects(:386-408)与 objectScope 无需放宽;assertNoForbiddenPlanKeys(:97-110)递归覆盖新块;binding owner 来自服务端、请求改不动;missingFromPlmPolicy 硬钉 mark_inactive(conflict-planner.cjs:212-222);插件内无调度器('cron' 全插件仅 pipelines.cjs:28 一处),automation-actions.ts 动作类型表确无「调用插件路由」;HARD_APPLY_BLOCKING_ROW_ERROR_TYPES 确实不用动。

**具体失败场景**:

状态:222 现网配置(INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON 未设 maxReadCount / maxElapsedMs → stock-preparation-table-actions.cjs:290-291 给 undefined → bom-expansion.cjs:334-349 的两条预算判断全程为空操作),source 绑定 bridge:legacy-sql-readonly(bom-expansion.cjs:40-43 允许),readPlan 打开 projectSubtree,取方案默认 maxSubtreeDepth=1 / maxSubtreeNodes=200 / maxSubtreeRoots=200。

输入:一线对项目 2-20231625 点一次 dry-run(B2a 注册的 dataScopeRef 就是这一个项目号,http-routes.cjs:4082)。Bridge 对 `{Parent_OBJ_ID: <项目节点>}` 这次读返回 filtersApplied:false(bridge-agent-readonly-adapter.cjs:469 的合法返回;测试 bridge-agent-readonly-adapter.test.cjs:169/195 就是这个形状)。

后果链:
1) readAll(:352-393)只把 filtersApplied 记进 stat,不校验;discoverSubtreeRoots 也没有 matchesByField 二次过滤 → 第一次 BFS 读回 PathInfo 全表 1189 行(runbook:115),全部当作「项目节点的深度 1 子节点」入队。visited Set 每个节点只见一次,subtree_cycle_detected **不触发**;maxSubtreeDepth=1 也不触发,因为越界就发生在深度 1 这一次读。
2) 对前 200 个节点各读一次 bomHead,拿到 143 张表头里挂在无项目祖先节点下的那 137 张,其 part_id 成为根 —— 这些零件属于别的项目/共享零件库。B2a 第 4 步只校验请求里的 projectNo(b2a-trial-registry.cjs:1237-1244),第 5 步对象域因复用同名表必然通过(:1247-1259),证据里仍写 dataScopeRef=2-20231625。**跨项目数据以「本项目备料行」的身份落库,且授权凭证与审计都显示没越界。**
3) 每个根走 readPart→expandChildren,路径各自独立、无全局零件 visited(:876-879 只查单路径),887 个零件的共享子 DAG 被重复展开;每行 ≥3 次读,唯一终止是 maxRows=10000(:18)→ 一次同步 HTTP 请求里 3 万次以上 PLM 往返,没有 maxElapsedMs 可以打断它。
4) 撑到 maxRows 时 pushRow(:746-752)推 max_rows_exceeded;方案的第二段没有 `if (errors.length > 0) return` 守卫,剩余根继续读、并对每个根重复 push 同一个 global error。
5) 若 2) 里两个节点的表头指向同一个 part_id(143 表头对 887 零件),两条子树根的 idempotencyKey 逐字节相同(:467),planner groupByKey(:487-501)判重、defaultPolicy 'hold'(:758)→ 整个计划 manual_confirm、canApply=false,方案专门为此写的去重规则只覆盖「订单根 vs 子树根」,拦不住。
6) 换一条支线:若第 2 步没撞上重复,canApply = `!hasGlobalErrors && !hasHardRowErrors`(table-actions.cjs:1251),而 222 上「根零件下 40–60% 子件不在物料表」只产生 missing_component,不在 HARD 集合(:80)→ **apply 放行**,把伪造 rawQuantity=1(createRow :583-584,并沿 :871 乘到全部子件)、缺了近一半子件的跨项目 BOM 写进沙箱表。
7) 若这条链挂在 cron 上,PLM 读全程以 config.dataSourceOwnerId 身份跑(http-routes.cjs:4143-4157),而没有任何审计动作记录这次拉取,lastPlmRefreshAt(conflict-planner.cjs:1077-1084)只记成功写入 —— 事后查不到是谁、以谁的身份、拉进了哪些项目的数据。

另有一条独立的、必现的破坏:只要 topology.subtree 按方案写的键名(configured/declared/measured)输出字符串,assertSourcePreflightValuesFree(:1772-1779)判为 unclassified-string-leaf 直接 refuse → SOURCE_PREFLIGHT_VALUES_FREE_SELF_CHECK_FAILED,**所有**数据源的预检路由全部报错,与是否启用子树无关。

### [semantics] refuted=True

**理由**:

方案在这五个角度上都有可核对的破绽。逐条给代码证据(路径均为 C:/Users/zhou/Downloads/dev/metasheet/)。

═══ 一、去重规则漏掉最常见的一类重复(不是丢行,是**成片重复且能 apply**)═══

方案把去重规则写死为「订单根先跑并登记 rootsBySourceId,子树根命中已登记的 componentSourceId 就跳过」。这只覆盖**根 vs 根**。

makeIdempotencyKey(plugins/plugin-integration-core/lib/stock-preparation-bom-expansion.cjs:467-474)吃 {projectNo, componentSourceId, parentSourceId, path}。零件 B 作为订单根 A 的**子件**时 key = {…,B,"A",["A","B"]};B 作为子树根时 key = {…,B,null,["B"]}。**两个 key 不同** → groupByKey(stock-preparation-conflict-planner.cjs:485-499)分不到一组 → resolveDuplicateExpandedRows(:902-986)根本不触发 → 没有 hold → canApply 仍为 true(stock-preparation-table-actions.cjs:1251 `canApply: !hasGlobalErrors && !hasHardRowErrors`)→ apply 照写。

这不是我推测的边界:仓库自己的夹具测试就把「同一零件挂在两个父件下 = 两行两个不同 key,**不是** duplicate case」钉死了(__tests__/stock-preparation-synthetic-sql-fixture.test.cjs:512-517)。子树根发现正是在制造这种形状。

后果:B 及其**整棵子树**在备料表里出现两遍,totalQuantity 一份是 2×q、一份是 1×q,而 totalQuantity 就是导出的「总数量」列(stock-preparation-prep-line-export.cjs:128)。读次数也翻倍。

═══ 二、子树根集合**自身**就会撞 key(方案完全没写这条)═══

方案的 discoverSubtreeRoots 对每个节点读 bomHead,filters 只有 {[pathIdField]: nodeId},**不带 SysVer**;isActiveBomHead(:451-461,注意方案写的 :383 是错的)对 null/'' 一律判 active。实测客户库:零件 600028853 有 **2 张表头**(docs/development/takeover-beiliao-20260821/222-deploy-window-runbook-20260901.md:116)。两张表头 → 同一个 part_id → 同一个 rootSourceId → 两行 **idempotencyKey 逐字节相同** → defaultPolicy 'hold'(conflict-planner.cjs:755、915)→ plan.valid=false → dryRunStatus 'manual_confirm_required'(table-actions.cjs:1295)。同一装配挂在两个文件夹节点下也一样。方案把去重说成「apply 的前提」,却只防了它想到的那一半。

═══ 三、根数量=1 正是 parseQuantity 明文拒绝的那类捏造乘数 ═══

bom-expansion.cjs:429-435 的注释原话:absent quantity 若变成真 0,会「silently become a real 0 and **multiply down as 0 through every descendant**」。把它换成 1 是同一个错误换个常数——1 经 :887 `totalQuantity: parentRow.totalQuantity * qty.value` 逐层相乘到每个子件,再流进导出的「总数量」。方案引用这段注释只用来论证「别传 null」,却违反了这段注释真正的原则:**缺失的量不许被发明出来**。

而且行上无任何标记:方案把出处只放在 summary 计数(rootQuantitySource),理由是「值面不泄漏」。结果导出行里一个被默认出来的 1 与一个实测的 1 **逐字节不可区分**。

翻转场景更糟:订单后来新增/删除了这个零件的明细行时,key 完全相同({projectNo,X,null,["X"]}),planner 走 makeUpdateDecision(:1136-1148),changedFields 只有 ['rawQuantity','totalQuantity'],conflictSummary 'plm_system_refresh' —— 整棵子树的总量在无解释的情况下乘/除一个订单数量。

═══ 四、预检:方案给出的 topology.subtree 形状会让预检**整条路由 500**,且默认路径也中招 ═══

assertSourcePreflightValuesFree(stock-preparation-source-preflight.cjs:1723-1801)在**每一次**预检末尾无条件调用(:1659)。规则(:1777-1780):任何 string leaf 必须属于四类之一,否则 refuse('unclassified-string-leaf')。

方案的 `topology.subtree = {configured, declared, columnPresent, populatedRows, rowCap, measured}` 里,leaf 名 `configured` / `declared` / `measured` **不在** CLOSED_VOCABULARY_LEAF_FIELDS(:367-378)、不在 SERVER_AUTHORED_LEAF_FIELDS(:404-406)、不在 IDENTIFIER_LEAF_FIELDS(:414-426)、也不匹配 LIVENESS_VALUE_PATH(:354)。只要它们是字符串就抛 SourcePreflightError → http-routes.cjs:6164 返回 500 SOURCE_PREFLIGHT_FAILED。方案说 subtree 子对象无条件加进 topology,所以**没声明 project-subtree 的默认路径同样炸**。

方案「值面闭包(:1736-1739 的 bridge/detectedBridge/configuredBridge/measuredBridge 词表)自动跟随」这句只对那四个 leaf 名成立,对它自己新造的 leaf 名一律不成立。

═══ 五、给 DECLARABLE_BRIDGES 加值不是加法:它改写了两个既有 blocker 的 payload,并广告一个必然无效的解法 ═══

`declarableBridges: [...DECLARABLE_BRIDGES]` 被内嵌在 BOM_STORE_SIGNALS_CONFLICT(:1496)与 BRIDGE_UNDECIDABLE_AT_CAP(:1526)的 detail 里。加值之后这两条既有 blocker 会告诉一线「你可以声明 project-subtree」;而按方案自己的收窄,declarationResolves 只对独占轴生效 → 声明了也解不掉 → 无提示地卡死。

这恰好落在客户实际看到的那条拦截上:runbook 已实测「唯一 blocker 是 bom_store_signals_conflict」且「**这个僵局没有声明参数可用**」(222-deploy-window-runbook-20260901.md:112),交付说明再次确认「当前没有『声明 BOM 存储』的入口可以消掉这条拦截」(customer-delivery-guide-20260904.md:185)。方案往他们正在读的那张清单上又加了一个假选项。所以「老轴的判定一字不改(回归可证)」在 payload 层面是假的。

另:http-routes.cjs:6130-6136 的报错文案硬编码 'declaredBridge must name one of the **two** bridge candidates',allowed 却会列三个;preflight :284-287 与 :370-373 的注释("Deliberately only the two real carriers")同时作废。方案说 http-routes「无逻辑改动」,但留下了自相矛盾的对外文案。

═══ 六、这条「声明的规矩」在新轴上没有牙齿,因为**声明面和启用面根本不是同一个面** ═══

declaredBridge 是 GET /api/integration/stock-preparation/source-preflight 的 query 参数(http-routes.cjs:113、6128、6151-6157);projectSubtree 是 table-action 的 source.readPlan,经 INTEGRATION_CORE_..._JSON 由 normalizeSource 整体 cloneJson 透传(table-actions.cjs:169)。预检**从不被拉取链路调用**(runStockPreparationSourcePreflight 全仓唯一调用点 http-routes.cjs:6151),交付文档也明说它是「建议性报告而非拉取的闸门」(customer-delivery-guide-20260904.md:185)。

所以 DECLARED_SUBTREE_CONTRADICTS_MEASUREMENT 拦的是一个**没人必须做**的声明,而真正开启子树的那条路(readPlan.projectSubtree)完全不经过预检。「人可以声明,但不能声明出数据否认的拓扑」在新轴上只对一个与功能无因果关系的 token 成立。

═══ 七、「关掉=逐字节不变是结构性的」对夹具守卫是假的 ═══

__tests__/stock-preparation-synthetic-sql-fixture.test.cjs:63:`SCHEMA_COLUMNS_NOT_READ_BY_PLAN = Object.freeze({})`,注释写明「Empty on purpose」。:402-414 用**默认计划**(:364 normalize(PLM_STOCK_PREPARATION_BOM_READ_PLAN))做反向断言 `assert.deepEqual(unused, [])`。加 dn_pdm_pathinfo.parent_obj_id 与 dn_pdm_bomheadinfo.path_id 之后,这两列对默认计划就是 unused → 守卫红。唯一合法修法是往那个「故意为空」的常量里写两条永久例外——**这是默认路径上的守卫被削弱**,与「结构性不变」正好相反。(:368 还钉死 `schema.size === 7`。)

═══ 八、子树拓扑本身在本仓库里没有任何证据 ═══

实测客户走法(222-deploy-window-runbook-20260901.md:116)是:FileCode → PathExAttrInfo.Parent_OBJ_ID → PathInfo → OrderHeadInfo.path_id → OrderDetailInfo.order_id → part_id → **BomHeadInfo** → bom_id → BomDetailsInfo。BomHeadInfo 是**从 part_id 进的,从来不是从 path 进的**。它记录在案的列集是 part_id, bom_id, SysVer, bom_able(222-rehearsal-full-run-20260904.md:84);两份夹具也只有这四列(synthetic 01-schema.sql:119 起;structure-exact 的 DN_BomHead_View)。DN_PDM_PathInfo 在合成夹具里是**单列表**(01-schema.sql:83-85,只有 OBJ_ID)。

**全仓没有任何文档或夹具记录 BomHeadInfo 有 path_id,或 PathInfo 有 Parent_OBJ_ID。** 方案的整条「BomHeadInfo.path_id」前提是未经证实的。

同时,方案引 `222-rehearsal-full-run-20260904.md:23-27` 支持「项目 2-20231625 的 6 个 BOM 表头挂在深度 1 的子节点上」以论证 maxSubtreeDepth 默认 1。该文件里 2-20231625 只出现在**第 24 行**,原文是「唯一子树里挂着 BOM 的项目 2-20231625 的 BOM 也残缺(根零件下 40–60% 子件不在物料表)」——「6 个表头」「深度 1」「挂在子节点上」**一个字都没有**。默认深度的唯一依据是伪引用。

═══ 九、222 上根本走不到方案设想的 large-BOM 后台路径 ═══

isLargeBomBoundedExpansion(bom-expansion.cjs:514-518)要求 `rowErrors.length === 0`。222 子树 40–60% 子件缺失 → readPart 逐个发 missing_component rowError(:810)→ largeBom 恒为 false → dryRunStatus(table-actions.cjs:1292-1297)返回 'failed' 而不是 'large_bom_bounded'。方案「读放大…被判为 large BOM 而路由到后台任务路径」这条风险描述,对它自己描述的那份数据是错的:那里没有后台逃生口。

═══ 十、定时拉取:推荐的「只跑 dry-run」正是会无限泄漏的那个模式 ═══

createDryRunToken(table-actions.cjs:953-962)每次 dry-run 往插件存储写一条 `integration:table-action:dry-run-token:<token>`。**唯一的删除**在 consumeDryRunToken(:972),即只有 apply 才删;过期只在 consume 时惰性检查(:976-979),**没有任何清扫器**。方案「建议第一波只跑 dry-run」= 每个 cron tick 留下一条永不消费、永不删除的记录(5 分钟一次 = 288 条/天/项目),无界增长。方案对此只字未提。

附带:若部署设了 INTEGRATION_CORE_B2A_REGISTRY_PATH,sourceReadOperationLimit 被硬钉为 1(b2a-trial-registry.cjs:710-712),且在首次读之前就 claim(:63-75)——定时脚本**第二次就被拒**。方案「零插件改动」没有限定这一条。

═══ 十一、「上次同步时间不需要任何新写入」是错的:skip 不写任何东西 ═══

runPatch 只挂在 makeAddDecision(conflict-planner.cjs:1125)、makeUpdateDecision(:1139)、makeInactiveDecision(:1231)。makeSkipDecision(:1151-1157)返回 `{decision, idempotencyKey, conflictSummary}` —— **没有 patch**。所以「无变化的那次拉取」写零行,lastPlmRefreshAt 停在上一次**有变化**的时间。222 自己的记录就有 `update=4 skip=3`(222-rehearsal-full-run-20260904.md §3.2),而稳态 cron 产出的正是全 skip。

于是 max(lastPlmRefreshAt) 回答的是「上次有变化」,不是「上次同步」:cron 正常在跑,界面却显示几天前的时间——这恰好是 project-board 模块自己 :63-77 那段注释点名的「the one answer that cannot be right」。方案「冲突规划器给每一行都写 lastPlmRefreshAt」是事实错误。

次级:readPullTargetRowFacts 会返回 bounded:true(project-board.cjs:415-417,上限 READ_MAX_PAGES=100 × READ_PAGE_LIMIT=500,见 prep-line-export.cjs:67-68),此时 max 是前缀最大值;看板已经为同一原因专门冻结了 pulledRowCountBounded 键(:155),新字段却没有对应的 bounded 标记。

═══ 十二、两处会翻转失败模式/证据形状的遗漏 ═══

(a) 订单循环在 try/catch 内(bom-expansion.cjs:903-975)。「在 :904-960 的订单循环**之后**追加」在 970(try 内)与 976(try 外)之间是歧义的。放在 try 外,子树 readAll 抛出的 read_count_exceeded / read_time_limit_exceeded(:334-350)**无人捕获** → 整个 expandPlmProjectBom promise reject → 路由 500,而不是方案所依赖的「global error → status failed → canApply=false」。

(b) summary.rootMatches = pathMatches.length,即 pathExAttr 命中行数(:989),且被测试钉死(__tests__/stock-preparation-structure-exact-rehearsal.test.cjs:342、stock-preparation-demo-runner.cjs:369 都断言 ===1)。开了子树后,一次产出 N 个子树根的运行,证据里 rootMatches 仍是 1。方案新增了计数块,却从未处理这个**字面就叫 rootMatches** 的字段——「evidence 形状有测试钉死」这一点被满足了字面,却让该字段主动误导。

═══ 附:方案里指错的行号(照着看会落到无关代码)═══
isActiveBomHead 实为 :451-461(方案写 :383);rowFromPart 实为 :612(写 :679);cycle_detected 实为 :864-867(写 :876-879);readObjects 去重集合实为 makeSummary :548(写 :989);assertNoForbiddenPlanKeys 实为 :93-105(写 :97-110);createRow 的 conditional-key 实为 :599-608(写 :585-596)。makeIdempotencyKey :467、readAll :351、assertReadBudget :334-350、readPart :801、expandChildren :816、normalize :239、makeSummary :536、planner :212-222/:485-499、token TTL :76-77、HARD :80、normalizeSource :169-186 均核对无误。

**具体失败场景**:

【最短可复现的一条:子树根重复整棵子树,且能 apply】

状态:项目 P 有一条订单明细指向装配件 A(quantity=2);A 的 BOM 里含子装配 B;B 自己在 P 的文件夹子树某节点上也挂了一张 DN_PDM_BomHeadInfo(part_id=B)。按方案启用 projectSubtree。

输入:POST /api/integration/table-actions/plm.stock-preparation.pull-bom.v1/dry-run,projectNo=P。

过程:订单段产出 [A](totalQuantity=2)、[A,B](2×qB)、[A,B,C]…;rootsBySourceId = {A}。子树段发现 rootSourceId=B,B **不在** rootsBySourceId(那里只有订单根)→ 不跳过 → rowFromPart(rawQuantity=totalQuantity=1)→ 再走 expandChildren,产出 [B]、[B,C]…

后果:B 的 key {P,B,"A",["A","B"]} 与 {P,B,null,["B"]} 不同(bom-expansion.cjs:467-474),C 的两条 key 同理不同 → groupByKey(conflict-planner.cjs:485-499)不分组 → 无 duplicate_expanded_key、无 hold → canApply 为 true(table-actions.cjs:1251)→ apply 写入。备料表里 B 与整棵 B 子树各出现两遍,总数量一份 2×q、一份 1×q,导出「总数量」列(prep-line-export.cjs:128)双计;读次数同步翻倍。仓库夹具测试 __tests__/stock-preparation-synthetic-sql-fixture.test.cjs:512-517 正把这种「路径不同 = 不是重复」钉死,所以现有守卫不会救。

【同一批里第二条:预检整条 500】
状态:任意部署,不必声明 project-subtree。输入:GET /api/integration/stock-preparation/source-preflight?externalSystemId=…。过程:报告带上 topology.subtree.configured / .measured(字符串)→ assertSourcePreflightValuesFree(source-preflight.cjs:1723-1801,:1659 无条件调用)在 :1778 判定这两个 leaf 名不属于四类中任何一类 → refuse('unclassified-string-leaf') → SourcePreflightError。后果:http-routes.cjs:6164 返回 500 SOURCE_PREFLIGHT_FAILED,预检对所有租户全线不可用——包括从未启用子树的默认路径。

【第三条:定时 dry-run 无界泄漏】
状态:222 上 crontab 每 5 分钟只跑 dry-run(方案自己推荐的第一波)。过程:每次 createDryRunToken(table-actions.cjs:953-962)写一条带 expiresAt 的存储记录;唯一删除点在 consumeDryRunToken:972,只有 apply 才走到;过期只在 consume 时惰性判断(:976-979),无清扫。后果:288 条/天/项目 的孤儿记录永久累积在插件 KV 里,没有任何代码会回收。

## 4. 需 owner 拍板
- 子树桥接是**正式功能**还是仅为演示/测试手段?它改变的是业务定义——「备料表里应该出现哪些根件」,不是一个实现细节。
- 无订单时**根数量=1** 是否被业务接受?替代方案只有两个:整单失败(222 上一行都拉不出),或让一线手工补数量(需要新的确认面)。
- 允许同一项目**同时**经订单与子树出根吗?建议订单优先、子树跳过;若两条路径对同一零件给出不同数量,以订单为准是否正确?
- 接受「关掉子树配置 = 下一次拉取把子树来的行全部置为无效」这个不可逆姿态吗?还是需要一个「保留但标记来源」的迁移方案?
- 子树遍历默认深度 = 1、且包含项目节点自身 —— 这两个默认值是否符合客户的目录习惯?(222 实测形态支持深度 1,但只有一个项目的证据。)
- 222 测试库里子树根件下 40–60% 子件缺料,拉出来的表会大面积报 missing_component:这样的结果可以拿去给客户演示吗?还是必须等客户补数据?
- 预检里 project-subtree 允许**人来声明**(在实测可佐证的前提下),还是只允许实测得出、不给人任何声明权?
- 定时拉取:只定时 **dry-run**(只读、无副作用、只做「有变化」提醒),还是允许无人值守 **apply** 直接写沙箱表?
- 定时任务用哪个服务账号(必须是**租户内**主体,不能是无租户平台管理员)、token 谁保管、多久轮换?
- 是否值得为「上次同步时间 / 同步失败可见」新增一条审计动作 + 数据库 check 约束迁移?还是先用行级 lastPlmRefreshAt 的最大值凑合(只能证明成功过的那次,记不下失败)?

## 5. 实测依据(222 → 客户测试 PLM,2026-09-05 只读)
项目 `2-20231625` → 节点 15013536,子树 14 节点(深度 0/1/2 = 1/9/4),6 个 BOM 表头全在深度 1,6 个根件全在物料表。逐张(bom_id/明细/缺子件):600028990/15013551 10 行缺 1;600029067/15013552 9 行缺 1;600029077/15013553 4 行缺 2;600029048/15013573 13 行缺 7;600028853/15013572 59 行缺 33;600029083/15013550 14 行全缺。全库 143 表头中 137 挂在无项目祖先节点下(共享零件库)——子树遍历必须限定在项目节点后代内。
