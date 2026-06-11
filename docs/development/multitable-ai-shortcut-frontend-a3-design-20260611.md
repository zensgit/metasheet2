# 多维表 AI 字段 shortcut 前端(A3 / M3)— 设计锁定 — 2026-06-11(核验修订版)

> Status: **DESIGN-LOCK(docs-only)** · 主线位置:arc 计划 M3(关 T3 展示;修正二:产品路径)
> 核验:fact-check workflow(1 核验员逐行验 A2 真实契约 + 1 批评者,verdict ready-with-edits)——**全部修正已并入,契约已钉死,无悬置条款**。
> **本环声明一个小后端触点**:ledger 导出 summary 函数 + admin-only 用量汇总路由(零迁移零新表)。无 OpenAPI。

## 0. 范围一句话

M3 = 体验层:①字段管理器 aiShortcut 配置区(含"用当前记录预览");②记录抽屉 + 单元格编辑器 run 触发;③全状态 UX(按 error.code 判别);④用量可见性(per-run tokens + admin 汇总卡)。

## 1. 承重事实(核验后)

| 事实 | 出处 |
|---|---|
| 配置区模式:per-type template 块 + reactive draft + hydrate + `update-field` emit + `fieldConfigError` 内联 | MetaFieldManager.vue:73/615/1019/1146/1346/380 |
| **A2 真实响应契约(已逐行验证)**:见 §2.3 表;run 成功 = `{ok:true,data:{status:'succeeded',action:'run',recordId,fieldId,version(可 null),output,usage,estimatedCostUsd,provider,model}}`——**不是 PatchResult** | routes/multitable-ai.ts:555-569;集成测试 :201-204 |
| preview **强制要求真实可读 recordId**(z.string().min(1);无手填样例路径)且接受 inline config;run 拒 inline(400 AI_INLINE_CONFIG_REJECTED) | multitable-ai.ts:339/341/443-448 |
| **`aiShortcut:null` 被 400 拒**(校验只跳过 undefined);**移除 = PATCH property 整体替换时省略该键**;"disabled 标记"方案不安全(unknown 顶层键被忽略仍按生效解析) | ai-shortcut-config.ts:57-60/150-151;univer-meta.ts:5237-5259 |
| **property-clobber 陷阱(既有,A3 后承重)**:saveConfig 纯草稿构建 property 整体替换——不水合 aiShortcut 则任意一次保存静默删配置 | MetaFieldManager.vue currentDraftProperty/saveConfig |
| parseJson 错误携带 status/code/fieldErrors/serverVersion/retryAfterMs;**body 顶层 `status` 判别字段不透出 → 必须按 `error.code` 分支**;quota 的 429 **无** Retry-After | client.ts:165-222 |
| echo 应用点 `applyPatchResult()`(updated/records 键) | useMultitableGrid.ts:796-819 |
| 抽屉有 fieldPermissions prop + `canEditField()`(=preview/run 门控数据);**MetaCellEditor 无 fieldPermissions——其安全性依赖"编辑器只为可编辑单元格打开"的上游不变式** | MetaRecordDrawer.vue:291/367/378-384 |
| `checkAiUsageQuota` 算了三个 SUM 但**丢弃数值只返回决策**——summary 需新导出函数(共享 SQL) | ai-usage-ledger.ts:139-174 |
| dry-run 先例无记录选择器,只有 `currentRecordId` 门控的"用当前记录测试"按钮 + 手填样例 | MetaFieldManager.vue:176-210/698-796 |
| burst limiter preview/run 同 keyPrefix(`multitable-ai-shortcut`)——预览点击会消耗 run 的限流额度 | multitable-ai.ts:142-173 |

## 2. 锁定设计

### 2.1 配置区(MetaFieldManager)

- 新 config 区块(目标字段 string/longText):kind 枚举、sourceFieldIds 多选(镜像 A2 约束 ≤20、排除 computed/自身)、params per-kind(options ≤50×100 行编辑器;targetLang ≤32;instruction ≤500 计数 textarea)。
- **clobber 防护(锁,带回归测试)**:`hydrateExistingFieldConfig` 必须水合 `aiShortcut` 进草稿;string/longText 字段**每次**保存的 property 都回发现存 aiShortcut(未配置则不带键)。
- **移除 = 省键**(勾掉"启用 AI shortcut"开关 → 保存的 property 不含该键)。**无 null、无 disabled 标记**。
- **配置时 preview(锁定为方案 a)**:"用当前记录预览"按钮,`currentRecordId` 门控(无当前记录/空表 → 禁用 + 提示);走 A2 preview(**inline 草稿 config** + currentRecordId)。UI 明示两点:**预览即真实 provider 调用,消耗配额与 token**;**配置区预览验证的是当前草稿,非已生效配置**。
- A2 服务端校验失败 → 既有 `fieldConfigError` 内联。

### 2.2 触发面与 echo 适配

