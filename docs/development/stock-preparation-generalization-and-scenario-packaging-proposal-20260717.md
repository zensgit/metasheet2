# 备料业务通用化 + 场景化呈现 — 规划提案（PROPOSED — owner 审定）— 2026-07-17

> **状态：PROPOSED。** 本文回答三个问题：①备料代码里还有多少真实的通用化空间；②抽取应该按什么
> 次序、以什么纪律进行；③备料作为一个「场景」应如何在产品里呈现而不突兀。
> 全部代码事实以 origin/main **`fbb92eec48ecbe59dab0457b75115e5fbdf12d5a`** 为锚，由三路独立读
> 代理逐模块核实（29 个后端 stock-preparation 模块 + 8 个 FE service 模块 + 产品呈现面 + 仓内
> 先例全量走查）。本文不请求任何编码；每个阶段各自过 owner 门。
>
> **owner review round-1（2026-07-17）已吸收**：①K1 通用性按实际耦合面收窄（§2.2）；②实施
> 顺序改为垂直推进（§4，owner 拍板五步序）；③App Center 前置条件明确、否决空壳插件（§5.3）；
> ④措辞修正（2/3=启发式非度量；/stock-prep=integration:write；锚定 exact SHA）。
>
> **2026-07-19 执行更新（不改本文历史 grounding）：** V0 已由 #4468 与 follow-up #4469
> 落入 main；P4 方案 A + bounded C 已由 #4470/#4473 落入 main。开发目标现进入 **V2 Charter**：
> `stock-preparation-v2-material-master-reconciliation-charter-20260719.md`。V2 runtime 在该 Charter
> ratify 前保持 NO-GO；RC-A #4437 继续作为独立操作线，不因本目标更新而重跑或改包。

## 1. 核心判断

备料的通用化空间**真实、分层、且仓内已有一次成功先例**：

- 全部 29 个后端模块按「纯模式 / 模板参数化 / 域绑定」三分，比例约为 **1/3 : 1/3 : 1/3**——
  这是**架构启发式而非代码度量**（round-1 措辞修正）：它指方向（大部分机制层在正确注入点打开后
  可复用），不作为工作量或行数承诺；
- **先例已经存在**：option-sync 已经走完这条路——FOS-2 把循环/跳过/patch/报错语义抽成
  `field-option-sync-runtime.cjs` 通用内核（:3-18 明言「stock-preparation is now a THIN
  WRAPPER」），通用路由 `POST /api/integration/field-options/sync` 已在，契约测试把
  `preset.stock-preparation.v1` 钉为**第一个 preset / 兼容锚**。**这就是其余抽取应复制的模板**；
- 备料已经骑在五条真实平台缝上（provisioning / scoped records API / FOS 内核 /
  `executeConfiguredRead` 只读源 / durable 插件存储）——通用化不是「把备料改成平台」，而是
  「把备料里长出来的第 6、7、8 条缝也交还平台」。

## 2. 通用化地图

### 2.1 已是平台能力（无需动）

`context.api.multitable.provisioning`、records API + `createTargetScopedRecordsApi` 写围栏
（sheet 围栏 403 + 逻辑↔物理翻译 fail-closed）、approved read-source configs +
`executeConfiguredRead`、FOS 内核、durable job store（大 BOM 任务）、dry-run token 两阶段
（kv 前缀已是通用命名空间 `integration:table-action:*`）。

### 2.2 五个可抽取的「场景无关内核」（按价值/成本排序）

