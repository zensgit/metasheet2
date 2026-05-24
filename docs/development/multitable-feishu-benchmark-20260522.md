# Multitable vs 飞书多维表 — 优化空间分析

Date: 2026-05-22
Status: research / planning baseline (post multitable i18n track strict-zero closure)
Revision: **v2 errata + roadmap re-rank** (see §13 Changelog)
Scope: `apps/web/src/multitable/**` 前端 + 涉及的 backend API surface

## 1. 方法学

证据来源：
- 3 个 Explore agent 并行扫描（field types / views+performance / collaboration+automation+API depth）
- 直接读 `apps/web/src/multitable/types.ts` (1081 行) + `MetaGridTable.vue` (692 行) + `useMultitableGrid.ts` 关键能力探测
- 已合并 i18n track 全数 26 slices 提供的 UI surface map（17 typed label modules 覆盖范围）

参考 baseline：origin/main `dc8f3581a` 之后的 multitable codebase（i18n track 完整收尾后）。

## 2. 当前优势（建立坐标系，避免负面化）

### 2.1 字段层基础扎实

`types.ts:6-33` 真实存在 **27 个 field type union**：

| 类别 | 字段 |
|---|---|
| 基本 | `string` `number` `boolean` `date` `dateTime` `longText` |
| 选择 | `select` `multiSelect` `autoNumber` |
| 计算 | `formula` **`lookup`** **`rollup`** |
| 富类型 | `attachment` `url` `email` `phone` |
| 数值变体 | `currency` `percent` `rating` |
| 专门 | `barcode` `location` `person` |
| 系统 | `createdTime` `modifiedTime` `createdBy` `modifiedBy` |
| 关联 | `link` |

**亮点**：`lookup` + `rollup` 是 native field type（非 formula 内嵌），与飞书"查找引用 + 汇总"同档；formula 含 54 函数 × 8 类别 + 15 diagnostic（Slice C 收尾）。

### 2.2 自动化层成熟

T3D 4-PR 链交付：
- **7 触发类型**：record.created/updated/deleted + field.value_changed + schedule.cron/interval + webhook.received + legacy field.changed
- **8 行动类型**：update_record / create_record / send_webhook / send_notification / send_email / send_dingtalk_group_message / send_dingtalk_person_message / lock_record + legacy notify/update_field
- **12 condition operators** + 8-value `AutomationConditionValueWidget` union
- **DingTalk 集成深度**：6 个 dingtalk*.ts util（presets / template tokens / template lint / recipient warnings / public form link warnings / internal view link warnings）+ group/person delivery 跟踪 + redacted support packet

### 2.3 视图覆盖完整

9 个 view component 全部存在：grid / calendar / gallery / gantt / hierarchy / kanban / timeline / dashboard + chart-renderer + form view + record drawer。所有视图 i18n 完整（Slice B 收尾）。

### 2.4 协作层有基础

- Yjs awareness（字段级粒度 — user.fieldIds array）
- Row-level + field-on-row comments + threading（parentId nesting）
- Mention inbox（unread + mentioned filters）
- Per-record audit log (`MetaRecordRevision` 含 action/changedFieldIds/patch/snapshot)
- Cell-level optimistic concurrency（serverVersion）

### 2.5 i18n track 完整收官

26 slices / 17 typed label modules / strict-zero closed — chrome 层已无遗漏。

---

## 3. 关键差距（按 leverage 排序）

### Gap 1 — Grid view 无虚拟滚动 🔴 #1 能力差距（但需 perf gate 先行）

**这是单点决定 metasheet2 能否进入 enterprise scale 的卡点。但启动顺序必须先做性能 baseline，否则虚拟化做完也说不清改善多少。**

**前置 prerequisite — D2 large-table perf gate（必须先做）**：
- 量化 10k / 50k / 100k 行数据的：导入耗时 / 查询响应 / 渲染 FPS / 导出耗时 / 编辑延迟
- 输出 baseline 报告 + 性能 budget（"虚拟化后 50k rows 渲染 < 2s"等可验证目标）
- 否则虚拟化无法证明 ROI，也无法判断是否触发其他二阶问题（network bottleneck / server-side filter latency / Yjs sync overhead）
- **1 个 PR，低风险，高决策价值** — 是真正的第一刀

