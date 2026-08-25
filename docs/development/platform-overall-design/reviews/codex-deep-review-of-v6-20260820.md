# MetaSheet 平台总体设计 v6 深度审阅意见

日期：2026-08-20  
审阅对象：《MetaSheet 业务应用平台化总体设计 v6》  
代码复核：`zensgit/metasheet2` 当前 GitHub `main` 的关键路径

## 一、总体结论

v6 已经从平台愿景稿进化为接近 design-lock 的评审输入，主要代码事实和架构方向基本收敛。它可以作为总体评审和 owner 决策材料，但还不能直接转化为开发总任务。

当前剩余问题主要不是代码事实错误，而是：

- 路线图阶段之间存在依赖冲突；
- 部分范围在不同阶段重复；
- workflow 的租户归属模型仍未设计；
- writer policy、binding-sheet 基数和同步发布模型尚未定案；
- 工程量单位和 owner 决策层级不统一。

我的状态判断是：

| 用途 | 判断 |
|---|---|
| 总体评审输入 | 可以采用 |
| owner 决策材料 | 接近可用 |
| design-lock | 尚缺依赖修订和关键模型定案 |
| 开发任务清单 | 暂不能直接执行 |
| 第一个业务应用路线 | 备料方向正确 |

## 二、v6 已经做对的部分

### 2.1 正确处理了平台与应用的先后关系

v6 的核心原则是：

> 平台能力从真实应用中抽取，不要先建设半年平台再交付第一个应用。

这是正确的。备料作为第一个业务灯塔、CRM-lite 作为蓝图一致性样板，也比原先“先做 CRM、备料后置”的顺序合理。

### 2.2 P0-B 门外与门内拆分正确

v6 已经将 P0-B 拆分为：

- 门外平台壳：manifest、导航、实例、schema-only 蓝图、合成 fixture、values-free preflight 和模拟链路；
- 门内业务激活：真实 PLM/K3 读取、业务值可见、生产主表写入、历史迁移和双轨验证。

这样可以避免把“2–4 周完成应用壳”误解为“2–4 周完成客户生产上线”。

把生产读取、值面可见、目标表写入拆成三类独立授权也非常合理；K3 外部回写继续作为更高等级的后置授权。

### 2.3 代码事实已经较好收敛

以下表述现在基本准确：

- workflow 是 list、claim、formData、complete 四处共同缺陷；
- `assertSheetScope` 属于 legacy 安全迁移，不是一行修复；
- create/update/delete 三类自动化动作都已有 revision；
- additive 字段原语 `ensureMissingObjectFields` 已存在；
- `ensureObject → ensureFields` 仍可能覆盖字段；
- manifest permissions 当前尚未真正裁剪插件运行时 API；
- `source=automation` 只能说明写入入口，不能标识具体系统主体。

重新查看当前 GitHub `main` 后，workflow、provisioning 和插件 scope 的这些关键证据仍然成立。

### 2.4 外部数据设计明显成熟

值得保留的设计包括：

- binding/version/qualification 归一化；
- certified 和 tenant self-serve 两级信任；
- 生产读取、值面可见、目标表写入三类授权；
- plan 绑定 binding content-key 和 registry 代际；
- external key registry 与 tombstone；
- 同步只产生 plan，人工确认后 apply；
- v1 不做外部回写、双向同步和复杂 link；
- `masterRef` 字段类型后置，首期使用登记表与跨 base link。

### 2.5 正确区分底层原语与完整产品能力

v6 不再笼统认为底座没有 additive upgrade，而是准确区分：

- 已有安全的字段新增原语；
- 尚无完整的三方 diff、弃用、数据迁移、租户修改保留、升级 ledger 和回滚体系。

这是更适合开发决策的表述。

## 三、路线图中的两个核心冲突

### 3.1 P0-B2 与 P1 的前后关系不清楚

P0-B2 包含：

- 真实 PLM/K3 读取；
- 业务值面开启；
- 生产主表人工确认写；
- 历史迁移和双轨对账。

但 P1 才建设：

- integration principal；
- 归一化 binding；
- writer-aware 字段策略；
- external key registry；
- 通用同步和 plan/apply。

因此必须明确 P0-B2 采用哪条路径。

#### 路径 A：复用当前备料窄链路

P0-B2 可以先于 P1，但只能使用已经冻结和授权的备料专用能力：

- 具名 PLM/K3 profile；
- 现有 approved config；
- stock-preparation planner/UoW；
- 单客户、单实例；
- 不宣称通用平台能力完成。

#### 路径 B：使用新的平台通用 binding

如果 P0-B2 使用新 binding、integration principal 和通用同步原语，则必须依赖 P1，不能排在 P1 前面。

建议正式拆分：

```text
P0-B2a：现有窄链路客户激活，可先于 P1
P0-B2b：迁移到通用 binding，依赖 P1
```

### 3.2 P0-B2 与 P2.5 范围重复

P0-B2 已包含历史迁移、双轨对账、急停和回退；P2.5 又包含配置导入、历史范围、双跑对账、切换判据和回滚预案。

建议调整为：

