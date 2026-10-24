# SA-01：K3 本地修复与追加发布记录

日期：2026-10-24。范围仅为既有草稿 #6323；下游为 #6324，#6337 保持封存。

Owner 本次允许将已验证补丁与 MD 普通追加到 #6323/#6324、核对叠层和 pin 后运行既有合成 CI；不强推、不新增切片、不合并、不部署、不读取客户数据、不真实发送。此前文档中的“仅本地、未发布”描述保留为当时的历史事实。

## 修复与基线

本地检查点 `b92cbd908d31cbad95f30d4cc45ebc370b323533` 保留原 #6323 `1370b2d96f1e9edf0c36c322ac1156de0f02410f` 的祖先关系及冻结 main `771170234e95ff67c0b1d32b2e4929c08d7ee39e`。已提交的第一跳 BL2 数字校验继续保留。

本次三文件 K3-F1 补丁在组合读取第二跳、`String()` 前拒绝绝对值超过 `Number.MAX_SAFE_INTEGER` 的数值，使用既有 `READ_SOURCE_COMPOSITION_HANDOFF_VALUE_INVALID`。精确长数字字符串继续可用；非 BL2 下一跳合法的安全幅度小数仍按原合同处理。新增测试走真实 planner/runtime/注册 HTTP handler，仅来源和存储为合成替身，不声称实际客户连接或 JWT middleware 验证。

## 已执行证据

- composition planner、composition runtime、composition config、BL2 runtime、HTTP routes 五个完整入口均 exit 0。
- 单点删除第二跳数字守卫后，planner 与 HTTP 两个独立测试入口均 exit 1；每次实际变异命中 1，网络调用 0，原生产源字节不变。
- 历史证据位于 `artifacts/k3-f1-verification-20261024/summary.json`，包括首次代理连接失败后的独立复验；没有以成功结果删除先前失败材料。
- 来源策略配置轮在此父树重新执行 planner / HTTP routes 两个整入口通过；PLM 的 299 套链、257 条前端及来源策略变异属于子层，不作为本父层全量 CI 结果。

当前重新取得的 main 为 `fdb30a671686db8dbdbdf606f3a6f1b98add9969`，新增考勤和登录修复。将以普通 merge 对齐，再在最终父/子候选分别检查实际 provenance 与相关门禁。本文尚不宣称该最终组合或远端 CI 已通过；后续结果追加记录。

回滚只撤回本切片修复和入口，不撤回已合入 main 的宜搭基础层，也不开放 K3 写回。外部发送开关保持关闭。
