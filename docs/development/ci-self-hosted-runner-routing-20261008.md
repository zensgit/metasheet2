# 必需检查经 `MS2_PLUGIN_RUNNER` 切到自托管 runner

- 日期: 2026-10-08
- 基线: `origin/main` `804bb35a55c4b59a726c111a8c942bef9fd44f19`（2026-10-09 merge 对齐；上一基线 `8f90307d5a5c36c7b9958b88b0b8cf0d6f9110cb`，原先从 `9d65b8318f3d5cbc323b458cb5c96c2240a144f7` 开出）
- 参照: `afd32b704`（`ci(plugin-tests): route the test job through the MS2_PLUGIN_RUNNER variable`，#6247）
- 性质: Draft。只改必需检查的 `runs-on`。不合并。
- 2026-10-09 协调修订：移除与 #6272 重叠的 `web-tests.yml` 修改；前端由 #6272 独立使用 `MS2_WEB_RUNNER`，本 PR 不改它。
- 2026-10-09 对齐：merge `fc139c868`，不 rebase。main 上多出的 4 个提交没有改本 PR 路由的 8 个 workflow，merge 无冲突。
- 2026-10-09 再对齐：merge `9c34e1a002`，不 rebase。该提交只改审批前端 9 个文件，没有敏感路径，merge 无冲突。
- 2026-10-09 再对齐：merge `8f90307d5a`，不 rebase。`5a7e7897b` 改的是 `plugin-tests.yml`（本 PR 不改这个文件）和 decision-register；`8f90307d5a` 只加两份 stock-prep ADR。都没有碰到本 PR 的 8 个 workflow，merge 无冲突。
- 2026-10-09 再对齐：merge `804bb35a55`，不 rebase。`11a00d9ded` 与 `804bb35a55` 都没有敏感路径，merge 无冲突。Harold 同意对这 2 个无敏感路径的提交不重跑整套检查；push 仍会由 GitHub 自动触发 CI，本轮只做定向补验，不额外手动重跑。

`9d65b8318` 之后、合入前的 main 提交：

| SHA | 说明 | 敏感路径 |
|---|---|---|
| `7723d950d` | directory create-and-bind 对登录名规则返回 400 | 无 workflow、迁移、pins、drain、checkpoint、`vitest.config.ts`、timemachine |
| `64bf18b5e` | attendance-web-guard worker 超时 | 无 workflow。只改 `attendance-admin-regressions.spec.ts` 和一篇验证文档 |
| `65e8ee7c7` | 审批未读/结果角标，默认关 | workflow：`approval-realdb-list-scope.yml`、`approval-web-guard.yml`。`packages/core-backend/vitest.config.ts`。无迁移、pins、drain、checkpoint、timemachine |
| `fc139c868` | staging window smoke 打进 runner bundle | workflow：`attendance-staging-window-runner.yml`。无迁移、pins、drain、checkpoint、`vitest.config.ts`、timemachine |
| `9c34e1a002` | 审批人员字段显示名，不显示成员 id | 无。只改 `apps/web` 审批相关 9 个文件 |
| `5a7e7897b` | 迁移前重建 `metasheet_test`，`test` job 超时 150 分钟 | workflow：`plugin-tests.yml`（不是本 PR 改的 8 个文件）。decision-register。无迁移、pins、drain、checkpoint、`vitest.config.ts`、timemachine |
| `8f90307d5a` | stock-prep 项目备料表 ADR | 无。两份 ADR 文档 |
| `11a00d9ded` | 审批历史节点名 | 无。8 个审批相关文件和测试 |
| `804bb35a55` | dispatch loop 心跳证明改看 claim/renew 时间 | 无。只改 `multitable-automation-dispatch-loop-realdb.test.ts` |

这 3 个 workflow 与本 PR 改的 8 个文件不重叠。`9c34e1a002`、`5a7e7897b`、`8f90307d5a`、`11a00d9ded`、`804bb35a55` 也不碰这 8 个文件。

变量未设置时，表达式求值为 `ubuntu-latest`，与改前的托管 runner 相同。仓库变量 `MS2_PLUGIN_RUNNER` 设成一个自托管 runner 标签后，下面列出的 job 改到该标签。删掉变量即回到 `ubuntu-latest`。