**证据**：
- `MetaGridTable.vue:692 lines` 中 grep `virtual|window|RecycleScroller|DynamicScroller|VirtualList|IntersectionObserver` **零命中**
- 唯一性能优化：`content-visibility: auto` (L606) — CSS hint，浏览器降级渲染但 DOM 节点仍存
- 分页：offset+limit 模式 `DEFAULT_PAGE_SIZE`（`useMultitableGrid.ts:344`）

**实测瓶颈**：~2k rows DOM jank（agent 估算）。Gantt/Timeline/Kanban 同样 render full set，二阶问题。

**飞书对照**：row windowing + lazy column 渲染 + 增量 filter，实测 100k+ rows 流畅。

**建议方案**：
- 引入 `vue-virtual-scroller` 的 `RecycleScroller`，或自实现固定行高 windowing
- 行高约束：`RowDensity = 'compact' | 'normal' | 'expanded'`（types.ts:37）已存在，可固定为枚举行高
- Grid 模板改 `<RecycleScroller :items="visibleRows" :item-size="rowHeight">`
- 配合 server-side filter/sort 既支持的 offset 分页

**Effort: 中等 (2-3 周)** | **Impact: 极高** — 直接决定能否接 1 万+ 记录的 base。

---

### Gap 2 — Grid 无聚合行 / 分组无统计

**证据**：
- Grid 已支持 group-by（`MetaGridTable.vue:378-405` 折叠 + count），但 **无 per-group sum/avg/min/max**
- Grid 底部 **零 agg footer**（grep `aggregation|summary|footer` 全空）
- 飞书：**统计栏** 每列可设 sum/avg/count/min/max/non-empty count；分组头显示分组聚合（"销售总计 ¥1.2M"）

**建议方案**：
```ts
// view.config 扩展
{
  aggregations: Record<fieldId, 'sum' | 'avg' | 'count' | 'min' | 'max' | 'nonEmpty'>
  groupAggregations: Record<fieldId, AggFn>  // 各分组内统计
}
```
- 渲染层：`<MetaGridFooter :rows="filteredRows" :aggs="aggregations">` 一行（sticky bottom）
- group header 加 inline agg：`{groupValue} ({rowCount}) — 销售总计：${groupSum}`
- 前端 reduce 即可；配合虚拟滚动只算 visible window 也无碍

**Effort: 中等 (1.5-2 周)** | **Impact: 高** — BI 用户的核心期望（销售看板、预算追踪）。

---

### Gap 3 — 无 AI 字段 / 无 AI action / 无 NL-to-query

**证据**：全 codebase grep 零 AI 字段类型 / 零 LLM 集成。

**飞书对照**：2024 起内置 **AI 字段 7+ subtypes** — summarize / classify / extract / generate / translate / sentiment / tag-from-content；2025 推出 **AI tabledesk**：自然语言 → filter/sort/formula（"显示上周销售额 > 1万的客户"）。

**建议方案 Phase 1（最小可用 AI 字段）**：
```ts
// types.ts 扩 union
| 'ai'

// property shape:
{
  mode: 'summarize' | 'classify' | 'generate' | 'extract',
  sourceFieldIds: string[],
  prompt: string,
  model: 'claude-haiku-4-5' | 'claude-sonnet-4-6' | ...,
  cacheKey?: string  // 防重复调用
}
```
- 后端加 `/multitable/ai/generate` endpoint，按 `record × ai-field` 缓存结果
- Editor 显示 "Generating..." + Regenerate 按钮；Renderer 显示生成文本 + small attribution badge
- **2 phase**：先 stateless generation（点 regenerate 触发），后 auto-trigger on source field change

**Phase 2** 可考虑 AI tabledesk（NL → filter/formula）。

**Effort: 高 (4-6 周)** | **Impact: 战略性** — 飞书 2024→2025 最大差异化点。

**注意**：接 Anthropic Claude API（与 metasheet2 主线一致），含 prompt caching 控成本。

---

### Gap 4 — 跨 base 链接 + 跨 base 自动化

**证据**：
- `types.ts` 中 link field 的 `foreignSheetId` 仅在同 base 内
- 自动化 `triggerConfig.sheetId` / actionConfig 全 scoped 单 sheet（无 baseId 跨域）

**飞书对照**：**跨多维表关联** 字段 + 工作流可跨 base 操作。

**建议方案**：
- Schema：link field property 加 `foreignBaseId?` (current implicit = same base)
- API：`/bases/{baseId}/sheets/{sheetId}/records/...` 已支持 baseId scoping；only auth check + workspace boundary 需补
- Automation：action `update_linked_records` 加 `targetBaseId?` 参数；权限检查跨 base 校验调用者在 target base 是否有写权限

