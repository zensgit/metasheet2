# 外接适配器完善 + MSSQL 多版本支持 + Windows 部署形态 — 设计稿(已落仓)

> 状态:**已落仓并完成收口回填(2026-05-31,按 `origin/main` 至 #2161 核准)**。本稿最初提交为 `7dea4c685`;当前 §4 为完成态 tracker,不再代表初稿快照。
> 本稿对应需求:把现有"外接数据源适配器"做实并修复质量缺口;新增对客户 **Windows Server + SQL Server(多版本)** 环境的连接与部署支持。
> v2 关键变更:现状盘点纠正(真正可用仅 postgresql/postgres+http)、新增 A0 持久化接线 + A-RO 框架级只读、A1 改用真正 crypto service、A4 扩为 enum↔registry↔驱动三方对齐、Lane B 明确不动 K3 通道只抽共享 helper + gated 在 A 之后。

---

## 0. 治理与门控(先读这一节)

本稿涉及两类被冻结/受约束的工作,**默认不开工,逐项等显式 opt-in**:

| 工作 | 性质 | 闸门 |
|---|---|---|
| 新增 MSSQL 连接器 / 给连接配置加"版本维度" | **阶段二 connector** | ✅ 已 opt-in 并落地(#1985 + 后续 B3/B4/B5A/smoke) |
| 后端在客户 Windows 上的部署形态 | 基础设施 | ✅ C1/C2/C3-code/C3-env kit 已落地;🔒 客户 Windows 主机实跑证据待回填 |
| 现有适配器 P0/P1 修复(凭据加密 / 注入 / 错误吞咽 / 测试) | 可论证为**内核打磨 + 安全修复** | ✅ 已按 Lane A 完成 |

**绝不触碰**:`plugin-integration-core`、中央 RBAC/auth(K3 lock 红线)。

---

## 1. 设计原则(MetaSheet 自有原则)

1. **对客户数据源零改动、零风险**:不要求客户升级 SQL Server、不要求客户改服务器 TLS/证书配置、不要求客户开维护窗口。一切兼容性在我方 runtime 侧消化。
2. **只读优先(MVP 强制,框架级,非装饰)**:MVP 只暴露读路径。只读保障必须做到**框架级双层**(不能只靠适配器层):① 路由级 —— readOnly 源拒绝 raw `POST /:id/query` 写语句(SELECT-only 分类器,或对 readOnly 源直接禁用 raw query);② 适配器层 —— 拒绝 `insert/update/delete/transaction` 写。由 per-source `readOnly` 旗标(默认 `true`)统一控制。落地见 Lane A 的 **A-RO**(框架级,适用全部适配器),MSSQL 仅继承该保障。写能力解禁是后续独立闸。
3. **默认安全,放宽显式且可审计**:连接默认 `encrypt=true`(线缆始终加密);`trustServerCertificate` 默认 `true`(信任内网自签证书、跳过证书身份校验,但**仍全程加密**——ERP 内网部署常态,PR1 #1985 既定默认)。更进一步的降级(降 TLS 版本/cipher、或关加密走明文)都是**单数据源**级别的显式配置,并在降级时落 warn 审计日志。降 TLS(B3,仍加密)与关加密(明文)互斥,不可同设。
4. **线缆加密与存储加密正交**:网络 TLS 与"凭据落库加密"是两件事,都要做;内网部署不豁免存储加密。
5. **适配器与部署形态解耦**:连 SQL Server 的能力不依赖后端跑在哪(Linux VM / 容器 / 原生 Windows 三档通用)。

---

## 2. 现状摘要(为何要"完善")

- 路由 `routes/data-sources.ts` 鉴权齐全(`rbacGuard('data_sources', …)` 全覆盖),参数化 SQL 到位 —— 这部分是好的。
- **现状盘点(已核验,比初稿更糟)**:
  - **真正能端到端连通的只有 `postgresql`/`postgres` + `http`**。
  - zod enum 暴露 7 种(`postgresql/postgres/mysql/mongodb/http/redis/elasticsearch`),但 `registerDefaultAdapters()` 只注册 5 种(`postgresql/postgres/mysql/http/mongodb`)→ **`redis`/`elasticsearch` 在 enum 里但未注册 = 必抛 `Unsupported data source type`**。
  - 已注册的 `mysql`/`mongodb` 又因 `mysql2`/`mongodb` 驱动未装 → 运行时抛 `xxx package is not installed`。
  - 即:enum ↔ registry ↔ 已装驱动 **三方不一致**,多数类型是"可选但必挂"。
- **持久化是死代码(P0 前置)**:`getManager()` 直接 `new DataSourceManager()` 不传 db,`initialize(db)` 全仓库无调用 → `this.db` 永远 undefined,落库/加载分支不执行。**当前数据源只活在内存单例里,进程重启即丢**;凭据加密/存量迁移无真实落点 → 见 Lane A 的 **A0**。
- **只读有现成后门(P0)**:`POST /api/data-sources/:id/query`(`data-sources.ts:487`)执行任意 SQL,经 `BaseAdapter.query()` 裸 SQL seam(`BaseAdapter.ts:201`)。仅在适配器层挡 `insert/update/delete` **拦不住** 经 raw query 发来的 `DELETE/UPDATE` → 只读保障必须做到框架级,见 Lane A 的 **A-RO**。
- **已有 K3 SQL Server 通道(K3 红线,只借鉴不改)**:`plugins/plugin-integration-core/lib/adapters/k3-wise-sqlserver-{channel,executor}.cjs` 已用 node-mssql/tedious 连 SQL Server(executor 为 new-pool-per-call,`new driver.ConnectionPool`)。说明驱动在本仓库已验证可用;但它是 K3 专用特权通道(对象白名单 + 结构化读 + 中间表写边界),抽象与 `BaseDataAdapter` 的长连接/池化生命周期不同 → 见 Lane B 处理方式。
- 无通用 MSSQL 适配器;连接配置无"版本"概念;`DataSourceConfig.connection` 是无类型 `Record`,无 per-type 校验。

---

## 3. 三条工作轨

### Lane A — 现有适配器 P0/P1 修复(内核打磨 + 安全修复;不新增类型)

| 项 | 问题 | 修复 |
|---|---|---|
| **A0 持久化接线(最前置)** | `getManager()` 不传 db,`initialize(db)` 无人调用 → 数据源只在内存、重启即丢,A1/A4 无落点 | 给 `DataSourceManager` 绑定 Kysely(`initialize(db)` 在 `index.ts` 启动时调用)+ 启用 autoload/persist;确认 `data_sources` 表 schema 存在(无则补迁移)。**A0 不做,A1/A4 无法真正完成** |
| **A0.1 scope/ownership 收口(与 A0 同前置)** | 持久化层有 `owner_id/workspace_id`,但:创建路由 `addDataSource(config)` 不传 owner/workspace(`data-sources.ts:188`,默认落 `'system'`);`loadFromDatabase()` 全量载入(`:69`);`listDataSources()` 枚举整张内存 map(`:539`)→ **一开持久化即变跨 workspace 全局缓存** | ① 写路径:create/update 把 `req.user.id`(owner)+ workspace 上下文传入 `addDataSource`/persist;② 读路径:load/list/get 及每个 `:id` 操作(get/test/connect/query/select/schema)按 owner/workspace 收口,拒绝越权访问他人数据源;③ 结构问题:内存单例仅以 `id` 为键、跨 scope 共享 → 路由层须对每个 id 操作强制 scope 校验。**A0.1 与 A0 同为前置,先于 A1/A4** |
| **A-RO 框架级只读保障** | raw `POST /:id/query`(`data-sources.ts:487`)绕过适配器写 guard | ① per-source `readOnly` 旗标(默认 true)进 config;② 路由级:readOnly 源拒绝 raw query 写语句(SELECT-only 分类器 或 禁用 raw query);③ 适配器层:拒 `insert/update/delete/transaction`。三层齐全才算只读。**框架级、适用全部适配器**,MSSQL 继承 |
| A1 凭据明文落库 | `DataSourceManager.ts:130` 留 `// TODO: Encrypt sensitive fields`,凭据明文进 JSONB | 落库前加密 `credentials`,读取时解密;迁移已有明文行(加解密 API + 密钥管理见下) |

> **A1 加解密 API + 密钥管理(安全修复需先定清,否则埋雷)**:
> - **不要用 `SecretManager`** —— 它只是 secret provider/loader(只有 `get()`,无加解密)。真正的 `encrypt/decrypt` 在 `src/security/plugin-runtime-security-service.ts:190/195`(或等价 SecurityService);A1 impl 时确认复用哪个、是否适合数据源凭据场景。
> - ① 主密钥来源(env / 文件 / OS keystore / KMS),三档部署各自取哪个;② 轮换姿态(能否轮换、旧密文如何重加密);③ 存量迁移(建议一次性全量迁移 + 校验无明文残留,而非惰性重加密)。
| A2 `sanitizeIdentifier` 静默改写 | `BaseAdapter.ts:247` 用正则吃掉非法字符,`user-name`→`username`、`public.foo` 的 `.` 被吞 | 改为**违规即抛**;显式支持 schema-qualified(按 `.` 分段各自校验) |
| A3 错误吞咽 | `PostgresAdapter.query()` 把异常包成 `{data:[],error}`;`testConnection()` catch 后返 false,错因丢失 | 区分"连接/语句错误"与"空结果";`testConnection` 保留错因(返回结构含 message) |
| A4 空壳/未注册适配器(enum↔registry↔驱动三方不一致) | `redis`/`elasticsearch` 在 enum 但未注册(必抛 Unsupported);`mysql`/`mongodb` 已注册但驱动未装(必抛 not installed) | 对齐三方:**(a)** 要做实的类型 → 注册 + 装驱动 + 连通验证;**(b)** 暂不做的 → 从 enum 摘除。建议先把 enum 收敛到真正可用集合(postgresql/postgres/http),其余按需再开。**注意:摘 enum 是破坏性契约变更** —— 必须同步 OpenAPI parity 门,且存量 `data_sources` 中该 `type` 的行需迁移策略(删除 / 标记 inactive / type 重命名),不可裸摘 |
| A5 `stream()` 假流 | 注释自承 "batch fetch instead of true cursor"、一次性读进内存 | 接 `pg-cursor`/`pg-query-stream` 做真游标流;或明确文档标注"非流式 + 上限保护" |
| A6 测试缺失 | Postgres/MySQL 等核心适配器零单测 | 补 connect/query/transaction/错误路径单测 |

> **wire-vs-fixture 纪律**:A1/A3 涉及对象序列化(凭据、错误)经字段拷贝/投影,凡新增字段必须有"经真实 wire 往返"的集成测试,不能只测手搓 fixture。
> **enum 严格性纪律**:A2/A4 涉及枚举入参,必须显式测"非法值不静默回落默认"。

### Lane B — MSSQL 连接器(阶段二,🔒 需 opt-in;contracts-first)

**驱动决策**:选 `tedious` / `node-mssql`(纯 JS、跨平台、支持 SQL Server 2008R2→2022;K3 通道已在用,驱动可用性已验证)。**不选** `msnodesqlv8`(原生编译 + 仅 Windows + 装 ODBC Driver),除非将来明确需要 Windows 集成认证再单独评估。

**与已有 K3 通道的边界(K3 lock 红线)**:`plugin-integration-core` 的 `k3-wise-sqlserver-*` 是 K3 专用特权通道(对象白名单 + 结构化读 + 中间表写),**不改、不泛化、不复用其本体**。做法:把"纯 mssql 连接 / TLS 协商 / 类型映射"这类**与 K3 业务无关的底层 helper**抽成共享模块(放通用侧,不放 integration-core),新增 **sibling `MSSQLAdapter`** 走 `BaseDataAdapter` 的长连接/池化生命周期(**不是** executor 那种 new-pool-per-call)。只借鉴经验,不动红线。

| 项 | 内容 |
|---|---|
| B1 契约(先行) | `connection` 新增 per-source 旋钮:`version` / `encrypt` / `trustServerCertificate`;zod enum 加 `mssql` + **registry 同步注册 `mssql`**(避免重蹈 A4 的 enum/registry 不一致);OpenAPI parity 同步;非法 `type` 必须报错不回落。`readOnly` 旗标由 A-RO 统一定义,MSSQL 默认 `true`。**`authType` 本期只定 `'sql'`**;`'windows'`(集成认证)从 Linux runtime 走需 Kerberos/keytab/AD 信任/票据续期,是独立切片(B6),不在本期契约里半成品化 |
| B2 适配器实现 | `MSSQLAdapter extends BaseDataAdapter`(tedious,长连接/池化生命周期,**非 new-pool-per-call**),对齐 connect/query/select/getSchema/stream;**继承 A-RO 框架级只读保障**(路由级 + 适配器层);TLS 旋钮经 tedious `cryptoCredentialsDetails` 的 **per-connection** `minVersion` + `ciphers`(含 `@SECLEVEL=0`)落地——明确走 per-connection,不用进程级 `--tls-min-v1.0` flag;复用 §Lane B 抽出的共享 mssql helper |
| B3 TLS 放宽策略(我方侧) | 默认 `encrypt:true` + `trustServerCertificate:true`(信任内网自签证书,仍加密;PR1 #1985 既定默认,有受信 CA 时可 per-source 收紧为 `false`);老库 TLS1.0/老 cipher(AES-CBC-SHA)→ **per-connection** 放宽(`cryptoCredentialsDetails.minVersion='TLSv1'` + cipher 串带 `@SECLEVEL=0`),作用域限该源、客户服务器零改动,**仍加密;与 `encrypt:false` 互斥(同设即抛)**;**两个机制非 per-source、需进程级**:(i) 若误用 `--tls-min-v1.0` flag 是进程级——不采用;(ii) OpenSSL3 legacy provider(仅当撞上 RC4/3DES/MD5)经 `openssl.cnf` 进程级加载,**不可 per-source** → 这类极老库一律走隔离代理 sidecar 分支,不在主进程放 legacy provider;再不行该源 `encrypt:false`(仅内网 + 审计) |
| B4 版本兼容矩阵 | 2008R2 / 2012 / 2016 / 2019 / 2022 行为表(默认加密要求、TLS 版本、握手关键字)。**真实容器只能测 2017+**(MS 官方 Linux mssql 镜像最低 SQL Server 2017;2008R2/2012 是 Windows-only 二进制,无 Linux 容器)→ 2017/2019/2022 用 `mcr.microsoft.com/mssql/server` 真测;2008R2/2012 用协议级 mock。**真实 legacy(2008R2/2012)验证需 Windows VM/快照** —— 这条会给 B4 带来 Windows 测试基础设施依赖,本预算未含,列为 P0 待裁示项 |
| B5 测试 | connect/query/transaction 单测 + 经真实 wire 的集成测试(round-trip 校验,套用 wire-vs-fixture 纪律) |

**降级决策树(B3 核心)**:
```
默认: encrypt=true, trustServerCertificate=true         ← PR1 既定:加密 + 信任内网自签证书(2016+/内网直接用)
 ├ (可选收紧) 有受信 CA 证书 → trustServerCertificate=false  ← 校验证书身份,更严
 └ 老库 TLS<1.2 握手断 → per-connection 降 TLS 下限/cipher(B3)  ← 仍加密(cryptoCredentialsDetails),客户服务器不动
    └ 连 TLS1.0 都谈不拢 → 该源 encrypt=false(内网+审计) 或 隔离代理 sidecar  ← 明文为最后手段,作用域限一台;与 B3 互斥
```

### Lane C — 部署形态(基础设施;运行时已基本可移植)

**关键发现(2026-05-29 全面审计已纠正)**:后端运行时是干净的 —— 生产启动即 `node dist/src/index.js`,**不 spawn 任何 shell 脚本**(仓库 `.sh` 全是 CI/部署/开发工具,非运行时);pg/redis/mssql 驱动纯 JS 无原生编译。`src`(+ 已加载 plugins + 部署期 `migrate`)内的 runtime POSIX 假设经全面审计共 **两处**,均已处理:① `ScriptSandbox` workDir `'/tmp/sandbox'`(C1,已修为 `os.tmpdir()`);② `ScriptSandbox` 两处 `spawn('python3')`(C3-code,已修为平台感知 `resolvePythonBinary` + `PYTHON_BIN`)。**初稿"唯一 `/tmp/sandbox`"的说法不完整 —— `python3` spawn 是审计补出的第二处。** 故"原生 Windows 跑"成本仍远低于最初估计,且代码层已 `windows-latest` CI 真证(见 C3 验证计划)。

依赖侧:后端自身需 PostgreSQL + Redis。Postgres 有 Windows 官方安装包;**Redis 无官方 Windows 原生版** → Windows 原生兼容选项:**Microsoft Garnet(MIT 开源,.NET 8,RESP 兼容)** 作 OSS 首选,**Memurai**(开发版免费/商业版付费)作稳定商业 fallback;或 WSL2 / Docker。这才是 Docker 省事的真正原因,而非 Node app 本身。

**三档部署(按客户 IT 接受度;对 Lane B 连接能力无影响)**:

| 档 | 形态 | 代价 | 适用 |
|---|---|---|---|
| **A(首选)** | 客户给一台同网段 Linux VM,跑现有镜像/compose | 零移植 | 客户能给内网 Linux VM |
| **B** | Windows + Docker/WSL2,`docker compose` 起 app+PG+Redis | 客户需接受 Docker(注意 Docker Desktop 企业授权) | 允许 Docker/WSL |
| **C** | 全原生 Windows:Node 注册为 Windows 服务(nssm/node-windows)+ PostgreSQL Windows 安装包 + **Garnet(OSS)或 Memurai(商业)** | 修 `/tmp/sandbox`(C1)+ 一次 Windows 运行时验证(C3)+ 引入 Garnet/Memurai | Windows 且禁 Docker |

| 项 | 内容 |
|---|---|
| C1 | `ScriptSandbox.ts:108` `'/tmp/sandbox'` → `path.join(os.tmpdir(),'sandbox')` |
| C2 | 部署 runbook 覆盖 A/B/C 三档 |
| C3 | 若走 C:Windows 原生运行时验证 pass(路径/文件操作/服务化/PG+Memurai 连通) |

---

## 4. 门控 TODO 清单(✅ 完成 / 🔒 硬件或独立闸 / ⬜ 可选债务)

> **状态回填 2026-05-31**:按 `origin/main` 至 #2161 核准。外接数据源 / SQL Server 连接器已从 API-only 走到**后端安全闭环 + Windows 部署/验证 kit + UI list/create/delete/test/edit/credential rotation**。剩余项不再阻塞"连接客户 SQL Server"目标:仅客户硬件证据(C3-env、2008R2/2012)与可选技术债(B0/B6/UI-schema/UI-preview/真 cursor/Knex)。

### Phase 0 — 决策与开闸(裁示见 §5)
- ✅ P0-3 Lane A 放行(归入内核打磨/安全修复)
- ✅ P0-4 Lane B 已 opt-in(A0/A0.1/A-RO/A1/A4 定住后,2026-05-28):通用连接器 PR1 #1985 + B3 legacy-TLS #1997
- ✅ P0-5 落点 `docs/development/data-sources-mssql-windows-deploy-design-20260527.md` + 新分支 `codex/data-sources-lane-a-hardening-20260527`(从 `origin/main`)
- ✅ P0-6 现做协议 mock + 2017+ 容器真测;legacy VM 延后
- ✅ P0-1/P0-2 优先级 A>B>C(C 兜底);客户 Linux VM / Docker 事实执行期回填

### Phase A — 适配器修复(P0-3 已放行;A0 最前置)
- ✅ **A0 持久化接线**(#1960 `ec0516b5d`):`DataSourceManager.initialize(db)` 启动调用 + autoload/persist + `data_sources` 表
- ✅ **A0.1 scope/ownership 收口**(#1960):写路径带 owner + `assertAccess` 每个 `:id` 操作越权 404 + list 过滤 + 越权拒绝测试
- ✅ **A-RO 框架级只读**(#1964 `b0f7c54df`):per-source `readOnly`(默认 true)+ 路由级 SELECT-only 分类器 + 适配器层 `assertWritable`
- ✅ A1 凭据落库加密(#1972 `5e11ee72c`):用 `encrypted-secrets` AES-256-GCM(非 SecretManager)+ 惰性迁移 + decrypt fail-loud
- ✅ A2 `sanitizeIdentifier` 违规即抛 + schema-qualified 支持(#2037 `bf0eefc78`):按 `.` 分段校验、非法即抛(不再静默改写);MSSQL/MySQL per-segment quote;`[dbo].[table]` schema-qualified 经 SQL Server 容器 matrix 真 wire 证
- ✅ A3 query/testConnection 错误不吞,保留错因(#2034):`testConnection` 返回 `{success,error?}`;错因经 `redactSecrets` 脱敏(`password`/`token` 不入 response/log);manager 仅转发 redacted `connectionError`;真 wire 集成测试覆盖
- ✅ A4 enum↔registry↔驱动三方对齐(#1976 `f5013324e`):`SUPPORTED_DATA_SOURCE_TYPES` 单一支持矩阵 + 非法 type 400 + load 跳过不支持行
- ✅ A5 结果边界策略(#2079,取「明确上限保护」而非真 cursor):共享 `DATA_SOURCE_DEFAULT_LIMIT=1000` / `DATA_SOURCE_MAX_ROWS=10000`;**适配器层 `select()` 硬防线**(omit→MAX cap、>MAX→抛、非法→抛,经 `resolveEffectiveLimit`),挡住绕过路由的直连内部调用(`DataSourceManager` 复制循环已显式分页,不受影响);路由 `/select` 入口补默认 limit、超限 400(zod);raw `/query` 无法安全自动限界 → 标为非大表导出通道 + 无 `LIMIT/TOP/FETCH` 时 best-effort warning + audit(裸 `OFFSET` 不算上限);`stream()`(raw SQL、未经路由暴露、内部唯一)仍为非流式,真 cursor 留作后续 thorough。测试 `data-source-result-boundary.test.ts`(14 例:常量 + resolveEffectiveLimit + PG/MSSQL select 真 wire + 路由默认/400/warning)
- ✅ A6 Postgres 适配器单测(#2139 `0e35ae94e`,并行会话):connect/query/transaction/错误路径覆盖 —— `packages/core-backend/tests/unit/postgres-adapter.test.ts`

### Phase B — MSSQL 连接器(Lane B 已 opt-in 2026-05-28;contracts-first)
- ⬜ B0 抽共享 mssql helper(连接/TLS/类型映射)—— 可选债务。当前 `MSSQLAdapter` 内联实现已稳定,不阻塞客户连接;若后续复用到更多 SQL Server 通道再抽,且不碰 integration-core。
- ✅ B1 契约(#1985 `ff0bcd0cc`):`type=sqlserver` zod enum + registry 同步注册(`SUPPORTED_DATA_SOURCE_TYPES`)+ config 旋钮(encrypt/trustServerCertificate)+ 非法 type 400;`readOnly` 用 A-RO 默认 true;`authType` 仅 `sql`
- ✅ B2 `MSSQLAdapter`(mssql 驱动,池化生命周期)实现(#1985):connect/query/select/getSchema/stream + 继承 A-RO 只读 guard + `[ ]`/TOP/OFFSET-FETCH/`@pN`
- ✅ B3 per-connection TLS 降级旋钮(#1997):`cryptoCredentialsDetails.minVersion`/`ciphers`(经 `tlsMinVersion`/`tlsCiphers`/`legacyTls` 便捷开关),secure-by-default,非法 minVersion 即抛,降级 `emit('tls-downgrade')` 审计 + warn;仍加密(明文/legacy-provider 仍走 sidecar)
- ✅ B4 版本兼容矩阵与现代真 wire 证据:2019/2022 SQL Server service-container CI matrix 已落(#2030 `524f89576`);旧版 2008R2/2012 兼容矩阵 + legacy smoke recipe 已落(`data-sources-windows-2008r2-2012-compat-matrix-20260529.md`)。🔒 真实 2008R2/2012 执行仍需客户 Windows VM/快照。
- ✅ B5 单测 + 真 wire smoke:fake-driver/SQL 生成/TLS 旋钮单测 + B5A opt-in smoke gate(#2026) + 2019/2022 CI real-wire matrix(#2030) + B3 TLS env smoke(#2131/#2132)。🔒 legacy 旧库真跑证据待客户 VM。
- 🔒 B6(后续切片)Windows 集成认证 `authType:'windows'` —— Kerberos/keytab/AD,独立设计

### Phase C — 部署形态(随 A/B 决策)
- ✅ **C1** `'/tmp/sandbox'` → `path.join(os.tmpdir(),'sandbox')`(`ScriptSandbox.ts` + `script-sandbox-workdir.test.ts`;测试 mock `os.tmpdir()` 到非 `/tmp` sentinel,断言 workDir 派生自 `os.tmpdir()` 而非硬编码字面量 —— 否则 Linux CI 上 `os.tmpdir()===/tmp` 会让回退到字面量仍然 pass)
- ✅ **C2** A/B/C 三档部署 runbook —— `docs/development/data-sources-mssql-windows-deploy-runbook-20260529.md`
- ✅ **C3-code** 代码可移植层(#2054):`ScriptSandbox` 两处 `spawn('python3')` → `resolvePythonBinary()`(平台感知 `win32→python` + `PYTHON_BIN` 逃生口)+ `executePython` error-path 临时文件 cleanup;`script-sandbox-python-portability.test.ts`(resolve 纯测 + bogus-binary error path + 真 wire `validateScript`)+ **`windows-latest` CI lane**(`sandbox-windows-portability.yml`,path-filtered + targeted,真 win32 证 workDir/python 解析/真 wire/error-path,无 PG/Redis)。审计纠正了"唯一 `/tmp/sandbox`"说法
- ✅ **C3-env kit**(#2111 `656a57f93`):`scripts/ops/validate-windows-runtime.ps1` + Windows OSS 选型研究 + C3 validation plan + 2008R2/2012 matrix;默认 probe-only/零改动,安装与服务注册显式 opt-in。
- 🔒 **C3-env execution**(需客户 Windows 主机):PG/Garnet\|Memurai 连通 + nssm/node-windows 服务化 + 端到端启动 + auth/data-source smoke 证据回填。

### Phase UI — 用户可操作面(唯一 tracker)
- ✅ UI-1 list/create/delete(#2147 `1054444a8`):首个 `/data-sources` 页面,凭据空值省略、必填 host/database/baseURL、delete confirm。
- ✅ UI-2 test connection(#2151):列表行测试连接,展示 A3 脱敏错误与 latency。
- ✅ UI-3 edit non-secret config(#2154 + #2155 + #2161):编辑 name/connection/readOnly;后端深合并 `connection` 防止丢 TLS/security keys;前端支持 server-only MSSQL 且不削弱 Postgres host 规则。
- ✅ Credential rotation(#2160 `82d6317b2`):独立凭据模式/接口,只提交填写字段,留空不覆盖旧凭据。
- ⬜ UI-schema 库表/字段浏览:surface `GET /api/data-sources/:id/schema` + `GET /api/data-sources/:id/tables/:table`;后端端点已就位,前端尚未暴露。
- ⬜ UI-preview bounded read preview:surface `POST /api/data-sources/:id/select`;A5 已在后端提供上限保护,前端预览不是连接器可用性的硬门槛。

**完成态判定(2026-05-31)**:A/B/C-code + UI 管理主线(连/测/改/删/轮换)均已合并;独立管理工具完整性还剩 UI-schema + UI-preview 两个 surface-only 前端切片。继续推进只应围绕:(1)客户/VM 实跑证据回填;(2)独立 opt-in 的可选债务,不要再把它们并入连接器核心完成标准。

---

## 5. 裁示(已定 — 2026-05-27 review)
- **P0-3 ✅ Lane A 放行并完成**:A0/A0.1/A-RO/A1/A2/A3/A4/A5/A6 均已落。
- **P0-4 ✅ Lane B 已按条件 opt-in 并完成主线**:MSSQL 通用连接器、TLS 旋钮、现代真 wire smoke 均已落;B6 Windows 集成认证仍是独立冻结切片。
- **P0-6 ✅ 现代路径已真测;legacy 真实证据待 VM**:2019/2022 容器 CI 已证;2008R2/2012 有矩阵 + B3 smoke recipe,真实执行需客户 Windows VM/快照。
- **P0-1/P0-2 ✅ 部署优先级 A(Linux VM)> B(Windows+Docker/WSL2)> C(原生 Windows)**;C 作兜底,非默认目标。
- **P0-5 ✅ 落点**:`docs/development/data-sources-mssql-windows-deploy-design-20260527.md`;新分支 `codex/data-sources-lane-a-hardening-20260527` 从 `origin/main` 切;第一可执行 slice = **A**(A0 起)。

### 仍待确认(执行期)
- 客户 SQL Server 具体版本(影响 P0-6 是否升级为投 Windows VM)。
- 客户是否能给 Linux VM(P0-1)/ 是否允许 Docker/WSL2(P0-2)的事实回填(影响最终走 A/B/C 哪档)。
- 若客户要求原生 Windows C 档,需运行 `scripts/ops/validate-windows-runtime.ps1` 回填 C3-env evidence。

---

## 附录:实现参考(内部,正式落仓库前剥离)
> 按"正式文档只述 MetaSheet 自有原则"惯例,以下外部参考仅供实现期借鉴,不进正式设计文档正文。
- 驱动:`tediousjs/tedious`、`tediousjs/node-mssql`(MIT)。
- SQL 方言层(可选重构方向,非本期强制):`knex/knex`(MIT)已封装 pg/mysql/mssql 方言转义/池化,可一次性 retire A2/A5 类手搓缺口;采用与否单列为后续独立闸,本期不绑定。**但要明账这笔技术债**:本期不上 Knex → `MSSQLAdapter` 得自己手搓标识符转义/池化/方言,等于把 A2/A5 的硬化工作再做一遍;MSSQL 之后的下一个 SQL 连接器会第三次重复 A2。故"采用 Knex"不是永久可选项,迟早要开这个闸——成本估算应计入这笔重复税。
- 架构参考:`directus/directus`(Node 经 Knex 连外部 SQL,含 MSSQL)、`airbytehq/airbyte` 的 `source-mssql`(连接器 config schema / 版本旋钮形态)。
- Windows Redis:`microsoft/garnet`(MIT,OSS 首选)/ Memurai(商业 fallback);开发期 SQL Server:`mcr.microsoft.com/mssql/server` Linux 容器(仅 2017+)。