- **抽屉(主)**:字段头动作区按钮组——`fieldPermissions` 可读→"预览",`canEditField`→"运行"(与后端门一致)。
- **单元格编辑器(辅)**:编辑态内嵌"运行"按钮(link-btn 先例);**RBAC 不变式入注释**:按钮安全性依赖编辑器仅为可编辑单元格打开;任何把按钮挪出编辑态的 follow-up 必须显式接 fieldPermissions。
- **run 响应适配器(锁;核验 refuted 修正)**:`useAiShortcut` 从 run 响应**合成** `{updated:[{recordId,version}], records:[{recordId,data:{[fieldId]:output}}]}` 再喂 `applyPatchResult()`;**`version===null` 时跳过 version 写入只合值**;合成逻辑必须有**对真实 wire 形状的路由级断言**(fixture-drift 纪律)。
- **运行中漂移(锁)**:run 发起时捕获本地 row.version;返回时若本地 version 已变(协作编辑),**跳过合并**并提示刷新(与 409 同一条恢复文案);409 原样走网格既有冲突语义。
- **重入防护(锁)**:三个入口统一 in-flight pending 态(按钮禁用 + spinner);文案提示预览与运行共享频率额度。

### 2.3 状态 UX(契约已验证钉死;client 按 `error.code` 分支)

| 后端结果 | HTTP | 判别键(error.code) | UI |
|---|---|---|---|
| blocked | 503 | `AI_BLOCKED` | "AI 能力未启用/未就绪,请联系管理员"(**勿按 5xx 通用故障处理**;管理员经 A1 readiness 端点诊断) |
| rate_limited | 429 **+ Retry-After** | `RATE_LIMITED` | "操作过于频繁" + retryAfterMs 倒计时禁用 |
| quota_exhausted | 429 **无 Retry-After** | `AI_QUOTA_EXHAUSTED` | "AI 用量已达上限"(无倒计时) |
| unsafe_input | 422 | `AI_UNSAFE_INPUT` | "内容含敏感形态,已拒绝发送" |
| provider_error | 502 | `AI_PROVIDER_ERROR` | "AI 服务暂时不可用" + 重试 |
| 版本冲突(run) | 409 | `VERSION_CONFLICT` | 网格既有冲突语义(提示刷新) |
| 成功 | 200 | `data.status==='succeeded'` | 适配器落值 + "本次消耗 ~N tokens"(usage) |

### 2.4 用量可见性(T3 展示收口;唯一后端触点)

- **ledger 新导出 summary 函数**(与 `checkAiUsageQuota` 共享 SUM SQL,返回数值;零迁移零新表)。
- **新路由** `GET /api/multitable/ai/usage-summary`(internal + `requireAdminRole()`,**不挂 AI burst limiter**):返回 **`{ callerDayTokens, callerWeekTokens, instanceDayUsd, caps }`**(subject 语义锁定:调用者自身 tokens + 实例 USD;per-user 查询参数 = follow-up)。**不含 readiness 信息**——blocked 诊断走 A1 端点,不在此复用。
- 配置区 admin 用量卡(automation 卡片着色样式;均时不在卡片先例内,不镜像):**探测结果 per-session 缓存**(非 admin 一次 403 后本会话静默隐藏)。
- 普通用户 T3 可见性 = per-run tokens + §2.3 配额状态文案。

### 2.5 边界

A2 后端语义不动(新增:ledger summary 导出 + 一只读路由);无 OpenAPI;无迁移;i18n 仅扩展 `meta-manager-labels`/`meta-record-labels`/`meta-core-labels`/`meta-api-error-labels`;无网格列头/行菜单入口;无批量。

## 3. 测试矩阵(fail-first)

| # | 场景 | 断言 |
|---|---|---|
| A3-T1 | 配置区渲染/水合/保存形状/约束镜像 | 组件 spec |
| A3-T1b | **clobber 防回归**:已配置 aiShortcut 的字段,只改 validation 后保存 → property 仍含原 aiShortcut | 组件 spec(wire 形状断言) |
| A3-T1c | **移除往返**:勾掉开关保存 → property 无键;重开配置区 → 显示未配置 | 组件 spec |
| A3-T2 | 配置时 preview:inline 草稿 config + currentRecordId 调用形状;无 currentRecordId → 禁用;真实调用/草稿语义提示文案存在 | 组件 + client spec |
| A3-T3 | 抽屉按钮 RBAC 三态(可读/可编辑/均无) | 组件 spec |
| A3-T4 | **适配器**:对真实 wire 形状(路由级响应)合成 PatchResult;version null 跳过;成功落值 + tokens 展示 | composable + 路由级 spec |
| A3-T4b | 漂移守卫:返回时本地 version 已变 → 跳过合并 + 刷新提示 | composable spec |
| A3-T5 | 状态全集按 error.code 分支:**429 双语义**(RATE_LIMITED 有倒计时/AI_QUOTA_EXHAUSTED 无)、503 AI_BLOCKED 不按通用故障、422/502/409 | client + 组件 spec |
| A3-T5b | 重入:pending 中再点 → 无第二次请求 | composable spec |
| A3-T6 | 单元格编辑器按钮(编辑态出现,同 composable) | 组件 spec |
| A3-T7 | usage-summary:后端 admin 200 形状/非 admin 403/不挂 burst limiter;FE admin 卡渲染/403 缓存隐藏 | 后端路由 + 组件 spec |
| A3-T8 | i18n 双语/模块归属/无跨模块重声明 | 静态 |
| A3-T9 | vue-tsc -b + 后端 tsc + 全套回归 | gates |

## 4. 回滚

纯前端 + 一只读路由 + 一导出函数:revert 即消失;property.aiShortcut 数据不受影响。

## 5. 不在 M3

网格列头/行菜单入口 · 批量 · readiness 普通用户预取 · 用量历史/导出/每用户查询参数 · 记录选择器式预览 · 自动化 action · OpenAPI。
