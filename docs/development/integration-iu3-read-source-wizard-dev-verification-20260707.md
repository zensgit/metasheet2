# IU-3 读取源配置四步向导 — DEV VERIFICATION — 2026-07-07

> Design-lock: `integration-iu3-read-source-wizard-design-lock-20260707.md`（#3797 merged, owner
> granted implementation 2026-07-07）。Umbrella: `integration-ux-workbench-redesign-design-lock-20260706.md`
> (RATIFIED) §2 IU-3。本 MD 按锁 §3 的验收清单交付证据。

## 1. 改动清单

| 文件 | 变化 |
| --- | --- |
| `apps/web/src/services/integration/readSourceModePresets.ts` | **新增**：四张 preset 卡片元数据模块（errorCodeLabels 同风格，zh+en，values-free） |
| `apps/web/src/components/integration/IntegrationReadSourceWizard.vue` | **新增**：el-steps 四步向导组件（纯重排壳，零 service 调用） |
| `apps/web/src/components/integration/IntegrationReadSourceConfigPanel.vue` | 向导设为默认新建面 + `专家表单` 切换；新 `initialViewMode` prop；`evidenceContainers` 计算逻辑抽为共享纯 helper；新增 `approveSavedResult()`（复用既有 `approveReadSourceConfig`+`refresh`）。**平铺表单本体一行未动** |
| `apps/web/src/services/integration/readSourceConfigs.ts` | 仅新增导出 `deriveReadSourceProbeEvidenceContainers`（从 panel 抽出的纯 shaping helper，行为逐字节相同）；其余全部不动 |
| `apps/web/tests/readSourceModePresets.spec.ts` | **新增**：preset↔mode tripwire 测试 |
| `apps/web/tests/IntegrationReadSourceWizard.spec.ts` | **新增**：向导 11 条组件测试（含两条字节等价） |
| `apps/web/tests/IntegrationReadSourceConfigPanel.spec.ts` | 仅 `mountPanel()` 增加 `initialViewMode: 'expert'` prop（注释说明）；**零断言变化**（锁 §2 既有测试不变量）— diff 全文只有该 helper 一处 |
| `apps/web/tests/ui-foundation-style-guard.spec.ts` | TARGET_FILES += 向导组件（token-only 门覆盖新文件） |
| `.github/workflows/integration-guard.yml` | path filters + vitest 名单加入新 source/spec 文件 |

## 2. 四步向导 step map（锁 §1 交互骨架 → 实现）

| 锁定步骤 | 实现 | 关键 testid |
| --- | --- | --- |
| ① 选系统 | 已注册 external-system 卡片点选；选中即把 `systemId` + `requiredKind`（=该系统 `kind`，即兼容适配器过滤的机制——config 只能消费所选系统的 kind，与专家表单 `onSystemChange` 完全同映射）写入共享 draft；未选不可下一步 | `rsc-wizard-system-<id>`、`rsc-wizard-next` |
| ② 定形状 | 四张 preset 卡片（非裸 mode 下拉）；选定后**只展开该 mode `MODE_REQUIRED_FIELDS` 的必填字段**（卡片展示的 requiredFieldKeys 与实际渲染字段读同一个 computed，不可能漂移）；可选字段全部折叠进「高级」区：keyEncoding / resolver 多重性细项（排序字段/方向、判别字段/值）/ 多 fieldMap / detail_with_lines 的可选 keyField / readMethod / version（后两者为专家面能力对齐，保证向导可表达专家面全配置空间→字节等价普适成立）；校验不清零不可下一步 | `rsc-wizard-mode-<mode>`、`rsc-wizard-advanced-toggle`、`rsc-wizard-validation` |
| ③ 探测 | 复用面板既有 `runProbe()`（emit 上抛，同一函数）；证据卡片化：人话结论（IU-1 `integrationErrorCodeDisplayLabel`/`integrationErrorCodeHint`）+ 容器/形状可视 + 机器码折叠进 `<details>`（默认收起，排障可展开）；失败时 hint 即下一步建议（IU-1 模块自带） | `rsc-wizard-probe-run`、`rsc-wizard-evidence-summary`、`rsc-wizard-evidence-raw` |
| ④ 审批 | 复用面板既有 `saveVersion()`；保存成功后出现「提交审批」按钮 → `approveSavedResult()` 走既有 `approveReadSourceConfig` + `refresh()`（与列表行审批按钮同一 service 调用、同 confirm 守卫）；提交只在末步 | `rsc-wizard-save`、`rsc-wizard-approve` |

上一步可回改（`rsc-wizard-back`，状态保留，golden 覆盖）；步进指示用 `el-steps`（装饰层；导航由原生按钮驱动，测试环境无 EP 也全功能）。

## 3. preset 模块契约（锁 §2 "展示层映射，非新契约"）

- 卡片 id 集 = `READ_SOURCE_MODES` 原样四值（`single_record`/`list_page`/`detail_with_lines`/`resolver_lookup`），**不新增 mode**。
- 每张卡 `requiredFieldKeys` **就是** `READ_SOURCE_MODE_REQUIRED_FIELDS[mode]` 的同一数组引用（import 真源，非手抄副本），**不改 MODE_REQUIRED_FIELDS**。
- 数组由 `READ_SOURCE_MODES.map(...)` 构建，缺卡片在 **import 时 throw**（dev/build 立红）。
- 文案 zh+en、values-free（只描述读形状，零业务值示例）。

## 4. tripwire 说明 + mutation 证明

