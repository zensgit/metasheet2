# 审批编辑器与流程编排 E1-b / E2 / C1-C5 / F1-a-F3 收尾验证（2026-07-31）

**范围状态：PR VERIFIED / REQUIRED CI PASS**

**整线状态：NOT FINAL**

本报告只关闭 E1-b renderer/command feasibility、E2 第一刀无行为抽取、
C1 线性/复杂流程统一载体、C2 canvas-first 工作区、C3 边 `+` 插入、C4
语义拖拽/分支排序、C5 Canvas 历史，以及 F1-a/F1-b/F2/F3 表单 palette、
三栏 builder/inspector、命令/引用保护和附件 authoring 代码门。#4702 又完成
表单与 Canvas 单一 per-draft history 的组合验证。它不宣称审批编辑器已对标
完成，不授权部署、UAT 或 flag 开启；C4/F1/F3 真浏览器 T1、V1/V2、P1、
X1 仍未闭合。

## 1. Exact heads

| 切片 | 分支 | exact head |
|---|---|---|
| E1-b | `codex/approval-editor-e1b-command-drag-20260728` | `2955a68da` |
| E2 | `codex/approval-editor-e2-shell-extract-20260728` | `5a9bb4db2` |
| C1 | `codex/approval-editor-c1-unified-canvas-20260728` | `704276e1a` |
| C2 | `codex/approval-editor-c2-canvas-first-20260728` | `068d6e628` |
| F1-a | `codex/approval-editor-f1-form-palette-20260728` | `6b926dce5` |
| C3 | `codex/approval-editor-c3-edge-insert-agent-20260728` | `525915d3d` |
| F1-b | `codex/approval-editor-f1b-form-builder-20260728` | `93a9527f2` |
| C4 | `codex/approval-editor-c4-semantic-drag-20260731` | `c6f0b7bbc` |
| F2 | `codex/approval-editor-f2-form-command-protection-20260731` | `4ccc20f71`（组合含 `5fff366e8`） |
| F3 | `codex/approval-editor-f3-attachment-authoring-20260731` | `2cbbd539a` |
| C5 | `codex/approval-editor-c5-unified-history-20260731` | `a2dacd562` |
| I1 | `codex/approval-editor-2-final-integration-20260731` | `7192a56fd` |
| 文档 | `codex/approval-editor-flow-parity-plan-20260727` | 本报告提交后的 head |

E2 起点为 `origin/main@9da0335b4`。canonical checkout 未被修改。

## 2. E1-b 证据

### 2.1 静态与真浏览器

```text
targeted ESLint: PASS
vue-tsc --noEmit: PASS
Playwright Chromium: 4/4 PASS
mixed-100: first 111.18ms, repeat 107.48ms
```

三 viewport 为 1440x900、1024x768、390x844。截图人工复核确认：

- 画布与右侧 inspector 不重叠；
- 选中节点有明确 focus ring；
- edge `+` 可见；
- 卡片、边和文字无横向溢出；
- 390 使用 bottom sheet；
- 100 节点仍可滚动和选择。

### 2.2 命令与数据合同

- reorder 使用生产 `reorder-condition-branches`；
- move 使用生产 `move-node-into-edge`；
- 非法 self-slot / unsupported-node-type 保持 graph byte-identical；
- pointer 与 keyboard 产生相同拓扑；
- undo 恢复 byte-identical graph；
- selection/focus/inspector 在层级变化后仍指向同一业务 key；
- graph JSON 不含 renderer 坐标。

### 2.3 判别变异

中和 `restoreSelectionFromHistory` 后：

```text
Expected: "主管审批"
Received: null
E1-b Playwright: RED
```

恢复 exact file 后同一用例重新 PASS。该测试不是仅靠“边集合变化”假绿。

## 3. E2 证据

### 3.1 定向回归

```text
13 approval authoring test files: 247/247 PASS
targeted ESLint: PASS
vue-tsc --noEmit: PASS
git diff --check: PASS
```

覆盖：

