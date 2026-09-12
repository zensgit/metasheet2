# 数据工厂 K3 写回文案改口 + 三个 DISABLED 码进码表（G10）· 设计

- 日期：2026-09-10
- 分支：`fix/integration-k3-writeback-copy-and-codes`（基于 origin/main `a22955f83`）
- 相关运行时权威：`plugins/plugin-integration-core/lib/k3-external-write-permanent-fence.cjs`（E4 / HG v1.2 §10.1）

## 1. 差距

运行时自 2026-08-29 起永久禁止 K3 外部写回，四层拒绝、无任何运行时开关。但数据工厂主链路的**文案与控件**还停留在禁令之前：

| 位置 | 原文案 | 问题 |
| --- | --- | --- |
| `IntegrationWorkbenchView.vue` 页头副标题 | 「…先 dry-run，再导出或 Save-only 推送。」 | 把一个永远被拒的动作写成主路径 |
| 同文件 四步流程条第 4 步 | 「4. Dry-run / 推送 — 预览 payload 后导出或 Save-only 写回」 | 同上 |
| 同文件 运行与推送面板标题下 | 「…确认无误后才 Save-only 推送到目标系统。」 | 同上 |
| 同文件 `k3WebApiReadGateNotice` / `sourceSelectorExplanation` | 「当前 K3 WISE WebAPI 仅作为目标写入连接」 | 直接宣称 K3 是写入目标 |
| 同文件 `targetSelectorExplanation` | 「当前只有 K3 WISE WebAPI 目标连接可写入…真实推送仍按 Save-only 显式确认」 | 同上，且只认 WebAPI 一个 kind |
| `IntegrationPipelineRunSection.vue` | Save-only 勾选 + 「Save-only 推送」按钮对 K3 目标照常渲染 | 操作员点下去才在 403 处得知 |
| `errorCodeLabels.ts` | 三个 DISABLED 码未登记 | 撞上时状态条直出后端英文原文 |

同屏的 `IntegrationHubOverviewSection` 早已按后端 `writeCapability.notice` 显示「只读·永不写入」——**同一块屏幕上两种说法**。

## 2. 追到的调用链

**写禁令（只读，未改动）**

- `k3-external-write-permanent-fence.cjs`：闭合令牌 `K3_WISE_EXTERNAL_WRITE_DISABLED`；主体集合 `K3_EXTERNAL_WRITE_TARGET_KINDS = ['erp:k3-wise-webapi', 'erp:k3-wise-sqlserver']`（`Object.freeze`）；`isK3ExternalWriteTargetKind` 精确匹配。
- `pipeline-runner.cjs:448`：`K3_WISE_PIPELINE_RUN_DISABLED`，**只对 `erp:k3-wise-webapi` 且 `dryRun !== true`**；同函数下方对 `erp:k3-wise-sqlserver` 走永久令牌。这两个码是**同一场景的两种回答**，取决于 kind。
- `outbound-http-write-gate.cjs:149`：`OUTBOUND_HTTP_WRITE_DISABLED`（env 未配 = 能力关闭），另有 `OUTBOUND_HTTP_WRITE_TARGET_NOT_AUTHORIZED` / `OUTBOUND_HTTP_WRITE_ALLOWLIST_INVALID`；`GENERIC_HTTP_WRITE_KINDS = ['http']`。

**错误码到屏幕（本次接通）**

```
后端 envelope {ok:false, error:{code, message}}
  -> workbench.ts parseIntegrationResponse   <-- 原本在这里把 code 丢掉，只 throw new Error(message)
  -> executePipeline / dryRunExternalWrite / applyExternalWrite 的 catch
  -> setStatus(error.message)                 <-- 英文原文直出状态条
```

**目标 kind 到控件（本次接通）**

```
selectedTargetSystem.kind
  -> writeFence.ts isK3ExternalWriteTargetKind（新增，服务端集合的前端镜像）
  -> targetWriteFenced (computed)
  -> :target-write-fenced -> IntegrationPipelineRunSection 的 v-if
```

