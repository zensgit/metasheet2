# 审批编辑器与流程编排对标执行台账（2026-07-28）

**状态：IN PROGRESS**

**权威交互合同：**
`approval-canvas-v2-interaction-design-lock-20260721.md`

**本轮 delta 计划：**
`approval-editor-flow-parity-development-plan-20260727.md`

本台账只记录实际执行状态。`IMPLEMENTED`、测试通过、提交、push、CI、
merge、部署、UAT 和 flag 是不同状态，不互相替代。

## 1. 切片台账

| ID | 交付 | 基线 / 分支 | 提交 | 实现模型 | Codex 复核 | 当前状态 |
|---|---|---|---|---|---|---|
| E0 | exact-head 审计 | `d449aa7e6` / `codex/approval-editor-flow-parity-plan-20260727` | `1941e2f0c` | Claude Opus 5 只读反例 + Codex | 代码、测试、flag、设计锁逐项核对 | Draft PR #4644；required CI 绿 |
| E1 | renderer spike | `origin/main@9da0335b4` / `codex/approval-editor-e1b-command-drag-20260728` | `6151d37cb` | Grok 4.5 Build；Kimi 做视觉 IA | Playwright、ESLint、类型、截图与 100 节点复核 | Draft PR #4643；required CI 绿 |
| E1-b | 生产命令适配、drag、history | 基于 E1 / `codex/approval-editor-e1b-command-drag-20260728` | `2955a68da` | Grok 4.5 Build | stale focus 修复、判别变异、浏览器超时/100 节点交互稳定化 | Draft PR #4643；required CI 绿 |
| E2 | Flow Canvas presentational shell 抽取 | `origin/main@9da0335b4` / `codex/approval-editor-e2-shell-extract-20260728` | `5a9bb4db2` | Claude Sonnet 5 | 247 测、类型、事件变异；修复静态 style 守卫误判 | Draft PR #4642；required CI 绿 |
| C1 | 线性/复杂流程统一 Canvas 载体 | E2 head / `codex/approval-editor-c1-unified-canvas-20260728` | `704276e1a` | Claude Opus 5 实现；Kimi exact-head 只读复审 | 真实视图写回、payload/dirty、promote 保真、flag fallback、删除下限及浏览器三 viewport | Draft PR #4649；required CI 绿 |
| C2 | Canvas-first 工作区与表单/流程切换 | C1 head / `codex/approval-editor-c2-canvas-first-20260728` | `068d6e628` | Codex 实现；Kimi exact-head 对抗复审 | 默认画布、辅助模式、Form/Flow 往返、viewport 重测、ARIA、三 viewport 真浏览器 | Draft PR #4652；required CI 绿 |
| F1-a | 表单 palette、插入槽和字段移动 | C2 head / `codex/approval-editor-f1-form-palette-20260728` | `6b926dce5` | Codex 实现；三轮独立子代理对抗复审 | 点击/typed drag 插入、handle-only 拖排、键盘/触屏等价、唯一字段 ID、三 viewport 真浏览器 | Draft PR #4657；required CI 绿 |
| C3 | 合法边 `+` 与 typed 插入菜单 | C2 head / `codex/approval-editor-c3-edge-insert-agent-20260728` | `525915d3d` | 子代理实现；Codex exact-source 复核和修复 | 40x40 边控件、四类节点、renderer intent、无 default 条件图、parallel join 收敛、真浏览器 | Draft PR #4697；本地 required Web Tests / build PASS；exact-head required CI PASS，merge state CLEAN |
| F1-b | 三栏表单 builder 与聚焦 inspector | F1-a head / `codex/approval-editor-f1b-form-builder-20260728` | `93a9527f2` | Codex 实现与复核 | 左 palette / 中画布 / 右 inspector、typed drag、键盘/触屏等价、flag OFF 回退、三 viewport 真浏览器 | Draft PR #4696；本地 required Web Tests / build PASS；exact-head required CI PASS，merge state CLEAN |
| C4 | 语义节点拖拽与条件/并行分支排序 | C3 head / `codex/approval-editor-c4-semantic-drag-20260731` | `c6f0b7bbc` | 子代理实现；Codex exact-source 复核 | renderer intent-only、统一 command seam、合法槽、stale/cross-region no-op、values-free live message、键盘等价 | Draft PR #4698；本地 required Web 360/4338 + build PASS；required checks 3/3 PASS、CLEAN；真浏览器证据待补 |
| F2 | 表单结构命令、历史身份与 FWB 引用保护 | F1-b head / `codex/approval-editor-f2-form-command-protection-20260731` | `5fff366e8` + `4ccc20f71` | Codex 前端；子代理后端；Codex 组合复核 | UUID identity、全版本字段/明细列历史、values-free 引用、发布同事务 gate、错配/畸形上下文 fail-closed | Draft PR #4699；required Web 359/4330、unit 147、fresh PG15 API 8/8、两刀 mutation RED；required checks 3/3 PASS、CLEAN |
| F3 | 附件字段 authoring 双 flag 兼容 | F2 head / `codex/approval-editor-f3-attachment-authoring-20260731` | `2cbbd539a` | Codex 实现与复核 | palette allowlist、已有附件模板 fail-closed、flag OFF 不丢字段 | Draft PR #4700；required checks 3/3 PASS；CLEAN；真浏览器整链待 T1 |
| C5 | Canvas/节点检查器统一 undo/redo | C4 head / `codex/approval-editor-c5-unified-history-20260731` | `a2dacd562` | Codex 实现；Kimi 只读复核 | 顶栏/快捷键、稳定 key 选择、焦点恢复、redo 分叉清理 | Draft PR #4701；required checks 3/3 PASS；CLEAN；真浏览器整链待 T1 |
| I1 | 表单与 Canvas 单一 per-draft history 最终组合 | F3 head + C3/C4/C5 / `codex/approval-editor-2-final-integration-20260731` | `7192a56fd` | Codex 实现/组合复核；Kimi 对抗复核；Grok 上游不可用 | 受控字段组件、唯一父层写入口、表单四类命令、changed-key restore、保存边界、身份不可复用 | Draft PR #4702；本地 focused 46/46、required Web 360/4366、lint/type/build PASS、五刀 mutation RED；required checks 3/3 PASS |

