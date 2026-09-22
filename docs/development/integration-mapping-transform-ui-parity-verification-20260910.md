# G27 清洗映射规则 UI 对齐引擎全集 — 验证记录

Date: 2026-09-10
Worktree: `C:\Users\zhou\Downloads\dev\metasheet-wt-g27`
Branch: `feat/integration-mapping-transform-ui-parity`（基于 `origin/main` a22955f83）
设计文档: `docs/development/integration-mapping-transform-ui-parity-design-20260910.md`

后端零改动：`plugins/`、`packages/` 未出现在 `git status` 里，全部改动落在 `apps/web/` 与 `docs/`。

## 1. 命令与退出码（第一轮，#5596 终审修复之前）

> 终审修复后的最终一轮命令与计数见 §5.8；本节保留第一轮记录，各轮都跑过。


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

### 2.1 `apps/web/tests/integrationMappingTransformParity.spec.ts`（新，第一轮 21 条 → 终审后 30 条）

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

`G27 cleaning-rules parity: #5596 final-review fixes`（终审新增，见 §5）
- `F07: a build error names the row and keeps the original message verbatim`
- `F02: a step carrying BOTH args.* and top-level keys is read the way the engine reads it`
- `F02: a rule carrying BOTH a top-level and a params value is read the way the validator reads it`
- `F01/F11: pattern flags and custom messages are DROPPED on read — the loss is asserted, not hidden`
- `F04/F08: the mapping-level default does NOT fire on a whitespace-only source value`
- `survives the API layer: normalizeFieldMappings -> transformRecord keeps chains and pins null defaults`
- `round-trips a dictMap VALUE containing "=" (only the first "=" splits)`
- `skips (and reports) a dictMap entry the textarea convention cannot express`
- `pins the dictMap trim loss: parse(serialize(map)) equals the TRIMMED map, and says so`

两条「引擎实跑」的测试通过 `createRequire()` 直接 `require` 服务端模块（与 `tests/k3-endpoint-vocab-mirror.spec.ts` 同一套反漂移做法），不是复述一份服务端常量：

```ts
const pluginLib = path.resolve(__dirname, '../../../plugins/plugin-integration-core/lib')
const { SUPPORTED_TRANSFORMS, transformRecord } = require(path.join(pluginLib, 'transform-engine.cjs'))
const { SUPPORTED_RULES, validateRecord } = require(path.join(pluginLib, 'validator.cjs'))
```

引擎对 UI 产出的 9 条映射实跑后的值（断言原样）：`FNumber: 'mat-001'`、`FUpper: 'MAT-001'`（链）、`FQty: 1234`、`FDateOnly: '2024-01-31'`、`FDateTime: '2024-01-31T00:00:00.000Z'`、`FName: 'UNKNOWN'`、`FSyncKey: 'mat-001-M8-red'`（trim→concat 链）、`FBaseUnitID: 'Pcs'`、`FModel: 'N/A'`（映射级默认值先顶上、再被链上的 `upper` 处理），`errors: []`。
校验实跑：合法记录 `errors: []`；违规记录错误码顺序 `['PATTERN', 'ENUM', 'MIN']`，且既无 `UNSUPPORTED_RULE` 也无 `INVALID_RULE`——即我们下发的规则形状引擎全认。

### 2.2 `apps/web/tests/IntegrationMappingRulesSection.spec.ts`（第一轮 +8 条共 10 条 → 终审后 12 条）

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
- `keeps a trailing comma the operator just typed in the concat fallback input`（终审新增，F06 回归）
- `re-syncs the concat fallback input when the field list changes from OUTSIDE the input`（终审新增）

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

## 5. 终审修复（2026-09-10，#5596 对抗复核终审「修完 F06 再转正式」）

终审结论：三条核心保证成立、守卫接线复核通过，需先修 F06 与四项低成本后续。以下逐项落地，全部仍是**后端零改动**。

### 5.1 必修 F06 — concat 无 schema 回退框吞掉尾随逗号

