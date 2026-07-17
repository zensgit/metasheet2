# Canonical Org MVP · 实施进度台账（2026-07-16）

> Owner 指令产物：修正实施计划（`canonical-org-provider-transfer-v1-mvp-implementation-plan-20260713.md`）
> 的状态失真——该计划原写 "Not started"，而 B1/B2/B3 已真实落地。本台账记录**真实 PR、merge SHA、
> 遗留限制**；后续每落一步就地更新本文件，计划文件本身不再承载滚动状态。

## 1. 已落地（真实 merge SHA）

| 步 | PR | Merge SHA | 内容 | Owner 复审轮数 |
|---|---|---|---|---|
| **B1** | #4304 | `849f1d53d` | local provider bootstrap：get-or-create（普通 INSERT + 捕 23505 `isUniqueViolation` + re-select winner）；`one_active_local_integration_per_org` partial unique index；`local_integration_corp_id_shape` CHECK；创建审计 | 2（并发唯一性构造证明；CHECK 语义精确措辞）|
| **B2** | #4317 | `bf52b9513` | 部门/账号/成员关系 CRUD + 8 条 admin 路由（`/api/admin/directory/local`）；fail-closed 字段白名单 + 严格类型校验（int4 有界；错误类型→400 且原值不变）；archive-not-delete；显式 primary 切换 | 2（类型强校验轮）|
| **B3** | #4318 | `65dec7b36` | `is_manager` 一等主管关系（迁移 `zzzz20260715100000`）；双源 resolver precedence（`a.integration_id`+`d.integration_id` 双侧、DingTalk legacy 路径逐字不变）；membership PATCH 单请求单操作（isPrimary XOR isManager）+ `directory.local_membership.set_manager` 审计；writer 11 谓词守卫（org/integration 双侧/provider 三处/status='active'/account/department）| 3（可达性；双侧边界；三谓词轮）|
| **PB4-1** | #4366 | `9a0f23037` | membership 输入 + 主切换原子性：非 UUID `membershipId`→**400**（路由 UUID 形状校验）；`switchLocalPrimaryDepartment` 单事务锁账号 + 全 membership 部门（`ORDER BY id FOR UPDATE`）、目标缺失不清旧主、UPDATE 只作用已核验集合 | 4（四锁点：before-any-DB-call 精确校验、gate-head 非 patch-identical 等）|
| **PB4-2** | #4392 | `a993e8b84` | archive → 全只读，**write-point 强制**（每写函数同事务 `SELECT…FOR UPDATE`→分类→写）；主切换全只读 + 跨作用域越界整体 409 / 目标越界 404；manager writer 账号先于部门锁；404-vs-409 纪律；覆盖 route/service/B3 writer | ~5（TOCTOU→write-point 重写；P1b 越界 demotion；404-vs-409；provider-target route 测；gate 记录措辞）|
| **PB4-3** | #4397 | `80f4aceae` | 部门环检测：事务内递归祖先 walk（child 命中新父祖先链→409、`path[]` 终止守卫）+ 每-integration `pg_advisory_xact_lock` 串行 reparent（防 disjoint cross-mount 4-环）+ 钉 READ COMMITTED | opus gate APPROVE（P3 = RC 钉线机制证已补）+ owner 审后落地 |
| **PB4-4** | #4401 | `987bdc5e0` | 本地 integration 重激活：`getOrCreateLocalIntegration` 条件 UPDATE 就地复活同一稳定锚（`name=$2 AND status<>'active'` 竞态安全闩 → 同 id、子表存活、单 `directory.local_integration.reactivate` 审计）| 1（**owner 抓 P2**：并发 mutation 假绿 → 改 `pg_blocking_pids()` 确定性 barrier，删 latch 稳定多审计）|
| **B4** | #4419 | `b94dcd644` | `directory_department_bindings` buildable FK chain：单 `org_id` 列 + 双 integration `(id, org_id)` 复合 FK → **跨 org binding FK-impossible**；全 FK 列 NOT NULL（封 MATCH SIMPLE NULL 绕过）；provider-role 冗余 FK+CHECK 无 trigger；**部门 FK 三列 `(dept_id, integration_id, provider)`**（owner P2：钉住部门行自身 provider，拒 provider-mislabeled 部门占位）；`status active\|stale` 供 B7；迁移 replay 幂等 + down/up 往返 | 1（**owner 抓 P2**：dept FK 无 provider leg，两种 mislabeled binding 可插入 → 三列 FK + I/J 测试 + 双腿 mutation）|

## 2. 遗留限制（诚实清单，按归属批次）

### pre-B4 hardening 小批次 — ✅ 全部闭合（PB4-1..4 已落地，2026-07-17）
- ✅ 非 UUID `membershipId`→500 → **400**（PB4-1 `9a0f23037`：路由 UUID 形状校验）。
- ✅ archive 不冻结后续写入 → **write-point FOR UPDATE 全只读**（PB4-2 `a993e8b84`：route/service/B3 writer 全覆盖）。
- ✅ 间接部门环可达（A→B→A） → **事务内递归祖先 walk + 每-integration 串行 reparent**（PB4-3 `80f4aceae`）。
- ✅ B1 停用后同名重建撞 `UNIQUE(org_id, provider, name)` → **getOrCreate 就地重激活同一稳定锚**（PB4-4 `987bdc5e0`）。
- ✅ primary-switch 存在性检查移入事务并合成单 UPDATE（PB4-1/PB4-2 已含）。

### routing 加固批（B5/B6 期间处理）
- resolver **读侧**不过滤 integration `status`：active 期间设置的 `is_manager` 在 integration
  停用后仍参与解析（写侧门已在 B3 关闭；读侧为既有设计属性，B3 未宣称覆盖）。
- 主管**链**（chain hop）与**部门负责人**（dept head）仍走 legacy 源（B3 只泛化 direct-manager 步）。

## 3. 未开发（顺序 owner 已裁：串行）

> **B5/B6 门控（owner 2026-07-17，B4 落地时重申）**：B4 已落地（§1 `b94dcd644`）。B5/B6 为
> routing-core，**先审定 design lock 再开发**——草案见
> `canonical-org-b5-b6-routing-core-design-lock-20260717.md`（待 owner 审定）。

- **B5** 显式 `(org, purpose)` routing policy + 只读切换预览 → **B6** local/DingTalk 审批路由真库
  等价证明（首个真实消费者）→ **B7** 外部部门 suggest-only 对账（消失只标 `stale`，不得停用本地
  部门）。B5/B6 同碰 routing core，**不并行**。
- Canonical Org **单独收官门**：真库 done-gate、迁移 replay、mutation 表、真实 merge SHA 全入库后，
  才解锁 Transfer。
- **Transfer**：T1 → T2 → T2-Gate → **条件式 T2.5** → T3 → T4 → T5。**T2.5 为显式决策分支**（owner
  裁定）：两 corp 实证若确认 `(provider, external_key)` 冲突，必须先落 tenant-scoped key migration
  （`(provider, tenant_key, external_key)`），**不得直接进入 T3**。
- 排除项（本轮不做）：Feishu/WeCom driver、全消费者迁移、per-org quiet-hours、共享限流。

## 4. 并行的 owner/ops 线（生产发布前必须闭合，与 B4-B7 并行）

- DingTalk Hardening v1 运行态：OAuth live monitor 已闭环（连续三次 scheduled success），但
  **真实 UAT evidence pack 仍为空模板、开关台账负责人仍全 `_TBD_`**——模拟验收不能替代
  U1–U13 与真实 callback corp-anchor。
