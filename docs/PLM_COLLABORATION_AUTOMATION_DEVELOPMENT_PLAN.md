# PLM Collaboration And Automation Edition — MetaSheet 实现依赖说明（引用）

> **这是一份短引用，不是计划正文。** 完整的产品计划与 gated TODO 归属
> **Yuantus PLM 产品仓库**（真源），勿在此复制正文以免双份维护。

## 主文档（真源）

`yuantus-plm:docs/development/plm-collaboration-automation-development-plan-20260602.md`

产品归属：**Yuantus 是 PLM 产品真源与主文档归属**；**MetaSheet2 是多维协作、审批自动化、
授权能力的实现依赖**。该升级版的能力在 PLM 场景内呈现，但底层能力跑在 MetaSheet 侧。

## MetaSheet2 侧的实现关注点

升级版能力依赖本仓库以下模块（详细接缝/file:line 见主文档 §5.2）：

- **多维表 provisioning**：`packages/core-backend/src/multitable/`（base/sheet/field/record API、`MultitableEmbedHost.vue` 嵌入壳）—— 用于按 PLM 对象生成协作表/视图。
- **approval bridge**：`packages/core-backend/src/services/ApprovalBridgeService.ts` + `routes/approvals.ts`（`/actions` 回写 PLM，PLM=SoT；**勿用 legacy `/approve`、`/reject`**）。
- **automation service**：`packages/core-backend/src/multitable/automation-*.ts`（触发器/动作；钉钉投递、send_webhook、催办、建跟进项、锁记录）。
- **feature entitlement**：前端 route `requiredFeature` 信号 → 扩展为更细的 feature guard（授权数据模型主源在 Yuantus，见主文档 §6 / §5.4）。
- **PLM federation connector**：`packages/core-backend/src/data-adapters/PLMAdapter.ts` + `routes/federation.ts`（Yuantus PLM API 桥接）。

## 状态

引用文档，不含计划正文。任何实现按主文档的 gated Phase 逐次独立 opt-in；本文件不授权实现。