- 现象：回退输入 `:value` 绑的是 `args.concatFields.join(', ')` 这个**派生值**，而 `parseCommaSeparatedList` 会丢掉空尾项，所以敲下 `spec,` 之后数组仍是 `['spec']`、派生串仍是 `spec`，下一次深层响应重渲染就把逗号无条件 patch 掉——源库 503、拿不到 schema 时这是**唯一**的 concat 编辑入口，等于第二个字段名根本敲不进去。
- 修法：`IntegrationMappingTransformArgs.vue:103`（`concatFieldsDraft = ref(...)`）+ `:109-112`（`onConcatFieldsText` 先写草稿再写数组）+ `:114-118`（`watch(() => props.args.concatFields, { deep: true })` 只在「外部改动使 `parse(draft)` 与数组不再相等」时回填），模板 `:38-47` 改绑草稿。
- 补测（`IntegrationMappingRulesSection.spec.ts`，用 `reactive()` mapping）：
  - `keeps a trailing comma the operator just typed in the concat fallback input` — 连发 `spec`、`spec,` 后断言 `input.value === 'spec,'`，再写一次兄弟字段 `concatSeparator` 强制重渲染，仍是 `spec,`，最后 `spec,color` 解析成两项。
  - `re-syncs the concat fallback input when the field list changes from OUTSIDE the input` — 外部把数组换成 `['color','size']` 后草稿跟着变成 `color, size`（证明修法没有把外部变更也锁死）。

### 5.2 F01 + F11 — 有损项补登记

- `integrationMappingTransform.ts:261-270` 的 KNOWN LOSS 注释从 2 项扩到 4 项，新增 `pattern.params.flags`（`validator.cjs:85-97` 用它 `new RegExp(pattern, flags)`）与任意规则的 `message`（`validator.cjs:59` 优先用它）。
- 设计文档 §5 同步这四项，并写明「有损方向是安全的那一侧」。
- 用例 `F01/F11: pattern flags and custom messages are DROPPED on read — the loss is asserted, not hidden`：先用真校验器证明**原始** payload 是大小写不敏感且用自定义文案，再证明**读回重发**后变成大小写敏感、退回引擎默认文案。有损行为被钉住而不是被描述。

### 5.3 F02 — 参数优先级严格照抄引擎

- `integrationMappingTransform.ts:298-303`：`isPlainObject(step.args) ? step.args : step`（原为 `{ ...step, ...nested }` 合并）。引擎 `normalizeTransformStep`（`transform-engine.cjs:131`）是**整体替换**。
- `integrationMappingTransform.ts:321-331`：`ruleParam` 改成顶层优先、params 其次，与 `normalizeRule`（`validator.cjs:42-46`「先复制 params 再用顶层覆盖」）同序。
- 两条对照用例都**跑真引擎**取期望值：
  - `F02: a step carrying BOTH args.* and top-level keys is read the way the engine reads it`（含判别用例 `{ args:{unrelated:1}, format:'date' }` → 引擎给整条 ISO，编辑器必须显示 iso）
  - `F02: a rule carrying BOTH a top-level and a params value is read the way the validator reads it`（`regex:'^TOP$'` vs `params.regex:'^NESTED$'` → 顶层赢）

### 5.4 F04 / F08 — 映射级默认值文案与语义

- `IntegrationMappingRulesSection.vue:155`（placeholder）与 `:157-163`（帮助文案）改为「来源为缺失/null/空字符串时生效；纯空格不算，需要请改用 defaultValue 转换步骤；值按字符串写入」。
- 用例 `F04/F08: the mapping-level default does NOT fire on a whitespace-only source value` 用真引擎钉住四种取值：`'   '` 保持原样、`''` 与缺失字段被顶上、纯空格经 `defaultValue` **步骤**才会被顶上。
- 说明：这条用例钉的是引擎语义（`isBlank` 与 `isBlankAfterTrim` 的差别），属于「引擎变了就红」的对照件，不是我方守卫，因此没有对应的变异探针——文案与它一致就是全部主张。

### 5.5 F07 — build 报错带行号

- `integrationMappingTransform.ts:231-253`：`buildFieldMappingPayload` 外层 try/catch，前缀 `第 N 条清洗规则（目标字段）：`，原文完整保留；目标/来源都空时用「未命名字段」。
- 用例 `F07: a build error names the row and keeps the original message verbatim`，同时断言 `pattern 正则无效` 子串仍在（§3 那条用例因此不红）。

