# YiDa CLI local closeout verification — 2026-10-23

## Evidence scope

This is local copied-source/package verification on frozen baseline `825a6fbe85c3b4df00aa794807a602f21a22c4d4`, not CI, a new full repository build, deployment, customer authorization or YiDa sending. The two new acceptance runners are task-local harnesses. The existing runtime-closure regression remains the portable CI-wired test.

The original package SHA256 stayed `7dc3bfdf3ff0c5ee823cae3e9a8f2788f9ac2b04c909e3e994d973d10551a17c`. Source archive SHA256 is `4637ae7dc25bee656abe6e4c43ff695bc16c7e73e5bd65c204bfa08a0ef527df`. Supplemental pin archive SHA256 is `7e05248e817bf974d46581fee48820fe3ab4df4c97202603daf43867d98c8e6d`; the exact-baseline closure-workflow reference archive SHA256 is `553314053d4ffcbd0349202ba3bab05e3b8350a39682ec453a8e76b982268098`.

An initial delegated implementation attempt failed/retried at connection, made zero writes and ran zero checks, then was interrupted/closed. Implementation and local runs used a different implementer. The independent Codex sibling audit is separate from these implementation results.

## Completed package checks

Standalone real-package run: `artifacts/package-1792718417296/package-acceptance.json` relative to the task root.

| Real archive | Verifier exit | Outer checksum | Result |
| --- | ---: | --- | --- |
| Original package, independent baseline audit | 0 | correct | Full verifier accepts |
| Original-derived missing CLI, original verifier | 0 | recomputed/correct | Historical false green retained |
| Fixed good derivative, internal fixed verifier/pin | 0 | recomputed/correct | Full verifier accepts |
| Fixed derivative missing CLI | 1 | recomputed/correct | Exact missing CLI content refusal |
| Fixed derivative missing direct bootstrap dependency | 1 | recomputed/correct | Exact missing bootstrap content refusal |

The fixed good archive SHA256 is `266e436fd2a877b55833aa7cc96f2b3f51c88792a52508615f3013184c491382`. The standalone missing-CLI archive SHA256 is `1790a102f604cf94a3a3a42146471c6afe9f936cf104e9300a7288a7a40c1987`; its missing-bootstrap peer is `95ca58968c0ada5360616dd01abcc8b345cc17117d35a6e5967e964593dd67eb`. Subsequent runs generate separate archives and receipts with their own exact hashes and complete `SHA256SUMS`.

The good derivative differs in exactly two regular-file contents: `scripts/ops/multitable-onprem-package-verify.sh` and `plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json`. These are test derivatives over an actual existing build, not a fabricated build-provenance claim. The CLI is the original compiled artifact, SHA256 `e9244742b3f9476923d449290133ea99e7c4f5aa1506cea451d7180cf763b7a8`.

Repository pin computation and full provenance verification pass on exact source bytes. Only verifier pin `runtimeFiles.multitableOnpremPackageVerify` changes to `9d123e6c5c7b699102cd01248b8105b72df12bbc4e1bb500e6c34b4b13574a9d`; the new manifest file SHA256 is `b049c1103ff7faf71398a2870968635ed5e25b5e4a6bfcbea85e9c978a1d5a22`. No blanket LF normalization or unrelated pin changes were used.

The independent Codex baseline and fixed-checker receipts remain in sibling `yida-cli-codex-audit-20261023/package-gap-audit-baseline.json` and `package-gap-audit-fixed.json`. Their original missing-CLI false green is preserved; their fixed checker rejects both missing paths. They are not counted as extra implementation tests.

## Permanent regression and mutation

Command in clean WSL environment, from the repository root:

```text
node --test tmp/yida-cli-closeout-20261023/source/scripts/ops/onprem-package-runtime-closure.test.mjs
```

Result: exit 0, 13 tests, 13 pass, 0 fail, 0 skip. Both new compiled-path missing-file negatives ran. The test also confirms its existing Node 20 workflow wiring; no CI run was triggered.

The same complete test file on an isolated copied fixture, with exactly the two new verifier entries removed, exits 1: 13 tests, 11 pass, 2 fail. Both failures report the verifier accepting the corresponding omitted YiDa file. The mutation assertion wrapper exits 0 because it requires those two failures. Receipt: `artifacts/closure-mutation-*/mutation-result.json`.

## Historical local failures retained

An initial source-pin diagnostic exited 1 because the scoped subset lacked the exact-baseline `stock-prep-powershell51.yml`; the baseline input was then supplied. No unrelated pin was changed. An initial package harness exited 1 because it supplied a string to the provenance API instead of `{ repoRoot }`; that harness error was fixed before successful package acceptance. Its post-command historical receipt is `artifacts/package-1792718396152/failure.json`.

