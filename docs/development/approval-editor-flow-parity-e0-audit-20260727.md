# 审批编辑器与流程画布 E0 现状审计

**审计状态：** COMPLETE  
**审计基线：** `origin/main@d449aa7e6d02f94df2738a77cafffa778b12fde0`  
**审计日期：** 2026-07-27  
**范围：** 审批表单编辑、流程画布、条件/并行拓扑、检查器、路线预览、版本差异与恢复、功能开关、CI 收集面  
**结论：** 无 P1。存在 5 项 P2，均应在生产开启 `APPROVAL_CANVAS_V2_ENABLED` 或宣布飞书/钉钉对标前关闭。

本报告只记录 exact-head 可复现证据。代码存在、单测通过、设计锁写明或模型审阅通过，均不单独等于用户可达能力。

## 1. Findings

### P2-1 表单生产 UI 绕过命令层，可制造不可保存草稿并静默删除字段权限

生产页面没有导入 `approvalFormCommands.ts`：

- `TemplateAuthoringView.vue:2562-2568` 直接追加和过滤 `draft.value.fields`。
- `TemplateAuthoringView.vue:2571-2583` 直接交换或调用通用数组移动函数。
- `templateAuthoring.ts:225-228` 仍以当前长度生成持久 ID `field_${index}`。
- `approvalFormCommands.ts:56-84` 已定义不可复用的持久身份历史。
- `approvalFormCommands.ts:420-451` 已定义删除前完整引用清点和 fail-closed 拒绝，但生产页面未调用。

两个独立判别探针：

1. 新建字段 1/2/3，删除中间字段 2，再新增字段。序列化结果为：

   ```json
   [
     { "id": "field_1", "label": "字段 1" },
     { "id": "field_3", "label": "字段 3" },
     { "id": "field_3", "label": "字段 3" }
   ]
   ```

   `validateTemplateFormFields` 在 `templateAuthoring.ts:1126-1128` 只会提示“字段 id 不能重复”，但普通用户看不到也不能编辑字段 ID。后端在 `ApprovalProductService.ts:859-866` 再次拒绝。结果是用户可通过正常 UI 进入无法修复、无法保存的草稿状态。

2. 字段 2 被审批步骤设置为 `hidden` 后，通过页面当前删除逻辑删除字段 2：

   - `validateTemplateDraft` 返回 `[]`。
   - `buildApprovalGraph` 静默移除 `fieldPermissions`，因为 `templateAuthoring.ts:977-990` 会过滤已删除字段。
   - 同一输入调用 `removeFormField` 返回 `field_is_referenced`，依赖类型为 `step_field_permission`。

这不是仅缺少 undo 的体验差异，而是生产 UI 绕过现成 fail-closed 合约后产生的配置静默丢失。

**关闭条件：**

- 页面新增、删除、排序全部改走 `approvalFormCommands`。
- 接入完整 identity history 与 external reference inventory；缺失时拒绝，不回退到长度派生 ID。
- mounted browser 测试覆盖“删除中间字段再新增”和“删除被字段权限/条件/FWB 引用字段”。
- 旧图未编辑 round-trip 必须 byte-identical。

### P2-2 版本差异页面向管理员展示内部字段/节点/边标识

- `templateVersionDiff.ts:42-52` 在缺少业务名称时回退到 `field.id`、`node.key`，边标签直接拼接 `${source} -> ${target}`。
- `TemplateDetailView.vue:496-512` 原样渲染 `change.label`。
- required 测试 `approval-template-version-diff.test.ts:72-73` 反而固定了 `approve -> cc` 与 `cc -> end`。

该页面不受 Canvas V2 flag 保护，模板管理员当前即可访问。它违反现有交互锁“普通用户不见 node/edge/key/ID”的约束，也使后续正确修复必然先改 required 测试。

**关闭条件：**

- 边显示业务节点名称与业务关系文案，不显示 source/target key。
- 缺少名称时使用“未命名字段/节点”，不回退内部 ID。
- 增加 DOM 级 no-internals 守卫，覆盖文本、`aria-label` 与 tooltip。

### P2-3 两个负担安全/保真的 authoring spec 未进入任何 required CI

以下文件既不在 `apps/web/scripts/run-required-web-tests.sh`，也未进入 required workflow：

- `apps/web/tests/approval-template-authoring-errors.test.ts`
- `apps/web/tests/approval-template-authoring-field-permissions.test.ts`

`approval-web-guard.yml` 当前不是 `main` 的 required context。2026-07-27 实查 required contexts 只有：

```text
contracts (strict)
contracts (dashboard)
pr-validate
test (20.x)
contracts (openapi)
web-tests
stock-prep PowerShell 5.1 acceptance
attendance-web-guard
```

因此 values-free 错误映射和字段权限保真可回归而 required checks 仍全绿。

**关闭条件：**

