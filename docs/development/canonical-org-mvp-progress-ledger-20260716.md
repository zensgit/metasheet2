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

## 2. 遗留限制（诚实清单，按归属批次）

### pre-B4 hardening 小批次（不阻塞 B4 启动，**阻塞 Canonical Org MVP DONE**）
- 非 UUID `membershipId` 进 `::uuid` cast → 500（应 400/404；B2/B3 同形）。
- archive 不冻结后续写入（向已归档部门加成员、归档账号切 primary 均 200）。
- 间接部门环可达（A→B→A；实测递归 CTE 无害终止，仍应规范化）。
- B1 停用后同名重建撞 `UNIQUE(org_id, provider, name)`（B1 不宣称停用后自动重建）。
- primary-switch 存在性检查移入事务并合成单 UPDATE（owner 判 P3 加固，非阻塞）。

### routing 加固批（B5/B6 期间处理）
- resolver **读侧**不过滤 integration `status`：active 期间设置的 `is_manager` 在 integration
  停用后仍参与解析（写侧门已在 B3 关闭；读侧为既有设计属性，B3 未宣称覆盖）。
- 主管**链**（chain hop）与**部门负责人**（dept head）仍走 legacy 源（B3 只泛化 direct-manager 步）。

## 3. 未开发（顺序 owner 已裁：串行）

- **B4** department binding 表（双侧 composite FK、provider-role 约束）→ **B5** 显式 `(org, purpose)`
  routing policy + 只读切换预览 → **B6** local/DingTalk 审批路由真库等价证明（首个真实消费者）→
  **B7** 外部部门 suggest-only 对账（消失只标 `stale`，不得停用本地部门）。B5/B6 同碰 routing core，
  **不并行**。
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
