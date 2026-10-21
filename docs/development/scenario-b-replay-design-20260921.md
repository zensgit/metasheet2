# 场景 B 一键复演脚本设计（Q3b）

`scripts/ops/scenario-b-replay.mjs` · 自测 `scripts/ops/scenario-b-replay.test.mjs`
验证记录：`docs/development/scenario-b-replay-verification-20260921.md`

## 1. 它是什么，不是什么

**是**：把 Q3a 那支权威测试（`plugins/plugin-integration-core/__tests__/scenario-b-v2-snapshot-diff.test.cjs`）
里的调用序列，从「进程内 handler 直调 + 内存 staging 替身」抬到**真 HTTP**，对着一台已经起来的
后端按顺序跑一遍，逐步按状态码判成败，最后吐一份 values-free 报告。

**不是** diff 引擎的证明。四类变更认不认得出来，Q3a 已经在无数据库的条件下逐类证完了
（`scenario-b-v2-snapshot-diff.test.cjs` 断言 2/3 + 三个变异）。本脚本证的是**另一件事**：

> 这条链在一台真机器上，从源登记到 diff 读面，整条能跑通；哪一步断了，报告说得出是哪一步、
> 期望什么状态码、实际拿到什么。

所以脚本对「跑通」的定义是逐步状态码 + 末端逐类计数比对，不是「没抛异常」。

## 2. 调用序列（逐条对着 Q3a 测试抄下来的）

| # | 步骤枚举 | 方法 + 路由 | 期望状态码 | 对应测试里的那一步 |
| --- | --- | --- | --- | --- |
| 1 | `GATE` | `GET /api/integration/stock-preparation/preflight` | 200 | 测试里没有（真机专属，见 §3） |
| 2 | `REGISTER_SYSTEM` | `POST /api/integration/external-systems` | 200/201 | `externalSystemRegistry.getExternalSystemForAdapter` 替身 |
| 3 | `SAVE_CONFIG` | `POST /api/integration/read-source-configs` | 200/201 | `readSourceConfigStore.getForRuntime` 替身 |
| 4 | `APPROVE_CONFIG` | `POST /api/integration/read-source-configs/:id/approve` | 200 | 替身里写死的 `status: 'approved'` |
| 5 | `RUN_V1` | `POST /api/integration/stock-preparation/mvp/source-runs/plm-bom` | **201** | `persistBothBatches()` 的第一次 `invokeHandler` |
| 6 | `RESEED_V2` | 不是 HTTP —— 操作员换表内容（§4） | — | 测试里是换 `rows: fixture.ROWS_V2` |
| 7 | `RUN_V2` | 同 5，`snapshotVersion: 2` | **201** | 第二次 `invokeHandler` |
| 8 | `BATCH_LIST` | `GET …/snapshot-batches?projectId=…` | 200 | 断言 3 的 `stockPreparationSnapshotBatchList` |
| 9 | `DIFF` | `GET …/snapshot-batches/:id/diff` | 200 | 断言 3 的 `stockPreparationSnapshotDiff` |
| 10 | `DIFF_ROWS` | `GET …/snapshot-batches/:id/diff/rows` | 200 | 断言 3 的 `stockPreparationSnapshotDiffRows` |
| 11 | `VERIFY_EXPECTED` | 不是 HTTP —— 与夹具的 `V2_EXPECTED_DIFF` 逐类比对 | — | 断言 2/3 的逐类点名 |

路由字符串来自 `plugins/plugin-integration-core/lib/http-routes.cjs:133,144,145,148`（源运行与三条读面）
与 `:25,31,35`（源登记三条）。

`RUN_V1` 只认 **201**：200 意味着 `autoPersist.mode = skipped_existing`（同批次同内容的幂等重放，
`scenario-b-v2-snapshot-diff.test.cjs` 断言 4），那是一次「什么都没落」的调用，当成复演成功就是假绿。

第 11 步比的是（全部取自夹具 `scenario-b-synthetic-bom.cjs`，不是脚本里写死的数字）：

