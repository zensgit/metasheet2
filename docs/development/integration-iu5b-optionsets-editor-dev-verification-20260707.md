# IU-5b optionSets 结构化编辑器(集成 JSON textarea 站点 5)— 开发验证 — 2026-07-07

> 上位锁:`integration-ux-workbench-redesign-design-lock-20260706.md`(RATIFIED)§2 IU-5
> "JSON textarea 逐处结构化(门:IU-2 落地;**每处单独评估**);专家 JSON 模式保留切换"
> + 主循环对 5 处裸 JSON textarea 的逐处处置:站点 5(optionSets)= **真结构化编辑器**
> (闭形状,不同于站点 1-4 的开放/自由形 JSON-assist 处置)。
> D1(lane D part 1,#3838,IU-5a)落了站点 1-4 的 JSON-assist 形态,并把站点 5 DEFERRED
> 到本片(D2/IU-5b)——其宿主 panel(`IntegrationFieldOptionSyncPanel.vue`)当时在
> in-flight 未合并 PR #3822 中。#3822(IU-2d)已合并 main,门开;owner 2026-07-07 授权
> 本片。

## 0. 前提偏差说明(owner 应知)

任务前提写"D1 的 helper `jsonAssist.ts`/`JsonAssist.vue` 已随 #3838 落地"——**核实为
不准确**:开发时 `gh pr view 3838` 显示该 PR 仍是 **OPEN**(`mergedAt: null`),且与
当前 main **CONFLICTING**(`mergeable: CONFLICTING`,大概率因 #3838 与其他并行 PR
都改了 `IntegrationConnectionSection.vue`/`IntegrationPayloadPreviewSection.vue`)。
`IntegrationFieldOptionSyncPanel.vue`/`IntegrationWorkbenchView.vue` 两处 `#3838`
分支相对 origin/main **零 diff**(已核实),所以那两个共享 helper 文件本身与本片的
改动面无冲突——但它们物理上还不在 main 上。

处置(与 advisor 核对一致):**将 `jsonAssist.ts`(`apps/web/src/utils/`)与
`JsonAssist.vue`(`apps/web/src/components/integration/`)按字节复制**到本分支(取自
`claude/integration-iu5a-json-assist-20260707` 分支 tip,ff239cbdf),而不是把本分支
stack 在那个不稳定/冲突中的分支上。两个文件顶部各加了一段 D2 NOTE 注释,说明其为
#3838 的字节级复制。**结果**:#3838 与本 PR 无论谁先合并,另一个在落地时会在这两个
文件路径上遇到一次"双方都新增同一文件"的冲突——**内容完全相同,是纯机械 no-op
冲突**,直接保留任一份即可,不需要人工比对内容差异。这一排序留给 owner 决定;本片
的职责只是把这个依赖显著标注出来(此处 + PR 描述 + commit 消息)。

## 1. 结构化编辑器覆盖的"闭形状"契约

`apps/web/src/utils/optionSetsStructured.ts`(纯函数层,独立于 Vue,可直接单测):

```ts
interface OptionSetsOptionEntry { value: string; label: string; [key: string]: unknown }
interface OptionSetsFieldRow { fieldKey: string; options: OptionSetsOptionEntry[] }

parseOptionSets(text: string):
  | { ok: true; wrapped: boolean; rows: OptionSetsFieldRow[]; originalRecord: Record<string, unknown> }
  | { ok: false }

serializeOptionSets(rows, wrapped, originalRecord = {}): string   // JSON.stringify(_, null, 2)
findDuplicateFieldKeys(rows): string[]
```

**闭形状**(能被结构化编辑器接管的唯一形态):顶层是一个 JSON 对象,要么直接是
`{ [fieldKey]: OptionEntry[] }`(bare,无 `optionSets` 包装,匹配
`buildStockPreparationOptionSyncPayload` 现有的自动包装规则),要么是
`{ optionSets: { [fieldKey]: OptionEntry[] }, ...其他顶层键 }`(wrapped,匹配现有
`stockPreparationOptionSyncPlaceholder` 的形状)。每个 `OptionEntry` **必须**同时有
字符串类型的 `value`/`label`;`actionBindings` 等其他键允许存在但结构化编辑器不提供
行内编辑 UI——只保证透传不丢。

**不可结构化(判定 `{ ok: false }`,回落专家 JSON,不改动/不丢原文本)**:
- 非法 JSON(`JSON.parse` 抛错);
- 顶层不是对象(数组/字符串/数字/null);
- 顶层含 `optionSources` 或 `configInfo`(legacy alias 形态——是备料兼容路由认的另一
  套数据模型,不是本编辑器的形状,`syncFieldOptions` 里 `usesLegacyAliases` 分支就是
  为这套形态存在的);
- 某字段的值不是数组;
- 数组里某项不是纯对象,或 `value`/`label` 缺失/非字符串。

## 2. 结构化⇄JSON 映射与字节等价证明

- **序列化格式统一为** `JSON.stringify(doc, null, 2)`(与既有 placeholder /
  `formatJsonText` 同一规范格式)。
- **结构化 → JSON**:`serializeOptionSets(rows, wrapped, originalRecord)` —
  `map[row.fieldKey] = row.options`(数组引用不变,顺序=行数组顺序)→
  `wrapped ? { ...originalRecord, optionSets: map } : map`。
  `tests/utils/optionSetsStructured.spec.ts`(`is byte-identical to the raw textarea
  path for a fresh document`)与 `tests/IntegrationOptionSetsStructuredEditor.spec.ts`
  (`BYTE-EQUALITY: ...`,走真实 DOM 交互:点新增字段→填字段名→点新增选项→填
  value/label)都直接断言:结构化编辑产出的最终字符串与
  `JSON.stringify({ optionSets: { material_type: [{ value: 'plate', label: 'Plate' }] } }, null, 2)`
  **完全相等**——即用户直接在 textarea 里手打同样内容会得到的字节。
- **JSON → 结构化(幂等往返)**:`parseOptionSets(text)` 拿到的 `rows`/`options`
  条目**是原 `JSON.parse` 输出对象的引用,不克隆**——零编辑时
  `serializeOptionSets(parsed.rows, parsed.wrapped, parsed.originalRecord)` 与源
  文本逐字节相等(`round-trips a wrapped/bare document with zero edits` 两个测试)。
  边界情形(易错点,已专门钉住):`optionSets` 键**夹在两个 sibling 键中间**
  (`{ alpha, optionSets, zeta }`)时,朴素的 `{ ...extra, optionSets }` 重建会把
  `optionSets` 挪到最后,悄悄改变顶层键序——`serializeOptionSets` 用
  `{ ...originalRecord, optionSets: map }` 是安全的,因为 JS 对象字面量里**重复键
  取第一次出现的位置,只更新其值**;`preserves sibling top-level keys AND their
  original relative order` 测试直接断言重建结果的 `Object.keys(...)` 顺序仍是
  `['alpha', 'optionSets', 'zeta']`。
- **未建模的 option 额外键(如 `actionBindings`)**:`parseOptionSets` 不克隆条目对象,
  编辑时只 mutate `.value`/`.label` 两个已知键——所以 `actionBindings` 及其原始键序
  在任何"编辑其他行/其他字段"的操作后原样存活(`preserves unmodeled extra option
  keys` 测试:改了一个不相关字段后,`stock_preparation_status` 行的
  `actionBindings` 与键序 `['value','label','actionBindings']` 不变)。

## 3. 恶意/畸形 JSON 回落行为(不静默丢数据)

`IntegrationFieldOptionSyncPanel.vue` 挂载时用 `parseOptionSets(初始文本).ok` 一次性
(非响应式)决定初始 `mode`:能结构化 → `structured`(默认);不能 → 强制 `expert`,
且专家文本框显示的**就是原始文本本身,一个字节都不改**(`does not silently drop
the malformed text: it stays exactly in the model/textarea` 测试:mount 后
`textarea.value === malformed` 且 `onUpdate:...` 从未被调用过——没有"进入面板就悄悄
重写模型"这回事)。

从专家模式想切回结构化时(用户可能直接手改了 textarea),`isCurrentTextStructurable`
(只读 computed,读当前模型文本跑一次 `parseOptionSets`)门控切换按钮:不可结构化则
按钮 `disabled` + 显示 values-free 的
`field-options-structured-unavailable-hint`("当前内容不是结构化编辑器支持的字段
选项形状……");文本被修正为合法形状后按钮自动重新可点(`re-enables the toggle once
the expert-mode text is fixed into a structurable shape` 测试)。**从结构化切到专家
永远允许**(结构化编辑必然产出合法、可结构化的 JSON)。

结构化编辑器组件本身用 `v-if`(不是 `v-show`)挂载——每次真正"切进"结构化模式都是
全新实例、在 `setup()` 里对当时的模型文本解析一次;**没有"文本→行"的响应式
watcher**(避免与正在进行的行编辑互相打架、形成更新环——参考组件头注释与
advisor 复核意见)。反方向(行编辑→文本)则是每次 add/remove/输入操作后同步调用
`serializeOptionSets` 并 emit,模型与"能否运行同步"的 `stockPreparationOptionSyncCanRun`
等既有 computed 保持实时一致,和原始纯 textarea 的行为等价。

## 4. 专家模式保留(零降级)

- 原始 `<textarea data-testid="stock-option-sync-json">` **markup 原样保留**,只是
  外层 `<label>` 从"始终渲染"改成 `v-show="mode === 'expert'"`——**只切 CSS
  display,不摘出/重建 DOM 节点**,`data-testid`、`v-model` 绑定、既有 4 个测试全部
  **零改动通过**(`IntegrationFieldOptionSyncPanel.spec.ts` 既有断言逐字节未动;
  详见下方"既有断言"小节)。
- textarea 旁新挂了 D1 的 `<JsonAssist>`(格式化按钮 + 校验状态行),复用同一个
  `stockPreparationOptionSyncPlaceholder` 作为 values-free 占位示例——专家用户在
  这条路径上比 D1 之前更方便(能一键格式化),不是降级。
- 重复字段名(两行填了同一个 `fieldKey`)不阻断编辑,但会显示
  `option-sets-duplicate-warning`(values-free,不点名具体字段名/值)提示
  "序列化时只保留同名最后一行",避免用户以为两行都保存了却悄悄丢了一行——不是
  必需项,但延续本仓"不静默丢数据"的一贯纪律,成本很低就加上了。

## 5. SENTINEL(no-echo 安全线)

沿用 D1 建立的不变量:任何"校验/回落说明"文案都不得渲染用户输入内容本身。
- 组件层面从不消费 `error.message`(`parseOptionSets` 内部 `JSON.parse` 的 catch
  分支只返回 `{ ok: false }`,不转发任何 message 文本);
- `field-options-structured-unavailable-hint` 是固定文案,不插值任何解析出的字段名
  /值;`SENTINEL: a secret-shaped value in malformed JSON never leaks into the
  unavailable-mode hint` 测试用 `sk-SECRET-TOKEN-...` 构造畸形 JSON,断言该 hint、
  toggle 按钮文案、boundary 提示文案均不含该 secret;
  - 说明:测试**特意排除**了 textarea 自身的 `.value` DOM 属性——那是字段把用户
    自己输入的内容原样显示回给他自己,不是"泄漏进一条校验/错误提示行",这两者是
    本仓一贯区分的(与 JsonAssist 的 no-echo 哨兵同一原则,该组件本身也从不在状态
    行里回显 secret)。
- `option-sets-duplicate-warning` 同理:哪怕重复的字段行里塞了 secret 形文本,警告
  文案本身也是固定的、不插值任何 value/label 内容
  (`SENTINEL: a secret-shaped option value never leaks into the duplicate-warning
  hint text` + 纯函数层 `findDuplicateFieldKeys` 的同名哨兵测试)。

## 6. 测试证据(全部本地双 Node 跑绿)

| 面 | 内容 | 结果 |
| --- | --- | --- |
| 纯函数层 `tests/utils/optionSetsStructured.spec.ts` | `parseOptionSets`(空/wrapped/bare/多字段顺序/actionBindings 保留/非法 JSON/非对象/legacy alias/非数组/缺 value-label/非字符串)11 + `serializeOptionSets`(字节等价/wrapped 幂等/bare 幂等/sibling 键序/行编辑反映/零行文档)6 + `findDuplicateFieldKeys`(唯一/重复/SENTINEL)3 | 20/20 ✅ |
| 组件层 `tests/IntegrationOptionSetsStructuredEditor.spec.ts` | 空态提示/BYTE-EQUALITY/加字段加选项/删选项删字段/actionBindings 保留/重复警告+改名后清除/SENTINEL/zh | 8/8 ✅ |
| 宿主 panel `tests/IntegrationFieldOptionSyncPanel.spec.ts` | **既有 4 个测试逐字节未改**,新增 8 个(默认结构化/切专家显示 JsonAssist/来回切换往返/畸形强制专家+禁用切换/不静默丢畸形文本/修正后重新启用切换/SENTINEL/zh) | 4(existing)+ 8(D2 new)= 12/12 ✅ |
| integration-guard.yml 全清单(含本片 3 个新增 spec 名) | 26 个 spec 文件,default Node(v25)与 Node 20(nvm)双跑 | 277/277 ×2 ✅ |
| `plugin-integration-core` CJS 链 | guard 另一腿(本片零后端改动,回归确认) | 全绿 ✅ |
| UF-6 style guard(`ui-foundation-style-guard.spec.ts`) | `IntegrationFieldOptionSyncPanel.vue` 已在既有 ratchet 清单里;改动后仍 0 hex/rgb | 77/77 ✅(未新增文件到该 ratchet——不在本片 CI 面内,后续如需可另开) |
| `vue-tsc -b` | 全仓 web typecheck | 0 错误 ✅(default Node + Node 20) |
| `vite build` | 生产构建 | ✅(default Node + Node 20) |

CI 面:`integration-guard.yml` 修复了一处既存的 YAML **重复 `run:` key** bug(#3822
落地时的一次并发合并遗留——两条 `run:` 行只有后一条生效,前一条列表里的
`IntegrationBridgeAgentSection` 曾经"看起来在跑但其实没跑"),收敛为两条清单的
**并集** + 本片新增的 3 个 spec 名(`IntegrationOptionSetsStructuredEditor`
`optionSetsStructured` 已验证一个 token 同时命中两个新 spec 文件路径)。path filter
新增 4 个文件(`IntegrationOptionSetsStructuredEditor.vue` / `optionSetsStructured.ts`
+ 复制来的 `JsonAssist.vue` / `jsonAssist.ts`)。

## 7. 既有断言(#3822 遗留)未受影响的原因

`IntegrationFieldOptionSyncPanel.spec.ts` 既有 4 个测试**逐字节未修改**:
1. `renders the panel...RAW optionSets JSON textarea` —— `querySelector` 找 textarea
   + 断言 `tagName === 'TEXTAREA'`:`v-show`(非 `v-if`)保证元素**始终在 DOM 里**,
   查询不受当前 mode 影响,继续通过。
2. `renders NOTHING without integration:admin` —— 根 `v-if` 未动,继续通过。
3. `honours the can-run disable gate...` —— 与本片改动的 testid 无交集,继续通过。
4. `forwards textarea edits through update:...(defineModel wiring)` ——
   直接对 textarea dispatch 原生 `input` 事件;`v-show` 不摘监听器,`v-model` 仍然
   活着,继续通过。

**没有任何既有断言需要改成"专家模式默认"或其他妥协**——结构化默认 + 专家可达两个
目标同时满足,零冲突。

## 8. 边界与后续

- 不做:per-option `actionBindings` 的行内编辑 UI(仍需专家 JSON 编辑;结构化编辑器
  只保证透传不丢——泛化到 UI 属于 FOS-4 范畴,不是本片目标);字段级/kind 级 schema
  校验(与站点 1-4 一致,后端/save 路径判定不变);`optionSources`/`configInfo`
  legacy alias 的结构化(仍走专家 JSON,兼容路由本身零改动)。
- **零后端/service 改动**:`syncFieldOptions`/`buildStockPreparationOptionSyncPayload`
  /两条路由分派逻辑一个字节未碰;结构化编辑器只是把
  `stockPreparationOptionSyncText` 这个既有字符串模型的另一种编辑入口。
- IU-5 五个站点(1-4 由 D1/#3838 JSON-assist,5 由本片/D2 结构化编辑器)至此**全部
  处置完毕**——design-lock §2 IU-5 这一条切片阶梯收口,前提是 #3838 落地(见 §0
  偏差说明,排序留给 owner)。
