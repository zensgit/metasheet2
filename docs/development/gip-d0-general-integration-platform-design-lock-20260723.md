# GIP-D0 — 通用集成平台分层设计锁（Scenario / CertifiedSourceProfile / Binding / Run）

**日期**：2026-07-23　**状态**：**PROPOSED（未 ratify）**——owner 对平台化探讨裁 APPROVE-WITH-HARDENING（1 P1 + 4 P2 + 表述修正），本稿全量吸收。
**定位**：企业系统数据协同平台的分层合同。备料只是第一个场景 preset；模型不限定"配置 PLM 和 ERP"。
**边界**：本锁不解锁 D2/runtime，不改变 #4437 当前验收路线（#4437 走 `stock_preparation.v1 × bridge.bounded_read.v1` 基础模式）；ratify 前零实现。

---

## 0. 抽取锚点（平台化 = 从已 ratify 先例抽取，非发明）

| 平台层 | 已 ratify / 已建先例 |
|---|---|
| 场景角色绑定 | MR charter §2.3（`scenarioInstance` active 指针 + 语义角色 → approvedConfigVersionId + pinned systemContentKey） |
| 绑定生命周期与重验 | MR charter §4.5（四层重验；`active` = 指针派生谓词非存储状态） |
| 内容键与血缘指纹 | MR charter §4.6（`systemContentKey`（认证主体引用，非凭据）/ `bindingFingerprint` / 双指纹） |
| 一致性证明闭集 | MR charter rev-4 三机制（源侧快照事务 / 不可变快照 token / 单调无 ABA 版本 pin）——与 scale-kernel D0 `consistencyProof` 枚举**一一对应** |
| capability 认证 schema | scale-kernel D0 五维矩阵 + §8 承重电池（本锁将其**降为认证 schema**，见 §3） |
| 规范对象种子 | stock-prep intake contract（bom/material 已冻结消费字段） |

---

## 1. 四层模型

```
Scenario Definition        业务场景定义（备料、物料对账、供应商同步…）：一方发布、版本化
CertifiedSourceProfile     受认证连接器能力包：一方认证、版本化
Customer Binding           客户配置：谁家系统担任哪个角色、映射、范围、策略：闭合 schema 内客户自助
Run                        固定上述版本后执行，保存完整血缘与证据
```

**Run 血缘五元组 pin**（每次 run 固定，审计血缘不可改写）：
`scenarioVersion + certifiedSourceProfileVersion + bindingVersion + approvedConfigVersion + systemContentKey`。
evidence 全程 values-free，且**必须**携带 per-role 快照身份（token/version/读窗口）。

---

## 2. 系统实例与类别

客户可登记 PLM、ERP、CRM、SRM、MES、WMS 或自定义系统。**系统类别只用于展示，不作为安全判断依据**——判定语句永远是："该角色的 binding 经其 profile + 映射能否产出所需规范对象、并满足该角色声明的能力谓词"，语句中不出现系统类别。

---

## 3. CertifiedSourceProfile（连接器能力包）

**命名**：仓内 `profile` 已过载（attendance `mappingProfiles`、connector 模板、P5 图号 profile 等）——新类型定名 **CertifiedSourceProfile**，避免歧义。

**认证书 schema** = scale-kernel D0 五维坐标（acquisition/consistency/continuation/completeness/apply）+ 完整合同（一致性证明方式、完整性证明方式、恢复许可、最大规模、唯一排序键要求、manifest/token/cursor 形状、失败词表）+ **合规测试电池**（D0 §8 电池按 profile 实例化，CI 常驻）。**矩阵自此降为认证分类学；运行时只可选 profile，不可自由组合维度**（杜绝非法组合空间）。

**v1 profile 清单**（首批实现，架构按通用建）：

```
bridge.bounded_read.v1        （撑 #4437 当前验收）
bridge.sealed_snapshot.v1     （大规模客户；先过 feasibility spike）
sql.snapshot_keyset.v1        （第二类通用连接器）
sql.change_tracking.v1        （有真实需求后）
file.signed_manifest.v1
```

