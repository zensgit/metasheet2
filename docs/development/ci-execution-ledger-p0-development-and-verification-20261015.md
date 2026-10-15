# CI execution ledger P0：开发及验证

## 结论与授权边界

**P0 离线工具已完成并验证；现有 CI 调度、测试、配置和门槛未改变，未部署。** 这不是已启用的新 CI gate，也没有实际提速结论。2026-10-15 owner 已单独批准本分支提交、公开、创建 Draft PR 和运行现有 CI；本报告记录发布前验收，不预判远端 CI 结果。不合并、不部署、不接入新门槛。

冻结基线为开工时最新 main `42984091d7fe0e4f81ac026243200840c314bb79`，实现位于本任务独立工作树。设计合同见 `ci-execution-ledger-p0-design-lock-20261015.md`。独立复核对 13,750 个既有 tracked 文件逐个与 Git 原始 blob 比较，零字节变化；不以只检查两个 workflow 替代完整范围核实。

## 实现内容

| 新文件 | 用途 |
|---|---|
| `scripts/ops/ci-execution-ledger.mjs` | 离线源码账本、显式基线生成、工作树检查、worker/收据/调用多重集校验 |
| `scripts/ops/fixtures/ci-execution-ledger-p0/baseline.json` | 从冻结 Git 对象生成的独立 source-bound 基线 |
| `scripts/ops/ci-execution-ledger.test.mjs` | 源码漂移、结构/类型、错误通道及基线负例 |
| `scripts/ops/ci-execution-receipts.test.mjs` | worker 图、生命周期、精确成功、收据绑定和调用多重集负例 |

账本完整绑定 Plugin/Web 两个 workflow 及 required Web runner 三份源码：2 个 workflow、6 个 job、163 条源码 step 记录；命令、环境和其他可能含值的块以摘要保留，避免复制 URL/环境值到证据。当前 source ledger digest 为 `6162f327ad9021a625cf1573e77656b7d8a98bdfedc7a0cb2bce90fbcb46e8af`。

基线生成只读取上述冻结 commit 的 Git 对象；默认检查读取**当前工作树字节**，不会因 HEAD 未变而忽略本地修改，也不自动重写基线。改动命令、配置、顺序、重复次数或 runner 源码都会导致 source binding 不一致。

`evaluateExecution` 把可信调用方独立提供的 expected worker 图与 observed 图比较后，才检查结果、收据和调用证据。协调删除 observed worker、needs 边、结果和收据不能缩小 expected 清单。支持实际 check 字面名称 `test (20.x)`，与 worker ID 的语法分开。

只接受显式 completed 生命周期和每个 worker/收据的精确 success；失败、跳过、取消、未知、缺失、重复、额外、过期 SHA/run/attempt/config、空调用及调用多重集漂移均有负例。成功模型支持默认 success、`success()`、true 和 `always()`；`failure()`、`cancelled()` 及其他无法证明的条件拒绝，不引入 Actions 表达式执行器。

## 模型分工与修复闭环

- Grok 4.7 **medium** 实现，任务 session 元数据核实 actual model/effort；正式实现前调整并验证 session 设置，全局默认 effort 已恢复原 xhigh。随后同一 session 使用 headless resume，避免 TUI 渲染/长轮询开销，没有另起重复实现会话。
- Sol 6.1 **medium** 独立 refute-first 复核，未编辑实现。初次发现四项 P2：嵌套 schema、Git stderr 泄漏、缺失 workflowStatus 放行、条件语义未检查。Grok 修复并补负例/临时目录清理；父任务再补两处严格类型判断和四个 resealed-baseline 负例。
- Sol 针对原反例及残余类型问题再次验证，最终 **bounded PASS**，全部四项 P2 与清理观察关闭。复核报告为本地 `artifacts/ci-execution-p0-20261015/sol-independent-review.md`；早期 HOLD 保留为历史，不冒充从未失败。

## 验证结果

重型依赖准备和质量检查在 Mac mini 专用合成源码目录运行；Node **v20.20.2**，沿用既有 fail-closed Python/PyYAML reader，无新增仓库依赖。未启动数据库、业务后端或浏览器，未读取客户数据，也未改变真实 CI 变量/保护。

