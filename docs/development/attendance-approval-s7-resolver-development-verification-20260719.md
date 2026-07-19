# 考勤审批动态审批人 resolver（S7）开发与验证报告 — 2026-07-19

> 设计依据：`attendance-approval-s7-resolver-direct-manager-dept-head-multilevel-design-lock-20260716.md`
>（RATIFIED）。本文只证明 S7-0..S7-5 的代码交付与测试结果，不代表生产启用、客户 UAT
> 或对默认关闭开关的运营裁决。

## 1. 结论

S7 的代码切片已按锁定顺序完成：先修 approve/reject 授权源，再落判别联合与
fail-closed 扩展点，随后接入直属上级、部门主管、多级上级，最后把三种动态类型接到
A1 结构化编辑器。考勤审批引擎不再把动态步骤静默降级到管理员兜底；解析失败、端口缺失、
开关关闭或动态步骤形状非法时均显式失败。

运行时开关 `ATTENDANCE_APPROVAL_DYNAMIC_ASSIGNEE_SOURCES_ENABLED` 仍为默认 OFF。
本轮没有部署、环境变量修改、生产操作、issue 关闭或 release tag。

## 2. 交付台账

| 切片 | 交付 | 主线提交 / PR |
|---|---|---|
| Design lock | S7 语义、边界、OD-S7-1..6 与切片顺序 | `e93af98d4` / #4356 |
| S7-0 | approve/reject 对 active assignment 的对称授权；保留窄 scheduler-scope carve-out | `0105994a8` / #4396 |
| S7-1 | 判别联合 step 契约、authoring/runtime 双 fail-closed、host resolver port、默认 OFF flag | `f80594f37` / #4415 |
| S7-2 precursor | resolver port 只注入 `plugin-attendance`，其余插件 fail-closed | `761bf3597` / #4453 |
| S7-2 | `direct_manager`：org 锚定、创建时冻结 `managerId`、步进只读快照 | `ce885dc30` / #4471 |
| S7-3 | `dept_head`：org 锚定、创建时冻结 `deptHeadId`、步进只读快照 | `b09c380e2` / #4476 |
| S7-4 | `manager_at_level`：冻结 dense chain、按 level 精确取一名上级、环与上限守卫 | `00402ab39` / #4480 |
| S7-5 | A1 编辑器三种动态 kind、values-free readiness、host-authoritative level cap | `0c4d65dcd` / #4481 |

## 3. 关键正确性门

### 3.1 授权与 fail-closed

- S7-0 对 `user`、`role`、`source_queue` 三类 active assignment 做逐类型匹配，approve 与
  reject 同门；admin override 只在 assignment 匹配失败后生效。
- 动态步骤在 authoring create/update 与 runtime request-create/step-advance 两层受门。
  flag OFF、port 缺失、kind 未实现、resolver 抛错或无法解析审批人时，不写 instance、
  assignment 或 record，也不进入 legacy admin fallback。
- static step 与 dynamic step 为互斥联合；混合形状、未知 kind、非法 level 与额外动态参数
  不由前端静默修复，保留到后端并由 422 合约拒绝。

### 3.2 组织隔离与冻结

- directory lookup 在候选 tie-break 前按 `directory_integrations.org_id` 锚定，覆盖
  两 org 共用同一 local user 的反例。
- `managerId`、`deptHeadId`、`managerChainIds` 在请求创建时水合进
  `requester_snapshot`；后续步进只读冻结值，不因组织关系中途变化而换审批人。
- S7-5 readiness 端点只返回布尔值与 host 解析的最大层级，不返回账户、用户、integration
  或其他目录值；委派考勤管理员必须是目标 org 的 active member，平台管理员保留 override。

### 3.3 范围边界

- v1 只交付 `direct_manager`、`dept_head`、`manager_at_level`。
- `continuous_managers` 明确 OUT：它需要考勤侧 quorum / count-of-acted-assignees 语义后才可重入。
- S7 没有把 `plugin-attendance` 变成对整个 core-backend 的运行时依赖；只通过
  `context.services.approvalAssigneeResolver` 窄端口复用 host 内核能力。

## 4. 验证证据

| 切片 | 主要正控 | 关键 mutation / 对抗证据 |
|---|---|---|
| S7-0 | 14/14 真库：三 assignment 类型 x 正负 x approve/reject，加 admin 两腿 | 破坏 role 分支使 role 正腿红；绕过 reject gate 使三条 reject 负腿红 |
| S7-1 | 28 unit + 18 real-DB；create/update 与两条 runtime flag-flip 路径 | 去掉 mixed rejection 与 step-advance gate 均使对应腿红 |
| precursor | 4 腿 port-scoping + 真 loader 正控 | 恢复无条件注入后两条非 attendance 插件负例红 |
| S7-2 | 80 focused unit；56 S7 real-DB | 去掉 org anchor 后跨 org 反例选择 foreign manager 并红 |
| S7-3 | 88 unit；71 S7 real-DB；本切片 15/15 | 去掉 org anchor、step-advance gate、unresolved/freeze 各自使对应腿红 |
| S7-4 | 116 unit；90 S7 real-DB；本切片 24 unit + 14 real-DB | `level - 1`、short-chain validation、org anchor 三刀均被杀；Codex 补齐漏接 CI 的 P2 |
| S7-5 | focused FE 58/58；backend 11/11；web guard 24 files / 511 tests；full core 2314 suites / 8529 tests | extra-key、org-membership、stale-response 三刀均被杀；Codex 两轮修正 silent-repair、fallback cap、readiness auth/active-account 等问题 |

S7-5 首轮 CI 揭示新 route spec 使用 `request(app)`，被仓库 app-mode tripwire 拒绝；测试改接
`usePinnedServer()` 后，新 route spec 11/11、tripwire 2/2、完整 core-backend 8529/8529
均绿。该修复只改测试接线，不改产品行为。

## 5. 独立复审

S7-2..S7-5 的实现与初始测试由 Grok Build 执行，Codex 对当前 diff、运行时调用链、权限边界、
CI wiring 与 mutation 做独立复核。复核中实际拦下并修复了：S7-4 real-DB spec 未进入 required
lane；S7-5 对畸形/额外字段的静默修复；客户端自设最大层级 fallback/clamp；readiness 缺 active
account 与 org membership 约束；重复/泄漏式错误提示；以及 app-mode tripwire CI 接线。

最终代码 verdict：APPROVE，0 P1 / 0 P2。

## 6. 收口与剩余

S7-5 已合入，本设计锁内的自主代码开发量为零。剩余只有：

1. 把本验证报告合入主线。
2. 在部署到目标环境后，由 owner/operator 单独决定是否启用
   `ATTENDANCE_APPROVAL_DYNAMIC_ASSIGNEE_SOURCES_ENABLED`；默认 OFF 不变。
3. 启用前做 values-free readiness 与三种 kind 的受控 staging smoke；这不是客户 UAT，
   也不能由本文代替生产授权。

仓库仍有 #4353/#4354/#4355 三条 task-first UI 改善线；它们属于 vNext 体验优化，既不阻断
已归档的 attendance v1，也不阻断 S7 代码收口。飞书、原生硬件、多午夜排班、
`continuous_managers` 与审批照片 read-grant 继续按各自 gate 留在本轮 OUT。
