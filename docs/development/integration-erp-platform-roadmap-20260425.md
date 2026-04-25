# 通用 ERP 集成平台 · 路线图（Roadmap）

> 状态：**讨论稿，未列入交付**
> 出处：2026-04-25 团队对话「我们能做通用型的 ERP 对接平台么？K3 只是试验」
> 主笔：Claude（Sonnet 4.6, 1M context）+ 团队对话提取
> 目的：在 K3 WISE Live PoC 进入门槛前，把"是否走平台化"这个战略问题落到文字，避免日后用错精力或错失时机

---

## 1. 背景与问题

我们已经在 main 上交付了 `plugin-integration-core` 的 backend MVP（M0+M1+M2 mock 共 #1140-#1155 + #1162 + #1166 共 11 个 PR），当前正进入"K3 WISE 真客户测试账套 Live PoC"阶段。

业务侧提出疑问：**这套基建是不是只能服务于 K3？还是可以演化成一个通用的 ERP 集成平台？**

本文档的目标：基于代码现状给出**事实判断 + 阶段化路线 + 关键决策点**，让"是否走平台化"成为可量化讨论而非情绪决策。

---

## 2. 架构审计：现状有多通用？

### 2.1 已可复用 / vendor-agnostic 基础已具备

> **降级用语**：以下是 plugin-integration-core 内 vendor-agnostic 的基础设施，不代表"100% 通用"——尤其底层 Postgres/MySQL 适配器目前更多是**内核 data-adapters 资产**，尚未通过 plugin-integration-core 的 adapter contract 接入；HTTP adapter 是 plugin-local 的，可直接被 pipeline-runner 用作 source/target。

| 模块 | 文件位置（已合 main） | 复用性证据 |
|---|---|---|
| Adapter 契约 | `plugins/plugin-integration-core/lib/contracts.cjs` | 5 个方法 `testConnection / listObjects / getSchema / read / upsert` 与任何 ERP/PLM 无关 |
| Pipeline runner | `plugins/plugin-integration-core/lib/pipeline-runner.cjs` | 不知道 source/target 是谁；依赖注入 adapter 实例 |
| Transform engine | `plugins/plugin-integration-core/lib/transform-engine.cjs` | 内置变换（trim/upper/toNumber/toDate/dictMap 等）vendor 无关 |
| Validator | `plugins/plugin-integration-core/lib/validator.cjs` | required/pattern/enum/min/max/unique 通用规则 |
| Idempotency / watermark / dead-letter / run-log | `plugins/plugin-integration-core/lib/{idempotency,watermark,dead-letter,run-log}.cjs` | 全部 vendor 无关 |
| External system 注册表 + 凭据加密 | `plugins/plugin-integration-core/lib/external-systems.cjs` + `lib/credential-store.cjs` | tenant_id/workspace_id 已就绪；config JSONB 容纳任意 vendor 维度（K3 acctId、SAP CompanyCode、用友账套等） |
| REST control plane | `plugins/plugin-integration-core/lib/http-routes.cjs` | pipeline CRUD / run / dry-run / dead-letter / replay vendor 无关 |
| HTTP adapter（plugin-local） | `plugins/plugin-integration-core/lib/adapters/http-adapter.cjs` | REST 风格 ERP 可直接套配置 |
| Postgres / MySQL（**内核 data-adapters 资产**） | `packages/core-backend/src/data-adapters/{PostgresAdapter,MySQLAdapter}.ts` | 内核已有，但**未通过 plugin-integration-core adapter contract 接入**——直接库连接 ERP 时需补一层 plugin adapter 包装 |

**结论**：vendor-agnostic 底子已就位，不存在 K3 锁死。换 vendor 时，主要新增一个 **vendor adapter + vendor metadata 包**（包含 adapter 实现、vendor profile、错误字典、preflight rules、字段词典、测试 fixture、runbook 等——详见 `integration-vendor-abstraction-checklist-20260425.md`）。**注意**：不是只新增一个 adapter 文件就够。

### 2.2 K3 特有但易抽离（4-6 人天工作量）

