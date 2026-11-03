# 场景 B 一键复演脚本 —— 验证记录（Q3b）

设计：`docs/development/scenario-b-replay-design-20260921.md`
被证对象：`scripts/ops/scenario-b-replay.mjs`
时间：2026-09-21（UTC，命令行 `date` 取得，非估算）

## 0. 一句话结论

**假件层 + 真 socket 层都证到了；真复演（真 PG + 真后端）没跑。** 本机没有任何 PostgreSQL
客户端/服务端二进制（`which psql initdb pg_ctl postgres` 全空），C 盘 95% 已用（余 16G），
不具备起便携 PG + 起后端 + 跑迁移的条件。所以下面每一条都写清楚它证的是哪一层。

## 1. 自测层（注入假 fetch，不碰网络/数据库）

```
node --test scripts/ops/scenario-b-replay.test.mjs
ℹ tests 24   ℹ pass 24   ℹ fail 0
```

覆盖：

| 组 | 断言 |
| --- | --- |
| 安全门 | 生产 Apply 已配置 / 无正向沙箱标记 / allowlist 被污染 / 目标出沙箱命名空间 / 命名空间前缀漂移 / 预检 401·403·404·500 / 形状不认识 —— 七种拒绝形状逐个点名；拒绝时 `calls.length === 1`（只发了预检） |
| 安全门 | 本机是正向标记（没开 `STOCK_PREP_SANDBOX_MODE` 也放行），但**本机不豁免生产姿态**（同一份输入加上 `productionApply.state='configured'` 立刻拒） |
| 安全门 | `markers` 里不含 allowlist 字符串、不含主机 |
| 安全门 | 脚本里镜像的 `SANDBOX_OBJECT_ID_NAMESPACE` / `..._PATTERN` 与 `stock-preparation-target-provisioning.cjs` 源码**逐字**一致（源码改了而镜像没跟 → 这条红，而不是门悄悄放宽） |
| 逐步判成败 | 8 个 HTTP 步骤各自换一个非期望状态码：`exitCode=1`、`stoppedAt` 是那一步、**总请求数**恰好等于到那一步为止该发的数（后面的请求没发出去） |
| 逐步判成败 | `RUN_V1` 拿 200（幂等 noop）也判失败 |
| 逐步判成败 | 状态码全绿但逐行分布对不上（removed 少一条）→ 停在 `VERIFY_EXPECTED` |
| 逐步判成败 | `--mode v1` 不发 diff 那两条读面 |
| 逐步判成败 | 换表步骤拿不到 → 停在 `RESEED_V2`，第二次源运行不发 |
| values-free | 服务端往每个响应里塞夹具件号/项目号、往 `changeCounts` 里塞非字母键 —— 报告里 `SYN-` 一次都不出现（**失败**的报告上也不出现） |
| values-free | `scanValuesFree` 命中时只报类别，序列化后不含命中的值本身 |
| 不写 autopersist / 不发租户 | 整条复演的每个请求：无 `x-tenant-id` 头、请求体无 `tenant|persist` 类键、查询串无租户/落库开关；源运行请求体键集恰好是 7 个（比 Q3a 测试里的 `sourceRunBody` 少 `tenantId` —— 刻意） |
| 不写 autopersist / 不发租户 | `assertRequestBodySafe` 对 `tenantId` / `autoPersist` / 未登记键各自抛 |
| 参数 | 必填、互斥、闭集、缺值、末尾斜杠 |
| 参数 | `--dev-token` 拿不到 token（模拟生产上的 404）→ 当门没过，`calls.length === 1` |

## 2. 变异自证（内存级：读源码 → 单行锚点替换 → data: URL 编成新模块，磁盘零改动）

三处，每处都断言锚点**恰好命中 1 次**（先 `replace(/\r\n/g,'\n')`），并且在同一份输入上
比对「变异体 vs 真脚本」：

| # | 变异 | 变异体的行为 | 真脚本的行为 |
| --- | --- | --- | --- |
| ① | 删掉 `if (productionApply.state !== 'closed') …` | 放行一个 `productionApply.state='configured'` 的落点 | 拒，`production_apply_configured` |
| ② | 删掉 `if (!loopback && !sandboxModeEnabled) …` | 放行一台既非本机、也没开沙箱模式的默认装机 | 拒，`no_sandbox_marker` |
| ③ | `ok: accept.includes(response.status)` → `ok: true` | 把 `REGISTER_SYSTEM` 的 403 记成 PASS 继续往下跑 | 停在 `REGISTER_SYSTEM`，`exitCode=1` |

