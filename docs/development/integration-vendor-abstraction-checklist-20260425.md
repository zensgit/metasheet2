# Vendor 抽离 Checklist · 阶段二准备工作

> 状态：**讨论稿，未列入交付**
> 出处：2026-04-25 团队对话
> 配套：`integration-erp-platform-roadmap-20260425.md` § 2.2 + § 4 阶段二
> 触发条件：**K3 WISE Live PoC PASS 之后才启动**；PoC 结果尚未 PASS 时不要开工，避免基于错误经验做抽象

---

## 0. 背景与原则

K3 WISE Live PoC 完成后，第一件事是**做一次有限抽离**——把当前与 K3 强耦合的 5 处代码拆成"vendor-agnostic 框架 + per-vendor 配置"。这是阶段二接入第 2 家 ERP（金蝶云星空 / 用友 U8 等）的前置条件。

**总工作量**：4-6 人天（不含第 2 家 ERP 自身的 adapter 编写）
**前置依赖**：K3 PoC PASS（否则可能基于错误的 K3 经验做抽象）
**禁忌**：不要在抽离同时引入新 vendor；先抽再接，证明抽对了再扩展

---

## 1. 五项任务总览

| ID | 任务 | 文件位置 | 工作量 | 验收 |
|---|---|---|---|---|
| **VA-T01** | Per-vendor preflight rules 抽离 | `scripts/ops/integration-k3wise-live-poc-preflight.mjs` → 拆基座 + per-vendor rules | 1.5 人天 | K3 rules 单独一份；新增空 SAP rules 文件能通过 lint |
| **VA-T02** | Adapter lifecycle 声明化 | `lib/contracts.cjs` + `lib/pipeline-runner.cjs` + `lib/adapters/*` | 2 人天 | adapter 通过 `getLifecycle()` 声明 `['save','submit','audit']`；runner 按声明执行；K3 行为不变 |
| **VA-T03** | Vendor-scoped error dictionary | 新建 `lib/error-dictionary/{k3-wise,sap,...}.cjs` + `lib/error-translator.cjs` | 1 人天 | K3 错误码 → 业务语义映射从 adapter 抽出；adapter 拒绝 hardcode error 翻译 |
| **VA-T04** | Vendor profile 元数据（轻量版） | 新建 `lib/vendor-profiles/index.cjs` + 每家 vendor 一份 JSON | 1 人天 | profile 包含 vendor name、version、capabilities、required config keys、default safety rules；K3 profile 完整、SAP profile 占位 |
| **VA-T05** | 抽象后的 contract 兼容性回归 | 全套 `__tests__/`（特别是 e2e-plm-k3wise-writeback） | 0.5 人天 | 所有现有测试不动通过；新增"vendor-agnostic contract"测试 |

---

## 2. VA-T01 · Per-vendor preflight rules 抽离

### 现状

`scripts/ops/integration-k3wise-live-poc-preflight.mjs` 里 K3 安全规则是硬编码：

```js
const NON_PRODUCTION_ENVS = new Set([...])
const K3_CORE_TABLES = new Set(['t_icitem', 't_icbom', 't_icbomchild'])
// ... if (k3Wise.autoSubmit === true || k3Wise.autoAudit === true) ...
```

### 目标结构

```
scripts/ops/
├── integration-live-poc-preflight.mjs               (基座，vendor 无关)
└── live-poc-preflight-rules/
    ├── k3-wise.mjs                                  (K3 核心表黑名单 / autoSubmit/autoAudit / Save-only)
    ├── sap-s4.mjs                                   (占位：BAPI 危险列表 / RFC 角色)
    ├── kingdee-cloud.mjs                            (占位：星空特有规则)
    └── yonyou-u8.mjs                                (占位)
```

每份 `*.mjs` 导出统一 shape：

```js
export default {
  vendor: 'k3-wise',
  requiredConfigKeys: ['version', 'apiUrl', 'acctId', 'environment'],
  intercepts: [
    { id: 'k3-no-prod', test: (cfg) => !NON_PRODUCTION_ENVS.has(cfg.environment), msg: '...' },
    { id: 'k3-save-only', test: (cfg) => cfg.autoSubmit !== true && cfg.autoAudit !== true, msg: '...' },
    { id: 'k3-no-core-table-write', test: (cfg) => !overlapsCoreTable(cfg), msg: '...' },
  ],
  defaultLifecycle: ['save'],   // 不开 submit/audit
}
```

基座脚本 `integration-live-poc-preflight.mjs` 根据 `gate.targetVendor` 字段动态加载对应 rules。

### 验收

