# 备料接入提速:从「改配置重启」到「分钟级点选」——统一路线图(2026-09-01,DRAFT)

> **地位**:排期投入的加速工作项清单,不进入当前任何门;values-free。基线 `origin/main`。
> **owner 关切(原文,2026-09-01)**:「为何产品治理链这么慢,在客户那边接入的话这么慢要被骂死了」。
> **本稿覆盖范围**:2026-09-01 在 222 现场机对客户 PLM 的一次实读诊断,起初记下三处摩擦,复盘后又追加七处发现——本稿把十项发现统一成一张按优先级排列的工作清单,不再分「原始三项」与「新增七项」两份账。

---

## 0. 一句话结论

**运行时不是问题**:连接客户 PLM + 读真实 BOM 实测约 1.3 秒,生成是秒级的。owner 感到的"慢",**百分之百落在客户现场的首次接入设置上**——不是治理链设计错了,是三类具体缺口:①一个真实的 UX 缺口(源绑定要改部署环境变量 + 重启)、②该做但没做完/没部署的工作(厂商 preset 目录已合入但未部署、纠正后的读取拓扑还在未合分支上、系统不会自己测出客户走哪条拓扑)、③本该收窄却仍然宽的人工确认面(以及围绕它的可读性/可操作性/进度可见性一整圈可用性缺口)。**没有一项要求拆掉"写入正式主表前必须人工确认"这道治理门**——那是信任保证,本稿只做治理门之外的加速。

八项工作按优先级排列(细节见 §4):

| 优先级 | 编号 | 工作项 | 一句话 |
|---|---|---|---|
| P0 | ① | UI 选源 | 源绑定从"改环境变量+重启"变成"工作台里选一下",立即生效 |
| P0 | ② | 源就绪预检 + 拓扑自测 | 接入第一步:30 秒读出"这个源能不能用、走哪条拓扑",而不是自己摸半天 |
| P0 | ③ | 部署 preset 目录 + 纠正后的读取拓扑 | 把已经在代码里、但没上 222 的东西真正部署上去,换掉走错的订单模块桥接 |
| P1 | ④ | 可读项目目录 + 可操作错误 | 操作员不用查库就能找到项目;报错直接说"下一步做什么" |
| P1 | ⑤ | 更新/重拉 + 冲突裁决 UX | PLM 改了,系统主动感知;同批次同物料撞了,给出清楚的裁决面板 |
| P1 | ⑥ | preset 驱动的自动确认 | 把"一刀切人工确认"收窄成"只有真正的歧义才要人点" |
| P2 | ⑦ | 逐行溯源 | 每一行都能点开看"这行数据从哪条 PLM 同步、哪一列换算来的" |
| P2 | ⑧ | 大 BOM 展开的进度 + 可恢复 | 大项目展开时给进度条,不是干等的转圈图标 |

---

## 1. 问题拆分:运行时快,接入设置慢

### 1.1 运行时不是问题(现场实测)

- 连接客户 PLM + 读真实 BOM:约 1.3 秒。
- 生成(展开 BOM → 落备料行):秒级。
- 现场验证过的真实项目:项目号 `230920006`(名称"RY2注射水缓冲罐部件")可读,BomHeads 143 条——不是空跑,是实数据实读通过。

### 1.2 真正慢的是"第一次把系统接到这家客户身上",而不是治理链

治理不变量——**任何数据在写入正式主表(`plm_stock_preparation_main`)之前必须经人工确认**——今天原样成立且必须保持成立:

- `plm_stock_preparation_main` 只被 APPLY 路径写入:`plugins/plugin-integration-core/lib/field-option-sync-contract.cjs:177`(`targetTable: 'plm_stock_preparation_main', // canonical own-sheet stock-prep objectId`)、`plugins/plugin-integration-core/lib/stock-preparation-templates.cjs:632`(`objectId: 'plm_stock_preparation_main'`)。
- 生成/试算阶段写的是独立的"备料行"表 `plm_stock_preparation_line`(`stock-preparation-templates.cjs:922`),不是正式主表——`stock-preparation-customer-pack.cjs:7-16` 的模块注释把主表明确称为"FROZEN canonical"、`:208-213` 明说"未声明 targetObjectId = 落正式主表"这条路径不变。
- 换句话说:owner 感到慢的地方,不是"人工确认"这道门本身开合太慢——是门**前面**那段路(把系统接到客户身上)太长、门**周围**(确认面有多宽、错误提示有多清楚、进度看不看得见)太粗糙。本稿全部工作项都发生在这道门的前面或旁边,**不动这道门**。