**Effort: 高 (4-5 周，含权限模型扩展)** | **Impact: 高** — enterprise 跨部门 workflow（申请 base → 审批 base → 履约 base）是飞书 hallmark 用例。

**⚠️ 注意**：K3 PoC stage-1 lock 下需评估是否触发 integration-core 触碰红线。建议 GATE PASS 后再启动。

---

### Gap 5 — 通信渠道：源码层已 ready，真实差距在运维 + 渠道扩展

**证据修正**（v1 写错）：
- ✅ **`send_email` 源码已 ready**（v1 误称"仅类型存在"）：
  - `packages/core-backend/tests/unit/email-transport-readiness.test.ts` — SMTP transport readiness gate（支持 host/port/user/password/timeout 验证 + 配置错误时阻塞）
  - `scripts/ops/multitable-email-real-send-smoke.test.mjs` + `.ts` — 真实发送 smoke test
  - `packages/core-backend/tests/e2e/multitable-automation-send-email-smoke.spec.ts` — e2e 集成
  - Phase 2 Lane B3 + RC automation 发邮件 dev/verification MD 多份
- ❌ **DingTalk** 实现深度（6 util + 18 placeholder + group/person/template/warning helpers）— 这部分 v1 描述正确
- ❌ 零 Slack / Teams / Lark Bot / SMS 单独 channel

**真实 gap**：
1. **生产环境真实邮箱回执证据**（不是源码能力 — 是 SMTP 凭证配置 + 实发记录归档 + 退信处理）
2. **多渠道扩展**：Slack incoming webhook + Microsoft Teams adaptive card（可复用 DingTalk pattern 派生 `slackNotificationPresets.ts`）
3. **K3 PoC GATE PASS 后** Lark/Feishu Bot

**建议方案** — 分级扩展：

| Phase | 内容 | Effort |
|---|---|---|
| **Phase 1** | 生产 SMTP 凭证落地 + 真实发件回执 acceptance；webhook delivery 加 HMAC-SHA256 签名 | 1-2 周（运维 + 验证为主，非编码）|
| **Phase 2** | Slack incoming webhook + Microsoft Teams adaptive card — drop-in 复用 `dingtalkNotificationPresets.ts` 派生 | 3-4 周 |
| **Phase 3** | Lark/Feishu Bot 集成（如目标用户重叠）— K3 PoC GATE PASS 后 | 3-4 周 |

**Impact: 中-高** — DingTalk 在中国市场强，但 SaaS 出海需 Slack/Teams。

---

### Gap 6 — 外部开发者生态（spec 已存在，差的是面向开发者的分发 + 治理）

**证据修正**（v1 写错）：
- ✅ **OpenAPI spec 早已存在**（v1 误称"无 OpenAPI spec / Postman collection"）：
  - `packages/openapi/src/paths/multitable.yml` — **1602 行** 完整 spec
  - `packages/openapi/dist/` 含 `combined.openapi.yml` + `openapi.json` + `openapi.yaml` + `sdk.ts`（SDK auto-gen 已 ready）
  - Parity tests：`packages/openapi/dist-sdk/tests/{approval,plm-workbench,client}.test.ts`
  - Source-of-truth + dist + 测试 三件套齐备
- ❌ Webhook 无 HMAC 签名机制（这部分 v1 描述正确）

**真实 gap**：
1. **外部开发者文档站**（`docs.metasheet2.com/api` 或类似）— spec → 渲染 → 发布
2. **SDK 分发**（npm / pypi / Go module）— `sdk.ts` 已 ready 但未发布
3. **Webhook 签名机制**（HMAC-SHA256，业内 table stakes）
4. **配额 / rate-limit / API key 治理**（quota dashboard + per-token rate limit）
5. **错误码 reference**（关联 audit MD §3.5 5 个 frontend fallback string；后端 error code 字典化）

**飞书对照**：Open Platform 自带完整 OpenAPI + 多语言 SDK + rate limit + quota + signature + 错误码 reference + 沙箱 + applications 审批流程。

**建议方案**（按价值递增）：
- **Phase 1**（quick win，1 周）：Webhook HMAC-SHA256 签名 + 签名 verify docs
- **Phase 2**（2-3 周）：docs site 发布 — `dist/openapi.yaml` → ReDoc / Stoplight Elements 静态站
- **Phase 3**（3-4 周）：SDK npm publish + 错误码 reference + sandbox/staging env quota dashboard

