# 外接适配器完善 + MSSQL 多版本支持 + Windows 部署形态 — 设计稿(已落仓)

> 状态:**已落仓 v2(并入 2026-05-27 三轮 review findings + 裁示)**,提交 `7dea4c685`,分支 `codex/data-sources-lane-a-hardening-20260527`(基于 origin/main,未 push)。
> 本稿对应需求:把现有"外接数据源适配器"做实并修复质量缺口;新增对客户 **Windows Server + SQL Server(多版本)** 环境的连接与部署支持。
> v2 关键变更:现状盘点纠正(真正可用仅 postgresql/postgres+http)、新增 A0 持久化接线 + A-RO 框架级只读、A1 改用真正 crypto service、A4 扩为 enum↔registry↔驱动三方对齐、Lane B 明确不动 K3 通道只抽共享 helper + gated 在 A 之后。

---

## 0. 治理与门控(先读这一节)

本稿涉及两类被冻结/受约束的工作,**默认不开工,逐项等显式 opt-in**:

| 工作 | 性质 | 闸门 |
|---|---|---|
| 新增 MSSQL 连接器 / 给连接配置加"版本维度" | **阶段二 connector** | 🔒 GATE/解锁后单独 opt-in(每个连接器都是独立闸) |
| 后端在客户 Windows 上的部署形态 | 基础设施 | 🔒 撞 K3 lock"不开新战线";但见 §5,运行时其实可移植,成本低于预期 |
| 现有适配器 P0/P1 修复(凭据加密 / 注入 / 错误吞咽 / 测试) | 可论证为**内核打磨 + 安全修复** | ⚠️ 由你拍板是否归入"内核打磨"放行 |

**绝不触碰**:`plugin-integration-core`、中央 RBAC/auth(K3 lock 红线)。

---

## 1. 设计原则(MetaSheet 自有原则)

1. **对客户数据源零改动、零风险**:不要求客户升级 SQL Server、不要求客户改服务器 TLS/证书配置、不要求客户开维护窗口。一切兼容性在我方 runtime 侧消化。
2. **只读优先(MVP 强制,框架级,非装饰)**:MVP 只暴露读路径。只读保障必须做到**框架级双层**(不能只靠适配器层):① 路由级 —— readOnly 源拒绝 raw `POST /:id/query` 写语句(SELECT-only 分类器,或对 readOnly 源直接禁用 raw query);② 适配器层 —— 拒绝 `insert/update/delete/transaction` 写。由 per-source `readOnly` 旗标(默认 `true`)统一控制。落地见 Lane A 的 **A-RO**(框架级,适用全部适配器),MSSQL 仅继承该保障。写能力解禁是后续独立闸。
3. **默认安全,放宽显式且可审计**:连接默认 `encrypt=true`、`trustServerCertificate=false`;任何"降级"(跳证书校验 / 关加密 / 降 TLS 版本)都是**单数据源**级别的显式配置,并在降级时落 warn 审计日志。
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
| B3 TLS 放宽策略(我方侧) | 默认 `encrypt:true,trustServerCertificate:false`;内网自签 → per-source 开 `trustServerCertificate`(仍加密);老库 TLS1.0/老 cipher(AES-CBC-SHA)→ **per-connection** 放宽(`cryptoCredentialsDetails.minVersion='TLSv1'` + cipher 串带 `@SECLEVEL=0`),作用域限该源、客户服务器零改动;**两个机制非 per-source、需进程级**:(i) 若误用 `--tls-min-v1.0` flag 是进程级——不采用;(ii) OpenSSL3 legacy provider(仅当撞上 RC4/3DES/MD5)经 `openssl.cnf` 进程级加载,**不可 per-source** → 这类极老库一律走隔离代理 sidecar 分支,不在主进程放 legacy provider;再不行该源 `encrypt:false`(仅内网 + 审计) |
| B4 版本兼容矩阵 | 2008R2 / 2012 / 2016 / 2019 / 2022 行为表(默认加密要求、TLS 版本、握手关键字)。**真实容器只能测 2017+**(MS 官方 Linux mssql 镜像最低 SQL Server 2017;2008R2/2012 是 Windows-only 二进制,无 Linux 容器)→ 2017/2019/2022 用 `mcr.microsoft.com/mssql/server` 真测;2008R2/2012 用协议级 mock。**真实 legacy(2008R2/2012)验证需 Windows VM/快照** —— 这条会给 B4 带来 Windows 测试基础设施依赖,本预算未含,列为 P0 待裁示项 |
| B5 测试 | connect/query/transaction 单测 + 经真实 wire 的集成测试(round-trip 校验,套用 wire-vs-fixture 纪律) |