- Canvas flag OFF 时实验面不可见；
- flag ON 的 list/canvas 切换；
- Canvas drag/drop 与 Alt+Arrow；
- Inspector 编辑写回既有 save payload；
- 删除后 selection 清理；
- read-only mutation controls；
- 390 宽度 inspector scroll；
- condition/parallel/cc/approval 编辑；
- 复杂图 load -> save byte-identical round-trip；
- unknown/unsupported config 的 fail-closed 保真。

测试运行中已有的 Vue Router 和未 stub Element Plus 警告仍存在；没有新增
测试失败。它们不是本刀引入的产品错误。

### 3.2 DOM 与 CSS

- 抽取前后 Canvas `data-testid`：25 / 25，missing 0，added 0；
- markup 与 Canvas scoped CSS 同时移入 `ApprovalFlowCanvas.vue`；
- 父组件不再拥有 `.template-authoring__canvas-workspace`；
- 子组件继续拥有 400px desktop inspector 和 164px mobile scroll margin；
- 真实 mounted test 验证 list 与 Canvas inspector 的 child-owned 样式。

### 3.3 判别变异

中和子组件 `onMoveTargetDrop` 的 typed intent 后，mounted test 精确转红：

```text
expected moved node top < app node top
received 340 < 190: false
```

恢复 exact file 后同一测试重新 PASS。该证据钉住子组件到父 command
handler 的事件透传。

## 4. 审阅发现与处置

| 严重度 | 发现 | 处置 |
|---|---|---|
| P2 | E1-b 第一版在 move 后保留 render focus id，可能选错 inspector 节点 | 改用 history stable key 重映射 focus id；Playwright + mutation |
| P3 | C1 线性流程 promote 后，原 `steps.length` 删除下限失效，可继续删到 start→end | 改按 effective graph 的 approval node 数量守卫；中和回旧逻辑后 exact test RED |
| P3 | E2 抽取后父组件残留 3 个常量 import 和 1 个 helper | 删除机械残差；lint 转绿 |
| P3 | Claude Sonnet 卡在 Playwright MCP 启动，不是产品测试 | 终止悬挂 MCP；Codex 独立运行全部验证，不采信未完成模型声明 |

最终审阅未发现新的 P1/P2。

## 5. C1 证据

### 5.1 数据与拓扑

- 线性 Canvas inspector 不创建 shadow edit，全部写回已有
  `ApprovalStepDraft`；
- 仅打开/选中/切换 Canvas 不置 dirty，保存 payload byte-identical；
- 首次插入/移动通过 `applyTopologyToDraft` promote，原审批节点的 key、name、
  source ids、mode、empty policy、auto approval policy 和 field permissions
  保持；
- flag OFF 回到结构列表；unsupported template 不开放 Canvas；
- `topologyEdgeCount`、parallel-region 和 validity 读取 effective graph；
- 最后审批节点删除下限在 promote 前后都成立。

### 5.2 测试与变异

```text
C1 mounted production-view spec: 9/9 PASS
authoring / inspector / topology / viewport focused battery: 124/124 PASS
style guard: 83/83 PASS
targeted ESLint: PASS
vue-tsc: PASS
```

三刀判别变异：

1. 中和 linear carrier lookup -> inspector write-through tests RED；
2. 恢复 preservedGraph-only edge count -> promotion/delete positive controls RED；
3. 恢复 promote 前专属删除下限 -> 第二次删除测试 RED。

Kimi 对 `8cf218f31` 做 exact-head 只读对抗复审，结论 APPROVE、无 P1/P2；
其 P3 删除边界在 `bbd436177` 修复。required approval-web-guard 首跑随后
暴露既有 inspector 删除测试使用“唯一审批节点”作为正控；`704276e1a`
把 fixture 改为两个审批节点，保留 selection/inspector 清理断言且不弱化
产品守卫。相关两 spec 20/20、ESLint 和 diff check 通过。

### 5.3 真浏览器

真实 `TemplateAuthoringView` 在 Chromium 中验证：

| viewport | Canvas | graph region | inspector | 横向溢出 |
|---|---:|---:|---:|---|
| 1440 | 1078 x 554 | 666 x 478 | 400 x 554 | 无 |
| 1024 | 918 x 572 | 506 x 478 | 400 x 538 | 无 |
| 390 | 300 x 1003 | 300 x 478 | 300 x 401 | 无 |

