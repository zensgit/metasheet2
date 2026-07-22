# 审批、自动化与 Canvas 本轮收尾验证（2026-07-22）

**结论：CODE COMPLETE FOR THE NAMED CANVAS AND FWB STACKS; PENDING REVIEW, LANDING, PROGRAM UAT AND FLAGS**

本文只对 #4531/#4532/#4533/#4536/#4537/#4538/#4539 的 exact heads 与命名组合树负责。它不把 Draft PR、CI、合入 main、
真实租户 UAT 或生产启用混为一件事。

## 1. 审阅结论

### #4531 — FWB-2 更新已有记录

- Head：`b0fbd827fcc4c1539420679c016e681f94528db4`。
- ReClaude Opus 4.8 独立审阅：无 P1/P2。
- Codex 复核 capability resolver 和 projection 行为；不存在把任意 record id 当作写入目标的旁路。
- 缺失/越权/锁定/不可写统一持久化为 `fwb_rejected:linked_record_unavailable`，关闭记录存在性 oracle。
- 真库 15/15，单元 14/14，backend typecheck 通过；oracle mutation RED 后恢复 GREEN。

### #4532 — 并行条件路径汇合

- Head：`5c2c73f57dba25dba6175cd5aad231a450c38eae`。
- ReClaude Opus 4.8 独立审阅：APPROVE，无 P1/P2。
- 后端 authority 128/128，前端相关 31/31，前后端 typecheck 通过。
- 变异删除 all-path join guard 后命名测试 RED；恢复后 GREEN。
- 第二轮修复把相同校验应用到 cloned workflow draft，避免只保护新模板。

### #4533 — Canvas V2 节点检查器

- Head：`f98791b647bc1fa2f28bca29a365afd0ae66fc41`。
- Kimi K3 只读对抗审阅发现并推动关闭：可见内部 edge/node keys、节点 mouse-only 两项 P2。
- Codex 后续发现并关闭未命名节点标题回退到 raw key 的残余。
- inspector 10/10；authoring/topology 159/159；web typecheck 与生产构建通过。
- 三个判别 mutation 分别钉住 Enter 选择、业务标签和未命名节点类型回退。
- Playwright 证据：桌面 400px inspector；390px 视口内无页面级横向溢出并自动揭示检查器。

### #4536/#4537/#4538 — 版本、导航与语义重排

- Heads：#4536 `e338bce439b14bcf2aa54e393386ebc7646a7fc7`；#4537
  `2a5c4b91600c58f6d60ea81c8ed63cb12627d977`；#4538 `c43ee9fa494fdde25c59ec486a02878116d90cc3`。
- #4536 将版本 diff/restore 接入当前 Canvas，并确保恢复生成新 draft 后重新执行拓扑校验。
- #4537 交付 zoom/pan/minimap、版本 overlay 与窄屏导航，不改变 graph authority。
- #4538 交付同一区域内 topology-backed reorder；required web gate 353 files / 4207 tests、生产构建通过。
- 两个重排 mutation 分别钉住 same-region guard 与 rewire；ReClaude 调用返回 `Execution error`，未记独立 verdict。

### #4539 — FWB 生产 authoring 与写回组合

- Head：`6f6ebcfce54b92426199f05943035e457c9b831f`，stacked on #4531。
- UI 支持新建当前表记录与更新审批表单 record-link 指向记录；普通用户全程使用选择器和映射表，不接触 JSON。
- update target 只由服务端从模板顶层 pinned record-link 推导；跨表确认要求目标表管理能力，保存要求同 actor receipt。
- 目标 schema 在执行时重读；create/update 都复用 claim + mutation + revision + chained outbox 同事务合同。
- Kimi K3 找到并推动关闭 3 个 P2：失效 link 显示 raw id、瞬时加载失败无恢复、切换模式静默清空映射。
- required web gate 355 files / 4277 tests，focused frontend 68/68，生产构建与双端 typecheck 通过。
- fresh Postgres 完整迁移后 FWB create 18/18、update 15/15、正式矩阵 9/9，共 42/42；确认路由 14/14。
- 八个判别 mutation 分别钉住 target permission、update hash subject、actor receipt、date lexical guard、
  stale-link marker、linked-schema retry、destructive-switch confirmation 与旧抽屉 linked-schema generation guard。
