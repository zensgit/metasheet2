# 钉钉收尾合同与目录 CI 接线合同进入必需检查

状态：开发候选。只改 `.github/workflows/plugin-tests.yml` 的 `contracts` job 与并行合同 `scripts/ops/plugin-tests-parallel-contract.test.mjs`；不改分支保护，不改冻结基线 `scripts/ops/fixtures/plugin-tests-serial-baseline-20261030.json`，不改 `k3wise-offline-poc` job 的任何步骤。

## 背景

下列八个 node:test 套件此前只在 `k3wise-offline-poc` job 里运行。该 job 的检查名「K3 WISE offline PoC」不是 main 的必需检查，所以它变红不会挡住合并；这些套件实际上只是文档，不是门。`contracts` job 经 `test` 汇总 job 进入必需检查 `test (20.x)`，并且已有同类先例（docker-gc 主机身份合同、钉钉 OAuth-stability workflow 合同（随生产就绪清单那一步运行）、K3 演练驱动合同、目录 deprovision-ledger 与 activation-source-lock 接线合同）从该 job 复制到 `contracts`。

## 改动

`contracts` job 新增两步，均不带 `if:`，不带 `continue-on-error`：

1. 紧接 `id: dingtalk-production-readiness-inventory-contract` 那一步之后，`DingTalk closeout env and OAuth-stability contracts (required lane)`：
   - `scripts/ops/dingtalk-closeout-env-contract.test.mjs`
   - `scripts/ops/dingtalk-oauth-stability-metrics-auth-contract.test.mjs`
   - `scripts/ops/dingtalk-oauth-stability-metrics-only-contract.test.mjs`
   - `scripts/ops/dingtalk-oauth-stability-metrics-only-fullscript.test.mjs`
   - `scripts/ops/github-dingtalk-oauth-stability-summary.test.mjs`
2. 紧接 `Directory activation source-lock CI-wiring contract (required lane)` 那一步之后，`Directory grant-table, deprovision-writer and access-graph-mutex CI-wiring contracts (required lane)`：
   - `scripts/ops/directory-grant-table-ci-wiring.test.mjs`
   - `scripts/ops/directory-deprovision-writer-ci-wiring.test.mjs`
   - `scripts/ops/directory-access-graph-mutex-ci-wiring.test.mjs`

`k3wise-offline-poc` job 里的原有调用保持不动，该 job 仍然自包含；重复运行只多几秒。`dingtalk-oauth-stability-workflow-contract`、`dingtalk-oauth-stability-argmax-payload`、`attendance-remote-docker-gc-workflow-contract`、`directory-deprovision-ledger-ci-wiring`、`directory-activation-source-lock-ci-wiring` 在必需检查里已有副本，本次不再重复。

这八个套件只依赖 node 内置模块、`python3` 和 bash：metrics-only 与 summary 经 `python-interpreter.mjs` 直接调用 `python3`，metrics-only full-script 调用 bash，三个目录接线合同经 `ci-realdb-step-contract.mjs` 用 `python3` + PyYAML 解析 YAML；`contracts` job 不安装依赖，同族套件已在该 job 的 ubuntu-22.04 上运行。

## 并行合同的显式例外

按 `ci-parallel-required-gates-20261030.md` 的规则，新增测试须显式更新清单并审阅，不能自动重写基线。`plugin-tests-parallel-contract.test.mjs` 新增两个常量 `closeoutContractsStep`、`directoryWiringContractsStep`，并入 `contracts` 组现有的 splice 逻辑：每一步只钉前一个邻居（分别按 `id` 与 `name` 定位，与 unit 组 lint 例外的 `lintIndex + 1` 先例一致），剥掉后再与冻结基线逐步比对。随之新增 14 个变异用例（每步各 7 个：删除、追加 `|| true`、加 `if: false`、加 `continue-on-error`、少跑一个文件、与前一步对调、复制一份），每个都必须让并行合同失败。

生产就绪清单合同仍只切取它自己那一步到下一个 `- name:` 之间的文本，不守新步骤；守住新步骤的只有并行合同。

## 文本冲突说明

另有三张开放 Draft 同时修改 `scripts/ops/plugin-tests-parallel-contract.test.mjs`（改的是其他执行组的例外与变异数组两端）。本次把常量放在 `inventoryStep` 之后、例外并入 `contracts` 分支、变异放在 `doc.jobs.contracts.steps.reverse()` 之后，避免落在同一行。后合入的一方 rebase 后重跑 `node --test scripts/ops/plugin-tests-parallel-contract.test.mjs` 与全部必需检查。

## 决策

「这些合同在必需的 `contracts` job 里运行」属于工程实现选择（T 层默认），不改分支保护。

Decision: Ratified-by-default-2026-11-03

owner 可在 24 小时内否决；否决的落地代价是删除上述两步与并行合同里的例外块（两个常量、`contracts` 分支内的两段 splice、14 个变异用例），K3 job 不受影响。

## 本机验证

本机 Node 24，CI 的 `contracts` job 用 Node 20（ubuntu-22.04）。并行合同 6/6 通过，14 个新变异逐个被拒绝；两步各自的完整 `node --test` 调用分别 41/41、9/9 通过；生产就绪清单合同 18/18；读取 `plugin-tests.yml` 的 67 个 `scripts/ops` 套件与 24 个无库 vitest 单测除一处与本改动无关的既有失败外全部通过。