console error 为 0。Canvas inspector 勾选“自审合并”后切回结构列表，同一
checkbox 保持选中；只在真实编辑后 header 才变为“有未保存更改”。

## 6. C2 证据

### 6.1 行为与回退

- Canvas flag ON 时线性与复杂流程默认进入真正 Canvas；
- 表单/流程在同一工作区用 segmented control 往返；
- 原结构视图保留为“辅助编辑模式”，切回后原有步骤仍在；
- Canvas 从隐藏状态显示时重新测量 viewport；
- flag OFF 不出现新切换器，保持旧路径。

### 6.2 测试、变异与真浏览器

```text
17 authoring/canvas/graph files: 260/260 PASS
focused mounted specs: 22/22 PASS
targeted ESLint: PASS
vue-tsc --noEmit: PASS
git diff --check: PASS
```

四刀判别变异分别中和 Canvas 默认值、Form/Flow action、viewport reveal
watch 和 ARIA group 语义，指定测试均精确转红。真实 Chromium 在
1440 / 1024 / 390 验证默认 Canvas、Form -> Flow -> Form、辅助模式恢复、
无横向溢出和零 console error。

变异恢复阶段曾误命中另一个同形 `@click`，导致表单/流程按钮目标反转；
单测运行时点未覆盖该恢复错误，真浏览器交互发现并阻止发布。按按钮上下文
修复后，完整测试、类型、lint 和浏览器矩阵全部重跑。Kimi exact-head
对抗复审的两个 P2（不完整 tablist 语义、隐藏 Canvas 0x0 viewport）均已
闭合，最终无 P1/P2。

## 7. F1-a 证据

### 7.1 行为与兼容

- palette 精确覆盖当前 `AUTHORABLE_FIELD_TYPES`，点击和 typed native drag
  均可把字段加入所选插入槽；
- 每个字段前后都有可聚焦插入槽；鼠标、键盘和触屏都可选择位置，重复点击
  同一槽位会取消；
- 只有字段拖拽把手可启动移动；typed payload 必须与本地 active drag
  session 匹配，外来或 malformed payload 不改草稿；
- 键盘 `Alt+ArrowUp/Down` 与既有上下移动按钮提供等价重排；
- 删除后新增字段选择最小可用 `field_N`，不产生重复 ID；
- read-only 全部 inert；Canvas flag OFF 不显示 palette、插入槽和新把手，
  继续走旧路径。

### 7.2 测试、变异与真浏览器

```text
focused palette + mounted authoring specs: 22/22 PASS
required web tests: 359 files / 4320 tests PASS
targeted ESLint: PASS
vue-tsc --noEmit: PASS
web production build: PASS
git diff --check: PASS
required PR checks: 3/3 PASS
```

三刀判别变异分别恢复错误的前向移动索引、恢复 `fields.length + 1` 字段
编号、删除 typed payload 与本地 drag session 一致性检查，指定测试均
精确转红。三轮独立子代理复审发现并推动关闭 malformed drag、前向跨越
覆盖、palette allowlist、键盘/触屏插入点、删除空隙重复 ID 和 CI 收集等
问题；最终 exact diff 无 P1/P2。

真实 `TemplateAuthoringView` 在 Chromium 中验证：

| viewport | palette / form | 插入行为 | 横向溢出 | console error |
|---|---|---|---|---:|
| 1440 x 1000 | 左右并列 | 日期插入字段 1 | 无 | 0 |
| 1024 x 900 | 上下堆叠 | 插入槽可选择 | 无 | 0 |
| 390 x 844 | 上下堆叠 | 触屏选择后插入多行文本为字段 2 | 无 | 0 |

F1-a 本身没有抽出独立 builder，也没有提供聚焦字段的右侧属性检查器；
该缺口由 F1-b 关闭，但完整命令层引用保护和附件 authoring 仍属于 F2/F3。

## 8. C3 与 F1-b 证据

### 8.1 C3 边 `+`

- 每条合法 edge 一个 40x40 可聚焦 `+`；menu 提供当前上下文合法的
  approval / cc / condition / parallel；