**冻结**：**v1 全部 profile 为 READ-ONLY**。外部写回（write-back）是独立 capability class、独立认证/审批/审计轨——任何 profile 不得夹带写能力过认证。

---

## 4. 标准数据契约（规范对象）

系统数据统一映射到规范对象（BOM、物料、客户、供应商、需求、库存、生产计划…）；**场景只依赖规范对象，不依赖厂商字段**。

**最小冻结纪律（反万能本体）**：规范对象只冻结**已落地场景实际消费的字段**（intake contract 是 bom/material 的种子）；加宽只许 additive；版本化（run 经 scenarioVersion 连带 pin canonicalObjectVersions）；语义变更 = 新版本。

**逐字段要求类（P2 修正吸收）**——现有 `assertEveryConfiguredFieldResolved` 只保证配置字段**在 ≥1 行出现过**（已核验：`resolvedRows >= 1` 语义），**不可直接泛化**为规范对象校验。规范对象每字段必须冻结：

```
requirement:  ALL_ROWS_REQUIRED | NON_EMPTY_WHEN_PRESENT | OPTIONAL
+ 标准化规则、类型、闭词表映射、身份键唯一性
```

**Preflight 只能提前发现问题；运行时仍须对完整快照重新验证**（preflight 早发现 ≠ 运行时可信）。

---

## 5. 场景角色

**角色显式带类型（P2 修正吸收）**：

```
EXTERNAL_READ_SOURCE      外部只读来源（由 CertifiedSourceProfile 描述）
INTERNAL_APPLY_TARGET     内部多维表写入目标（如 preparation_target——不由外部 connector profile 描述）
EXTERNAL_WRITE_TARGET     外部写回目标（v1 禁用；独立认证/审批/审计轨）
```

**角色声明** = `{ roleType, canonicalObject, 各模式的 requirement predicate, 可选角色的缺席/降级规则 }`。示例：基础备料 = bom_source + material_source + preparation_target；需求感知备料 += demand_source（可绑 CRM/ERP）；供应感知 += supplier_source（SRM）；执行感知 += inventory_source / production_plan_source（WMS/MES）。

**模式可用性（P2 修正吸收——能力非线性等级，禁止 min() 归约）**：

```
modeAvailable(mode) =
  每个必选角色的 profile 满足该 mode 的 requirement predicate
  且所有可选角色符合场景规定的缺席/降级规则
```

UI 展示**逐角色缺口**（"demand_source 的连接器无法证明完整性 → 出口：换 profile / 收窄范围"——#4437 三叉决策树的产品化），**不得**计算抽象 min(profileMode)。**双向不静默**（不降级不升级），判定入 run evidence。

**跨角色时序（P1 修正吸收——不得称"一致性"）**：MR charter §2.2 已 ratify："两侧各自时点一致后，**跨侧时间偏移是产品语义而非缺陷**……不假装存在跨系统全局事务"。冻结词表：

```
crossRoleTemporalPolicy:
  DISCLOSE_ONLY          各自一致，披露采集窗口（MR charter 现行语义）
  MAX_CAPTURE_GAP        freshness SLO——只约束采集时间接近，不是一致性证明，
                         不消除"更新恰发生在两次读之间"的伪差异
  COMMON_EFFECTIVE_CUT   两侧各自证明受同一业务截止点约束
  COORDINATED_SNAPSHOT   保留未来能力（v1 不设）
```

`material_reconciliation.v1` 维持已 ratify 的 `DISCLOSE_ONLY`；是否升级 `COMMON_EFFECTIVE_CUT` 由 **MR-D0-A1** 单独裁决——本锁不改动已 ratify 语义。

---

## 6. 客户绑定（Customer Binding）

**客户可配置**（闭合 schema 内自助）：scenarioId、各角色 systemId、certifiedSourceProfileId、approved object/view/reference、身份键与复合排序键、字段映射、单位/状态闭词表映射、同步范围 preset、调度/预算/留存、基础/全量/增量模式。

