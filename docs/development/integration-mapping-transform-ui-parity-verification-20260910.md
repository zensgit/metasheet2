# G27 清洗映射规则 UI 对齐引擎全集 — 验证记录

Date: 2026-09-10
Worktree: `C:\Users\zhou\Downloads\dev\metasheet-wt-g27`
Branch: `feat/integration-mapping-transform-ui-parity`（基于 `origin/main` a22955f83）
设计文档: `docs/development/integration-mapping-transform-ui-parity-design-20260910.md`

后端零改动：`plugins/`、`packages/` 未出现在 `git status` 里，全部改动落在 `apps/web/` 与 `docs/`。

## 1. 命令与退出码

| # | 命令（cwd） | 退出码 | 结果 |
| --- | --- | --- | --- |
| 1 | `pnpm install --frozen-lockfile --offline`（worktree 根） | 0 | `Done in 2m 58.7s using pnpm v9.15.9`（worktree 初始无 `node_modules`） |
| 2 | `npx vitest run tests/integrationMappingTransformParity.spec.ts`（`apps/web`） | 0 | `21 passed (21)` |
| 3 | `npx vitest run tests/IntegrationMappingRulesSection.spec.ts`（`apps/web`） | 0 | `10 passed (10)` |
| 4 | `npx vitest run tests/IntegrationWorkbenchView.spec.ts`（`apps/web`） | 0 | `52 passed (52)`，**该文件一行未改** |
| 5 | `npx vitest run tests/ui-foundation-style-guard.spec.ts`（`apps/web`） | 0 | `107 passed (107)` |
| 6 | 上面 4 个 spec 一次跑（`apps/web`） | 0 | `Test Files 4 passed (4) / Tests 190 passed (190)` |
| 7 | `pnpm --filter web run type-check`（worktree 根） | 0 | `vue-tsc -b` + 两个 verification tsconfig 全过 |
| 8 | `pnpm --filter web run lint`（worktree 根） | 0 | 见下方说明 |

第 8 条说明：`apps/web` 的 `lint` 脚本跑的是**显式文件清单**（main/App/useAuth/featureFlags/api/PLM/workflow 那批），本次改动的 integration 组件、视图与 spec **都不在该清单内**，所以这条是「没有被我的改动带红」的对照，不是对新代码的覆盖。新组件的样式约束由 `tests/ui-foundation-style-guard.spec.ts` 这条 fs 级门禁承担（见 §4）。

## 2. 测试清单（新增/修改的测试名）

### 2.1 `apps/web/tests/integrationMappingTransformParity.spec.ts`（新，21 条）

`G27 cleaning-rules parity: UI list vs engine whitelist`
- `offers exactly the engine SUPPORTED_TRANSFORMS set`
- `mutation probe: dropping one transform from the UI list turns that assertion red`
- `offers exactly the validator SUPPORTED_RULES set`
- `mutation probe: dropping enum from the UI rule list turns that assertion red`

`G27 cleaning-rules parity: transform payload shapes`
- `keeps the pre-G27 single-step payloads byte-for-byte`
- `builds toDate / defaultValue / concat in the shapes the engine reads`
- `builds a multi-step chain as the array normalizeTransformList reduces`
- `mutation probe: a builder that keeps only the first step fails the chain expectation`
- `ignores steps whose transform is still empty`
- `refuses the argument shapes the engine would silently no-op or reject`

`G27 cleaning-rules parity: validation payload shapes`
- `keeps required/min/max in their pre-G27 order and shape`
- `emits pattern and enum only when authored`
- `rejects an invalid regex at build time instead of one INVALID_RULE per row`

`G27 cleaning-rules parity: field-mapping payload`
- `is byte-identical to the pre-G27 payload for an untouched row`
- `adds the mapping-level defaultValue only when authored`

`G27 cleaning-rules parity: the engine accepts what the UI builds`
- `transforms every UI-authored shape, including the chain and the mapping-level default`
- `validates with the pattern and enum rules the UI now authors`

