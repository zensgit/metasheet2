# SA-02J：草案验证与批准证据绑定（方案 A 已获准）

状态：2026-10-01，用户明确确认“按 A 实施 PLM 验证门——新配置通过目录校验和样本确认后，才能批准、激活”。本地实现与合成验证获准；这不是客户源库读取、发送、发布、合并或部署授权。本文与代码位于不同工作树，未提交/开 PR/合并/部署。下文原待选措辞保留为决策来由，当前选择为 A。

上位目标：[受控自助集成](integration-self-service-adaptation-goals-20260930.md)。已批准合同：[生命周期 §9、§12](stock-preparation-read-plan-lifecycle-design-20260930.md)。不新增连接器平台或第二个编排引擎。

## 1. 实读事实与问题

检查对象为代码工作树 `b35d4cd1fbaa50d0cf15e1a75745f77624a9468a` 加累计候选，未刷新 GitHub。下列行号是该工作副本的定位，不冒称都已存在于该 commit；最终实施报告另记文件字节摘要。

- `plugins/plugin-integration-core/lib/stock-preparation-read-plan-config.cjs:3` 明确 structure-only；七类角色共14个必填列、11个可选列。格式合法而不存在的列仍可通过结构检查。`stock-preparation-read-plan-store.cjs:19` 的批准是状态转换，不是物理验证证据。
- `packages/core-backend/src/data-adapters/data-source-plugin-facade.ts:764` 有现成单表 `getTableInfo`，经过当前 Connection owner 和 readonly 检查，但单独调用没有 SA02 tenant 上下文。来源必须先过同一 canonical resolver，不能从请求体另取 Connection。
- `PostgresAdapter.ts:336,434` 与 `MSSQLAdapter.ts:529,593` 查系统目录列；未知对象、权限不可见或 getter 吞掉的 query error 可能均成为空列。空列只能记“未核实”，不能误报存在或给出准确“表不存在”结论。
- `data-source-sql-readonly-source-adapter.cjs:523` 只拆一层 schema.table。普通读取把 object 直接交给宿主；metadata 的默认 schema 不等于证明 runtime search_path。PG runtime 使用未引用标识符，目录里的带引号混合大小写名称可能无法按同名读取。
- `scripts/ops/bridge-agent-readonly.ps1:557` 的 schema 来自 Agent 配置，不查询物理库。它不是与 PG/MSSQL 实查同级的证据。
- `stock-preparation-read-plan-store.cjs:49` 的 contentKey 证明配置内容相同，不证明 Connection 材料没变，也不是授权或批准签名。

必须区分三个结论：结构合法、本次物理列覆盖、样本业务语义确认。前两项都不能推出第三项；把数量列映射到真实存在的排序列仍可能通过目录检查。

## 2. A 裁决前已完成的独立代码范围（历史阶段）

不改变管理路由合同，先做两个局部增量：

1. 前后端严格 SA02 草稿把 object 语法统一为一个或两个非空标识符段，拒绝 `a..b`、尾点与三段名称；保留trim、长度、禁用词和列名规则。不改 legacy 通用 normalizer、不宣称所有历史 SQL 读取都拒绝三段名称。
2. 纯目录比较器 `inspectStockPreparationReadPlanCatalog`，只消费调用者传入的严格配置和 TableInfo 列描述，无 I/O、存储、路由或授权 capability。返回固定角色路径/错误码，`validation: physical-columns-only`、`authorizesExecution: false` 始终明确。不能拿其返回值当服务端验证回执。

保守范围：PostgreSQL 与 SQL Server 的明确 schema.table；PG 配置标识符须小写，SQL Server 精确匹配不猜 collation；裸表名、Bridge、空列、未加载目录、对象或字段歧义均未核实。真实目录中未使用的 Unicode/空格列名不应导致无关拒绝。核对所有已配置可选列，但不凭 DB 类型猜业务规则。

验证由既有 owner facade/canonical resolver 访问**新建合成 PG**，真实系统目录喂给比较器；collector 只在测试中存在，不接线上新消费者。SQL Server 本片仅目录形状与代码合同测试，不冒称真实 SQL Server 验收。

## 3. 推荐的下一刀：显式验证，而非批准时偷偷读库