- P0-B2：小范围真实激活、真实只读、沙箱验证和有限生产 apply；
- P2.5：完整配置导入、历史迁移、正式双轨、切换验收和旧系统退役。

否则相同工作会被重复估算，责任归属和验收口径也会混乱。

## 四、仍需补齐的安全设计

### 4.1 Workflow 不能只增加授权函数

v6 提出统一 `authorizeTaskAction` 是正确方向，但任务自身必须能可靠关联到安全域：

```text
task
  → process instance
  → process definition / app instance
  → tenant / workspace / base
```

如果数据模型无法提供这些关联，授权函数仍无法阻止跨租户访问。

design-lock 还应明确：

- candidate group 使用实时成员还是任务创建时快照；
- 用户退出群组、离职后的任务处理；
- 委托、代理和管理员权限优先级；
- list 是否允许返回完整 variables/formData；
- complete 后外部动作的事务与 outbox 边界；
- 同一任务并发 claim/complete 的状态条件。

建议列表接口返回安全投影，不要直接 `selectAll()` 并返回完整任务变量。

### 4.2 `assertSheetScope` 过渡期不能只告警

legacy 路径不能一次性全部 fail-closed，但仅审计也无法构成安全边界。过渡期至少要做到：

- 新安装应用全部 strict；
- 新对象必须登记 registry；
- 写操作早于读操作切换 strict；
- allowlist 由服务器持有，并绑定 tenant/plugin/sheet；
- 未登记且跨 tenant/base 的访问立即拒绝；
- legacy observe 设置明确截止日期；
- 所有未登记对象进入盘点和归属回填。

### 4.3 Manifest permissions 不能被误认为已运行时隔离

P0-B1 可以完成权限声明、preflight 和安装检查，但当前 manifest permissions 还不能裁剪插件实际 API。

验收必须区分：

```text
permissions declared
permissions validated during install
permissions enforced at runtime
```

在运行时 enforcement 落地前，不能把“manifest 已声明权限”描述为“插件已被权限隔离”。

## 五、仍需定案的数据模型

### 5.1 `writer_allow_set` 建议归一化

写者可能包括：

- `binding:<id>`；
- `app:<instanceKey>`；
- automation；
- import；
- system migration。

如果直接存储数组或 JSON，会出现：

- 缺少外键；
- binding 删除后留下悬空 writer；
- 并发修改丢失；
- 查询和审计困难；
- policy 版本演进困难。

建议以归一化授权表作为安全真源：

```text
meta_field_writer_grants
- field_id
- writer_kind
- writer_id
- binding_version_id
- state
- policy_version
```

字段上可以保留缓存投影，但不能把客户端可修改 property 或无外键数组作为权限真源。

### 5.2 必须锁定权限合成顺序

建议采用 deny 优先：

```text
computed field deny
  → base/sheet permission deny
  → field_permissions deny
  → writer grant mismatch deny
  → record lock deny
  → 允许写入
```

任何一层的拒绝都不应被另一层的 allow 覆盖。

### 5.3 v1 建议选择一个 mirror sheet 对一个 binding

文档仍把 binding↔sheet 的 1:1/1:N 留作决策，但 `meta_sheets.active_binding_id` 又是单数设计。

建议 v1 直接锁定：

```text
one synced mirror sheet = one binding
```

PLM 与 K3 分别写自己的 mirror/登记表，再由 plan 合并到业务主表。不要让多个 binding 直接并发写同一张生产业务表。

这可以避免：

- writer 归属冲突；
- 并发 apply；
- 外部键冲突；
- 一方失败而另一方已经写入；
- 一张 sheet 出现多个 active binding；
- 局部同步状态难以解释。

### 5.4 同步不应直接把生产业务表变成半完成状态

v6 提议分块写入时把 sheet 标记为 `syncing`，允许 stale read，并在 run 结束后统一 recompute。这样仍可能让用户看到半批数据。

更安全的 v1：

```text
external source
  → mirror/staging snapshot
  → generate plan
  → human confirm
  → apply business table
```

同步期间只修改镜像快照，不修改业务主表。这样 plan 才是真正的生产写入边界，也不需要长时间抑制业务表自动化。

### 5.5 External key registry 还需补充约束

除了 `(binding_id, normalized_key_hash)`，还需明确：

- 一个 active record 是否只能对应一个主键；
- 哈希碰撞如何比较完整 canonical key；
- 源端重编号采用 alias/history 还是更换主键；
- 回收站恢复如何重新激活 registry；
- binding 删除但 sheet 保留时 registry 如何归档；
- registry 的保留、压实和清除策略。

建议 hash 只用于快速定位，命中后仍比较完整 canonical key。源端重编号通过独立 alias/history 表处理。

## 六、应用升级应提前增加保护

完整三方 diff 可以放在 P2，但覆盖型 `ensureObject → ensureFields` 是当前活路径风险，不应完全等到 P2。

P0-S 或 P0-B1 至少应增加：

- 已存在对象禁止无提示 destructive reconcile；
- 重装、repair 或 enable 前生成字段 diff；
- name/type/property/order 出现差异时默认拒绝；
- 只有具名 migration operation 可以修改已有字段；
- 当前 after-sales 安装器增加重入与租户修改保留测试；
- 修复路径显式使用 `ensureMissingObjectFields` 或三方 diff seam。

