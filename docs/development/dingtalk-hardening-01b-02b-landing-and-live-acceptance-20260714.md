# DT-CLOSE-01B/02B 落地与 live 验收记录（2026-07-14）

> 状态记录，事实截至 2026-07-14。承接
> `dingtalk-hardening-v1-runtime-closeout-design-and-verification-20260713.md`（目标级设计）与
> `dingtalk-hardening-switch-ruling-ledger-20260713.md`（开关台账）。

## 1. 落地序列（逐窗，每窗 Opus 对抗审 APPROVE + CI 全绿后单独 arm）

| 窗 | PR | Merge SHA | 内容 |
|---|---|---|---|
| 1 | #4277 | `fab40e848` | **OAuth state 指标真生产者**：`metasheet_dingtalk_oauth_state_operations_total{operation,result}` + `metasheet_dingtalk_oauth_state_fallback_total{operation}`（`packages/core-backend/src/metrics/metrics.ts`），`generateState()`/`validateState()` 插桩（`auth/dingtalk-oauth.ts`） |
| 2 | #4253 | `35488cbfb` | 稳定性检查 metrics-only 降级（DT-CLOSE-01B）终版 + **summary.py 同 PR 迁移** + summary/workflow-contract 测试接入 `plugin-tests.yml` |
| 3 | #4255 | `983802abf` | retention 契约修正（DT-CLOSE-02B）终版 + 文档状态修正 |

分支已随合并自动删除。

## 2. 关键设计决策（为什么这样做）

- **零值预初始化（#4277）**：检查脚本的 `matching()` 只匹配**样本行**（`line.startswith(<metric>)`），
  `# HELP`/`# TYPE` 不算；而 prom-client 带 label 的 counter 在首次 `inc()` 前不输出样本行。
  因此所有 label 组合在注册时初始化为 0——**零流量窗口也必须能证明 producer 活着**（liveness 信号，
  不是流量信号）。mutation 证承重：注释掉零值初始化 → boot-presence 测试变红。
- **fallback 语义**：`fallback_total` 只统计「共享（Redis）store 不可用而改用进程内存」的降级；
  Redis 配置下的正常 miss 落内存不算。shared-required 模式先记 `result="error"` 再 fail-closed。
- **三态 `alertDeliveryObservability`**：`observed` 仅当全部拓扑探针成功 **且** webhook `configured=true`；
  `:9093` 拒绝、webhook 未配置、或任一 docker-logs 探针失败（含 bridge 容器缺失）均为 `deferred`。
  告警拓扑维持 deferred by design，**不参与 health verdict**。
- **summary.py 与 verdict 同门**：失败原因严格镜像 verdict 三门（health / oauthMetricsPresent / storage）；
  webhook/Alertmanager 一律降为 `alertDeliveryObservability` 键控的信息叙述。永久 pin：
  `oauthMetricsPresent=false` 时必须点名指标缺失、必须不出现 webhook 归因（曾经的掩盖路径）。
- **日志探针 fail-honest**：远端管道 `set -o pipefail`（经 `bash -c $(printf '%q' …)` 显式走 bash，
  不信任登录 shell）+ `2>/dev/null`（错误文本不可能被 grep 计数）+ `{ grep … || test $? = 1; }`
  （no-match 中和、真错误传播）；`wc -l` 恒 exit 0 掩蔽 docker 失败的路径已根除。

## 3. Live 验收证据（run 29326896286 @ `e8c37ec0c`，artifact `stability.json`）

- 连续两次 scheduled run **SUCCESS**：run 29319848894（08:56Z @ `73b3796cf`）、
  run 29326896286（10:52Z @ `e8c37ec0c`）——两 SHA 均包含全部三个 merge（ancestry 已验）。
  此前最后一次旧管线 run（06:58Z @ `e97068b72`）为 failure——直接死因是旧脚本对 Alertmanager
  `:9093` 的硬依赖 curl 中断（rc=7，无 JSON），#4253 的软探针修复了它；producer 缺失是软探针
  落地后本会暴露的下一层原因（该 run 的 SHA 也未含 producer）。
- `healthy: true`、`oauthMetricsPresent: true`：deploy host 的 `/metrics/prom` 上
  `operations_total` 4 条样本 + `fallback_total` 2 条样本，值全为 0——零值预初始化在生产精确生效。
- `alertDeliveryObservability: deferred`：host 上 webhook 配置文件存在（`configured=true`）但告警
  拓扑不完整——三态逻辑正确拒绝 `observed`（full-script 测试 state-4 行为在生产复现）。
- 部署链：docker-build（build+deploy job，SSH 到主机）在每次 main push 后成功——producer 自
  `fab40e848` @ 07:48Z 的部署起即在主机上（08:15Z @ `983802abf` 为三合并齐备的锚点），
  无需人工部署步骤。

## 4. 剩余收官项（全部 owner/ops，开发侧无遗留）

- 开关台账负责人填充（`_TBD_` 行）。
- U1–U13 真企业 UAT + 真 callback corp-anchor 证据（values-free）。
- must-verify-enabled 开关逐项裁决（OAuth shared-state / retention 窗口 / alert webhook 送达验证）。
- 两项挂账 ownerDecision：告警拓扑是否补部署（补齐则 observability 翻 `observed`）；
  Stream worker env 关闭不停已运行实例的 caveat 是否改 runtime。
- Milestone-2（Canonical Org & Provider Transfer v1）维持 HALTED，Hardening v1 真 DONE 后启动。
