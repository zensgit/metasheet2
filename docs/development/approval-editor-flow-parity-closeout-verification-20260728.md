# 审批编辑器与流程编排 E1-b / E2 / C1 / C2 / C3 / F1-a / F1-b 收尾验证（2026-07-31）

**范围状态：PR VERIFIED / REQUIRED CI PASS**

**整线状态：NOT FINAL**

本报告只关闭 E1-b renderer/command feasibility、E2 第一刀无行为抽取、
C1 线性/复杂流程统一载体、C2 canvas-first 工作区、C3 边 `+` 插入，及
F1-a/F1-b 表单 palette、三栏 builder/inspector 与插入移动交互。它不宣称
审批编辑器已对标完成，不授权 C4/C5、F2/F3、部署、UAT 或 flag 开启。

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

## 9. 残余与 owner 门

1. #4642/#4643/#4649/#4652/#4657 required CI 已绿；#4696/#4697 已开 Draft，
   本地门已绿、PR CI 单独结算；全部未 merge；
2. edge `+` 产品接线和节点按钮群移除已由 C3 完成；
3. 统一 drag feedback、分支拖排和 undo/redo 属于 C4/C5；
4. F1-a/F1-b 已有 palette、插入槽、字段移动和三栏 builder/inspector；完整
   引用保护和附件 authoring 仍属于 F2/F3；
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
- `C3 edge insertion = DRAFT PR / LOCAL REQUIRED PASS / PR CI PENDING`；
- `F1-b form builder and inspector = DRAFT PR / LOCAL REQUIRED PASS / PR CI PENDING`；
- `approval editor parity line = IN PROGRESS / NOT FINAL`；
- 下一开发点为 C4/C5 语义拖拽、分支排序与 undo/redo，并行推进 F2/F3
  引用保护和附件 authoring。