表达式与已合入的 `test` job 相同，不另起变量:

```yaml
runs-on: ${{ vars.MS2_PLUGIN_RUNNER || 'ubuntu-latest' }}
```

GitHub Actions 里，未定义的 `vars.*` 是空字符串。空字符串在 `||` 上为假，所以未设置和设成空字符串都落到 `'ubuntu-latest'`。

## 1. 改了的 workflow / job

每个文件只加了一行注释，并把该 job 的 `runs-on` 换成上面的表达式。步骤、`env`（含 `EXPECT_DB`）、触发条件、矩阵、job id、`name:` 都没有改。

| 检查名 | workflow | job id | `runs-on` |
|---|---|---|---|
| `contracts (strict)` / `contracts (dashboard)` / `contracts (openapi)` | `.github/workflows/attendance-gate-contract-matrix.yml` | `contracts` | `:26` |
| `pr-validate` | `.github/workflows/phase5-validate.yml` | `pr-validate` | `:19` |
| `attendance-web-guard` | `.github/workflows/attendance-web-guard.yml` | `attendance-web-guard` | `:274` |
| `integration-guard` | `.github/workflows/integration-guard.yml` | `integration-guard` | `:350` |
| `ssh host-key pin contract (fail-closed known_hosts)` | `.github/workflows/ssh-hostkey-pin-contract.yml` | `contract`（`name:` 在 `:42`） | `:44` |
| `observation-kit contract (read-only SQL census + runbook gating)` | `.github/workflows/multitable-o2-observation-kit.yml` | `contract`（`name:` 在 `:57`） | `:59` |
| `recovery-schema-drift` | `.github/workflows/multitable-recovery-schema-drift.yml` | `recovery-schema-drift`（`name:` 在 `:56`） | `:58` |
| `Approval browser verify (chromium)` | `.github/workflows/approval-browser-verify.yml` | `browser-verify`（`name:` 在 `:37`） | `:39` |

`test (20.x)` 已在 `afd32b704` 接上同一表达式，本 PR 没有再改 `.github/workflows/plugin-tests.yml`。确认位置: job id `test`，`runs-on` 在 `.github/workflows/plugin-tests.yml:134`，矩阵 `node-version: [20.x]`（`:146`）。检查名仍由 job id 加矩阵值组成，是 `test (20.x)`。

## 2. 没改的 workflow，以及原因

### 2.1 明确不动

| workflow | 原因 |
|---|---|
| `.github/workflows/web-tests.yml` | 由 #6272 独立路由到 `MS2_WEB_RUNNER`。本 PR 保持基线文件不变，避免两个 PR 对同一 job 选择不同变量。 |
| `.github/workflows/stock-prep-powershell51.yml` | 检查名 `stock-prep PowerShell 5.1 acceptance`（job id `stock-prep-powershell51`，`name:` `:43`，`runs-on: windows-latest` `:44`）。要 Windows PowerShell 5.1。整文件是 provenance 哈希输入 `evidenceFiles.s6aPowershell51Workflow`（`plugins/plugin-integration-core/lib/sealed-export/sealed-export-package-provenance.cjs:307-311`）。Linux 标签带不动这个 job。 |
| `.github/workflows/sealed-export-s5-sqlserver.yml` | 不在本次必需检查名单里。整文件是哈希输入 `evidenceFiles.s5EvidenceWorkflow`（同文件 `:254-258`）。本 PR 不改它，pin 不动。 |

本次改动的 8 个 workflow 都不在 `PINNED_EVIDENCE_FILES` / `PINNED_RUNTIME_FILES` 里。`plugin-tests.yml` 在 pin 范围收窄之后不再是哈希输入（provenance 模块 `:297-306`）。

### 2.2 同一 workflow 里其它 job 保持 `ubuntu-latest`

`.github/workflows/plugin-tests.yml` 里除 `test` 以外:

| job id | 检查名 | `runs-on` |
|---|---|---|
| `dingtalk-p4-ops-regression-gate` | `DingTalk P4 ops regression gate` | `:30` |
| `k3wise-offline-poc` | `K3 WISE offline PoC` | `:57` |
| `after-sales-integration` | `after-sales integration` | `:2014` |
| `coverage` | `coverage` | `:2132` |

