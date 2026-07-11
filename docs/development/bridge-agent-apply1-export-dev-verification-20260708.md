# BA-APPLY-1 — Bridge Agent 变更建议 → 机读实施清单导出 · 开发/验证报告 — 2026-07-08

> Design-lock: `docs/development/bridge-agent-controlled-apply-design-lock-20260708.md`(#3876）§2 形态
> A + §1 三条原则 + §4 硬锁。上位锁:`bridge-agent-admin-page-design-lock-20260707.md`(BA-UI-0
> RATIFIED)。Demand anchor:#3746(保持 OPEN)。Owner 已于 2026-07-08 授权收官后 4 条独立线开发,
> BA-APPLY-1 为其 #1 优先。
>
> **口径提醒**:design-lock 文档头写"状态:PROPOSED,等 owner ratify…authorizes NO RUNTIME"——该行是
> design-lock 自身发布时的初始状态声明;本次开发的授权渠道是 owner 2026-07-08 的任务派工(4 条线之一,
> BA-APPLY-1 优先),而非对 design-lock 文档本身的另一次 ratify 动作。本片严格落在 §2 形态 A 的范围内
> (纯导出/render,零 runtime apply),不越界到形态 B(§2 后端受控 apply,门:BA-APPLY-1 落地 + owner
> 单独 opt-in,未开)。
>
> 本片 = **纯导出/渲染**:把 BA-UI-3 已产出的、已经过 identifier 门控的变更建议草稿,额外渲染成一份
> **机读**格式(JSON:`{ schemaVersion, operations }`),而不是（或者说,除了）人读的建议文本。**零平台
> 写路径、零 Agent 写、零新增后端调用、零本机 config 写、零 apply**——这些都是 BA-APPLY-2+(形态 B)
> 未开的 rung 才会引入的东西。

## 1. 范围与做法(vs design-lock §1/§2/§4 逐条)

| lock 条款 | 实现 |
| --- | --- |
| §1 原则 1:只扩只读暴露面,apply 后 Agent 仍 `readonly:true` | 本片不 apply 任何东西;清单的操作枚举本身即被限定为只读扩面动作(见 §3) |
| §1 原则 2:前端只 PRODUCE 建议,apply 走后端受控通道/运维脚本 handoff | 清单是纯 client 端渲染产物(`buildImplementationChecklist`),无 `fetch`/`apiFetch`,无 service 调用 |
| §1 原则 3:凭据后端持有,证据 values-free | 清单内容只含对象名/字段键名/操作枚举;不含 host/凭据/取值/自由文本 |
| §2 形态 A:变更建议 → 机读实施清单导出(values-free);运维受控应用 | `buildImplementationChecklist(drafts) → { checklist: { schemaVersion, operations }, invalidObjectCount, invalidFieldKeyCount }`,组件新增"导出实施清单"按钮 + JSON 预览 + 复制/下载 |
| §4 硬锁:只读不变式,操作枚举绝不含写/删/可写化 | 操作枚举闭集 `'add_readonly_object' \| 'add_readonly_field'`,`op` 完全由字段数量派生,从不读取调用方输入 |

## 2. 机读实施清单契约(`apps/web/src/services/integration/bridgeAgentConfigCheck.ts`)

```ts
export type BridgeAgentChecklistOperationKind = 'add_readonly_object' | 'add_readonly_field'

export interface BridgeAgentChecklistOperation {
  op: BridgeAgentChecklistOperationKind
  objectName: string
  fieldKeys: string[]
}

export interface BridgeAgentImplementationChecklist {
  schemaVersion: 1
  operations: BridgeAgentChecklistOperation[]
}

export function buildImplementationChecklist(
  drafts: BridgeAgentSuggestionObjectDraft[],
): { checklist: BridgeAgentImplementationChecklist; invalidObjectCount: number; invalidFieldKeyCount: number }
```

- **输入**:与 `buildBridgeAgentChangeSuggestion` 完全相同的 `drafts: { objectName, fieldKeys }[]`
  ——操作员键入的对象名 + 字段名(仅名称)。**不是**从 `buildBridgeAgentChangeSuggestion` 的输出接力
  (即不吃已过滤的 `entries`),而是独立地重新应用同一个安全标识符门(`filterSafeSuggestionDrafts`,
  下方"门复用"一节)——这样即便调用方误传未过滤的原始草稿,这个函数自己也不会把敌意名称带进清单。
- **序列化/复制/下载出去的产物,精确等于** `result.checklist`(即 `{ schemaVersion, operations }`
  两个字段),**不含** `invalidObjectCount`/`invalidFieldKeyCount`(那两个计数只留给调用方做 UI 判断,
  从不进入导出内容),**不含**任何 `targetLabel`/`system.name`/自由文本——与人读建议文本
  (`buildBridgeAgentChangeSuggestion` 的 `text`,含"目标实例:…"抬头行)刻意不同,机读清单更严格。
- **操作枚举派生规则(exact-registered,精确到字面量)**:
  - 一条草稿的有效字段名(经安全标识符过滤)数量为 0 → `op: 'add_readonly_object'`,
    `fieldKeys: []`。
  - 一条草稿的有效字段名数量 ≥ 1 → `op: 'add_readonly_field'`,`fieldKeys` 携带该行**全部**有效
    字段名(不是每字段一条操作——一行草稿只产出一条操作,`fieldKeys` 是数组)。
  - `op` **完全由"该行是否有有效字段名"这个布尔派生**,`BridgeAgentSuggestionObjectDraft` 本身没有
    `op` 字段——调用方(包括恶意/被篡改的草稿对象)不可能通过输入注入第三种或写/删/可写化的操作字面量
    (mutation 证明见 §7)。
- **门复用**:新增私有辅助 `filterSafeSuggestionDrafts(drafts)` 从 `buildBridgeAgentChangeSuggestion`
  的内联逻辑中提炼出来,现在是**唯一**一处安全标识符过滤实现,`buildBridgeAgentChangeSuggestion` 与
  `buildImplementationChecklist` 都调用它——不再有两份重复的过滤逻辑各自维护。提炼后先跑一遍既有 65
  个 `bridgeAgentConfigCheck.spec.ts` 测试确认逐字节行为不变,再在其上叠加清单相关测试。

## 3. 组件接线(`apps/web/src/components/integration/IntegrationBridgeAgentSection.vue`)

- 新增按钮 `data-testid="bridge-agent-checklist-export"`("导出实施清单"/"Export implementation
  checklist"),点击切换 `checklistVisible`,按钮文案随之切换为"收起实施清单"/"Hide implementation
  checklist"——与既有"查看/收起 schema"toggle 模式一致。
- 该按钮 + 展开内容是**建议卡的兄弟节点**(不是嵌套在人读建议文本的 `v-else` 分支内),独立于
  `suggestionResult.entries.length` 门控——有自己的 IU-6 guided-empty 态
  (`bridge-agent-checklist-empty` / `-empty-what` / `-empty-first-step`),在
  `implementationChecklist.checklist.operations.length === 0` 时渲染,而不是复用建议卡的空态。
- 展开后:只读 `<textarea data-testid="bridge-agent-checklist-text">` 展示
  `JSON.stringify(checklist, null, 2)`;"复制清单 JSON"按钮(`bridge-agent-checklist-copy`,复用
  `navigator.clipboard.writeText` 同一套失败兜底模式,`bridge-agent-checklist-copy-state` 显示
  已复制/复制失败);"下载清单 JSON"按钮(`bridge-agent-checklist-download`,`Blob` +
  `URL.createObjectURL` + 隐藏 `<a download>` 点击 + `URL.revokeObjectURL`,文件名仅含固定前缀 +
  客户端 `Date.now()` 时间戳,不含系统名/配置值)。
- `implementationChecklist` computed 直接从 `suggestionDrafts`(与 `suggestionResult` 相同的输入源)
  重新构建 `BridgeAgentSuggestionObjectDraft[]` 并调用 `buildImplementationChecklist`——不吃
  `suggestionResult.value.entries`,保持"独立重新过滤"的纵深防御与纯 util 层的契约一致。
- 样式:复用既有 `.integration-workbench__button` / `.integration-workbench__empty` /
  `.integration-workbench__hint` / `.bridge-agent__suggestion-output` / `.bridge-agent__suggestion-text`
  类(与人读建议卡的输出块外观一致),仅新增一个无样式规则的 `.bridge-agent__checklist-export` 包裹
  div(布局用,不含新 CSS 声明)——`IntegrationBridgeAgentSection.vue` 已在
  `ui-foundation-style-guard.spec.ts` 的 `TARGET_FILES` 中,本片未新增 `.vue` 文件,故无需改动该清单。

## 4. 零写路径确认(vs design-lock §4 硬锁逐条)

| 检查点 | 状态 | 证据 |
| --- | --- | --- |
| 无 apply 端点调用 | ✅ | `buildImplementationChecklist` 是纯函数,无 `fetch`/`apiFetch`;组件新增的三个按钮处理函数(`toggleChecklist`/`copyChecklistText`/`downloadChecklistJson`)均不调用任何 service 函数 |
| 无 Agent 写 | ✅ | 全仓搜索确认本片零涉及 `bridge-agent-readonly-adapter.cjs`、`scripts/ops/bridge-agent-readonly*.ps1`、`plugins/plugin-integration-core/**`(本片零后端改动) |
| 无本机 config 写 | ✅ | 下载/复制均为浏览器本地动作(Blob/clipboard),不写任何服务器状态;`downloadChecklistJson` 仅创建一个客户端 `<a>` 下载,不触达后端 |
| 只读不变式(操作枚举绝不含写/删/可写化) | ✅ | 闭集类型 `'add_readonly_object' \| 'add_readonly_field'`;`op` 完全派生,mutation 证明见 §7 |
| SAFE_IDENTIFIER 门复用(敌意名称不进清单) | ✅ | `filterSafeSuggestionDrafts` 单一实现,两个 builder 共用;§6 SENTINEL 覆盖清单序列化后的完整字符串 |
| 序列化产物无 targetLabel/系统名/自由文本 | ✅ | `checklist` 只有 `schemaVersion`/`operations` 两个键(测试断言 `Object.keys(...).sort()`) |

## 5. 测试矩阵

| 面 | 文件 | 数量 | 备注 |
| --- | --- | --- | --- |
| 纯 util(既有 65 + 新增 10:契约形状/两个派生分支字面量/多行顺序/枚举白名单/注入 op 防御/门复用/SENTINEL 全序列化扫描/never-throws) | `apps/web/tests/bridgeAgentConfigCheck.spec.ts` | 75 | 既有 65 个测试逐字节不变(门提炼重构后先跑绿confirm,再叠加) |
| 组件(既有 32 + 新增 8:toggle 可见性/JSON 精确渲染/object-only 分支/加删行反映/SENTINEL/复制成功/复制失败兜底/下载 Blob+anchor+revoke) | `apps/web/tests/IntegrationBridgeAgentSection.spec.ts` | 40 | 既有 32 个测试保持 ADD-ONLY 不变 |
| integration-guard 全 34 文件已收编列表(两个源文件均已在既有 `run:` 行与两个 `paths:` 块中,零 workflow 改动) | `.github/workflows/integration-guard.yml` | 483 | 全绿(34 files / 483 tests) |
| `ui-foundation-style-guard`(未新增 `.vue`,`TARGET_FILES` 无需改动) | `apps/web/tests/ui-foundation-style-guard.spec.ts` | 83 | ✅ |
| `vue-tsc -b` | — | — | ✅ clean |
| `pnpm --filter @metasheet/web build` | — | — | ✅ built |
| `pnpm --filter @metasheet/web exec eslint <两个改动源文件>` | — | — | ✅ 0 errors(该两文件不在 `apps/web` 的 `lint` 脚本显式文件列表内,手动跑作为额外确认) |

CI 面:`.github/workflows/integration-guard.yml` 的 `pull_request`/`push` 两个 `paths:` 块与**唯一**的
`run:` vitest 列表**已经**包含 `bridgeAgentConfigCheck.ts`/`.spec.ts` 与
`IntegrationBridgeAgentSection.vue`/`.spec.ts`(BA-UI-3 落地时收编)——本片只编辑既有文件、未新增文件,
因此本次**零 workflow 改动**;新增的测试用例随既有文件名自动纳入 CI。

## 6. SENTINEL 覆盖

| 面 | 载体 | 断言 |
| --- | --- | --- |
| 纯 util:清单构建(`bridgeAgentConfigCheck.spec.ts`) | 草稿 `objectName` 为连接串/host URL,`fieldKeys` 含密钥字符串;混入一条合法草稿 | 对 `JSON.stringify(result.checklist)` 的**完整序列化字符串**断言不含 sentinel/host 片段/连接串,且存活的一行恰好是被净化后的合法条目(无部分/损坏残留) |
| 纯 util:注入 op 防御(`bridgeAgentConfigCheck.spec.ts`) | 手工构造带 `op: 'delete_object'` 字段的敌意草稿对象(绕过 TS 类型用 `as unknown as`) | 输出的 `op` 依旧是派生值 `add_readonly_object`,证明调用方输入无法覆盖派生逻辑 |
| 组件 DOM:导出面板(`IntegrationBridgeAgentSection.spec.ts`) | 操作员在真实输入框键入 `password=SENTINEL...` 作为对象名,以及合法对象名 + `token=SENTINEL...` 混入字段名 | 敌意对象名整行被丢弃(退回 guided-empty 态,`bridge-agent-checklist-text` 不存在);合法行的 JSON 精确等于净化后的期望值,`root.textContent` 全文不含 sentinel |
| 组件 DOM:复制/下载载荷 | 复制到 mock 剪贴板、下载到 mock Blob 的内容 | 对 `writeText` 的调用参数与下载 Blob 的文本内容分别 `JSON.parse` 后做精确 `toEqual`,两处均只含派生后的 add_readonly_* 操作,不含任何 sentinel |

## 7. Mutation 证明(操作枚举硬锁)

| # | 变体 | 预期 | 结果 |
| --- | --- | --- | --- |
| M1 | 把 `buildImplementationChecklist` 内 `op` 派生表达式的 object-only 分支从 `'add_readonly_object'` 改为 `('delete_object' as BridgeAgentChecklistOperationKind)`(强制类型断言绕过 TS,模拟一次把只读扩面操作误改成写/删操作的回归) | 操作枚举白名单测试 + 派生分支字面量测试 + 注入防御测试均应变红 | **RED**:4 个测试失败——`every produced op is in the hardcoded ALLOWED_OPS allowlist`、`object-only draft … yields exactly op=add_readonly_object`、`a draft with an injected op-like field …`、`SENTINEL: …`(该 sentinel 测试的存活行恰好是 object-only 分支,因此也踩中)——ALLOWED_OPS 硬编码在测试文件里(不从源码 import),即使源码的类型联合也被一并改掉,测试依旧能感知字面量层面的漂移 ✅ killed |

### 7.1 执行记录

变体注入 → `pnpm --filter @metasheet/web exec vitest run bridgeAgentConfigCheck` 确认 **RED**(4
failed / 71 passed)→ 用备份文件精确还原
`apps/web/src/services/integration/bridgeAgentConfigCheck.ts`(未触碰同一提交里的任何其它文件)→
重跑 `bridgeAgentConfigCheck` + `IntegrationBridgeAgentSection` 两个 spec 确认 **GREEN**(75 + 40 =
115/115)。基线在 mutation **之前**已完成本次全部实现改动(工作树完整改动),mutation 与 revert 均只
针对这一个文件,未使用任何整仓级 `checkout -- .`。

## 8. 改动清单

| 文件 | 类型 |
| --- | --- |
| `apps/web/src/services/integration/bridgeAgentConfigCheck.ts` | 编辑(提炼共享安全标识符门 `filterSafeSuggestionDrafts` + 新增 `buildImplementationChecklist`/操作枚举类型/清单类型) |
| `apps/web/src/components/integration/IntegrationBridgeAgentSection.vue` | 编辑(ADD-ONLY:新增"导出实施清单"按钮 + JSON 预览 + 复制/下载,复用既有样式类;import 新增 `buildImplementationChecklist`) |
| `apps/web/tests/bridgeAgentConfigCheck.spec.ts` | 编辑(ADD-ONLY:新增 `buildImplementationChecklist` describe 块,10 tests) |
| `apps/web/tests/IntegrationBridgeAgentSection.spec.ts` | 编辑(ADD-ONLY:新增 8 个组件测试 + zh 断言追加到既有 zh 测试 + 新增 `readBlobText` 测试辅助函数) |
| `docs/development/bridge-agent-apply1-export-dev-verification-20260708.md` | 新增(本文) |

`.github/workflows/integration-guard.yml` **未改动**——两个源文件均已在既有 `paths:`/`run:` 收编中
(BA-UI-3 落地时已收编)。

## 9. 边界外(维持冻结)

BA-APPLY-2(形态 B:后端受控 config-apply 端点、审批门、只读 allowlist 白名单写轨)与 BA-APPLY-3(apply
后自动复探测)均未开,门:BA-APPLY-1 落地 + owner 单独 opt-in。本片没有新增/编辑任何后端路由、
Agent/adapter 行为、凭据路径——`plugins/plugin-integration-core/**` 未被触碰。design-lock §2 形态 A
"运维受控应用"这句话维持字面意义:本片生成的机读清单没有任何程序化的落地路径,复制/下载之后如何应用、
何时应用完全是运维人工决定(交给受控后端或既有 `scripts/ops/bridge-agent-readonly.ps1` 的一个后续、
未开的环节)。
