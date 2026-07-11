# IU-5a JSON-assist(集成 JSON textarea 站点 1-4)— 开发验证 — 2026-07-07

> 上位锁:`integration-ux-workbench-redesign-design-lock-20260706.md`(RATIFIED)§2 IU-5
> "JSON textarea 逐处结构化(门:IU-2 落地;**每处单独评估**);专家 JSON 模式保留切换"。
> IU-2 已全量落地(IU-2a/2b/2c),门已开。本片 = lane D part 1(owner 2026-07-07 授权),
> 按主循环对 5 处裸 JSON textarea 的逐处评估,先落站点 1-4 的 **JSON-assist** 形态
> (旁挂增强:一个格式化按钮 + 一条校验状态行;textarea 与其 data-testid 原样保留,
> 专家路径零降级)。

## 1. 逐站点处置表(binding disposition)

| # | 站点(data-testid) | 所在组件 | 处置 | 本片落点 |
| --- | --- | --- | --- | --- |
| 1 | `connection-draft-config` | `IntegrationConnectionSection.vue` | **JSON-assist**:格式化按钮 + 行级校验反馈 + 按 kind 的 values-free 占位示例;kind = `erp:k3-wise-webapi` 时加"该类型有专页配置"提示,链到既有 `/integrations/k3-wise` 路由(`router/appRoutes.ts`) | ✅ 本 PR |
| 2 | `connection-draft-capabilities` | `IntegrationConnectionSection.vue` | **JSON-assist**(同上;占位示例 = 能力形状 values-free 示意) | ✅ 本 PR |
| 3 | `sample-record` | `IntegrationPayloadPreviewSection.vue` | **JSON-assist only**(天然自由形,不做 form) | ✅ 本 PR |
| 4 | `payload-template` | `IntegrationPayloadPreviewSection.vue` | **JSON-assist only**(占位示例镜像该 textarea 既有 `placeholder` 属性的形状) | ✅ 本 PR |
| 5 | 字段选项同步 optionSets | `IntegrationFieldOptionSyncPanel.vue` | 结构化编辑器(独立后续切片) | ⏸ **DEFERRED → D2**(该 panel 在未合并的 in-flight PR #3822 中;本片零触碰 `IntegrationFieldOptionSyncPanel` 与 `IntegrationWorkbenchView`,避免与 sibling PR 冲突) |

通则(全站点一致,来自 disposition):textarea 与全部既有 data-testid 原样保留(assist
是旁挂增强);专家路径不降级;零后端/service 改动;既有 spec 断言零改动(ADD-ONLY);
token-only 样式(`var(--ms-*)`,零新增 hex/rgb 字面量);zh+en(走既有 `useLocale`
模式);占位示例一律占位符形态、无真实业务值。

## 2. 共享 helper 契约

四个站点共用同一实现,不四倍复制逻辑:

### `apps/web/src/utils/jsonAssist.ts`(纯函数层)

```ts
type JsonAssistStatus = 'empty' | 'valid' | 'invalid'
interface JsonAssistAnalysis { status: JsonAssistStatus; line: number | null; column: number | null }

analyzeJsonText(text: string): JsonAssistAnalysis
formatJsonText(text: string): string | null
```

- `analyzeJsonText`:空白 → `empty`;`JSON.parse` 通过 → `valid`;抛错 → `invalid` +
  尽力恢复的 1-based (line, column) 定位。定位只经窄正则 `/position (\d+)/` 从
  SyntaxError.message 提取**纯整数偏移**,再在调用方自己已可见的 textarea 文本里数换行
  换算行列 —— **绝不返回/转发 `error.message` 本身**(见 §3)。无 position 的错误形态
  (如 "Unexpected end of JSON input")→ `line/column = null`,调用方降级为通用
  values-free 文案。
- `formatJsonText`:`JSON.parse` → `JSON.stringify(_, null, 2)` 回写;解析失败返回
  `null`(格式化对非法输入是 no-op,永不 throw)。幂等(已格式化文本再格式化不变)。

### `apps/web/src/components/integration/JsonAssist.vue`(旁挂 UI 层)

Props:`modelValue`(与 sibling textarea 同一 v-model 数据)· `placeholderExample`
(values-free 占位示例串,per-site)· `testId`(= sibling textarea 的 data-testid,
用作本组件自有 testid 前缀)。Emit:`update:modelValue`(仅格式化按钮触发)。

渲染恰好两件东西(disposition"通则"):

- 格式化按钮 `${testId}-json-format`:当前文本合法时可用,点按将 2-space 格式化结果
  emit 回模型;非法/空时 disabled。
- 状态行 `${testId}-json-status`(带 `data-status` 属性):
  `empty` → 显示 per-site 占位示例;`valid` → "JSON 格式正确 / Valid JSON";
  `invalid` → "第 N 行第 M 列附近的 JSON 格式有误 / Invalid JSON near line N, column M"
  (无定位时通用文案)。zh+en 走 `useLocale`(与 IU-1/IU-6 同款 `bi()` 模式)。

样式全部 `var(--ms-*)` token(space/radius/border/bg/text/success/danger),零 hex —
既有 UF-6 style-guard(`ui-foundation-style-guard.spec.ts`,已覆盖两个 section 文件)
维持 65/65 绿。

### 站点接线

- 站点 1/2(`IntegrationConnectionSection.vue`):JsonAssist 挂在 `<details>` 专家区两个
  textarea 下方;`connectionConfigExample` 按 `connectionDraft.kind` 分族(K3 族 → 指向
  专页向导的提示串 / `metasheet:*` / `http*` / 兜底 `<config-key>` 形),
  `connectionCapabilitiesExample` = `{"read":"<true|false>","upsert":"<true|false>",...}`
  能力形状示意;kind = `erp:k3-wise-webapi` 时渲染
  `connection-draft-k3-setup-hint` + `connection-draft-k3-setup-link`(router-link 到
  `/integrations/k3-wise`)。父组件(IntegrationWorkbenchView)零改动 —— 组件继续经由
  既有 `connectionDraft` reactive 就地变更模式工作。
- 站点 3/4(`IntegrationPayloadPreviewSection.vue`):JsonAssist 挂在两个 textarea 下方,
  经既有 `defineModel`(`sampleRecordText`/`payloadTemplateText`)双向绑定;
  `sampleRecordExample` 全泛型 `{ "<field-name>": "<field-value>" }`(样例记录形状由源
  系统决定,不预设字段名),`payloadTemplateExample` 镜像该 textarea 自己既有
  placeholder 的 `FNumber/FName` 示意形(占位值,非真实业务值)。

既有校验面(父组件的 `connectionDraftJsonError` 保存前校验、DF-T1 preview 的服务端
校验)全部原样保留 —— JsonAssist 是纯前置反馈层,不接管任何 save/preview 判定。

## 3. no-echo 哨兵(安全不变量)

V8 的 `JSON.parse` SyntaxError.message **内嵌违规输入的片段**(如
`Unexpected token 'S', "{"a": SECRET_TOK"... is not valid JSON`)。若把
`error.message` 直渲进 UI,粘贴进 textarea 的 secret 形文本(token/密码)会逐字泄入
DOM。这正是 IU-1 addendum("raw errorMessage 一律不渲染")在本地校验面的同构风险。

防线 + 证明:

- `jsonAssist.ts` 从不返回 message 文本,只返回整数(或 null)—— 数字无法携带内容;
- 哨兵测试 ×2(利用裸词值构造非法 JSON,恰好触发 V8 会嵌片段的错误形态):
  - `tests/utils/jsonAssist.spec.ts`:`JSON.stringify(analysis)` 不含
    `sk-SECRET-TOKEN-...` 任何子串(纯函数层);
  - `tests/JsonAssist.spec.ts`:植入同款 secret 后,状态行 `textContent` **及整个
    `container.innerHTML`** 均不含该 secret(DOM 层)。

## 4. 测试证据(全部本地双 Node 跑绿)

| 面 | 内容 | 结果 |
| --- | --- | --- |
| 新 helper spec ×2 | `tests/utils/jsonAssist.spec.ts`(9:empty/valid/行列定位/无 position 降级/no-echo 哨兵/格式化往返/幂等/invalid→null)+ `tests/JsonAssist.spec.ts`(5:testid 派生/empty 占位+disabled/valid+格式化 emit/invalid 状态/DOM no-echo 哨兵) | 14/14 ✅ |
| 站点接线(ADD-ONLY) | `IntegrationConnectionSection.spec.ts` +5(strip 双站点存在 + textarea 保留 TAGNAME/格式化就地变更 reactive draft/坏 JSON→invalid/非 K3 无 hint/K3 kind→hint+link);`IntegrationPayloadPreviewSection.spec.ts` +4(strip 双站点存在 + textarea 保留/格式化 emit/坏 JSON→invalid(受控双向 host)/empty 占位)。**既有断言零改动**(既有 4+3 测试原文未动;仅新增 `reactive` import 与受控 mount helper) | 9/9 + 7/7 ✅ |
| integration-guard.yml 全清单 + JsonAssist | 20 spec 文件 227 tests,default Node(v25)与 Node 20(nvm)双跑 | 227/227 ×2 ✅ |
| plugin-integration-core CJS 链 | guard 另一腿(本片零后端改动,回归确认) | 全绿 ✅ |
| UF-6 style guard | `ui-foundation-style-guard.spec.ts`(含两个被改 section 文件的 hex=0 门) | 65/65 ✅ |
| `vue-tsc -b` | 全仓 web typecheck | 0 错误 ✅ |
| `vite build` | 生产构建 | ✅ |

CI 面:`integration-guard.yml` path filter 补入 4 个新文件(JsonAssist.vue /
jsonAssist.ts / 两个新 spec),vitest 定向清单追加 `JsonAssist` 模式(一个模式同时命中
`tests/JsonAssist.spec.ts` 与 `tests/utils/jsonAssist.spec.ts`,已本地验证)。

## 5. 边界与后续

- **站点 5 deferral**:optionSets 结构化编辑器是**独立后续切片(lane D part 2 / D2)**。
  其宿主 `IntegrationFieldOptionSyncPanel.vue` 在 in-flight 未合并 PR #3822 中,本片对
  该 panel 与 `IntegrationWorkbenchView.vue` **零触碰**(collision-free surface:sibling
  PRs #3821/#3822/#3824 均不触本片两个 section 文件)。
- 不做:JSON 结构化 form(站点 1-4 评估结论即 assist 形态)、schema 级校验(按 kind 的
  字段合法性仍由后端/save 路径判定)、编辑器组件(CodeMirror 等)引入。
- 专家路径零降级:textarea 全保留、既有保存前 `connectionDraftJsonError` 校验全保留、
  机器码详情面未动。