The first native Windows attempt exited 1 during pinned-pnpm initialization before database creation. Its same-file user/global npm config setup was replaced with distinct empty owned config files. Receipt: `artifacts/windows-1792718539936/windows-cli-acceptance.json`.

The second native Windows attempt exited 1 at `install-production-dependencies`, with `PRODUCTION_INSTALL_FAILED`, after retaining the original 600-second child budget. It never started PostgreSQL; its owned native extraction and manifests were removed. The child status/output was not retained by that earlier harness, so this record does not claim a specific package-manager error or a successful install. Receipt: `artifacts/windows-1792718593766/windows-cli-acceptance.json`. Its public registry cache was copied for the final frozen run. That earlier loaded harness predates final cleanup/containment assertions and is not relabeled as final acceptance.

The first frozen run passed the production installation and dependency checks, then exited 1 with `OWNED_PG_INIT_FAILED` before any server start attempt. Receipt: `artifacts/windows-1792719282105/windows-cli-acceptance.json`. An isolated, redacted reproduction confirmed that WSL's default shell expanded the nested bash positional arguments. Using `wsl --exec` instead of the default-shell command boundary made the identical isolated initdb succeed with exit 0 and empty stderr. Both diagnostic roots were removed. The corrected complete run below uses newly frozen hashes.

## Native Windows final receipt

Final receipt: `artifacts/windows-1792719426845/windows-cli-acceptance.json`. Harness exit **0**, `ok=true`, with 26 real CLI invocations and no skipped cases.

| Platform / tool | Actual result |
| --- | --- |
| Native Windows | NTFS extraction outside monorepo |
| Native Node | `v20.20.2`, `process.platform=win32` |
| Package manager | `pnpm@9.15.9`; pinned toolchain install exit 0 |
| Package production install | `--prod --frozen-lockfile --ignore-scripts`, exit 0; own public registry cache reused |
| Database | WSL Ubuntu-24.04, `PostgreSQL 14.24 (Ubuntu 14.24-1.pgdg24.04+2)`, own new randomized-port cluster |
| Production module checks | pg/bcryptjs/winston/prom-client resolve inside package; tsx/typescript/vitest absent from resolution |
| Actual runtime containment | 176 file-resolution events for each database-using CLI invocation; 0 outside-package resolutions |

The package runner SHA256 is `53414a53cd4f0515917d1a951df04e7454eafb0cbef9c33560b8f0aaf5fbb247`; the Windows runner SHA256 is `88cdf8ca21280ad93a556ae19238a84f6abe36239145f90356879214f2d23366`. Both hashes were recorded at process start and end and were unchanged. The CLI remained the original compiled artifact named above.

| CLI cases | Count | Actual exit / summary | Anchor evidence |
| --- | ---: | --- | --- |
| Empty args, missing apply, relative input | 3 | 1 / input | Empty and unchanged |
| Missing database environment | 1 | 1 / unconfirmed | Empty and unchanged |
| Unknown, inactive, nonadmin, wrong tenant | 4 | 1 / denied | Empty and unchanged |
| Revoke SELECT and UPDATE individually on each of six ACL tables | 12 | 1 / unconfirmed | Empty and unchanged |
| Revoke anchor SELECT, then INSERT on fresh empty anchor | 2 | 1 / unconfirmed | Empty and unchanged |
| Valid synthetic live administrator | 1 | 0 / provisioned | Exactly one anchor created |
| BOM/CRLF manifest, same-owner rerun | 2 | 0 / provisioned | Exact original row unchanged |
| Different live administrator | 1 | 1 / conflict | Exact original row unchanged |

The dedicated operator was confirmed false for superuser, CREATEDB, CREATEROLE, BYPASSRLS, replication, table/schema/database ownership, any role membership, and powerful inherited membership. Schema CREATE, anchor UPDATE/DELETE and ledger INSERT were also absent. Only CONNECT, schema USAGE, six-table SELECT/UPDATE and anchor SELECT/INSERT were granted. PostgreSQL reported its listener as loopback only. The delivery ledger stayed empty; no external sending occurred.

The final run again executed the full patched verifier from the good derivative itself: good archive exit 0, missing CLI exit 1, missing bootstrap exit 1, all with correct outer checksums and the required missing-content refusals. Its good hash remains `266e436fd2a877b55833aa7cc96f2b3f51c88792a52508615f3013184c491382`; final missing-CLI hash is `7658591b68efe77960cbf63396ba74475ca42aaa16079b1f99cc16f0a4ad06ff`, and final missing-bootstrap hash is `f450db2140e5f9eacc4a4e387831ce1d933296d3b32f813a5851344d056181b9`. The archives and all three checksums remain in that run's `packages/` directory.