## 2. E1-b 执行事实

改动仅位于 `apps/web/verification/`：

- harness 引用生产 `approvalCanvasCommands`；
- reorder、move、undo、redo 共用生产 history；
- pointer/HTML5 drag 与键盘调用同一 adapter；
- typed rejection 映射 values-free 文案；
- graph snapshot 不持久化 renderer 坐标；
- selection 用稳定业务 key 映射当前 focus id。

模型第一版存在真实缺陷：拓扑重排后保留旧 `selectedFocusId`，可能使
inspector 指向另一个节点。Codex 返回同一 Grok session 修复后，再中和
稳定键恢复逻辑，Playwright 精确转红；恢复后转绿。

## 3. E2 执行事实

E2 只修改：

- `apps/web/src/views/approval/TemplateAuthoringView.vue`
- `apps/web/src/approvals/components/ApprovalFlowCanvas.vue`（新增）
- `apps/web/tests/approval-template-authoring-canvas-inspector.spec.ts`

边界：

- 父组件继续拥有 draft、selection、zoom、viewport、save/publish 和全部
  topology/command handlers；
- 子组件只接收派生 props、渲染既有 DOM，并发出 typed intents；
- `ApprovalGraphNodeConfigEditor` 继续复用同一 provide/inject 上下文；
- scoped CSS 随 markup 移入子组件；列表所需样式保留在父组件；
- 25 个 Canvas `data-testid` 抽取前后集合一致；
- 无依赖、后端、API、payload、feature flag 或默认视图改动。

父组件由 3732 行降至 3340 行。新增 shell 为 526 行；本刀不是最终文件
拆分，后续 form、shell 和 version 仍按计划独立切片。

## 4. 状态矩阵

| 面 | E1-b | E2 | C1 | C2 | F1-a | C3 | F1-b | C4 | F2 |
|---|---|---|---|---|---|---|---|---|---|
| 设计方向 | 已约束 | 已约束 | 已约束 | 已约束 | 已约束 | 已约束 | 已约束 | 已约束 | 已约束 |
| 实现 | 完成 | 完成 | 完成 | 完成 | 完成 | 完成 | 完成 | 完成 | 完成 |
| 本地测试 | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| 判别变异 | PASS | PASS | 3 刀 | 4 刀 | 3 刀 | focused + browser | focused + browser | command/mounted 判别 | 2 刀 + real DB |
| 独立复审 | Codex | Codex | Kimi + Codex | Kimi + Codex | 子代理 + Codex | Codex | Codex | Codex，无 P1/P2 | Codex 组合复核，修 DTO/mock/运行时校验 |
| push / PR | #4643 | #4642 | #4649 | #4652 | #4657 | #4697 | #4696 | #4698 | #4699 |
| required CI | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS | PASS |
| 真浏览器 | PASS | N/A | PASS | PASS | PASS | PASS | PASS | 待补 | 待补 |
| merge / UAT / flag | 全部否 | 全部否 | 全部否 | 全部否 | 全部否 | 全部否 | 全部否 | 全部否 | 全部否 |

新增切片状态：

