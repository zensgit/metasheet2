# Windows-native deploy (Lane C tier C) — 开源对标素材(内部研究,非正式设计文档)

> **性质**:内部 OSS 对标研究。按"正式文档只述 MetaSheet 自有原则"惯例,外部产品/品牌名只在本研究文档出现;runbook / 设计稿正文保持品牌克制,仅引用"推荐默认 / 备选"。
> **用途**:为 **C3-env validation kit**(`scripts/ops/validate-windows-runtime.ps1` + 2008R2/2012 兼容矩阵)提供选型依据。kit 的定位是 **验证(probe)优先**,非一键安装器。
> **核实日期**:2026-05-29(版本/许可证经 web 核实,见文末 Sources)。

---

## 0. 结论速读(选型)

| 需求 | 推荐默认(OSS) | 备选 | 许可证 |
|---|---|---|---|
| Node 作 Windows 服务 | **nssm**(Non-Sucking Service Manager) | node-windows(基于 winsw)/ winser | nssm 公共领域 · winsw/node-windows MIT |
| Windows 上的 Redis 替代(RESP) | **Microsoft Garnet** | Memurai(商业,非 OSS) | Garnet **MIT** |
| PostgreSQL on Windows | 官方 **EDB Windows 安装包** | —(无 OSS 缺口) | PostgreSQL License |
| 连旧版 SQL Server(2008R2/2012) | **tedious / node-mssql**(本仓库既用) | —(驱动层无替换需求) | **MIT** |

**总判断**:tier C 全栈可由已知 MIT/OSS 组件 + 我方既有 B3 驱动路径拼装,**无需自研基础设施**。唯一需在客户机现场核实的是 **Garnet 命令子集覆盖**(见 §2)。

---

## 1. Node 作 Windows 服务

- **nssm**:把任意程序(含 `node dist/src/index.js`)注册为 Windows 服务,两条命令即可;社区长期生产使用、最简。**kit 默认走 nssm**。
- **node-windows**(coreybutler):早期基于 nssm,**现基于 winsw.exe**;复用 OS 原生 uptime,可与 Nagios / System Center 等系统监控对接。比 nssm 集成更深,但更重。
- **winsw**:node-windows 的底座,能力强。
- **winser**(jfromaniello):npm 包,封装 nssm 注册流程。
- **裁示落地**:kit **只在脚本里实现 nssm 路径**;node-windows 仅作**附录/备选**说明,不在脚本里双实现(避免双维护 + 决策面扩大)。

## 2. Windows 上的 Redis 替代 — Garnet(OSS 首选)

- **Microsoft Garnet**(`microsoft/garnet`):Microsoft Research 的远程 cache-store,采用 **RESP 线协议**,可被**未改动的 Redis 客户端**驱动(支持的命令子集持续扩大);**Windows 与 Linux 同等高效测试**;Microsoft 内部**生产部署**(Azure Resource Manager 等);NuGet `garnet-server`。**许可证 MIT**。
- **Memurai**:Windows 上的 Redis 兼容实现,**商业**(开发版免费 / 商业版付费),作稳定 fallback。**非 OSS**。
- ⚠️ **现场核实项(kit 验收前)**:Garnet 宣称"持续扩大的命令子集"——必须先核实 **MetaSheet 后端实际用到的 Redis 命令/特性**(队列 / 发布订阅 / Lua / 过期策略等)落在 Garnet 已支持集合内,再决定 Garnet vs Memurai。kit **默认 RESP `PING`(只读连通,零写入)**;`-RedisWriteProbe` 开关另跑一个自清理 SET/GET/DEL 临时 key 证基本读写命令覆盖(默认关,以保持默认零写入)。更深的命令覆盖核实留作部署期 checklist 项。

## 3. PostgreSQL on Windows

- 官方 **EDB Windows 安装包**即可;`DATABASE_URL` 指向它。驱动(`pg`)纯 JS、无原生编译,Windows 无障碍。无 OSS 缺口,kit 只做**可达性 + 迁移 pending** 探测,不自动安装。

## 4. 旧版 SQL Server(2008R2/2012)— tedious 既有路径 + B3 TLS

web 核实印证了我方 B3 设计的必要性,旧库连接的真实坑:

- **2008/2008R2/2012/2014 需补丁才支持 TLS 1.2**;而**现代 Windows 默认禁用 TLS 1.0/1.1** → 客户端默认谈不拢。
- **cipher 套件不匹配**时,服务器**直接关闭连接**(不报错),表现为连接失败。
- 旧 workaround 是进程级 `--tls-min-v1.0` flag —— **我方 B3 的 per-connection `cryptoCredentialsDetails`(`minVersion`/`ciphers`)正是为取代它**:作用域限单数据源、不污染进程、客户服务器零改动。
- 自签证书 → `trustServerCertificate`(我方默认 true)。
- **结论**:旧库路径 = B3 TLS 降级旋钮 + `trustServerCertificate`,**无需新代码**;2008R2/2012 因无 Linux 容器,只做**协议级 matrix + smoke recipe**(指向客户实例),**不承诺 CI 或本机验证**。
- 连接器版本怪癖参考:`directus`(Knex+MSSQL)、`airbyte` `source-mssql`(config schema / 版本旋钮形态)。

---

## 5. 对 validation kit 的映射

| OSS 素材 | kit 用法(验证优先) |
|---|---|
| nssm | `-RegisterService` 显式 opt-in 时注册服务;默认只探测"是否已注册 / nssm 是否在 PATH" |
| Garnet/Memurai | 默认 RESP `PING`(零写入);`-RedisWriteProbe` 加自清理 SET/GET/DEL 读写探测;命令覆盖深核 = checklist 项 |
| EDB PG | 默认可达性 + `migrate --list` pending 探测;不自动装 |
| tedious + B3 | legacy smoke recipe:`smoke:sqlserver` + B3 TLS 旋钮指向 2008R2/2012 实例 |

---

## Sources(2026-05-29 核实)

- Garnet:<https://github.com/microsoft/garnet> · <https://microsoft.github.io/garnet/docs> · NuGet `garnet-server` <https://www.nuget.org/packages/garnet-server/>
- Windows 服务:node-windows <https://github.com/coreybutler/node-windows/wiki> · winser <https://github.com/jfromaniello/winser> · nssm 用法 <https://briancaos.wordpress.com/2022/12/01/run-node-js-on-windows-server-using-nssm/>
- 旧版 SQL Server TLS:<https://learn.microsoft.com/en-us/troubleshoot/sql/database-engine/connect/tls-1-2-support-microsoft-sql-server> · <https://learn.microsoft.com/en-us/troubleshoot/sql/database-engine/connect/ssl-errors-after-tls-1-2> · node-mssql 自签证书 issue <https://github.com/tediousjs/node-mssql/issues/1271>