Cleanup is part of the success gate: owned PostgreSQL stop exited 0; status exited 3 (not running); cluster removed and absent; synthetic manifests removed; native extraction/toolchain/config paths removed. All corresponding receipt booleans are true. Retained registry cache contains public dependency content, not synthetic credentials. Earlier failed receipts are retained separately.

## Independent provenance suite platform limit

Codex independently reports the complete original CJS provenance suite passing under WSL Node with exit 0 and its success marker. Its native Windows run fails in the suite's Bash-positive fixture at line 669: Windows script/package paths are passed unchanged to Bash, whose actual exit is 127 with the missing-file category. Sibling receipt `yida-cli-codex-audit-20261023/native-provenance-limitation.json` records stderr SHA256 `e27e936c6a490c32b186e2eb30fa2fa6a285cf3c108dab0c9abf02dad6d7035a`. An earlier default-sandbox access denial is a separate host restriction. Neither result is relabeled as a native CLI failure or as an all-native-suite pass; no unrelated suite rewrite was made.

## Local-only reproduction (runners in gitignored `tmp/`, not in the repository) and limits

The acceptance runners live only in the gitignored task directory `tmp/yida-cli-closeout-20261023/` of the developer checkout; they are not part of the repository or this PR. On that checkout, from native Windows PowerShell at the repository root, run the local harness with Node:

```powershell
node tmp/yida-cli-closeout-20261023/source/scripts/ops/yida-cli-windows-acceptance.mjs
```

It creates a new receipt directory, runs the full package checks, installs production-only dependencies with a frozen lockfile and lifecycle scripts disabled, performs actual native CLI/grant tests against its own Linux PostgreSQL instance, and cleans exact owned temporary paths. Raw child errors/stacks, credentials, connection strings, SQL parameters and generated principal/anchor values are not printed.

The copied subset does not support claiming full workspace build/lint/typecheck or complete repository integration validation. Only the direct compiled bootstrap dependency is newly required; this does not enumerate every transitive import. Lifecycle-disabled installation does not certify deployment lifecycle scripts. All production/customer execution, external writes and sending remain outside this work.

## Codex 独立复审结论（2026-10-23）

本轮三个指定缺口均已完成本地闭环，未发现新增阻断项。此结论仅适用于上述冻结源码和包，不是对当前远端 PR 全绿、可合并或可部署的背书。

- **反例确实成立且已修复**：Codex 使用独立脚本和原始实际构建包，复现旧验包器对“CLI 被删除、外层校验和已正确重算”的包返回 0；修复版对 CLI 缺失、直接 bootstrap 模块缺失分别返回 1。将验包器降级后，同一个缺失包重新被接受，独立负例断言因此转红。证据：同级 `yida-cli-codex-audit-20261023/package-gap-audit-fixed.json`、`verifier-downgrade-mutation.json`。
- **不是只看实施者收据**：Codex 在冻结脚本不变的情况下再次完整执行原生 Windows 验收。独立运行收据为 `artifacts/windows-1792719640685/windows-cli-acceptance.json`，进程退出 0，26/26 用例通过，未跳过。它与实施者的 26/26 是两轮相同覆盖，不相加宣称 52 种测试。
- **依赖及权限边界**：独立运行仍是原生 Windows Node/NTFS、包内生产依赖、无 tsx/typescript/vitest；数据库用例实际产生 176 次文件解析，包外解析为 0。操作账户不是超级用户、不是对象所有者、没有角色成员关系，没有锚点 UPDATE/DELETE 或发送账本 INSERT 权限。14 个逐项撤权负例均发生在空锚点上；成功仅创建一行；重复执行、BOM/CRLF 输入和不同管理员冲突均保持原行不变。
- **实际停止与清理已核实**：两轮均为 PostgreSQL stop=0、status=3，集群与临时清单/原生解包目录删除成功。Codex 另行仅统计任务专用前缀，Windows 临时目录剩余 0、WSL PG 目录剩余 0。原始构建包保持未修改；公开依赖缓存及脱敏收据保留，不含本次生成的口令清单。
- **独立完整测试**：现有 closure 回归文件 13/13、0 skip；WSL 下原 provenance 完整测试退出 0。Windows 下该完整测试的既有 Bash 路径用例失败仍保留，不能因此声称“所有测试在 Windows 全绿”。

Codex 的两轮收据/源码/包哈希复核汇总为同级 `yida-cli-codex-audit-20261023/final-evidence-review.json`。其中独立运行收据 SHA256 为 `e2aab9c335d9d194e0c667ab28c683a8d2bd5f72136b729893a7d30e966b5bfb`；脚本起止哈希与当前文件一致，包的三个派生归档哈希也逐一核对。

