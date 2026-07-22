# 审批、自动化与 Canvas 本轮收尾验证（2026-07-22）

**结论：CODE COMPLETE FOR THE NAMED THREE SLICES; PENDING LANDING, PROGRAM UAT AND FLAGS**

本文只对 #4531/#4532/#4533 的 exact heads 与命名组合树负责。它不把 Draft PR、CI、合入 main、
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

- Head：`9d1608c566c39944351f049c8dd222735a1e6839`。
- Kimi K3 只读对抗审阅发现并推动关闭：可见内部 edge/node keys、节点 mouse-only 两项 P2。
- Codex 后续发现并关闭未命名节点标题回退到 raw key 的残余。
- inspector 10/10；authoring/topology 159/159；web typecheck 与生产构建通过。
- 三个判别 mutation 分别钉住 Enter 选择、业务标签和未命名节点类型回退。
- Playwright 证据：桌面 400px inspector；390px 视口内无页面级横向溢出并自动揭示检查器。

## 2. #4532 + #4533 合成树

合成方式：从 `origin/codex/approval-tree-authoring-v1-clean` 建 detached worktree，依次合并 #4532 与 #4533，
无冲突；synthetic head 为 `1061d8645`。验证后 worktree 和临时依赖 symlink 已清理。

| Gate | 结果 | 证明范围 |
|---|---:|---|
| backend approval product service | 128/128 | graph authority 与 clone/all-path join |
| frontend authoring/topology set | 211/211 | inspector、并行/条件/抄送、layout/topology 组合 |
| backend `tsc --noEmit` | pass | 合成后端类型面 |
| web `type-check` | pass | 合成前端类型面 |
| web production build | pass | Vite 生产产物可生成 |

构建中的既有 chunk-size warning 与测试期间非阻塞 WebSocket port warning 未被误报为产品失败。

## 3. CI 与 PR 状态（记录时点）

| PR | Draft | Base | Checks observed |
|---|---|---|---|
| #4531 | yes | `codex/approval-record-link-layer2-20260721`（#4524 head branch） | `pr-validate` success；真库证据来自本地 exact-head gate |
| #4532 | yes | `codex/approval-tree-authoring-v1-clean` | `approval-web-guard`、`pr-validate` success |
| #4533 | yes | `codex/approval-tree-authoring-v1-clean` | `approval-web-guard`、`pr-validate` success |

PR 仍为 Draft，因此本轮没有 merge、deploy 或 flag 变更。
各 slice 与合成树使用的文件集合不同，31/159/211 是各自收集结果，不应做加法推导。

## 4. 剩余开发与 owner 门

### 工程侧仍未完成

1. 将 #4439 版本 diff/restore 叠到最终 Canvas 组合树并重跑 restore-after-validation 回归。
2. 下一阶段 Canvas parity：semantic drag/reorder、zoom/pan/minimap、版本可视化 overlay 和移动 bottom sheet。
3. 根据 #4510 落地形态 rebase #4524/#4531，并在最终头重跑 S1-S8 正式矩阵。

### Owner-only

1. 审阅并决定 #4510 是整包落地还是拆成来源 PR + residual delta。
2. 按台账序列审合 Canvas 与 FWB stacks。
3. 在真实企业、真实模板和真实数据上执行 UAT。
4. 观察指标后按 durable -> Class A -> Class B -> FWB 分级开启 flags。

## 5. 最终验收条款

只有同时满足以下条件，审批/自动化数据闭环才可标记为 `FINAL`：

- 所有命名 PR 已在 `main`，最终组合头的 required checks 全绿；
- S1-S8 在 merged main 上使用生产调用链 8/8；
- 审批值新建记录、精确更新已有记录、decision-value writeback 均有真实租户正反例；
- 并行/条件组合模板可保存、发布、运行、版本恢复，恢复后的非法图被拒绝；
- flags 分级开启后没有重复写入、poison、stuck lease、权限 oracle 或回退到 legacy 丢事件。

在这些门完成前，准确状态是“本轮三片代码完成并验证，审批线尚未生产收官”。