- [ ] K3 现有 8 个 preflight 测试不变通过
- [ ] 创建空 `sap-s4.mjs`（只有 schema，没有 intercept），基座加载不报错
- [ ] CLI 传 `--vendor=k3-wise` / `--vendor=sap-s4` 切换 rule set
- [ ] 文档 `docs/development/integration-vendor-preflight-spec-*.md` 描述 rules 文件 schema

---

## 3. VA-T02 · Adapter lifecycle 声明化

### 现状

K3 的 Save → Submit → Audit 三段式硬编码在 K3 adapter 里；其他 vendor 没有这个概念，runner 不能区分。

### 目标（**第一版 optional，不破坏现有契约**）

在 `IExternalSystemAdapter` 契约新增 `getLifecycle()` 方法 ——**第一版作为 optional**，向后兼容：

- adapter 实现了 `getLifecycle()` → runner 按声明阶段执行
- adapter 没实现 → runner fallback 到当前 `upsert()` 单步行为
- K3 adapter 这一步**不强制重写**，行为完全不变

```js
// K3 WISE adapter（可选迁移）
getLifecycle() {
  return ['save', 'submit', 'audit']  // 三段
}
// SAP S/4 adapter（可选迁移）
getLifecycle() {
  return ['create']                   // 单段
}
// Yonyou U8 adapter（可选迁移）
getLifecycle() {
  return ['save', 'verify']           // 二段
}
// 任何未实现 getLifecycle() 的 adapter
// → runner 走老路径 adapter.upsert()，不进 lifecycle 分支
```

Pipeline runner 在配置侧也是可选：

```js
// pipeline.options（仅当 adapter 暴露了 getLifecycle 时有意义）
{
  lifecycleStages: {
    save:   { enabled: true },
    submit: { enabled: false },         // 默认 false（PoC Save-only）
    audit:  { enabled: false }
  }
}
```

### 改动文件

| 文件 | 改动 |
|---|---|
| `plugins/plugin-integration-core/lib/contracts.cjs` | `IExternalSystemAdapter` 加 `getLifecycle()` **可选**方法（注释明确"未实现则 fallback 到 upsert"） |
| `plugins/plugin-integration-core/lib/pipeline-runner.cjs` | runner 检测 `typeof adapter.getLifecycle === 'function'`：有则按声明执行 + 查 `pipeline.options.lifecycleStages[name].enabled`；无则走原 `adapter.upsert()` 路径 |
| `plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs` | **第一版不动**——继续走 upsert 单步路径，behavioral parity；M2 K3 PoC PASS 后再决定是否拆 lifecycle.save/submit/audit |
| `plugins/plugin-integration-core/lib/adapters/http-adapter.cjs` | **第一版不动** |
| `plugins/plugin-integration-core/lib/adapters/plm-yuantus-wrapper.cjs` | **第一版不动**（source-only adapter） |
| `plugins/plugin-integration-core/__tests__/pipeline-runner.test.cjs` | 新增"adapter 暴露 lifecycle 时按声明阶段执行"测试 + "未暴露 lifecycle 时走 upsert"回归测试 |

### 验收

- [ ] **K3 adapter 的现有 Save-only PoC 行为完全不变**（adapter 不动 = behavior 不动）
- [ ] 新增 "lifecycle-aware adapter 路径" 测试通过：用一个 mock adapter 暴露 `getLifecycle()=['save','submit']`，runner 调用两阶段
- [ ] 新增 "lifecycle-unaware adapter 路径" 回归测试：用一个 mock adapter **不**暴露 `getLifecycle()`，runner 仍走 `upsert()`
- [ ] e2e-plm-k3wise-writeback 测试不动通过（K3 adapter 没改，行为没变）
- [ ] 所有现有 adapter 测试不动通过

---

## 4. VA-T03 · Vendor-scoped error dictionary

### 现状

K3 错误码翻译散在 K3 adapter 和 ERP feedback writeback 里；其他 vendor 接入时要翻一遍源码找翻译点。

### 目标结构

```
plugins/plugin-integration-core/lib/error-dictionary/
├── index.cjs                  (loader：按 vendor 加载)
├── k3-wise.json               (K3 错误码 → 业务语义)
├── sap-s4.json                (占位)
├── kingdee-cloud.json         (占位)
└── yonyou-u8.json             (占位)
```

`k3-wise.json` 形态示例：

