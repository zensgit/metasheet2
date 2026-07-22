# 审批、自动化与 Canvas 收口执行台账（2026-07-22）

**状态：IMPLEMENTED ON REVIEW BRANCHES / NOT LANDED AS A PROGRAM**

基线：`origin/main@1a209a5cc`。本台账是 SHA 级证据，不是合并或启用授权。

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
| 2b | #4533 `9d1608c56` | 画布节点检查器、业务标签、键盘操作 | Draft；基于 #4433；与 #4532 已合成验证 |
| 3 | #4439 `e78649428` | 模板版本 diff 与安全恢复 | 基于 #4433；需在最终 Canvas 组合树复绿 |
| A | #4510 `f6d05814a` | 数据闭环与 Canvas foundation 集成候选 | Draft；大集成 PR，不能与来源 PR 重复落地 |
| B | #4524 `f52c58545` | 安全 record-link 表单字段与普通用户选择器 | Draft；基于 #4510 |
| C | #4531 `b0fbd827f` | FWB-2 更新选择的已有记录 | Draft；基于 #4524 |

历史来源 PR #4491、#4342、#4489 的产品内容已被 #4510 吸收并进一步修正。落地时只能选择：

1. 审阅并落 #4510，随后关闭/标记被吸收的来源 PR；或
2. 先落来源 PR，再把 #4510 重建成只含剩余差异的 PR。

禁止同时 squash 整个 #4510 与完整来源 PR；那会产生重复迁移、重复接线和不可审阅历史。

## 3. 推荐落地序列

### 3.1 Canvas 车道

1. 复审并合入 #4433。
2. 将 #4532 rebase/retarget 到 `main`，复跑后端 graph authority。
3. 将 #4533 rebase 到包含 #4532 的头，复跑 128 后端 + 211 前端组合门和生产构建。
4. 将 #4439 rebase 到最终 Canvas 头，验证 restore 生成的新 draft 同样受 #4532 校验。
5. 之后再开 semantic drag、zoom/pan/minimap 和 version overlay；不得与前三步抢同一 Vue hot file。

### 3.2 数据闭环车道

1. owner 先裁决 #4510 的整包落地形态。
2. #4510 落地或拆解完成后，依次 rebase #4524 -> #4531。
3. 在最终组合头运行正式 S1-S8 矩阵，特别核对 approval completed -> durable adapter -> FWB -> revision/outbox。
4. flags 保持 OFF；真实租户 UAT 后再分级开启。

Canvas 与数据闭环可以并行审阅和落地，因为当前文件所有权不重叠；各车道内部必须按上述 base 顺序串行。

## 4. 多模型分工与验收边界

| 模型/角色 | 本轮使用 | 最适合的后续任务 | 不承担 |
|---|---|---|---|
| Kimi K3 | Canvas UX/可访问性长上下文审阅，发现内部 key 与鼠标-only 两项 P2 | 信息架构、画布密度、响应式交互、设计一致性 | 安全/并发最终 verdict |
| ReClaude Opus 4.8 | FWB authz/oracle 与并行拓扑的独立对抗审阅 | transaction、authz、并发、恢复、启动 fail-closed | 自己实现后的唯一审阅者 |
| Grok | 跨 PR 只读依赖核对；本次 bridge 不稳定，直接 CLI 只完成部分审计 | 有明确文件所有权的实现与测试 | 合并授权或不完整审计的“APPROVE” |
| Codex | 实现修复、合成树、真实测试、最终判定和文档 | hot-file 集成与最终证据归档 | owner 的 ratify/UAT/flag 决定 |
| Sonnet/Fable | 本轮未放在关键路径 | Sonnet 做中型 Vue 切片；Fable 做非敏感台账初稿 | 锁、authz、并发终审 |

任何代理的结论都必须绑定 exact head；rebase 后需重跑命名测试，不能沿用旧 verdict。

## 5. 下一轮并行编排

| Lane | 可并行工作 | 写入范围 | 退出条件 |
|---|---|---|---|
| C1 | Canvas semantic drag/reorder | graph command + canvas interaction 独占 | 键盘等价路径、无非法拓扑、撤销/重做 |
| C2 | zoom/pan/minimap/large graph | renderer/layout 独占 | 1440/1024/390 截图与非空像素门 |
| V1 | version visual diff/restore UX | history/version components 独占 | 不覆盖历史、恢复后重校验 |
| D1 | FWB/record-link 最终组合 | backend FWB hot files 独占 | 真库矩阵、权限撤销、重复投递净一次 |
| Q | 对抗审阅 | 只读 | P1/P2 清零或明确 REQUEST CHANGES |

C1、C2、V1 在拆开组件后可并行；D1 与前端车道可并行。共享 `TemplateAuthoringView.vue` 前必须先指定唯一集成人。
