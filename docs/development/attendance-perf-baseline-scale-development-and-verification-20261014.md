# 考勤导入 baseline 1 万／2 万行开发及验证 — 2026-10-14

状态：PASS，全部已授权合成验收 gates 通过；六轮规模、完整恢复和独立最终复核均已完成。公开发布、PR、合并及部署均未执行；真实 CI 变量与分支保护未修改。Astra high 最终 verdict 为 PASS／must-fix0，证据与历史失败分开保留。

## 范围与固定版本

本轮仅验证已有 standard CSV 导入消费者的 10000／20000 行规模，修复范围内实际复现的计时和 COMMIT 等待问题。初始基线 `316b06e93a8eaa0012394ae5ddf36ae157db79ab`；计时修复 `cd7d7d0c0075a0579c9ee4ea6272ab86598d5cac`；最终源码／消费者／实际后端 build identity 均冻结为 `1ef38f6b17a7fdcf77e1934c99d84a3be7e1efcb`。分支 `codex/attendance-perf-baseline-scale-20261013`，截至本报告完成仅本地提交。

设计锁：`attendance-perf-baseline-scale-synthetic-design-lock-20261013.md`。实现和独立审阅分开；重型验证仅在 Mac mini 专属目录和全合成数据库执行。

## 两项实际修复

1. V1 job 初始 started_at 为空，终态 UPDATE 同时使用事务 `now()` 填开始和结束，真实 SQL elapsed=0，消费者的 async commit gate 因此失去意义。仅将 core repository 的成功终态 finished_at 改为 `clock_timestamp()`；保留 started_at 的已有值／事务起点 fallback、updated_at、谓词、响应持久化和业务 effects。此度量是事务开始至终态 SQL 的时间，排除排队、事务外准备、失败重试和终态后的 COMMIT 验证／确认；客户端提交时间另报。
2. 20000 行 reservation 的 COMMIT 客户端在 30000ms 读超时，而既有 W4 服务端语句契约为 180000ms。实际服务器提交了 queued job，但错误响应阻止入队；重复请求只读回 queued。新增独立 connection adapter，仅 literal `COMMIT` 采用既有 180000ms 客户端等待上限，接入两个 V1 host；其余 SQL、参数、原连接及 release、全局池配置均保留。未改变任何原常量、锁规则、flag 或性能阈值。

`legacy_projection_only` 不等于停用 V1 导入。已 ratified durable-plan amendment §4.6 排除 measured duration／派生 updatedAt／throughput 的跨运行字面相等，要求字段、类型和确定关系保持；这两项修复不改变业务 posture 或确定性结果。一般网络丢失 COMMIT 确认后 queued job 的持续恢复仍是独立待办，本轮未修改 replay／startup recovery 契约。

## 真实失败证据与环境边界

初始 316 版本的 10000 行已真实生成 10000 条唯一物理记录，但 SQL 起止时间相等；默认 PostgreSQL advisory-lock 容量还使 rollback 失败。因此该轮未 qualified。第一版恢复的 `pg_restore --clean` 因继承约束失败并回滚；随后保存完整私有 poststate dump，仅重建已验证身份的专属合成 DB，439 表内容和数量全部恢复、服务停止。

cd7 版本重新验收时，测量工具先遇到 Python3.9 对 PostgreSQL 五位小数时间格式的兼容问题；失败回执保留。工具仅对合法时区和 1–6 位小数做保精度归一化，40 项本地及 Mac 离线测试通过，最终观测 SQL 加固后为41项。之后三轮 10000 行通过，首轮 20000 行遇到 reservation COMMIT read timeout；该组同样不作为最终六轮样本。其 poststate、rawlogs、恢复回执保留，439 张表完整恢复、服务停止。

1ef版本的第三目标已完成三轮10000和首轮20000实际业务回滚，但20000计时38090ms越过原30000ms限值，原结果保持不 qualified。其中28349.65ms是 rollback前验收只读 SQL。相同20k查询在当前统计下319.109ms；控制旧统计的同schema/index合成TEMP fixture复现20352.715ms，原因是新batch selectivity误估使每item按source_batch重复扫描记录。工具改为唯一record ID先定位，再检查完全相同的org/user/date/batch条件；实际catalog还要求id单列PRIMARY KEY。相同stale fixture优化查询142.462ms，两者均匹配20000记录，五种实际mismatch均降为19999。原/新wall_ms还包括第二次SELECT，不作单次查询耗时引用。所有fixture事务均ROLLBACK。