```json
{
  "vendor": "k3-wise",
  "version": "1.0",
  "errors": {
    "K3_E_CONNECTION_TIMEOUT":     { "category": "transient",  "retry": true,  "userMsg": "K3 服务器响应超时，自动重试中..." },
    "K3_E_AUTH_EXPIRED":           { "category": "auth",       "retry": false, "userMsg": "K3 登录会话过期，需重新登录" },
    "K3_E_FNUMBER_DUPLICATE":      { "category": "validation", "retry": false, "userMsg": "物料编码已存在，请检查 FNumber 唯一性" },
    "K3_E_FBASE_UNIT_NOT_FOUND":   { "category": "data",       "retry": false, "userMsg": "K3 计量单位字典未找到，请补全 dictMap.unit 配置" }
  }
}
```

### 改动文件

| 文件 | 改动 |
|---|---|
| 新建 `plugins/plugin-integration-core/lib/error-dictionary/index.cjs` | `loadDictionary(vendor)` + `translateError(vendor, code, ctx)` |
| 新建 `plugins/plugin-integration-core/lib/error-dictionary/k3-wise.json` | 把现有 K3 错误码迁过来 |
| `plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs` | 删除 hardcode 翻译，改调 `translateError('k3-wise', code, ctx)` |
| `plugins/plugin-integration-core/lib/erp-feedback.cjs` | 同上 |

### 验收

> **说明**：adapter 仍然需要**产生**原生 vendor 错误码（这是数据，不是翻译）。本任务的目标是确保**用户可见的错误翻译**统一走字典，而不是散落各处。

- [ ] K3 现有 ERP feedback 测试不变通过
- [ ] **用户可见错误翻译统一走 error dictionary**——`grep -rn '"用户可见错误信息文本"' plugins/plugin-integration-core/lib/adapters/ lib/erp-feedback.cjs` 不应找到散落的中文/英文错误描述（adapter 仍然返回 vendor code 是允许的）
- [ ] `translateError('unknown-vendor', code, ctx)` 返回安全的 fallback（不抛错；返回 `{category: 'unknown', userMsg: <vendor code 原样>, retry: false}`）
- [ ] `translateError('k3-wise', '<未知 K3 错误码>', ctx)` 同样 fallback 不抛错
- [ ] 新增 SAP / 用友 / 金蝶云的空字典加载不报错
- [ ] 字典覆盖率指标可观测——新增脚本或测试，输出"K3 字典覆盖了多少 K3 已知错误码"，便于后续补全

---

## 5. VA-T04 · Vendor profile 元数据（轻量版）

### 目标

每家 vendor 一份 metadata JSON，描述 vendor 的"指纹"：

```
plugins/plugin-integration-core/lib/vendor-profiles/
├── index.cjs              (loader)
├── k3-wise.json
├── sap-s4.json
├── kingdee-cloud.json
└── yonyou-u8.json
```

`k3-wise.json` 完整示例（其他先占位）：

```json
{
  "vendor": "k3-wise",
  "displayName": "金蝶 K3 WISE",
  "version": "15.x / 14.x",
  "capabilities": {
    "objects": ["material", "bom", "purchase-order", "sales-order"],
    "writeProtocol": ["webapi", "sql-server"],
    "readProtocol":  ["webapi", "sql-server"],
    "auth":          ["acctId+username+password"]
  },
  "requiredConfigKeys": ["version", "apiUrl", "acctId", "environment"],
  "lifecycle": ["save", "submit", "audit"],
  "defaultSafety": {
    "saveOnly":             true,
    "blockProductionEnvs":  true,
    "blockCoreTables":      ["t_ICItem", "t_ICBOM", "t_ICBomChild"]
  },
  "defaultMappings": {
    "material": [
      { "sourceField": "code", "targetField": "FNumber" },
      { "sourceField": "name", "targetField": "FName" }
    ]
  }
}
```

### 改动文件

| 文件 | 改动 |
|---|---|
| 新建 `plugins/plugin-integration-core/lib/vendor-profiles/index.cjs` | `loadProfile(vendor)`、`listProfiles()`、`validateAgainstProfile(vendor, config)` 返回 `{ ok, missing, extra }`，**不抛错** |
| 新建 `plugins/plugin-integration-core/lib/vendor-profiles/k3-wise.json` | 完整填 |
| 新建 `plugins/plugin-integration-core/lib/vendor-profiles/{sap-s4,kingdee-cloud,yonyou-u8}.json` | 占位 |
| `plugins/plugin-integration-core/lib/external-systems.cjs` | **draft 不强校验**——`upsertExternalSystem` 入库总是允许；只在以下三个 critical 阶段强校验 `requiredConfigKeys`： <br>1. `status` 从其他状态过渡到 `active` 时（要把 system 标记为可用必须满足完整配置） <br>2. `testConnection(systemId)` 调用时 <br>3. `runPipeline(pipelineId)` 触发时（如果 pipeline 引用的 system 不完整，run 拒绝启动并落入 dead-letter） |
| `plugins/plugin-integration-core/lib/http-routes.cjs` | 把上述 3 个 critical 阶段的校验失败映射成清晰的 4xx 错误（含 missing keys 列表），便于前端引导用户补全 |