- 两个 spec 接入 `run-required-web-tests.sh`。
- 同时保留 path-filter guard 作为快速反馈，但不能把非 required guard 当最终门。
- 用一次中和 values-free 映射、一次中和 field permission 保真证明 required job 精确变红。

### P2-4 条件公式 capture-prone 拒绝缺少用户可行动文案

- 后端在 `ApprovalProductService.ts:1597` 与 `ApprovalGraphExecutor.ts:1206` 返回 `APPROVAL_CONDITION_FORMULA_CAPTURE_PRONE`。
- `templateAuthoringErrors.ts:3-8` 没有该 code。
- `describeTemplateAuthoringError` 对未知 code 只返回通用 fallback。

管理员输入 `{amount} - {amount} == 0` 后，保存只会得到“保存模板失败”，无法定位分支或修正公式。后端 fail-closed 是正确的，但编辑器没有完成这一机器码的产品闭环。

**关闭条件：**

- 增加 values-free、可操作的 code-to-copy 映射。
- mounted UI 测试断言不会显示原始表达式、字段 ID 或后端 message。
- save/update/publish/restore 的同类错误使用同一映射入口。

### P2-5 Canvas flag 开启后仍不满足无障碍和真浏览器激活门

`TemplateAuthoringView.vue` 当前：

- 没有 `aria-live`、`role="status"` 或 `role="alert"`。
- 没有 `prefers-reduced-motion`。
- `onCanvasNodeKeydown` 在 `:2326-2331` 只支持 `Alt+ArrowUp/Down`。
- 没有设计锁要求的普通方向键导航、`Shift+F10` 上下文菜单、命令结果与拒绝播报。
- 变更仍直接调用 `graphTopologyEdit`，没有挂载 `approvalCanvasCommands` 的 undo/redo 历史。

测试层只有 Vitest/jsdom 和纯函数规格。`apps/web/verification/` 没有审批 Playwright 用例，无法证明拖拽、焦点、缩放、响应式检查器、长文案和触摸等真实浏览器行为。

**关闭条件：**

- 一套 mounted command adapter，所有鼠标、拖拽和键盘操作调用同一命令代数。
- 单一 polite live region；错误/冲突才使用 assertive。
- reduced-motion、焦点恢复、键盘全流程。
- Playwright 在 1440x900、1024x768、390x844 下跑 E1 夹具并做像素/DOM 几何断言。
- 完成这些门前 Canvas V2 保持默认 OFF，结构列表继续作为可访问回退。

## 2. P3 与实现漂移

### P3-1 分支优先级命令不会改变当前画布布局

`approvalCanvasCommands.ts:364-425` 只重排 condition/parallel config 中的 branch key，保持 `edges` 不变；`graphLayout.ts:51-67` 却按 `graph.nodes` 数组顺序排列同层节点。于是优先级改变在画布上可能完全无视觉变化。

E1 布局必须以 gateway config 的 branch order 为 lane order，默认条件分支固定在最右侧。

### P3-2 当前布局固定卡片尺寸，且节点卡片内仍堆操作按钮

- `graphLayout.ts:24-27` 固定 190x96。
- `TemplateAuthoringView.vue:654-692` 在节点卡片内放置移动、添加分支、插入和删除按钮。
- 右侧 inspector 没有 390px 窄屏 bottom sheet 两档形态。

这不构成 flag-OFF 下的运行时漏洞，但不能作为飞书/钉钉产品面完成证据。

### P3-3 timeout / approvalThreshold 保真守卫的注释与覆盖不完整

`templateAuthoring.ts:582-596` 声称复杂图 allowlist 与后端重放能力一致，但后端现在会规范化并保留 `timeout` 与 `approvalThreshold`。当前前端仍保守锁定，安全但注释已失真。

现有测试覆盖线性 `timeout` 只读拒绝；没有明确的 `approvalThreshold` 只读正反控，也没有复杂图两者的 mounted 保存禁用证据。不得简单把 key 加入 allowlist，必须先证明 hydrate-edit-save 全链 byte-identical。

### P3-4 设计治理状态漂移

`approval-canvas-v2-interaction-design-lock-20260721.md` 头部仍为 `PROPOSED`，同时记录 D2-b/D6-f1 已交付。实现已进入 `main`，但 G0 未在权威文档中追认。该漂移不是运行时 bug，但 D3-D6 不能以“代码已存在”替代 owner ratify。

## 3. As-built 能力矩阵