| 特性 | 当前位置 | 抽离方向 |
|---|---|---|
| K3 WebAPI / SQL Server adapter | `lib/adapters/k3-wise-*.cjs` | 保持原样，作为 vendor 适配器实现之一即可 |
| 字段映射（FNumber/FName/FChildItems） | 用户配置（`fieldMappings.material/bom`） | 已经是 user-config，不在代码里 → 已通用 |
| Preflight intercept（autoSubmit/autoAudit/t_ICItem 黑名单） | `scripts/ops/integration-k3wise-live-poc-preflight.mjs` | 抽成"per-vendor preflight rules"配置；K3 是其中一份 |
| Submit/Audit 二段提交 | adapter 内硬编码 | 改成 `adapter.lifecycle: ['save', 'submit', 'audit']` 由 adapter 声明，runner 按声明执行 |
| K3 错误码 → 业务语义翻译 | adapter 内硬编码（部分） | 改成 vendor-scoped error dictionary（JSON 表） |

详见同目录 `integration-vendor-abstraction-checklist-20260425.md`。

### 2.3 需要新增的"平台化"工作（决定是否走平台化路线）

| 新工作 | 价值 | 工作量 |
|---|---|---|
| Vendor profile 注册中心（capabilities / 必填字段 / 安全规则 / 默认 mappings / 错误字典） | 让运维不写代码就能新增 vendor | 1-2 人周 |
| Adapter marketplace（插件包发现/安装/版本管理） | 第三方/客户工程师自己写 adapter，不用进 main 仓库 | 2-3 人周 |
| 可视化 Adapter Builder（无代码新建 vendor）：填 REST endpoint + auth 模式 + 字段路径 → 生成 adapter | 80% 是 REST 的 ERP 不需要写代码 | 3-4 人周 |
| Schema catalog / 字段词典 | 客户配置时不用查 K3 文档 | 2-3 人周（每家 vendor 1 人天填词典） |
| 多 ERP 同时连接 scope 隔离 | 已有 `tenant_id/workspace_id` 基础，pipeline 层加 vendor scope 标签 | 3-5 人天 |

---

## 3. ERP 覆盖优先级（中国市场视角）

按中国中型制造业市场覆盖，下面 6 家 ERP 覆盖 80%+：

| 优先级 | ERP | API 成熟度 | 接入工作量预估（在已有基建上） | 备注 |
|---|---|---|---|---|
| 1 | **K3 WISE** | 中（K3API + SQL Server） | 已完成 mock，PoC 中 | 当前主线 |
| 2 | **金蝶 K3 Cloud / 星空** | 高（REST + 签名） | 1-2 人周 | 同金蝶系，复用大量字段映射经验 |
| 3 | **用友 U8/U9** | 中（REST + token） | 2-3 人周 | 国内最大装机量之一 |
| 4 | **SAP S/4 HANA** | 高（OData / RFC / BAPI） | OData: 2-3 人周；RFC: 4-5 人周 | 大型/外企客户必备 |
| 5 | **用友 YonBIP** | 高（REST） | 2 人周 | 用友新平台，新客户增长快 |
| 6 | **鼎捷 / 浪潮 GS** | 中-低 | 3-4 人周 | 制造业垂直 |

**国外**（未来）：NetSuite / Oracle EBS / Dynamics 365 / Acumatica / Workday 各 2-4 人周。

---

## 4. 四阶段路线图

```
阶段一（现在 - 1 个月）·  K3 PoC 跑通
  目标：验证产品-市场契合度（PMF），不分散精力做平台化
  关键交付：K3 真客户测试账套 Live PoC PASS
  决策门槛：PoC PASS = 进入阶段二；FAIL = 修 K3 adapter 不开新战线

阶段二（1-3 个月）· 抽离 + 第 2 家 ERP
  目标：用真实复用证明"通用"不是 PPT
  关键交付：
    1. 完成 §2.2 抽离工作（4-6 人天，详见 vendor-abstraction-checklist）
    2. 接 1 家 ERP 验证可复用性（推荐金蝶云星空 或 用友 U8，按客户需求选）
    3. 第 2 家 ERP 的接入时间应 ≤ 3 周（如果 ≥ 4 周说明抽离不够好，回流改）
  决策门槛：第 2 家 ≤ 3 周成功 = 进入阶段三；否则回流抽离

阶段三（3-6 个月）· 平台化基建
  目标：让"通用 ERP 集成平台"作为正式产品定位成立
  关键交付：
    1. Vendor profile 注册中心（§2.3）
    2. Schema catalog（先填阶段二的 2 家 + 阶段三新增 1-2 家共 3-4 家）
    3. 简单的 Adapter Builder（先支持 REST + Bearer/Basic auth）
  决策门槛：基建上线 + 客户成功故事 ≥ 3 家 = 进入阶段四

阶段四（6 个月+）· Marketplace + SaaS
  目标：生态 + 商业化
  关键交付：
    1. Adapter marketplace（让 SI/客户上传第三方 adapter）
    2. 多租户 SaaS 模式
    3. 国外 ERP 选择性进入
```

