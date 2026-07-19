# 钉钉线 goal 轮 — as-landed 收账与验证记录（2026-07-17 设计 / 2026-07-19 落地）

> **Status: development-side CLOSED for Track A (B5a–B7 + design lock) and Transfer T1/T2/T2-Gate code.**
> 本文是 **as-landed closeout**，不是 open-stack / unarmed PR 台账。
> 真实两 corp 钉钉 staging 实证仍为 **owner/ops `_TBD_`**；不得把 CI 碰撞机制证明写成 collision CONFIRMED/DISPROVED。
> **T2.5 仍为条件分支**。T3 解锁纪律：owner 接受的 **DISPROVED** 可跳过 T2.5 并解锁 T3；**CONFIRMED** 必须先 **实现并落地 T2.5** 后才能进 T3（仅有裁决不够）；**INCONCLUSIVE** 继续冻结 T3/T4/T5。

**本文件来源说明**：原 untracked 稿是 stale PR #4466 的移植，仍写「栈/T1/T2/T2-Gate unmerged、unarmed、held」。
本版按 **main 真实 merge SHA** 重写为诚实收账；保留有用的设计与 mutation 证据，删除 head/open/unarmed/held 语言、`/tmp` gate-report 依赖与 Claude 生成页脚。

**角色（2026-07-19 纠正 / closeout）**：

| 角色 | 承担 |
|---|---|
| **Grok Build** | 纠正实现 + 本 closeout 文档落地 |
| **Codex** | 独立复审 + 真库 / 接线 / typecheck / 证据核对 |

---

## 0. 执行摘要

| 轨 | 内容 | as-landed 状态 |
|---|---|---|
| A | B5a–B7 routing-core + design lock #4425 | ✅ **已合并 main**（Track A 共六张 PR：1 张 design-lock + 5 张 B5a–B7 实现；真实 merge SHA 见 §1） |
| B | Transfer MVP 代码侧：T1 + T2 + T2-Gate | ✅ **已合并 main**（#4458 / #4464 / #4465；真实 merge SHA 见 §2） |
| C | 本 MD（as-landed 纠正） | ✅ 本文件 |
| Side | #4337 durable-delivery S5 返工 | ✅ **已合并** `dfc9318fc…`（另线，见 §5） |

**开发侧可自动化收口**（本轮已完成）：restack/rebase、mutation 承重、真库套件、no-DB wiring/values-free 合同、typecheck、migration replay、exact-head GitHub checks。

**owner/ops 运行态证明**（本轮 **未** 完成，且不可由开发环境替代）：

- 真实两 DingTalk corp staging 碰撞裁决（runbook §4 仍 `_TBD_`）
- T2.5 go/no-go：仅 collision **CONFIRMED** 时强制实现并落地 T2.5；**DISPROVED** 可跳过 T2.5
- T3 解锁（CONFIRMED 路径上仅有裁决不够）：
  - owner 接受的 **DISPROVED** → 跳过 T2.5，解锁 T3（其后 T4/T5 仍按 owner 串行）
  - **CONFIRMED** → 必须 **实现并合并落地 T2.5** 之后才解锁 T3（仅有裁决不解锁）
  - **INCONCLUSIVE** → T3/T4/T5 继续冻结

---

## 1. Track A — B5a–B7 + design lock（Canonical Org routing-core）

### 1.1 真实 merge 账本

| 步 | PR | Merge SHA（full） | 内容（as-built 摘要） |
|---|---|---|---|
| Design lock | #4425 | `d9f56a8c244eba64699479ef4a2732ddb426c185` | B5/B6 routing-core 决策锁 + 落地台账 |
| B5-a | #4429 | `81aff820315cc1102f5b7ff95cea93e5dc310bbb` | `(org_id, purpose)` routing policy schema；同 org canonical FK；fallback `ON DELETE RESTRICT` |
| B5-b | #4430 | `05dcd52826eac71e73da2a717c17d3d849cc94f4` | policy-authoritative resolver；未配置/坏配置 fail-close；legacy 无策略 SQL 保持；create/preview 区分持久配置错误与暂时读取失败 |
| B5-c | #4431 | `5e55b549d6d5c79237f52a0f088e49ff95e1e1d0` | platform-admin list/set/clear/read-only preview；canonical 同 org 且 active；写点 `FOR SHARE`；values-free audit |
| B6 | #4434 | `50cbfcfeaa7e866ddbe35853cfc3f99add00c01e` | local/DingTalk 审批路由真库等价 + in-flight 不变；`deptHead` provider-specific 非等价被显式钉住 |
| B7 | #4436 | `b004c57978c9dbfe8ad3795dc4bad239f0cf8691` | 外部部门 suggest-only 对账；active/stale 只改 binding；本地部门零写；歧义不自动匹配；Q6 sync hook 失败隔离且日志 values-free |

