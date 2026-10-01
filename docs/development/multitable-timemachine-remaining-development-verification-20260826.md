# 多维表 Time Machine 剩余开发与验证记录（2026-08-29 重写）

> **状态：D2-D7 DEVELOPED AS DRAFT / NOT MERGED / NOT ENABLED。**
> 本文是收口索引，不是部署、flag 或 production 授权。所有 Time Machine / recovery
> flag 保持 default-OFF；本轮未 dispatch、未部署、未触达 production。

## 0. 当前结论

- L1 已关闭，权威记录仍为
  `docs/development/multitable-timemachine-l1-closure-20260826.md`。
- 前置载体已按 `#5190 -> #5193 -> #5194 -> #5195` 串行进入 main。
- Phase D1 设计锁已按 owner 指定的 exact SHA-256
  `19f10cd8d7259861c75ee6d82af4f421f29b875101a5a2a583c0a73c67009caf`
  ratify，并随 #5199 进入 main。
- Phase D2-D7 已在 Draft/HOLD PR #5305 实现并完成本地、真库、mutation、独立复审和
  product-code 远端矩阵；报告头矩阵暴露的 scratch teardown 竞态也已修复。最终
  report-carrier exact-head 矩阵已终态通过，尚未获得合并、staging、flag 或 production 授权。
- E1、provider/KMS 选择、staging 运行和 production 仍是独立门。D1 ratify 或 D2-D7
  开发完成都不会自动打开这些门。

产品边界不变：归档只能保护可信捕获边界之后的数据。捕获前已物理删除、retention 已永久清除且
没有备份/外部归档的数据，不能由版本链或 Time Machine 凭空恢复。

## 1. 精确载体

| 项 | 精确值 | 状态 |
|---|---|---|
| current-main 基线 | `c479e9b321fe772149e367b5d90cb01c21654766` | #5305 merge-base |
| D1 设计锁 merge | `e0956fd5c13b5500ae68c2425b97706d8a761043` | 已进入 main |
| D2-D7 Draft PR | `#5305` | Draft / HOLD |
| 最终 product-code head | `73d3187c8b6be375c710ce38a92c42468c74c458` | product-code matrix PASS |
| 最终 product-code tree | `eb16faa33b49bcb4e7727bc5917a24a726d43254` | 独立复审绑定 |
| scratch-drain fix head | `e19b65041d9fd79a556bb58b0c40734b2066c874` | 真库连续复验 PASS |
| 最终 code/test tree | `6ac12d5efa2849faecdd4de32f4414574b90bb82` | 已冻结 |
| development + verification report head | `beeff6b3765cff463f8887d58f6b3fb11b8a5a61` | `48 SUCCESS / 1 intentional SKIPPED / 0 failure / 0 pending` |
| report-carrier tree | `73dc25034d60f950cf4f34277a837c98ecb77746` | code/test 字节与父头一致 |

详细开发与验证事实分别在 #5305 的：

- `docs/development/multitable-timemachine-phase-d2-d7-development-report-20260829.md`
- `docs/development/multitable-timemachine-phase-d2-d7-verification-report-20260829.md`

本文不复制完整测试 transcript；任何结论以冻结 head、工作流日志和上述两份报告的边界为准。

## 2. 已完成开发

### D2 归档权威

- closed archive/catalog/manifest/coverage 合同与 section 因果图。
- writer block、source pin、object receipt、key/nonce registry、AEAD/MAC 和 coverage binding。
- parent-last snapshot、独立 bootstrap operation、whole-operation prune 与 default-OFF flag 登记。

### D3 生命周期

- current-head catalog、legal hold placement/release、expiry/delete/key-retirement 权威。
- claim/fence/receipt 约束保持 fail-closed，不把 provider 网络调用放进数据库事务。

### D4 重建

- checkpoint + archived delta 的单一 authenticated reconstruction authority。
- generation/root/source-vector/section 完整性和 floor-aware replay 均有真库证明。

### D5 恢复执行

- owner-safe list/read/preview/execute/status/resume/cancel API。
- 小任务复用既有 exact-anchor/L8 destructive kernel；大任务使用 durable plan/chunk/receipt/job。
- immutable block fence 与 renewable worker fence 分离；支持重试、取消、接管和 job rediscovery。
- 5,001-record same-process takeover 证明逐 chunk 原子、exact-once receipt 和最终聚合；不冒充
  OS-process restart。

### D6 前端

- Time Machine picker、archive generation 选择、scope、diff、sync/async progress 和 durable job resume。
- sheet/generation/job 过期响应不会覆盖新上下文；malformed successful job-list response fail-closed。
- job-list wire 使用精确七字段、UUID、decimal、timestamp、terminal/count 和
  `totalCount > 5000` 合同，numeric JSON primitive 不被强制转换。

