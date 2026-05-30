# 外接数据源 + SQL Server 连接器 — 部署 runbook(A/B/C 三档)

> **范围**:本 runbook 对应设计稿 Lane C 的 **C2**(A/B/C 三档部署操作手册)。配套 **C1**(`ScriptSandbox` workDir `/tmp/sandbox` → `os.tmpdir()`,去掉运行时唯一的 POSIX 假设)在同一刀落地。**C3**(Windows 原生运行时验证)仍 **🔒 未验证** —— 见 §7。
> **权威设计稿**:`docs/development/data-sources-mssql-windows-deploy-design-20260527.md`。本 runbook 只讲"**怎么部署**";为什么三档都可行、治理/裁示/降级决策树看设计稿 §0/§1/§5。
> **承袭原则**(设计稿 §1):① 对客户数据源**零改动、零风险**;② **只读优先**(MVP 强制,框架级);③ **适配器与部署形态解耦** —— 连 SQL Server 的能力**不依赖后端跑在哪**(A/B/C 三档对 Lane B 连接能力无影响)。

---

## 0. 为何三档都可行(关键事实)

- 生产启动即 `node packages/core-backend/dist/src/index.js`(见 `Dockerfile.backend` CMD),**不 spawn 任何 shell 脚本**(仓库 `.sh` 全是 CI/部署/开发工具,非运行时)。
- `src` 内**唯一**的运行时 POSIX 假设是 `ScriptSandbox.ts` 的 workDir 默认值 `'/tmp/sandbox'` —— **本刀 C1 已改为 `path.join(os.tmpdir(),'sandbox')`**,原生 Windows 落 `%TEMP%\sandbox`,不再有 `/tmp` 依赖。
- `pg` / `redis` / `mssql(tedious)` 驱动**纯 JS,无原生编译** → 不挑 OS/CPU。
- 因此"原生 Windows 跑"成本远低于初估;**唯一真麻烦是依赖侧的 Redis**(见 §5)。

依赖侧:后端需 **PostgreSQL** + **Redis**。Postgres 三档都有现成形态;Redis 在原生 Windows 无官方版,故 C 档需替代实现(§5)。

---

## 1. 选档决策(A > B > C)

| 档 | 形态 | 移植代价 | 适用客户 |
|---|---|---|---|
| **A(首选)** | 客户给一台**同网段 Linux VM**,跑现有镜像 / `docker-compose.app.yml` | **零移植** | 能给内网 Linux VM |
| **B** | **Windows + Docker/WSL2**,`docker compose` 起 app+PG+Redis | 客户需接受 Docker(注意 Docker Desktop 企业授权) | 允许 Docker/WSL2 |
| **C(兜底)** | **全原生 Windows**:Node 注册为 Windows 服务 + PostgreSQL Windows 安装包 + Garnet/Memurai 替代 Redis | C1(本刀已修)+ 一次 Windows 运行时验证(C3,🔒)+ 引入 Garnet/Memurai | Windows 且**禁** Docker |

> 选档只看**客户 IT 接受度**,与"能不能连客户的 SQL Server"无关 —— 后者三档一致。**先问两件事**:① 客户能否给内网 Linux VM?能 → A。② 否则,允许 Docker/WSL2 吗?允许 → B,不允许 → C。

---

## 2. 通用前置(三档共用)

### 2.1 构建产物 / 镜像
- 镜像:`ghcr.io/${IMAGE_OWNER:-zensgit}/metasheet2-backend:${IMAGE_TAG}` + `…/metasheet2-web:${IMAGE_TAG}`(`pnpm docker:build` 本地构建,或从 ghcr 拉)。
- 原生(C 档):`pnpm install && pnpm --filter @metasheet/core-backend build`(`tsc` → `dist/`),启动 `node packages/core-backend/dist/src/index.js`。