Canonical Org **开发侧 DONE-gate** 另见 `canonical-org-mvp-done-gate-20260719.md`（以 B7 merge 为基线的组合验证）。
生产发布仍由 Hardening v1 的 owner/ops 门控制，不在本 MD 范围。

### 1.2 开发期 restack / exact-head gate 史（保留证据，状态已过时）

原 goal 轮在 **合并前** 做过：

- 返工波推完但栈未重排 → 逐环 rebase（CI 接线文件 UNION 保留全部条目），range-diff 证明实质 patch 字节级不变。
- Fresh exact-head 对抗 gate（Fable）+ P2/P3 修复轮。

| PR | 合并前 gate 关键发现 → 处置（历史） | 说明 |
|---|---|---|
| #4430 B5-b | 4 mutation 全红（含 create-guard 删除精确复现 fail-open）；preview-leg pin + rename-free 注入 → **defer 落地窗** | 已并入 main；deferred P3 不阻塞 merge |
| #4431 B5-c | **P2** env gate 严格解析无测试 → 补 falsy 腿（`'false'`/`'0'`→409），突变现红 | 已并入 main |
| #4434 B6 | 非空虚性亲验；sentinel UPDATE 按 integration 限域；shared-default inflight dept 入 afterAll | 已并入 main |
| #4436 B7 | **P2** heal 方向 `ri.status='active'` 守卫无测试 → 补 heal 冻结腿，突变现红；doctrine/CI 标签/审计 values-free 负断言 | 已并入 main |
| #4425 lock | Lock schema 残留 `mode` 列；台账仍写 B5–B7「未开发」等 → 全修 | 已并入 main |

**勿再使用** 合并前中间 head（如 `3312cf6d1` / `56e0b03ad` 等）作为当前验收基线；权威是 §1.1 的 **merge SHA**。

### 1.3 Track A 之后剩余（owner / 非本轮代码）

- Canonical Org **生产发布**：Hardening v1 U1–U13 / 开关台账负责人 / 真实 callback corp-anchor（见 hardening runtime closeout；**非**本 goal 轮 Transfer 代码缺口）。
- deferred P3（非阻塞）：B5-b preview-leg pin、rename-free 注入（若仍需要，另开小 PR）。

---

## 2. Track B — Transfer MVP 代码侧（T1 / T2 / T2-Gate）

### 2.1 T1 = PR #4458 — **MERGED** `b9b354a38ddc34845fbbf71e87863fbe191eee16`

**Schema / API（as-built）**：

- `provider_org_transfers` + `provider_org_transfer_decisions`（§7.1/§7.2）
- admin API（§6.3 减 decisions PATCH——defer 到 T3/T4 与真实 decision 面同落）
- **B4 doctrine 加固**：跨 org 转移 FK-impossible（单 `org_id` + 双复合 FK）；provider 不匹配 FK-impossible + `CHECK provider<>'local'`；active-per-source partial unique
- 状态机无吸收非终态（failed→scan 回收边）；每转移一事务 `FOR UPDATE` 写点强制（PB4-2 doctrine）
- §12.3 dry-run-required 且 scan-relative；undecided decisions 挡 apply
- **directory 表指纹证零写**

**生产 adapter 路径（2026-07-19 纠正，已随 merge 落地）**：

- 生产路径 **不再** 静默回落到 noop
- `adapterFor` 在未注册 provider adapter 时抛 typed **409 `ORG_TRANSFER_ADAPTER_UNAVAILABLE`**
- 状态机 / decisions / success-audit 路径保持不变
- `noopOrgTransferAdapter` **仅** 保留给显式 test registration，不作为生产 fallback

**偏差（已记 PR，仍有效）**：`created_by` / `decided_by` = text（本仓 `users.id` 是 text）；加列 `dry_run_at`。

