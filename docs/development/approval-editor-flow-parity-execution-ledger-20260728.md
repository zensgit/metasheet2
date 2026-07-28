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
| E0 | exact-head 审计 | `d449aa7e6` / `codex/approval-editor-flow-parity-plan-20260727` | `1941e2f0c` | Claude Opus 5 只读反例 + Codex | 代码、测试、flag、设计锁逐项核对 | 文档已提交；未 push |
| E1 | renderer spike | `origin/main@9da0335b4` / `codex/approval-editor-e1b-command-drag-20260728` | `6151d37cb` | Grok 4.5 Build；Kimi 做视觉 IA | Playwright、ESLint、类型、截图与 100 节点复核 | verification-only；未 push |
| E1-b | 生产命令适配、drag、history | 基于 E1 / `codex/approval-editor-e1b-command-drag-20260728` | `1303d7ba7` | Grok 4.5 Build | 发现并修复移动后 stale focus id；补判别变异 | verification-only；未 push |
| E2 | Flow Canvas presentational shell 抽取 | `origin/main@9da0335b4` / `codex/approval-editor-e2-shell-extract-20260728` | `ffe0c6229` | Claude Sonnet 5 | 清理 4 个 lint 残差；247 测、类型、事件变异 | local verified；未 push |

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

| 面 | E1-b | E2 |
|---|---|---|
| 设计方向 | 已由 delta 计划约束 | 已由 delta 计划约束 |
| 实现 | 完成 | 完成 |
| 本地测试 | PASS | PASS |
| 判别变异 | PASS | PASS |
| 提交 | 是 | 是 |
| push | 否 | 否 |
| required CI | 未运行 | 未运行 |
| merge | 否 | 否 |
| staging / UAT | 否 | 否 |
| production flag | 保持 OFF | 保持 OFF |

## 5. 后续顺序

1. 对 E1-b、E2 做 owner review；决定是否 push / 开 PR；
2. 合入 E2 后才启动 C1 线性/复杂图统一 adapter；
3. C1 的未编辑 round-trip 和旧图保真通过后，才启动 C2 canvas-first；
4. E0 的 required CI、业务错误文案和表单命令绕过问题分别小刀关闭；
5. F1 在 E2 后抽表单 builder，再做 palette 拖入；
6. T1 真浏览器 required CI 全闭合后才进入 staging UAT；
7. production flag 和结构化辅助入口退役始终由 owner 单独决定。
