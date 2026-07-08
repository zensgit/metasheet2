# TC-1 连接器/体验模板目录 — seed-the-wizard v1 — 开发验证 — 2026-07-08

> 落地范围:governing design-lock `docs/development/integration-connector-template-catalog-design-lock-20260708.md`
> (#3879)§4 阶梯的 **TC-1**。排序门(BA-apply 与 W2 均已落地)owner 于 2026-07-08 确认已满足
> (`BA-APPLY-1` #3894 merged)。本文件是该 design-lock §5 要求的验证 MD。

## 0. 一句话摘要

新增一个 values-free 的模板目录模块(`readSourceTemplateCatalog.ts`,8 条目)+ 一个折叠默认的
"从模板开始"选卡 UI(`IntegrationTemplateCatalogPicker.vue`),ADD-ONLY 接入既有读取源配置面板
(`IntegrationReadSourceConfigPanel.vue`)与组合配置面板
(`IntegrationReadSourceCompositionAuthoringPanel.vue`)。选中一张卡只做一件事:把既有向导 draft
的**恰好一个字段**设为目标值(`mode` 或 `sourceTarget`),然后把视图切回向导 —— 不新增后端、不新增
runtime、不新增连接种类/读取模式/组合形状、不改向导内部逻辑。

## 1. 目录条目契约

`apps/web/src/services/integration/readSourceTemplateCatalog.ts` 导出
`INTEGRATION_TEMPLATE_CATALOG: readonly IntegrationTemplateCatalogEntry[]`(8 条),每条形状:

```ts
{
  id: string                    // kebab-case,如 'k3-wise-webapi-single-record'
  title: { zh, en }
  oneLiner: { zh, en }
  targetKind: string            // 描述性元数据 only —— 从不写入 draft
  seedsWizard: 'read-source' | 'composition' | 'bridge'
  seed: { mode } | { sourceTarget } | { kind }   // 按 seedsWizard 判别的种子形状
  requiredFieldKeys: string[]   // 直读真源,见 §3
}
```

v1 覆盖集合(design-lock §1 表 × 本次开发指示 "Cover: ..." 全覆盖):

| id | seedsWizard | targetKind | seed |
| --- | --- | --- | --- |
| `k3-wise-webapi-single-record` | read-source | `erp:k3-wise-webapi` | `{ mode: 'single_record' }` |
| `k3-wise-sqlserver-list-page` | read-source | `erp:k3-wise-sqlserver` | `{ mode: 'list_page' }` |
| `bridge-legacy-sql-readonly` | bridge | `bridge:legacy-sql-readonly` | `{ kind: 'bridge:legacy-sql-readonly' }` |
| `http-read-single-record` | read-source | `http` | `{ mode: 'single_record' }` |
| `http-read-list-page` | read-source | `http` | `{ mode: 'list_page' }` |
| `http-read-detail-with-lines` | read-source | `http` | `{ mode: 'detail_with_lines' }` |
| `http-read-resolver-lookup` | read-source | `http` | `{ mode: 'resolver_lookup' }` |
| `two-hop-composition` | composition | `composition:two-hop` | `{ sourceTarget: 'internal_id' }` |

`targetKind` 是描述性字段(标注这个模板适配哪种既有连接 kind),**从不**写入 draft ——
真实的 `systemId`/`requiredKind` 永远来自用户挑选一个已注册的外部系统(租户数据),模板不能、也
不应该替用户预先决定"用哪个系统实例"。K3 WISE WebAPI 模板与通用 HTTP 的 `single_record` 模板
seed 字段值相同(`{ mode: 'single_record' }`)—— 这是设计使然,不是疏漏:read-source 向导的种子
被刻意收窄为向导 `selectMode()` 真正会设置的唯一字段,连接器差异只体现在 `title`/`oneLiner`/
`targetKind` 这些展示层信息里,不体现在 seed 里(见 §2 round-trip 论证)。

## 2. Seed round-trip golden(design-lock §5.1)

`seedReadSourceDraft(draft, entry)` 的全部实现是:

```ts
draft.mode = entry.seed.mode
```

—— 与 `IntegrationReadSourceWizard.vue` 自己的 `selectMode()` **字面相同**的赋值。
`seedCompositionDraft` 同理只赋 `draft.sourceTarget`,与
`IntegrationReadSourceCompositionAuthoringPanel.vue` 面板级默认赋值(`draft.sourceTarget =
'internal_id'`)一致。

`apps/web/tests/readSourceTemplateCatalog.spec.ts` 的 `describe('round-trip golden: ...')`
对**每一个** read-source 条目、以及 composition 条目做:

```ts
const seeded = createReadSourceConfigDraft(); seedReadSourceDraft(seeded, entry)
const manual = createReadSourceConfigDraft(); manual.mode = entry.seed.mode
expect(seeded).toEqual(manual)   // 深等价,不是子集比较
```

组件层再证一次、且是**非平凡**版本(design-lock 要求証明"预填"是真实可观察的变化,不是恰好等于
默认值的假阳性):`IntegrationCompositionWizard.spec.ts` 的
`'TC-1: selecting the two-hop composition template seeds sourceTarget back to the EXACT default...'`
先手动把 `sourceTarget` 改成 `'diverged_value'`,再点模板卡,断言回到 `'internal_id'` 且不再包含
`'diverged_value'` —— 证明这是一次真实的、可观察的状态注入,不是"本来就相等"的空转。
`IntegrationReadSourceWizard.spec.ts` 的
`'TC-1: selecting a read-source template card seeds draft.mode to EXACTLY what manually clicking...'`
在**先点模板、后选系统**的顺序下断言到达 step 2 时 `list_page` 卡为 selected 且字段集
(仅 containerPaths,无 keyField/resolverRule)与既有"手动点卡"用例断言的字段集完全一致。

## 3. 单一真源(design-lock §2/§3 硬锁)

- **read-source 条目**:`requiredFieldKeys` 直接是 `readSourceModePreset(mode).requiredFieldKeys`
  的**同一个引用**(该值本身就是 `READ_SOURCE_MODE_REQUIRED_FIELDS[mode]`)。
  `readSourceTemplateCatalog.spec.ts` 用 `toBe`(引用相等)断言,不是 `toEqual`(结构相等)——
  一份"恰好长得一样"的手抄副本也会在这条测试下失败。`title`/`oneLiner` 同样从
  `readSourceModePreset(mode).title`/`.oneLiner` 组合而来(测试用 `toContain` 断言目录文案
  确实包含真源 preset 的文案),不是重新描述一遍"单记录读是什么"。
- **bridge 条目**:新增 `BRIDGE_AGENT_KIND` / `BRIDGE_AGENT_REQUIRED_CONFIG_FIELDS` 两个导出常量到
  `bridgeAgentConfigCheck.ts`(纯前端模块,零后端),并把原先内联在 `firstBaseUrlLike` 里的三行
  `if` 改写成对 `BRIDGE_AGENT_REQUIRED_CONFIG_FIELDS` 的循环 —— **行为完全不变**
  (`bridgeAgentConfigCheck.spec.ts` 75 个既有用例改动前后全绿,含 baseUrl/bridgeUrl/url 三路
  fallback 的既有断言)。目录的 `seed.kind`/`targetKind`/`requiredFieldKeys` 现在读的是这两个真实
  常量,不是手抄的字符串/数组。
- **composition 条目**:`requiredFieldKeys` = `Object.keys(createReadSourceCompositionDraft())`
  —— 派生自真实 draft 工厂函数自己的字段集,不是手写列表;工厂新增/删减字段会自动反映到这里。
- **模式集合覆盖**:每个 read-source 条目的构造都要经过 `readSourceModePreset(mode)`——
  该函数本身在 mode 未注册时 import 期即 throw(见 `readSourceModePresets.ts` 既有 tripwire)。
  目录因此天然继承"引用了不存在的 mode 必须编译期红"这一硬约束,不需要重新发明一遍。
  `readSourceTemplateCatalog.spec.ts` 额外断言每个 read-source 条目的 `seed.mode` ∈ 真实
  `READ_SOURCE_MODES` 集合。目录是 main 能力集合的**子集投影**(design-lock §1):未来 main 新增
  mode/kind 而目录未收录不会变红,只有目录引用不存在的值才会红。

## 4. 零后端/runtime 变化

```
$ git status --porcelain（本分支相对 origin/main 的全部改动）
 M .github/workflows/integration-guard.yml
 M apps/web/src/components/integration/IntegrationReadSourceCompositionAuthoringPanel.vue
 M apps/web/src/components/integration/IntegrationReadSourceConfigPanel.vue
 M apps/web/src/services/integration/bridgeAgentConfigCheck.ts
 M apps/web/tests/IntegrationCompositionWizard.spec.ts
 M apps/web/tests/IntegrationReadSourceWizard.spec.ts
?? apps/web/src/components/integration/IntegrationTemplateCatalogPicker.vue
?? apps/web/src/services/integration/readSourceTemplateCatalog.ts
?? apps/web/tests/IntegrationTemplateCatalogPicker.spec.ts
?? apps/web/tests/readSourceTemplateCatalog.spec.ts
?? docs/development/integration-tc1-template-catalog-dev-verification-20260708.md
```

无 `plugins/**`、无路由、无 migration、无 adapter/kind/mode 改动。`bridgeAgentConfigCheck.ts` 的
改动是纯前端模块内的常量导出 + 行为不变的重构(见 §3、既有 75 用例全绿)。

**既有向导/面板 spec 存量断言零改动**(design-lock §5.4):在接入 picker 之前先跑通
`IntegrationReadSourceWizard.spec.ts` / `IntegrationCompositionWizard.spec.ts` /
`IntegrationReadSourceConfigPanel.spec.ts` / `IntegrationReadSourceCompositionAuthoringPanel.spec.ts`
四个既有 spec(48 用例全绿),接入后**只追加**新的 `it(...)` 块(TC-1 前缀),未修改任何既有断言 ——
picker 默认折叠(`display:none`),不占用任何既有 data-testid,不改变任何既有渲染顺序。

## 5. values-free

`readSourceTemplateCatalog.spec.ts` 的 `'VALUES-FREE: ...'` 用例对每个条目的
`title`/`oneLiner`/`seed` 全部字符串字段做 5 类 sentinel 扫描:digit-run>4、`https?://`、
类域名形状、IPv4 形状、凭据关键词(password/secret/token/apikey/authorization/credential)。
目录文案全部停留在"形状"层面(如"单记录读"/"两跳组合"),从不出现具体 material/host/tenant/
库名/URL/凭据 —— 连示例都不出现(design-lock §3:"连'示例凭据'都不允许")。composition 条目的
`seed.sourceTarget = 'internal_id'` 与 bridge 条目的 `requiredFieldKeys =
['baseUrl','bridgeUrl','url']` 都是字段**名**(标识符),不是字段**值**。

## 6. 测试汇总

| 文件 | 用例数 | 内容 |
| --- | --- | --- |
| `apps/web/tests/readSourceTemplateCatalog.spec.ts`(新) | 19 | 契约/单一真源(3 类)/values-free/round-trip golden(read-source × composition)/覆盖断言 |
| `apps/web/tests/IntegrationTemplateCatalogPicker.spec.ts`(新) | 5 | picker 独立契约:折叠默认、按 seedsWizard 过滤、emit、zh 文案 |
| `apps/web/tests/IntegrationReadSourceWizard.spec.ts`(ADD-ONLY +4) | 15(11 既有 + 4 新) | picker 折叠默认不扰动既有默认路径、seed round-trip DOM 证明、expert→wizard 强制切回、zh 文案 |
| `apps/web/tests/IntegrationCompositionWizard.spec.ts`(ADD-ONLY +4) | 14(10 既有 + 4 新) | 同上,组合向导侧;含"先手动改值再选模板"非平凡 round-trip |
| `apps/web/tests/bridgeAgentConfigCheck.spec.ts`(未改动,重跑确认) | 75 | 确认 `firstBaseUrlLike` 重构后行为不变 |
| `apps/web/tests/IntegrationReadSourceConfigPanel.spec.ts` / `IntegrationReadSourceCompositionAuthoringPanel.spec.ts`(未改动,重跑确认) | 既有全部 | 确认 picker 接入未扰动 expert-mode 既有断言 |

全量 targeted 集合(镜像 `integration-guard.yml` 的单一 `run:` 行)本地跑:36 test files / 515
tests 全绿。`vue-tsc -b` 干净;`vite build` 成功。

## 7. Bridge 模板的 v1 UI 范围说明(明确的作用域取舍)

`bridge-legacy-sql-readonly` 条目在目录**数据**层完整(覆盖设计锁 v1 候选集的 bridge 行,
requiredFieldKeys/kind 均单一真源),并在 `IntegrationTemplateCatalogPicker.spec.ts` 里以
`seeds-wizard="bridge"` 的独立 picker 实例验证可渲染。但 **TC-1 没有把交互式选卡接入
Bridge-Agent 分区**(`IntegrationBridgeAgentSection.vue`)—— 该分区是对已连接实例的只读观测/探测
(BA-UI-1..3),没有一个"新建"authoring draft 可供预填;为它发明一个可预填的表单会违反
"复用不重建"硬锁。这是一个明确的、有意的 v1 范围取舍,不是遗漏 —— 记录于此供 TC-2+ 参考
(TC-2 若要做"选模板→深链到该分区"的引导流,可以复用本条目已有的 `seed.kind`)。

## 8. 后续(design-lock §4,本文不授权任何一级)

TC-2(onboarding 引导流,骑既有 probe / BA-UI-2)、TC-3+(新增模板批次、目录内搜索/分类)均为
**各自独立、之后、显式的 opt-in**;marketplace / 客户自建模板不在 v1 范围内(design-lock §6)。
本文件只覆盖 TC-1。