---

## 2. 现场诊断证据:十项发现,按主题分三类

### 2.A 源接入类(对应工作项 ①②③)

**证据 1 ——源绑定今天只能靠改部署环境变量 + 重启后端。**

- 备料表动作的源固定在环境变量 `INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON`(`packages/core-backend/src/plugin-runtime-config.ts:2`),原样解析为 JSON(`:104-107`)。
- 该 JSON 里 `source.externalSystemId` 是必填字段:`plugins/plugin-integration-core/lib/stock-preparation-table-actions.cjs:178`(`normalizeSource`,`requiredString(input.externalSystemId, 'source.externalSystemId')`)。
- 这份配置在**插件激活时**一次性读入,不是按请求读取:`packages/core-backend/src/index.ts:2813`(`config: resolvePluginRuntimeConfig(manifest.name)`),`resolvePluginRuntimeConfig` 直接读 `process.env`(`plugin-runtime-config.ts:98-107`)。**改环境变量后不重启进程,新值不会生效**——这就是实施者今天必须 SSH 改文件 + `pm2 restart metasheet-backend` 的根因,不是流程习惯,是代码的读取时机决定的。
- 前端拿到的动作元数据**刻意不包含**这条绑定:`publicActionMetadata`(`stock-preparation-table-actions.cjs:353-386`)返回的字段里没有 `source`/`externalSystemId`——今天连"看"这条绑定都要读代码,更别说改。

**证据 2 ——已部署的读取拓扑硬编码走订单模块桥接,这家客户订单模块近乎空。**

- 部署在 222 的默认读取计划:`PLM_STOCK_PREPARATION_BOM_READ_PLAN`(`plugins/plugin-integration-core/lib/stock-preparation-bom-expansion.cjs:177-224`)。链路是:项目号(`FileCode`)→ `DN_PDM_PathExAttrInfo`/`DN_PDM_PathInfo` → **`orderHead: DN_PDM_OrderHeadInfo`**(`:190-194`)→ `orderDetail: DN_PDM_OrderDetailInfo`(`:196-201`,靠它的 `componentIdField: 'part_id'` 才能找到 `part`)→ `part` → `bomHead` → `bomDetail`(数量取 `Bom_ExAttr1`,`:221`)。**项目要落到 BOM,必须先经过一条订单记录。**
- 现场诊断:这家客户的订单模块几乎不用——全库仅 1 条 `DN_PDM_OrderHeadInfo` 记录。对绝大多数项目,`orderHead`/`orderDetail` 这一跳找不到任何行,链路在 `part` 这一步之前就断了,**BOM 展开结果是 0 行——即便源已经正确指到了客户 PLM**。
- 现场实读到的真正桥接路径是 `DN_PDM_DesignBom`(2570 行,数量同样落在 `bom_exattr1`),经 `product_part_id` 直接把项目和 BOM 连起来,完全绕开订单模块。这条修正后的拓扑目前只在未合分支 `feat/stock-prep-vendor-presets` 的最新提交上(`32dd7f173`,"dn-pdm topology backfill from the first live run — per-table row ids, measured join keys, order-side slot dictionary"),**该分支尚未合入 `origin/main`**(`git merge-base --is-ancestor` 核实为 `NO`)。该提交已经修正了物理行 id 与业务键分离、数量走字典槽位等结构性问题,但提交里用的表名仍是 `DN_PDM_BomHeadInfo`/`BomDetailsInfo` 而非现场诊断口中的"`DN_PDM_DesignBom`"——**合并该分支时需要把现场诊断的表名/`product_part_id` 发现与分支内容互相核对,不能假定二者已经是同一件事**。
- 厂商 preset 目录本身(`#5385`,机制:字典表怎么读、join 拓扑怎么走、行粒度怎么定)**已经合入 `main`**(`git merge-base --is-ancestor 25635e67d origin/main` → `YES`,首条 preset 为 `plugins/plugin-integration-core/lib/source-vendor-presets/dn-pdm-family.preset.json`)——**问题不是没写,是 222 上跑的构建版本比这次合并更老,没有把它部署上去**。