仍须明确：数据库是本地 WSL PostgreSQL，不是原生 Windows PostgreSQL；依赖安装禁用了生命周期脚本，成功运行复用了公开包缓存，之前 600 秒安装失败没有被覆盖；六张 ACL 表是最小合成夹具，不冒充整套生产迁移验证。**本节记录上一轮只读复审时的状态**：当时所有改动只在 `tmp/yida-cli-closeout-20261023/source/` 隔离副本，未移植或提交到 PR 工作树，未提交、推送、触发 CI、合并、部署、客户读取或真实发送。之后的授权及移植结果单独续记于下节，历史失败不撤销。

## 完整 #6315 分支移植与推送前门禁（2026-10-23）

Owner 随后明确授权：移植到完整、对齐后的 #6315，通过门禁后普通追加提交、推送并运行既有 CI；仍不强推、不新增切片、不合并 PR、不部署、不读取客户数据、不真实发送。本节是推送前本地验证，不把随后尚未执行的新 head CI 预记为通过。

完整候选从远端 #6315 `e1a9e914c1899f82e1b5d434e85ba3a741b17786` 的既有本地 CLI 修复 `825a6fbe85c3b4df00aa794807a602f21a22c4d4` 继续，普通 merge 对齐 main `cb22e18e196e36482ab82a7ad0dcf987a3eca064`（远端 #6315 此前落后 main 43 个提交）。无冲突，未重写历史。主检出和其它工作树的未提交文件未被修改。

移植的永久增量为：验包 required 清单两项、已有 runtime-closure 测试两项、一项 verifier pin，以及设计/验证两份 MD。这些增量不是另起的普通追加提交，而是随 merge 提交 `42ff6d072` 本身携带（叠在无冲突合并结果树之上），可用 `git diff 408ae48b0b21c8f3b6a2b4f9e21ab7fa174e9e8b 42ff6d072` 查看。固定临时布局的 Windows/package 验收脚本与原始收据继续留在 `tmp/`；没有将不可移植的本地工具冒充 CI 入口，也不把整个临时源码副本或包上传。

完整候选上重新执行的本地门禁：

| 门禁 | 实际结果 |
| --- | --- |
| 仓库自身 pin 计算函数与 manifest 逐项比较 | 66 项，实际 LF 字节完全一致；仅 verifier pin 较旧 manifest 改变 |
| 原 provenance 完整测试 | exit 0，成功标志出现 |
| migrations/package closure/no-node-modules/Guard wiring 四整文件 | 97/97，0 fail、0 skip |
| 插件原始完整 test-chain | 269 套通过，exit 0 |
| 原 Integration Guard 前端脚本 | 69 文件、1605 项通过，exit 0 |
| core-backend 原 type-check（含 recovery archive 子项目） | exit 0 |
| core-backend 原 build | exit 0；不是仅检查旧 dist 是否存在 |
| CLI 两个完整 unit 文件 | 13/13，0 skip |
| CLI + 完整 Git 索引 raw-control/hourcycle/W7 五整文件 | 62/62，0 skip；W7 的 `.env` 缺席 + skip-worktree 元数据条件保持 |
| 原宜搭 browser CI 与 workflow 两整文件 | 80/80，0 skip |
| 原 Guard 三个无条件 control block，按 workflow 原文执行 | chain 269（最低 150）、Bridge 26（最低 26）、wiring 64（最低 62），全部 exit 0 |
| 对齐后真实 closure 文件的降级变异 | 撤掉两项 required 路径后 13 条中恰好 2 条负例致红，11 条仍绿；独立夹具已删除 |
| Bash 语法、已暂存/未暂存 diff whitespace 检查 | 均通过 |

新编译的 CLI SHA256 仍为 `e9244742b3f9476923d449290133ea99e7c4f5aa1506cea451d7180cf763b7a8`；直接 bootstrap 模块 SHA256 为 `07a4ee2615d7517d70d7d10afcdca342cd646a46084f1297957f2fb4a262efdf`。二者与上节原生 Windows 两轮验收实际运行的包中字节一致。main 对齐没有改变这两个 TS 源文件、live-authority、tsconfig 或 lockfile；这不是一次新的 Windows 26 项运行，也不是新发行包的部署验证。

本地门禁收据位于独立 `tmp/yida-cli-alignment-20261023/`，只发布计数、状态、哈希和结论。首次组合调用写错 no-node-modules 文件名，Node 在测试执行前拒绝该命令；改用仓库实际文件名后上述四整文件 97/97 通过，这个调用错误不归因为产品失败。原生 Windows Bash 路径限制、600 秒安装失败、初次委派实施的连接失败及其它历史记录仍全部保留。

所有本地门禁使用清空后重建的环境，无客户数据库地址或真实发送配置；根目录及 backend `.env` 未物化。前端门禁另以现有 `METASHEET_ENV_DIR` 指向新建空目录复跑，避免读取任何环境文件，不改变测试预算或业务安全开关。正式 CI 结果须按推送后的精确 head 单独核实，不能用这些本地通过代替。
