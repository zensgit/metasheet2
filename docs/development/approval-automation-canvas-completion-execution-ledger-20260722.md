# 审批、自动化与 Canvas 收口执行台账（2026-07-22）

**状态：IMPLEMENTED ON REVIEW BRANCHES / NOT LANDED AS A PROGRAM**

记录基线：`origin/main@3d1b6cfa`。本台账是 SHA 级证据，不是合并或启用授权。

## 1. 已在 main 的底座

| 能力 | 状态 | 证据 |
|---|---|---|
| durable delivery S1-S5/S7 | 已合入 | #4337，`dfc9318fc` |
| FWB 映射、record-link executor、decision-value freeze | 已合入 | #4341/#4343/#4344 |
| FWB 幂等与事务底座 | 已合入 | FWB ledger 与既有 revision/outbox 合同 |

“底座已合入”不代表 action 注册、普通用户 record-link authoring、完整 Canvas 或 flag 已启用。

## 2. 当前实现队列

| 顺序 | PR / head | 内容 | 当前门 |
|---:|---|---|---|
| 1 | #4433 `8ef543af1` | 分支编排与纵向流程画布基础 | owner review/merge；后续 Canvas PR 的 base |
| 2a | #4532 `5c2c73f57` | 所有并行条件路径汇合校验 | Draft；基于 #4433 |
| 2b | #4533 `f98791b64` | 画布节点检查器、业务标签、键盘操作 | Draft；stacked on #4532 |
| 3 | #4536 `e338bce43` | 模板版本 diff/恢复接入当前拓扑校验 | Draft；stacked on #4533 |
| 4 | #4537 `2a5c4b916` | zoom/pan/minimap 与版本 overlay | Draft；stacked on #4536 |
| 5 | #4538 `c43ee9fa4` | 同区域语义重排与 topology rewire | Draft；stacked on #4537 |
| A | #4510 `f6d05814a` | 数据闭环与 Canvas foundation 集成候选 | Draft；大集成 PR，不能与来源 PR 重复落地 |
| B | #4524 `f52c58545` | 安全 record-link 表单字段与普通用户选择器 | Draft；基于 #4510 |
| C | #4531 `b0fbd827f` | FWB-2 更新选择的已有记录 | Draft；基于 #4524 |
| D | #4539 `a22f2a04b` | FWB 新建/更新生产 authoring、server confirmation 与全链组合 | Draft；stacked on #4531 |
| Docs | #4535 `b49f8f244` | 本设计锁、执行台账、收尾验证 | Draft；本次更新后 SHA 另记 |

历史来源 PR #4491、#4342、#4489 的产品内容已被 #4510 吸收并进一步修正。落地时只能选择：

1. 审阅并落 #4510，随后关闭/标记被吸收的来源 PR；或
2. 先落来源 PR，再把 #4510 重建成只含剩余差异的 PR。

禁止同时 squash 整个 #4510 与完整来源 PR；那会产生重复迁移、重复接线和不可审阅历史。

## 3. 推荐落地序列

### 3.1 Canvas 车道

1. 复审并合入 #4433。
2. 依次 retarget/rebase #4532 -> #4533 -> #4536 -> #4537 -> #4538；每一层只在父层落 main 后移动。
3. 每层重跑其命名 guard；最终 Canvas 头重跑 topology/authoring、required web gate、生产构建和桌面/窄屏截图。
4. 不把 #4538 的同区域语义重排描述为任意边重连；跨区域重排和大图虚拟化另开锁。

### 3.2 数据闭环车道

1. owner 先裁决 #4510 的整包落地形态。
2. #4510 落地或拆解完成后，依次 rebase #4524 -> #4531 -> #4539。
3. 在 #4539 最终组合头运行正式 S1-S8 矩阵，特别核对 approval completed -> durable adapter -> FWB -> revision/outbox。
4. flags 保持 OFF；真实租户 UAT 后再分级开启。

Canvas 与数据闭环可以并行审阅和落地，因为当前文件所有权不重叠；各车道内部必须按上述 base 顺序串行。

## 4. 多模型分工与验收边界

| 模型/角色 | 本轮使用 | 最适合的后续任务 | 不承担 |
|---|---|---|---|
| Kimi K3 | Canvas UX/可访问性与 FWB authoring 长上下文审阅；本轮 FWB 找到 3 个 P2 并由 `a22f2a04b` 关闭 | 信息架构、画布密度、响应式交互、设计一致性 | 安全/并发最终 verdict |
| ReClaude Opus 4.8 | #4531 authz/oracle 与 #4532 拓扑审阅；#4538/#4539 调用发生 `Execution error`，不计 verdict | transaction、authz、并发、恢复、启动 fail-closed | 自己实现后的唯一审阅者 |
| Grok | 通过已授权 CLI 发起 #4539 只读审阅；只有产生 exact-head 结论后才记录 verdict | 有明确文件所有权的实现与测试 | 合并授权或不完整审计的“APPROVE” |
| Codex | 实现修复、合成树、真实测试、最终判定和文档 | hot-file 集成与最终证据归档 | owner 的 ratify/UAT/flag 决定 |
| Sonnet/Fable | 本轮未放在关键路径 | Sonnet 做中型 Vue 切片；Fable 做非敏感台账初稿 | 锁、authz、并发终审 |

任何代理的结论都必须绑定 exact head；rebase 后需重跑命名测试，不能沿用旧 verdict。

## 5. 下一轮并行编排

| Lane | 可并行工作 | 写入范围 | 退出条件 |
|---|---|---|---|
| C1 | 大图虚拟化与跨区域语义移动（新锁） | graph command + canvas renderer 独占 | 键盘等价路径、无非法拓扑、撤销/重做 |
| C2 | 移动 bottom sheet（新锁） | inspector/mobile chrome 独占 | 390px 触控、焦点恢复、无横向溢出 |
| V1 | 逐节点版本 cherry-pick（新锁） | history/version components 独占 | 不覆盖历史、冲突可解释、恢复后重校验 |
| D1 | 精确数字写回（新锁） | mapping + query/formula/export 全链 | 全链 decimal 语义证明后才能移除禁用门 |
| Q | 对抗审阅 | 只读 | P1/P2 清零或明确 REQUEST CHANGES |

C1、C2、V1 在拆开组件后可并行；D1 与前端车道可并行。当前 Draft stack 必须先按顺序落地，不能与这些新锁混合。