`readSourceModePresets.spec.ts` 三道闸：

1. **mode 集合 tripwire**：`READ_SOURCE_MODE_PRESETS.map(id) toEqual [...READ_SOURCE_MODES]`（双向集合等价 + 顺序）——未来加 mode 未配卡片 → 红。
2. **requiredFieldKeys 恒等 tripwire**：逐 mode `toBe`（引用恒等，非仅 deep-equal）——换成手抄副本即红，漂移在结构上不可能。
3. 文案非空（zh+en 四字段）。

Mutation 证明（每次单独注入 → 跑测 → revert，工作**先提交后做实验**）：

| # | 注入 | 结果 |
| --- | --- | --- |
| M1 | `requiredFieldKeys: [...REAL[mode]]`（改为拷贝） | 恒等 tripwire 红（1 failed） |
| M2 | preset 构建 `slice(0, 3)`（丢一张卡） | 集合 tripwire 红（2 failed） |
| M3 | 向导 `selectSystem` 写 `kind.toUpperCase()`（与专家面分叉） | 字节等价 ×2 + probe-body 断言红（3 failed） |
| M4 | 向导 style 块注入 `#4b5563` | ui-foundation-style-guard 红（1 failed） |

## 5. 字节等价证明（锁 §2 首条硬锁）

`IntegrationReadSourceWizard.spec.ts` 两条 `BYTE-EQUALITY` 测试：同一组输入分别**从真实 DOM** 驱动
(a) 默认向导面（四步走完 → 保存）与 (b) `initialViewMode='expert'` 平铺面（同字段 → 保存），
在 apiFetch mock 层截获两次 POST 的 **raw body 字符串**，断言 `wizardBody === expertBody`
（字符串逐字节相等，非 deep-equal），再对 body 做整体形状断言防"两个空对象相等"假阳性。

- 场景 1：`single_record` 含高级字段（keyEncoding=numeric_id、readMethod=GET、带空白的 fieldMap → 验证 trim 归一同路）。
- 场景 2：`resolver_lookup`/`field_equals`（判别字段/值 + 单 fieldMap）。

结构上的因：两面共写**同一个** reactive draft、共走**同一个** `buildReadSourceConfigPayload`（仅在
panel 调用，本身未改）——测试把这个论证钉成经验事实（M3 证明测试确实咬人）。

## 6. 零后端/契约变化声明

- 本 PR **不含任何** `plugins/`、路由、validator、wire 形状改动：`readSourceConfigs.ts` 的 API 函数
  （list/save/approve/retire/audit/probe）、S1 validator（`validateReadSourceDraft` + server 侧）、
  probe 路由、审批路径全部原样；唯一 service 层 diff 是新增导出的纯 shaping helper（§1）。
- 向导所有动作 emit 到 panel 的**既有**函数（`runProbe`/`saveVersion`/`approveReadSourceConfig`）；
  没有新 fetch 调用点。
- 探测证据仍全部经由既有 allowlist normalizer（`normalizeReadSourceProbeEvidence`）后才进模板；
  人话层只消费 IU-1 注册闭词表；raw errorMessage 依旧无渲染路径。

## 7. 专家模式保留证明（折叠≠删除）

- 平铺表单 DOM/逻辑**逐行未动**（diff 上只被 `<template v-else>` 包裹 + 顶部加 toggle）；
- 既有 `IntegrationReadSourceConfigPanel.spec.ts` 的**全部断言原文通过**（唯一 diff = mount helper 加
  `initialViewMode: 'expert'` prop，锁明示允许的 stub/prop 附加，注释注明）；
- 向导 spec 的 expert-toggle golden：默认向导 → 点 `rsc-mode-toggle` → 14 个平铺面签名 testid 全在 →
  再点回向导。

## 8. el-*/token 覆盖 + 图标

- 新组件样式 **零 hex/零 rgb()**，全部 `var(--ms-*)`；已加入 `ui-foundation-style-guard.spec.ts`
  TARGET_FILES（M4 证明闸有效）。panel 内新增 toggle 样式同样 token-only（该文件存量 hex 属 IU-2
  范围，未触碰）。
- 图标全走 Element Plus SVG（`@element-plus/icons-vue`：Check/ArrowDown/ArrowRight/CircleCheck/
  WarningFilled/Setting/MagicStick）。
- `el-steps`/`el-step` 测试 stub 走 IU-2a ElCard stub 同法（spec 头注释说明）。

## 9. 测试与双 Node 结果

| 检查 | Node 20 (v20.20.2) | 默认 (v25.9.0) |
| --- | --- | --- |
| integration-guard web 名单（20 spec files，含新 2 个） | **219/219 绿** | **219/219 绿** |
| `pnpm --filter plugin-integration-core test`（35 CJS suites） | 全 OK | 全 OK |
| `vue-tsc -b` | — | clean |
| `vite build`（`pnpm build`） | — | 成功 |

新增测试：`readSourceModePresets.spec.ts` 4 条；`IntegrationReadSourceWizard.spec.ts` 11 条
（默认面 golden、步进门 ×2、四模式字段展开、回退保态、探测人话证据+折叠机器码+probe 契约体、
save→approve 既有路径+confirm 守卫、字节等价 ×2、expert 切换、zh 文案——zh 走
`useLocale().setLocale` 模式，与 panel spec 同法）。

## 10. 边界内自查

不含：新读取模式、后端/契约/审批路径改动、组合向导（IU-4）、JSON 结构化（IU-5）、移动端。
锁外未加能力；锁内无未满足条款。