- 两批次各自 `autoPersist.created.lines` = `ROW_COUNT` / `ROW_COUNT_V2`
- 批次列表里两批次的 `lineCount` 同上，且 `incomplete === false`
- `DIFF` 的 `baseSnapshotBatchId` 是服务端**自己**挑的 v1（不是请求指定的）
- `DIFF_ROWS` 的 `rowCount` = `V2_EXPECTED_DIFF.total`，`heldRowCount` = 四条
- 逐行 `diffType` 分布 = added 1 / removed 1 / changed 2 / unchanged 51
- 逐行 `changeTypes` 里 `quantity_changed` 与 `component_code_changed` **各恰好一条**
  （后者是「原位物料替换被点名」那条，不是被 `source_fingerprint_changed` 顺带报出来的）

## 3. 安全门（本脚本的第一等公民）

脚本**不接受**一个只写着 `--base-url` 的地址就开跑。发任何业务请求之前，先 `GET` 部署预检，
用它的 values-free 回答判「这是不是一个沙箱/本机落点」。三条判据全部来自仓库里已有的定义：

| 判据 | 仓库出处 | 不满足时的原因码 |
| --- | --- | --- |
| 沙箱 objectId 命名空间 | `stock-preparation-target-provisioning.cjs:99,103` | `sandbox_namespace_mismatch` / `target_outside_sandbox_namespace` |
| D1=B 落点裁决（落地表只能在 `plm_stock_preparation_sandbox*`） | `docs/development/takeover-beiliao-20260821/222-deploy-window-runbook-20260901.md` §0.6 | 同上 |
| 生产 Apply 姿态必须 `closed` | `stock-preparation-preflight.cjs:299` `buildPosture()` | `production_apply_configured` |

另外两条：

- `droppedNonNamespaceEntries !== 0`（预检自己报的「env 里有非沙箱条目」计数）→ `allowlist_polluted`。
- **必须有一个正向沙箱标记**：base 是 loopback，**或**预检报 `modeEnabled === true`
  （即 `STOCK_PREP_SANDBOX_MODE=true`）。两者都没有 → `no_sandbox_marker`。
  这一条是整道门里最容易被写漏的：一台「谁也没说过它是沙箱」的默认装机，前面几条判据全都
  空过（allowlist 空、declared 空、posture closed），门会静静放行 —— 那正是最危险的形状。
  自测的变异②把这一条拿掉，证明它不是装饰。

loopback **不豁免**其余判据：把本机端口转发到生产的人拿不到放行（自测里有这条正例/反例对）。

loopback 的判定（#5931 复审 F2 收紧）：URL 规范化后的 hostname 必须**先被 `node:net` `isIP()`
证明是 IP 字面量**，再判 IPv4 `127.0.0.0/8` 或 IPv6 `::1`；名字只认恰好 `localhost`。以 `127.` 打头的
DNS 名（`127.x.invalid`、`127.0.0.1.nip.io`）、借 localhost 作前缀/子域的名字、带尾点的 `localhost.`、
IPv4 映射地址 `[::ffff:127.0.0.1]` 与 `0.0.0.0` 都**不是**正向标记（解析到哪由 DNS/栈决定）。

判不了就拒：预检 401/403/404/500、响应形状不认识，一律 `preflight_unreachable` /
`preflight_shape_unknown`，退出码 2，**一个业务请求都不发**（自测断言 `calls.length === 1`）。

门的输出是 values-free 的：`markers` 只有布尔与计数，**不回显** allowlist 里的 objectId 字符串，
也不回显主机名。拒绝时 stderr 只打闭集原因码，不打服务端回来的自由文本。

## 4. 三条「永远不做」

1. **永不设置 autopersist。** `MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED` 是**服务端** env
   （`http-routes.cjs:1348`，只认精确字面量 `'true'`）。脚本不写 env、不发任何 autopersist 字段；
   `assertRequestBodySafe()` 在每个请求出门前逐键核对白名单，任何名字里带 `persist` 的键直接抛。
   这意味着：**目标部署自己没开 autopersist 时，`RUN_V1` 不会落行、脚本会在第 5 步红**。这是对的 ——
   复演需要落库，而「让它落库」是部署侧的 owner 决定，不是脚本能替谁做的。
