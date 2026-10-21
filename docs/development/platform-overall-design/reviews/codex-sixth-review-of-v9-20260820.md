# MetaSheet 业务应用平台总体设计 v9：Claude 反馈第六轮复核意见

> 日期：2026-08-20  
> 复核对象：Claude 对 v8 第五轮复核的回复、MetaSheet 业务应用平台总体设计 v9 Markdown、v9 PDF  
> 建议状态：完成 v9.1 勘误后冻结为 Ratification Review 输入；停止总体设计 prose 往返，转入 P0-S 执行与 P0-D spike

## 1. 总体结论

我同意 Claude“停止长篇 prose 往返，转入 P0-S 执行和 P0-D spike”的建议。经过多轮复核，继续通过文字推演的边际收益已经明显下降。

Principal 采用反向 FK 还是 subtype，以及 Mirror 采用内部 staging 还是双物理 sheet，必须依靠真实 schema、原型、数据库约束和规模测试解决。

但当前 v9 仍不适合原样冻结。它存在几处复制残留，三个 spike 也缺少明确验收标准。建议先形成一次很短的 v9.1 勘误版，之后停止 v10/v11 式总体设计稿循环。

后续主要交付物应转换为：

```text
ADR
+ migration 草案
+ 最小原型
+ 测试结果
+ 性能数据
+ 回滚证明
```

## 2. v9 仍存在的正文错误

### 2.1 版本号残留

标题为：

```text
MetaSheet 业务应用平台化总体设计 v9
```

但前言仍写“版本：v8”，§4、§13 等章节标题也仍使用 v8。冻结前必须全文统一为 v9 或 v9.1。

### 2.2 §10 仍保留已经 Deferred 的 BPMN 建设

§7 已经明确完整 workflow 授权模型 Deferred，不进入当前平台主线，但 §10 仍列出：

```text
workflow 归属链
authorizeTaskAction
list 安全投影
```

这些内容应从当前 core 增量中删除，移动到“未来正式选择 BPMN 后”的条件性路线。

### 2.3 §10 仍保留已经作废的 sync_from_source

同一段同时出现旧命令和“无该命令”，形成直接矛盾。应彻底删除旧名称，只保留五阶段：

```text
refresh_mirror_from_source
→ publish_mirror_generation
→ propose_business_apply
→ approve_plan
→ apply_plan
```

### 2.4 P0-D 路线图仍包含完整 workflow 模型

P0-D 行仍写有“workflow 归属模型与六个设计问题”，但 Decision #16a′ 已将其 Deferred。应从 P0-D 删除，改为：

```text
P0-D 仅记录 BPMN 重新启用条件；
完整授权和租户模型在正式选择 BPMN 后另立项目。
```

### 2.5 Designer 保留边界存在两个版本

应采用更严格的统一口径：

- draft：可保留；
- modeling：可保留；
- compile preview：可保留；
- deploy：关闭；
- runtime start：关闭；
- message/signal/timer：关闭。

P0-S 不应投入完整 designer 租户授权后，又把完整 BPMN 加固标为 Deferred。

## 3. BPMN P0-S 不能只关闭 HTTP 路由

ENABLE_BPMN_RUNTIME=false 必须同时关闭：

1. HTTP runtime 路由；
2. workflow engine 初始化；
3. timer poller；
4. 后台 job；
5. message/signal 消费；
6. designer 到 deploy/runtime 的旁路。

否则即使 /api/workflow 被关闭，数据库中已有的 timer、service task 或后台 worker 仍可能继续执行。

建议采用单一 fail-closed 开关 ENABLE_BPMN_RUNTIME。只有精确值 true 才启用；缺失、空值、非法值全部视为 false。

关闭前还需盘点 active process instances、未完成 user tasks、timer jobs、message/signal subscriptions、service tasks 和 incidents。

### P0-S BPMN 验收测试

```text
flag 缺失 → runtime 不初始化
flag=false → runtime 不初始化
flag 非法 → runtime 不初始化
所有 /api/workflow runtime 请求被拒绝
designer 无法 deploy/start
timer poller 不启动
已有 timer 不执行
Approval Center 不受影响
```

## 4. Principal Spike 的验收标准

Claude 已接受“业务对象反向持有 principal_id”，方向正确。但 Principal Spike 必须验证以下约束。