这四个不是 `test (20.x)`。`coverage` 在 `pull_request` 上 `needs: test`，仍申请 `ubuntu-latest`。托管额度被拒时，这个非必需 job 仍会 0 步失败；它不在本次要改的必需检查里。

### 2.3 名单之外、可以以后再接、这次不接

- `.github/workflows/multitable-o2-observation-kit-realdb.yml` 的执行证明 job。必需的是上面的 hermetic contract。这条 realdb lane 有自己的 `services` Postgres，而且带路径过滤，不是本次点名的检查。
- 其余仍写死 `ubuntu-latest` 的 workflow（部署、夜间、prod 远端、冒烟等）都不是本次点名的必需检查。

没有因为「跑不了」而从名单里拿掉的 job。下面第 3 节的前提满足时，第 1 节的 job 都可以接到自托管 runner。前提不满足时，失败会出在具体步骤（缺 `pwsh`、缺 Docker、`sudo` 要密码），变量仍可立刻删掉。

## 3. 每个 job 对 runner 的依赖

共同前提: Linux。`runs-on` 收到的是一个标签字符串，不会拆逗号，也不会把 JSON 数组展开。runner 要能出站访问 GitHub（checkout、`setup-node`、`pnpm/action-setup`、`actions/cache`）和 npm registry。

### 3.1 `contracts`（strict / dashboard / openapi）

- 矩阵 `case_id: [strict, dashboard, openapi]` 没动，所以三个检查名不变。
- Node 20（`actions/setup-node@v4`，`:41-45`），pnpm 9（`pnpm/action-setup@v4`，`:36-39`）。依赖缓存走 `setup-node` 的 `cache: 'pnpm'`，不另写 `actions/cache`。
- 脚本调用系统 `python3`（标准库）和 `jq`。workflow 自己不安装它们。托管镜像里两者都有；自托管镜像要预装。
- 无 `services:`，无 Playwright，无 `sudo`，无仓库 secret。`permissions: contents: read`。

### 3.2 `pr-validate`

- 多数 PR 上 `METRICS_URL` 为空时，probe 步写完 summary 就结束，后面的 Node 安装被 `if:` 跳过。
- secret 在 `.github/workflows/phase5-validate.yml:28-29`：`METRICS_URL`、`METRICS_AUTH_HEADER`。这是本次接过去的必需 job 里，唯一读取仓库 secret 的 job。值会进该 job 的环境。第 6 节。
- secret 有值时才装 Node **18.x**（`:48-51`）、用 corepack 装 pnpm `10.16.1`，并用 `curl` 探活、`jq` 读结果。无 `services:`，无 Playwright，无 pnpm store cache。
- workflow 没有 `permissions:`，`GITHUB_TOKEN` 用仓库默认权限。

### 3.3 `test (20.x)`（已接上，这里只记录 runner 要备的东西）

- Node `20.x`，pnpm `10.16.1`，`actions/cache@v4` 缓存 pnpm store（`:669`）。
- `pnpm type-check` 设置 `NODE_OPTIONS: --max-old-space-size=4096`（`:871`），给 `vue-tsc`。`apps/web/package.json` 的 `build` / `type-check` 同样把 `vue-tsc` 的堆设成 4096（`:8`、`:13`）。私有仓库的托管 runner 是 2 vCPU / 8 GB，默认堆大约 2 GB 时 `vue-tsc` 会 OOM（该步注释 `:866-870`）。
- `:639` 起有 `shell: pwsh` 的步骤。托管 Ubuntu 镜像自带 PowerShell 7。自托管机器的 `PATH` 上要有 `pwsh`。
- `:1082` 的 `ankane/setup-postgres@v1`（Postgres 14）通过系统包管理器安装数据库，Ubuntu 上需要免密 `sudo`。这是装到 runner 上的 Postgres，不是 `services:` 容器。
- `integration-guard` 契约测试在 `pnpm install` 之前用系统 `python3` + PyYAML（`scripts/ops/integration-guard-required-wiring-contract.test.mjs:209-214`）。缺解释器或 PyYAML 会 fail-closed。Ubuntu 包名是 `python3-yaml`。
- `test` job 不引用仓库 secret。同文件 `:2169` 的 `secrets.GITHUB_TOKEN` 在 `coverage` job，那个 job 仍在 `ubuntu-latest`。