**Effort: 总计 6-8 周分阶段** | **Impact: 中** — 不直接拉新用户但 unblock 集成商生态。

---

### Gap 7 — 权限矩阵 golden gate（v1 低估，升至顶层关键 gap）🔴 企业 must-have

**v1 修正**：v1 把权限相关项埋在 UX gaps（如"Field-level conditional visibility"），低估了企业版核心需求。对标飞书企业版，**权限矩阵是与"大表性能"同级的硬门槛**，不应屈居 UX 子项。

**5 类权限矩阵 baseline**（每类必须有可验证 spec + golden matrix）：

| 类别 | metasheet2 现状 | 飞书企业版 | 缺口 |
|---|---|---|---|
| **Sheet** | `MetaSheetPermissionManager` (T3C-2a) 存在 + record/sheet 权限 manager | view-level role binding | 缺统一的 5-类 golden test matrix |
| **View** | view permission UI 存在 | per-user view subscribe + private view | private view scope 验证 |
| **Field** | field permission entries 存在（types.ts:325 `MetaFieldPermissionEntry`）| field-hide / field-readonly / field-required per role | golden matrix gap test |
| **Record** | `useMultitableRecordPermissions` composable + UI manager | row-level rules + sharing | rule-engine vs static permission 区分 |
| **Export** | export 全集导出（per agent 2） | export-with-permission-mask（隐藏字段不导出） | export 时不带 hidden / readonly field 验证 |

**建议方案 — D3 permission matrix gate**：
- 1 个 PR 输出 5 类 golden matrix test suite（user role × sheet/view/field/record/export × granted/denied/inherited 三态）
- 重点验证 **export 不绕过 field permission**（常见安全漏洞）
- 输出 acceptance MD 含可复现的 golden matrix（如 `permission-matrix-golden-20260522.md`）

**为什么是 #3 优先级**：
- enterprise 客户必查项（采购评估 checklist top 5）
- 防止 regression — 后续 cross-base / AI / template 都依赖此矩阵稳定
- 比 BI 优化更基础（BI 用户也需要权限正确）

**Effort: 中等 (2-3 周)** | **Impact: 极高** — enterprise gate 项。

---

## 4. UX 质量差距（次优先级）

| Gap | 现状 | 飞书 | 实现 pattern | Effort | Impact |
|---|---|---|---|---|---|
| **冻结列（用户可配）** | 仅 row-num + check-col sticky (`MetaGridTable.vue:603/605`)；列不可冻结 | 多列冻结左/右 | `view.config.frozenLeftColumnIds[]` + CSS sticky stack | 1 周 | 中 |
| **Inline create row** | grep 零；只能从 toolbar/empty state | grid 末行 "+" 直接新建 | empty-row 模板 + onClick 触发 createRecord | 3-5 天 | 中-高 |
| **Calendar event 拖拽改时长** | 现仅点击打开 detail (`MetaCalendarView.vue:94`) | 拖边调时长 / 拖体移日期 | 复用 Gantt resize 模式 (`MetaGanttView.vue:487 onResizeStart`) | 1-2 周 | 中 |
| **Kanban swimlane（双轴）** | 单 select field group (`MetaKanbanView.vue:249-251`) | group + lane 双轴 | 加 `view.config.swimlaneFieldId` + 嵌套 v-for | 1.5 周 | 低-中（niche） |
| **Per-cell comment** | row-level + field-on-row（无 cell-level） | 任何 cell 右键评论 | 评论模型已支持 fieldId，UI 改 cell 右键菜单 | 1 周 | 中 |
| **Mention in cell content** | 仅 comment body | longText 任意位置 @mention | longText 字段加 mention parser + autocomplete | 2-3 周 | 中-高（长文本协作）|
| **Conditional formatting 深度** | T3E-3 仅 solid color + applyToWholeRow | gradient bar / data bar / icon set / color scale | `ConditionalFormattingRule.style.kind: 'solid'\|'gradient'\|'icon'\|'scale'` | 2 周 | 中 |
| **Field-level conditional visibility** | 零 — 字段仅可全局 hide | 根据其他字段值动态显隐 | `view.config.fieldVisibilityRules: Array<{fieldId, conditions}>` | 2-3 周 | 中 |
| **Rich text 长字段** | longText 仅 plain textarea (`MetaCellEditor.vue:56-66`) | 富文本 + 嵌入图片 + mention + 链接预览 | 接 ProseMirror / TipTap | 3-4 周 | 中 |
| **导出选区** | export 仅 CSV/XLSX 全集 | 选区导出 / 视图导出 / 模板化导出 | export 函数加 `rowIds[]` / `columnIds[]` filter | 1 周 | 低 |