### 4.1 租户一致性

只有 principal_id FK 不能保证业务对象和 principal 属于同一租户。建议采用复合约束或等效实现：

```text
UNIQUE(id, tenant_id)

FOREIGN KEY (principal_id, tenant_id)
REFERENCES principals(id, tenant_id)
```

### 4.2 一对一主体归属

必须决定：

- 一个 binding 是否只能对应一个 principal；
- 一个 principal 是否允许同时被 binding、connector 或 automation 引用；
- principal 是否可以被重新绑定；
- subtype 与 principal 是否严格一对一。

安全主体一般不应被重新复用。

### 4.3 删除、撤销和审计

需要明确：

- 删除 binding 是删除 principal 还是 revoke；
- 历史 revision 是否仍能解析原 principal；
- revoke 后已有 token/session 是否立即失效；
- grant 是否立即失效；
- principal ID 是否永久禁止复用。

建议以 revoke 为主，不物理删除 principal，以保证历史审计稳定。

### 4.4 表名

当前主体还包括 integration、connector 和 system migration，因此 automation_principals 名称过窄。建议使用 service_principals 或 non_human_principals。

## 5. Mirror Publication Spike 是最关键的实验

Claude 已认识到“切换 active_generation_id 不等于读隔离”，这是正确的。但“内部 staging 后发布到用户 sheet”仍没有自动解决原子性。

### 5.1 核心困难：稳定 Record ID

其他表可能通过 link 字段引用 mirror 中的记录。如果每次发布删除并重建 mirror：

- record ID 会变化；
- link/lookup 可能断裂；
- 人工关联可能失效；
- 历史 revision 无法稳定对应；
- registry 与 record ID 的绑定需要重写。

如果为了保持 record ID 而逐行更新现有 mirror，发布过程又可能出现半批状态。

因此 spike 必须回答：如何同时保证原子可见性和稳定 record ID？

### 5.2 方案 A 的实际验证点

内部 staging 发布到现有 mirror 时，必须验证：

- 发布是否可以在单一数据库事务内完成；
- 最大可接受数据规模；
- 是否长时间锁表；
- 自动化和 record events 何时触发；
- 未变化记录是否保持原 record ID；
- 发布失败能否快速回滚；
- 服务重启后能否恢复。

### 5.3 方案 B 的实际验证点

双 physical sheet 切换 active sheet 时，必须验证：

- sheet ID 是否变化；
- 公式、视图、link 指向哪个 sheet；
- 是否需要逻辑 sheet ID；
- 字段 ID 是否稳定；
- 跨 base link 是否失效；
- 权限、导航和视图是否需要复制。

v9 中的“one mirror sheet = one binding”建议改为：

> 一个 binding 对应一个逻辑 mirror；内部可以使用一个或多个物理发布载体。

否则双 sheet 方案与既有定案字面冲突。

### 5.4 Mirror Spike 必须通过的验收条件

1. 任意读者只能看到完整旧代或完整新代；
2. 未变化外部记录的 record ID 稳定；
3. link、lookup、formula 和 view 不断裂；
4. 自动化不会收到重复或半批事件；
5. 发布失败可以回滚；
6. 服务重启后可以恢复或安全重试；
7. 目标规模有实际基准测试；
8. 旧 generation 有明确保留和清理策略；
9. plan 绑定已发布 generation，而不是未完成 staging；
10. 并发 refresh、publish、propose 和 apply 有明确互斥规则。

在这些结果出现前，不应仅凭 prose 直接锁定方案 A。

## 6. External Key Spike 还需关联 Registry Generation

v9 增加 normalization_version 是正确的，但还应研究 registry_generation_id。

normalization 版本升级时，同一业务键可能生成不同 canonical/hash。如果新旧规则的 registry 行同时 active，现有唯一约束未必能够阻止语义重复。

建议升级流程为：

1. 冻结旧 registry generation；
2. 使用新 normalization 重建；
3. 检测坍缩和冲突；
4. 生成迁移报告；
5. 原子切换 active registry generation；
6. plan 绑定 registry generation；
7. 旧 plan 在切换后成为 stale。

alias/history 在 §4 中被作为源端重编号的正式方案，但在 §15 又被放进“后续产品化”。必须二选一：