| 能力 | 当前状态 | 可交付判断 |
|---|---|---|
| Canvas flag 严格默认 OFF | 已实现 | 可保留 |
| 复杂图列表/画布切换 | 部分实现 | 仅复杂图，且默认 list |
| 线性流程统一画布 | 未实现 | 对标阻塞 |
| 条件/并行拓扑编辑 | 已实现基础命令 | 生产 UI 仍是按钮群/直接 mutation |
| 语义拖动 | 部分实现 | 仅 approval/cc 合法线性边槽 |
| 分支优先级排序 | 纯命令存在 | 当前布局不体现顺序 |
| undo/redo | 纯命令存在 | 生产 UI 未挂载 |
| 表单字段拖动排序 | 已实现原生 HTML5 | 新增/删除绕过命令层 |
| 左侧控件 palette 拖入 | 未实现 | 表单对标阻塞 |
| 路线预览 | 已实现 | 保留，需放入统一工作台 |
| 版本时间线 | 已实现 | 可用 |
| 版本差异 | 部分实现 | 有内部 ID 泄露，非并排对照 |
| 恢复为新草稿 | 已实现且并发保护 | 可用，不修改历史版本 |
| 真浏览器审批编辑器验收 | 未实现 | 开 flag 阻塞 |

## 4. E1 最小图形夹具

E1 spike 只做隔离渲染研究，不修改生产路由、不修改保存模型、不启用 flag。

### 4.1 必备流程形状

1. `start -> approval -> cc -> end` 线性主干。
2. 一个 condition gateway：
   - 两个规则分支；
   - 一个 default 分支；
   - 分支优先级可重排；
   - default 始终最后。
3. 一个 parallel gateway：
   - `joinMode=all` 与 `joinMode=any` 两个 variant；
   - 至少三条分支；
   - 一条分支内含 condition；
   - 不包含 nested parallel。
4. 一个 80 字符节点名、40 字符分支名、三行审批人摘要。
5. 一个 100 节点混合图。
6. 一个带未知 legacy config 的只读图。
7. 一个带 `timeout` 和一个带 `approvalThreshold` 的只读保真图。
8. 一个仅重排 `config.branches`、不改变 `nodes`/`edges` 数组的 priority variant。

### 4.2 不可协商约束

1. **一个业务模型：** 坐标、缩放、选中态不得进入 `ApprovalGraph` 或保存 payload。
2. **一个命令入口：** 渲染层不得重写业务校验；所有 mutation 经 `approvalCanvasCommands` / `graphTopologyEdit`。
3. **分支顺序真实可见：** lane 顺序从 gateway config 读取，不从 `graph.nodes` 数组猜测。
4. **动态测量：** 边路由不得依赖固定卡片高度；边不得穿卡，卡片不得重叠。
5. **旧图保真：** 未编辑 hydrate-save payload byte-identical；未知 config 保持只读。
6. **业务语言：** DOM、tooltip、`aria-label` 不得出现 node/edge/key/ID 或 `source -> target`。
7. **键盘等价：** 无鼠标完成新增、分支、移动、配置、撤销和保存。
8. **无障碍：** 命令结果、拒绝和校验计数可播报；reduced-motion 有效；焦点可恢复。
9. **响应式：** 1440 右侧 360px dock，1024 右侧 320px overlay，390 使用 bottom sheet。
10. **两点 CI：** 新 spec 同时进入 required web-tests 与快速 path guard。

## 5. E1 模型分工

| 任务 | 模型 | 边界 |
|---|---|---|
| 视觉 IA、节点层级、分支可读性、空/错/长文案状态 | Kimi K3 | 只读评审与原型建议，不改生产代码 |
| 隔离 renderer spike、Playwright 几何验证 | Grok | 仅 E1 实验目录/分支，不接生产路由 |
| 命令边界、保真、无障碍与 false-green 对抗审阅 | Claude Opus 5 | 只读；Codex 逐条复核 |
| 证据归并、P 级裁决、最终合入门 | Codex | 不把模型自评当验收 |

## 6. 验证记录

在 exact-head 隔离 worktree 执行：

```text
approval canvas/form/version focused Vitest: 7 files, 125 passed
vue-tsc --noEmit: PASS
```

这些结果证明纯命令和既有 jsdom 规格当前通过，不证明生产 UI 已挂载命令，也不证明真实浏览器拖拽/布局。

独立 Opus 5 审阅使用：

```text
model: claude-opus-5
context window: 1,000,000
max output: 64,000
mode: read-only review
```

Codex 对其结论做了二次裁决：

- 接受：raw key 版本差异、CI 漏收集、capture-prone 缺文案、无障碍/浏览器门、命令层未挂载。
- 升级：表单命令层未挂载从体验 P3 升为数据保真 P2，并用两个判别探针证明。
- 驳回“timeout 零覆盖”：现有线性 timeout 测试存在；修正为 P3 注释/组合覆盖漂移。

## 7. Owner 门

1. G0：追认或修订现有 Canvas V2 交互锁。
2. 明确 E1 为 pre-G0 隔离 spike，不能被解释为 runtime 授权。
3. E0 五项 P2 关闭前，不开启生产 Canvas flag。
4. E1 通过后再选择 renderer；不得由模型自行决定依赖与产品架构。
5. merged-main Playwright + 真租户 UAT 通过后，才讨论 staging canary 与生产分级开启。