### 5.6 终审指出的盲区 — 存库→回读→引擎整链

- 用例 `survives the API layer: normalizeFieldMappings -> transformRecord keeps chains and pins null defaults`：直接 `require` 注册层的 `pipelines.cjs` `__internals.normalizeFieldMappings`（不改 `plugins/`），把 UI payload 过一遍再喂 `transformRecord`。
- 钉住两件事：数组形转换链原样透传；**未填默认值的行在存库后变成 `defaultValue: null` 自有键**，于是同一行的缺值结果从存前的 `undefined` 变成存后的 `null`。设计文档新增 §5.2 记录这一跳。

### 5.7 追加（非阻断，但 G08 接线前必修）— dictMap 逆函数会损坏「键含 `=`」「值含换行」

审阅人追加的问题：`integrationMappingTransform.ts` 的 dictMap 逆函数是直白的 `` `${key}=${value}` ``，与正向 `parseDictionaryMap` 的约定对不上。

- **静默改写**：键为 `A=B` 的条目，序列化成 `A=B=<值>`，解析侧按第一个 `=` 切分 → 变成键 `A`、值 `B=<值>`。一次读回再保存，字典就悄悄换了一本。
- **要么炸要么裂**：值里含换行的条目，序列化后跨两行 → 下一次保存抛「dictMap 每行必须使用 source=target 格式」，或者第二行恰好含 `=` 时裂成一条伪条目。
- **首尾空格**：解析侧一律 trim，所以原 map 的 `' EA '` 读回来变成 `'EA'`——引擎按 `String(value)` 精确查键，能匹配的来源值因此变了。

修法（`integrationMappingTransform.ts:291-329` 的 `dictionaryMapToText`）：序列化只输出**解析侧能原样读回**的条目——键去 `=`、去换行、去空判断，键值先 trim 再拼；表示不了的条目整条跳过，并把原因写进 `EditableMapping.loadWarnings`（`:432` 挂载，`integrationWorkbenchSectionTypes.ts:74-77` / `IntegrationWorkbenchView.vue:585-586` 声明为可选、编辑器内部状态，永不下发）。trim 真的改动了键或值时也报一条 warning。极端情况下整本字典都不可表示 → 文本为空 → 下一次保存**响亮地**失败在「dictMap 字典映射不能为空」，而不是静默存成另一本。

三条往返用例（parity spec）：

| 用例名 | 钉住什么 |
| --- | --- |
| `round-trips a dictMap VALUE containing "=" (only the first "=" splits)` | 值里的 `=` **可以**保真：`{EA:'a=b'}` → 文本 `EA=a=b` → 原样回来，且引擎仍映射出 `a=b` |
| `skips (and reports) a dictMap entry the textarea convention cannot express` | 键含 `=`、值含换行、值纯空格三条各自被跳过并各产一条 warning，重发的 payload 只剩可表示的那条——**绝不**出现旧实现那种 `{ A: 'B=keyHasEquals' }` |
| `pins the dictMap trim loss: parse(serialize(map)) equals the TRIMMED map, and says so` | `parse(serialize(map))` 深等于 **trim 后**的 map；warning 里含「首尾空格」；并用真引擎对比 trim 前后 `' EA '` / `'EA'` 的匹配差异；第二遍往返稳定 |

本轮变异探针：

| 探针 | 改坏了什么 | 退出码 | 变红的测试 |
| --- | --- | --- | --- |
| dictMap-1 | 逆函数改回原始的 `` `${key}=${value}` ``（去掉 `=`/换行守卫与 trim 规范化） | 1 | `skips (and reports) a dictMap entry the textarea convention cannot express` |
| dictMap-2 | 条目照跳，但不再挂 `loadWarnings`（静默丢弃） | 1 | `skips (and reports) a dictMap entry the textarea convention cannot express` / `pins the dictMap trim loss: parse(serialize(map)) equals the TRIMMED map, and says so` |