### 验收

- [ ] `loadProfile('k3-wise')` 返回完整 profile
- [ ] `loadProfile('sap-s4')` 返回占位 profile（不抛错，返回 `{ vendor: 'sap-s4', placeholder: true }`）
- [ ] `listProfiles()` 返回 4 项
- [ ] **draft 路径**：`upsertExternalSystem({ status: 'inactive', config: {} })` 应**成功**入库（保留草稿能力）
- [ ] **active 路径**：`upsertExternalSystem({ status: 'active', config: {} })` 应**失败**并返回缺失字段列表（kind=k3-wise 时缺 version/apiUrl/acctId/environment）
- [ ] **testConnection 路径**：对状态 active 但仍缺字段的 system 调用 testConnection 应返回 4xx 含 missing keys
- [ ] **runPipeline 路径**：pipeline 引用配置不完整的 source/target system，run 应被拒并写入 dead-letter（错误类别：`invalid-system-config`）
- [ ] **现有所有未引入 vendor profile 的测试不变通过**（向后兼容）

---

## 6. VA-T05 · 抽象后的 contract 兼容性回归

### 目标

确保 VA-T01-T04 完成后：
1. 所有现有测试不动通过
2. K3 实际行为不变
3. 新增"vendor-agnostic contract"测试，断言基座层不知道任何 vendor 名称

### 改动文件

| 文件 | 改动 |
|---|---|
| 新建 `plugins/plugin-integration-core/__tests__/vendor-agnostic-contract.test.cjs` | grep 检查 `lib/pipeline-runner.cjs` / `lib/contracts.cjs` 不包含 `'k3-wise'` / `'sap'` 等 vendor 字符串；遍历 vendor profiles 确认基座可热加载 |
| 全套 `__tests__/*.cjs` | 不动，跑一遍 `pnpm -F plugin-integration-core test` |
| `scripts/ops/integration-k3wise-live-poc-preflight.mjs` test 套 | 适应基座+rules 拆分后的入口 |

### 验收

- [ ] `pnpm -F plugin-integration-core test` 全绿
- [ ] `pnpm -F plugin-integration-core test:e2e-plm-k3wise-writeback` 不变通过
- [ ] 新增的 vendor-agnostic-contract 测试通过

---

## 7. 实施顺序与时间表（K3 PoC PASS 后启动）

```
Day 1   (1.5d) · VA-T01 preflight rules 拆基座
Day 2-3 (2.0d) · VA-T02 adapter lifecycle 声明化（最难，影响 runner）
Day 3   (1.0d) · VA-T03 error dictionary
Day 4   (1.0d) · VA-T04 vendor profile 元数据
Day 5   (0.5d) · VA-T05 兼容性回归 + 全套测试 + commit + PR
```

**总计 6 人天**（含测试、文档、PR review buffer）。

---

## 8. 完成定义（DoD）

- [ ] 5 个 PR 全部合到 main（每个 task 一个 PR，按 #1140-1155 的节奏）
- [ ] `pnpm -F plugin-integration-core test` 全绿
- [ ] `pnpm validate:plugins` 全绿
- [ ] 新增 vendor profile 4 份（K3 完整 + SAP/金蝶云/用友 U8 占位）
- [ ] 抽离后的 K3 PoC 行为不变（重跑一次 K3 测试账套 dry-run）
- [ ] 文档：本 checklist 上每项打勾 + 更新 `integration-erp-platform-roadmap-20260425.md` 阶段二状态

---

## 9. 不在本期范围（推到阶段三+）

- 多 ERP 同时连接的 scope 隔离（runtime-level）
- Adapter marketplace
- 可视化 Adapter Builder
- Schema catalog 完整填充
- 第 2 家 ERP 真实接入（这是阶段二 §3 的下一步）

---

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 抽象层引入意外行为变化 | VA-T05 全套回归 + 在客户测试账套上重跑一次 K3 dry-run |
| Adapter lifecycle 抽象过早，发现 SAP 不适配 | 阶段二接 SAP/金蝶云时如发现 lifecycle 模型不够，再扩展（YAGNI 原则） |
| Error dictionary 扁平 JSON 不够表达复杂场景 | v1 用 JSON；v2 必要时升级到 JS 函数（每条 error 一个 handler） |
| 6 人天估计偏低 | 如果某 task 卡住超过预算 2 倍，stop 并 review 是否需要分 PR |