- 精确 number mapping 仍明确不可选；这不是遗漏，而是普通编辑/查询/公式/汇总/导出全链精度尚未证明。

## 2. 组合树验证

Canvas 使用严格 stacked PR：#4532 -> #4533 -> #4536 -> #4537 -> #4538。数据闭环使用
#4524 -> #4531 -> #4539。每层保留自己的 exact-head gate；没有把一个车道的绿灯冒充另一个车道或 merged-main 证据。

| Gate | 结果 | 证明范围 |
|---|---:|---|
| backend approval product service | 128/128 | graph authority 与 clone/all-path join |
| Canvas required web gate | 353 files / 4207 tests | #4538 最终 Canvas 头 |
| FWB required web gate | 355 files / 4277 tests | #4539 最终 FWB 头 |
| FWB real-DB composition | 42/42 | create、update、S1-S8 matrix |
| backend/frontend typecheck | pass | 两车道 exact heads |
| web production build | pass | 两车道 Vite 生产产物可生成 |

构建中的既有 chunk-size warning 与测试期间非阻塞 WebSocket port warning 未被误报为产品失败。

## 3. CI 与 PR 状态（记录时点）

| PR | Draft | Base | Checks observed |
|---|---|---|---|
| #4531 | yes | `codex/approval-record-link-layer2-20260721`（#4524 head branch） | `pr-validate` success；真库证据来自本地 exact-head gate |
| #4532 | yes | `codex/approval-tree-authoring-v1-clean` | `approval-web-guard`、`pr-validate` success |
| #4533 | yes | #4532 head branch | exact-head local gate；远端 checks 独立结算 |
| #4536 | yes | #4533 head branch | exact-head local gate；远端 checks 独立结算 |
| #4537 | yes | #4536 head branch | exact-head local gate；远端 checks 独立结算 |
| #4538 | yes | #4537 head branch | required web 353/4207；生产构建 pass |
| #4539 | yes | #4531 head branch | required web 355/4277；真库 42/42；生产构建 pass |

PR 仍为 Draft，因此本轮没有 merge、deploy 或 flag 变更。
各 slice 与合成树使用的文件集合不同，31/159/211 是各自收集结果，不应做加法推导。

## 4. 剩余开发与 owner 门

### 工程侧仍未完成

1. 当前 Draft stacks 尚未按父子顺序落 main；每次 retarget/rebase 后必须重跑命名门。
2. 精确数字写回尚未开发完成，当前门应继续拒绝 number mapping。
3. 任意边重连、跨区域拖排、大图虚拟化、逐节点版本 cherry-pick 和完整移动 bottom sheet 属后续新锁。

### Owner-only

1. 审阅并决定 #4510 是整包落地还是拆成来源 PR + residual delta，避免与来源 PR 重复落地。
2. 按台账序列审合 Canvas 与 FWB stacks；本 MD 不构成 merge authorization。
3. 在真实企业、真实模板和真实数据上执行 UAT。
4. 观察指标后按 durable -> Class A -> Class B -> FWB 分级开启 flags。

## 5. 最终验收条款

只有同时满足以下条件，审批/自动化数据闭环才可标记为 `FINAL`：

- 所有命名 PR 已在 `main`，最终组合头的 required checks 全绿；
- S1-S8 在 merged main 上使用生产调用链 8/8；
- 审批值新建记录、更新指定已有记录、decision-value writeback 均有真实租户正反例；
- 并行/条件组合模板可保存、发布、运行、版本恢复，恢复后的非法图被拒绝；
- flags 分级开启后没有重复写入、poison、stuck lease、权限 oracle 或回退到 legacy 丢事件。

在这些门完成前，准确状态是“命名 Canvas/FWB stacks 代码完成并验证，审批线尚未生产收官”。