**降级决策树(B3 核心)**:
```
默认: encrypt=true, trustServerCertificate=false        ← 2016+ 直接用
 └ 自签证书连不上 → trustServerCertificate=true          ← 仍加密,放弃证书身份校验(内网可接受)
    └ 老库 TLS<1.2 握手断 → 我方 runtime 放宽 TLS 下限    ← 仍加密,客户服务器不动
       └ 连 TLS1.0 都谈不拢 → 该源 encrypt=false(内网+审计) 或 隔离代理 sidecar  ← 明文为最后手段,作用域限一台
```

### Lane C — 部署形态(基础设施;运行时已基本可移植)

**关键发现**:后端运行时是干净的 —— 生产启动即 `node dist/index.js`,**不 spawn 任何 shell 脚本**(仓库 189 个 `.sh` 全是 CI/部署/开发工具,非运行时);`src` 内唯一 runtime POSIX 假设是 `ScriptSandbox.ts:108` 的 `'/tmp/sandbox'` 默认值;pg/redis 驱动纯 JS 无原生编译。故"原生 Windows 跑"成本远低于最初估计。

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

## 4. 门控 TODO 清单(🔒 待开闸 / ⬜ 待办未阻塞 / ✅ 完成)

### Phase 0 — 决策与开闸(裁示见 §5)
- ✅ P0-3 Lane A 放行(归入内核打磨/安全修复)
- 🔒 P0-4 Lane B hold,待 A0+A-RO+A1+A4 后再 opt-in
- ✅ P0-5 落点 `docs/development/data-sources-mssql-windows-deploy-design-20260527.md` + 新分支 `codex/data-sources-lane-a-hardening-20260527`(从 `origin/main`)
- ✅ P0-6 现做协议 mock + 2017+ 容器真测;legacy VM 延后
- ✅ P0-1/P0-2 优先级 A>B>C(C 兜底);客户 Linux VM / Docker 事实执行期回填

### Phase A — 适配器修复(P0-3 已放行;A0 最前置)
- ⬜ **A0 持久化接线**:`DataSourceManager` 绑 Kysely + `initialize(db)` 启动调用 + autoload/persist + 确认/补 `data_sources` 表(**A1/A4 的前置,先做**)
- ⬜ **A0.1 scope/ownership 收口**:写路径带 owner/workspace + 读/list/load 及每个 `:id` 操作按 scope 收口 + 越权拒绝测试(**与 A0 同前置,否则持久化=跨 workspace 全局缓存**)
- ⬜ **A-RO 框架级只读**:per-source `readOnly` 旗标 + 路由级 raw-query 写拦截(SELECT-only 或禁用)+ 适配器层 mutation guard + 测试
- ⬜ A1 凭据落库加密(**用真正的 crypto service,非 SecretManager**)+ 密钥来源/轮换/存量一次性迁移 + wire round-trip 集成测试
- ⬜ A2 `sanitizeIdentifier` 违规即抛 + schema-qualified 支持 + 非法值测试
- ⬜ A3 query/testConnection 错误不吞,保留错因 + 集成测试
- ⬜ A4 enum↔registry↔驱动三方对齐(收敛 enum 到可用集 / 或注册+装驱动)+ 破坏性契约迁移 + 非法 type 测试
- ⬜ A5 `stream()` 真游标流 或 明确文档标注 + 上限保护
- ⬜ A6 Postgres connect/query/transaction/错误路径单测