`G27 cleaning-rules parity: editor round trip (G08 pre-work)`
- `re-parses every payload it builds back into the same payload`
- `re-parses into an editor state that renders the same controls`
- `also reads engine-legal shapes this UI never writes`
- `drops a transform the UI cannot author instead of pretending it round-tripped`

两条「引擎实跑」的测试通过 `createRequire()` 直接 `require` 服务端模块（与 `tests/k3-endpoint-vocab-mirror.spec.ts` 同一套反漂移做法），不是复述一份服务端常量：

```ts
const pluginLib = path.resolve(__dirname, '../../../plugins/plugin-integration-core/lib')
const { SUPPORTED_TRANSFORMS, transformRecord } = require(path.join(pluginLib, 'transform-engine.cjs'))
const { SUPPORTED_RULES, validateRecord } = require(path.join(pluginLib, 'validator.cjs'))
```

引擎对 UI 产出的 9 条映射实跑后的值（断言原样）：`FNumber: 'mat-001'`、`FUpper: 'MAT-001'`（链）、`FQty: 1234`、`FDateOnly: '2024-01-31'`、`FDateTime: '2024-01-31T00:00:00.000Z'`、`FName: 'UNKNOWN'`、`FSyncKey: 'mat-001-M8-red'`（trim→concat 链）、`FBaseUnitID: 'Pcs'`、`FModel: 'N/A'`（映射级默认值先顶上、再被链上的 `upper` 处理），`errors: []`。
校验实跑：合法记录 `errors: []`；违规记录错误码顺序 `['PATTERN', 'ENUM', 'MIN']`，且既无 `UNSUPPORTED_RULE` 也无 `INVALID_RULE`——即我们下发的规则形状引擎全认。

### 2.2 `apps/web/tests/IntegrationMappingRulesSection.spec.ts`（+8 条，共 10 条）

- `renders the section id and one mapping card per mapping`（既有，改用共享工厂构造 mapping）
- `forwards add-mapping and remove-mapping clicks to their prop functions`（既有，同上）
- `shows no argument control for the transforms that take no argument`
- `shows only the toDate format select for toDate, and writes the chosen format back`
- `shows only the value input for defaultValue, and writes the value back`
- `shows a source-field multi-select plus separator for concat, and writes both back`
- `falls back to a comma-separated concat field input when the source schema is unknown`
- `renders one chained-step editor per extra step, with its own fn and argument controls`
- `forwards the chain add/remove clicks to their prop functions with the mapping`
- `writes the pattern, enum and mapping-level default inputs back onto the mapping`

### 2.3 未改动但必须绿的既有测试

`apps/web/tests/IntegrationWorkbenchView.spec.ts` 的 52 条一行未改全绿。它包含对保存/预览 payload 里 `fieldMappings` 的逐条断言（`transform: { fn: 'upper' }`、`{ fn: 'dictMap', map: {...} }`、`validation: [{ type: 'required' }, { type: 'min', value: 0.000001 }]`），因此这条通过本身就是**字节兼容的端到端证据**。

## 3. 变异探针（内存改写 → 运行 → 逐字节还原）

做法：用一个一次性脚本把守卫改坏 → 跑对应 spec → 记录退出码与红的测试名 → 用**内存里保存的原始字节**写回（不用 `git checkout --`、不用 `git reset`）→ 再核对 `git status --porcelain` 与 `git diff --numstat` 与改之前完全一致。

