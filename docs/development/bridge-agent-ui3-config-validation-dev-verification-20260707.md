# BA-UI-3 — Bridge Agent 配置校验 + 变更建议清单 · 开发/验证报告 — 2026-07-07

> Design-lock: `docs/development/bridge-agent-admin-page-design-lock-20260707.md`(#3792,RATIFIED;
> owner granted the FULL BA-UI ladder 2026-07-07)§3 BA-UI-3。前置:BA-UI-1 = #3824
> (`bridge-agent-ui1-observability-dev-verification-20260707.md`)、BA-UI-2 = #3840
> (`bridge-agent-ui2-probe-dev-verification-20260707.md`)。Demand anchor:#3746(保持 OPEN)。
> 本片 = 只读校验 + 变更**建议**清单:零受控 apply、零后端写路径、零本机 config 编辑、零 .ps1 调用
> (lock §3:"受控落地,不做前端直改" — 任何真正的变更由受控后端或既有运维脚本落地，本页只生成人读的
> 建议文本)。

## 1. 范围与做法(vs lock §3 BA-UI-3 逐条)

| lock §3 BA-UI-3 条款 | 实现 |
| --- | --- |
| 校验必填/limits/auth mode/localhost-proxy 边界/raw-SQL 禁止/对象 allowlist 完整性 | 纯 util `computeBridgeAgentConfigCheck()`,固定 6 项、固定顺序,见 §2 契约表 |
| 新增对象/字段映射生成"变更建议" | 纯 util `buildBridgeAgentChangeSuggestion()`,操作员输入对象名+字段名(仅名称)→ 生成可复制文本 |
| 管理员确认后由后端或 .ps1 应用 | 本片没有任何 apply/write 调用;生成的文本是给人读的实施清单,不经过任何 API |
| values-free:reasons 是 coarse enum/label,不回显配置值 | 每项 `{id, status, labelKey}`;`labelKey` 是固定字符串查表结果,从不插值任何 config 值 |

## 2. 配置校验契约(`apps/web/src/services/integration/bridgeAgentConfigCheck.ts`)

`computeBridgeAgentConfigCheck({ config, objectNames })` 返回固定 6 项、固定顺序数组:

| id | 检查内容 | pass | warn | fail | values-free 理由来源 |
| --- | --- | --- | --- | --- | --- |
| `requiredFields` | `config.baseUrl` / `bridgeUrl` / `url` 之一为非空字符串 | 存在 | — | 都不存在 | 只测存在性,从不回显该字符串 |
| `limits` | `sampleLimit`/`maxLimit`(镜像 adapter 的 `normalizeLimits`:默认 3/20,上限 500) | 未配置(用默认值)或配置且合理 | — | 配置了但形状无效(非正整数)、`sample>max`、或 `max>500` | 只测数值关系,从不回显具体数字 |
| `authMode` | `config.authMode` 是否为非空字符串 | 已声明(不论其值) | 未声明 | — | 只测"是否声明"这个布尔,从不回显 `authMode` 的实际值 |
| `localhostBoundary` | 解析 `baseUrl`/`bridgeUrl`/`url` 的 hostname 是否 127.0.0.1/localhost/::1 形状 | 回环地址 | 缺少地址,无法核实 | 存在但不是回环地址(含解析失败) | `new URL()` 解析结果只产出一个布尔,解析出的 host 从不进入任何输出字段 |
| `rawSqlForbidden` | `config` 顶层或 `config.options` 下是否出现 `sql`/`rawSql`/`rawSQL`/`queryText`/`statement` 键(镜像 adapter 的 `RAW_SQL_KEYS`) | 未出现 | — | 出现任一键 | 只测键名是否存在,从不回显键值 |
| `objectAllowlist` | 给定 `/objects` 已返回的对象名(BA-UI-1 已在消费),是否覆盖 material / bom / bom_child 风格(大小写/前缀不敏感的 token 匹配) | 三个 token 都命中 | allowlist 为空,或部分缺失 | — (advisory,非硬性 gate) | 只输出闭集 label,从不回显具体对象名列表 |

