# C3 — Windows 原生运行时验证计划(代码可移植层已 CI 真证 · 环境层待客户主机)

> **配套**:设计稿 `data-sources-mssql-windows-deploy-design-20260527.md`(§Lane C / §5 权威)+ 部署 runbook `data-sources-mssql-windows-deploy-runbook-20260529.md`(档 C 部署步骤)。
> **范围**:设计稿把 C3 列为单条 🔒「Windows 原生运行时验证 pass」。本计划把它**拆成两层**,因为两层的可验证性根本不同:
> - **① 代码可移植层** —— backend 运行时本身在 Windows 上是否成立(路径/子进程/信号)。**可在 GitHub `windows-latest` 上真证,无需客户硬件 → 本刀已做。**
> - **② 环境集成层** —— PostgreSQL/Garnet|Memurai/nssm 服务化 + 端到端启动。**无法 CI,留作客户 Windows 主机的手动 checklist(§3,仍 🔒)。**

---

## 0. 结论速读

- **代码可移植层(本刀已闭环)**:backend 运行时(`node dist/src/index.js` + 其 import graph + 部署期 `migrate`)经审计为 Windows-clean,**仅两处** POSIX 假设,均已处理:
  - **C1**:`ScriptSandbox` workDir `'/tmp/sandbox'` → `path.join(os.tmpdir(),'sandbox')`(已合 **PR #2041**)。
  - **C3-code**:`ScriptSandbox` 两处 `spawn('python3')` → `resolvePythonBinary()`(平台感知 + `PYTHON_BIN` 逃生口)+ `executePython` error-path 临时文件 cleanup(**本刀**)。
  - **windows-latest CI lane**(本刀)在**真 Windows** 上证 workDir 解析 + python 解释器解析 + 真 wire 执行 + 缺失解释器的优雅失败。
- **环境集成层(仍 🔒)**:待客户 Windows 主机,逐项走 §3 手动 checklist。

---

## 1. 可移植性审计结果(纠正设计稿「唯一 /tmp/sandbox」说法)

设计稿 §Lane C 关键发现称运行时唯一 POSIX 假设是 `ScriptSandbox.ts` 的 `/tmp/sandbox`。**审计(全 `core-backend/src` + 已加载 plugins 包 + 部署期 `migrate`)证明该说法不完整** —— 完整清单:

| 类别 | 审计结果 |
|---|---|
| 硬编码 POSIX 绝对路径 | 仅 C1 的 `/tmp/sandbox`(已修);`uploads` 用 `process.env.STORAGE_PATH \|\| path.join(process.cwd(),'uploads')`(可移植);其余 `/`-拼接均为 **URL / S3 object key / metric label**,非文件系统路径 |
| 子进程 `spawn`/`exec` | 仅 `ScriptSandbox` 两处 `spawn('python3')`(`executePython` + `validateScript`,**已修**);plugins(`plugin-attendance` index.cjs、`plugin-integration-core` K3 executor 等)**0 spawn/exec** |
| 平台分支 | 仅 `process.platform` 作**诊断上报值**(health / isolation),无平台分支逻辑 |
| 权限 / 符号链接 | runtime 路径无 `chmod`/`symlink` 使用 |
| 信号 | `SIGTERM`/`SIGINT` 优雅停机(见 §4 服务停止语义) |

> 结论:除 C1 + C3-code 两处外,backend 运行时(含 plugins、uploads、migrate)在 Windows 上无其它已知阻断。

---

## 2. 代码可移植层 — `windows-latest` CI 证据(本刀)

- **workflow**:`.github/workflows/sandbox-windows-portability.yml`。**path-filtered**(仅 `sandbox/**` + `script-sandbox-*.test.ts` + 本 workflow 变化触发)、**targeted**(仅跑 `script-sandbox` portability vitest,**无 PG/Redis**、不跑全套)—— 不是全仓每 PR 的 Windows 大门。
- **证什么(在真 win32 上)**:
  1. workDir 派生自 `os.tmpdir()`(`script-sandbox-workdir.test.ts`)。
  2. `resolvePythonBinary('win32', undefined) === 'python'`(pure test,真 win32 执行)。
  3. **真 wire**:经解析出的解释器 `spawn` + 执行 python(`validateScript`)。`SANDBOX_REQUIRE_PYTHON=1` 强制该测试**不跳过**(缺 python 则硬失败,杜绝 skip-when-unreachable 假绿);`PYTHON_BIN` 指向 `setup-python` 解释器(确定性,且即档 C 推荐配置,见 §5)。
  4. **error path**:解释器缺失时优雅失败(不抛)+ 错误信息含解析出的 binary 名(便于 `PYTHON_BIN` 诊断)+ 临时 `.py` 不泄漏 —— 确定性,全平台跑(bogus binary 在哪都是 ENOENT)。

---

## 3. 环境集成层 — 手动验证 checklist(🔒 需客户 Windows 主机)

按 runbook **档 C** 部署后逐项验证(每项含 pass 判据):

- ⬜ **服务化**(nssm / node-windows):`node …/dist/src/index.js` 注册为服务 → 开机自启 + 崩溃重启生效。
- ⬜ **服务停止语义**(见 §4):停服务时进程优雅退出(连接/事务收尾)。
- ⬜ **PostgreSQL**(Windows 安装包):`DATABASE_URL` 连通;`migrate -- --list` 无 pending。
- ⬜ **Redis 替代**(Garnet / Memurai):`REDIS_HOST`/`REDIS_PORT` 连通;缓存读写正常。
- ⬜ **文件 / 路径**:`ScriptSandbox` workDir 落 `%TEMP%\sandbox` 可创建/写/清理;`uploads` 落 `<cwd>\uploads`。
- ⬜ **Python**(仅当用到 workflow Python 脚本节点):设 `PYTHON_BIN`(见 §5);`validateScript` 与 `executePython` 均通(executePython 双重缩进 bug 已修,见 §6)。
- ⬜ **Auth round-trip**:登录 → 带 token 调鉴权接口 → 200(**静默 401 = schema gap**,先查迁移)。
- ⬜ **数据源只读**:`GET /api/data-sources/:id/test` 通;SQL Server smoke(如已配)通。
- ⬜ **凭据加密**:`ENCRYPTION_KEY`/`ENCRYPTION_SALT` 稳定;服务重启后已存数据源仍可解密(decrypt fail-loud)。

---

## 4. 服务停止语义(SIGTERM —— P3,降级为说明非代码 bug)

- 主入口只监听 `SIGTERM`/`SIGINT`(`index.ts:2263-2264`)做 graceful shutdown。
- **native Windows 无 OS 级 `SIGTERM` 投递**;Windows 服务的停止由 nssm/node-windows 自身机制触发。
- 验证(归入 §3):用 nssm/node-windows 停服务时确认进程优雅退出;必要时配置服务管理器发送 Ctrl+C(→`SIGINT`)或其 graceful-stop。**非代码 bug**,无需改 `process.on('SIGTERM')`。

---

## 5. `PYTHON_BIN` 指南(Windows 服务 PATH 不可靠时)

- **默认**:win32 → `python`,posix → `python3`。
- Windows **服务**的 PATH 常与交互式 shell 不同(服务以受限账户/不同环境运行),bare `python` 可能找不到,或撞 Microsoft Store 启动器别名(不真正执行)。
- 故档 C 推荐**显式设 `PYTHON_BIN` 为 `python.exe` 绝对路径**(如 `C:\Python312\python.exe`)。`resolvePythonBinary` 的 `PYTHON_BIN` 优先级正是此逃生口。

---

## 6. 已知缺口(独立 follow-up,非本刀)

- ✅ **`executePython` 的 `wrapPythonScript` 双重缩进 bug —— 已修(独立小切片 PR,2026-05-29)**:模板行 `    ${...}` 已含 4 空格,而每行又 `map(line => '    ' + line)` 再加 4 空格 → 用户代码落 **8 空格缩进**于 4 空格的 `result = None` 之下 → 曾使**任何非空 python 脚本均 `IndentationError`**(`executePython` 端到端在所有平台不可用;`validateScript` 路径无 wrapper 不受影响)。修复 = 去掉模板插值行的多余 4 空格(由每行 `map` 提供唯一缩进)+ 补 e2e(`script-sandbox-python-portability.test.ts`:单行/多行/context/运行时错误,经真 python 证)。与 C3 可移植性正交,故按裁示作**独立切片**,不混 C3-env。
- 🔒 **2008R2 / 2012 真实验证**(需 Windows VM —— 无 Linux 容器)。
- 🔒 **B6 Windows 集成认证**(`authType:'windows'`,Kerberos/keytab/AD)。
