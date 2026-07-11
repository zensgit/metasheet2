# BA-UI-4 — Bridge Agent 计划任务运行态提示 · 开发/验证报告 — 2026-07-07

> Design-lock: `docs/development/bridge-agent-admin-page-design-lock-20260707.md`(#3792,RATIFIED;
> owner granted the full BA-UI ladder 2026-07-07)§3 BA-UI-4。前置:BA-UI-1 = #3824
> (`bridge-agent-ui1-observability-dev-verification-20260707.md`,门条件,已 merge)。BA-UI-2 = #3840
> (`bridge-agent-ui2-probe-dev-verification-20260707.md`,已 merge,本片复用其探测结果)。BA-UI-3 =
> #3858(armed,未在门条件内 —— BA-UI-4 的门只写「BA-UI-1」)。Demand anchor:#3746(保持 OPEN)。
> **本片是 BA-UI 阶梯的最后一片(BA-UI-1..4 至此全部完成实现)。**
>
> 本片 = 纯只读、FIRST VERSION 只读显示,不 start/stop、不本机 config、零新路由、零凭据路径变更、
> 零持久化(渲染皆从已有组件状态 + 固定文案派生)。

## 1. 范围与做法(vs lock §3 BA-UI-4 逐条)

| lock §3 BA-UI-4 条款 | 实现 |
| --- | --- |
| 「计划任务运行态提示」卡片,每系统一张 | 每张 Bridge Agent 状态卡内新增 `bridge-agent-task-status-<id>` 区块(探测证据下方、卡片内 sibling,不嵌套任何按钮)。 |
| 第一版只读显示,不 start/stop(硬锁) | 本区块**零按钮、零 service 调用、零本机 config 写**——见 §4 no-control 证明。 |
| 门 = BA-UI-1(仅此) | BA-UI-1(#3824)已 merge;BA-UI-2/3 非本片门槛,但本片确认复用 BA-UI-2 的探测结果(见下)。 |

## 2. 数据来源 vs 静态引导文案(逐条对账 —— 为何不是"造假")

design-lock 原文:「若计划任务状态未在任何既有 wire 上,渲染 values-free『由 Scheduled Task 管理 /
启动方式提示』静态引导块,而不是编造数据」。逐条核实:

| 卡片行 | 来源 | 判定 |
| --- | --- | --- |
| 「按部署惯例：本 Agent 通常由本机 Windows 计划任务（Scheduled Task）常驻管理，而非本页直接控制。」 | 固定双语文案(无插值) | **静态引导**,非实时状态。措辞刻意用「按部署惯例/通常」而非「现在处于」,避免给人"已核实该实例确实由计划任务管理"的错觉。 |
| 「最近探测结果（非任务运行态）：PASS / FAIL / 未探测」 | 组件已有的 `probeResults[system.id]`(BA-UI-2 `runProbe()` 写入的 `overallPass`) | **复用既有组件状态**,不是任务运行态的直接读数——标题与文案都显式加注「非任务运行态」,防止与"计划任务是否 Running"混淆。 |
| 「启动方式提示：安装/查看/启停计划任务由本机运维按 Bridge Agent 运维 runbook 操作；本页不提供启停或本机配置入口。」 | 固定双语文案(无插值) | **静态引导**,指向 `docs/operations/bridge-agent-readonly-runbook-20260521.md` 既有的 `-Action Install/Status/Start/Stop/Uninstall` 流程(文案本身不复述任何主机名/端口/路径/凭据)。 |

**为什么"计划任务是否真的 Running"这件事拿不到、也不该在本片编造**:BA-UI-1 的 backend scout 已经把
`testConnection()` 消费的 `/health` 响应形状钉死为 `{ ok, status, connected, authenticated, code?,
message }`——这里的 `status`/`ok`/`connected` 描述的是 Agent HTTP 进程是否可达,**不是** Windows
Scheduled Task 本身的 Running/Stopped/Ready 状态。`listObjects()`/`getSchema()` 同样不携带任务状态。
唯一能看到真实计划任务状态的地方是宿主机上的
`scripts/ops/bridge-agent-readonly-scheduled-task.ps1 -Action Status`——该脚本的设计说明里明确写着
它*故意*不调用 `/health`（要求 `X-MetaSheet-Bridge-Secret`,脚本不读/不打印共享密钥）。把 Agent 可达
性(`/health` 探测通过)包装成"计划任务在运行"会是一句站不住脚的断言;本片选择老实分开这两件事:一条
固定的部署惯例说明 + 一条明确标注"非任务运行态"的探测结果 + 一条指向 runbook 的固定引导。**不加新
后端路由**——把任务状态接到 Web UI 需要扩展 BA-M1 Agent 协议或新增一个宿主代理端点,超出本片(乃至整
条 BA-UI 阶梯)的授权范围,维持 lock §6"零开门"。

## 3. 组件改动

`apps/web/src/components/integration/IntegrationBridgeAgentSection.vue`(编辑,add-only):

- 模板:每张系统卡片内、探测证据块之后新增 `bridge-agent-task-status-<id>` 区块(§2 三行 + 一个
  `Clock` 图标),testid:`bridge-agent-task-managed-<id>` / `bridge-agent-task-last-check-<id>`
  (`data-result="pass"|"fail"|"unknown"`)/ `bridge-agent-task-guidance-<id>`。
- 脚本:新增 `taskLastCheckResult(systemId)`(读 `probeResultFor`,派生 `pass|fail|unknown`)与
  `taskLastCheckLabel(systemId)`(映射为 `PASS`/`FAIL`/`未探测`|`Not probed yet`——**故意粗粒度**,
  不像 `overallLabel()` 那样带失败步名,见 lock「coarse only」)。两者都是纯读取既有 reactive 状态,
  不发起任何新 fetch。
- 图标:新增 import `Clock`(`@element-plus/icons-vue`,已在依赖中,无需新增包)。
- 样式:新增 `.bridge-agent__task-status` / `.bridge-agent__task-note` / `.bridge-agent__task-guidance`
  三个 token-only 规则(`var(--ms-*)`/`--el-*` 全覆盖,零硬编码 hex);**刻意不复用**在线/离线徽章的
  颜色类,不给这块内容任何"绿色=运行中"式配色——这是静态引导 + 粗粒度探测结果,不是实时状态徽章。
- **零新增文件**:未新增 `.ts` 工具模块、未新增 fieldHints key、未新增 errorCodeLabels 码(本区块不
  渲染任何 code)、未触碰任何后端文件、未改 `.github/workflows/integration-guard.yml`(该文件的
  paths 与 vitest run 列表已在 BA-UI-1 收编 `IntegrationBridgeAgentSection.vue` 及其 spec,本片只编
  辑既有文件,無新 spec 文件名需要追加)。

## 4. No-control 证明(硬锁:第一版只读,不 start/stop)

- 代码审查:`bridge-agent-task-status-<id>` 区块内**零 `<button>`/`<input>`**,零 `@click`,零对
  `checkSystem`/`runProbe`/任何 service 函数的调用——三行皆为 `{{ bi(...) }}` 文本插值或纯函数读取
  组件既有 reactive 状态。
- 测试(`task status: renders the managed-by-scheduled-task guidance...`):
  - 断言 `card.querySelectorAll('button, input[type="button"], input[type="submit"]').length === 0`
    (查询**限定在本区块容器内**,而非整个卡片——同一张系统卡片本就含"检查连接"/"一键探测"两个既有按
    钮,是**兄弟节点**而非本区块后代,scoped 查询确保不会误判)。
  - 另断言全树 `[data-testid*="task-start"]` / `[data-testid*="task-stop"]` 均不存在。
- Mutation 证明(见 §6 变体 B):在本区块内插入一个假想的「启动」按钮 → 断言翻红(RED,1 failed,恰好
  是 no-control 测试)→ 精确 revert → 恢复 22/22 GREEN。

## 5. Sentinel 测试说明

在 `bridgeSystem()` 既有的敌意 fixture(`system.config`/`system.lastError` 均带 SENTINEL 串)之上,
新增一条**限定作用域**的 sentinel 断言(`task status: SENTINEL — ...`):驱动 check + probe(健康检
查故意返回敌意 `code`+`message`)后,只在 `bridge-agent-task-status-<id>` 容器的 `innerHTML`/
`textContent` 内断言全部 9 个 SENTINEL 值 + 6 个子片段(`SENTINEL-`/`Password=`/`token=`/
`authorityCode=`/内网 IP/`sharedsecret`)均不出现。与既有两条全页 SENTINEL 测试(§2.1 基线 + BA-UI-2
via-probe)互为补充——全页测试证明"哪里都不泄漏",本条额外证明"就算把敌意载荷灌进本区块能触达的每
个数据源(system 字段、probe 健康检查响应),本区块自己的三行渲染依然干净"。

## 6. Mutation 证明(基线 commit 后单独注入 → 跑 → 红 → 精确 revert)

基线 commit:`cee425f2a`(本片改动,提交于两次 mutation 之前)。

| # | 变体 | 预期 | 结果 |
| --- | --- | --- | --- |
| A | 在「启动方式提示」段落末尾插值 `{{ (system as any).lastError }}`(把 sentinel 敌意 lastError 泄漏进本区块) | sentinel 断言翻红 | **RED**(3 failed:§2.1 全页 SENTINEL + BA-UI-2 via-probe SENTINEL + 本片新增的作用域 SENTINEL 测试,三条同时触发)✅ killed |
| B | 在区块标题下插入一个假想「启动」`<button>`(`bridge-agent-task-start-<id>`) | no-control 断言翻红 | **RED**(1 failed:恰好命中 no-control 测试,其余 21 条不受影响)✅ killed |

两次注入各自单独执行 → `vitest run IntegrationBridgeAgentSection` 确认 RED → 用 Edit 精确还原插入点
(未使用 `git checkout --`,避免动到未提交内容——虽然本次两次 mutation 前已 commit,仍按纪律走精确
路径 revert)→ `git diff --stat` 确认工作树与基线 commit 零差异 → 重跑确认 GREEN(22/22)。

## 7. 安全边界 checklist(vs lock §2.1 / §3 BA-UI-4 逐条)

| 条款 | 状态 | 证据 |
| --- | --- | --- |
| 不 start/stop、不本机 config 编辑(第一版 out 项) | ✅ | §4 代码审查 + no-control 测试 + mutation B |
| 无凭据/host/连接串/token/secret 渲染 | ✅ | §5 scoped sentinel 测试 + mutation A;三行文案本身零插值(除 `taskLastCheckLabel` 的 `PASS`/`FAIL`/`未探测` 三选一固定串) |
| 无新增后端路由 | ✅ | 本片零编辑后端文件(`plugins/plugin-integration-core/**` 未触碰) |
| values-free 诊断 | ✅ | 最近探测结果只出 `PASS`/`FAIL`/`未探测` 三态,不带失败步名(见 §2 表格"coarse only") |
| 代理走既有 external-system 权限门,不碰中央 rbac/auth | ✅ | 本片零新 service 调用,复用 BA-UI-2 `probeResults` 组件内状态,不发起任何新 fetch |
| 不编造未暴露的数据 | ✅ | §2「为什么…不该在本片编造」——任务运行态本身从未渲染;文案措辞刻意区分「部署惯例/引导」与「探测结果」两类内容,且探测结果行显式加注「非任务运行态」 |

## 8. 测试与构建矩阵

| 面 | Node 25(默认) | Node 20(nvm,CI 同版) |
| --- | --- | --- |
| `IntegrationBridgeAgentSection` spec(BA-UI-1 10 + BA-UI-2 6 + BA-UI-4 6 = 22 tests) | ✅ 22/22 | ✅ 22/22 |
| `pnpm --filter plugin-integration-core test`(CJS 全链,本片未触碰但门槛要求跑一遍) | ✅ | ✅ |
| integration-guard 29-spec 全列表(`vitest run composition-vocab-mirror ... IntegrationCompositionWizard`) | ✅ 304/304 | ✅ 304/304 |
| `ui-foundation-style-guard`(TARGET_FILES 已在 BA-UI-1 收编本组件,token-only) | ✅ 83/83 | —(纯 fs 扫描,版本无关) |
| `vue-tsc -b` | ✅ clean | — |
| `pnpm build`(apps/web) | ✅ built | — |

CI 面:`integration-guard.yml` 的 `paths` 与 vitest run 列表**在 BA-UI-1(#3824)已收编**
`IntegrationBridgeAgentSection.vue` 与其 spec——本片只编辑既有文件,无新增 spec 文件名,**无需改动
workflow 文件**(遵照"仅新增 spec 名才追加"的纪律)。

## 9. 改动清单

| 文件 | 类型 |
| --- | --- |
| `apps/web/src/components/integration/IntegrationBridgeAgentSection.vue` | 编辑(add-only:计划任务运行态提示区块 + `taskLastCheckResult`/`taskLastCheckLabel` + `Clock` icon import + 局部样式) |
| `apps/web/tests/IntegrationBridgeAgentSection.spec.ts` | 编辑(add-only:6 个 BA-UI-4 tests) |
| `docs/development/bridge-agent-ui4-task-status-dev-verification-20260707.md` | 新增(本文) |

## 10. 边界外(维持冻结)/ 阶梯收尾

BA-UI-1(只读可观测)/ BA-UI-2(values-free 探测)/ BA-UI-3(配置校验 + 变更建议清单,#3858 armed)三
片各自独立 opt-in 且均已实现(BA-UI-3 待其自身 PR 落地)。**本片(BA-UI-4)完成后,design-lock §3 列出
的 BA-UI-0..4 全部切片均已进入实现或已实现状态——BA-UI 阶梯到此收尾。** 本片未新开任何后续切片、未
新增任何写路径或本机 config 编辑入口,lock §6"零开门"维持不变。后续若要做真正的 start/stop(第二
版),需要一份新的、单独 owner-ratify 的 design-lock(本片刻意不预留任何"半成品"钩子)。