**为什么 `rawSqlForbidden` 不检查 adapter 的 `guardrails.read.noRawSql`**:那个标志是
`bridge:legacy-sql-readonly` 这个 kind 的**结构性常量**(每个实例恒为 `true`),对单个系统没有区分度;
本检查项改为对**该系统自己的 config** 做卫生检查——是否有人往 config 里加了看起来像 raw SQL 的键,这是
一个真正逐系统可能不同的信号。

**为什么 `objectAllowlist` 从不判 `fail`**:这是一个 advisory 完整性提示,不是硬性验收门——一个只暴露
`material` 的 bridge 并不是"错误配置",只是可能还没暴露 BOM 相关对象;该项因此止步于 `warn`,由管理员
自行决定是否通过下方的建议清单卡扩展。

**为什么 `authMode` 缺失只是 `warn` 不是 `fail`**:BA-M1 adapter 在 `authMode` 缺失时仍会尝试从
`config.sharedSecretEnvVar`/credentials 解析共享密钥(非 `'none'` 才尝试),缺失声明不代表连接必然不安全,
只是意味着这个选择是隐式的——值得管理员留意,不构成失败。

值域完全固定(`BridgeAgentConfigCheckLabelKey` 14 个 key、`BridgeAgentConfigCheckItemId` 6 个 id),
`bridgeAgentConfigCheckLabel(labelKey, locale)` 是纯查表(同 `errorCodeLabels.ts`/`fieldHints.ts` 的
exact-key 纪律),没有任何字符串插值路径能把 config 值带进输出。

组件卡片(`bridge-agent-config-check` / `bridge-agent-config-check-list` /
`bridge-agent-config-check-item-<id>`)完全**派生自已有状态**——当前选中实例的 `system.config` +
已加载的 `objects`(BA-UI-1/BA-UI-2 已在维护的响应式状态)——**零新增网络请求**。

## 3. 变更建议(change-suggestion)契约

`buildBridgeAgentChangeSuggestion(drafts, locale, targetLabel?)`:

- 输入:`drafts: { objectName: string, fieldKeys: string[] }[]` —— **操作员在页面上手动键入**的"想新增
  暴露的对象名 + 字段名"(仅名称,不涉及任何取值);`targetLabel`(可选)是当前选中实例的 `system.name`
  (纯展示性文档头,BA-UI-1 已在别处无脱敏地展示这个名字,不是新的暴露面)。
- 校验:每个候选名称必须匹配安全标识符正则 `/^[A-Za-z_][A-Za-z0-9_]*$/` 且长度 ≤ 64(镜像
  `bridge-agent-readonly-adapter.cjs` 的 `SAFE_OBJECT_NAME_PATTERN`)。不匹配的名称(空白裁剪后)——
  典型地包括任何含 `=`/`;`/`:`/`.`/空白的字符串,也就是密钥、连接串、host 几乎必然具备的形状——
  **被丢弃,只计数(`invalidObjectCount`/`invalidFieldKeyCount`),从不回显原始字符串**。对象名不合法时,
  整条 draft 被跳过(不会出现"半条"记录)。
- 输出:`{ entries, invalidObjectCount, invalidFieldKeyCount, text }`。`text` 是双语(随 `locale`)、
  可直接复制的纯文本"变更建议 / 实施清单",按顺序列出每个有效对象 + 其有效字段名(逗号分隔),末尾附
  "已忽略 N 个不符合标识符格式的对象/字段名"提示(数量,而非内容)。
- 应用面:本 util **不调用任何 apply/write 接口,不写本机 config,不触发 .ps1**——`text` 仅供人工复制后
  交给受控后端或 `scripts/ops/bridge-agent-readonly.ps1`(lock §3 原文:"由受控后端或运维脚本应用")。

组件卡片(`bridge-agent-suggestion-builder`)提供加行/删行的草稿表单(`bridge-agent-suggestion-row-<i>`
+ `bridge-agent-suggestion-object-<i>` / `bridge-agent-suggestion-fields-<i>`)、一个只读 `<textarea
data-testid="bridge-agent-suggestion-text">` 展示生成的文本、以及一个"复制建议文本"按钮
(`navigator.clipboard.writeText`,失败时显示 values-free 的失败提示,永不抛出)。零有效条目时渲染
IU-6 what+first-step 引导态(`bridge-agent-suggestion-empty` / `-empty-what` / `-empty-first-step`),
而不是空文本框。

