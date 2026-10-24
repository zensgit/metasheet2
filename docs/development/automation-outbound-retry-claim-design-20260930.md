# SA-06A2：已有 outbound failed 重领的单赢家门

2026-09-30；T 层既有竞争 bug 修补。基线 b35d4cd1 加当前本地 SA 累积修改；仅本地开发和合成验证，不获准真实读取、外发、提交、发布、合并或部署。

## 1. 为什么先做这个前置

稳定执行 root 是 SA-06 必需条件，但不是充分条件。现 `claimOutboundIntent` 的 failed 分支先 SELECT 再 CAS UPDATE；UPDATE 影响0行仍返回 retry_failed。两个同 root/action 执行者读到同一 failed 时，会同时获准发送。先证明并修复该竞争，不能拿“根稳定”背书重复发送已解决。

## 2. 冻结行为

- 仅成功完成 failed→pending 的调用者才能返回 retry_failed；判据与 fresh insert 一致：明确 rowCount 数值为1。
- CAS 返回0、null、undefined、非1等无法证明赢者的结果，直接返回既有 skip_unknown。不得在本次调用里重新 claim、递归重试、退回 proceed、覆盖其他赢家状态或主动发网。
- CAS 抛错原样向调用方失败，不吞错后放行。先前已知 sent/unknown/pending、fresh insert 与 flag OFF 的合同不变。
- loser 不修改赢家状态；若两者都先读failed，赢者可以继续其一次尝试并持久结果。后来的第三调用者仍按现有 pending→unknown 保守策略，不能借本刀声称所有并发/回执/租约问题都解决。
- 只改已有 primitive 与测试；不新增端点、动作、消费者、权限、DDL、flag或翻转默认值。不能扩大为所有 Automation 动作完整幂等。

## 3. 必须证明

1. 作者在已有 primitive suite 取得修前行为 RED：受控 barrier 使两个调用都读取到failed，只有一个 UPDATE 赢，但旧代码两者都返回retry_failed；正控fresh、单次失败重试、sent保持。
2. 独立真实 executor + actual primitive 组合：同时重放同root/action的 webhook，SQL边界可替身，但不能 mock claim 或 executor。修前能证明两次 fetch，修后仅一次发送；loser failed/outcome_unknown 且依赖尾动作不执行，winner结果正常。
3. 在新建 disposable PG 上扩已有 outbound-intent realdb suite，使用真实SQL竞争。测试协调只暂停实际 SELECT 的返回，UPDATE必须由真实PG决定赢家；验证只有一次attempts增长和一次授权。若加实际executor PG链，发送边界必须合成且显式统计。
4. 独立移除rowCount门，必须使上述真实行为证据红；单测不能用没有真正互斥的假库声明并发安全。
5. 复跑所有 Class-B consumer/intent 回归、core 类型与定向lint、现有 provenance；测试只扩已有CI文件，不为本刀另开workflow。主审掌管唯一 disposable PG 运行器，不连既有DB/.env。

## 4. 与主目标及后续决定

SA-06仍需要可信请求身份、绑定配置/规则版本、结果持久化及取消/sink围栏。现有8个consumer与全部非幂等动作不因本刀获得可靠重放保证；不能把outbox eventId直接当成完整授权或运行根。新具名只读请求consumer/IntegrationRunPort另交GOV-08合同，并受SA-02在线管理权限决定约束；不静默新增权限入口。

回滚会恢复双重发送窗口，不能为恢复旧“绿灯”降级。既有ledger不清理、不回填、不自动重发unknown。