---

## 5. 关键风险

| 风险 | 表现 | 缓解 |
|---|---|---|
| **过度工程**（最大风险） | K3 PoC 还没过就投入平台化，结果客户没买单，平台化沉没成本巨大 | 阶段一锁定不开新战线；任何"K3 之外"的工作必须等 PoC PASS 才启动 |
| **Vendor 长尾陷阱** | 看似 80/20 实际是 20/80：每接一家 ERP 维护成本上升，国内 ERP 版本碎片严重 | 阶段二只接 1 家，证明 ROI 后才扩展；自我设限"每季度最多 1 家新 ERP" |
| **Schema 版本漂移** | K3 WISE 15 vs K3 WISE 14 字段差异；用友 U8 v15 vs v17 | Vendor profile 中心引入 `vendor.version` 字段；mappings 按版本绑定 |
| **认证方式异构爆炸** | OAuth2 / SAP login ticket / Oracle SSWS / 用友 token / NetSuite TBA / SAP Ariba SOAP-WSSE | 阶段三 Adapter Builder 优先支持 top 5 auth 模式；其他走 vendor adapter 自定义 |
| **Adapter 质量参差** | 一旦开了 marketplace，第三方 adapter 出故障会反噬平台口碑 | 阶段四前不开 marketplace；阶段四引入 adapter 认证机制（自动测试 + 评级） |
| **K3 PoC 客户拖延** | 客户 GATE 答卷迟迟不回，整个进度卡住 | 客户答卷与平台化路线解耦：阶段一可同步做内核打磨（不动 K3 PoC 路径），但不投入平台化代码 |

---

## 6. 决策清单（团队定期回顾）

每月 review 一次以下问题，决定是否进入下一阶段：

| 决策点 | 问题 | 当前状态（2026-04-25） |
|---|---|---|
| D1 | K3 PoC 是否 PASS？ | 等客户 GATE 答卷 |
| D2 | 第 2 家 ERP 是哪家？是否有真实客户需求？ | 未确定 |
| D3 | 第 2 家 ERP 的接入是否 ≤ 3 周完成？ | N/A |
| D4 | 是否已有 ≥ 3 家成功案例？ | N/A |
| D5 | 是否准备好承担 marketplace 的运营成本（adapter 审核 / 评级 / 支持）？ | N/A |

---

## 7. 文档关系

- 本文（roadmap）：战略层
- 同日 `integration-vendor-abstraction-checklist-20260425.md`：阶段二抽离工作的具体 task list
- 已有 `integration-core-k3wise-live-poc-design-20260425.md` + `*-verification-20260425.md`：阶段一执行
- 已合 main · K3 PoC 运行手册（#1155）：
  - 本体：`packages/core-backend/claudedocs/integration-plm-k3wise-mvp.md`（703 行 runbook）
  - 设计：`docs/development/integration-plm-k3wise-mvp-runbook-design-20260424.md`
  - 验收：`docs/development/integration-plm-k3wise-mvp-runbook-verification-20260424.md`

---

## 8. 一句话总结

> **架构上是通用的，K3 只占 `lib/adapters/` 里两个 vendor 文件 + 一份 preflight 脚本。不存在 K3 锁死风险。**
>
> **但"通用 ERP 集成平台"作为产品定位，需要再投 2-3 个月做平台化基建（vendor profile / schema catalog / adapter builder）才成立。**
>
> **建议节奏**：K3 PoC PASS → 抽离 4-6 人天 → 接第 2 家 ERP 实证 → 再决定是否投平台化基建。
