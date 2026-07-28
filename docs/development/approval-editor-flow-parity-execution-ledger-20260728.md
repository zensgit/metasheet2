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
| C1 | 线性/复杂流程统一 Canvas 载体 | E2 head / `codex/approval-editor-c1-unified-canvas-20260728` | `bbd436177` | Claude Opus 5 实现；Kimi exact-head 只读复审 | 真实视图写回、payload/dirty、promote 保真、flag fallback、删除下限及浏览器三 viewport | Draft PR #4649；CI 运行中 |

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

| 面 | E1-b | E2 | C1 |
|---|---|---|---|
| 设计方向 | 已由 delta 计划约束 | 已由 delta 计划约束 | 已由 delta 计划约束 |
| 实现 | 完成 | 完成 | 完成 |
| 本地测试 | PASS | PASS | PASS |
| 判别变异 | PASS | PASS | PASS（3 刀） |
| 独立复审 | Codex | Codex | Kimi APPROVE，无 P1/P2；Codex复核修 P3 |
| 提交 | 是 | 是 | 是 |
| push / PR | #4643 | #4642 | #4649（stacked on #4642） |
| required CI | PASS | PASS | 运行中 |
| merge | 否 | 否 | 否 |
| staging / UAT | 否 | 否 | 否 |
| production flag | 保持 OFF | 保持 OFF | 保持 OFF |

## 5. 后续顺序

1. 审阅并按依赖落 #4642 -> #4649；#4643 是 verification-only 独立支线；
2. C2 接通 canvas-first，C3 把节点按钮群改为边 `+`，C4/C5 收拖拽与 undo/redo；
3. F1 抽表单 builder，并实现左 palette 拖入 + 中画布 + 右字段检查器；
4. F2/F3 补字段引用保护与附件 authoring；
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
- 真 Chromium 在 1440 / 1024 / 390 无横向溢出或 console error；
- 390 下 sticky bottom navigation 遮挡、卡片内按钮群和紧凑触控尺寸仍属于
  C2/C3/X1，未被 C1 结论掩盖。