建议保留保存/批准/激活分步，再增加明确的“验证草案”操作。候选授权仍为 verified tenant + workspace=null + integration admin ∩ 当前 canonical Connection owner，无 admin owner 绕过；真实客户读取继续单独窗口授权。

- 以已保存的不可变 versionId 为目标，服务端加载精确 scope 的 config/contentKey。请求不能提交 catalog、passed、tenant、actor、credentials 或 Connection 指针自证。
- 目录验证是明确的数据面操作，需要受控超时、并发/预算、来源资格与原有源读取安全约束；异常固定脱敏，不复用全 schema 列举扇出。
- 业务预演需用户显式选择样本项目，仅使用既有冻结备料动作的真实读取、完整性、BOM版本和错误合同。不能借草案绕过 B2a 对象/窗口或返回可直接写入的 apply token；不激活该草案、不写目标、不发宜搭。
- “机器验证通过”与“用户确认字段业务含义”分别记账。物理匹配不代表数量、关联键、版本含义正确；有效样本不证明所有未来项目正确。未来运行继续执行现有错误/不完整/版本门。
- 批准只接受服务端持久记录，绑定精确 tenant/null workspace、action、versionId/contentKey、system、当前 canonical Connection 和验证合同版本；激活再次核对。没有记录/失败/过期/来源变化均不继承旧验证，不回退 legacy 或默认计划。
- 同一个 Connection ID 的配置或 owner 改动也必须使证据失效。现有 generation 只是激活指针代次，不能替代来源材料版本。实现前需冻结可强制的来源修订标识及并发重验/事务合同；不能用两次普通读取宣称原子冻结，不导出含凭据的普通 SHA。
- 元数据/业务验证记录与状态审计原子保存。项目号、源表列名称、样本行不进入 values-free 审计/PR；若授权 UI 需要查看样本，用最小临时结果，不把源数据写成公开证据。

## 4. 待选择及兼容约束

推荐 **A：显式验证 + 样本确认后才能新批准/激活**。另一个可选项是 B：先只提供目录诊断，不阻断批准；B较小，但不能关闭目标中的“错误配置不能发布”。不推荐“approve 时自动连接源库”，它改变用户已确认的 metadata-only 行为且难于解释等待/失败。

新门上线时，已批准但无验证记录的版本不能被自动补章。需盘点并安排重新验证；现有在用版本要采用何种切换/停用窗口，必须在部署授权前明确，不在本轮悄悄退役。当前未发布候选可在本地测试中按新合同补数据；不能据此假定现网无旧数据。

本选择只批准后续本地开发与合成验证，**不授权**真实客户读取、宜搭发送、生产写、公开 PR、合并或部署。独立 ADR 与实现仍按 GOV-08 分开发布。

## 5. A 实施验收要求（执行结果另记）

- 真路径先绿：真实JWT/owner/tenant → 指定 draft → 实际目录/样本 → 持久回执 → 精确批准/激活；不能用客户端上传的通过标记或宽松假 facade 替代。
- 各单点变异必须独立红：删目录字段检查、仅验证部分可选列、丢 tenant/owner、换版本/来源后复用回执、把Bridge声明当实查、只做metadata却当业务确认、绕过批准/激活验证门。
- 真实 DB 交错验证来源修订、状态/回执原子性、重复验证/并发激活；没有来源强制版本或锁协议前不宣传证明已冻结。
- UI明确待验证/仅目录匹配/预演错误/待确认/可批准的不同状态；旧响应不得覆盖新会话或新版本。
- 不削弱当前管理“不读源”测试来换绿。新增显式操作用自己的真路径证据，旧六个操作仍只读注册元数据。

此前纯比较器未接线上批准门属于当时的获准范围边界；现在按 A 推进显式验证、业务确认及批准/激活证据门。SA02和总目标仍未完成，必须完成真实生产路径和独立审查后另记结果，不能把本次授权当成实现完成。

## 6. A 的本地实现合同（2026-10-01 冻结）

顺序为：保存不可变版本 → 显式验证该版本及所选项目 → 临时查看最多20行样本 → 单独确认样本 → 批准 → 激活。目录不匹配、业务展开不完整或空样本均不能取得通过回执。保存、列表、确认、批准、激活、退役、停用本身不触发源库读取。

