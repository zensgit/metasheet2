# 审批编辑器与流程画布 E1 Renderer Spike 验证

**状态：** SPIKE COMPLETE / A1 PARTIAL
**基线：** `origin/main@d449aa7e6d02f94df2738a77cafffa778b12fde0`
**实验分支：** `codex/approval-editor-e1-renderer-spike-20260727`
**日期：** 2026-07-27
**产品代码、路由、依赖、flag：** 零改动

本报告验证一个隔离的 DOM + SVG 受约束垂直树 renderer 是否能承载审批
画布的布局、分支可读性、响应式检查器和真浏览器验收。它不授权把实验
代码接入生产，也不把“能渲染”解释为“编辑器已对标飞书/钉钉”。

## 1. 模型分工与实际运行

| 环节 | 实际模型/执行者 | 结果 |
|---|---|---|
| exact-head 对抗审阅 | Claude `claude-opus-5` | 只读审阅完成；Codex 逐条复核并形成 E0 |
| 视觉 IA 批评 | 本机 Kimi Code 当前配置模型 | 完成；CLI 未给出可验证的 K3 型号，因此不宣称 exact K3 |
| 隔离 renderer 与 Playwright | `grok-4.5-build` | 生成 5 个 verification 文件；未改生产路径 |
| 最终裁决、补测与门控 | Codex | 发现并修正 ESLint 漏项，补确定性/百节点交互/耗时证据 |

Grok Bridge 本地 server 未成功启动，且主机 DNS 对 Grok CLI endpoint 的
解析异常。执行改用已认证的原生 Grok CLI，并通过仅监听
`127.0.0.1` 的临时 CONNECT 转发访问正确 endpoint；未修改系统 DNS，
未扩大代码发送范围。

## 2. 实验交付物

实验只新增：

- `apps/web/verification/approval-flow-canvas-e1-fixtures.ts`
- `apps/web/verification/approval-flow-canvas-e1-layout.ts`
- `apps/web/verification/approval-flow-canvas-e1-harness.html`
- `apps/web/verification/approval-flow-canvas-e1-harness.ts`
- `apps/web/verification/approval-flow-canvas-e1.spec.ts`

夹具覆盖：

1. 线性 `start -> approval -> cc -> end`；
2. 条件分支、默认分支与 priority-only 重排；
3. `joinMode=all/any` 的三路并行，且一条分支内含 condition；
4. 长节点名、长分支名、三行摘要；
5. 100 节点混合图；
6. legacy、timeout、approvalThreshold 三种只读保真图；
7. 1440、1024、390 三种 inspector 呈现。

实现保持坐标、选中态、sheet 状态只存在于 render model；夹具中的
`ApprovalGraph` 不写入坐标。

## 3. Fail-first 记录

首次真浏览器运行不是假绿：

```text
desktop: FAIL
edge e4 crosses card "其他处理"
compact: PASS
narrow: PASS
```

失败来自 nested condition 与 parallel sibling 共用 lane，join edge 穿过
中间卡片。修复没有删除、跳过、放宽或 special-case
`assertEdgesDoNotCrossCards`，而是：

1. gateway 子树按配置顺序分配互斥连续 lane；
2. nested gateway 先计算 subtree width；
3. join 固定在所属 parallel strip 中央；
4. SVG edge 使用 obstacle-aware orthogonal routing；
5. 找不到直达 corridor 时绕开 blocker card。

同一断言随后在全部 viewport 与夹具通过。

Codex 复核又发现两个模型未报告的问题：

- layout 中一个未使用的 `rank`；
- Playwright 中一个未使用的 `labels`。

定向 ESLint 因此先红，再做最小清理后转绿。该过程说明
`vue-tsc` 绿不能替代 lint 门。

## 4. 真浏览器结果

执行：

```text
pnpm exec playwright test \
  verification/approval-flow-canvas-e1.spec.ts \
  --config playwright.verification.config.ts
```

结果：

```text
chromium: 3 passed
desktop 1440x900: PASS
compact 1024x768: PASS
narrow 390x844: PASS
mixed-100 render: first=105.53ms repeat=105.15ms
```

