# 审批编辑器与流程编排 E1-b / E2 收尾验证（2026-07-28）

**范围状态：LOCAL VERIFIED**

**整线状态：NOT FINAL**

本报告只关闭 E1-b renderer/command feasibility 与 E2 第一刀无行为抽取。
它不宣称审批编辑器已对标完成，不授权 C1/C2、部署、UAT 或 flag 开启。

## 1. Exact heads

| 切片 | 分支 | exact head |
|---|---|---|
| E1-b | `codex/approval-editor-e1b-command-drag-20260728` | `1303d7ba7` |
| E2 | `codex/approval-editor-e2-shell-extract-20260728` | `ffe0c6229` |
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
| P3 | E2 抽取后父组件残留 3 个常量 import 和 1 个 helper | 删除机械残差；lint 转绿 |
| P3 | Claude Sonnet 卡在 Playwright MCP 启动，不是产品测试 | 终止悬挂 MCP；Codex 独立运行全部验证，不采信未完成模型声明 |

最终审阅未发现新的 P1/P2。

## 5. 残余与 owner 门

1. E1-b/E2 尚未 push、开 PR、跑 required CI 或 merge；
2. edge `+` 插入仍是 spike 演示，生产接线属于 C3；
3. C1 的统一线性/复杂图 adapter 尚未开发；
4. E0 的表单 command 绕过、required CI 收集和业务文案缺口仍未关闭；
5. production Canvas 仍默认 OFF；
6. staging UAT 与生产 flag 为 owner 门；
7. 结构化辅助编辑入口必须保留，直到键盘/辅助技术等价性有真浏览器证据。

## 6. 结论

- `A1 renderer feasibility = PASS`；
- `A2 first extraction = IMPLEMENTED + LOCAL VERIFIED`；
- `approval editor parity line = IN PROGRESS / NOT FINAL`；
- 下一开发授权点为：先审合 E1-b/E2，再单独授权 C1。