2. **永不发 tenantId / `x-tenant-id`。** autopersist 打开时，PLM 源运行对**任何载体**上的显式
   tenantId 都 400 拒绝（`http-routes.cjs:1379` `assertStockPreparationPlmAutoPersistNoSteering`）；
   而 `x-tenant-id` 请求头本身是已知的跨租户值泄漏面。租户一律由 token 自己带 —— `--tenant`
   **只**用于 `--dev-token` 铸 token 时的 query，绝不进任何业务请求。
3. **永不连数据库。** v1 → v2 之间那次换表内容（灌 `03-seed-v2.sql`）是操作员的动作：
   给 `--reseed-command` 让脚本代跑一条命令，或者交互式等一行确认。脚本自己不 import `pg`、
   不拼 psql、不读连接串。非交互且没给 `--reseed-command` → 停在 `RESEED_V2`，原因
   `reseed_step_unavailable`，第二次源运行不发。

## 5. 报告

```
{ mode, ok, exitCode, stoppedAt, gate{decision,reason,markers,preflightStatus},
  steps[{step,status,ok,…}], batches{v1,v2}, diff{…}, expected{…}, valuesFree{clean,hitClasses} }
```

values-free by construction：

- `steps` 只有闭集步骤名 + 整数状态码 + 布尔；传输失败记 `status: 0` 和 `error.name`，**不带**
  `error.message`（可能含主机名）。
- `changeCounts` 逐键过滤：键名必须是纯字母，值过 `Number()`。服务端把件号塞进某个计数键，
  那个键会被整条丢掉。
- 批次 id / 配置 id 是**脚本自己生成或调用方给的标识符**，不是业务值。
- emit 之前过一遍 `scanValuesFree()`：哨兵 = 夹具的件号/项目号/路径键 + 调用方在命令行上给的
  `--source-project-no` / `--project-name`。命中即判失败，且**只报命中类别**（`fixture_part_identifier` /
  `caller_supplied_business_value`），不回显命中的值 —— 否则自检报告自己就成了泄漏面。

退出码：`0` 全绿 · `1` 某一步失败 · `2` 安全门拒绝 · `3` 参数错误。

## 6. 用法（README 段落）

```bash
# 前置：目标部署上已有一个指向合成 BOM 表的只读 Connection（--data-source-id 指它），
#       且该部署自己打开了 MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED=true（脚本不替它开）。

# 1) 先把 v1 灌进合成表
psql -d syn_bom_b1 -v ON_ERROR_STOP=1 \
  -f plugins/plugin-integration-core/fixtures/scenario-b-synthetic-bom/01-schema.sql
psql -d syn_bom_b1 -v ON_ERROR_STOP=1 \
  -f plugins/plugin-integration-core/fixtures/scenario-b-synthetic-bom/02-seed.sql

# 2) 一键复演（两批次 + diff）
node scripts/ops/scenario-b-replay.mjs \
  --base-url http://127.0.0.1:8900 \
  --dev-token --tenant tenant_scenario_b \
  --data-source-id syn-bom-postgres-b1 \
  --project-id business_project_scenario_b \
  --mode v1v2 \
  --reseed-command "psql -d syn_bom_b1 -v ON_ERROR_STOP=1 -f plugins/plugin-integration-core/fixtures/scenario-b-synthetic-bom/03-seed-v2.sql" \
  --json
```

