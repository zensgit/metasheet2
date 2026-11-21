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

## 对齐后的发布前门禁

实际普通合入 main 后的代码候选为 `39e73e1ee960c0b294a989a322790428cfa14c43`，父历史与原 PR 均保留；没有 rebase 或强推。两份前端必跑清单仅继承 main 的 `attendance-group-fixed-schedule`，保留全部原 K3 token；相对 main 的净差量与合入前一致。

从该提交显式选取 14099 个安全 Git blob 导出到新建 Linux native 副本，读取前排除 backend `.env`。仅对既有三个 CRLF 测试材料作与前轮相同的 LF 准备，实际被 pin 文件不在这三项内；Git 字节和测试副本哈希分列记录。依赖锁与既有 Linux 安装一致。原工作树及其他审阅 clone 未被重置。

- 完整 `sealed-export-package-provenance.test.cjs` exit 0，按最终副本实际字节校验，没有在哈希时替换行尾。
- 两个既有接线整文件共 **71/71**，0 failed/cancelled/skipped；这是接线检查，不是宜搭浏览器 70/71 项。
- 原 fail-fast 插件链 **287/287，exit 0**；运行前后 14099 个安全路径内容相同。
- 完整链 stdout SHA256：`1612d59d72b53e4cb93ad1eee51c228ad9c41567027a4b78e22894a61e3532e5`。本地详细证据位于 PLM 同轮隔离工作树 `tmp/publication-20261024/k3-summary.json`，不作为远端 CI 已通过的声明。

首次 Git fetch 被本机失效代理拒绝，随后仅对该 Git 命令禁用代理后取得当前远端；没有改全局配置。旧 CI、平台假红、浏览器及数据库清理失败记录仍保留，不能由本次插件链成功宣称这些历史根因全部已修。该轮不重复真实宿主/PG 验收，下一步运行既有正式合成 CI。