> 旧中间 head（如 `5800e5d82…` / `6c13361cdd…`）与「生产 no-op 静默 fallback」表述均 **superseded** by merge SHA above。

### 2.2 T2 = PR #4464 — **MERGED** `85ef8b7ab84f6546c4d01bf3068dbd7960709bd7`

**§12.2 source freeze（as-built）**：

- 活跃转移冻结 source integration 的 sync——**lease claim 之前** typed 409（`DIRECTORY_SYNC_FROZEN_BY_TRANSFER` 携 `transferId`）
- 零 run 行、零配额消耗；scheduler 静默跳（镜像 lease-skip 先例）
- preview 刻意保持可用（转移期间的只读证据工具）
- 缺表 `to_regclass` 探针 fail-proceed 并打出 warn 日志（无表 = 无转移）

**freeze override 面（2026-07-19 纠正，已随 merge 落地）**：

- 废弃旧 **raw-SQL / DB-only** `freeze_source_sync` override
- 现为 **`PATCH /api/admin/directory/org-transfers/:id/source-sync-freeze`**
  - 共享 `ensurePlatformAdmin`
  - 严格 body `{ freezeSourceSync: boolean }`
  - server-derived resource/org
  - 行锁（row lock）
  - **非终态 only**（terminal 拒绝）
  - values-free postcommit audit
  - 支持 unfreeze / refreeze

> 旧中间 head（如 `a83fb577f…` / `eadb5d8da6…`）与「DB-level / API-deferred override」表述均 **superseded** by merge SHA above。

### 2.3 T2-Gate 证据工具 = PR #4465 — **MERGED** `2b43246508ccbf9e65752c1e1c0f209d1ab1fe67`

**CI 可证一半（机制，非真实 corp 行为）**：

1. `(provider, external_key)` 唯一索引按名钉死
2. 同步派生 = 裸 `unionId`（无 corp 前缀）
3. **端到端碰撞签名**（沙箱构造）：同 `unionId` 双 corp ⇒ 第二 corp sync **整单失败**（upsert 环无 per-account savepoint；**碰撞 apply 事务回滚后 corp B 的 `directory_accounts` / `directory_departments` 为零行**；integration 行与 `directory_sync_runs` 的 `status='failed'` 行**仍在**，作为失败证据，并携 duplicate key + 索引名分类）
4. 对照腿：不同 `unionId` 共存

**Runbook**（values-free 证据协议 + owner T2.5 决策矩阵）：
`docs/development/canonical-org-t2-gate-two-corp-staging-runbook-20260717.md`

**硬边界（不得夸大）**：

| 已证明（开发 / CI） | 未证明（owner/ops only） |
|---|---|
| 唯一索引 + 裸 key 派生 + 无 savepoint ⇒ 碰撞时 apply 整单失败的**机制**（corp B 目录账户/部门表零行；failed run 行保留） | 真实钉钉是否在两 corp 下对同一人发**相同** `unionId` |
| values-free runbook SQL 与决策矩阵已入库 | runbook §4 证据块：仍为 **`_TBD_`** |
| | **不得**声称 collision CONFIRMED 或 DISPROVED |

---

## 3. 明确不做 / 仍 gated（诚实清单）

| 项 | 归属 | 状态 |
|---|---|---|
| Track A + T1/T2/T2-Gate **代码合并** | 开发 | ✅ **已完成**（§1 / §2） |
| **T2-Gate staging 双 corp 实证** | owner/ops | ⏳ runbook §4 `_TBD_`；不可模拟 |
| **T2.5** tenant-scoped key migration | 条件工程 | **CONFIRMED** → 必须实现并落地后才能进 T3；**DISPROVED** → 跳过 T2.5 |
| **T3 → T4 → T5** | 冻结 | **DISPROVED**（owner 接受）可跳过 T2.5 解锁 T3；**CONFIRMED** 仅有裁决不够，须 T2.5 落地后才解锁 T3；**INCONCLUSIVE** 继续冻 |
| T2 在途窗口（sync 已在跑时创建转移不打断该次 sync） | 设计有界暴露 | gate 评估见 §4；如需关窗属 T3 前置 |
| Hardening v1 owner/ops 收官（U1–U13 / 负责人 / 开关台账） | 并行另一线 | 本轮未动 |
| Feishu/WeCom driver、全消费者迁移 | 计划排除 | 不做 |

---

## 4. 对抗 gate / mutation 证据（历史 + 纠正）