- 如果 v1 支持源端重编号，alias/history schema 和运行时进入 P1；
- 如果不进入 P1，v1 应显式拒绝自动重编号，只允许人工迁移。

## 7. §15 应增加 Production Go-Live Gate

v9 将备份恢复、保留和导出、SLO、App Center 权限 runtime enforcement 等放入“后续产品阶段”。它们不一定阻塞 Design Lock，但其中一部分必须阻塞生产上线。

建议改成四层。

### A. Design Lock 阻塞

principal、writer grant、mirror、registry、plan、租户和字段权限。

### B. P1 执行包

migration、rollback、测试矩阵、observability、容量基准和 Exit Criteria。

### C. Production Go-Live Gate

- 备份恢复演练；
- 数据保留和租户删除；
- 凭据轮换；
- SLO 和告警；
- 灾难恢复；
- 权限 runtime enforcement；
- 审计导出；
- 生产回滚演练。

### D. 后续产品功能

移动端、页面编排、聚合收件箱、external lookup 和其他体验增强。

App Center 权限如果仍只有声明而没有 runtime enforcement，就不能对客户宣称应用已经实现权限隔离。

## 8. 代码基线仍未真正冻结

文档记录了新检查点 c5a4a94f7，但前言仍以 9d4a87824 为基线，并注明本地没有新提交。

本轮复核时 GitHub main 最新检查点仍为：

```text
c5a4a94f7fc4ae8347ea9ad9da9fa446ccd87a4d
```

正确冻结顺序应为：

1. 本地拉取或检出 c5a4a94f...；
2. 固定 migration head；
3. 重跑代码事实检查和最小测试；
4. 生成带完整 SHA 的 v9.1；
5. 冻结 v9.1 为 Ratification Review 输入。

可以停止长篇设计迭代，但不能跳过 rebaseline。

## 9. PDF 审阅结果

新版 PDF 共 21 页：

- 第 1–15 页有正文；
- 第 16–21 页为空白页，共 6 页；
- Decision Register 和路线图仍较密；
- A4 竖版不适合宽表。

当前优先使用 Markdown 作为工作稿。正式 Ratification Pack 应重新生成 PDF，删除空白页，并将宽表改为横向附件。

## 10. 最终裁决

### 对 Claude 的收敛提议

同意：

> 不再进行 v10、v11 式总体设计散文循环。

### 对当前 v9

有条件接受，但需要先完成 v9.1 机械勘误：

1. 全文版本号统一；
2. 删除 §10 和 P0-D 中残留的 BPMN 完整改造；
3. 删除所有 sync_from_source；
4. 统一 designer 保留边界；
5. 修正 one mirror 的逻辑/物理含义；
6. 增加 Production Go-Live Gate；
7. 在真实目标 SHA 上重跑代码事实；
8. 正式送审 PDF 重新排版。

完成这些机械修订后，应冻结总体设计，不再继续 prose 往返。

## 11. 下一阶段三条工作线

### P0-S：立即执行

- fail-closed BPMN runtime gate；
- 同时关闭 engine、poller、worker 和 deploy 旁路；
- /erp/* 关闭及凭据事件处置；
- ensureObject destructive-reconcile 守卫；
- assertSheetScope inventory。

### P0-D Spike 1：Principal

产出：

```text
ADR
+ schema/migration
+ tenant FK 验证
+ revoke/delete 测试
+ 授权查询成本
```

### P0-D Spike 2：Mirror Publication

产出：

```text
A/B 原型
+ record ID 稳定性
+ link/formula 验证
+ 并发/失败恢复
+ 规模基准
```

### P0-D Spike 3：External Key Registry

产出：

```text
DDL
+ normalization version migration
+ registry generation
+ collision/renumbering 测试
+ plan stale 测试
```

## 12. 对备料首应用的结论

备料仍然可以作为第一个应用，而且不需要等待 P1 全部完成：

> 完成 P0-S、客户授权门和生产回滚保障后，可以按 B2a 窄路径进行真实客户验证；但 P1 通用底座必须等待 Principal、Mirror、Registry 三个 spike 完成并 Ratify。

B2a 的专用路径必须继续受限于登记的客户、系统、数据范围、到期时间和 B2b 迁移条件，不能被其他应用当作通用集成能力复用。