### D7 证据与运行手册

- staging-only runbook、fault/scale/local provider 证据和开发/验证报告已形成。
- application runtime 可注入 provider-neutral factory；exact-ON 且未提供 owner-selected factory 时
  启动拒绝，不静默选择生产对象存储或 KMS。
- startup/shutdown 与 worker lifecycle 已接 canonical server runtime；flags 仍 OFF。

## 3. 验证结果

| 门 | 结果 |
|---|---|
| 独立 exact-head refute-first | `0 P1 / 0 P2 / 0 P3` at `73d3187c8b` |
| archive client wire spec | `31/31` PASS；timestamp parse-only mutation 恰 `2` RED |
| D5-D7 unit/route/runtime | `18 files / 205 tests / 0 skipped` |
| required web | `406 files / 5,150 tests` PASS |
| fresh candidate DB restore-jobs | `1 file / 20 tests / 0 skipped`，DROP 后 residue `0` |
| shared full-schema cleanup regression | `10 files / 182 tests` PASS |
| key-registry scratch teardown | 连续 `4 x 10/10` PASS；每次 `scratchDrain=CLEAN`；prefix residue `0` |
| Node 20 archive roster | `14 files / 279 tests / 0 skipped` |
| #5305 product-code remote matrix | `48 SUCCESS / 1 intentional SKIPPED / 0 failure` |
| #5305 report-head remote matrix | `48 SUCCESS / 1 intentional SKIPPED / 0 failure / 0 pending` |

判别 mutation 至少覆盖：malformed envelope/entry、timestamp/decimal/primitive guards、
`totalCount > 5000`、worker drain、runtime factory、D2 child cleanup、immutable token burns、
daily job takeover 和 archive real-DB fail-not-skip wiring。删除承重守卫时目标测试变红，恢复后重绿。
首个 report-only 矩阵的 2,679 个 multitable 测试断言全部通过，但旧式 scratch 立即 terminate
在连接关闭尾声产生未处理 `57P01`。修复复用仓库统一 owned-pool + drain/drop helper，不把重跑绿
当作豁免证据。

## 4. 明确保留的边界

| 边界 | 当前含义 |
|---|---|
| production object-store/KMS factory | 未选型；必须由 owner 明确绑定 |
| staging fault/storage/KMS run | 未执行；本地 provider 不是 staging/production durability evidence |
| true OS-process restart | 未执行；5,001-record 证据只证明 same-process takeover |
| genuinely stuck worker stop | canonical loop 会 contain 普通 tick failure；无限卡住的 in-flight stop 仍需有界化 |
| malformed catalog-list `2xx` | 旧只读 catalog path 仍可能映成空列表，不能拿它证明“没有归档” |
| sheet-ID stale comparison | 与更强 generation/job guard 重叠，单独删除不具 mutation 判别力 |
| cross-sheet atomic restore / permission restore / system sheet restore | 不在本阶段授权范围 |

这些边界均不是启 flag 的豁免理由。任何 staging 结论必须绑定 exact build、provider/KMS 配置、
运行时间窗、日志/APM source 和 residue；不能用短容器日志代表完整观察窗。

## 5. 后续 owner 门

1. #5305 `beeff6b376` report-carrier exact head 已以
   `48 SUCCESS / 1 intentional SKIPPED / 0 failure / 0 pending` 终态通过；该证据不自动授权合并。
2. owner 审阅 #5305 的 exact report head、代码 tree、独立 verdict 与 residual table，再决定是否允许合并。
3. 若允许合并，在 then-current main replay/range-diff，保留 workflow/test union，重新跑 required CI、
   Node 20 archive roster 和真库门。
4. 另行选择 staging provider/KMS 组合并授权 staging-only fault/restart/runbook；仍不触及 production。
5. flag 启用、production 部署和真实恢复各自需要新的明确授权，不能由 Draft 合并推导。

## 6. 协调与未做事项

- 审批流程及自动化队列继续独立 HOLD；本线未合并其 PR、未修改其 flags 或部署状态。
- 云课堂仅使用已串行分配并归还的 shared/DB 窗口；其代码未混入 #5305。
- 未 merge/auto-merge/undraft #5305。
- 未 dispatch、未 SSH、未部署、未启任何 recovery/archive/retention flag。
- 未触达 production，未声称 staging acceptance，未恢复无来源历史数据。

因此当前可准确表述为：**Time Machine D2-D7 开发与独立验证完成于 Draft/HOLD 载体；
provider、staging、merge、flag 与 production 门仍关闭。**
