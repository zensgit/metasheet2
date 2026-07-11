# 集成后续四线 + Bridge Agent apply 线 — 目标池收官台账（2026-07-08）

> 承接 `post-integration-four-line-development-completion-20260708.md`（#3916）。该 MD 之后本轮又落
> BA-APPLY-2a / disposition(2b=WONTFIX) / BA-APPLY-3，Bridge Agent 受控 apply 线**终态定型**，故补此收官台账。
> owner `/goal`：余下开发为总目标池，可建即建、门控即停、外部即等，完成给设计+验证 MD。

## 1. 本轮全部落地（自 #3916 后新增）

| rung | PR | 证明 |
|---|---|---|
| BA-APPLY-2a 后端审批门+审计+values-free 暂存 | #3938 | 四闸 KILLED（op-whitelist / 审批门 fail-closed / 零 Agent 写结构性 / sentinel）；consumer-面口径固化 |
| Disposition：2b=WONTFIX by design | #3936 | 安全模型级决定（非成本）；§7 终态表；#3746 最终口径回贴 |
| BA-APPLY-3 应用后自动复探测确认 | #3946 | M1/M2 派生守卫 KILLED；结构性零写；SENTINEL 无泄漏；无 list-route；45 全绿 |

（#3916 已含：BA-APPLY-1 #3894 · W2-a #3899 · TC-1 #3906 · 4 设计锁）

## 2. Bridge Agent 受控 apply 线 — 终态

```
只读诊断(BA-UI-1) → values-free 探测(BA-UI-2) → 变更建议(BA-UI-3)
  → 机读清单导出(BA-APPLY-1) → 后端审批门+审计+values-free 暂存(BA-APPLY-2a)
  → 运维 handoff(人工执行只读 allowlist/config 变更 = 人类把关点)
  → 自动复探测确认(BA-APPLY-3) ✅ 终态
```

**不变量**：Agent 恒 `readonly:true`；本平台/页面**从不**向 Agent 或客户机器写配置；
低频高后果的 allowlist/config 变更**刻意保留运维手工把关**（安全边界，不适合自动 API 化）。
**2b（给 Agent 加 config-write 端点）= WONTFIX by design**，除非 owner 未来显式重新 ratify Agent 安全模型。

## 3. 目标池最终分类（诚实台账）

### ✅ 已完成（可建即建，全部过闸落地）
四设计锁 · BA-APPLY-1 · W2-a · TC-1 · BA-APPLY-2a · disposition · BA-APPLY-3

### 🔒 门控（等 owner 逐项 opt-in，不擅建）
| 项 | 门 |
|---|---|
| W2-b（token/route-wiring） | owner opt-in；含 W2-a wiring 前置验收（real-store→4-key 投影→dryRun 字节等价） |
| W3（sandbox 写）/ W4（生产写） | owner opt-in；W4 客户面禁 |
| REC-R1（递归 BOM） | demand-gate：需具名 ≥3 层 BOM 用例 + opt-in（#3877 readiness 锁） |
| TC-2+（模板目录扩展/上架流） | owner opt-in |
| BA-APPLY-2b | WONTFIX by design（安全模型）——不复活 |

### 🔒 外部（我方不可建，等实体机 Codex 开 PR）
Track B #3888 / #3889 / #3890（当前为 OPEN issue，无 PR）——PR 出后按 #3890→#3889→#3888 审阅落地。

## 4. 本轮方法论（供复盘）

- **模型分工受 weekly limit 约束**：2026-07-08 起 Sonnet subagent 触及 weekly 上限（resets Jul 12），
  BA-APPLY-3 改由**主循环（Opus）亲手实现**——有界 Vue 切片可主循环建，增量提交保 WIP。并行 subagent
  开发在限额恢复前受限；本轮转为**主循环串行建 + 自闸**。
- **质量闸不变**：每 runtime 逐守卫 mutation（KILLED 才算测试咬住）；结构性零写 grep；values-free SENTINEL；
  consumer-面非 browse-面纪律。
- **落地力学**：串行落（一个 MERGED 再碰下一个）；BEHIND≠需 rebase（只是等 checks）；扩展既有 spec 无新文件 → 无 yml 改动。

## 5. 收官声明

目标池里**我方能自动完成的 runtime 已全部落地**。余下全为**门控**（等 owner 一句话 opt-in）或**外部**
（等实体机 PR）——按红线纪律**停门前**，不为凑“完成”去建门控项或复活 WONTFIX。任一门控项 owner 一句话即可解锁开建。