**禁止配置**：任意 SQL、任意 URL、任意脚本、任意写操作、未注册 filter 表达式、绕过完整性/一致性证明。特殊查询 → connector owner 注册**具名、受测的 queryPreset 或只读 view**，Binding 引用之。

**生命周期（表述修正吸收——两种对象、两套已定语义，不发明第三套）**：
- **config version**（现存实现，`read-source-config-store.cjs` :23-27）：持久状态 `draft → approved → retired`；**preflight 是操作步骤，不是状态迁移**；运行读取面 approved-only fail-closed（`getForRuntime` 先例）。
- **binding version**（MR charter §4.5 已锁）：`draft_candidate → preflight_passed → approved → superseded / revoked`；**`active` 不是存储状态**——是"被场景 `active_binding_version_id` 指针指向"的派生谓词；指针切换 = 原子激活事务，revoke 同事务清指针；不原地修改 active binding。

**systemContentKey（P2 修正吸收，对齐 charter §4.6"认证主体引用"）**：

```
systemContentKey = hash(profile/version + endpoint identity + data scope + stable authPrincipalKey)
secretVersionId  = 仅进安全证据与运行时重验；永不进入业务 baseline lineage
```

同一主体换密钥 ⇒ **不**重建业务基线；主体或数据权限范围变化 ⇒ 必须重验并产生新血缘。

**预算合法域**：binding 预算 ≤ min(profile 认证上限, 租户配额)，preflight 校验。

---

## 7. first-party 界限（表述修正吸收）

**一方专属**：场景定义、执行策略、profile 认证代码（它们就是代码，携带 diff/apply 语义与审批流）。
**客户自助**：在闭合 schema 内创建系统实例、binding、映射——CRM/SRM 自助配置目标不受伤。
第三方作者生态（伙伴写场景）= v2 独立设计门（自带沙箱与审查链），v1 不开。

---

## 8. UI 渐进披露

- **基础模式**：安装场景 → 选系统 → 确认必要映射 → 预检 → 启用。
- **高级配置**（顾问/集成管理员）：CertifiedSourceProfile、object/view、身份键、snapshot/manifest 能力、budgets、retention、schedule。
- preflight 自动显示：基础同步可用 / 全量可用 / 增量可用 / 当前连接器无法证明完整性（逐角色）。
- **不要把 CRM、SRM 塞进基础备料页面**——作为可安装的增强能力逐步出现。

---

## 9. 实施序

1. `stock_preparation.v1` scenario preset #1 + `bridge.bounded_read.v1`（撑 #4437，**不等本锁**）；
2. 本 GIP-D0 冻结 + **MR-D0-A1 时序语义裁决** → ratify 门；
3. `bridge.sealed_snapshot.v1`（先 feasibility spike，对比交互分页真实改动面，不预断）；
4. `sql.snapshot_keyset.v1`；
5. 客户 Binding + 版本化审批（charter §4.5 语义平台化）；
6. **第二个真实新场景 = SRM 供应商/供货能力对账**（`material_reconciliation.v1` 的 charter+D1 已在飞，是首个"第二消费者"锚点；SRM 场景验证内核**没有偷偷依赖备料**）；第三场景 = CRM 需求驱动备料；
7. 有真实需求后再增 `sql.change_tracking.v1`（企业模式）。

**原则**：架构通用、能力按 profile 渐进实现、客户差异配置化、特殊协议插件化、业务安全规则不可配置化——不为每个客户维护代码分支，也不让通用化演变成任意脚本平台。

---

## 10. 边界

- 本锁 PROPOSED；ratify 前零实现（仅只读 spike）；
- 不解锁 D2/runtime；不改 #4437 验收路线；
- 与 scale-kernel D0（内核机制）、W3/G1 设计锁并行独立；scale-D0 §2 矩阵经本锁降为认证 schema（已在该文标注 A1 修订）。