这只优化观测工具，没有修改业务回滚代码或调整真实统计、没有扣除耗时或把观测移出 rollback计时窗口，也没有改变性能限值。最终41项工具回归及独立等价性复核通过，重新从全新目标跑六轮；旧1ef三轮样本不拼接到最终结果。

最终测试使用第四个全新合成目标：439 项迁移、0 排除，两租户、三个生成账户、两条业务哨兵。实际 health SHA、登录、auth/me 租户及导入入口就绪均校验。Mac native 16GiB／10 cores，Node20.20.2，PostgreSQL16.15，shared_buffers128MiB。实际 max_locks_per_transaction=1024、max_connections=100、max_prepared_transactions=0；原默认 max_locks_per_transaction=64 未通过。本结果仅对披露的调整后合成资源配置成立，不声称默认容量、共享环境或生产环境通过。

每个 case 前后重新读取有效 DB 参数并核对资源摘要，未放大 commit420000ms／rollback30000ms 门槛。全 host profile 和 DB GUC profile 使用不同摘要，均保留于 values-free 证据。

## Profile 与计量口径

10000 为 scheduled standard；20000 为明确选择 rows=20000 的 manual standard，**不是默认 workflow dispatch 行数**（该输入默认10000）。固定 commit／sync preview／async commit／CSV upload+export／payload auto／rollback true／日期 span366，group sync关闭。两种规模均低于50000的 bulk threshold。保留原 poll、retry及 API 超时配置，不更改 preview/export 未设的性能界限。

默认导出为 anomalies；合成正常记录可能仅导出表头，不描述为全记录导出。preview 在大输入时仅完整计算前200条，未宣称对 N 条全部做完整 preview 计算。物理 N、item N、唯一 user/date、实际链接和完整生成 key 集合独立读取验证。

异步限值使用原 API jobElapsedMs。SQL 微秒精确耗时也必须大于0且不超过420000ms；API须符合原 Date 对象整秒量化，summary须严格等于实际 API，throughput亦核对关系。SQL420998ms/API420000ms反例会失败，1000ms格式说明不提供超限 allowance。小 control 可出现 SQL正耗时而 API整秒0；规模样本要求两者均正。

loopback observer 在 rollback 请求转发前执行只读 SQL 和证据保存。报告列出这部分及同步 proxy 开销；rollbackMs 包含观测开销，未扣除、未放宽门槛。间接资源竞争未量化，也不声称独占整台 Mac。

## 验证证据

- 原 316 source 的七个相关／邻居 Node test files：104/104，0 skip；对应消费者源码字节在最终版本不变。
- 计时真实 PG 回归：旧 now 的两目标测试红（9 个未选用例是 skipped）；修复后 DB文件11/11、repository+worker35/35。
- COMMIT adapter最终增量：Mac DB12/12、unit+worker38/38。真实 deferred trigger等待100ms，raw client40ms读超时对照，adapter按既有180000界限成功。
- 移除 COMMIT 覆盖的实际 mutation：目标 DB测试红1，11个未选用例 skipped，随后恢复模块字节并核对SHA256；final DB/unit绿。
- 最终测量工具：41/41 本地及 Mac 离线测试；含 SQL/API/summary反例、精确界限、orgB、refresh候选和采用、资源 drift、Python3.9小数格式。
- 最终 source 的 `pnpm validate:all`：exit0。
- 八项真实缺／空 org、synthetic org、SHA及错租户负向 case，与真实刷新候选错租户 HTTP200 witness，最终回执均通过，错租户刷新候选实际auth/me HTTP200／tenantB，0导入POST，attendance71表内容不变；三行control实际distinct新token验证并在后续导入请求采用。

## 重放命令与证据位置

先使用本任务的私有准备工具创建全新目标，核对实际 source／health／tenant 绑定并保存 baseline。工具拒绝覆盖已有目标；私有配置、dump和凭据不进入 Git。以下 runtime、工具目录变量由 owner 从私有位置设置，不可指向共享目标。