> **读者注意**：下表 T1/T2 的 **pre-closeout** 对抗 gate 行是 2026-07-17 史，**不是** 最终 as-built 验收。
> 最终 as-built 以 §2.1 / §2.2 merge SHA 与 §4.1 纠正为准。
> **不依赖** `/tmp/pr*-*-gate-*.md`（易失、不可复现）；证据以 PR 讨论、本 MD、runbook 与 main 上的测试为准。

| PR | 历史 gate | 关键发现 → 处置 | 最终权威 |
|---|---|---|---|
| #4458 T1 | pre-closeout APPROVE（**superseded by §4.1 纠正**） | 4 mutation 全红（含活库索引置换）；apply-vs-cancel 竞态 + UPDATE 旁路 FK 探针；恢复边（failed→scan / applying→cancel）直接种入并测 | **merge** `b9b354a38…` |
| #4464 T2 | pre-closeout hold→闭（**superseded by §4.1 纠正**） | **P2** scheduler frozen-skip 分支无测试 → 补单元腿，突变现红；在途窗口写入错误类 docblock；async 409 腿补 `transferId` | **merge** `85ef8b7ab…` |
| #4465 T2-Gate | APPROVE 0 P1/P2 | 承重双向证明：corp B unionId 改异 → 碰撞腿红；给真实派生加 corp 前缀 → 3 腿红（套件驱动生产派生）；runbook SQL 对真 schema 执行 | **merge** `2b4324650…` |

T3+ 前瞻（gate 输出，**非本轮 scope**）：decisions PATCH 须取转移行锁并考虑清 `dry_run_at`；cancel-from-applying 仅在 apply 单事务时安全——T3 多事务 apply 须重审。

### 4.1 Owner-closeout 纠正（2026-07-19）— T1/T2 行为（已随 merge 落地）

**诚实声明**：§4 表中 T1/T2 的 prior adversarial gate 漏掉了最终纠正前的两处 as-built 问题；不得把 pre-closeout 行当作当前 acceptance。

| 发现 | 修复（as-built on main） | 独立承重突变证据 |
|---|---|---|
| T1：生产 `registry.get(provider) ?? noopOrgTransferAdapter` 静默 fallback | `adapterFor` 无注册 adapter → typed **409 `ORG_TRANSFER_ADAPTER_UNAVAILABLE`**；noop **仅**显式 test registration | 恢复 `?? noop…` → T1 no-adapter 两测变红，且组合 T1+T2 no-run/no-sweep 测变红 |
| T2：raw-SQL / DB-only override，API-deferred | `PATCH .../source-sync-freeze`：shared platform-admin、strict body、server-derived resource/org、row lock、nonterminal-only、values-free audit、unfreeze/refreeze | 去掉 freeze update 的 terminal guard → terminal API 测从期望 409 变成 200（变红） |

**独立复审（Codex）**：完整实现已独立 review；确认 shared platform-admin guard、**无**生产 adapter 注册；跑通相关套件后 **无剩余行为 P1/P2**。
**纠正实现（Grok Build）** + **复审/测试（Codex）**。

### 4.2 T2-Gate exact-head 证明（rebase 后 / 合并前终验）

在 T1/T2/T2-Gate 最终 head 上（rebase 后、merge 前）记录的组合证据：

| 门 | 结果 |
|---|---|
| 真库 T1 + T2 + T2-Gate | **22 + 16 + 5 = 43/43** |
| no-DB wiring / values-free 合同 | **22/22** |
| TypeScript | typecheck 通过 |
| Migration replay | **两遍** replay 通过 |
| GitHub checks（exact-head） | **16 success · 0 fail · 1 conditional skip** |

合并后权威 tip 即 T2-Gate merge：`2b43246508ccbf9e65752c1e1c0f209d1ab1fe67`（含 T1/T2 祖先）。

---

## 5. 另线插入事项 — #4337（已合并）

owner 对 **#4337**（P2 durable-delivery S5）CHANGES_REQUESTED 的返工已 **合并**：