浏览器断言包括：

- 卡片不重叠；
- 非端点 edge 不穿卡；
- 页面无水平溢出；
- condition/parallel lane 顺序来自 gateway config，default 最右；
- 100 节点两次加载的卡片坐标与 edge path 完全一致；
- 100 节点中的后段节点可滚动、选择并打开 inspector；
- edge `+` 可键盘激活；
- 单一 polite live region；
- card 内无动作按钮群；
- DOM 文本、title 与 `aria-label` 不出现 raw node/edge key；
- 1440 使用 360px dock，1024 使用 320px overlay，390 使用 bottom sheet；
- reduced-motion media rule 存在；
- read-only fidelity 图不提供 insertion。

视觉输出：

- `apps/web/verification-output/e1-desktop-linear.png`
- `apps/web/verification-output/e1-desktop-parallel-any.png`
- `apps/web/verification-output/e1-desktop-long-labels.png`
- `apps/web/verification-output/e1-desktop-mixed-100.png`
- `apps/web/verification-output/e1-compact-1024.png`
- `apps/web/verification-output/e1-narrow-390.png`

静态门：

```text
targeted ESLint: PASS
vue-tsc --noEmit: PASS
```

## 5. Renderer 决策

**当前决定：继续验证无新依赖的 DOM + SVG constrained renderer，不在
本阶段引入 Vue Flow 或 ELK。**

理由：

1. branch-order、nested condition、parallel join、动态卡高和 100 节点已
   在真 Chromium 中可行；
2. 当前实验不增加 production bundle，也没有新增许可证；
3. ApprovalGraph、命令代数和 fail-closed 校验可以继续保持独立；
4. 现在引入通用图编辑库不能自动解决业务语义、权限、版本保真和命令
   入口问题，反而增加第二套状态模型风险。

这不是永久排除 Vue Flow/ELK。只有 E1-b 或 C1 证明现有方案无法满足
拖拽命中、焦点或大图性能，才重新打开依赖决策。

## 6. 未关闭项

### A1-1 mutation 尚未接生产命令代数

实验中的 edge `+` 只打开菜单并播报选择，不写 graph。它证明可供性与
键盘路径，不证明 `approvalCanvasCommands`、undo、保真或保存。

**关闭条件：** E1-b 在隔离 harness 中挂一个 command adapter，至少用同一
命令入口完成 insert、branch reorder 和 constrained move；拒绝路径必须
保持 graph byte-identical。

### A1-2 drag slot 尚无真浏览器证据

实验有 edge insertion control，没有 pointer/drag hit-test。生产代码已有
受约束 drag，但本实验 renderer 尚未证明合法槽高亮、非法落点 no-op 和
焦点恢复。

**关闭条件：** E1-b 增加一个合法拖动、一个非法拖动和键盘等价测试，
不得在 renderer 复制拓扑判断。

### A1-3 round-trip 与 CI 未证明

实验不调用 hydrate/save，不在 required CI。未编辑 byte-identical、
unknown config 保真、required web-tests 两点接线仍属于后续产品切片。

### P3 视觉密度

复杂并行图的每段 edge 都显示 `+`，branch label、线和 `+` 在局部较密。
产品化时应在 hover/focus/selected path 才强化 insertion affordance，
同时保持键盘可发现性；不能通过缩小触控目标解决。

## 7. Gate 结论

- **E1 可行性 spike：PASS。**
- **A1 生产晋级门：PARTIAL。**
- **允许并行启动 E2 无行为抽取：是，E2 只依赖 E0。**
- **允许启动 C2 canvas-first：否，先关闭 E1-b 与 C1 round-trip。**
- **允许开启 staging/production Canvas flag：否。**

下一执行顺序：

1. E1-b：command adapter + drag hit-test；
2. E2：`TemplateAuthoringView.vue` 无行为抽取，可与 E1-b 并行；
3. E0 P2-2/P2-3/P2-4 可独立小 PR 先关闭；
4. E0 P2-1 与 E2/F1 合并规划，避免两次修改热文件；
5. C1 在 E1-b 与 E2 后开始。