| # | 内核 | 现状证据 | 注入点（域参数） |
|---|---|---|---|
| K1 | **快照对账骨架**（rounds 1-2 收窄：**骨架可抽，不是现成内核，事务边界待 P4**）：persist 的**分页重放、冻结投影判等、写入编排**可抽；**事务骨架当前不存在**——P4 方案 A（受限 unit-of-work）落地后才形成可抽的事务边界 | sync-run-plan **并非无域数学**：computeFlags（sync-run-plan.cjs:129）计算 missingChildBom、设计数量/单位、duplicatePathKey 与阻断状态——**mapper、flag aggregator、run-status 分类全部属 preset 注入面**；snapshot-diff 同样：pathKey 主键、`childDrawingNo\|childVersion` 身份回退、重复键 HELD 策略、数量合法性、阻断分类、输出投影全部代码化（snapshot-diff.cjs:124,148-152,196-215） | **身份策略、mapper、flag/run-status 分类器、阻断规则、投影、比较器全部由 preset 注入**；模板集、key picker、change-type/blocking 词表 |
| K2 | **确认流内核**：系统产候选→人工确认（server 戳身份、XOR 确认模式、create-only、human_preserved 结构性剥离）+ 异常队列（severity + 闭词表 resolution） | confirm-writes/generation-runtime/confirm-reads 的机制层全部同型复用；域只在 XOR/tri-XOR 语义与 8 异常类型词表 | 候选方法词表、确认模式、异常类型/决议词表 |
| K3 | **场景表模板 manifest 原语** | 仓内**四套**并行 manifest 机制共用同一 idiom（normalize-fail-closed、FORBIDDEN_CONTENT_KEYS、secret-shape 拒绝、values-free）：S3-1 integration-templates、S3-3 reference catalog、DF-T3a reference-mapping、备料 9 冻结模板——统一为一个平台 manifest 原语是**最强的单点通用化** | 模板清单、字段所有权（plm_system/human_preserved）、optionSource 契约键 |
| K4 | **values-free 审计原语** | audit-store 的结构闸完全通用（enum-shaped ≤80 字符、一层计数嵌套、append-only）；场景绑定只有闭词表（8 个常规业务动作 + P4 一次性 repair 动作）与表名 `integration_stock_prep_audit`（066/067 迁移） | {action 词表, 表名} |
| K5 | **完整性可证 feeder 面** | readonly-source-run 骑在平台 read-source 上；SOURCE_KIND_CAPABILITIES + fail-closed limitContract 是场景无关工程；域残留只有 PLM/ERP 分区与 channel 名 | source-kind 分区、channel 词表、intake 归一化器 |

### 2.3 真域核心（保留为「备料场景包」的内容，不抽）

BOM expansion + DN_PDM read plan（`bom-expansion.cjs:157-207`）、intake 别名表（FNumber/FIssueUnit
等 K3/PLM 字段词汇即域本身）、material-match / unit-rule-match / mvp-generation 的匹配与
issueQty 数学、8 异常类型、tri-XOR 语义、备料六视图业务语义。
**另：reference-mapping 与 material-mapping 是有意的两套机制**（人维护字典 vs 系统产候选+确认
生命周期；大小写语义相反），不应合并——共享的是 manifest 契约模式（K3），不是 resolver。

## 3. 抽取阻碍（四个结构点，任何抽取前先解）

1. **中央路由注册**：`http-routes.cjs`（~4,985 行）里 ~25 条备料路由 + 15+ 直接 require——
   无场景自注册机制，第二个场景必须改共享文件；
2. **`resolveTargetFieldIds` 钉死 9 objectId 冻结注册表**（table-actions.cjs:384-392）——
   「通用」的 scoped records API 物理上无法寻址第二个场景的表；
3. **主表 validator 烤死域字段清单**（templates.cjs:16-37,:311-341 REQUIRED_SYSTEM_FIELDS /
   HUMAN_PRESERVED_FIELD_IDS）——非备料模板被 normalizer 直接拒绝；
4. **diff comparator/change-types 是代码不是配置**（§2.2 K1 注入点）。
（次要：audit 表名/词表参数化，K4。）

## 4. 演进策略：不做大重构，做「第二场景拉动的抽取」

**反面教训已写在代码里**：`stock-preparation-common.cjs:2-5` 的 scoping note（review #3892）
明言各模块**有意**携带不同匹配语义（null 处理、空串语义各不相同），天真的「共享内核」重构会
静默改行为。因此：