---

## 5. 字段类型质量差距

| 类型 | 现状 | 飞书 | 建议 |
|---|---|---|---|
| **Attachment** | MIME icon 但无 image-only 变体；无 inline gallery picker | image-only field + 嵌入相册 | 加 `property.imageOnly: boolean` 或新 `image` 子类型 |
| **Location** | 仅 address 文本 (`MetaCellEditor.vue:82-93`)；无 map picker | 地图选点 / 地理编码 / 反向地理编码 | 嵌入 Leaflet / 高德 地图组件 |
| **Currency** | 硬编码符号映射 (`field-config.ts:222-226`) | 多 locale + 千分位 + 货币列表完整 | 接 `Intl.NumberFormat` + 货币选择器 |
| **Number** | unit suffix 存于 property 但无 UI 编辑入口 | 单位选择器 + 显示模式 | field-manager 加 unit suffix UI |
| **Formula** | 无类型兼容性 validation | 公式语法 + 类型检查 | 静态检查 source field type 与 formula 函数 |
| **Person Link** | 仅 link 变体 (refKind='user') | 专门 person field type 含 avatar / presence | 提升为独立 type 含 profile card |

---

## 6. 字段类型缺失（vs 飞书）

| Feishu 字段 | 描述 | metasheet2 现状 |
|---|---|---|
| **AI 字段** | summarize/classify/extract/generate/translate/sentiment | ❌ 完全缺失 |
| **跨多维表关联** | link 跨 base | ❌ link 仅同 base |
| **双向关联** | 自动镜像 link | ❌ 单向 |
| **进度 / 线性 gauge** | 视觉进度条 | ❌ percent 仅数字 |
| **时间跟踪 / Duration** | 时长 + 计时器 | ❌ 缺失 |
| **二维码生成 + 扫码输入** | 显示 QR + 扫码 | ⚠️ barcode 仅文本输入 |
| **地理位置地图** | 地图嵌入 | ⚠️ location 仅文本 |
| **Sub-record / 子记录** | 嵌套记录 | ❌ 仅 link count 显示 |
| **条件字段显隐** | 动态隐藏 | ❌ 仅全局 hide |
| **富文本 + 提及** | 长文本含 @mention | ❌ longText 纯文本 |

---

## 7. 架构性机会（长期）

### Opportunity A — 实时推送（WebSocket / SSE）

- 当前 comment inbox、自动化 log、字段变更通知很可能走 polling
- 飞书：长连接推送
- **Pattern**：基于既有 Yjs WebSocket (`useYjsDocument.ts` 已有 ws 通道)，扩 channel 类型为 record/comment/automation event broadcast。Server push 即可，无需 fan-out
- **Effort: 3-4 周** | **Impact: 中-高**（协作 UX 质变）

### Opportunity B — PWA / 离线模式

- 飞书：移动 + 离线缓存
- metasheet2：未见 service worker / offline first
- **Pattern**：以 Yjs CRDT 为基础（已支持离线合并），加 service worker 缓存最近访问 base/sheet/records + IndexedDB 持久化
- **Effort: 6-8 周** | **Impact: 中**（B2B 移动场景）

### Opportunity C — 模板市场 / Workflow templates

- T2 + T3E-1 有 template 概念（`card.install` / template gallery），但 likely scope-limited
- 飞书：模板市场（行业模板 + workflow 模板 + 数据源连接器模板）
- **Pattern**：模板包含 schema + sample data + automation rules；导入时 fork-as-base
- **Effort: 4-6 周** | **Impact: 中-高**（用户冷启动 GTM）

---

## 8. Quick wins（小 effort，高 visibility）

