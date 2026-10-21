# 集成层 G4 结构化强制设计（PR-2 第一刀，2026-09-08）

> 一句话：把 SQL adapter 的 resolver 调用纪律变成可验证的对象来源约束，移除 adapter 加载降级；对无可信调用身份的跨插件 SQL / 私有配置操作明确拒绝。不是完整的跨插件租户隔离方案，也不是同进程恶意代码沙箱。触发条件见 §6；在此之前不动工。

- 基线：`origin/main@a15f5433b`（2026-09-08）。行号为当日快照，动工前重核。
- 性质：设计说明，不是实施记录。values-free。
- 上游：`docs/integration-consolidation-minimal-plan-20260901.md`（PR-1/2/3 分工）、PR #5452 合并后终审（G4 被批评者判为"约定而非结构"）。

## 1. 为什么现在写：三次同类事故一个根因

| 事故 | 表现 | 根因归类 |
|---|---|---|
| PR-1 合并后终审（高） | `loadTableActionSourceAdapter` 先以请求者解析连接、再委托 owner；守卫测试只挂 `getExternalSystem`，resolver 从未运行 | 调用点纪律 + 测试替身绕过收口 |
| #5471 → #5534 | 读取口回退到租户级行，写入口按请求作用域保存，两半不一致 | 读写两侧各自决定作用域，无共享不变式 |
| #5538 反驳 | 把 sql-readonly 分支从 `scopedAuthenticatedWriteInput` 降为 `scopedInput` 后整套测试仍绿 | 守卫存在与否只靠测试作者记得去测 |

三者共同点：**守卫是否生效取决于每个调用点是否记得调它**。今天代码里的事实（均可核）：

- 路由注册只要求 `upsertExternalSystem / getExternalSystem / deleteExternalSystem / listExternalSystems`（`lib/http-routes.cjs:3495`），**不要求** `getExternalSystemForAdapter`。15 处方法存在性检查实际分为 **13 处三元回退 + 2 处 C6 target 条件重载**（:5503、:5638），不能一律当三元表达式机械替换。生产提供 ForAdapter，但测试替身可缺失它。
- runner 有独立入口：`lib/pipeline-runner.cjs:337` 仍只要求 `getExternalSystem`，:372–376 自己做 ForAdapter → 公共投影回退；源、目标和 replay 都消费它（:409、:416、:1276）。路由的硬依赖不能约束 runner。
- adapter 没有 resolver **来源证明**：`lib/adapters/data-source-sql-readonly-source-adapter.cjs:561` 接受 `config.dataSourceId`，但不证明该对象经过 resolver；`lib/connection-resolver.cjs:136–146` 的 `adapterBinding` 返回普通对象。这不等于宿主 facade 的 owner / tenant / 只读检查不存在。
- 跨插件通信面（`index.cjs`）：`upsertExternalSystem` 已剥 `principal` 并强制 `runAs:'service'`（:214），但 `upsertPipeline` 原样转发（:227-228），`createdBy` 落库后即成为 pipeline-runner 的连接 principal；`tenantId` 两处都原样转发。
- 仅清空请求 `createdBy` 不封住既有流水线：`lib/pipelines.cjs:511–522` 只在 INSERT 写 `created_by`，UPDATE 保留旧 owner；`lib/pipeline-runner.cjs:413` 仍用旧 owner 解析连接。tenant 已绑定且 owner 匹配时，facade 允许 service 读取（`packages/core-backend/src/data-adapters/data-source-plugin-facade.ts:494–523`），不能把 `runAs:'service'` 当作 SQL 禁用开关。

## 2. 目标不变式（每条都要可测、可变异）