- **纪律 = FOS 先例**：每层抽取都由一个**真实的第二场景**拉动；stock-prep 永远是 preset #1，
  以 preset 契约测试锚定 **byte-identical**（对既有行为零变化），mutation 证内核承重；
- **第二场景候选**（同型：外部只读源→快照→diff→确认→内部表，按现有需求就近取材）：
  ① **ERP 物料主数据对账**——`erp_material_master` + T3a upsert-persist 已经是第二个 persist
  消费者的雏形；② 供应商/客户主数据对账；③ 价格表对账。建议 ①（代码距离最短、客户价值直接）；
- **阶段序（round-1 改判：垂直推进，废除「先抽象后场景」的 S0→S3 序——那仍是平台先行重构，
  与本节自己的原则矛盾）。owner 拍板五步**：
  - **V0（已落 main）**：plm-workbench focus allowlist 补 `/stock-prep`，并由 #4469 把
    route-guard 决策抽为行为承重的纯函数；
  - **V1（P4 前置已落，通用抽取未启动）**：P4 方案 A（host 组合事务 + in-tx key fence）及
    bounded C 已落；其 UOW 仍明确是 stock-preparation-specific。persist 骨架只能等 V2 第二消费者
    出现后再抽，避免把 stock 专用边界误称为通用；
  - **V2（定义第二场景）**：「PLM ↔ ERP 物料主数据对账」，**必须拥有独立 manifest、路由、权限、
    字段词表（自己的 frozen templates + 自己的 intake 别名表）和契约测试**——不能只是给备料
    缓存换名字（`erp_material_master` 留在备料场景内不动，结构上排除该退化）；
  - **V3（第二场景上线时抽 K1）**：最小场景注册 + 快照/diff MVP 同步拉动最少骨架抽取，按实际
    需要再抽确认流；**验收判据 = 通用内核不再依赖任何 stock-prep 模板或域分类器**——以
    import-graph tripwire 测试机械化，且判据是**依赖闭包不是直接依赖**（round-6 修正：直接
    require 清单检查可被一个中间模块绕过）：从通用内核**入口模块**出发遍历**完整静态依赖闭包**
    （带循环保护），任意**传递**依赖命中 stock-prep 模板/mapper/分类器即红；**动态
    require/import() 无法静态证明时同样 fail-closed**（或进显式 allowlist 并逐条说明），
    drain-only，照 supertest AST tripwire 模式；
  - **V4（最后做场景目录）**：新增 `stock-prep:read/operate/admin` 独立权限（顺带解决现状
    「操作员须持 integration:write」的权限过宽），从统一 registry 派生 App Center 与首页场景
    入口；模板中心继续只承载单表模板。

## 5. 场景化呈现：怎么不突兀

### 5.1 现状（三套半成品呈现机制不合流）

- 备料今天**只有两个 `integration:write` 权限门后的顶栏链接**（数据工厂 `/integrations/workbench`、
  备料工作台 `/stock-prep`；appRoutes.ts:256 route 权限同为 integration:write，非 admin-only）：无 app-center 卡、无模板目录存在感、无 focus
  mode；**`plm-workbench` 专注模式的 allowlist 甚至不含 `/stock-prep`**（main.ts:157）——
  备料的天然受众在该模式下会被重定向走，这是现存的不协调；
- 仓内已有三套机制但互不组合：**模板目录**（8 个硬编码单表模板，装完只有 base+sheets+fields+
  views，无包概念）；**app-center**（`/apps` launcher + `app.manifest.json`，仅 after-sales 与
  attendance 两个；**after-sales 是最接近「场景包」的先例**：manifest 带 boundedContext /
  runtimeBindings.installPayload.templateId / navigation / permissions + install ledger +
  instance registry）；**PRODUCT_MODE 专注模式**（attendance 以 nav 换壳 + 硬编码 3 路径
  allowlist 呈现，代码写死非 manifest 驱动）。

### 5.2 呈现哲学

**备料从「集成工作台里的面板」变成「数据底座上的一个已安装场景」**——与 attendance /
after-sales 同构，因此天然不突兀：