| # | 项 | Effort | Impact |
|---|---|---|---|
| 1 | **Webhook HMAC-SHA256 签名** — `WebhookCreateInput` 加 secret 字段已存在 schema，加签名 generate (backend) + verify docs (frontend) | 3-5 天 | 高（安全 baseline）|
| 2 | **Comment mention → in-app push 通知** — mention inbox 数据通路已就绪，加 mention 时 fan-out 到 commentInbox.unread + ws push（如已有 ws 连接） | 3-5 天 | 中-高 |
| 3 | **`lock_record` action UI** — action type 已在 types.ts 但 RuleEditor 无对应 widget；加 dropdown + spec | 2 天 | 中 |
| 4 | **`send_email` 真实实现** — 类型存在但无 endpoint；连 SMTP / SendGrid / SES，模板复用 DingTalk preset pattern | 1 周 | 高 |
| 5 | **Webhook retry + exponential backoff UI** — backend 已 `retryCount` 字段，前端补 `retryPolicy` 配置 UI | 3-5 天 | 中 |
| 6 | **Inline create row** — Grid 末行 "+" 直接新建（最常见缺失 UX） | 3-5 天 | 中-高 |
| 7 | **冻结列（用户可配）** — 加 `view.config.frozenLeftColumnIds[]` + CSS sticky stack | 1 周 | 中 |

**Quick wins 7 项合计 ~4 周以内**，可与 Gap 1 (Grid 虚拟化) 并行做（不同人手）。

---

## 9. 推荐 Sequencing（v2 rerank — 替代 v1 4-Tier 结构）

基于 v2 errata（perf-gate-before-virtualization + permission-matrix-as-must + AI-staged-provider-first），重排为 8 步线性顺序：

| # | 项 | Effort | 风险 | 决策依据 |
|---|---|---|---|---|
| **1** | **D2 large-table perf gate** — 10k/50k/100k baseline 量化（导入/查询/渲染/导出/编辑延迟）输出 perf budget | 1 PR / 1 周 | 极低 | 最稳的第一刀；measurement-before-optimization 原则；为虚拟化提供可验证 ROI |
| **2** | **Grid virtualization** — 基于 #1 perf gate 结果做（不盲改），可能配合 server-side filter 改造 | 2-3 周 | 中 | #1 输出 baseline 后才有意义；fixed-row-height windowing per `RowDensity` |
| **3** | **D3 permission matrix gate** — sheet/view/field/record/export 5 类 golden test suite | 2-3 周 | 低 | 企业 must-have；防 cross-base / AI 等后续 feature regression；export-with-permission-mask 防安全漏洞 |
| **4** | **Grid BI polish** — agg footer + group rollup + 冻结列 + inline create row | 2-3 周合计 | 低 | 高 RoI 体验补齐；BI 用户期望；可与 #3 并行 |
| **5** | **Formula dry-run diagnostics** — 公式 dry-run 含测试数据预览 → 立刻减少配置错误 | 1.5-2 周 | 低 | 比 AI 更基础；formula docs (Slice C) 已含 15 diagnostic，可扩展为 dry-run mode；为 AI 字段铺路 |
| **6** | **AI provider readiness + AI field shortcut** — provider 选型 + cost/redaction/blocked-state 治理 → 然后才 AI field preview/run | Phase 1: 2-3 周 readiness；Phase 2: 4-5 周 AI field | 高 | 不直接开 ai field type；先解决 provider/cost/合规/失败态/缓存；avoid premature commitment |
| **7** | **Template preview/dry-run/onboarding** — 模板冷启动 + 行业模板（基于 T2 + T3E-1 已有 template 概念扩展） | 3-4 周 | 低 | GTM 价值；冷启动 + 行业模板 |
| **8** | **Cross-base link/automation** — 跨 base 字段 + 跨 base 自动化 | 4-5 周 | 高 | 高价值但高风险；**需 #3 permission matrix 稳定 + K3/integration 边界 GATE PASS 双前提** |

### Sequencing 决策原则

- **Measurement before optimization**（#1 → #2）
- **Enterprise baseline before differentiation**（#3 → #4-8）
- **Foundations before advanced**（#5 dry-run → #6 AI field）
- **Stability before risk**（#3 + K3 stable → #8 cross-base）

### Quick wins（可与 #1-#5 并行做）

7 项 Quick wins 合计 ~4 周不变（见 §8）— 不同人手可并行：
1. Webhook HMAC 签名（3-5 天）
2. Comment mention → in-app push（3-5 天）
3. `lock_record` action UI（2 天）
4. **修正后** Email send action UI 完善（1 周 — 源码已 ready，补 UI + 配置流程）
5. Webhook retry + exponential backoff UI（3-5 天）
6. Inline create row（3-5 天 — 合并入 #4 BI polish）
7. 冻结列（1 周 — 合并入 #4 BI polish）