dictMap-1 只打红一条是对的：值含 `=` 那条在新旧实现下都保真，trim 那条在旧实现下也仍然等于 trim 后的 map（差别只在有没有守卫），真正被旧实现破坏的是「键含 `=` / 值含换行」这条。还原后 `git status --porcelain` 与改之前一致。

**口径订正（本次订正，不改逻辑、不改测试断言语义）**：§5.7 这套修法的净效果是**有损转换并告警**，不是保真/无损修复——键含 `=`、值含换行、trim 后为空的条目仍然被整条跳过，只是跳过时会经 `loadWarnings` 说话，不再静默改写。dictMap 的正向解析器 `parseDictionaryMap`（`apps/web/src/components/integration/integrationMappingTransform.ts:114-123`）本就支持 JSON 对象文本（`trimmed.startsWith('{')` 分支直接 `JSON.parse`），逆函数 `dictionaryMapToText` 若改成输出 JSON 而不是逐行 `key=value`，即可经同一个解析器无损往返；本次未做这一步。**G08（存库→回读→引擎）接线前必须先解决 dictMap 的无损表示**，否则回填编辑器会让「编辑器里看不见的丢失」变成「读一次存一次就真丢了」。本 PR 不宣称无损完成。

### 5.8 本轮命令与退出码

| 命令（cwd） | 退出码 | 结果 |
| --- | --- | --- |
| `npx vitest run tests/integrationMappingTransformParity.spec.ts`（`apps/web`） | 0 | `30 passed (30)`（原 21 + 终审 6 + dictMap 3） |
| `npx vitest run tests/IntegrationMappingRulesSection.spec.ts`（`apps/web`） | 0 | `12 passed (12)`（原 10 + 新 2） |
| 四个 spec 一次跑（`apps/web`） | 0 | `Test Files 4 passed (4) / Tests 201 passed (201)` |
| `pnpm --filter web run type-check`（worktree 根） | 0 | 三个 tsconfig 全过 |
| `pnpm --filter web run lint`（worktree 根） | 0 | 同 §1 说明：改动文件不在该脚本的显式清单内 |

`tests/IntegrationWorkbenchView.spec.ts` 仍是一行未改的 52 条全绿，`tests/ui-foundation-style-guard.spec.ts` 107 条全绿。

### 5.9 本轮变异探针（同样是内存改写 + 逐字节还原）

| 探针 | 改坏了什么 | spec | 退出码 | 变红的测试 |
| --- | --- | --- | --- | --- |
| F06 | 回退输入改回绑派生值 `args.concatFields.join(', ')` + 不写草稿（**即修复前的原始实现**） | section | 1 | `keeps a trailing comma the operator just typed in the concat fallback input` |
| F02a | 步骤参数改回 `{ ...step, ...args }` 合并 | parity | 1 | `F02: a step carrying BOTH args.* and top-level keys is read the way the engine reads it` |
| F02b | 规则参数改回 params 优先 | parity | 1 | `F02: a rule carrying BOTH a top-level and a params value is read the way the validator reads it` |
| F07 | 去掉行号前缀，直接 `throw error` | parity | 1 | `F07: a build error names the row and keeps the original message verbatim` |
| API 层 | 映射级默认值无条件下发（去掉「只在填了才发」） | parity | 1 | `is byte-identical to the pre-G27 payload for an untouched row` / `adds the mapping-level defaultValue only when authored` / `survives the API layer: normalizeFieldMappings -> transformRecord keeps chains and pins null defaults` |

F06 那条探针值得单独说：它把代码改成的正是**修复前的实现**，红的正是新增的回归用例——即「这个 bug 如果再回来，测试会抓住」。还原后 `git status --porcelain` 与改之前一致，随后四个 spec 重跑 198 passed。

## 6. 环境噪声（与本次改动无关）

- vitest 启动时的 `WebSocket server error: Port is already in use` 每次都有，与本机另一个 vite 进程抢端口有关，不影响用例结果。
- `IntegrationWorkbenchView.spec.ts` 的 stderr 里有大量 `Failed to resolve component: el-icon / el-tooltip` 与 `SQLSERVER_TEST_FAILED: TLS/SSL ...` 字样，都是该 spec 既有的 mock 数据与未注册的 Element Plus 全局组件产生的，改动前后一致，用例本身 52/52 绿。