### 3.4 `web-tests`

由 #6272 验证并使用 `MS2_WEB_RUNNER`；不属于本 PR 的路由改动。

### 3.5 `attendance-web-guard`

- 分类器判定无关改动时，只做 checkout 和 `git diff`。
- 判定相关时: Node `20.x`，pnpm `10.16.1`，`actions/cache@v4`（`:445`）。目标 vitest 步把堆设成 8192（`:463`）。
- `:468` `pnpm exec playwright install --with-deps chromium`。`--with-deps` 在 Ubuntu/Debian 上走 `sudo apt`。需要免密 `sudo`，以及 apt 能装 Playwright 的系统库。
- 无 `services:`，无仓库 secret。无 `permissions:`。

### 3.6 `integration-guard`

- 每次都跑（不看分类结果）的契约步在 `pnpm install` 之前调用系统 `python3` + PyYAML，和 `test (20.x)` 同一座桥。runner 要预装 `python3-yaml`。
- 分类为相关时: pnpm `10.16.1`，`actions/cache@v4`（`:575`），再跑 plugin-integration-core 链和 web specs。
- 无 `services:`，无 Playwright，无 `sudo`，无仓库 secret。无 `permissions:`。

### 3.7 `ssh host-key pin contract (fail-closed known_hosts)`

- checkout + `setup-node` 20 + `node --test`。无 pnpm、无缓存、无 Docker、无 Playwright、无 `sudo`、无仓库 secret。
- `permissions: contents: read`。超时 5 分钟。

### 3.8 `observation-kit contract (read-only SQL census + runbook gating)`

- 与上一节同形: checkout + Node 20 + `node --test`。无 pnpm、无仓库 secret。`permissions: contents: read`。
- workflow 头注释里的 Docker golden 由环境变量单独打开。本 job 不设置那些变量，golden 在这条必需检查里跳过。这条检查不要求 Docker。realdb 那条 lane 本次不改。

### 3.9 `recovery-schema-drift`

- `services.postgres`，镜像 `postgres:16`（`:60-62`）。GitHub 的 service container 要求 runner 是 Linux，并且 runner 用户能用本机 Docker。没有 Docker 时，这个 job 起不来。
- Node `20.x`，pnpm `10.16.1`。这个 job 没有 `actions/cache`。
- `env` 原样保留，包括 `EXPECT_DB`。步骤里没有 `sudo apt`。本地服务口令写在 workflow 里，供本机容器使用，不是 GitHub secret。
- `permissions: contents: read`。runner 要能拉取 `postgres:16` 镜像。

### 3.10 `Approval browser verify (chromium)`

- 无关改动时只做 checkout 和分类。
- 相关时: Node `20.x`，pnpm `10.16.1`，`actions/cache@v4`（`:132`）。
- `:149` `pnpm exec playwright install --with-deps chromium`，同样要 Ubuntu/Debian 上的免密 `sudo` 和 apt。
- 类型检查走 `type-check:verification-approval`（`apps/web/package.json:14`），这条脚本本身不加 4096 堆。`vue-tsc` 的 4096 堆在 `test (20.x)` 的 `pnpm type-check` 和 `apps/web` 的 `build` / `type-check`。
- 无 `services:`，无仓库 secret。无 `permissions:`。

## 4. 自托管 runner 最低要求

一台 Linux runner（Ubuntu 或 Debian，这样 apt 路径和托管镜像一致）同时接这些 job 时:

| 项 | 要求 |
|---|---|
| OS | Linux。`recovery-schema-drift` 的 service container 不能跑在 Windows/macOS runner 上。PowerShell 5.1 那条检查仍要 Windows，而且不走这个变量。 |
| Docker | 装好，runner 用户能访问 Docker socket。只为 `recovery-schema-drift` 的 `services.postgres`（`postgres:16`）。 |
| Node | 20。各 job 用 `actions/setup-node` 下载。`pr-validate` 在 metrics secret 有值时另要 Node 18。 |
| pnpm | 由 action 安装：`contracts` 用 9，其余用 `10.16.1`。不要求事先装好，但要能下载 action 和 registry。 |
| Playwright | `attendance-web-guard` 与 `Approval browser verify (chromium)` 在相关改动上执行 `playwright install --with-deps chromium`。免密 `sudo`，apt 可用。 |
| 内存 | `vue-tsc` 在 `test (20.x)` 使用 4096 MB 堆（`.github/workflows/plugin-tests.yml:871`）。`attendance-web-guard` 的 vitest 和 `web-tests` 脚本里的一条 vitest 使用 8192 MB 堆。物理内存要大于该步申请的堆，再加系统和其他进程。8 GB 的私有托管规格已经让默认堆的 `vue-tsc` OOM 过。 |
| 预装命令 | `git`、`bash`、`curl`、`jq`、`python3`、`python3-yaml`（PyYAML）、`pwsh`（PowerShell 7，给 `test` job 的 `shell: pwsh`）。`test` job 安装 Postgres 14 时还要免密 `sudo`。 |
| 磁盘 | pnpm store、Playwright 浏览器、Postgres 数据目录、`postgres:16` 镜像。job 之间不要复用脏的工作目录。 |

标签建议单独做一个，例如只加在这台机器上的标签，变量的值就写这一个标签。写成 `self-hosted` 时，仓库里每一个带该默认标签的 runner 都可能领到这些 job。

## 5. 注册 runner 和设置变量

1. 打开仓库 `zensgit/metasheet2` 的 Settings → Actions → Runners → New self-hosted runner，选 Linux x64。
2. 按页面给出的命令在机器上安装并注册。注册令牌是一次性的，不要写进仓库、PR 或日志。
3. 需要单独标签时，在配置命令里加上该标签。先装好第 4 节的包，再打开变量。
4. Settings → Secrets and variables → Actions → Variables → New repository variable。名称必须是 `MS2_PLUGIN_RUNNER`。值是一个 runner 标签。这是 Actions 变量，不是 secret，也不是 workflow 里的 `env`。
5. 之后的 workflow 运行会读到新值。已经在排队、并且 `runs-on` 已经求值成 `ubuntu-latest` 的 run 不会改道。

变量未设置时，这些 job 仍向 GitHub 托管 runner 要机器。托管额度被拒时，它们继续 0 步失败。本 PR 只打开开关，不代替额度。

## 6. 回退

删除仓库变量 `MS2_PLUGIN_RUNNER`。下一个 run 的 `runs-on` 回到 `ubuntu-latest`。不需要 revert 本 PR。把变量设成空字符串效果相同。把变量设成 `ubuntu-latest` 也会回到托管 runner，但删除变量是默认回退。

这个变量一次管第 1 节的全部 job，外加已经接上的 `test`。`web-tests` 不在本 PR 内；#6272 使用独立的 `MS2_WEB_RUNNER`，不受此变量回退影响。

## 7. 安全

- 仓库已是私有。同一仓库里的 pull request 会用 PR 头上的 workflow 文件在 runner 上执行。runner 上因此会跑 PR 带来的步骤。
- 每个 job 都有作业期内的 `GITHUB_TOKEN`。`contracts`、ssh host-key、observation-kit、`recovery-schema-drift` 写了 `permissions: contents: read`。`pr-validate`、`web-tests`、`attendance-web-guard`、`integration-guard`、`Approval browser verify`、`plugin-tests` 没有 `permissions:`，token 范围等于仓库的默认 `GITHUB_TOKEN` 权限。
- `pr-validate` 会把仓库 secret `METRICS_URL` 和 `METRICS_AUTH_HEADER` 注入步骤环境（`.github/workflows/phase5-validate.yml:28-29` 和校验步）。secret 有值时，自托管 runner 能在该 job 里读到它们。不要把这个 runner 放在存有生产凭据、部署私钥或客户数据的机器上。
- 优先用 ephemeral runner，或在每个 job 结束后清掉工作目录和浏览器缓存。自托管磁盘会留下来，托管 runner 不会。
- runner 只出站连接 GitHub。不要把监听端口暴露到网络上。
- 变量的值是标签，不是凭据。不要把口令写进 `MS2_PLUGIN_RUNNER`。
- 外部写、客户生产库、K3 写回都不在这些检查里打开。本 PR 不新增 env flag。