```bash
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-w4c3a-canonical-import-kernel.db.test.ts
pnpm --filter @metasheet/core-backend exec vitest --config vitest.config.ts run src/attendance/__tests__/w4c3a-legacy-plan-worker-repository.test.ts src/attendance/__tests__/w4c3a-legacy-plan-worker.test.ts
pnpm validate:all
python3 -B "$AUDIT/sol-harness-tests.py"
python3 -B "$TOOLS/refresh-drift-verified.py"
python3 -B "$TOOLS/sol-scale-harness.py" --runtime-root "$OWNED_SYNTHETIC_RUNTIME" --mode all
python3 -B "$TOOLS/restore-verified.py"
```

DB test命令只可使用已准备的全合成 test DB URL；guard mutation回到原实现／中和adapter后必须红，并恢复原字节后再验证。源代码三项可公开的变更为 V1终态时钟、独立COMMIT adapter和两host接线；相关新测试加入已有 wired DB文件，`plugin-tests.yml`的原 invocation保留。

values-free材料在任务 artifacts目录：`initial-scale-failure.json`、`original-source-receipts.json`、`pre-20k-repair-receipts.json`、`commit-timeout-evidence.json`、`connection-regression-receipt.json`、`witness-paired-profile.json`、`pre-witness-optimization-receipts.json`、`final-source-hashes.json`、`final-harness-hashes.json`以及`final-qualification-receipts.json`。独立报告为`astra-independent-review.md`和`astra-ultra-20k-root-cause.md`。这些文件中的 raw／private引用不作为公开数据。

## 六轮最终结果

同一 source1ef／41项工具版本／资源配置的一次 all 执行：8项负向＋3行control＋六轮规模全部通过；额外错租户刷新候选实际HTTP200证明通过。

| 轮次 | 行数 | preview ms | SQL精确任务 ms | API gate ms | 客户端提交 ms | export ms | rollback ms | 回滚前观测 SQL ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| schedule_1 | 10000 | 174 | 5114.322 | 5000 | 38504 | 54 | 3136 | 167.425 |
| schedule_2 | 10000 | 242 | 5929.555 | 6000 | 39746 | 100 | 3158 | 210.073 |
| schedule_3 | 10000 | 424 | 8832.904 | 9000 | 45651 | 64 | 3059 | 122.561 |
| manual_1 | 20000 | 213 | 11236.497 | 12000 | 105008 | 125 | 6324 | 275.704 |
| manual_2 | 20000 | 288 | 11795.174 | 12000 | 105799 | 113 | 6336 | 259.800 |
| manual_3 | 20000 | 330 | 17034.801 | 17000 | 111691 | 127 | 6615 | 273.095 |

所有六轮 physical records、唯一 user/date、item及record links均为 N；new keys=N，update0，skip0，processed=N、failed0，所有限值通过。10000行用户池28／实际日期358；20000行用户池55／实际日期364。每轮回滚后 business records恢复两条哨兵及相同内容hash，events0；orgB直接作用域69表不变，2张无直接org列保持已声明的验证边界。

| Profile | 客户端提交 min／median／max ms | rollback min／median／max ms | SQL精确任务 min／median／max ms |
|---|---:|---:|---:|
| schedule | 38504.000／39746.000／45651.000 | 3059.000／3136.000／3158.000 | 5114.322／5929.555／8832.904 |
| manual | 105008.000／105799.000／111691.000 | 6324.000／6336.000／6615.000 | 11236.497／11795.174／17034.801 |

小control真实SQL144.057ms，API整秒0，明确标记量化control；不充作规模性能样本。七个正向case实际anomalies CSV均为129bytes表头、0data rows，未宣称N行全记录导出。每轮保留batch/job各1、item各N；control加六轮合计7batch、7job、90003item审计，额外最终restore是独立步骤。

三轮样本只报告 min／median／max／range，不估计稳定p95/p99。DB GUC profile SHA256 `45637c2075446b5ba9fbd8b8781af2d7e4feea0c22fafabf094d66aab8ea47fa`；全host profile SHA256 `ec9afdc909016034e2955eee087ae9908d3568d066f7e89a0d6b766bb78b5804`。同步观测开销保留于测量，未扣除。

## 独立复核与模型选择