### 6.1 持久证据与生命周期

新增服务端回执表，合同版本固定 `plm-read-plan-validation.v1`，状态为 pending / passed / confirmed / failed。回执绑定版本、内容摘要、租户、空 workspace、动作、绑定、当前连接修订及验证人，只存计数和时间；不持久化项目号、样本、物理表列名称或凭据。所有证据转换与审计在同一事务。

有效期从 begin 开始15分钟，finish、confirm、新批准、新激活都必须在有效期内。重复验证取得新回执并替换版本的最新指针，不能再用旧回执批准。每个当前连接修订只允许一个未过期 pending 尝试，跨版本也受限；进程异常后需等待该尝试到期再重试，没有客户端强制豁免。源读取预算仍独立受更短的时间/页数/行数上限约束。

激活指针冻结当时已确认的回执。已经激活后，单纯15分钟到期或新 pending 不会自行停用当前版本；运行仍重新核对来源、owner、版本状态与指针代次。没有证据的旧指针拒绝运行，不伪造回填。部署前必须盘点和明确重新验证/切换窗口，本地实现不授权停用任何现网版本。

### 6.2 来源修订及锁顺序

`data_sources.validation_revision` 由数据库触发器铸造随机 UUID；连接材料、类型、owner、tenant、workspace、scope、启停/删除变化轮换，健康检查及更新时间不轮换。赋旧值、改回原配置的 ABA、删后同 ID 重建都不能复用旧修订。原子维护无凭据的元数据镜像表；绑定侧也有独立修订，覆盖 connection_id、配置、凭据密文、作用域及状态变化。

内存适配器只绑定加载它的同一条数据库记录或同次写入 RETURNING 的修订，不再读当前数据库修订给旧适配器“换标签”。宿主 facade 在 schema/select 调用前核对预期修订和适配器身份，异步连接期间更换适配器也拒绝。该边界不防同进程可信代码恶意修改内部对象。

证据事务先固定 READ COMMITTED，再锁实际绑定行 → 无凭据来源镜像 → 版本 → 回执 → 激活指针。源配置写入持有连接行后更新镜像，与验证提交形成真实数据库等待关系。不得反过来先锁镜像再锁绑定，避免与既有绑定写路径形成环。

源库读取不持有上述事务锁；读完提交证据时重查修订。批准和激活不读源。运行时读取亦绑定加载适配器修订，但不宣称远端源数据行级快照、在途读取瞬时撤销或配置和远端 SQL 的分布式原子性。超时后禁止后续页/角色读取，不宣称已取消数据库驱动的在途查询。

### 6.3 授权与部署前置

当前范围仅 verified JWT tenant + 空 workspace + integration admin ∩ 当前 canonical private Connection owner，PG/MSSQL 明确 schema.table。旧版本的 createdBy 是历史审计，不是永久授权；owner 变更使旧证据失效，新 owner 可重新验证同一不可变内容。Bridge 元数据声明不能作为本门的物理校验证据。

执行与源预检都将冻结回执的绑定修订，与真正传给适配器的那一行的私有修订比较，并把连接修订传到 facade。绑定修订不进入 public/list 响应。该检查约束选中的配置快照；不宣称撤销已经开始的远端读取。

tenant-only 是实际作用域限制，不是全 workspace 已切换的承诺：精确 workspace 来源绑定仍使用自己的执行作用域，不自动继承 tenant 激活指针。页面必须保留此提示；本刀不改 workspace 回退语义，不把当前工作区已应用该版本当作验收结论。

沿用现有 B2a 窗口、对象、预算与前后 schema 核对，新增独立用途 `stock-preparation.read-plan-validation`；不能借 table-action 的用途授权验证或反向借用。仅新显式 validate 端点触发该来源读取。

部署严格先迁移后代码：两个 TypeScript 迁移位于宿主实际扫描的 `src/db/migrations/zzzz2026100112*.ts`，排序晚于连接/绑定前置和数值 SQL 087。不得放到只扫描 SQL 的顶层 migrations，也不得拿更早的数值前缀绕过依赖。已有证据时 ledger down 明确拒绝，不能把“可回滚”理解为删除验证历史。这里只说明部署约束，未执行部署。
