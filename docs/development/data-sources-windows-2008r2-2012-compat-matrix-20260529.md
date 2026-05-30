# 旧版 SQL Server(2008R2 / 2012)兼容矩阵 + legacy smoke recipe

> **范围**:Lane C 的旧版 SQL Server 支持。**只做协议级矩阵 + smoke recipe,不承诺 CI 或本机验证** —— 2008R2/2012 是 Windows-only 二进制,无 Linux 容器镜像(MS 官方 `mcr.microsoft.com/mssql/server` 最低 2017),真实验证需客户 **Windows VM/快照**。
> **配套**:部署 runbook `data-sources-mssql-windows-deploy-runbook-20260529.md`(档 C)+ C3 验证计划 `data-sources-windows-c3-validation-plan-20260529.md` + OSS 对标 `docs/research/windows-deploy-oss-references-20260529.md`。
> **驱动事实**(已 web 核实,见研究文档):2008/2008R2/2012/2014 需补丁才支持 TLS 1.2;现代 Windows 默认禁用 TLS 1.0/1.1;cipher 不匹配时服务器直接关闭连接。我方 **B3 per-connection TLS 降级**(`tlsMinVersion`/`tlsCiphers`/`legacyTls`)正是为此设计,作用域限单数据源、客户服务器零改动。

---

## 1. 版本兼容矩阵

| 版本 | TLS 1.2 原生? | 默认加密/握手 | 我方连接配置 | 真实可测? |
|---|---|---|---|---|
| **2008 R2** | 否(需补丁) | 常仅 TLS 1.0 / 老 cipher(AES-CBC-SHA) | `encrypt:true` + `trustServerCertificate:true` + **B3** `tlsMinVersion:'TLSv1'`(必要时 `legacyTls`/`tlsCiphers`) | 仅 Windows VM(无容器) |
| **2012** | 否(需补丁) | 同上;打了 TLS 1.2 补丁后可 1.2 | 同上;有 1.2 补丁则无需 B3 降级 | 仅 Windows VM |
| 2014 | 需补丁 | 打补丁后 TLS 1.2 | 标准 `encrypt:true`+`trust...`;未打补丁回退 B3 | 仅 Windows VM |
| 2016 | 是 | TLS 1.2 原生 | 标准 `encrypt:true`+`trustServerCertificate:true`(内网自签) | 仅 Windows(无官方 Linux 镜像 ≤2016) |
| 2017 / 2019 / 2022 | 是 | TLS 1.2 原生 | 标准默认 | ✅ Linux 容器(已 CI:`sqlserver-smoke.yml`) |

> **判读**:2016+ 走标准路径;**2008R2/2012(及未打补丁的 2014)是 B3 降级的真实用武之地**。降到连 TLS1.0 都谈不拢时,该源 `encrypt:false`(内网+审计)或隔离代理 sidecar 为最后手段(与 B3 互斥)。

---

## 2. Legacy smoke recipe(客户 Windows VM 上机械跑)

旧库需要 B3 TLS 降级旋钮,而 **ops 脚本 `smoke:sqlserver` 当前只暴露 `MSSQL_ENCRYPT`/`MSSQL_TRUST_SERVER_CERTIFICATE`,不暴露 B3 的 `tlsMinVersion`/`tlsCiphers`/`legacyTls`**(见 §3 缺口)。故 legacy 验证走**真实产品路径**(数据源 create 的 connection 配置支持 B3 旋钮)+ kit 的只读 smoke:

**步骤(在客户同网段、能连到 2008R2/2012 的机器上):**

1. **建只读数据源**(API/UI),`type:'sqlserver'`,connection 带 B3 旋钮:
   ```jsonc
   {
     "type": "sqlserver",
     "connection": {
       "server": "<legacy-host>", "database": "<db>",
       "encrypt": true, "trustServerCertificate": true,
       "tlsMinVersion": "TLSv1"        // 2008R2/2012:降 TLS 下限;必要时再加:
       // "legacyTls": true, "tlsCiphers": "<...:@SECLEVEL=0>"
     },
     "credentials": { "username": "<u>", "password": "<p>" },
     "options": { "readOnly": true }
   }
   ```
   > `tlsMinVersion`+`encrypt:false` **互斥**(同设即抛)。降级会 `emit('tls-downgrade')` 落 warn 审计。

2. **跑只读连通 smoke**(kit):
   ```powershell
   .\scripts\ops\validate-windows-runtime.ps1 -BaseUrl https://<host>:8900 -Token <tok> -DataSourceId <id>
   ```
   `Data-source read smoke` 项 PASS = 经 B3 降级的旧库**只读连通**成立(证据 = HTTP 200)。

3. **记录证据**:kit 的 pass/fail/evidence 表 + 是否触发 `tls-downgrade` 审计;若连不上,按 §1 降级树下一档(`legacyTls`/`tlsCiphers` → 末档 `encrypt:false`)。

> **2017+ 实例**:可直接用 `pnpm --filter @metasheet/core-backend smoke:sqlserver`(`MSSQL_HOST`/`MSSQL_USERNAME`/… + `MSSQL_ENCRYPT`/`MSSQL_TRUST_SERVER_CERTIFICATE`);它已被 `sqlserver-smoke.yml` 在 2019/2022 容器真测。

---

## 3. 已知缺口(follow-up,非本刀)

- ⬜ **`smoke:sqlserver` 未暴露 B3 legacy-TLS env**:`smoke-sqlserver.ts` 目前只映射 `encrypt`/`trustServerCertificate`,无 `MSSQL_TLS_MIN_VERSION`/`MSSQL_TLS_CIPHERS`/`MSSQL_LEGACY_TLS`。故 TLS-1.0-only 旧库无法直接经该 ops 脚本 smoke,需走 §2 的 API-create 路径。补这三个 env 映射是一个**小 follow-up**(test/ops 脚本,lock-safe),做了之后 legacy 也能一行命令 smoke。
- 🔒 **真实 2008R2/2012 验证**:需客户 Windows VM/快照;本矩阵只到协议级 + recipe。
