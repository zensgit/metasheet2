# Multitable Global History — R6 Ratification & Decision Record(2026-07-08)

**性质:** owner 裁决记录。捕获 2026-07-08 owner 对 Global History 线五个闸门的一次性裁决,授权 R6 实施轮,并闭合三个不含代码的闸门。裁决原文(owner,会话内):

> 「O-1 已经可以判定通过。现在最顺的是推进 4c-1 / 4c-2 ratify;其中 4c-1 我仍建议选 full-read gate。T-source 继续保持 A2,destructive-tier FE 闭合判定可以基于今天这份 O-1 证据往前走。」

## 1. 五闸门裁决

| # | 闸门 | 裁决 | 处置 |
|---|---|---|---|
| 1 | 4c-1 lossy retype revert | **RATIFIED**,U-L8 = **full-read gate** | → R6 impl(下一 wave;wire 进 4c-2 捕获 seam) |
| 2 | 4c-2 forward tombstone-capture | **RATIFIED** | → R6 impl(本 wave,基座先行) |
| 3 | T-source | **保持 A2(最终)** | 闸门闭合,零代码——#3749 已上线的「锚定默认 + Advanced 手动兜底」形态即最终形态 |
| 4 | O-1 | **PASSED** | 见 §3 provenance |
| 5 | destructive-tier FE 闭合判定 | **可基于 O-1 证据闭合** | 见 §4 |

owner 同时将会话模型切换至 Opus 4.8(Fable 5 不可用回退)。

## 2. 4c-1 的 U-L8 裁决:full-read gate(锁定实施口径)

锁文 #3812 §2.2 给 owner 的二择一,owner 选 **(i) full-read gate**(祖源 `…unsafe-restore-design-lock-20260626.md:130` 的推荐项):

- **actor 缺全表读 capability ⇒ 本面整体 403**,**不提供任何 scoped loss-oracle**、不返回任何 undisclosed 标记。
- 因此 4c-1 impl **不实现** scoped 计数 + `undisclosedPresent` 分支(锁文 §2.2 的备选 (ii) 作废);loss-oracle 只对「已证明可读全表」的 actor 计算,天然无隐藏行泄漏面。
- golden 侧:锁文 L4 改为「无全表读权 → 403」形态;drift 重算(§2.3)因范围恒为全表可读,同尺比对无 undisclosed 边角(L5b 的 undisclosed 探针场景在 full-read gate 下不可达,保留为回归防护即可)。
- C2 no-oracle 因此以「gate 而非 marker」满足——最强口径。

## 3. O-1 PASSED 的 provenance(诚实记录)

owner 判定 O-1 通过,依据 = #3820 的**本地彩排**证据(6 run 全预期,三 flag 全开 **40 PASS / 0 FAIL / 0 SKIP**,harness 零缺陷)。**如实声明:这是本地 docker 彩排,不是 staging 正式验收跑**;owner 行使其闸门裁量权,判定本地证据已足以认定 O-1 通过。#3820 已把 staging 首跑摩擦(EDITOR_TOKEN 须真实 users 行、exit-2 无 summary 定位、8 条清单)预清——若将来 operator 仍要在真 staging 复跑,材料齐备,但非 O-1 pass 的前置。

## 4. destructive-tier FE 闭合判定

裁定:**闭合**,残差如下。依据链:

- #3749 已将三破坏性 tier(uncreate / undelete / revert-permission)的 preview 接入 Config History modal,含 typed confirm + execute confirm 转发。
- R5 吸收审计(#3749,APPROVE 0P1/0P2)证明这些 FE 门是**服务端权威**(400 CONFIRM_REQUIRED + execute 事务内 re-check LIVE grant),非 theater。
- R5b/R5c 已把该面全部字符串收编 typed label 模块(strict-zero 穷尽,全线 8 组件零残余散串)。
- O-1(§3)证明三 tier 的后端契约端到端可用。

**已知残差(记录,不阻塞闭合):** ResetConfirmDialog 及其 spec 不在 `multitable-web-guard.yml` path-filter 触发列表(既有 CI 工作流缺口,属 CI 裁量,非本线功能缺口)。

## 5. R6 实施排布(sequenced,非并行)

因 4c-1 真值路径 wire 进 4c-2 捕获 seam(捕获点 3),且两者均触 `univer-meta.ts`,采**依赖顺序**而非并行:

```
4c-2 impl(基座:tombstone 表 + 捕获 + 补水 + retention,flag 默认 off)
   └─→ 4c-1 impl(full-read gate + loss-oracle + HMAC token 绑定 + 写对称 cap
                 + pre-image 捕获接入 4c-2 seam,flag 默认 off)
          └─→ 4c-3(record undelete 2b:硬删入边重建,依赖 4c-2 捕获物)
```

模型分派:Sonnet 实现车道(隔离 worktree)+ Opus 主会话对抗审(mutation 证据必交)+ auto-merge/Monitor 落地 + 每 wave 设计+验证 MD。**flag 全程默认 off**——production 启用是独立的 O-2 operator 阶梯(破坏性从低到高:PERMISSION_REVERT → CONFIG_UNDELETE → SHEET_CONFIG_REVERT/FIELD_RETYPE_REVERT → CONFIG_UNCREATE;PIT_UNDELETE 先、PIT_RESET 后含 STOP-SHIP),**本轮不启用任何 flag**。

## 6. 轮后剩余 owner/operator 项(缩减后)

- 🧭 O-2 flag 阶梯启用(operator;每步按 runbook 采证)——含新增的 `MULTITABLE_TOMBSTONE_CAPTURE_ENABLED` / 4c-1 lossy flag,均默认 off 待 operator。
- 🔒 4c-3 record-undelete 2b:4c-2 impl 落地后解锁(owner 单项签核)。
- destructive-tier FE 的 web-guard path-filter 补入(CI 裁量,可选)。