**证据 3(本次复盘新增,现场诊断的直接教训)——系统不会自己测出"这家客户到底走哪条拓扑",今天全靠人工摸索发现 0 行、再手工排查。**

这正是订单模块桥接踩坑的直接后果:今天没有任何一个自动化步骤会在接入早期告诉实施者"这个源连得上,但 preset 认不出这套 schema"或"这个源连得上、preset 也认得,但项目号锚点字段对不上"。今天发现"走了订单模块桥接、0 行"这件事本身,是靠现场人工冷读多张表、逐条核对 join 计数才定位到的——`feat/stock-prep-vendor-presets` 分支的提交说明原文就是"joins verified by count"这类手工验证描述。**这件事今天每接一家新客户都要重新摸一遍**,因为不同客户的 schema 差异(订单模块用不用、数量落在哪个 ExAttr 槽位、项目号锚点是哪一列)是逐家不同的——参见 `docs/development/platform-overall-design/source-onboarding-self-service-design-20260830.md` §9 对首家客户的记录:"两套 BOM(设计 BOM 行数更多)与近空订单模块 → 权威源/锚点必须问不可推断"。

### 2.B 确认与可信类(对应工作项 ⑤⑥⑦)

**证据 4 ——确认面今天是"一刀切":批次里只要有一行进入人工确认,整批就不能 apply。**

- 决策枚举:`DECISIONS = { ADD, UPDATE, SKIP, INACTIVE, MANUAL_CONFIRM }`(`plugins/plugin-integration-core/lib/stock-preparation-conflict-planner.cjs:18-24`)——不是每行都进人工确认,但计划级的门槛是**批次内 `MANUAL_CONFIRM` 计数必须为 0** 才判定 `valid`:`valid: counts[DECISIONS.MANUAL_CONFIRM] === 0`(`:1271`)。一个批次里哪怕只有极少数真正有歧义的行,也会挡住整批(包括其余明明已经能自动判定的行)先行落地。
- 今天没有任何"preset 已经高置信度映射过的行,直接自动过"这层收窄——凡是没有部署 preset(见证据 2)的源,系统没有依据区分"明显"和"歧义",于是更多行落进 `MANUAL_CONFIRM`,而不是更少。
- 物料/单位换算侧同样有一层人工确认字段——`requiresConfirmation` / `confirmedBy` / `confirmedAt`(`human_preserved` 字段带,`stock-preparation-templates.cjs:910-916`)——这正是 owner 关切原话里点名的"物料映射/单位行"确认面。

**证据 5(本次复盘新增)——"PLM 更新时自动获取更新"和"同批次撞同一物料时人工判断"这两条 owner 的北极星诉求,后端和前端各已经做了一半,但没有连成一条完整体验。**

