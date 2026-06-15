# Multitable 对标飞书多维表格 — 刷新基准审计 & 差距阶梯(2026-06-15)

Date: 2026-06-15
Status: research / external-product benchmark (per repo convention, 外部产品对标含品牌名只放 `docs/research/`)
Baseline: `origin/main @ e37f7bc12` (#2635 export 列/行选择器 landed 2026-06-15 17:39)
Goal anchor: owner STANDING priority (2026-06-11) — "multitable driven by **对标并超越飞书**; rolling refresh audits → re-ranked ladder → staged arcs"

> **本文档与 `docs/development/multitable-benchmark-refresh-ladder-20260615.md` (#2629) 的分工**
> - **本文档(research)** = 外部对标:**当前(2026)飞书多维表格 feature set 的一手取证 + 引用** → diff 出差距 → **超越项(surpass)分析** → 按 value×reachability 重排的差距阶梯。品牌名按仓规放这里。
> - **#2629(development)** = 内部执行台账:旧 19 项阶梯的逐项 burndown(per-item PR + file:line)、开放 PR triage。
> - 本刷新**继承 #2629 的 burndown 结论(不重复推导)**,但在 **#2635(A2 export 选择器)落地之后**重排——这是 #2629 写作时还未发生的状态变化(#2629 把 A2 列为"首发 lock-safe",现已闭合)。
> 方法:飞书侧逐条 WebSearch/WebFetch 取证(官方 feishu.cn / larksuite.com 帮助中心 + open.feishu.cn / open.larksuite.com 开放平台 API 文档,见每节 Source);MetaSheet 侧逐条 `git show origin/main:<path>` / `git grep origin/main` 代码核验带 file:line(本仓两次 stale-marker 翻车 #2177/C5-2,故所有判定带锚点)。可信度分级见 §5 取证局限。

---

## 1. 当前 MetaSheet2 多维表能力盘点(代码核验 @ origin/main)

> 锚点均核验自 `origin/main`(工作树落后 ~182 commit,已 `git show origin/main:` 读)。

### 1.1 字段类型 — 28 个 union(`apps/web/src/multitable/types.ts:6-33`)

```
string · number · boolean · date · dateTime · formula · select · multiSelect
link · person · lookup · rollup · attachment · currency · percent · rating
url · email · phone · barcode · qrcode · location · longText · autoNumber
createdTime · modifiedTime · createdBy · modifiedBy
```

- **native `lookup` + `rollup`**(非 formula 内嵌)— 与飞书"查找引用/汇总"同档,但 MetaSheet 是**独立 field type**;**飞书 `rollup` 无独立 type**(经 lookup/formula 实现),MetaSheet 模型更直接。
- **`qrcode` 独立于 `barcode`**(#2593 render-only QR field 已落,`MetaCellRenderer.vue:37`,源串 plain-text 编辑)— 飞书 QR/条码是 type-1 的 `ui_type` 变体,MetaSheet 拆成两类(W1)。
- `longText` 富文本 = **render-only**:write-path sanitizer XSS-safe(#2598)+ FE render `MetaRichLongTextRender.vue`(DOMPurify,#2614),**但 cell 编辑器仍是 plain `<textarea>`(`MetaCellEditor.vue:70`),无 WYSIWYG 工具栏**。→ 见 §3 gap。
- **缺**:`button`(按钮字段——**飞书是真 field type,cn API `type 3001`**)· `ai`(AI 字段——无独立 type;AI 是 `string`/`longText` 字段上的 `aiShortcut`,见 §1.15)· 群聊(GroupChat,飞书 type 23)· duration/计时 · location 仅 address-string(无地图选点,coords 仅 API)。grep 核验 `types.ts` 无 `'button'`/`'ai'`/`'duration'` 字面量。

### 1.2 视图 — 9 类(`MultitableWorkbench.vue` `FORCED_VIEW_MODES`)

Grid · Form · Kanban · Gallery · Calendar · **Timeline** · Gantt · **Hierarchy**(层级,`MetaHierarchyView.vue` + `hierarchy-cycle-guard.ts`,父字段 downgrade 守卫 #2523/#2525)· Dashboard。**飞书仅 6 核心视图(Grid/Kanban/Calendar/Gantt/Gallery/Form),未确认独立 Timeline/Hierarchy** → MetaSheet 的独立 Timeline + Hierarchy 视图是 surpass(W9)。

- **Grid 无行虚拟化**:`MetaGridTable.vue` grep `RecycleScroller|DynamicScroller|VirtualList|virtual-scroll|windowing` **零命中**,直接渲染已加载页行。**头号企业规模阻塞**——飞书"多维表格数据库"引擎宣称单表 **100 万行** + 仪表盘统计 **1000 万行**,此处代差最大(详见 §3 阶梯 A1)。
- **聚合页脚 + 分组小计**:已支持(`MetaGridTable.vue:276` `<tfoot>` + `:654` per-group;服务端全集语义、非可视窗口、无本地 fallback `:630`),7 fn(sum/avg/min/max/count/countNonEmpty/countDistinct)`aggregation-helpers.ts:9`。
- **冻结列**:多列 left-prefix sticky stack(#1837)。**Inline create row**(#1834)。**日历拖拽改期**(#2581,lock/mask/version-aware)。
- **结构化 where-groups**(嵌套 AND/OR 筛选,`conjunction:'AND'|'OR'` `types.ts:821`,#2625)— 与飞书多条件筛选 parity。

### 1.3 公式引擎(`packages/core-backend/src/multitable/formula-engine.ts`)

**47 函数**(`formula/engine.ts:142` `registerBuiltinFunctions`,math/logic/text/date/stats + VLOOKUP/HLOOKUP/INDEX/MATCH)+ `{fld_*}` 字段引用 + 跨表 LOOKUP + dry-run 诊断;**Formula-over-Lookup(FOL)整弧 2026-06-10 闭合**:A-full #2450(allowlist)+ FOL-1 #2464(related-record recompute fan-out + Yjs 失效,`record-write-service.ts:298-326,572`)+ FOL-2 #2465(in-memory hydration,FOL 见真实 lookup 值非 stale,`formula-engine.ts:250`)。**NL→formula AI 辅助**已发(#2520,`POST .../ai/suggest-formula`,生成 1 候选 + dry-run 校验 + 手动 accept)。**飞书亦有 AI 生成公式**(NL→formula),此项 parity。

### 1.4 关联链接

- 同 base link:✅;**跨 base link**(`foreignBaseId` opt-in + base-read gating):✅ #2582 + FE picker #2611。
- **双向/镜像链接**(derived reverse MVP):✅ #2595/#2597。
- **跨 base 治理**:base-perm 原语 + 写配额护栏(#2587)+ 结构守卫(#2588);**实时失效 fan-out**(Phase C1 #2618)+ 跨 base 记录删除/锁(C2 #2615)+ 细粒度 `multitable:base:write` tier(C3 #2613)。整条 Phase A/B/C 收口 `multitable-crossbase-program-completion-20260614.md`(#2620)。

### 1.5 自动化(`automation-triggers.ts` / `automation-actions.ts`)

- **7 触发**(`automation-triggers.ts:6`):`record.created/updated/deleted` · `field.value_changed` · `schedule.cron` · `schedule.interval` · `webhook.received`。**飞书额外有 form-submit / 按钮点击 / 收消息触发**(MetaSheet 无按钮触发入口 → B1)。
- **12 行动**(`automation-actions.ts:7-19`):`update_record` · `create_record` · `delete_record` · `send_webhook` · `send_notification` · `send_email` · `send_dingtalk_group_message` · `send_dingtalk_person_message` · `lock_record` · `wait_for_callback` · **`condition_branch`** · **`start_approval`** · `parallel_branch`。
- **工作流引擎级图**:`condition_branch`(排他条件分支 A6-3-1/2,执行器 `executeConditionBranch:1038`)+ `parallel_branch`(**v1 = fan-out + join-all only**;join_any/取消/branch-local wait 仍 deferred,`automation-actions.ts:175-182`)+ `wait_for_callback`(suspend/resume A6-2 `:147`)+ `start_approval`(approval-as-job,`automation-approval-bridge-service.ts`)。**跨 base 自动化写已治理**(#2585 闭 ungated create 洞;executor 要求完整目标三元组 + `base:write` + 60/base/60s 配额 `automation-executor.ts:690-715,1783`)。
  > 对标:飞书自动化**也有条件分支 + AI Agent 节点 + AI 文本节点**(2025 头条);MetaSheet 的**净差异化是 typed `parallel_branch`(join-all)+ branch-local `wait` + `start_approval`(approval-as-job)的图编排** + 跨 base 写治理,**非"飞书没有分支"**。见 §4 W2(已校正)。

### 1.6 权限 / RBAC(`access.ts` / `permission-service.ts` / `permission-derivation.ts`)

层级:**sheet · view · field · record · base**(cross-base 新增 base tier)。**字段权限** entry(`MetaFieldPermissionEntry`)+ **记录权限** manager + **导出掩码**(读时掩码,见 §1.10)。**注意**:record-level 是**静态授权**,非规则引擎(无"按字段值动态行级规则"——见 §3 阶梯 B7)。permission-matrix golden gate 已入 CI(`plugin-tests.yml` DB-guard)。

### 1.7 仪表盘 / 图表(`dashboard-service.ts` / `charts.ts` / `chart-aggregation-service.ts`)

**9 图表 type**(`charts.ts:11`):bar/line/pie/**number(=KPI 数字卡,`MetaChartRenderer.vue:47`)**/table/area/funnel/gauge/scatter + 多系列 + 异步 chunk。**缺**:**仪表盘级筛选器联动**(dashboard 仅 `{chartId, position}` 网格布局 `dashboard.ts:7-8`,无 cross-chart filter linkage)· **透视表组件** · 排行榜/雷达/NPS 等。对标飞书:**仪表盘宣称 50+ 图表组件 + 拖拽透视表 + 多数据源联动 + AI 图表解释/总结**(2025 升级)——此处明显代差。详见 §3 阶梯 B4。

### 1.8 附件(`attachment-service.ts` / `attachment-orphan-retention.ts`)

MIME icon + 缩略图 + **image 内嵌预览 lightbox**(`isImage` gate `MetaAttachmentList.vue:105` + `thumbnailUrl` + 预览 modal `:71`);**orphan retention/aging**(`cleanupOrphanMultitableAttachments` `attachment-orphan-retention.ts:68`,可配 `MULTITABLE_ATTACHMENT_RETENTION_HOURS`)。基本与飞书附件 parity(细分 image-only 字段变体为次级小项)。

### 1.9 评论 + 提及

Threaded 评论(`meta_comments.parent_id`)+ resolved + 评论内 @mention(`mentions jsonb` + `MetaCommentComposer.vue:5-12`)+ per-cell 评论触发 + person 头像 chip。**缺**:**格内(in-cell)@mention**(`components/cells/` grep mention 零;longText 编辑器无 mention 触发)· **emoji 反应**(无 reaction 列)· 通知 digest/中心。对标飞书:**单元格级评论 + 评论内 @ + 插入图片** + 关注评论——MetaSheet 评论内 @ 已 parity,缺评论插图 + 格内 @ + 反应。

### 1.10 导入 / 导出(`xlsx-service.ts`)

导入 csv/tsv/txt/xlsx/xls + 粘贴(`MetaImportModal.vue:19`);**导出列/行选择器 = #2635 (A2) 已落 2026-06-15**:toolbar CSV/XLSX 打开 `MetaExportDialog`(列 checklist 默认全选 ≥1 必选 + 行范围 全部已加载/仅选中 + 格式)。**但 canonical 导出仍全客户端** `buildXlsxBuffer` over `grid.rows`(`MultitableWorkbench.vue:2616`),**capped 在已加载行** + **绕过** `#2591` 服务端 masked route(`GET .../export-xlsx?fieldIds=` 仅 narrow,`univer-meta.ts:7396`)。掩码成立**仅因 `grid.rows` 读时已掩码**(不泄露已授权外的数据)。→ **用户面列/行选择 UX 已闭合**(#2629 把 A2 列为首发,现已 done);**服务端全量(超已加载页)masked 导出仍 deferred**。

### 1.11 API token + Webhook(`api-token-service.ts` / `webhook-service.ts`)

API token CRUD;**Webhook HMAC-SHA256 签名**(`webhook-service.ts:575`,写基准时即已在)+ **出站管道接线 + retry**(#2511/#2512)。OpenAPI spec(`packages/openapi/src/paths/multitable.yml`)+ SDK auto-gen + parity gate。**缺**:面向外部开发者的 docs 站发布 / SDK npm 分发 / per-token rate-limit 治理面板。

### 1.12 实时协作(Yjs,`packages/core-backend/src/collab/`)

事件驱动(非轮询)+ presence chip + Yjs 契约 parity gate;cross-base 实时失效 fan-out(#2618)。

### 1.13 条件格式(`conditional-formatting-service.ts` + `ConditionalFormattingDialog.vue`)

`{backgroundColor?, textColor?}` solid + applyToWholeRow(`conditional-formatting-service.ts:25-26`)+ 11 operator + 规则上限 20。**缺**:data bar / 色阶(color scale)/ 图标集(icon set)。对标飞书:**条件格式已含公式高亮 + 数据条/色阶/图标集(V4.10)+ 填色(按条件给单元格/整行上色)**——MetaSheet 仅 solid,代差实在。详见 §3 阶梯 A5。

### 1.14 条件字段可见 / 表单逻辑(`field-visibility-rule.ts` #2605)

show/hide 基于其他字段值(form rules)。**表单逻辑深度缺**:required-if / 多页 / URL prefill / 提交后跳转。详见 §3 阶梯 A4。

### 1.15 AI(`ai-shortcut-config.ts` / AI 用量台账 / 配额)

`string`/`longText` 字段上的 `aiShortcut`(`AI_SHORTCUT_KINDS` `ai-shortcut-config.ts:18`):**4 子类 summarize / classify / extract / translate**,**仅手动触发**(`POST .../ai/shortcut/run`,`canEditRecord` 门;auto-trigger 明确出 M0 章程,grep 零)。用量台账留存/aging(#2519)+ **estimate-aware 配额 admission 关单请求 overshoot**(#2623)+ 字段读掩码进 prompt 前生效(taint chokepoint,`multitable-ai.ts:68`)。**无 `'ai'` field type**;**无 NL→filter(grep 零)/ 无 AI 问数 / 无 NL→建表**。
> 对标飞书 AI(头号代差):AI 字段捷径 = **智能分类 / 信息提取 / 内容总结 / 翻译 / 文本生成 / 图片识别**(可选 DeepSeek R1 / 豆包 Doubao 模型)· **一句话生成业务系统(NL→app)** · **AI 问数/智能问答(NL data Q&A)** · **AI 生成工作流 + 自动化 AI Agent 节点** · 仪表盘 AI 解释/总结 · AI 配权限 · AI 语音录入。MetaSheet 仅 4 手动 shortcut + NL→formula → §3 阶梯 B2。

---

## 2. 当前飞书多维表格 feature set(2026,一手取证)

> 取证方法:feishu.cn/hc 帮助中心 + open.larksuite.com 开放平台 API 文档。注意 feishu.cn / larksuite.com 产品页是 JS-SPA,WebFetch 仅得 metadata;**正文以 WebSearch 服务端渲染摘要 + open.larksuite.com API 文档(可完整渲染)为准**。

### 2.1 字段类型(开放平台 API 权威枚举)

开放平台 `List fields` API 的 type 枚举(权威、非陈旧):Text(1) · Number(2) · SingleSelect(3) · MultiSelect(4) · Date(5) · Checkbox(7) · **Person/User(11)** · Phone(13) · URL(15) · Attachment(17) · **SingleLink 单向关联(18)** · **Lookup 查找引用(19)** · Formula(20) · **DuplexLink 双向关联(21)** · **Location(22)** · **GroupChat 群聊(23)** · **Stage 流程/阶段(24)** · CreatedTime(1001) · ModifiedTime(1002) · CreatedBy(1003) · ModifiedBy(1004) · AutoNumber(1005) · **Button 按钮(`type 3001`)**。**Progress/Currency/Rating = type 2 的 `ui_type` 变体;Barcode/Email = type 1 的 `ui_type` 变体**;**Rollup 汇总无独立 type**(经 lookup/formula);**AI 字段 = 字段捷径**(UI 层,不在 API type 枚举)。注:**intl `List fields` API 文档(已亲测渲染)枚举不含 Button/Stage**;cn API 含 Button(3001)/Stage(24)→ **cn 领先**(Button=3001 经搜索摘要二次确认:"流程/按钮 type 暂无返回值")。
Source(API 枚举,server-rendered 高可信): <https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-field/guide> · intl(亲测渲染,不含 Button/Stage)<https://open.larksuite.com/document/server-docs/docs/bitable-v1/app-table-field/list> · Button=3001/流程·按钮无返回值 <https://www.feishu.cn/content/137710114294> · 字段分组 <https://www.feishu.cn/content/article/7574713887522639055>

- **按钮字段(Button, type 3001)**:**真 field type**,可作**自动化触发条件**(点击触发流程/一键改状态,如项目管理点击更新状态);自动化"按钮被点击时"触发器。Source: <https://www.feishu.cn/hc/zh-CN/articles/339066898695-使用多维表格按钮字段>
- **AI 字段捷径(field shortcut)**:封装 "AI+公式+API",轻量加在 text/number 字段;子类 = **智能分类 · 信息提取(日期/金额/人名/电话实体)· 内容总结 · 翻译 · 文本生成(邮件/JD/客服回复/文案)· 图片识别**,可选模型 **DeepSeek R1 / 豆包 Doubao**;一键批量整列。Source: <https://www.feishu.cn/hc/zh-CN/articles/464880997049-使用多维表格-ai-字段捷径> · <https://www.feishu.cn/content/article/7592534632910867658> · <https://www.feishu.cn/content/article/7579168498044161238>(模型)
- **群聊字段(GroupChat, 23)** + **Stage 流程字段(24)**:MetaSheet 无对应(IM/流程绑定特性)。进度(Progress)= 可视进度条(MetaSheet `percent` 仅数字)。

### 2.2 视图类型

**6 核心视图**:表格 / 看板(group-by)/ 日历 / 画册(gallery 卡片)/ 表单 / 甘特;视图可设**锁定视图 / 个人(私有)视图 / 独立分享视图**。**注:未确认飞书有独立 Timeline/Hierarchy/List 视图**(时间轴折进甘特)→ MetaSheet 的独立 Timeline + Hierarchy 是 surpass(W9)。**规模**:"多维表格数据库"引擎单表 **100 万行**(V7.57 自助扩容 + 100 万行归档表),cn 宣称底层"千万热行/亿级"。
Source: <https://www.feishu.cn/hc/zh-CN/articles/360049067931> · <https://www.feishu.cn/hc/zh-CN/articles/697278684206-快速上手多维表格> · 私有/分享视图 <https://www.feishu.cn/hc/zh-CN/articles/396528986790> · 100 万行 <https://www.feishu.cn/hc/zh-CN/articles/899737788817>

### 2.3 仪表盘(2025 升级)

**50+ 图表组件**(指标卡含同比/环比+趋势 · 排行榜 · 柱/条/折线/面积/饼/雷达/散点/NPS)· **拖拽透视表**(多行列+值+内置汇总)· 切片器/筛选 · **视图组件**(嵌 Grid/Kanban/...) · **多表联动分析**(单组件多数据源)· **AI 图表智能解释**(释义+异常标记)+ **AI 智能总结**(自动化推送)。统计可达 **1000 万行**。
Source: <https://www.feishu.cn/hc/zh-CN/articles/161059314076> · 50+/多表联动 <https://www.feishu.cn/hc/zh-CN/articles/858919003989> · 指标卡 <https://www.feishu.cn/hc/zh-CN/articles/440569013989> · 透视 <https://www.feishu.cn/hc/zh-CN/articles/377639339118> · 筛选 <https://www.feishu.cn/hc/zh-CN/articles/493084579750>

### 2.4 自动化(工作流 / 自动化流程)

- **触发**:新增记录 · 记录满足条件 · **定时重复**(如每天 10 点)· **表单提交时** · **按钮被点击时** · **接收到 webhook 时**(内外部系统可调用)· 接收飞书消息。
- **行动**:发送飞书消息(人/群/部门,可选发送身份)· 发送邮件 · 创建/更新/删除记录 · **发送 HTTP 请求(出站 webhook,调用三方)** · 发起审批 · **AI 生成文本节点** · **AI Agent 节点**(2025 头条:智能查询/热点分析/自动周报);支持**多步 + 条件分支**。
Source: <https://www.feishu.cn/hc/zh-CN/articles/740947703250-自动化流程触发条件与执行操作一览> · webhook 触发 <https://www.feishu.cn/hc/zh-CN/articles/612376356355> · HTTP 行动 <https://www.feishu.cn/hc/zh-CN/articles/410063847664> · AI Agent 节点 <https://www.feishu.cn/content/article/7591431268324101337>
> 校正:飞书自动化**有条件分支 + AI 文本/Agent 节点**,双向 webhook(入站触发 + 出站 HTTP);**MetaSheet 净差异化**是 typed `parallel_branch`(join-all)+ branch-local wait + `start_approval`(approval-as-job)图编排 + 跨 base 写治理(见 §3 W2),**而非"飞书没分支"**。反向:飞书有 **AI Agent 节点**,MetaSheet 自动化无 AI 节点。

### 2.5 数据连接 / 同步 / 跨多维表

- **原生同步表**:飞书表格→多维表格同步(自动/手动)· **跨多维表格同步数据**(汇总到同一 base 不同表)· 同步审批/任务清单数据 · **组织共享数据源**(发布为企业权威事实源)。
- 外部 DB(MySQL 等)= 经 API/脚本 或第三方(集简云/HiFlow),**非一方原生连接器**。
Source: <https://www.feishu.cn/hc/zh-CN/articles/843893161820-将表格数据同步至多维表格> · <https://www.feishu.cn/hc/zh-CN/articles/128401098783-跨多维表格同步数据> · <https://www.feishu.cn/hc/zh-CN/articles/959224273745-使用多维表格共享组织内数据源>

### 2.6 高级权限

精细管控 **数据表 · 记录(行)· 字段(列)· 视图 · 仪表盘**;**自定义角色**(角色=权限组,**≤30 角色 / ≤200 协作者/base**);为个人/群组设行/列读或编辑(增删行列)权限;**锁定视图/个人视图**;**AI 智能配置权限**(文字描述需求 → AI 建角色+配权限);V7.13 配置效果预览。
Source: <https://www.feishu.cn/hc/zh-CN/articles/962169212093-使用多维表格高级权限> · 行列 <https://www.feishu.cn/hc/zh-CN/articles/915018184717> · AI 配 <https://www.feishu.cn/hc/zh-CN/articles/804245947218> · 30 角色/200 协作者 <https://open.feishu.cn/document/server-docs/docs/bitable-v1/bitable-overview?lang=zh-CN>
> 未单独取证"导出遵守权限"(预期如此但未源)。

### 2.7 AI 能力(头号差异化)

- **AI 字段捷径**(§2.1):智能分类/信息提取/内容总结/翻译/文本生成/图片识别,可选 **DeepSeek R1 / 豆包 Doubao**。
- **AI 智能搭建助手**:**一句话生成业务系统(NL→app)**。
- **AI 生成公式**(NL→formula)· **AI 生成工作流**(NL→自动化)+ 自动化 **AI Agent 节点**。
- **AI 问数 / 智能问答**(对表自然语言提问得答案,如"最近销量好的商品+原因")。
- **仪表盘 AI 智能解释/总结**(§2.3)· **AI 配权限**(§2.6)· **AI 语音录入**(方言/纠错/抗噪)。
Source: <https://www.feishu.cn/content/article/7579168498044161238>(模型/AI 公式/工作流/语音)· NL→app <https://www.feishu.cn/content/article/7588081416752106693> · AI 问数 <https://www.feishu.cn/content/ai-powered-multidimensional-tables-easy-shortcuts-for-beginners>
> 局限:各 AI 功能**确认 2026 GA,但具体 ship 版本/日期未能逐条锚定**(不主张精确引入日期)。

### 2.8 开放平台 API

Base(bitable-v1)server API:app/base 管理 · table CRUD · field CRUD · view CRUD · **record CRUD + search** · dashboard(copy/list blocks)· 高级权限角色/协作者。**硬限制**:**10 QPS** · ≤300 字段/表(≤100 公式字段)· ≤200 视图/表 · batch ≤1000 记录/请求(全成或全败)· search ≤500 · batch_get ≤100 · 建议单 base 单并发写。**事件订阅**:记录变更事件 **`drive.file.bitable_record_changed_v1`**,webhook 回调或 **WebSocket 长连接**,**3 秒内 ACK**。官方多语言 SDK + Lark/Feishu CLI。
Source: <https://open.feishu.cn/document/server-docs/docs/bitable-v1/bitable-overview?lang=zh-CN> · 事件 <https://open.feishu.cn/document/docs/bitable-v1/events/bitable_record_changed?lang=zh-CN>
> 未从所读 bitable 页确认具体 HMAC/签名方案(事件平台级 Encrypt Key/校验 token 存在,但非 bitable 专属页所载)。

### 2.9 协作

实时多人协同编辑 · **单元格级评论 + 评论内 @提及 + 插入图片** · 关注评论(V5.5)· 富文本长文本字段(可嵌云文档/任务/流程图/图片/视频/表格)· 身份可选通知。
Source: 单元格评论 <https://www.feishu.cn/hc/zh-CN/articles/360025021493> · 关注评论 <https://www.feishu.cn/hc/zh-CN/articles/070181914854>

### 2.10 其他(2024-2026)

- **条件格式/高亮**:公式高亮 + **数据条/色阶/图标集(V4.10)** + **填色**(按条件给单元格/整行上色)。Source: <https://www.feishu.cn/hc/zh-CN/articles/161170600772>
- **记录历史/版本还原**:看历史版本并还原到任意状态。Source: <https://www.feishu.cn/content/article/7621123649048431573>
- **分组统计 · 模板中心 · 移动端 App(表单+语音转文字) · 仪表盘嵌入 Docs(V7.68 intl)**。
- **数据连接**(§2.5):in-base 跨表(关联+lookup,双向同步)+ **一应用关联多 base 文件**;外部 DB 同步经 API/iPaaS(集简云/数环通/影刀 RPA),**未确认一方原生外部连接器**(仅飞书审批同步确认原生)。

### 飞书 Base 2026 头条能力(供 diff)

1. **~26 字段类型** incl 双向关联(type 21)/查找引用(19)/群聊(23)/Stage(24)/**按钮(cn 3001)**;Rollup 无独立 type 2. **AI 字段捷径**(分类/提取/总结/翻译/生成/图片识别,可选 DeepSeek/Doubao 模型) 3. **AI 搭建/问数/生成公式/生成工作流/AI Agent 节点/语音录入** 4. **6 视图**(Grid/Kanban/Calendar/Gantt/Gallery/Form)+ 个人/保护/分享视图 5. **100 万行表 + 仪表盘 1000 万行统计** 6. **仪表盘 50+ 图表 + 拖拽透视表 + 多表联动 + AI 图表解释** 7. **自动化**:记录/定时/表单提交/**按钮**/**webhook** 触发 + 发消息/邮件/出站 HTTP/建改删记录/发起审批/**AI 节点** 8. 双向 webhook + 审批集成 9. **高级权限**:自定义角色(≤30)+ 行/列/视图/仪表盘 + AI 配权限 10. **OpenAPI**(10 QPS · ≤300 字段 · ≤1000 batch · search≤500)+ 事件订阅 webhook/长连接(3s ACK) 11. 单元格评论 @ + 图片 · 富文本长文本 12. 条件格式(数据条/色阶/图标集/填色)+ 记录历史还原 + 分组统计 13. 模板中心 + 移动端 + 仪表盘嵌 Docs 14. in-base 跨表关联 + 一应用多 base;外部 DB 同步 = API/iPaaS(非确认原生连接器) 15. **AI-native low-code/aPaaS** 业务系统搭建平台定位。

---

## 3. 差距阶梯(可执行,按 value × reachability 重排)

> 排序原则(总纲四原则):measurement→optimization · enterprise-baseline→differentiation · foundations→advanced · stability→risk。**单 arc 判别器 = prereqs-met**。

### 3.1 Top 候选阶梯

| # | 能力 | 飞书有 | MetaSheet 现状 | 差距 | value(用户影响) | reachability(effort + 前提) | arc 量级 |
|---|---|---|---|---|---|---|---|
| **A1** | **Grid 行虚拟化(windowing)** | **100 万行表 + 仪表盘 1000 万行统计** | 仅分页 + `content-visibility:auto`,零 windowing(`MetaGridTable.vue`,grep 零) | **企业规模头号阻塞,最大代差** | **极高**(决定能否接万级 base) | **前提未满足**:需先跑 S5b 50k/100k staging 基线(ops 门)锚预算 | **L** |
| **B1** | **按钮 / 动作字段** | 真 field type(cn 3001)+ 自动化"按钮点击"触发 | 无 `'button'` type;但 action backbone(update/create/delete/webhook/notification/lock/condition_branch/start_approval,12 action)**已成熟** | 缺行级触发入口 | **高**(行级一键操作,边际成本最低的超越) | **前提全满足**(action backbone 全在);仅轻设计锁(可调用范围) | **小链(2-3 PR)** |
| **B4** | **仪表盘非图表组件** | 50+ 图表 + 拖拽透视表 + 多表联动 + 仪表盘级筛选 + AI 图表解释 | 仅 9 chart type(含 number=KPI 卡)无 dashboard filter linkage / 透视(`dashboard.ts:7-8`) | 缺仪表盘级筛选联动 / 透视 / 排行/雷达 | **高**(BI/经营看板核心期望) | 前提满足(chart-aggregation 在);轻设计锁;透视表是其中 L 子项 | **小链→L** |
| **A5** | **条件格式样式深度** | 数据条 / 色阶 / 图标集 / 填色(V4.10) | 仅 solid 底色+文字色(`conditional-formatting-service.ts:25`) | 视觉深度 | 中 | 前提满足;轻设计锁 | **M** |
| **A4** | **表单逻辑深度** | required-if / 多页 / prefill / 提交后跳转 | #2605 仅单条件 show/hide(presentation-only,`field-visibility-rule.ts:15`) | 表单成熟度 | 中-高 | 前提满足(复用可见性规则词汇);设计锁 | **M** |
| **B2** | **AI 字段后续 rings + AI 节点** | 6 shortcut + 选模型 + NL→app/问数/工作流 + 自动化 **AI Agent 节点** + AI 语音 | M0-M4 基底成;**仅 4 手动 shortcut**(summarize/classify/extract/translate)+ NL→formula;无 AI 节点/问数/NL→filter | auto-trigger + generate + NL→filter/问数 + 自动化 AI 节点 | **战略高**(飞书头号差异化) | 基底已建;**每 ring 独立 opt-in;auto-trigger 需章程解锁** | **L/逐 ring** |
| **B7** | **行级条件权限规则引擎** | 行/列按值规则 + 自定义角色 | record_permissions 静态授权(无规则引擎);cross-base 已加 base-perm 原语 | 静态→规则引擎 | **高**(企业 must-have) | 前提部分(base-perm 原语在);**owner opt-in,安全敏感走对抗式评审 lane** | **L** |
| **B3** | **原生同步 / 外部源表** | 同步表 + 跨多维表同步 + 组织共享数据源 | 有 data-factory + data-sources CRUD,无 multitable 原生 syncedTable | 缺一方原生镜像 | 高(但 data-factory 已覆盖部分) | **owner opt-in + 设计锁(K3/集成边界)** | **XL** |

### 3.2 已**满足或超越**飞书(surpass wins — 代码取证)

- **W1 native `rollup` + `qrcode` 独立 field type**(`types.ts:12,21,27`)— **飞书 Rollup 无独立 type**(经 lookup/formula),QR 是 barcode 的 ui_type 变体;MetaSheet 的 rollup/qrcode 是一等类型,模型更直接。(注:飞书 lookup 确有 type 19,此项 parity。)
- **W2 自动化图编排净差异化**:typed `parallel_branch`(fan-out + **join-all**,v1)+ branch-local `wait_for_callback`(suspend/resume)+ `start_approval`(**approval-as-job**)+ `condition_branch`(`automation-actions.ts:17-18`,执行器 `:1038`)。**校正:飞书自动化也有条件分支 + AI Agent/文本节点**;MetaSheet 的真正超越是 **parallel/join 编排 + approval-as-job + 跨 base 写治理**,飞书反有 AI 节点(见反向差距)。
- **W3 跨 base 治理深度**:claim==truth 校验 + 完整目标三元组 + `multitable:base:write` + **60/base/60s 写配额**(`automation-executor.ts:690-715,1783`)+ 结构守卫 + 实时失效 fan-out(**故意省略 trigger actorId 防跨 base 主体泄露**,#2618)。飞书"跨多维表同步"是**数据复制**,MetaSheet 是**带治理 + 配额的实时引用**——治理深度超飞书。
- **W4 Formula-over-Lookup**:one-hop recompute fan-out(`record-write-service.ts:298-326`)+ **in-memory hydration(FOL 见真实 lookup 值非 stale,`formula-engine.ts:250`)** + Yjs 失效(#2450/#2464/#2465)——公式越关联取数且实时一致,超出"仅 form-submit 求值"的典型实现。
- **W5 安全级 export 掩码**:服务端 `fieldIds` 仅 narrow(post-mask 交集,never widen)+ **RED→GREEN 泄露 canary**(`univer-meta.ts:7396`,#2591);canonical FE 导出 over 读时已掩码 `grid.rows`(#2635)——不绕过字段权限(常见安全洞,MetaSheet 经安全评审关掉)。
- **W6 安全级富文本 + AI taint chokepoint**:longText 写路 DOMPurify XSS sanitizer + 8-canary fail-first(#2598/#2614);**字段读掩码进 AI prompt 前生效**(`multitable-ai.ts:68`)——掩码字段绝不入 prompt/export。
- **W7 Webhook HMAC-SHA256 + 租约 retry-backoff + 持久投递行**(`webhook-service.ts:368,381,631`,真实出站非 stub)+ OpenAPI spec + SDK auto-gen + parity gate(`packages/openapi`)— 开发者集成工程纪律在多数同类之上。
- **W8 AI 用量台账 dual-axis no-overshoot 配额 admission**(#2623,estimate-aware 关单请求 + 并行复合双重 overshoot)+ permission-matrix golden gate 入 CI(DB-guard)— 比典型 per-seat AI 计量更严,且权限回归已工程化。
- **W9 独立 Timeline + Hierarchy 视图**(`MultitableWorkbench.vue` `FORCED_VIEW_MODES`,Hierarchy 含 `hierarchy-cycle-guard.ts` 环防护)— MetaSheet **确有**这两个独立视图;**飞书侧仅基于"未确认存在独立 Hierarchy/List 视图"(时间轴折进甘特),非正向证据 → 此项可信度低于 W1-W8/W10,作 tentative win 标注、勿与代码取证项等价。**
- **W10 聚合页脚全集语义**:服务端 per-group 小计 over 全 filtered set(非分页窗口)、无本地 fallback(`MetaGridTable.vue:630,654`)— 窗口化下保持聚合正确是真差异化。

> **反向差距(诚实标注)**:飞书在若干处领先 MetaSheet——① 自动化 **AI Agent/文本节点**(MetaSheet 自动化无 AI 节点)· ② **100 万行表 / 1000 万行仪表盘**(MetaSheet 无虚拟化,A1)· ③ **50+ 图表 + 透视 + AI 图表解释**(B4)· ④ **AI 问数 / NL→app / AI 配权限 / AI 语音**(B2)· ⑤ **条件格式数据条/色阶/图标集**(A5)· ⑥ 单元格评论插图 / Stage·群聊字段。surpass 项集中在**治理/安全/工作流编排**,飞书领先项集中在**AI/规模/BI 富度**——与"对标并超越"目标一致:守住治理护城河、补 AI/规模/BI。

### 3.3 park(大/不确定 — 暂不开 arc)

- **群聊字段 / Stage 流程字段 / 飞书 IM 绑定特性** — 平台耦合,无具名需求。
- **location 地图选点** — provider 依赖(高德/Leaflet)决策门。
- **移动端 / PWA / 离线** — XL,无具名需求(仅有用例时进)。
- **AI 问数 / NL→建表 / 自动化 AI Agent 节点**(B2 最深 ring)— 战略大投入,基底先于此;AI 节点需接 Claude API + 章程解锁。
- **外部 DB 一方原生连接器** — 与 data-factory/K3 集成边界重叠,owner 门。
- **B3 原生 syncedTable** — XL 数据模型变更,owner opt-in + 设计锁先行。

**次级 parity 小项(value 中-低,无重门,可拼车顺手做,非独立 arc):** 格内 @mention + 评论 emoji 反应 + 评论插图(M,与 mention 基建联合)· 双向链接完整写回(现 #2595 仅 derived-reverse 只读投影,完整可独立写两端折进设计空间)· longText WYSIWYG 编辑器(现 render-only,编辑仍 textarea)· 附件 image-only 字段变体(预览/缩略图已在,仅缺独立 image 子类型)· 记录历史 UI 深化。

---

## 4. 推荐的下 1-2 个 arc

### 首推 arc:**B1 按钮 / 动作字段**(小链,2-3 PR)

**理由(value × reachability,判别器 = prereqs-met):**
1. **前提全满足、reachability 最高**:与 A1(虚拟化,需先过 S5b ops 基线门)和 B7/B3(owner+安全/设计门)不同,B1 **零前置门**——action backbone(`update_record`/`create_record`/`delete_record`/`send_webhook`/`send_notification`/`lock_record`/`condition_branch`/`start_approval`)已全部成熟落地,按钮字段只是给这套已验证后端加一个**行级触发入口 + 一个 `'button'` field type + 渲染/点击 UX**。这是"给定成熟 action backbone 的最便宜超越"。
2. **value 高且对标精准**:飞书把按钮字段作为头条业务字段(触发自动化 / 一键改状态),是高频用户面;MetaSheet 当前**完全缺**这个入口,是清晰的 baseline parity 缺口。
3. **arc 量级可控**:小链 = ① `'button'` field type + property(可调用 action 范围,设计锁)→ ② 渲染/点击触发(复用 automation-executor)+ 权限校验(行级写)→ ③ FE 编辑器配置 + 测试。每步标准管线,无 ops/owner 门。
4. **杠杆放大已有超越(W2)**:MetaSheet 自动化已是工作流引擎级(condition_branch/parallel/start_approval),按钮字段把这套深度**暴露到行级一键**——一个动作即把"更深的引擎"变成"更可见的用户价值"。

**设计锁先行项**:按钮可调用的 action 范围(仅 update_record 改状态?还是可触发完整 automation rule?)+ 行级写权限校验 + 幂等/防连点。

### 次推 arc:**B4 仪表盘非图表组件**(小链→L)

飞书 2025 仪表盘升级(指标卡 + 透视表 + 切片器 + 多数据源)是当前明显代差;MetaSheet 仪表盘仅 chart panel。前提满足(chart-aggregation 在),**指标卡 + 仪表盘级筛选**是小链可达的高 value 首切片,**透视表**作为其中 L 子项后续。BI/经营看板是 multitable 核心使用面。

### 测量锚 → 头号 baseline(并行/后续)

**A1 Grid 行虚拟化**是 value 最高的 baseline 缺口,但 reachability 受 **S5b 50k/100k staging 基线(ops 门)** 阻塞——**recommended 先清 ops 门跑基线锚预算,再开 A1**。这是唯一 value 极高但**前提未满足**的 L 项,故不作首推单 arc,而是排在 B1 之后、待 ops 基线就绪。

---

## 5. 落地与勘误

- 本文档相对 #2629 的**净增量**:(a) 飞书侧一手取证 + 引用(#2629 是纯代码 burndown,无飞书引用);(b) **#2635 落地后重排**——A2(export 选择器)已闭合,#2629 的"首发 lock-safe = A2"作废,首推上移到 B1;(c) surpass 项 **W1-W10** 代码取证 + **反向差距诚实标注**(对标"超越"目标的双向坐标系)。
- **飞书取证局限(诚实标注)**:① feishu.cn/larksuite.com 帮助中心**正文**是 JS-SPA,WebFetch 仅得 metadata → cn UI 特性据 **WebSearch 服务端渲染摘要 + feishu.cn/content 产品文**;② **字段 type 码 + API 限制据 open.feishu.cn 开放平台文档(server-rendered,最高可信)**;③ **各 AI 功能确认 2026 GA 但具体 ship 版本/日期未能逐条锚定**(不主张精确引入日期);④ 未确认飞书独立 Timeline/Hierarchy 视图、原生外部 DB 连接器、export 遵守权限、bitable 专属 HMAC 方案——均按"未核/未确认"标注,不据此打分。
- 后续按 goal 纪律:gate-free 项(B1 首推、B4 首切片)走标准管线;owner/ops/安全门项(A1 的 S5b、B7、B3、B2 AI 节点)到点请示。**勿自动开下一弧**(staged opt-in:每弧一次具名 opt-in)。