三条断言因此都不是空转：把对应能力拿掉，对应断言确实会红。

**为什么必须是内存级**：并发反驳镜头如果在同一个 worktree 上做落盘变异会互相污染、留残留
（`concurrent-refuters-same-worktree-mutation-clash`）。这里的探针只在进程内编译，脚本文件一个
字节都没改。为让 data: URL 下的模块能起来，`scenario-b-replay.mjs` 里所有依赖 `import.meta.url`
的解析（`fileURLToPath` / `createRequire`）都做成了可降级的 helper —— 这是为探针付的、写在代码
注释里的唯一一处结构成本。

## 3. 真 socket 层（真 CLI 进程 + 真 HTTP 服务器 + **真夹具文件**）

自测注入的是假 fetch 和假夹具；这一层把两者都换成真的，唯一还是桩的只有后端本身。
驱动脚本是一次性的，放在会话 scratchpad（不入库）：起一个 `http.createServer` 监听
`127.0.0.1:0`，`spawn` 真的 `node scripts/ops/scenario-b-replay.mjs … --json`，读它的退出码和
stdout。期望计数这一次是脚本**自己**从仓库里真实的
`plugins/plugin-integration-core/fixtures/scenario-b-synthetic-bom/scenario-b-synthetic-bom.cjs`
读出来的（54 / 54 / 55 / 51 全部对上），不是测试里那份替身。

两次：

```
productionRefused: {
  exitCode: 2,
  stderr: "[scenario-b-replay] SANDBOX GATE REFUSED: production_apply_configured",
  requestCount: 1,
  paths: ["/api/integration/stock-preparation/preflight"]
}
happyPath: {
  exitCode: 0,
  stoppedAt: "VERIFY_EXPECTED",
  byDiffType:   { added: 1, removed: 1, changed: 2, unchanged: 51 },
  byChangeType: { added: 1, removed: 1, quantity_changed: 1,
                  source_fingerprint_changed: 2, component_code_changed: 1 },
  valuesFree:   { clean: true, hitClasses: [] },
  gateMarkers:  { loopbackBase: true, sandboxModeEnabled: true, productionApplyClosed: true,
                  allowlistedCount: 1, declaredSandboxTargetCount: 1 },
  requestCount: 9,
  sentTenantHeader: false,
  sentTenantOrPersistBodyKey: false,
  reportMentionsHost: false
}
```

这一层额外证到（假件层证不到的）：进程退出码真的是 2 / 0；`--json` 的 stdout 真的能 `JSON.parse`；
`--reseed-command` 真的被 `spawn` 起来且退出码被采信；真夹具文件真的被加载且期望计数对得上；
报告里**不含**目标主机 `127.0.0.1`。

## 4. 没证到的（不含糊地列出来）

1. **真后端。** 所有响应都是桩服务器编的。路由路径、状态码语义、响应字段名来自亲读
   `http-routes.cjs`（§设计 §2 给了 `path:line`），但「这台真机器会不会这么答」没跑过。
   尤其是三条源登记路由的请求体形状 —— `externalSystemsUpsert` / `readSourceConfigsSave` 的
   校验分支没有在真服务端上走过一遍，第一次上真机很可能要按 400 的 `error.code` 调参数。
2. **真 PG + 真落库。** 两个批次是不是真的独立不可变、`autoPersist.created.lines` 是不是真的 54、
   服务端挑不挑得中 v1 作 base —— 这些在 Q3a 的进程内测试里证过（内存 staging），在**真 PG 上**
   没证过。
3. **`RESEED_V2` 的语义。** 只看命令退出码，没校验表里现在真的是 v2（要连库）。设计 §7.3 说明了
   这条不会变成假绿：换表没成功 → `DIFF_ROWS` 报 54 条全 unchanged → 第 11 步红。
4. **CI 泳道。** 自测登记在 `package.json`，但没有 workflow 拉它（本波不动 `.github/`）。

## 5. 复跑方式

```bash
node --test scripts/ops/scenario-b-replay.test.mjs      # 或 pnpm verify:scenario-b-replay:test
```

真复演的前置与命令见设计文档 §6。