## 4. 无 apply / 无写路径确认(vs lock §3 / §2.1)

| 检查点 | 状态 | 证据 |
| --- | --- | --- |
| 无新增网络请求(校验卡) | ✅ | `computeBridgeAgentConfigCheck` 输入完全来自已有 `system`/`objects` 响应式状态;spec 断言渲染前后 `apiFetchMock` 调用集合不变 |
| 无 apply 端点调用(建议卡) | ✅ | 组件 import 面无任何新 service 函数;`buildBridgeAgentChangeSuggestion` 是纯函数,无 `fetch`/`apiFetch` |
| 无本机 config 写、无 .ps1 调用 | ✅ | 全仓搜索确认本片改动零涉及 `scripts/ops/bridge-agent-readonly.ps1`、零新增/编辑任何 upsert/write service |
| 无凭据/host/连接串/token 回显(校验卡) | ✅ | `labelKey` 查表结果为固定字符串,§6 SENTINEL 测试覆盖 |
| 无凭据/host/连接串/token 回显(建议卡) | ✅ | 安全标识符正则过滤操作员输入;§6 SENTINEL 测试覆盖(草稿输入侧) |
| raw SQL 编辑器仍不存在 | ✅ | 建议卡的输入是"对象名 + 逗号分隔字段名"文本框,不是 SQL/查询编辑器;不产生任何可执行语句 |

## 5. 测试矩阵

| 面 | 文件 | 数量 | Node 25(默认) | Node 20(nvm,CI 同版) |
| --- | --- | --- | --- | --- |
| 纯 util(校验 6 项分支 + 建议构建 + 两个 SENTINEL + label map 值域扫描) | `apps/web/tests/bridgeAgentConfigCheck.spec.ts` | 65 | ✅ | ✅(随整组一起跑,见下) |
| 组件(校验卡渲染/分支 + 建议卡渲染/加删行/复制/SENTINEL ×2 + zh) | `apps/web/tests/IntegrationBridgeAgentSection.spec.ts` | 26(BA-UI-1 10 + BA-UI-2 6 + BA-UI-3 10) | ✅ | ✅ |
| integration-guard 全 29 文件列表(新增 `bridgeAgentConfigCheck` 到 run 行) | 见 `.github/workflows/integration-guard.yml` | 363 | ✅ 363/363 | ✅ 363/363 |
| `ui-foundation-style-guard`(未新增 .vue,TARGET_FILES 无需改动) | `apps/web/tests/ui-foundation-style-guard.spec.ts` | 81 | ✅ | —(纯 fs 扫描,版本无关) |
| `pnpm --filter plugin-integration-core test`(本片零后端改动,仍随 CI 一起跑) | — | 全绿 | ✅ | ✅ |
| `vue-tsc -b` | — | — | ✅ clean | — |
| `pnpm --filter @metasheet/web build` | — | — | ✅ built | — |

CI 面:`.github/workflows/integration-guard.yml` 的 `pull_request`/`push` 两个 `paths:` 块与**唯一**的
`run:` vitest 列表均已收编 `bridgeAgentConfigCheck.ts` / `bridgeAgentConfigCheck.spec.ts`(组件 spec 的
新增 case 骑在既有 `IntegrationBridgeAgentSection` 过滤词上,无需新增词条)。

## 6. SENTINEL 覆盖

两个独立的 SENTINEL 面,分别对应两个 util 函数各自读取的输入源(纯 util 层 + 组件 DOM 层各验一次):