- renderer 只发 typed intent，拓扑仍由纯 command 层修改；节点卡内旧插入
  按钮群删除，branch management 保留；
- nested parallel、malformed graph 和 stale edge 均 fail-closed；
- 独立复核补上两个守卫：无显式 default 的合法 condition 不被误锁；并行
  每条 branch path 必须收敛到 configured join；
- focused 58/58、required Web Tests 360 文件 / 4335 测试、类型、lint、
  production build、diff check 全 PASS；
- 真 Chromium：4 -> 5 nodes、3 -> 4 edge slots、四项 menu、validity error 0。

1440 viewport 的 `documentElement` 仍有 28px 横向溢出，截图定位为全站顶部
导航既有宽度，而不是本刀 Canvas/menu/inspector 重叠。该事实保留到 X1，
不能把 C3 证据写成“整页零溢出”。

### 8.2 F1-b 三栏表单工作区

- 新增 `ApprovalFormBuilder.vue` 和 `ApprovalFieldInspector.vue`；
- flag ON 为左 palette、中字段画布、右聚焦 inspector；flag OFF 保留旧路径；
- palette drag/click、插入槽、handle-only 拖排、上下移动和
  `Alt+ArrowUp/Down` 共用同一 fields 载体；
- options/detail/visibility/record-link catalog retry 全迁入同一 inspector，
  未改变持久化 form schema；
- required Web Tests 359 文件 / 4326 测试、类型、lint、production build、
  diff check 全 PASS；
- 真 Chromium 1440 / 1024 / 390 builder overflow 0、console error 0；桌面
  拖入日期后字段数 3 -> 4，并在右侧把选中字段改名为“财务复核人”。

### 8.3 C4 语义拖拽与分支排序

- 节点拖入合法 edge slot、条件分支排序和并行分支排序统一经页面
  `applyCanvasCommand` 接现有命令代数，renderer 无拓扑业务逻辑；
- 拖拽 payload 与本地 session token 绑定；stale、非法和跨区域输入 no-op，
  visible/live 文案 values-free；分支把手、`Alt+Arrow` 和按钮共享语义；
- focused 79/79、required Web 360 文件 / 4338 测试、类型和 production build
  PASS；Draft PR #4698，exact head `c6f0b7bbc`；
- 本轮 Codex In-app Browser 无法附着 localhost 新标签页。HTTP 服务本身 200，
  但缺 drag/screenshot 证据，因此 C4 只记 `IMPLEMENTED / LOCAL REQUIRED PASS`。

### 8.4 F2 表单命令与权威引用

- Builder 仅发 typed add/remove/move intent，页面调用 `approvalFormCommands`；
- 新字段/明细列使用 UUID identity；后端收集该模板全部历史版本的字段与明细
  列 ID，删除后不可复用；
- admin-only authoring context 在 REPEATABLE READ 只读事务返回完整身份与
  values-free FWB reference inventory；错模板、缺项或畸形成员全部 fail-closed；
- publish 在同一事务重扫引用，删除仍被 FWB 使用的字段返回 values-free 409；
- focused FE 105/105、BE unit 147/147、fresh PG15 全迁移真实 API 8/8、
  required Web 359 文件 / 4330 测试、两刀 mutation RED；Draft PR #4699，
  exact head `4ccc20f71`。

### 8.5 F3 附件 authoring

- 附件字段只在 Canvas V2 与附件 authoring 两个 flag 同时开启时进入 palette；
- 任一能力关闭时，已有附件模板由 unsupported/read-only gate fail-closed，
  不能在可写编辑器中静默删除附件字段；
- Draft PR #4700，exact head `2cbbd539a`，required checks 3/3 PASS、
  merge state CLEAN；尚未 merge、部署或开启 flag。

### 8.6 C5 与 I1 单一历史

- C5 为 Canvas topology/configure/delete 提供顶栏 undo/redo 和快捷键，恢复
  graph、selection 与 focus；Draft PR #4701 exact head `a2dacd562`，
  required checks 3/3 PASS；