- **I1** 规范化 kind 为 `data-source:sql-readonly` 时，`createAdapter` 仅接受生产接线的 resolver 实例登记的普通 SQL 产物；sealed 专用入口仅接受该实例登记的 sealed 最终产物。非产物在消费前 fail closed；普通 adapter 的稳定错误码为 `ADAPTER_INPUT_UNRESOLVED`，sealed 沿用其 values-free 错误合同。
- **I2** SQL 的 credential-stripped 公共投影不能作为 adapter / sealed 输入；所有本刀列明的 adapter 加载点都不得因 ForAdapter 缺失而降级。**不宣称**所有 HTTP/K3/PLM 公共对象在任意 `createAdapter` 调用上都被打标拒绝；C6 非 adapter-backed 的 config-only 路径保留。
- **I3** 本刀保护的 SQL / 私有配置系统变更及关联流水线变更、运行、replay，不接受通信参数自报的 `principal / createdBy / tenantId` 作为授权。当前通信面没有可信用户上下文，这些操作拒绝；不能借用既有流水线 owner 绕过。非敏感通信读写的 tenant 参数治理不在此不变式内，仍是待处理的隔离风险。
- **I4** 每个独立守卫都有原版通过、降级后失败的证据；不能用另一个提前失败的守卫冒充该变异被捕获。运行时变异用 `-r` 预载钩子在 CI 之外复跑，结构约束用独立静态测试。

威胁边界：生产装配代码、宿主注入 facade 与模块加载机制受信任。对象来源约束用于捕获绕过 resolver、复制投影等错误，不是权限凭证；读取时的认证、tenant / owner 校验继续由既有宿主路径执行。任意同进程代码若能替换 facade / checker / module loader，本设计不保证隔离，不能靠 Symbol 或 WeakSet 解决。

## 3. 机制：三刀加一条备注

### M1 · resolver 实例登记产物身份（实现 I1）

- 不采用“私有非枚举 Symbol 即不可伪造”的方案：`Object.getOwnPropertySymbols()` 可从合法对象取出 Symbol，再贴给另一对象；不导出 Symbol 不能防反射复制。
- 推荐在 `createConnectionResolver` 的**实例闭包**内维护私有 WeakMap，登记最终产物及类别 `ordinary / sealed`，只暴露内部判定函数，不暴露登记器或容器。生产 `index.cjs:308–324、358` 将**同一实例**的 resolver 与 checker 注入 registry / adapter registry / sealed 消费入口；不经通信 API 导出，不从单次请求 `deps` 接受替换。另一实例（包括假 facade 创建的实例）的产物不能通过生产 checker；checker 缺失时 SQL 消费拒绝。
- 在成功完成本次解析后登记独立快照，冻结顶层以及独立复制的 config / credentials 等可变子对象，避免登记后改连接指针、tenant 或嵌套配置。不冻结宿主共享对象；不缓存并跨请求复用已登记产物。WeakMap 登记不替代消费路径已有的实时权限检查。
- `lib/contracts.cjs:223` 先按已有规范规范化 kind，再对**原输入对象**验身份，之后才交付规范化投影。不能只比原始 `system.kind`：`' data-source:sql-readonly '` 经 :75 的 trim 后也会选到 SQL factory。不能在丢失对象身份的投影上验 WeakMap。
- sealed 要在 `resolveSealedSqlServer` 拼完最终 config / credentials 后登记，不能只在 `adapterBinding()` 登记：当前 :356–365 的 spread 会产生新对象。`lib/sealed-export/stock-preparation-runtime-core.cjs:232–243` 不走 `createAdapter`，必须在 `getExternalSystemForSealedSnapshot` 返回后、source-authority 消费前接独立 sealed 类别检查；普通产物不得替代 sealed 产物。
- JSON / spread / prototype 派生的对象均不是登记对象，应拒绝；不得提供“拷贝标记”或通用补登记来修复红测。测试通过同一受控装配中的真实 resolver 获取产物，host facade 仍可在测试边界替身化。

### M2 · 去掉 credential-stripped 回退，硬依赖 ForAdapter（实现 I2）

- 路由 `requireService` 增加 `'getExternalSystemForAdapter'`（`http-routes.cjs:3495`），**13 处三元回退**改为直接调用；runner 的独立依赖检查（`pipeline-runner.cjs:337`）同步增加该方法，:372–376 删除公共投影回退，覆盖源、目标与 replay。
- **2 处 C6 target 条件重载**只移除方法存在性条件（`http-routes.cjs:5503、5638`）。保留“public peek → 判断 `ADAPTER_BACKED_C6_TARGET_KINDS` → ForAdapter 重载”的次序与种类限制，不得改成全部 target 无条件解密；非 adapter-backed target 继续走原 config-only / dataSourceWrites 路径。
- 不新增 `PUBLIC_PROJECTION` 品牌。本刀的 SQL 对象来源限制由 M1 完成，M2 负责加载路径硬依赖；这两条联合实现收窄后的 I2，不扩展成全 kind 的品牌体系。
- **这是工作量主体**：缺少 ForAdapter 的替身在注册时就应失效。普通编排测试可提供满足合同的 mock；声称 SQL 权限 / resolver 保证的测试必须用真实 registry + 真实 `createConnectionResolver` + 假 host facade（参考 #5534），不能只把原来返回公共投影的方法改名。M1 的 checker 同样使用该测试实例，不以 `() => true` 背书。