Sol6.1 high 实现测量工具和已复现的计时修复；Grok4.7（实际 xhigh）做离线生成器／计量口径审查，父执行者重新执行并核对源文件 hashes。Astra high 独立找出零耗时、refresh假阳性和精度门槛漏洞并审查收据。20000 行跨 COMMIT／入队路径失败升级到 Astra ultra 只读定位和独立 code review；父执行者实现窄范围 adapter。最终代码 review 无 must-fix，六轮和恢复收据均已完成，Astra high 最终证据 verdict 为 PASS、must-fix0；审阅者未 SSH／读取私有输入／重跑 live benchmark，明确与父执行者实际 Mac 操作区分。

Kimi只做本机CLI preflight，未验证 K3 model alias，未声称运行 K3任务；Luna未调用。后续按难度自动选模型／effort，仅有必要时使用 Astra ultra。

## 恢复、交付及剩余门槛

最终 consumer rollback 与完整私有 baseline restore 是两个独立 gate。每轮业务表数量与全内容hash、orgB直接作用域69张考勤表保持；另2张无直接 org列不据此声称全部间接隔离。batch/item/job审计残留单列，最终额外恢复后再核对实际 public inventory 和439张表全部hash／count，停止两项专属进程。最终恢复已执行：成功保存私有qualified poststate dump、核验baseline dump摘要；仅重建身份验证通过的专属DB并事务恢复，实际public inventory439张完全一致、439张表所有count及全内容hash回到baseline，mismatch0。records2／events0，users3／user_sessions3，恢复后的hash均一致；qualified阶段11张表有审计／执行metadata变化，已通过额外restore清理，原有合成账户／session基线保留。backend与launcher已等待退出、专属PostgreSQL已停止。

可重放工具及 values-free receipts 位于本任务 `artifacts/attendance-perf-baseline-scale-20261013/`；rawlogs、CSV、完整 SQL、dump、凭据和资源 ID仅保留于 Mac 私有专属目标。新公开分支／Draft PR 需 owner另行批准。本轮不部署，不改真实CI变量或保护，不将本地合成通过冒充共享运营 workflow 通过。

## Design-lock gate closeout

| Gate | Result |
|---|---|
| Fresh synthetic target / source / tenant identity | PASS: 439 migrations, no exclusions, actual health and auth proofs |
| Missing / blank / incorrect bindings and refresh | PASS: 8 negatives, actual wrong-tenant candidate200, distinct verified positive adoption |
| Small control | PASS: 3 physical records, export and rollback, precise SQL / API quantization disclosed |
| 10000x3 / 20000x3 | PASS: one 1ef freeze / 41-test harness / resource profile, 6 actual qualified rounds |
| Focused / neighbor / mutation / quality | PASS: base-source104, final DB12 / unit38, tool41, real guard-red and byte restore, final validate:all |
| Independent review | PASS: Astra ultra code review and Astra high final evidence verdict, must-fix0 |
| Baseline restoration / owned shutdown | PASS: fresh439 inventory and full count/hash equality, auth restored, backend/launcher/PG stopped |
| Development / verification MD and local code | COMPLETE: two scoped local fixes and reviewable PR materials |
| Public branches / Draft PR / CI | NOT EXECUTED: separate owner approval required |
| Merge / deploy / real operational configuration | NOT AUTHORIZED OR EXECUTED |

## Draft publication authorization — 2026-10-14

The owner separately approved public publication of both branches, two dependent Draft PRs, and CI. Merge and deployment remain outside that approval. The preceding qualification is a historical receipt for frozen product source `1ef38f6b17a7fdcf77e1934c99d84a3be7e1efcb`; documentation-only publication commits do not change that source.

Publication preflight fetched main `d86cf921d852cc46ab4d17760f0bdf0c1161727a`. Both candidate trees merge without a textual conflict, but main has since added attendance timezone behavior and migrations. The six scale samples do not qualify that newer combined runtime. Preserve the frozen branches for Draft review, run the first PR's normal CI against its merge ref, and explicitly dispatch Plugin System Tests on the second branch because its stacked base is outside that workflow's pull-request branch filter. Record exact run/head identities separately; before any future merge, refresh main, reconcile the stack, and validate the resulting source.