## 3. 决定

### 3.1 新增前端镜像 `apps/web/src/services/integration/writeFence.ts`

前端此前没有任何「哪些 kind 被写禁」的概念，只有散落的 `'erp:k3-wise-webapi'` 字面量（`IntegrationWorkbenchView.vue:1156/1167` 两处，都漏掉了 sqlserver 兄弟 kind）。新增一个**纯函数 + 常量**的叶子模块：

- 精确匹配，**不做前缀匹配**。前缀匹配会把服务端没禁的 K3 相邻 kind 也遮蔽掉——那等于镜像自己在定策略，是它唯一不能做的事。
- **方向单一**：这里只能「少渲染一个按钮」或「多一句只读说明」，不能开启、解锁或放宽任何写入。真正拦请求的仍然只有服务端四层栅栏。
- 漂移风险用测试封死，不靠自觉：`integrationErrorCodeLabels.spec.ts` `require` 服务端栅栏模块，两边集合不一致就红。

选择镜像而非拉取：这个判断驱动的是「不要渲染按钮」，必须在任何网络往返返回**之前**就正确，而且没有任何读接口能在 run 之前回答「这个 kind 是否被写禁」。

### 3.2 三个码进 `INTEGRATION_ERROR_CODE_LABELS`

新增一个 family（3 条），码表从 50 条变 53 条；帮助页 `/help/integration` 遍历该 map，自动出现（其 spec 断言行数 == `integrationErrorCodeEntries().length`，无需改数字）。

口径与 `services/integration/stockPreparation/plainLanguage.ts` 的 `STOCK_PREP_POSTURE_PLAIN.k3ExternalWrite` / `.outboundHttpWrite` 对齐，每条 hint 都点出**存在的补救路径**（导出 / 落多维表），而不是暗示有个开关可找。

`OUTBOUND_HTTP_WRITE_TARGET_NOT_AUTHORIZED` / `OUTBOUND_HTTP_WRITE_ALLOWLIST_INVALID` **不进**：那是部署侧 allowlist 的事实，面向运维日志，不是数据工厂操作员能处理的。

### 3.3 `parseIntegrationResponse` 把 code 带出来

原本 `throw new Error(message)`，code 被丢掉，所以前端根本没有查表的钥匙。改为抛 `IntegrationApiError extends Error`：

> **终审更正（F01，2026-09-10）**：信封顶层的 `error.code` **不一定是产品码**。`sendError` 经 `inferErrorCode`
> 回落 `error.name`，而 `PipelineRunnerError` 没有自己的 `.code` —— 它把码放在 `details.code`。所以
> `/run` 与死信重放的拒绝，顶层是**类名**。取码改由 `integrationEnvelopeErrorCode` 负责：details.code 只在顶层缺失或
> 顶层是类名形状（`/Error$/`，大小写敏感）时顶上，自带 `.code` 的错误类不受影响。详见验证记录 §7。

- `instanceof Error` 仍然成立，`error.message` **逐字节不变**——约 50 个既有调用点行为不动。
- code 是**附加元数据**，不放宽、不重派生、不洗 message；调用方拿不到响应里原本没有的任何东西。
- 配套导出 `integrationApiErrorCode(error)`：只有真的收到非空 code 的 `IntegrationApiError` 才回答非 null，绝不猜。

### 3.4 失败文案按 code 查表

新增视图内 `integrationFailureMessage(error)`，接在 `executePipeline`、`dryRunExternalWrite`、`applyExternalWrite` 三个写路径 catch 上：

- 命中已登记 code -> `label｜hint`（按 locale）。
- 未登记 code -> **退回原有 `error.message`**，不猜标签。这是收窄展示面，不是发明内容。

其余 23 处同形 catch 未改动：它们是读/配置路径，收不到这三个码，改了只会扩大与在飞 PR #5587 的冲突面。