---

## 10. 关键判断

### #1 优先级 = D2 large-table perf gate（不是直接虚拟化）

v1 误把"虚拟化"列为 Tier 0。v2 修正：**先量化 baseline 才能验证虚拟化 ROI**。

10k/50k/100k 行的 perf budget 报告是后续所有性能 / 容量决策的锚点。1 PR 低风险，决策价值高。

### #2 优先级 = D3 permission matrix gate（与性能同级）

v1 低估了权限。v2 修正：**enterprise 客户采购评估的核心 checklist 项**，必须有 5 类 golden test matrix。否则 cross-base / AI / template 等后续 feature 都建在不稳的权限地基上。

### 最高战略 leverage = AI 字段（staged）

但 v2 修正：不从 `ai field type` 直接开。正确顺序：
1. **Provider readiness**（选型 + cost model + redaction policy + blocked-state handling）
2. **Formula dry-run diagnostics**（基础设施，降低 AI 复杂度）
3. **AI field preview/run**（最终交付）

否则先引入成本失控、合规风险、失败态、缓存问题。

### Cross-base 留到最后

v1 把 cross-base 排在 Tier 2 强战略差异化。v2 修正：**需要 permission matrix 稳定 + K3/integration boundary GATE PASS 双前提**才能动；否则跨 base 操作会暴露权限边界 + integration-core 边界 双重风险。

### 最低成本 visible win = Quick wins 7 项

合计 ~4 周可全做完，与 #1-#5 并行。其中 Email send action UI（修正后）+ Webhook HMAC + lock_record UI 是 enterprise-readiness baseline 三件套。

### i18n track 完成后的注意力释放

刚刚做完的 i18n track（26 slices / 17 modules / strict-zero closed）确认了 metasheet2 **chrome 层已完整**；剩余 gap 全在**能力层（performance / permission / AI / cross-base / channel）**。i18n 完成后正好释放注意力到这条战线。

**下一步建议**：先启动 **#1 D2 perf gate**（1 PR 1 周低风险），同期 Quick wins 并行。完成后基于 perf budget 数据决策 #2 virtualization 是否需要 + 怎么做。

---

## 11. 附录：参考代码 anchor

| 关注点 | 文件 + 行 |
|---|---|
| Field type union (27 types) | `apps/web/src/multitable/types.ts:6-33` |
| Field property accessors | `apps/web/src/multitable/utils/field-config.ts` |
| Cell editor branches | `apps/web/src/multitable/components/cells/MetaCellEditor.vue` |
| Grid view（无虚拟滚动） | `apps/web/src/multitable/components/MetaGridTable.vue:692` |
| Grid 分组 (无 per-group agg) | `apps/web/src/multitable/components/MetaGridTable.vue:378-405` |
| Grid 冻结仅 row-num+check | `apps/web/src/multitable/components/MetaGridTable.vue:603/605/654` |
| Grid 分页 offset/limit | `apps/web/src/multitable/composables/useMultitableGrid.ts:341-444` |
| Automation rule editor | `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue` |
| ConditionValueWidget 8-item union | `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue:1075` |
| Conditional formatting (T3E-3) | `apps/web/src/multitable/components/ConditionalFormattingDialog.vue` + `apps/web/src/multitable/types.ts:101-115` |
| Formula docs (54 fn × 8 cat) | `apps/web/src/multitable/utils/formula-docs.ts` |
| Comment inbox (per-record subscribe) | `apps/web/src/multitable/composables/useMultitableCommentInbox.ts` |
| Yjs awareness (field-level) | `apps/web/src/multitable/composables/useYjsDocument.ts` |
| Record audit log | `apps/web/src/multitable/api/client.ts:624-648` (MetaRecordRevision) |
| DingTalk 6 util families | `apps/web/src/multitable/utils/dingtalkNotificationPresets.ts` etc |
| API error labels (3-tier resolver) | `apps/web/src/multitable/utils/meta-api-error-labels.ts` + `apps/web/src/multitable/api/client.ts:72/87/93/750-756` |

---

## 12. 文档来源

本文档来自 multitable i18n track 完整收尾后的 benchmark 分析。Audit chain 同期产出：
- `multitable-final-i18n-audit-20260522.md`（初始 audit MD）
- `multitable-final-i18n-closure-audit-20260522.md`（strict-zero 闭包审计）
- Final audit chain 5 slices (A/B/C/D/E) shipped via PR #1753 / #1757 / #1761 / #1764 / #1768