- **操作员**从应用中心场景卡 / 首页场景区进入 `/stock-prep`（六视图 + dashboard 已是完整
  工作台）；
- **顾问/管理员**留在数据工厂（S1 建表、读取源配置、option-sync）——数据工厂定位收敛为
  「场景的数据供给与配置面」，不再兼任场景入口；
- 场景卡讲**业务语言**（"PLM BOM → ERP 备料对账"），数据工厂讲**数据语言**（源、配置、审批）。

### 5.3 三阶段落地

- **P0（round-1 收窄：只有一件立即可做）**：`plm-workbench` allowlist 补 `/stock-prep`
  （main.ts:155；一行，风险低、语义明确——路由本身仍有 integration:write 权限门，仅恢复该
  模式下持权用户的可达性）。**app-center 卡与首页场景区不再是 P0**：app-registry 一插件只读
  一个 manifest（app-registry.ts:91）且应用列表无权限过滤（platform-apps.ts:79），直接加卡
  = 无权用户可见但打不开的假入口；**也不为 metadata 造运行时仍归 integration-core 的空壳插件**。
- **P1（App Center 先补四个前置，再谈卡片）**：①一个插件可注册多个子应用；
  ②manifest 支持 requiredPermissions；③feature/readiness 状态声明；④**服务端与前端双重
  权限过滤**。之后场景包格式（引用冻结模板集 + navigation + permissions + read-source 依赖
  声明）装载复用 after-sales 的 install ledger + instance registry；模板目录长出「场景」类目。
  **编号关系（round-6 澄清）**：V0-V4 是唯一的执行序；P0/P1/P2 只是呈现面工作在该序中的落位
  标签——P0=V0，P1 的四个 App Center 前置与场景包格式**就是 V3「最小场景注册」的前端半边**
  （后端自注册 / 前端包声明，同一枚硬币），P2=V4 之后的收尾。不存在两条并行时间线。
- **P2（专注模式数据化）**：focus-mode allowlist 从 manifest navigation 派生（attendance 先例
  改造随行）——「备料专注模式」成为 manifest 产物而非 featureFlags.ts 代码分支。

### 5.4 W0/治理约束（任何新 provisioning/呈现能力必须遵守）

- 新场景写面必须收敛于 canonical sheet fence（W0-1 L4；default-OFF 期不得新增未围栏写者）；
- 场景表归属走 plugin object registry（scope 403 语义保持）；
- manifest 一律 schema-only + FORBIDDEN_CONTENT_KEYS + secret-shape 拒绝（K3 原语统一后自动
  获得）；values-free 呈现纪律不因「场景化」而放宽。

## 6. 与现有线的衔接（不冲突声明）

- OD1/3/4（客户口径）只影响备料**场景包内容**，不阻塞内核抽取；OD2 已 fail-closed（#4463）；
- P4 原子性：**A 方案实现先行，K1 抽取在后**（§4 阶段序已排）；
- E 线（现场对接）与场景包正交；RC-A（#4437）不受影响；
- attendance/after-sales 不改动，仅作先例引用（P2 阶段 attendance 的 allowlist 数据化随行，
  单独 owner 门）。

## 7. Owner 决策点（round-1 后更新）

1. ~~策略与阶段序~~ **已裁：垂直推进 V0→V4**（§4）；
2. ~~第二场景选型~~ **已裁：PLM ↔ ERP 物料主数据对账**，独立 manifest/路由/权限/词表/契约测试
   为硬性要求（V2 charter 文本届时单独过门）；
3. ~~P0 范围~~ **已裁：只修 focus allowlist**；App Center 卡等 P1 四前置齐备后再做；
4. ~~V0 是否开工~~ **已完成：#4468 + #4469 已落 main**（allowlist + 可执行 route-guard policy）；
5. **仍开放**：`stock-prep:read/operate/admin` 权限词表命名与迁移口径（V4 前置，影响现存
   integration:write 持有者的过渡方案）。