- I1 把表单 add/remove/move/configure 也接入同一 history；字段 inspector
  完全受控，builder 只发事件，父 view 是唯一草稿写入口；
- 每条 history entry 记录实际改变的顶层 draft key，撤销字段操作不会覆盖
  之后发生的 description 等基本信息编辑；
- 成功保存回读服务端全版本 identity context 后建立新历史边界并清空临时
  退役集合；失败保存不清空 undo；
- form selection/focus 随 undo/redo 恢复；无具体 control id 时聚焦 inspector
  第一个可交互控件，避免焦点落到 body。

### 8.7 I1 exact-head 验证与审阅

```text
focused history + mounted inspector: 46/46 PASS
required Web: 360 files / 4366 tests PASS
targeted ESLint: PASS
vue-tsc --noEmit: PASS
production Web build: PASS
git diff --check: PASS
```

五刀判别变异分别中和 history gate、撤销后的身份保留、changed-key restore、
焦点 fallback 和成功保存后的历史边界，指定测试均精确 RED；恢复后全绿。

Kimi exact-tree 对抗复核确认没有 nested `v-model`/direct mutation 绕过，
flag OFF 继续 mutate-only 且不展示 history 控件。它提出的跨成功保存旧快照
风险已通过“成功保存清空、失败保存保留”双正反控制关闭。其剩余 P3 为输入
逐键产生历史项及明细表格焦点粒度，均不构成数据正确性或 flag-ON 阻塞。
Grok 本轮因上游连接失败未读取代码，未计入复核证据。

## 9. 残余与 owner 门

1. #4642/#4643/#4649/#4652/#4657/#4696-#4702 required CI 已绿；#4702 为
   Draft、required checks 3/3 PASS；全部未 merge；
2. edge `+` 产品接线和节点按钮群移除已由 C3 完成；
3. drag feedback 和分支拖排已由 C4 实现，C5/I1 已实现 Canvas、节点检查器、
   表单结构与字段属性的单一 history；真浏览器证据仍待补；
4. F1-a-F3 已有 palette、三栏 builder、字段命令、引用保护及附件双 flag
   authoring；不得在 T1 前宣称交互交付；
5. 版本时间线/双画布 diff、路由预览整合、真实键盘/a11y 仍未完成；
6. 390 虽无横向溢出，但 sticky bottom navigation 会遮住内容，属于 X1；
7. production Canvas 仍默认 OFF；staging UAT 与生产 flag 为 owner 门；
8. 结构化辅助编辑入口必须保留，直到键盘/辅助技术等价性有真浏览器证据。

## 10. 结论

- `A1 renderer feasibility = PASS`；
- `A2 first extraction = PR VERIFIED / CI PASS`；
- `C1 unified carrier = PR VERIFIED / CI PASS`；
- `C2 canvas-first = PR VERIFIED / CI PASS`；
- `F1-a form palette and insertion = PR VERIFIED / CI PASS`；
- `C3 edge insertion = DRAFT PR / LOCAL REQUIRED PASS / EXACT-HEAD PR CI PASS / CLEAN`；
- `F1-b form builder and inspector = DRAFT PR / LOCAL REQUIRED PASS / EXACT-HEAD PR CI PASS / CLEAN`；
- `C4 semantic drag = DRAFT PR / LOCAL REQUIRED PASS / BROWSER EVIDENCE PENDING`；
- `C5 unified canvas history = DRAFT PR / EXACT-HEAD PR CI PASS / CLEAN / BROWSER EVIDENCE PENDING`；
- `F2 form command protection = DRAFT PR / LOCAL REQUIRED PASS / REAL DB PASS / PR CI PASS`；
- `F3 attachment authoring = DRAFT PR / EXACT-HEAD PR CI PASS / CLEAN / BROWSER EVIDENCE PENDING`；
- `I1 form + canvas single history = DRAFT PR / LOCAL REQUIRED PASS / EXACT-HEAD PR CI PASS / BROWSER EVIDENCE PENDING`；
- `approval editor parity line = IN PROGRESS / NOT FINAL`；
- 下一开发点为 T1 真浏览器、V1/V2、P1 和 X1；T1/U0 前不得标 FINAL。