| 验证 | 最终结果 |
|---|---|
| 新增 ledger/receipt 测试 | 19/19，通过；负例中的多个断言不虚增为独立测试数 |
| 原有 Python interpreter 与 attendance wiring 邻近测试 | 315/315，通过 |
| 最终同次 Node20 合计 | **334/334，通过，0 fail、0 skip** |
| 两个实际守卫 mutation | source comparison、exact-success 守卫分别被削弱后，匹配断言变红；恢复原字节 |
| mutation 恢复后正向控制 | 19/19，通过，模块 SHA-256 与最终候选一致 |
| 物理 CLI 工作树漂移 | 独立临时目录正向通过；实际追加 runner 字节后拒绝；恢复后通过 |
| Git/CLI 错误通道 | 合成 GIT_DIR marker 未出现在 stdout/stderr；预期检查失败只输出稳定错误码 |
| 基线与范围 | 基线文件未被检查模式重写；既有 tracked 文件/调度/测试/门槛不变 |
| `pnpm validate:all` | **通过**，未添加 gate skip flags |
| Sol medium 独立复核 | 最终 bounded PASS |

上述命令有重叠，334 与恢复后的 19 不相加声称 353 个不同用例。新测试是手动离线验证，**没有接入现有 required CI 链**，因此不宣称已经构成 CI 执行覆盖保证。

原生验证驱动准备时出现过 pnpm 路径定位和 npx 不在 PATH 的错误；仅在专用验证目录修正工具定位，使用真实 Node20/pnpm/npm npx CLI 重跑原 `validate:all` 通过，未替换校验为 stub 或修改仓库脚本。依赖下载/安装耗时不作为 CI 提速证据。

## 复现命令

前提：Node20，既有 parser 需要 Python3/PyYAML；冻结 Git 对象须存在。检查模式只需要已固化基线及当前源码；来源重建/溯源测试还需要冻结对象，未来 shallow CI 接入不能假定它已被 fetch。

```bash
node scripts/ops/ci-execution-ledger.mjs
node --test scripts/ops/ci-execution-ledger.test.mjs scripts/ops/ci-execution-receipts.test.mjs
node --test scripts/ops/ci-execution-ledger.test.mjs scripts/ops/ci-execution-receipts.test.mjs scripts/ops/python-interpreter.test.mjs scripts/ops/attendance-w4c2-ci-wiring.test.mjs
pnpm validate:all
```

基线重建仅在明确检查冻结来源时使用 `node scripts/ops/ci-execution-ledger.mjs --generate`，它显式写入 fixture，但不会把当前漂移自动 ratify 成新基线；源码基线更新仍需单独审阅。

## 能力限制与下一门槛

- 当前 Web `invocationContexts` 只有 workflow 调用 runner 的 1 个上下文。内部多个 npx 调用通过完整 **146,932 字节** runner 的 hash 绑定，**没有逐个枚举/解析内部 shell 调用**，更没有收集或执行 Vitest runtime cases。它是源码绑定型账本，不是已完成的运行时用例执行清单。
- expected 图和 binding 是可信调用方配置；收据校验是离线字段/多重集契约，**没有验签/认证上传产物，也不证明 GitHub 实际执行了 worker**。不能直接拿它接收任意外部收据并授权合并。
- 没有 P1 隔离 job、Web 分片、required aggregator 激活、调度性能对照或提速比例。P1/P2 的准备 DAG、DB fixture 历史独立性、完整 required 依赖图、实际调用/用例收集等阻断仍需单独完成。
- 发布前重新 fetch 后，最新 `origin/main` 仍为上述 `42984091d7fe0e4f81ac026243200840c314bb79`，与验收基线一致，无需续期或重放；四个实现/fixture 文件摘要保持原生验收版本。新增测试继续仅作手动离线验证，不接入现有 CI。Draft PR 的现有自动 CI 结果另行记录精确头 SHA，不能复用 #6410 的绿灯，也不能冒充新增 P0 测试在远端执行。不合并、不部署，不重启旧自动化或要求其他窗口再次暂缓。

精确候选摘要、最终原生 receipt、mutation/CLI 证据及复核记录保存在本地 `artifacts/ci-execution-p0-20261015/`。专属源码/依赖保留便于复现，不清理其他工作树或共享缓存。