| 面 | 载体 | 断言 |
| --- | --- | --- |
| 纯 util:校验(`bridgeAgentConfigCheck.spec.ts`) | `config.sharedSecretEnvVar`/`connectionString`/`authMode` 为敌意密钥字符串;`config.baseUrl` 为含 host 的非回环地址;`objectNames` 含敌意对象名 | 对**全部 14 个 labelKey**(不只是本次命中的几个)、两种 locale,断言均不含 sentinel 字符串/host 片段 |
| 组件 DOM:校验卡(`IntegrationBridgeAgentSection.spec.ts`) | 默认 `bridgeSystem()` fixture 自带的 `sharedSecretEnvVar`/`connectionString` sentinel | 断言 `bridge-agent-config-check-list` 的 `innerHTML` 不含任一 sentinel;另有专项测试验证非回环 host 字符串本身也不出现在 DOM(§2 fail 分支) |
| 纯 util:建议构建(`bridgeAgentConfigCheck.spec.ts`) | 草稿 `objectName`/`fieldKeys` 含 `password=SENTINEL...`、连接串、host URL、超长"标识符" | 断言 `entries`/`text` 均不含 sentinel,只有 `invalidObjectCount`/`invalidFieldKeyCount` 计数增加 |
| 组件 DOM:建议卡(`IntegrationBridgeAgentSection.spec.ts`) | 操作员在真实输入框中键入含 sentinel 的对象名/字段名(先纯非法 → 引导态;再合法对象名+夹杂非法字段名 → 部分渲染检验) | 断言生成的 `<textarea>` value 与整个 `root.innerHTML` 均不含 sentinel,合法字段名(`field_a`)正常出现 |

关键区分(BA-UI-1/2 mutation 报告已强调的教训):config 侧 sentinel 只需要证明"检查表输出不回显它",
建议侧的真正考验是"**操作员自己输入的**敌意字符串是否被回显"——因为建议 util 根本不读取 `config`,所以
两个 sentinel 面必须分别覆盖,不能只测一个就当作覆盖了另一个。

## 7. Mutation 证明(基线 commit 后逐一注入 → 跑 → 红 → 精确 revert)

| # | 变体 | 预期 | 结果 |
| --- | --- | --- | --- |
| M1 | `localhostBoundaryCheck` 的 fail 分支改为返回 `status: 'pass'`(把非回环地址误判为通过) | mutation-相关分支测试红 | **RED**(`bridgeAgentConfigCheck.spec.ts` 的 "fails for a non-loopback host" 用例失败)✅ killed |
| M2 | `buildBridgeAgentChangeSuggestion` 里 `isSafeIdentifier` 校验绕过(直接 `push(rawObjectName)` 不做正则校验),使敌意对象名直接进入 `entries`/`text` | SENTINEL 相关测试红 | **RED**("SENTINEL: a secret-shaped object name is dropped" 用例失败,`text` 含 sentinel)✅ killed |

### 7.1 执行记录

两变体各单独注入 → `vitest run bridgeAgentConfigCheck` 确认 **RED**(M1: 1 failed / 64 passed;M2: 1
failed / 64 passed)→ 精确路径 `git checkout -- apps/web/src/services/integration/bridgeAgentConfigCheck.ts`
复原 → 重跑确认 **GREEN**(65/65)。基线在两次 mutation **之前**已 `git add` 暂存(本 PR 的工作树改动),
两次 revert 后工作树回到基线、无残留。

## 8. 改动清单

| 文件 | 类型 |
| --- | --- |
| `apps/web/src/services/integration/bridgeAgentConfigCheck.ts` | 新增(纯 util:6 项校验 + 建议构建 + 值域 label map) |
| `apps/web/src/components/integration/IntegrationBridgeAgentSection.vue` | 编辑(add-only:两张新卡片 + 局部样式 + import + 安全边界注释更新,反映 BA-UI-3 对 `system.config` 的授权只读) |
| `apps/web/tests/bridgeAgentConfigCheck.spec.ts` | 新增(65 tests,含两个 SENTINEL 套件 + label-map 值域扫描) |
| `apps/web/tests/IntegrationBridgeAgentSection.spec.ts` | 编辑(add-only:10 个 BA-UI-3 tests) |
| `.github/workflows/integration-guard.yml` | 编辑(两个 `paths:` 块 + 唯一 `run:` vitest 列表收编新 util/spec) |
| `docs/development/bridge-agent-ui3-config-validation-dev-verification-20260707.md` | 新增(本文) |

## 9. 边界外(维持冻结)

BA-UI-4(计划任务运行态提示)独立 opt-in,本片未实现其任何部分。本片没有新增/编辑任何后端路由、
adapter 行为、凭据路径——`plugins/plugin-integration-core/**` 未被触碰(其 CI 检查在本 PR 中仍随
`integration-guard.yml` 一起跑,是既有事实而非本片引入)。lock §3 "由受控后端或运维脚本应用"这句话
维持字面意义:本片生成的建议文本没有任何程序化的落地路径,应用与否、何时应用完全是人工决定。