后续此文档可作为：
- 产品规划基线
- 工程优先级讨论锚点
- 与飞书定期对标的迭代起点

文档应在新 feature 切入时更新（如 AI 字段、虚拟滚动、cross-base 等切片落地后，对应 gap 移除）。

---

## 13. Changelog / Errata

### v2 (2026-05-22) — Errata + Roadmap Re-rank

**触发原因**：v1 草稿基于 agent 扫描 + 浅读，含两处事实错误 + sequencing 不够严谨（缺乏 measurement-before-optimization 纪律 + 权限矩阵被低估 + AI 启动顺序漏掉 provider readiness 前置）。

**事实修正**：

| v1 错误 | v2 修正 | 证据 |
|---|---|---|
| "send_email 仅类型存在无 endpoint 实现" | `send_email` 源码已 ready：SMTP transport + readiness gate + real-send smoke gate + Phase 2 Lane B3 + RC automation smoke 全套。真实 gap 是**生产环境真实邮箱回执证据 + 多渠道扩展** | `packages/core-backend/tests/unit/email-transport-readiness.test.ts`<br>`scripts/ops/multitable-email-real-send-smoke.test.mjs/.ts`<br>`packages/core-backend/tests/e2e/multitable-automation-send-email-smoke.spec.ts`<br>`docs/development/multitable-phase2-lane-b3-email-real-send-smoke-{development,verification}-20260511.md`<br>`docs/development/multitable-rc-automation-send-email-smoke-{development,verification}-20260507.md` |
| "全 codebase 无 OpenAPI spec / Postman collection" | OpenAPI spec 早已存在：source-of-truth + dist + parity test 三件套齐备。真实 gap 是**外部开发者文档站 + SDK 分发 + Webhook 签名 + quota/rate-limit + 错误码 reference 生态** | `packages/openapi/src/paths/multitable.yml` 1602 行<br>`packages/openapi/dist/{combined.openapi.yml,openapi.json,openapi.yaml,sdk.ts}`<br>`packages/openapi/dist-sdk/tests/{approval-paths,plm-workbench-paths,client}.test.ts` |

**Sequencing rerank**：

| v1 优先级 | v2 修正 |
|---|---|
| Tier 0: Grid 虚拟滚动直接做 | **#1 D2 large-table perf gate（10k/50k/100k baseline 量化）先行**；#2 virtualization 基于 perf gate 结果做，不盲改 |
| 权限矩阵藏在 UX gaps（"Field-level conditional visibility"） | **#3 D3 permission matrix gate** 升至顶层 — 与性能同级，企业 must-have，5 类 golden test matrix |
| Tier 1 BI polish 单列 | **#4 Grid BI polish** = agg footer + group rollup + 冻结列 + inline create row 合并 |
| AI 字段直接做 Phase 1（4-6 周）| **#5 Formula dry-run diagnostics** 先行（formula 基础设施，比 AI 更基础，可立即减少配置错误）<br>**#6 AI provider readiness + AI field shortcut** — staged：provider 选型 + cost/redaction/blocked-state 治理 → AI field preview/run |
| 未列模板 | **#7 Template preview/dry-run/onboarding** — GTM 冷启动 + 行业模板（基于 T2/T3E-1 已有 template 概念扩展）|
| Cross-base 列 Tier 2 | **#8 Cross-base link/automation** 留到最后 — 需 #3 permission matrix 稳定 + K3/integration GATE PASS 双前提 |

**新增门槛**：
- "perf gate before virtual scroll"（measurement-before-optimization）
- "permission matrix before cross-base"（baseline before differentiation）
- "AI provider readiness before AI field"（foundations before risk）

**保留项**：
- 字段类型缺失清单（§6）：lookup/rollup 已存在的发现仍准确
- UX 质量差距（§4）：10 项细节准确
- 架构性机会（§7）：3 项长期机会不变
- Quick wins（§8）：7 项不变（其中 #4 Email send UI 修正为"补 UI + 配置流程"非"真实实现"）

### v1 (2026-05-22) — Initial draft

基于 3 个 Explore agent 并行 + 直读 types.ts/MetaGridTable.vue/useMultitableGrid.ts 产出的初始 benchmark。Tier 0-4 sequencing。含上述 2 处事实错误 + 不够严谨 sequencing。保留为历史草稿，**实际工程决策以 v2 为准**。