| 探针 | 改坏了什么 | spec | 退出码 | 变红的测试 |
| --- | --- | --- | --- | --- |
| A | 从 `TRANSFORM_OPTIONS` 删掉 `toDate` 一项 | parity | 1 | `offers exactly the engine SUPPORTED_TRANSFORMS set` / `re-parses every payload it builds back into the same payload` / `also reads engine-legal shapes this UI never writes` |
| B | `buildTransformPayload` 把 `payloads.length === 1 ? payloads[0] : payloads` 改成 `payloads[0]`（链只取第一步） | parity | 1 | `builds a multi-step chain as the array normalizeTransformList reduces` / `mutation probe: a builder that keeps only the first step fails the chain expectation` / `ignores steps whose transform is still empty` / `transforms every UI-authored shape, including the chain and the mapping-level default` / `re-parses into an editor state that renders the same controls` |
| C | `pattern` 规则不再经 `assertValidPattern()` 编译校验 | parity | 1 | `rejects an invalid regex at build time instead of one INVALID_RULE per row` |
| D | 映射级 `defaultValue` 不再写进 payload | parity | 1 | `adds the mapping-level defaultValue only when authored` / `transforms every UI-authored shape, including the chain and the mapping-level default` / `re-parses into an editor state that renders the same controls` |
| E | 参数控件不再按所选转换显隐（`showsAnyControl` 恒真 + `defaultValue` 分支条件放宽成 `fn !== 'toDate'`） | section | 1 | `shows no argument control for the transforms that take no argument` / `shows a source-field multi-select plus separator for concat, and writes both back` / `falls back to a comma-separated concat field input when the source schema is unknown` |

还原核对（探针脚本末尾原样输出）：

```
--- git status after restore ---
 M apps/web/src/components/integration/IntegrationMappingRulesSection.vue
 M apps/web/src/components/integration/integrationWorkbenchSectionTypes.ts
 M apps/web/src/views/IntegrationWorkbenchView.vue
 M apps/web/tests/IntegrationMappingRulesSection.spec.ts
 M apps/web/tests/ui-foundation-style-guard.spec.ts
?? apps/web/src/components/integration/IntegrationMappingTransformArgs.vue
?? apps/web/src/components/integration/integrationMappingTransform.ts
?? apps/web/tests/integrationMappingTransformParity.spec.ts
```

`git diff --numstat` 在探针前后同为 `135/15`、`37/1`、`56/77`、`183/21`、`4/0`；随后重跑 parity + section + style-guard 三个 spec：`138 passed (138)`，退出码 0。

另外，parity spec 里**常驻**两条自带变异探针（`mutation probe: ...`），它们在测试内部构造「少一种 fn 的列表」和「只取第一步的构建器」，断言那两条对齐/链断言在该实现下必然抛错——即使没人再手工跑上面的脚本，CI 也一直在证明这两条断言有鉴别力。

## 4. 为什么动了 `tests/ui-foundation-style-guard.spec.ts`

改动只有 4 行：把新组件 `src/components/integration/IntegrationMappingTransformArgs.vue` 加进 UF-6 的 token-only 目标清单（外加三行说明注释）。

- 该 guard 是 fs 级门禁：目标清单里的每个文件都必须做到「零静态 `style=` 属性」和「`<style>` 块里零 hex/rgb 字面量」。
- 新组件的 CSS 是从同一个（已在清单内、已 token 化的）`IntegrationMappingRulesSection.vue` 抄来的，天生只用 `var(--ms-*)`，所以入列即绿，`STATIC_STYLE_ALLOWLIST` / `HEX_COLOR_ALLOWLIST` **保持为空**（没有为了让它过而开豁免）。
- 这是**收紧**：不入列的话，这个新文件永远不会被该门禁看住；入列后它跟其它 21+ 个文件受同一条规则约束。`107 passed` 里就包含它的两条（静态 style / hex 字面量各一条）。

## 5. 环境噪声（与本次改动无关）

- vitest 启动时的 `WebSocket server error: Port is already in use` 每次都有，与本机另一个 vite 进程抢端口有关，不影响用例结果。
- `IntegrationWorkbenchView.spec.ts` 的 stderr 里有大量 `Failed to resolve component: el-icon / el-tooltip` 与 `SQLSERVER_TEST_FAILED: TLS/SSL ...` 字样，都是该 spec 既有的 mock 数据与未注册的 Element Plus 全局组件产生的，改动前后一致，用例本身 52/52 绿。