### 2.2 必备环境变量(`docker/app.env` 或 Windows 服务环境)
| 变量 | 用途 | 备注 |
|---|---|---|
| `DATABASE_URL` | Postgres 连接串 | 三档必填 |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` | Redis/RESP 连接 | 见 `docker/app.env`(默认 `redis:6379`);C 档指向 Garnet/Memurai 的 host:port |
| `PORT` | 后端监听端口 | 默认 8900 |
| `JWT_SECRET` | 鉴权签名密钥 | **每环境独立**;变更会令旧 token 401 |
| **`ENCRYPTION_KEY`** | **数据源凭据落库加密主密钥(A1)** | **必须稳定 + 备份**:凭据以 AES-256-GCM 落库,`ENCRYPTION_KEY` 变更后解密**失败即抛**(`DataSourceManager` decrypt fail-loud),已存数据源不可用 |
| `ENCRYPTION_SALT` | 凭据加密 salt(A1) | 同上,稳定 + 备份 |

> ⚠️ **A1 凭据加密红线**:`ENCRYPTION_KEY`/`ENCRYPTION_SALT` 一旦丢失/变更,**所有已落库数据源凭据无法解密**。三档部署都必须把这两个值纳入密钥备份流程,不能只写在临时 env 里。

### 2.3 数据库迁移(部署 SOP — 不可跳)
- 执行:`pnpm --filter @metasheet/core-backend migrate`(= `tsx src/db/migrate.ts`,支持 `--list` / `--rollback`)。
- **镜像拉取式部署必须先 diff 待跑迁移**,部署后**验证一次 auth round-trip**:部署后**静默 401 通常是 schema gap(迁移没跑全),不是 `JWT_SECRET` 错** —— 见部署 SOP。

### 2.4 数据源连接默认(承袭 Lane A/B,三档一致)
- `readOnly` **默认 `true`**(框架级双层:路由级 SELECT-only 分类器 + 适配器层 `assertWritable`)—— MVP 只暴露读路径,写能力解禁是后续独立闸。
- SQL Server 源默认 `encrypt=true` + `trustServerCertificate=true`(线缆始终加密 + 信任内网自签证书;PR1 #1985 既定)。
- 老库握手不拢时,用 **B3 per-source TLS 降级旋钮**(`tlsMinVersion` / `tlsCiphers` / `legacyTls`)—— **仍加密**,作用域限该源,客户服务器零改动;与 `encrypt:false` 互斥(同设即抛),降级落 `tls-downgrade` 审计 + warn。

---

## 3. 档 A — 客户 Linux VM(首选,零移植)

1. **VM 要求**:与客户 SQL Server **同网段可达**;装 Docker + docker compose(或直接跑镜像)。
2. **放置** `docker-compose.app.yml` + `docker/app.env`(按 §2.2 填),`docker/nginx.conf`。
3. **拉镜像 / 构建**:`IMAGE_TAG=<tag> docker compose -f docker-compose.app.yml pull`(或 `pnpm docker:build` 后本地 tag)。
4. **起依赖 + 应用**:`IMAGE_TAG=<tag> docker compose -f docker-compose.app.yml up -d`(postgres:15 + redis:7 + backend@`127.0.0.1:8900` + web@`8081`,PG/Redis 带 healthcheck,backend `depends_on` 健康)。
5. **迁移**:进 backend 容器或用同镜像跑 `migrate`(§2.3),diff 待跑迁移。
6. **冒烟**:auth round-trip(§2.3);若已配 SQL Server 源,跑 §6 的只读连通冒烟。

## 4. 档 B — Windows + Docker/WSL2

与档 A **完全相同的 compose 与命令**,差异仅在宿主 OS:
1. 前提:客户 Windows 上装 **Docker Desktop**(注意企业授权)或 **WSL2 + Docker Engine**。
2. 其余步骤同 §3(同一 `docker-compose.app.yml`)。
3. 卷路径:compose 用 named volume(`metasheet-postgres-data` 等),Windows + Docker 下由 Docker 管理,无需手改路径。

> B 档本质是"把 A 档的 Linux 容器跑在 Windows 的 Docker 里",故移植代价仍≈零;真正的成本是**客户是否接受 Docker**。

## 5. 档 C — 全原生 Windows(兜底;⚠️ C3 🔒 未验证)

> **状态标注(勿当已签收)**:C1(workDir 可移植)**本刀已落**;但 **C3(Windows 原生运行时整体验证)仍 🔒 未做** —— 路径/文件操作/服务化/PG+Garnet/Memurai 连通**未在真实 Windows 上跑通过**。本节是**设计 + 已修可移植性**的部署指引,**不是已验证的签收路径**。真实落 C 档前必须先完成 §7 的 C3。

1. **Node 运行时**:装 Node ≥18;`pnpm --filter @metasheet/core-backend build` 出 `dist/`。
2. **注册为 Windows 服务**:**推荐默认 `nssm`**(`node-windows` 为附录/备选,见研究文档)把 `node packages/core-backend/dist/src/index.js` 注册为服务(开机自启、崩溃重启);服务环境注入 §2.2 的全部变量。可用 kit 的 `-RegisterService`(显式 opt-in)机械化此步。
3. **PostgreSQL**:用 PostgreSQL 官方 **Windows 安装包**;`DATABASE_URL` 指向它。
4. **Redis 替代(C 档关键)**:Windows 无官方原生 Redis → 用 **RESP 兼容的 OSS 实现作推荐默认 / 商业实现作备选**(具体选型 + 许可证见 `docs/research/windows-deploy-oss-references-20260529.md`,并**先核实后端实际用到的 Redis 命令落在所选实现的支持集内**)。后端 `REDIS_HOST`/`REDIS_PORT` 指向其监听地址即可,**应用侧无需改代码**。
5. **沙箱临时目录**:C1 后 `ScriptSandbox` 默认落 `%TEMP%\sandbox`(`os.tmpdir()`),无需手配。
6. **迁移 + 冒烟**:`pnpm --filter @metasheet/core-backend migrate`(§2.3)+ §6 验证。

---

## 6. 部署后验证(三档共用)

> **机械化(C3-env validation kit)**:本节探测可由 `scripts/ops/validate-windows-runtime.ps1` 一键跑出 **pass/fail/evidence**(**默认只读探测、零改动**;安装 / 服务注册 / 写系统环境变量需显式 `-Install` / `-RegisterService` opt-in)。带 `-BaseUrl -Token -DataSourceId` 时,下面第 2/3 项的鉴权 + 数据源只读 smoke 也一并机械跑。kit 是**验证器,不是一键安装器**——不会擅自固化客户环境。

1. **迁移完整性**:`migrate --list` 确认无 pending;部署 SOP 的 migration-pending diff。
2. **Auth round-trip**:登录 → 带 token 调一个鉴权接口 → 200。**静默 401 = schema gap**,回查迁移,别先怀疑 `JWT_SECRET`。
3. **数据源只读连通**:对已配置的 SQL Server 源调 `GET /api/data-sources/:id/test`(鉴权 `data_sources:read`)—— 失败时响应 `data.error.message` 会带**已脱敏**的错因(A3:`password`/`token` 等不出现在 response/log)。
4. **SQL Server 真连通冒烟(可选,需真实库)**:配 `MSSQL_HOST`/`MSSQL_SERVER` 等后跑
   `pnpm --filter @metasheet/core-backend smoke:sqlserver`
   (B5A:**只读**,无 `MSSQL_HOST`/`MSSQL_SERVER` 时 **exit 0 跳过**;覆盖 connect/select/OFFSET-FETCH/schema-qualified `[schema].[table]`)。
   **绝不**在客户库跑 `smoke:sqlserver:seed`(写库,仅 CI,需 `MSSQL_SEED_ALLOW_WRITE=true`)—— 承袭"对客户数据源零改动"。

---

## 7. 已知缺口 / 仍 gated(执行期回填)

| 项 | 状态 | 说明 |
|---|---|---|
| **C3 Windows 原生运行时验证** | 🔒 未做 | 走 C 档前必须验:路径/文件操作(含 `%TEMP%\sandbox`)、Node-as-service、PG + RESP 缓存连通、端到端只读拉数。**需 Windows VM/快照**,本预算未含。**机械化跑证据 = C3-env validation kit**(`scripts/ops/validate-windows-runtime.ps1`,§6);判读细项见 `data-sources-windows-c3-validation-plan-20260529.md`。 |
| **2008R2 / 2012 真实验证** | ⬜ follow-up | B4 已覆盖 2019/2022 真容器;2008R2/2012 是 Windows-only 二进制无 Linux 容器,真实验证需 **Windows VM**。兼容矩阵 + legacy smoke recipe(B3 TLS 降级)见 `data-sources-windows-2008r2-2012-compat-matrix-20260529.md`(**只到协议级 + recipe,不承诺 CI/本机验证**)。 |
| **B6 Windows 集成认证** | 🔒 独立切片 | `authType:'windows'`(Kerberos/keytab/AD)未做;本期连接器只支持 `authType:'sql'`。 |
| **共享 workDir 跨实例** | ⬜ 观察项 | C1 只改 base path(`/tmp/sandbox` → `os.tmpdir()/sandbox`),**语义不变**:多个 `ScriptSandbox` 实例仍共享同一 `<tmpdir>/sandbox`,`cleanup()` 递归删该目录。per-instance 隔离不在 C1 范围,留作后续独立项(非本刀引入)。 |

> **执行期仍待确认**(设计稿 §5):客户 SQL Server 具体版本、客户能否给 Linux VM / 是否允许 Docker/WSL2 —— 这三点决定最终落 A/B/C 哪档。

---

## 附录:命令速查

```bash
# 构建镜像(A/B)
pnpm docker:build                                              # 出 metasheet-backend / metasheet-web 镜像

# 起 / 停(A/B,生产 compose)
IMAGE_TAG=<tag> docker compose -f docker-compose.app.yml up -d
docker compose -f docker-compose.app.yml down

# 迁移(三档)
pnpm --filter @metasheet/core-backend migrate                  # 跑迁移
pnpm --filter @metasheet/core-backend migrate -- --list        # 看 pending

# 原生 Windows 启动(C)
pnpm --filter @metasheet/core-backend build                    # tsc → dist
node packages/core-backend/dist/src/index.js                   # 由 nssm/node-windows 包成服务

# SQL Server 只读连通冒烟(B5A;无 MSSQL_HOST/SERVER 自动跳过)
MSSQL_HOST=<host> MSSQL_USERNAME=<u> MSSQL_PASSWORD=<p> MSSQL_DATABASE=<db> \
  pnpm --filter @metasheet/core-backend smoke:sqlserver
```