另外，`tenant:instance:app` 只是兼容当前字符串解析的过渡方案。长期安全归属不应依赖 `projectId.split(':').pop()`，应逐步转为显式字段：

```text
tenant_id
app_id
instance_key
plugin_name
```

## 七、排期与治理需要进一步收敛

### 7.1 工程量单位必须统一

文档同时出现：

- 2–4 周；
- 4–6 人周；
- 16–24 周；
- 35–45 人周。

建议统一表示：

```text
工程量：person-weeks
日历周期：calendar weeks
团队假设：backend × N / frontend × N / QA × N
owner 门等待：单独列示，不计入纯工程量
```

尤其要明确 P1 的 16–24 是日历周还是人周。

### 7.2 Owner 决策应分层

25 个 owner 决策点会把所有工作串行化。建议拆成：

- 安全/授权门：owner 决定；
- 架构 ADR：技术负责人决定；
- 产品策略：产品负责人决定；
- 实施细节：开发团队决定；
- 客户级语义变更：客户负责人签字。

同时标记：

- 必须在 P0 决定；
- 进入 P1 前决定；
- 可以延迟到 P2/P3；
- 非阻塞建议项。

### 7.3 `@me` 不建议阻塞 P0-B1

v6 自己承认 `@me` 是跨 query/view/contracts 的全新能力。它不是证明备料应用壳成立的必要条件。

建议：

- P0-B1 使用预置视图或当前用户参数化入口；
- 通用 `@me` 算子进入 P1/P2；
- 不让它拖延 manifest、导航、实例和蓝图壳交付。

### 7.4 CRM-lite 建议拆成两个样板

如果 CRM-lite 必须包含同步 binding，它就不再是纯蓝图的轻量一致性样板。

建议拆成：

- CRM-schema：验证 blueprint 安装、实例和升级；
- CRM-sync：P1 完成后验证 binding、principal、字段归属和同步。

这样更容易判断失败属于蓝图层还是外部数据层。

## 八、建议的修订路线

### P0-S：安全与现有活路径保护

- workflow 租户模型、统一授权、事务状态机；
- task id 暴露和历史异常完成排查；
- legacy sheet registry 盘点与 strict 迁移；
- `ensureObject` destructive reconcile 保护；
- 旧备料系统凭据和暴露面处置。

### P0-D：核心模型 design lock

- system/integration principal；
- writer grants 归一模型及权限合成顺序；
- one mirror sheet / one binding；
- source binding 版本模型；
- 三类独立授权；
- plan 的 binding/schema/policy/snapshot 版本绑定；
- AppBlueprint 三方 diff 与 upgrade ledger。

### P0-B1：门外应用壳

- manifest、目录、导航和实例；
- schema-only 蓝图；
- 合成 fixture；
- values-free preflight；
- 模拟 plan/confirm/apply；
- 权限声明与安装检查；
- 不以通用 `@me` 为阻塞项。

### P0-B2a：现有窄链路客户激活

- 使用当前备料专用 profile、planner 和 UoW；
- 小范围真实只读；
- owner 门内值面验证；
- 有限、人工确认的生产 apply；
- 不声明通用平台同步能力完成。

### P1：通用外部数据底座

- integration principal；
- binding/version/qualification；
- mirror sheet 同步；
- writer grants 接管写路径；
- external key registry；
- sync → snapshot → plan；
- 配额、熔断、审计和急停。

### P2：蓝图与安全升级

- blueprint schema；
- id_map 和 instanceKey；
- 三方 diff、迁移和回滚；
- CRM-schema；
- CRM-sync；
- 备料描述迁入蓝图。

### P2.5：正式客户迁移

- 完整配置和历史数据导入；
- 正式双轨对账；
- 切换判据；
- 旧系统退役；
- 回滚演练。

## 九、进入 design-lock 前必须修正的六项

1. 明确 P0-B2 使用现有窄链路还是依赖 P1 通用链路；
2. 消除 P0-B2 与 P2.5 的迁移和双轨范围重复；
3. 为 workflow 建立 tenant/workspace/base 归属模型，而不只是授权函数；
4. v1 锁定 one mirror sheet / one binding；
5. 将 `writer_allow_set` 转化为或映射到归一化 writer grants；
6. 统一工程量单位，并将 25 个 owner 决策分级。

## 十、最终判断

v6 已经是一份高质量的收敛稿。它最大的进步是：不再把平台能力、客户授权和业务上线混为一谈，也不再把已有底层原语误判为完全缺失。

但它目前仍是一份“接近可执行的总体设计”，不是可以直接排给开发团队的执行包。完成六项修订、冻结目标 commit、补齐测试矩阵和验收标准后，它才适合作为正式 design-lock。

备料作为第一个业务灯塔应用的判断仍然成立。正确路线不是等待完整平台，也不是绕过平台安全边界，而是：

> 先以现有窄链路完成受控业务验证，再把被真实验证的能力迁入通用 binding、writer policy、plan 和 AppBlueprint 底座。