### Phase B — MSSQL 连接器(🔒 仍 hold;P0-4 裁示:待 A0+A0.1+A-RO+A1+A4 定住后再 opt-in;contracts-first)
- 🔒 B0 抽共享 mssql helper(连接/TLS/类型映射,通用侧,不碰 integration-core)
- 🔒 B1 契约:config 旋钮 + zod enum `mssql` + **registry 同步注册** + OpenAPI parity + 非法值测试(`readOnly` 用 A-RO,`authType` 仅 `sql`)
- 🔒 B2 `MSSQLAdapter`(tedious)实现 + 只读 guard + per-connection TLS 旋钮(`cryptoCredentialsDetails`)
- 🔒 B3 TLS 降级策略(per-connection 优先;legacy provider/明文走 sidecar 或内网+审计)+ 降级时审计日志
- 🔒 B4 2016/2019/2022 真实容器测 + 2008R2/2012 协议级 mock(真实 legacy 验证依 P0-6 决策)
- 🔒 B5 单测 + 经真实 wire 集成测试(wire-vs-fixture 纪律)
- 🔒 B6(后续切片)Windows 集成认证 `authType:'windows'` —— Kerberos/keytab/AD,独立设计

### Phase C — 部署形态(随 A/B 决策)
- ⬜ C1 `/tmp/sandbox` → `os.tmpdir()`
- ⬜ C2 A/B/C 三档部署 runbook
- 🔒 C3 (仅走 C 时)Windows 原生运行时验证 pass

**推进顺序(已按裁示更新)**:Phase 0 → **A0 + A0.1(持久化 + scope 收口)→ A-RO + A1 + A4(基础面安全)→ A2/A3/A5/A6** → **B(仅当 A0/A0.1/A-RO/A1/A4 定住后才 opt-in)** → C(随部署形态)。
- **Lane B 不再与 A 并行**:MSSQL 连接器必须落在已安全的框架上,故 gated 在 A0/A0.1/A-RO/A1/A4 之后(P0-4 裁示)。
- B 内部严格 contracts-first(B1 在 B2 之前)。
- 第一可执行 slice = **A0**(不是 B)。

---

## 5. 裁示(已定 — 2026-05-27 review)
- **P0-3 ✅ Lane A 放行**,但 **A0(持久化接线)最前置**;无 A0,A1/A4 无法真正完成。
- **P0-4 🔒 Lane B 继续 hold**,先别开工;待 **A0 + A0.1(持久化 + scope 收口)+ A-RO(只读/raw-query 防线)+ A1 + A4** 定住后再做 MSSQL,避免新连接器落在不安全的基础面上。
- **P0-6 ✅ 现在只做协议 mock + 2017+ 容器真测**;仅当客户明确是 2008R2/2012 或进入最终 signoff,才为 legacy 投 Windows VM/快照(现在上 VM 太早)。
- **P0-1/P0-2 ✅ 部署优先级 A(Linux VM)> B(Windows+Docker/WSL2)> C(原生 Windows)**;C 作兜底,非默认目标。
- **P0-5 ✅ 落点**:`docs/development/data-sources-mssql-windows-deploy-design-20260527.md`;新分支 `codex/data-sources-lane-a-hardening-20260527` 从 `origin/main` 切;第一可执行 slice = **A**(A0 起)。

### 仍待确认(执行期)
- 客户 SQL Server 具体版本(影响 P0-6 是否升级为投 Windows VM)。
- 客户是否能给 Linux VM(P0-1)/ 是否允许 Docker/WSL2(P0-2)的事实回填(影响最终走 A/B/C 哪档)。

---

## 附录:实现参考(内部,正式落仓库前剥离)
> 按"正式文档只述 MetaSheet 自有原则"惯例,以下外部参考仅供实现期借鉴,不进正式设计文档正文。
- 驱动:`tediousjs/tedious`、`tediousjs/node-mssql`(MIT)。
- SQL 方言层(可选重构方向,非本期强制):`knex/knex`(MIT)已封装 pg/mysql/mssql 方言转义/池化,可一次性 retire A2/A5 类手搓缺口;采用与否单列为后续独立闸,本期不绑定。**但要明账这笔技术债**:本期不上 Knex → `MSSQLAdapter` 得自己手搓标识符转义/池化/方言,等于把 A2/A5 的硬化工作再做一遍;MSSQL 之后的下一个 SQL 连接器会第三次重复 A2。故"采用 Knex"不是永久可选项,迟早要开这个闸——成本估算应计入这笔重复税。
- 架构参考:`directus/directus`(Node 经 Knex 连外部 SQL,含 MSSQL)、`airbytehq/airbyte` 的 `source-mssql`(连接器 config schema / 版本旋钮形态)。
- Windows Redis:`microsoft/garnet`(MIT,OSS 首选)/ Memurai(商业 fallback);开发期 SQL Server:`mcr.microsoft.com/mssql/server` Linux 容器(仅 2017+)。