### M3 · 通信面拒绝无可信身份的敏感操作（实现 I3）

- 宿主通信分派直接 `fn(...args)`（`packages/core-backend/src/index.ts:2354–2360`），没有注入用户 / tenant，也没有 JSON 隔离。对自报 principal 做 membership 查询只能证明成员关系，不能证明调用者就是该人，故本刀不走这条“背书”捷径。
- `upsertPipeline` 在通信边界剥离自报 principal，并强制 `createdBy=null`、service 姿态；这是**新建归属字段清洗**，不是已有 SQL pipeline 的执行围栏。不重写历史 owner 或做隐式数据回填。
- 推荐维持无可信身份即拒绝敏感操作，不在本刀新造跨插件授权协议。实施时必须按下表覆盖**既有对象及部分更新**，而非仅检查请求体的 kind 或是否携带凭据：

| 通信入口 | 本刀保护范围 / 拒绝点 |
|---|---|
| `upsertExternalSystem` | 新建 SQL / 私有配置系统拒绝；更新时同时检查已有行及合并后的有效配置，禁止省略 kind / 私有字段规避。不能先修改再检查。 |
| `upsertPipeline` | 新建及更新都检查当前和拟写入的源 / 目标引用；任一属于 SQL / 私有配置系统即拒绝。旧 `created_by` 不是跨插件授权依据。 |
| `runPipeline` / `replayDeadLetter` | 根据数据库中的 pipeline、源 / 目标、dead-letter 关联关系判定；涉及受保护系统时在加载凭据 / 建 adapter / 产生效果之前拒绝，包括已有 owner 的流水线及 dry-run。保留 `runAs:'service'`，但不依赖它代替拒绝。 |

- “私有配置”复用并核实既有分类规则（`lib/external-systems.cjs:239` 的 `hasPrivateConfigMutation` 是请求变更检查，**不能单独当作已有行分类器**）。缺少可靠分类、引用缺失或读写间目标改变均 fail closed；实施需在实际变更 / 消费边界复核同一目标，不能仅凭一次 public peek 放行。只读 public 投影缺少私有字段，不能据其缺字段判无私有配置。
- 非敏感旧通信接口暂不全面改造，其 tenant 参数仍是路由输入，**不是已认证租户**；本刀不承诺这些接口已租户隔离。跨插件可信 tenant / 调用者能力协议留待独立裁决，在第二租户 / workspace 接入前必须解决，不能以本设计合入替代隔离验收。动工前先盘点真实调用方；若依赖上述拒绝的敏感操作，停止该刀并明确迁移路径，不能悄悄放行或转为代 owner 执行。

### M4 · 备注：W4 开关默认值不在本刀

`MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED` 默认 OFF 是部署事件（`http-routes.cjs` 开关注释、交付指南 §5-5）。翻 ON 的前置是所有部署令牌带声明；#5538 的子例 (d) 已把 OFF 的过渡姿态显式断言，翻转时必须有意识地改它。

## 4. 测试策略