参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--base-url` | 必填 | 目标部署；末尾斜杠会被削掉 |
| `--token` / `--dev-token` | 二选一必填 | `--dev-token` 走 `GET /api/auth/dev-token`（生产上这条路由是 404，见 `packages/core-backend/src/routes/auth.ts:64`） |
| `--tenant` | 空 | **只**用于铸 dev-token；不进任何业务请求 |
| `--workspace` | 空（租户级 NULL 作用域） | 整条链的唯一作用域：给了就登记/保存/审批（查询串 `workspaceId`）、源运行（请求体 `workspaceId`）、快照读面（查询串）全带同一个值；不给就全不带。配置仓按作用域精确匹配、不回退（#5931 复审 F3） |
| `--fixture-dir` | 仓库里的合成夹具目录 | 期望计数从这里读 |
| `--mode` | `v1v2` | `v1` 只落一个批次、不读 diff |
| `--data-source-id` / `--system-id` | 合成默认值 | 源登记 |
| `--project-id` | `business_project_scenario_b` | 业务项目号**前缀**：实际项目号 = 前缀 + `_` + 本次随机盐，每次演练一个隔离的新项目（#5931 复审 F4；落库按项目要求版本严格递增、diff 读面拒同版本多前驱，两道守卫都不关） |
| `--source-project-no` / `--project-name` | 取夹具 / 空 | 给了就当哨兵，报告里绝不出现 |
| `--run-prefix` | `scenario_b_replay` | 批次/运行 id 前缀，实际 id 再缀一段随机盐（批次不可变，不能撞） |
| `--reseed-command` | 空 | v1→v2 之间代跑的那条命令；不给且非 TTY 则停在 `RESEED_V2` |
| `--timeout-ms` | 20000 | 单请求超时 |
| `--json` | 关 | 吐完整 JSON 报告而不是人读摘要 |

自测：`pnpm verify:scenario-b-replay:test`（等价 `node --test scripts/ops/scenario-b-replay.test.mjs
scripts/ops/scenario-b-replay-contract.test.mjs`）。前者注入假 fetch；后者把脚本的 fetch 接到真
`http-routes` handler + 真 `read-source-config-store`（有作用域语义的内存 db），钉住登记→保存→审批→源运行→
读面的作用域闭环与「同一后端连续两次完整复演都成功」。都不碰网络、不碰数据库。

## 7. 已知残余

1. **CI 泳道已接。** `.github/workflows/scenario-b-replay-verify.yml` 跑 replay 与契约两套件；
   其 wiring job 断言 paths 覆盖契约测试的真实 require 闭包、且 job 真跑两套件。
2. **真复演未跑。** 本机没有可用的 PG 客户端/服务端，也没起后端，所以只跑到「真 socket + 桩服务器」
   这一层。详见验证 MD §3，那里写明了到底证了什么、没证什么。
3. **`RESEED_V2` 的成败只看退出码。** 脚本不校验「表里现在真的是 v2 那 54 行」—— 那要连库。
   真正的守卫在下游：如果换表没成功，`RUN_V2` 落的行与 v1 一致，`DIFF_ROWS` 会报 54 条全 unchanged，
   第 11 步红。也就是说这条残余**不会**变成假绿，只会变成一条更晚、更绕的红。
4. **源登记是每次重来的。** 脚本每次都 upsert 外部系统 + 存一版配置；`saveVersion` 对同一份配置会
   `reused` 回 200，所以重复跑不会堆版本，但也没有清理动作。复用到的若已是 `approved`，脚本跳过审批
   （报告里 `APPROVE_CONFIG` 记 `skipped=reused_approved_version`）；此前无条件再批会在第二次执行时 409
   （#5931 复审 F4）。每次演练的业务项目是新的，历史批次原样保留、不清理。

- **同一后端不要混用默认作用域与 `--workspace`（同一个 `--system-id`）。** 外部系统登记按作用域
  归属：先默认（租户级）再 `--workspace X` 会在 REGISTER_SYSTEM 得 409 `EXTERNAL_SYSTEM_SCOPE_MISMATCH`；
  先 `--workspace X` 再默认或 `--workspace Y` 会因表上全局唯一 id 得 500。两者都在第 2 步 fail-closed，
  不会假绿。旧版脚本跑过的后端上系统已登记为租户级，旧 runbook 若写 `--workspace workspace_scenario_b`
  会撞 409——要么去掉该参数，要么换一个 `--system-id`。