- **已有的一半**:批次差异视图已经存在——`apps/web/src/components/integration/stockPreparation/StockPreparationSnapshotDiffView.vue`,文案原文"上面选一份,这里会显示它和上一份比改了什么"(`:148`,"Pick one above and this shows what changed since the previous copy")——"看改了什么"按钮(`:132`)、差异摘要含 `blockingExceptionCount`(`:194`)。同批次同一展开键重复(同物料撞了)的裁决词表也已经存在:`DUPLICATE_EXPANDED_KEY_POLICIES = ['keep_multiple_rows', 'merge_quantity', 'select_representative', 'skip_selected']`(`stock-preparation-conflict-planner.cjs:52-57`),其中只有 `keep_multiple_rows`(保留全部)与两个"hold"类原因走通了实现(`:778-796` 的推导注释:"a policy counts as implemented iff the planner does something NAMED with it"),`merge_quantity`/`select_representative`/`skip_selected` 是**刻意**未实现("Unimplemented BY DECISION, not by ...",`:790`)。
- **缺的一半**:全仓库对 `cron`/`schedule`/自动重拉关键词的检索在备料表动作与大 BOM 任务两个模块里零命中——今天没有"PLM 那边改了,系统主动感知并提示重拉"的触发机制,重拉只能靠人手动点(见 §3 已有的 #5394 项目接入面板);"撞同物料"的三种未实现裁决(合并数量/选代表行/跳过所选)意味着操作员今天遇到这三种真实场景时无法通过策略选择解决,只能落入默认 hold。

**证据 6(本次复盘新增)——每行数据的血缘字段已经建模,但没有做成"点开就看得到"的溯源视图。**

`LINEAGE_FIELD_IDS = ['projectNo', 'componentSourceId', 'parentSourceId', 'path']`(`stock-preparation-conflict-planner.cjs`)已经把"这行数据从哪个项目号、哪个源组件、哪个上级、走了什么路径展开来的"作为字段建模进了决策记录里——**数据已经在,只是今天没有一处 UI 把它按行展开成"这行数据从 PLM 同步 X、图号=IdentityNo、数量=Bom_ExAttr1 换算而来"这样一句人话**。厂商 preset 描述的正是这套字段语义的解读法(`dn-pdm-family.preset.json`),溯源视图要做的只是把 preset 的字段语义 + 这几个血缘字段拼成一句话,不需要新增数据模型。

### 2.C 可用性/运行时体验类(对应工作项 ④⑧)

**证据 7(本次复盘新增)——项目号今天是一个裸文本框,操作员得自己知道客户 PLM 里的项目号和名字,今天连现场诊断都得查库才拿到。**

- `apps/web/src/components/integration/stockPreparation/StockPreparationProjectSyncPanel.vue:13-25`:模板注释原文"The one input on this panel. The project number is the OPERATOR'S OWN text"(`:13`),`<input v-model="projectNo" placeholder="例如 P2026-001">`(`:18-25`);`:183` 附近的注释进一步写明"the projects read[...]"这个输入从不来自任何服务端响应回填。
- **零项目目录/选择器**:全组件对项目列表下拉、候选提示做检索无命中——这正是本次现场诊断中"就算是我(实施者)想找到 `230920006` 是哪个项目,也得直接查库才知道它叫'RY2注射水缓冲罐部件'"这一手工步骤的直接代码根因。备料工作台其余部分坚持 values-free(不展示业务行值)是刻意设计,但项目号+项目名这类"身份"信息不是敏感业务数据,今天却和真正敏感的数据被一并挡在了工作台外面。

**证据 8(本次复盘新增)——确认相关的报错走了一条"没有人话映射"的兜底通道,而这条通道已经在五个不同的确认类视图里重复出现。**

- `StockPreparationConfirmationQueueView.vue:341-343`:`recordError` 只在捕获的错误是 `StockPreparationConfirmApiError`(真实携带后端错误码)时才用 `error.code`;其余一切失败(裸网络错误、非预期形状的响应、裸 404)一律落到硬编码字符串 `'STOCK_PREPARATION_CONFIRM_REQUEST_FAILED'`——同一模式在 `StockPreparationExceptionQueueView.vue:486`、`StockPreparationMappingConfirmView.vue:489`、`StockPreparationPrepLineView.vue:381`、`StockPreparationUnitConfirmView.vue:551` 各出现一次,共五处。
- 平台确实有一套设计到位的错误码人话化基建:`apps/web/src/services/integration/errorCodeLabels.ts`(IU-1,design-lock `docs/development/integration-ux-workbench-redesign-design-lock-20260706.md`,#3739),已覆盖 Resolver/Probe/Composition/K3 WISE BOM-list/Bridge Agent/Dead-letter 六个错误码族、严格精确键匹配(不猜测)。**但该文件对 `STOCK_PREPARATION_CONFIRM_REQUEST_FAILED` 零命中**——备料确认这一族错误码从未被纳入 IU-1 的覆盖范围,今天的兜底码原样以裸 token 形式渲染给操作员(`StockPreparationConfirmationQueueView.vue:81-83`:`<code>{{ errorCode }}</code>`),没有一句"下一步做什么"的人话。基建是现成的,缺的是把这一族接进去。

**证据 9(本次复盘新增,与证据 2/3 同源)——大 BOM 展开已经有一套完整的后端任务/进度模型,但前端零消费。**

- `plugins/plugin-integration-core/lib/stock-preparation-large-bom-jobs.cjs`(#2342 C3/C4):任务状态机 `LARGE_BOM_BACKGROUND_EXPANSION_STATUSES = ['queued','running','paused','failed','completed','cancelled','expired']`,并维护 `job.progress` 字段(多处赋值,如 `:319`、`:410-427`、`:504`)。
- 对 `apps/web/src/` 全量检索 `largeBomJob`/`LargeBomJob`/`large-bom-job`,**零命中**——后端已经把"排队中/运行中/已暂停/百分比进度"这套模型做完整了,前端今天没有任何一处读取或渲染它。143 条 BomHead 级别的真实项目会触发大 BOM 展开路径,操作员今天看到的是一个不知道进度、也不确定卡没卡死的转圈图标。

---

## 3. 目标接入体验

实施者在 workbench 里对着一家新客户从头走一遍,应该是:

1. **选源**(工作项①):在备料工作台里点选客户的 PLM 连接,立即生效——不打开终端、不碰 `.env`、不重启进程。
2. **预检**(工作项②):系统在 30 秒内答完"连得上吗 / preset 认得这套 schema 吗 / 测得出这家客户走订单模块还是走 DesignBom 吗 / 项目号锚点是哪一列",给出一张 go / no-go 的清单,而不是等展开成 0 行才发现问题。
3. **点项目号,BOM 落地**(工作项③依赖于此、UI 本身已经做好):`项目工作台` 顶部面板已经把"点项目号 → 试算 → 确认 → 写入 → 批次存档"做成了一条按钮串——`feat(stock-prep): 项目接入`(`#5394`,`0799a7924`,已合入 `main`)。这一步的 UI 动作**今天已经存在**;卡住它的是上游①②③没做完(源指不对、preset 没部署、拓扑走错导致 0 行),不是这一步本身缺失。
4. **只有真正的歧义需要点一下**(工作项⑥):preset 高置信度映射的行自动过,人工确认队列只剩下系统答不出来的行。
5. **需要时看一眼**:项目找不到就翻可读的项目目录(工作项④),报错就照着提示的下一步做(工作项④),PLM 那边有更新会被主动感知、同物料撞车有清楚的裁决面板(工作项⑤),每一行想查就能查到血缘(工作项⑦),大项目展开有进度看(工作项⑧)。
6. **生成**:秒级(已验证,见 §1.1)。

分钟级,零环境变量编辑,零重启。

---

## 4. 统一工作项清单(按优先级)

### P0 — 现在就该动

**① UI 选源**

- **要什么**:把 §2.A 证据 1 的绑定从"环境变量,插件激活时读一次"改成"持久化配置(数据库,不是环境变量),按请求加载,改了立即生效,不需要重启"。
- **怎么做(目标形状,不预定具体落库方案——留给下方并行分支的实现)**:
  - 复用现有登记簿(`integration_external_systems` / `data_sources`),不新建一本新的连接登记簿——与 `docs/development/platform-overall-design/integration-hub-design-20260901.md` §7 "不新建注册表"的原则一致。
  - 写路径挂在 `integration:admin`(而不只是 `integration:write`)——这条绑定改变的是**全体租户**这条备料表动作解析到哪个外部系统,影响面比普通连接编辑更大。
  - 工作台里给一个"选源"入口(可复用对接中心 Level 1 已经设计的"换连接"操作位——`integration-hub-design-20260901.md` §7.1),不再要求打开"高级连接器"折叠开关。
  - 环境变量值降级为**兜底默认值**,不是唯一路径:未设置持久化绑定时回退到今天的环境变量读法,保证升级期间不炸。
  - 校验:绑定目标必须是已存在、测试通过的外部系统行;必须遵守 `#5401`(`b7120cd92`,已合入 `main`)刚建立的数据源归属/可见性模型;**绑定源的 `kind` 必须落在只读集合内**——`STOCK_PREPARATION_BOM_SOURCE_KINDS`(`stock-preparation-bom-expansion.cjs:41`)今天就只允许 `data-source:sql-readonly` / `bridge:legacy-sql-readonly`,UI 选源不能放宽这一点;并遵守 `[[k3-external-write-boundary-ruling]]`(owner 2026-09-01 裁决:K3 外部写走"只读账号可证明保证 + `#5402` 默认拒能力门纵深防御"两层)——**选源做得更方便,不能变成一条意外打开 K3 写的路径**。
- **进度**:并行分支 `feat/stock-prep-ui-source-binding` 已建(截至本次诊断与 `origin/main` 尚无分叉,即刚从 main 切出、还没有提交)——本节给的是它的目标形状与约束,不代替它的实现细节。

**② 源就绪预检 + 拓扑自测(自适应)**

两件事同一根——都是"系统自己测出这个源的真实形状,而不是假设"，因此归并成一个工作项,对应同一条计划分支 `feat/stock-prep-source-preflight-topology`(编写本文时尚未创建,按本次诊断结论列为下一步):

- **源就绪预检**(一次点击):在实施者做任何映射/生成动作**之前**,给一屏"可连接 ✅ / 能读到 143 条 BomHead ✅ / preset 认得这套 schema ✅ / 项目号活在 `FileCode` 列 ✅"式的清单,答不出来的项直接标红并给出下一步。这是接入流程的**第一步**,不是最后一道检查——目的是把 §2.A 证据 3 描述的"接完才发现 0 行,再回头人工排查"提前到接入开始前。
- **拓扑自测(自适应)**:不再硬编码"项目→订单模块→BOM"这一条桥接(§2.A 证据 2 的问题根源),改为按源**实测**:这家客户的项目→BOM 桥接走的是订单模块还是 DesignBom 类的直连表?数量落在哪个 ExAttr 槽位?测出来后写入该源的读取计划,而不是假设所有 `dn-pdm` 家族客户都走同一条路。**这是本次复盘认定的最高杠杆项**——因为每家新客户的 schema 差异是逐家不同的(参见证据 3 引用的 §9 记录),没有自测能力,每接一家都要重复一次今天的人工考古。
- **与已有工作的关系**:此项是把"给这一家客户手工修一次拓扑"(工作项③)升级为"以后接每一家客户都不用再手工修"的通用能力;工作项③是这次的具体修复,本项是让下次不用再修的机制,两者都排 P0 但不是同一件事,③不等本项做完也可以先合并部署。

**③ 部署 preset 目录 + 纠正后的读取拓扑**

- 合并(如仍未合并)`feat/stock-prep-vendor-presets` 分支尖端提交(`32dd7f173`,拓扑回填)入 `main`——合并评审时须核对该提交的表名/字段命名与本次现场诊断的 `DN_PDM_DesignBom` / `product_part_id` 发现是否一致,不能假定二者已经是同一件事(见 §2.A 证据 2 末段)。
- 把已经合入 `main` 的厂商 preset 目录(`#5385`,`25635e67d`)与上述纠正后的读取拓扑一并**部署到 222**,替换掉今天线上仍在用的、硬编码走订单模块桥接的默认读取计划(`PLM_STOCK_PREPARATION_BOM_READ_PLAN`)。
- **绑定到下一个 222 部署窗口**,与 `#5402`(K3 默认拒写能力门,`[[k3-external-write-boundary-ruling]]` 载明"合并与部署分开、owner 在场")同一窗口一起上——同一次现场部署动作,两件事一起过。

### P1 — 紧随其后

**④ 可读项目目录 + 可操作错误**(成本低、见效快,合并陈列)

- **可读项目目录**:把 `StockPreparationProjectSyncPanel.vue` 的裸文本框(§2.C 证据 7)升级为"项目号 + 项目名"的可搜索目录/候选列表,读取走 §2.A 已有的受管读取路径,不新开旁路。**继续对真正的业务行值保持 values-free**——只放开项目号与项目名这类身份信息,不放开物料/数量等敏感字段,与 `source-onboarding-self-service-design-20260830.md` §7 治理不变量("真值样本一律在受管预览里出现")一致。
- **可操作错误**:把备料确认这一族的错误码(§2.C 证据 8 列出的五个 Vue 视图共用的兜底码,以及各视图真实携带的后端 `error.code`)接入现有的 `errorCodeLabels.ts` 人话化基建,补一个"备料确认"错误码族,每条给"是什么 + 下一步做什么",不再是裸 token。

**⑤ 更新/重拉 + 冲突裁决 UX**

- 把 §2.B 证据 5 里"已经做了一半"的两块连成一条体验:批次差异视图(`StockPreparationSnapshotDiffView.vue`)前置为 PLM 更新的主动提示入口;补上今天缺失的自动/触发式重拉检测(而不是只能靠人手动点项目接入面板)。
- 把 `DUPLICATE_EXPANDED_KEY_POLICIES` 里刻意未实现的三条(`merge_quantity` / `select_representative` / `skip_selected`)按需补上真实实现,或至少在裁决面板里明确标注"这个策略今天会被拒、请选择另一个",不要让操作员选了一个策略却在计划阶段无声落回默认 hold。

**⑥ preset 驱动的自动确认**

- 确认队列自动接受 preset 高置信度映射的行(字典命中、数量候选唯一、槽位已知)直接进 `ADD`/`UPDATE`;`MANUAL_CONFIRM` 只保留给真正的歧义(多个数量候选、未识别的厂商槽位、字典命中冲突——参照 `source-onboarding-self-service-design-20260830.md` §4 的启发式)。
- **`valid: counts[MANUAL_CONFIRM] === 0` 这道计划级门槛原样保留,不放宽**——本项要收窄的是落进 `MANUAL_CONFIRM` 的**集合大小**,不是绕开这道门本身。
- 单位换算规则上的 `requiresConfirmation`/`confirmedBy`/`confirmedAt` 人工确认字段不动。

### P2 — 排在后面,但值得做

**⑦ 逐行溯源**

- 基于已建模的 `LINEAGE_FIELD_IDS`(`projectNo`/`componentSourceId`/`parentSourceId`/`path`)与 preset 的字段语义,给每一行加一个"查看来源"的展开——"来自 PLM 同步 X,图号 = `IdentityNo`,数量 = `Bom_ExAttr1` 换算而来"。不需要新数据模型,只是把已有字段拼成一句人话,遵循 `#5391` 先例(人话默认、技术详情一键展开,`integration-hub-design-20260901.md` §9 已引用同一先例)。

**⑧ 大 BOM 展开的进度 + 可恢复**

- 前端接入 `stock-preparation-large-bom-jobs.cjs` 已有的任务状态机与 `job.progress`,把"排队中/运行中/已暂停/百分比"渲染出来,替换今天的纯转圈图标。后端的可恢复能力(`paused`/任务可续跑)已经建模,缺的只是前端消费与展示。

---

## 5. 非目标 / 必须保留

- **不移除人工确认门**。写入 `plm_stock_preparation_main` 前必须人工确认,这是信任保证,不是效率反例;工作项⑥收窄的是确认面的大小,不是这道门本身,§4⑥ 的门槛表达式原样保留。
- **不让"UI 选源"变成一条打开 K3 外部写的路径**。绑定源的 `kind` 必须留在只读集合;`erp:k3-wise-webapi` 的四层永久焊死(`plugins/plugin-integration-core/lib/k3-external-write-permanent-fence.cjs`,`integration-hub-design-20260901.md` §4 详列四处代码位置)与 `#5402` 默认拒写能力门不受本设计影响,继续保持关闭/焊死状态。
- **不新建独立的连接登记簿**。①的持久化绑定复用现有 `integration_external_systems`/`data_sources` 两本登记簿与既有换连接入口,不重新发明一套。
- **可读项目目录不放大 values-free 的口子**。只暴露项目号与项目名这类身份信息,不暴露物料/数量等业务行值;真值预览继续只在受管读取路径里出现。
- **preset 目录与拓扑自测的产出仍需人工审核后落服务端受审文件**——参照 `source-onboarding-self-service-design-20260830.md` §7"页面只产草案,生效必经我方审核落服务端文件",本设计不改变这一治理姿态,只加速草案产出与部署节奏。
- **本文不裁定①②的具体落库 schema / API 形状**,留给对应实现分支(`feat/stock-prep-ui-source-binding`、计划中的 `feat/stock-prep-source-preflight-topology`)定稿。