- 探针采用 `-r` 预载 + 内存篡改，不改工作副本；每个实施 PR 将可复跑脚本与命令入库，不依赖会话级 `scratchpad`。每个探针记录独立的原版 PASS / 变异版 FAIL 和命中断言：
  - M1：分别删除普通 / sealed 消费端检查，未解析对象的拒绝测试必须红；加入规范化 kind、反射复制 Symbol、spread / JSON / prototype、另一 resolver 实例、登记后修改 config、普通产物冒充 sealed 等负例。合法普通 / sealed 最终产物是各自阳性对照，不能因“全部请求都被拒绝”而绿。
  - M2-a：独立移除路由或 runner 的 ForAdapter **硬依赖**，缺方法替身的“注册必须拒绝”测试应失败。此测试验证注册合同，不冒充路由执行证据。
  - M2-b：给生产加载点加静态 / AST 禁止公共投影降级的约束，逐点恢复回退必须使结构测试失败。运行时另测硬依赖与调用点**同时降级**的联合变异，并记录它不是单守卫证据；HTTP 与 SQL 用例分开，避免 SQL 的 M1 先拒绝掩盖 M2。C6 两个入口分别验证 adapter-backed 必重载、非 adapter-backed 不获取凭据。
  - M3-a：用允许的非敏感 pipeline 新建测试独立断言落库前 `createdBy=null`、principal 已剥离；仅移除字段清洗，该断言必须红，不能依赖 SQL 拒绝守卫兜底。
  - M3-b：分别移除敏感系统 upsert、pipeline upsert、run、replay 的拒绝点；覆盖新建、已有 owner、部分更新、伪造 tenant / principal、引用切换和 dry-run，独立断言没有进入凭据读取 / adapter / 写效果。使用真实 registry / runner，在效果边界替身化；不能把整条被测服务替换为恒拒绝 mock。
- M2 已有硬依赖时，“仅恢复三元回退 + 缺方法替身”在原版和变异版都会注册失败，**没有鉴别力**，不接受这种变异报告。
- 反驳纪律：每刀合并前问一遍"哪种降级变异它抓不到"（#5538 的教训）。
- 被 pin 文件以 `plugins/plugin-integration-core/lib/sealed-export/sealed-export-package-provenance.cjs` 的实际清单为准，不把任意目录通配当清单。每刀涉及被 pin 文件时重算并验证；仓库根目录执行 `node plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs`。Windows 使用符合 `.gitattributes` 的 LF 工作树；shell 子测试需可用的 Git Bash，不能用 PowerShell 5.1 的 `git show | sha256sum` 文本管道替代字节校验。

## 5. 分步、顺序、回滚

| 序 | 刀 | 为什么先/后 | 回滚 |
|---|---|---|---|
| 1 | M2 去回退 | 最机械，但触面最大（替身改造），先把测试基线立正 | 单独 revert |
| 2 | M1 实例身份 | SQL 保证型测试接线真实 resolver，并补 sealed 最终消费检查 | 单独 revert，恢复调用点纪律的残余风险须记录 |
| 3 | M3 通信 API | 独立，盘点调用方后关闭敏感新建 / 更新 / 执行路径 | 单独 revert 会重开已知通信风险，需明确授权，不作为自动恢复动作 |

三刀三 PR，不改持久化 schema；各自复核被 pin 清单与回滚影响。每刀走“rebase 最新 main → 必要时 re-pin → 全部 required checks 与审批齐备 → 确认候选 head/base 未变后及时合并”。integration-guard 与 S5 两条腿是重点检查，不替代全部检查或合并授权；本设计不授予动工、合并、打包或部署权限。

## 6. 触发条件与非目标

- **触发**（任一）：有人要给 integration 插件加一条"加载外部系统再建 adapter"的路由；任何部署出现第二个租户或 workspace；出现第二个跨插件调用方。
- **非目标**：workspace 共享模型、删除语义/软删复活、Bridge 下沉 core、W4 默认值翻转、连接器目录/自动化触发、全 kind 品牌体系、完整跨插件租户授权协议、同进程恶意代码沙箱——各归各的后续条目。第二租户触发工作不等于获准上线，残余隔离风险须单独闭环。

## 7. 风险

- M2 会一次性让一批测试替身失效，必须在同一 PR 里改完，不能分批（否则中间态 CI 红）。
- M1 最大风险是 checker 接错实例、在中间对象而非最终产物登记、合法消费者重建对象后丢失登记、或把来源证明误当权限。不得以导出登记器、通用补登记或假 checker 修补。
- M3 的敏感分类及读写间目标一致性必须落到真实入口测试；不能把“createdBy 清空”写成全部通信 tenant 安全，也不能清洗历史 owner 来掩盖授权缺口。
- 三刀涉及不同的路由、runner、装配与 sealed 消费文件；与备料线并行时可能触发 pin 冲突，应逐刀盘点实际差异，安排短暂合并窗口，而非假定每刀都改同一组文件。