## 8. 本地验证

工作树相对 `9d65b8318`，只含这 8 个 workflow 的 `runs-on`（加一行注释）和本文。`web-tests.yml`、`s6a-package-provenance-pins.json`、`stock-prep-powershell51.yml`、`sealed-export-s5-sqlserver.yml` 都不在 diff 里。

检查名: 用 PyYAML 解析 HEAD 与工作树。每个被改 workflow 的 job id、`name:`、矩阵、以及由此得到的检查名与 HEAD 一致。除 `runs-on` 外，解析后的文档结构一致。`plugin-tests.yml` 的五个检查名也一致，其中 `test` 的 `runs-on` 在 HEAD 上已经是同一表达式。

| 检查名（改前 = 改后） |
|---|
| `contracts (strict)` |
| `contracts (dashboard)` |
| `contracts (openapi)` |
| `pr-validate` |
| `test (20.x)` |
| `web-tests` |
| `attendance-web-guard` |
| `integration-guard` |
| `ssh host-key pin contract (fail-closed known_hosts)` |
| `observation-kit contract (read-only SQL census + runbook gating)` |
| `recovery-schema-drift` |
| `Approval browser verify (chromium)` |
| `stock-prep PowerShell 5.1 acceptance`（未改，`windows-latest`） |

初始版本的 actionlint 1.7.7 对当时 9 个路由文件、`plugin-tests.yml`、`stock-prep-powershell51.yml` 退出码 0。协调修订需重新校验剩余 8 个路由文件及未变的前端文件。

pins: `computePackageProvenancePinSet` 对冻结清单逐叶比较，不一致 0 条。冻结清单与现场重算都是 63 个 SHA-256、66 个叶子字段。

```text
node plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs
sealed-export-package-provenance.test.cjs OK
```

2026-10-09 协调修订复核：8 个 workflow 解析后仅 `runs-on` 不同，触发条件、步骤、条件、矩阵和检查名全部保持；`web-tests.yml` 与基线逐字节相同。actionlint 1.7.12 的 workflow 检查（不运行 shellcheck）通过；带 shellcheck 的完整检查有 12 条既有诊断，与基线逐项相同，新增 0 条，不声称完整 lint 全绿。integration-guard 接线契约及全局 flag manifest 测试合计 99/99，package-provenance 测试通过。远端 CI 需以修订后 SHA 重新验证。

2026-10-09 对齐 `fc139c868` 之后再算一次：`computePackageProvenancePinSet` 与冻结清单不一致 0 条。冻结清单与现场重算都是 63 个 SHA-256、66 个叶子字段。`node plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs` 输出 `sealed-export-package-provenance.test.cjs OK`。

2026-10-09 对齐 `9c34e1a002` 之后再算一次：不一致仍是 0 条，63 个 SHA-256、66 个叶子字段。同一 provenance 测试输出 `sealed-export-package-provenance.test.cjs OK`。

2026-10-09 对齐 `8f90307d5a` 之后再算一次：不一致仍是 0 条，63 个 SHA-256、66 个叶子字段。同一 provenance 测试输出 `sealed-export-package-provenance.test.cjs OK`。

2026-10-09 对齐 `804bb35a55` 的定向补验：相对新 main 的文件仍是这 8 个 workflow 加本文，与对齐前相对 `8f90307d5a` 的文件清单相同；8 个 workflow blob 与对齐前 head 逐字节相同。PyYAML 解析后，除 `runs-on` 外文档结构一致，检查名不变。文本 diff 每个文件只多一行注释并把 `runs-on: ubuntu-latest` 换成同一表达式。actionlint 1.7.7 对这 8 个文件（`-shellcheck=`）退出码 0。pins 不一致 0 条，63 个 SHA-256、66 个叶子字段。provenance 测试输出 `sealed-export-package-provenance.test.cjs OK`。Harold 同意对这 2 个无敏感路径的提交不重跑整套检查。