### 3.5 K3 目标不渲染 Save-only

`IntegrationPipelineRunSection.vue` 新增 `targetWriteFenced: boolean` prop（父组件解析，子组件保持「无状态、无服务调用」契约）：

- 命中 -> 勾选框与「Save-only 推送」按钮**都不渲染**，替换为一行说明（复用 `K3_WRITE_FENCE_EXPLANATION.zh` 常量）。
- **不是 disabled**：禁用态读起来是「还不行」——像是某个权限或设置能打开的东西；而这是「永远不行」。同理去掉勾选框：为一个永远不会发生的推送征求同意不是一个值得提供的选择。
- 未命中 -> 与 G10 之前逐字节相同。
- **Dry-run 不受影响**（栅栏禁的是写，不是预览；砍掉预览是 §15.2 E4-05 的失败模式）。

> **终审补（F05，2026-09-10）**：同一处理也施加到 K3 预设页 `IntegrationK3WiseSetupView.vue` —— 初稿只改了它的口，
> 没动它的「执行物料」「执行 BOM」按钮和「允许真实执行 Pipeline」勾选，等于把工作台刚消除的矛盾原样搬到了另一页。
> 并且那页有自己的私有 `parseIntegrationResponse`（抛裸 `Error`），本 PR 的 `IntegrationApiError` 不流经它，
> 所以在它的 catch 上接人话化本来会是 no-op；副本已删除，改用 `workbench.ts` 的唯一实现。

## 4. 绝对断言的边界

按「保证型措辞先证伪」的要求，两句话被**显式收窄**：

- 「K3 目标永久只读、不写回」——这是绝对断言，且服务端四层栅栏真的在强制它，可以说。
- 「通用 HTTP 外发**默认关闭**」——**不能**说成「HTTP 目标只读」。`http` kind 确有 `upsert` 路径，只是被 `outbound-http-write-gate.cjs` 挡着；部署方在服务端 allowlist 里授权一个目标，它就会写。后端 `integration-hub-overview.cjs` 的能力册**明确拒绝**把 `http` 标成「只读」（标为 `unregistered`），前端文案不能越过它去承诺。

任务原文给的措辞是「K3 / 通用 HTTP 目标只读，不写回」，此处按上述理由改成分述。这是与派工文案的一处**有意偏离**。

## 5. 不动的东西

- `plugins/` 与 `packages/` 零改动——栅栏本身不碰。
- 未新增任何客户端写路径守卫去「代替」服务端栅栏：客户端隐藏按钮**不是**保证，只是不再欺骗操作员。真正的保证仍然只有那四层。
- 未放宽任何回退或作用域；`parseIntegrationResponse` 的失败判定条件一字未改。

## 6. 存疑 / 待确认

1. **`K3_WISE_PIPELINE_RUN_DISABLED` 没有被服务端导出**（`pipeline-runner.cjs` 的 `module.exports` 只有 4 项），所以它的镜像同步守卫只能退到对该文件的定向源码扫描。若后续允许改 `plugins/`，建议把它提成导出常量，再把守卫换成 `require`。
2. 三个码里 `OUTBOUND_HTTP_WRITE_DISABLED` 目前**没有确证的前端到达点**被本次接线覆盖：它可从 `externalSystemsTest`（连接测试）经 `request` operation 抛出，而那条路走 `formatWorkbenchConnectionError`（`IntegrationWorkbenchView.vue:1327` 一带），本次未改。登记它是为了帮助页与未来到达点，不是因为当前有 UI 消费。
3. `erp:k3-wise-sqlserver` 在 `pipeline-runner` 走的是永久令牌而不是 `K3_WISE_PIPELINE_RUN_DISABLED`；两个码的中文标签因此措辞不同（前者「已永久关闭」，后者「不能直接推送」），这是**故意**的，与服务端两条不同的消息保持同构。