- **Merge SHA**：`dfc9318fc3f216eb6039e8a9833e06551f4227ec`
- **P1**：`automationServiceReady` readiness bit，publish-last（ctor + `init()` + `loadAndRegisterAllScheduled()` 全成功才发布；catch 内 best-effort `shutdown()`；durable assert 读 bit；`stop()` 清 bit）
- **P2**：activation 重排为可回滚序列（scheduler 校验前移，loop 启动为最后可失败步；fail-closed 时停止并清空 loop 句柄 + 拆 retry scheduler）
- **注入证据类**（合并前记录）：init-fail → start() REJECT / 零新发布 / 句柄空；load-fail → REJECT + 间隔内零 dispatcher DB tick；scheduler-fail → REJECT / 句柄空 / 零 tick

#4457 等邻接声明若仍依赖旧 SHA，由 owner 另线复证；**不在本 MD 重开**。

---

## 6. 开发侧 closeout vs owner/ops 运行态（勿混为一谈）

```
                    ┌─────────────────────────────────────────┐
  本 MD 闭合 ──►    │ Development / automatable               │
                    │  · Track A: 6 PRs (1 lock + 5 impl)     │
                    │  · T1/T2/T2-Gate merged + exact-head    │
                    │  · mutation / wiring / typecheck /      │
                    │    migration replay                     │
                    └─────────────────────────────────────────┘
                                      │
                                      ▼ 仍冻结（见下）
                    ┌─────────────────────────────────────────┐
  本 MD 不闭合 ──►  │ Owner/ops runtime proof                 │
                    │  · 真实两 corp staging runbook §4       │
                    │  · verdict: CONFIRMED | DISPROVED |     │
                    │    INCONCLUSIVE                         │
                    │  · DISPROVED → skip T2.5, unlock T3     │
                    │  · CONFIRMED → land T2.5, then T3       │
                    │  · INCONCLUSIVE → T3/T4/T5 stay frozen  │
                    └─────────────────────────────────────────┘
```

**Verdict 语言纪律**：

- 开发侧可以说：**碰撞机制已证**（索引 + 裸 key + 无 savepoint → apply 整单失败；corp B 的 `directory_accounts` / `directory_departments` 为零行，failed `directory_sync_runs` 行保留为证据）。
- 开发侧 **不可以** 说：真实跨 corp `unionId` 碰撞 **已确认** 或 **已证伪**。
- T3 解锁纪律（owner/ops 填完 runbook 并接受裁决之后才适用）：
  - **DISPROVED**（owner 接受）→ 跳过 T2.5，解锁 T3
  - **CONFIRMED** → 必须 **实现并落地 T2.5** 后才解锁 T3；**仅有 CONFIRMED 裁决不够**
  - **INCONCLUSIVE** → T3/T4/T5 继续冻结
- 在裁决未接受前：**T2.5 条件保留；T3/T4/T5 冻结**。

---

## 7. 相关文件

| 文件 | 角色 |
|---|---|
| `canonical-org-mvp-done-gate-20260719.md` | Canonical Org B1–B7 开发侧 DONE-gate |
| `canonical-org-mvp-progress-ledger-20260716.md` | 真实 merge SHA 滚动台账 |
| `canonical-org-t2-gate-two-corp-staging-runbook-20260717.md` | T2-Gate 双 corp values-free 实证协议（§4 `_TBD_`） |
| `canonical-org-provider-transfer-v1-mvp-implementation-plan-20260713.md` | Transfer 序列计划 |
| `canonical-org-b5-b6-routing-core-design-lock-20260717.md` | B5/B6 设计锁正文（随 #4425 落地） |

---

## 8. 本文件变更摘要（2026-07-19）

1. 将 stale transplant（#4466 未合并叙事：unarmed / OPEN / held / 零合并）改写为 **as-landed** 真实 merge 账。
2. 记录 Track A、T1/T2/T2-Gate、#4337 的 **full merge SHA**。
3. 记录 T2-Gate exact-head 组合证明：真库 **43/43**、wiring **22/22**、typecheck、双 migration replay、GitHub **16/0/1**。
4. 保留 T1/T2 纠正 as-built 与 mutation 证据；标明 pre-closeout gate 行已 superseded。
5. 删除 `/tmp` gate-report 依赖与 Claude 生成页脚。
6. 明确：**双 corp staging = `_TBD_`**；不声称 collision CONFIRMED/DISPROVED；T3 解锁纪律 = DISPROVED 可跳过 T2.5 进 T3 / CONFIRMED 须落地 T2.5 后进 T3 / INCONCLUSIVE 冻结。
7. **Grok Build** = 纠正/closeout 实现；**Codex** = 独立复审。