| 面 | F3 | C5 | I1 (#4702) |
|---|---|---|---|
| 设计方向 | 已约束 | 已约束 | 锁 §7.1 组合闭环 |
| 实现 | 完成 | 完成 | 完成 |
| 本地测试 | PASS | PASS | PASS |
| 判别变异 | focused 判别 | history 判别 | 5 刀 RED-before |
| 独立复审 | Codex | Codex | Kimi + Codex；无未闭合 P1/P2 |
| push / PR | #4700 | #4701 | #4702 |
| required CI | PASS | PASS | PASS |
| 真浏览器 | 整链待 T1 | 整链待 T1 | 待 T1 |
| merge / UAT / flag | 全部否 | 全部否 | 全部否 |

## 5. 后续顺序

1. 审阅并按依赖落 #4642 -> #4649 -> #4652；其后 #4697 走 C3，#4657 -> #4696 走 F1；#4643 是 verification-only 独立支线；
2. C3/C4/C5 已交付边 `+`、语义拖拽、分支排序及 Canvas/节点检查器统一历史；
3. F1-a/F1-b/F2/F3 已交付 palette、三栏 builder、命令层、外部引用保护及附件双 flag authoring；
4. #4702 已完成表单与 Canvas 单一 history 的组合收口，required checks 3/3 PASS，待 owner 审阅；
5. V1/V2、P1、X1 收版本、试运行、移动端/无障碍；
6. T1 真浏览器 required CI 全闭合后才进入 staging UAT；
7. production flag 和结构化辅助入口退役始终由 owner 单独决定。

## 6. C1 执行事实

- 线性 node key 规则只有 `linearCanvasCarrier.ts` 一处权威；
- inspector 的 source、ids、field、level、mode、empty policy、self-approval
  与 field permissions 全部写回 `ApprovalStepDraft`；
- view toggle 和 selection 不写 draft；保存 payload 只读 draft；
- first structural edit 使用 `applyTopologyToDraft`，不另造 promote 路径；
- edge count、parallel region、validity 全部基于 `canvasEffectiveGraph`；
- 删除守卫按有效图审批节点数工作，promote 后仍保留最后一个审批节点；
- required approval-web-guard 首跑暴露旧 inspector 删除正控仍使用唯一审批
  fixture；改为两个审批节点后，既保留删除/selection 正控，也不弱化最后节点
  拒绝，目标 20/20；
- 真 Chromium 在 1440 / 1024 / 390 无横向溢出或 console error；
- 390 下 sticky bottom navigation 遮挡、卡片内按钮群和紧凑触控尺寸仍属于
  C2/C3/X1，未被 C1 结论掩盖。

## 7. C2 执行事实

- Canvas flag ON 时 `canvasViewMode` 默认 `canvas`，线性与复杂图一致；
- “结构列表”改名“辅助编辑模式”，仍可切换且没有退役可访问回退；
- 表单/流程 segmented control 使用 `role="group"` 与 `aria-pressed`，真实
  production view 验证 Form -> Flow -> Form 往返；
- Canvas 从隐藏状态重新显示时重测 viewport，避免隐藏挂载产生 0x0 minimap；
- flag OFF 不出现新模式切换，不改变旧页面路径；
- 17 个 authoring/canvas/graph 文件 260/260、focused mounted 22/22、
  ESLint、`vue-tsc`、diff check 全通过；
- 四刀变异分别中和默认 Canvas、模式切换、viewport watch 和 group 语义，
  指定测试均精确转红；
- 真 Chromium 1440 / 1024 / 390 均无横向溢出、console error 为 0；
- 一次变异恢复误命中同形 `@click`，单测未暴露，真实浏览器发现按钮目标
  反转；按按钮上下文修复后重跑完整测试与浏览器矩阵。该事件证明真浏览器
  不是可省略的展示步骤。

## 8. F1-a 执行事实

- Canvas flag ON 时，palette 从 `AUTHORABLE_FIELD_TYPES` 派生全部当前可编辑
  字段类型；点击与 typed native drag 都写入同一草稿字段序列；
- 字段前、中、后都有显式插入槽；插入槽是可聚焦按钮，支持鼠标、键盘和
  触屏选择，再由 palette 点击插入；
- 字段移动只允许从拖拽把手启动，本地 active drag index 必须与 typed
  payload 一致；外来、缺失、负数和错配 payload 均 no-op；
- `Alt+ArrowUp/Down` 与上下移动按钮保留为拖拽等价路径，并声明
  `aria-keyshortcuts`；
- 删除后新增字段使用最小未占用 `field_N`，避免 `fields.length + 1`
  在编号空隙下生成重复 ID；
- read-only 时 palette、插入槽和拖拽把手均不可写；Canvas flag OFF 保持
  旧“添加字段”和原字段拖排路径；
- focused specs 22/22、required web test 总计 359 文件 / 4320 测试、
  `vue-tsc`、ESLint、web build 和 diff check 全通过；
- 三刀判别变异分别中和前向移动索引修正、恢复易重复 ID 算法、删除 typed
  payload 与本地拖拽会话一致性检查，指定测试均精确转红；
- 真实 Chromium 在 1440 / 1024 / 390 验证桌面左右布局、窄屏纵向布局、
  插入槽选择、字段插入、无横向溢出和零 console error；
- 本刀未抽出 `ApprovalFormBuilder`，也未形成聚焦字段的独立右侧属性
  inspector；这些明确留给 F1-b，不以 #4657 提前关闭。

## 9. C3 执行事实

- 每条通过纯合法性判定的 edge 渲染一个 40x40 可聚焦 `+`；Enter/Space
  打开菜单，Esc 关闭并返回原按钮；
- menu 只列当前 edge 合法的 approval / cc / condition / parallel，parallel
  branch 内不提供 nested parallel；
- renderer 仅 emit typed insertion intent，父层调用既有 topology command；
  节点卡内旧插入按钮群被移除，condition/parallel 的分支管理入口保留；
- Codex 独立复核发现：条件图无显式 default 仍可合法执行，不能误锁；并行
  分支仅“edge 存在”不足以开放写入，必须证明所有路径收敛到 configured join；
- 修复后 focused specs 58/58，required Web Tests 360 文件 / 4335 测试，
  `vue-tsc`、ESLint、production build 和 diff check 均通过；
- 真 Chromium 验证 4 个节点 / 3 个 edge slot 插入后成为 5 / 4，menu 四项、
  validity error 0；1440 下观察到 28px 全站顶栏既有横向溢出，画布、菜单、
  inspector 本身无重叠，该 shell 残余记入 X1，未伪称整页零溢出。

## 10. F1-b 执行事实

- 新增 `ApprovalFormBuilder.vue` 与 `ApprovalFieldInspector.vue`；父 view 继续
  拥有 draft、catalog 和保存/发布，不在子组件复制持久化合同；
- flag ON 为左 palette、中字段画布、右聚焦 inspector；1024 降为两栏加
  下方 inspector，390 为单列；flag OFF 保留旧全字段编辑列表；
- palette 点击/拖入、字段 handle-only 拖排、插入槽、上下移动和
  `Alt+ArrowUp/Down` 共用同一 fields 载体；typed payload 不放宽；
- record-link catalog error/retry、detail、visibility、options 和 required
  继续由同一 inspector 编辑，required source guard 同步到新 ownership；
- required Web Tests 359 文件 / 4326 测试、`vue-tsc`、ESLint、production
  build 和 diff check 均通过；
- 真 Chromium 1440 / 1024 / 390 builder overflow 0、console error 0；桌面
  拖入日期后字段数 3 -> 4，选中字段在右 inspector 改名成功。

## 11. C4 / C5 / F2 / F3 / I1 执行事实

- C4 的 node/branch drag intent 只在页面进入既有 command algebra；合法槽、
  session token、stale/cross-region no-op 和 values-free live message 已由
  focused tests 与 required CI 覆盖，真浏览器仍待 T1；
- C5 把 Canvas 和节点检查器的 topology/configure/delete 统一进顶栏历史，
  selection/focus 用稳定业务 key 恢复；#4701 required checks 3/3 PASS；
- F2 的后端 identity/reference authority 与发布同事务 gate 保持不变；F3 只在
  Canvas+附件双 flag 时开放新附件字段，旧模板在能力关闭时 read-only；
- I1 将 `ApprovalFieldInspector` 改为 props-in/events-out，
  `ApprovalFormBuilder` 不再通过嵌套 `v-model` 拥有草稿，父 view 成为唯一写
  入口；add/remove/move/configure-form-field 与 Canvas 共用一个 history；
- history entry 记录命令实际改变的顶层 draft key，避免撤销字段操作覆盖后来
  修改的 description 等基本信息；成功保存回读全版本 identity context 后清空
  本地历史与临时退役集合，失败保存保留 undo；
- exact head `7192a56fd`：focused 46/46、required Web 360 文件 / 4366 测试、
  targeted ESLint、`vue-tsc --noEmit`、production build、diff check 全 PASS；
- 五刀判别变异依次中和 history gate、身份保留、changed-key restore、焦点
  fallback 和成功保存历史边界，指定测试均 RED，恢复后全绿；
- Kimi 对抗复核确认受控组件 ownership、nested field mutation 和 flag OFF
  路径没有 P1；其跨保存旧快照风险已通过成功/失败保存边界回归关闭。Grok
  session 因上游连接失败未读取代码，不计入复核证据。
