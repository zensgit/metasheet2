# IU-4 组合配置三步向导 — DEV VERIFICATION — 2026-07-07

> Design-lock: `integration-iu4-composition-wizard-design-lock-20260707.md`（#3803 merged, owner
> 2026-07-07 授权本线全部开发；实现门 = IU-3 落地）。Sibling: `integration-iu3-read-source-wizard-design-lock-20260707.md`
> (#3797/#3821 landed)。本 MD 按锁 §3 的验收清单交付证据。

## 1. 改动清单

| 文件 | 变化 |
| --- | --- |
| `apps/web/src/components/integration/IntegrationCompositionWizard.vue` | **新增**：el-steps 三步向导组件（纯重排壳，零 service 调用） |
| `apps/web/src/components/integration/IntegrationReadSourceCompositionAuthoringPanel.vue` | 向导设为默认新建面 + `专家表单` 切换；新 `initialViewMode` prop。**平铺表单本体一行未动**（`draft`/`resolverConfigs`/`save()`/`savedRow` 审批-停用-审计区全部原样） |
| `apps/web/src/services/integration/readSourceCompositions.ts` | **未改动**（零后端/契约变化，锁 §2 首条硬锁） |
| `apps/web/tests/IntegrationCompositionWizard.spec.ts` | **新增**：向导 10 条组件测试（含 1 条字节等价 + 1 条 step-3 内审批） |
| `apps/web/tests/IntegrationReadSourceCompositionAuthoringPanel.spec.ts` | 仅 `mountPanel()` 增加 `initialViewMode: 'expert'` prop（注释说明）；**零断言变化**（锁 §2 既有测试不变量）— diff 全文只有该一行 |
| `apps/web/tests/ui-foundation-style-guard.spec.ts` | TARGET_FILES += 向导组件（token-only 门覆盖新文件） |
| `.github/workflows/integration-guard.yml` | path filters 加入新 source/spec 文件；**顺带修复**一个既有缺陷（见 §6） |

## 2. 三步向导 step map（锁 §1 交互骨架 → 实现）

| 锁定步骤 | 实现 | 关键 testid |
| --- | --- | --- |
| ① 选两跳 | 从父面板既有 `resolverConfigs`（已按 `status=approved` 查询 + `mode==='resolver_lookup'` 客户端过滤，flat 表单同一份引用）渲染两组卡片（hop1/hop2，同一份 configs 列表），点选写入共享 draft 的 `step1ConfigId`/`step2ConfigId`；两跳都选定且不相同才可下一步（相同会给出内联提示，不阻断修正） | `iu4-wizard-hop1-<id>`、`iu4-wizard-hop2-<id>`、`iu4-wizard-hop-same-hint`、`iu4-wizard-next` |
| ② 接线可视 | 固定两节点+一条连线的静态示意图：hop1 节点显示其 `id·object` 与「输出字段」= `draft.sourceTarget`（可编辑输入框，紧邻示意图，非画布内编辑）；hop2 节点显示其 `id·object` 与「key 输入」= 固定常量 `key`（composition payload 的 `toInput` 本就是编译期常量，不是任何 config 字段，故不存在"读不到"的问题）；sourceTarget 非空才可下一步 | `iu4-wizard-wiring`、`iu4-wizard-wiring-hop1`/`-hop2`、`iu4-wizard-wiring-output`、`iu4-wizard-wiring-input`、`iu4-wizard-source-target` |
| ③ 审批 | name 输入 + 复用父面板既有 `save()`（emit 上抛，同一函数，同一 `saveReadSourceCompositionVersion` 调用）；保存出现 `status==='draft'` 的行后，同一步内出现「提交审批」按钮，emit 上抛到父面板既有 `approve()`（同一 `approveReadSourceComposition` 调用 + 同一 `window.confirm` 守卫，与既有「已保存组合」侧栏的审批按钮**同一函数、两个入口**，同 IU-3 step-4 save/approve 手法）；一旦已审批，按钮退场，之后的停用/审计仍只在侧栏（`rscauth-saved`，与视图模式无关地始终渲染） | `iu4-wizard-name`、`iu4-wizard-save`、`iu4-wizard-approve`、`iu4-wizard-save-result`、`iu4-wizard-permission-hint` |

上一步可回改（`iu4-wizard-back`，状态保留）；步进指示用 `el-steps`（装饰层；导航由原生按钮驱动，测试环境无 EP 也全功能，同 IU-3 手法）。

## 3. hop 过滤行为（锁 §1 "仅 resolver_lookup 类可作 hop"）

- 过滤本身是父面板 `refreshPickers()` 的**既有**逻辑（`rows.filter(row => row.mode === 'resolver_lookup')`，配合 server 端 `status=approved` 查询参数）——向导**不新增**过滤规则，只消费同一份 `resolverConfigs` 数组作为两组卡片的数据源（展示层，锁 §1 "既有约束，展示层过滤"）。
- `IntegrationCompositionWizard.spec.ts`「hop selection filters to composable configs」用与既有 `IntegrationReadSourceCompositionAuthoringPanel.spec.ts`「lists ONLY approved resolver_lookup configs」相同的 4 行 mock 夹具（含 1 条 approved/wrong-mode 行 + 1 条 draft/resolver_lookup 行）验证：两个 hop 卡片网格都只出现 2 条合规行。
- Mutation 证明（M3，见 §7）：把 `refreshPickers()` 的过滤去掉后，新旧两条测试**同时变红**——证明过滤不是向导自己的展示假象，而是共享数据源上的真实约束。

## 4. 接线图说明（锁 §2 "接线图 = 纯展示"）

- `.iu4-wizard__wiring` 是固定的 flex 行：**恰好两个** `.iu4-wizard__wiring-node` + 一条 `.iu4-wizard__wiring-line`（EP `Right` 图标），永远不随选择数量变化——不是自由画布，没有拖拽/连线编辑/节点增删 API。
- hop1 输出字段名 = `draft.sourceTarget`（组合 payload 里真实存在的 `input.sourceTarget`）；hop2 key 输入 = 字面量 `'key'`（组合 payload `input.toInput` 的编译期常量，`buildReadSourceCompositionPayload` 里从未可配置）——图上两侧标签与 wire body 里的真实字段/常量一一对应，不是向导自造的展示文案。
- 编辑 `iu4-wizard-source-target` 会实时反映到 `iu4-wizard-wiring-output`（同一个 `draft.sourceTarget`，非影子状态）。
- `IntegrationCompositionWizard.spec.ts`「wiring diagram renders...」断言：默认值 `internal_id` 渲染、编辑后同步渲染、清空后阻断下一步、节点数量恒为 2。

## 5. 字节等价证明（锁 §2 首条硬锁）

`IntegrationCompositionWizard.spec.ts`「BYTE-EQUALITY」测试：同一组两跳输入（含 trim 归一化：
`sourceTarget`/`name` 两端都带前后空白）分别**从真实 DOM** 驱动 (a) 默认向导面（选两跳 → 填
sourceTarget → 填 name → 保存）与 (b) `initialViewMode='expert'` 平铺面（同字段 → 保存），在
apiFetch mock 层截获两次 POST 的 **raw body 字符串**，断言 `wizardBody === expertBody`（字符串逐字
节相等，非 deep-equal），再对 body 做整体形状断言防「两个空对象相等」假阳性：

```json
{
  "config": {
    "version": 1,
    "name": "material_to_bom_v1",
    "operations": ["read"],
    "steps": [
      { "id": "step-1", "readSourceConfigId": "rsc_material_lookup" },
      { "id": "step-2", "readSourceConfigId": "rsc_bom_lookup",
        "input": { "fromStep": "step-1", "sourceTarget": "resolved_material_id", "toInput": "key" } }
    ]
  }
}
```

结构上的因：两面共写**同一个** reactive draft（`IntegrationReadSourceCompositionAuthoringPanel.vue`
的 `draft = reactive(createReadSourceCompositionDraft())`，向导只拿到同一个对象引用做 in-place 赋
值）、共走**同一个** `saveReadSourceCompositionVersion` → `buildReadSourceCompositionPayload`（服务层
本身零改动）——测试把这个论证钉成经验事实（M1 mutation 证明测试确实咬人，见 §7）。

## 6. 零后端/契约变化声明 + 顺带修复的 CI 缺陷

- 本 PR **不含任何** `plugins/`、路由、validator、wire 形状改动：`readSourceCompositions.ts` 的全部
  导出函数（list/save/approve/retire/audit/run + 校验/normalizer）逐字节未动；向导所有动作 emit 到
  panel 的**既有** `save()` 函数——没有新 fetch 调用点。
- **顺带修复**：`integration-guard.yml` 的「Run integration web guard specs」步骤此前有 **3 个重复的
  `run:` key**（同一 step 下），这是无效但被多数 YAML 解析器（含本仓库 CI 实际使用的 PyYAML/常见
  parser）「静默容忍」的写法——只有**最后一个** `run:` 真正生效，导致已经写在文件里的 6 个 spec
  （`IntegrationBridgeAgentSection`/`IntegrationPipelineRunSection`/`IntegrationStockPrepPanel`/
  `IntegrationExternalWritePanel`/`IntegrationTableActionsPanel`/`IntegrationFieldOptionSyncPanel`）
  实际上**从未在 CI 里真正跑过**，尽管看起来"已经在名单里"。用 Python 脚本对三行取并集验证：
  `union(line178, line179, line180)` = 26 条，加本次新增 `IntegrationCompositionWizard` = 27 条，与
  任务口径「~27 specs」吻合。已合并为**唯一一个** `run:` key（27 spec 全量并集），并在 Node 20 与
  默认 Node 上各验证一次全绿（见 §9）。

## 7. mutation 证明（每次单独注入 → 跑测 → revert，工作先提交后做实验）

| # | 注入 | 结果 |
| --- | --- | --- |
| M1 | 向导 hop1 选择写 `row.id.toUpperCase()`（与专家面分叉） | 字节等价测试红（4 failed / 5 passed） |
| M2 | 向导 style 块注入 `#4b5563` | `ui-foundation-style-guard` 红（1 failed / 80 passed） |
| M3 | 父面板 `refreshPickers()` 去掉 `mode==='resolver_lookup'` 过滤 | 新向导「hop selection filters」+ 既有「lists ONLY approved resolver_lookup configs」**同时**红（2 failed） |

三次注入均在已提交的 HEAD 上做、验证后用 `git checkout --` 精确回退到提交状态（`git status --porcelain`
确认无残留），符合"先提交后做实验"纪律。

## 8. 专家模式保留证明（折叠≠删除）

- 平铺表单 DOM/逻辑**逐行未动**（diff 上只被 `<template v-else>` 包裹 + 顶部加 toggle，`draft`/
  `resolverConfigs`/`save()`/`savedRow` 侧栏全部原样）；
- 既有 `IntegrationReadSourceCompositionAuthoringPanel.spec.ts` 的**全部断言原文通过**（88 tests，唯
  一 diff = mount helper 加 `initialViewMode: 'expert'` prop，锁明示允许的 prop 附加，注释注明）；
- 向导 spec 的 expert-toggle golden：默认向导 → 点 `rscauth-mode-toggle` → 6 个平铺面签名 testid
  （`rscauth-step1`/`-step2`/`-name`/`-source-target`/`-save`/`-refresh`）全在 → 再点回向导。

## 9. IU-3 组件语汇复用说明

- el-steps 步进壳、卡片选择（`.iu4-wizard__card`/`--selected`/`__card-check`）、字段行（`.iu4-wizard__field`）、
  操作区/主按钮（`.iu4-wizard__actions`/`__button--primary`）、导航条（`.iu4-wizard__nav`）— class
  命名与 token 用法**逐字复制**自 `IntegrationReadSourceWizard.vue`（`iu3-wizard__*` → `iu4-wizard__*`
  前缀替换），未新起竞争样式词汇（同 IU-3 自身相对 IU-2 sections 的"verbatim-copy-from-token-only-
  parent"先例）。
- 模式切换 toggle（`rscauth-mode-toggle` / `Setting`↔`MagicStick` 图标 / 文案）与 IU-3 的
  `rsc-mode-toggle`（`IntegrationReadSourceConfigPanel.vue`）逐字同构。
- 图标全走 Element Plus SVG（`@element-plus/icons-vue`：`Check`/`Right`/`Setting`/`MagicStick`），
  零自绘 SVG。
- el-steps/el-step/el-icon/el-tooltip 测试 stub 与 IU-3 spec 同法（spec 头注释说明）。
- 与 IU-3 的差异（有意）：3 步而非 4 步（无独立"探测"步骤——组合本身没有 probe 语义）；未把两个
  组件抽成共享子件（锁 §2 "可抽共享子件"为可选项，本次未做，理由：两向导的领域模型/字段完全不同，
  抽取共享子件的唯一候选是纯样式，而样式已按"逐字复制"方式达成语汇统一，抽取不会减少代码量，反而
  会引入一层间接）。

## 10. 测试与双 Node 结果

| 检查 | Node 20 (v20.20.2, nvm) | 默认 (v25.9.0) |
| --- | --- | --- |
| integration-guard web 名单（27 spec files，含新 1 个） | **272/272 绿** | **272/272 绿** |
| `vue-tsc -b` | clean | — |
| `vite build`（`pnpm build`） | 成功 | — |
| `ui-foundation-style-guard.spec.ts`（81 tests，含新文件） | 绿 | — |
| `approval-web-guard.yml` 完整名单（30 spec files，本 PR 因改了该 workflow 名单里的 `ui-foundation-style-guard.spec.ts` 而会被触发） | **566/566 绿** | — |

新增测试：`IntegrationCompositionWizard.spec.ts` 10 条（默认面 golden、hop 过滤、步进门×2、接线图
渲染+编辑联动+门控、写权限门×2（禁用态/放行态分两个 mount，因 `canWrite` 是无响应式依赖的
`computed`，见测试内注释）、step-3 内「提交审批」（既有 `approveReadSourceComposition` + confirm
守卫）、字节等价、expert 切换、zh 文案）。

**CI 触达确认**：`ui-foundation-style-guard.spec.ts` 属于 `approval-web-guard.yml`（非
`integration-guard.yml`），其 `paths:` 过滤器**已经**列出该测试文件本身（第 126/242 行）——本 PR
修改了这个文件（TARGET_FILES 追加一行），所以 `approval-web-guard.yml` **会**在这个 PR 上真实触发，
新组件的 token-only 门不是"只在本地验证过"，而是有实际 CI 覆盖（本地跑过该 workflow 完整 30-spec
名单，566/566 绿，见上表）。

## 11. 边界内自查

不含：>2 跳、自由编排画布、组合 runtime/审批语义改动、递归、新读取模式、后端/契约改动。锁外未加
能力；锁内无未满足条款。
