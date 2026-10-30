# SA-01F：BOM 头状态与后台制品算法版本

日期：2026-09-30。状态：限定实施合同；基线为代码 worktree `b35d4cd1` 加已验证 SA-01E 等累积变更。仅既有备料读取/应用路径，不新增权限、端点、DDL、开关或外部发送。

## 1. 业务证据纠偏

本地备料源码 `后端/stockorder/src/main/resources/mapper/slave1/Bom.xml:38-51` 的子件读取对 BOM 头使用 `nullif(bom_able, 1) is null`，即 null 或 1 活跃。订单/按图号/递归物料联结均未按 isable 过滤。

同文件 `:90` 的 `isable=0` 仅用于图纸数量统计；`ExportProductDrawTypeInfoController.java:162-166、191-203` 计数为零仍读取子 BOM。因此本轮不新增 part.availability，不把仓内 preset 的字段知识当成已获准迁移的业务过滤规则。物料日期和 BOM 明细失效也没有已确认字段/比较时点合同，不臆造。

真正差异：当前 isActiveBomHead 把缺字段、空字符串、未知文本、对象及数字 2 视为活跃。真实 expander 在普通及订单指定版本路径均会展开其子件。

另有持久结果边界：旧大 BOM completed artifact 与 checkpoint 不再重读源。只改新读取不会废止修前的误展开/不完整结果；必须同时阻止旧算法制品继续执行，不能仅补一条部署备注。

## 2. 既有 activeField 的三态合同

不增加通用条件表达式或新的配置 schema。既有 bomHead.activeField 继续由用户映射列名；未声明该角色时保持明确的“不按头状态过滤”。

已声明时，在父项/版本/所属文件夹过滤之后，验证相关头的状态：

- 活跃：真实 null、number 1、boolean true、字符串 trim 后为 `1`。
- 停用：boolean false、除 1 外的有限 number；兼容既有文本停用别名，trim/lowercase 后为 `0/false/n/no/disabled/inactive`。
- 无法解释：缺字段/undefined、大小写匹配歧义、空串/空白、未知文本、数组/对象、非有限 number，固定 global 拒绝。不得转成 inactive、rowError/manual-confirm 或 large-BOM scale。

这是本应用支持的驱动表示，不声称模拟所有 SQL 隐式转换。`01`、`1.0`、`true` 等字符串不偷偷转换为数字/布尔真。数值 2 不展开符合旧 SQL 谓词；未知文本全局拒绝避免错映射后把所有旧子件失活。

错误用固定 `BOM_HEAD_ACTIVE_VALUE_INVALID`，不带原值；复用两处已有 catch → global read_failed。明确停用仍允许正常业务对账/失活，不能把“永远禁止所有写”伪装成修复。订单指定版本但无活跃头，继续已有 order_bom_version_no_active_match。

## 3. 后台制品代际，不能给旧结果补盖新章

单一服务器常量由 BOM 模块导出：`STOCK_PREPARATION_BOM_EVALUATION_VERSION = 'stock-preparation-bom.v2'`。它代表包含本轮与此前版本/归属/完整性修补的算法代次，不是 source schema、配置版本或运行授权。

- 新建后台 job 记录服务器当前 bomEvaluationVersion。实际调用生产 expander 完成后，artifact 才记录同版本，版本进入 artifactRevision。
- run 入口核 stored job 版本；缺失、旧值、未来值、类型错误均固定 409，在读源和任何状态写入之前拒绝。completed 旧 job 不能走提前返回重新宣称有效。历史 job 不自动补字段、不自动重新读取。
- 权威 expansion 必须同时具备现有完成/权威条件，以及 job/artifact 的当前精确版本。公共投影 authoritative 使用同一判断；GET 历史内容/状态仍可查看，不删除原数据。
- 新 plan 从已验证 expansion 继承版本与源 artifactRevision，并进入 planRevision。权威 plan 须版本一致且确实绑定当前 artifactRevision。重跑 expansion 必须清掉旧 plan/planRevision/planEvidence，不沿用旧批准结果。
- checkpoint 从经过上述校验的 plan 继承版本；每次 runChunk 在任何 create/patch、状态变更或 terminal 提前返回之前，核 stored version。请求体字段不能覆盖或补齐旧记录的版本。创建/运行 checkpoint 的原 permission、scope、锁、人工确认和写边界不变。
- 不能把常量只塞进“两侧都用新代码重新计算”的 actionContract 来冒充旧算法身份，也不能用 normalizer 给缺版本行补当前值。无需修改当前 action 配置或借新版本扩大读取对象。

该代次只防正常可信存储中的旧结果复用，不是防恶意同进程代码/直接篡改私有存储的密码学签名。已经完成的旧写入不会被撤销；部分应用的旧任务需获准业务对账后创建新任务，不能从旧 checkpoint 接着跑。混合新旧服务进程上线的部署策略另需运维控制，不声称旧二进制会遵守新门。

“拒绝前零读/写”以 jobs 模块入口为界。现有 HTTP execute 在调用 jobs 前会执行 B2a 授权/领取和 adapter 加载，chunk 路由也会先做目标只读预检；本刀不改这些授权顺序，不声称整条 HTTP 请求完全没有 bookkeeping 或目标查询副作用。旧结果不得到达真正的源 read 或目标 create/patch。

## 4. 真路径验收及写集

1. 两种字段命名、普通根/递归/子树；null/1/'1'/true 正例，0/2/false/旧否定别名停用，缺字段/未知/结构错误负例，未声明角色的兼容。无关父项/版本/文件夹的坏状态不阻断本项目。
2. 真实 expander→dry-run/planner→apply：坏状态无 token，强行 token 仍零 create/patch；已有子件不被误失活。已明确 inactive 的真实失活正例保留。后台坏状态不封 authoritative。
3. 真实 create→expand→plan→checkpoint→chunk 正控制；合成修前存储行（缺版本）、旧/未来/错类型版本，分别从 load后的真实入口拒绝，计数证明零源读/目标写/状态更新。旧 completed 提前返回、旧 paused checkpoint、版本只在 job/artifact/plan 一处丢失分别隔离。
4. 至少对三态兜底、两个消费者、job/artifact/plan/checkpoint 各门做独立行为变异；控制组先证明真实路径。保留旧 Bridge/断游标与执行身份套件。

实现 A 仅 owns BOM expander、相关 BOM/subtree 测试、既有 SQL 夹具注释。实现 B 仅 owns large-bom-jobs 与其相应测试；额外 fixtures 先说明路径再授权。独立作者/审查者拥有新增真链 suite；主审拥有 test-chain、文档、最终集成验证及其他共享文件。所有人保留累积 dirty，不共写生产文件。

## 5. 发布与未完成边界

上线后所有没有当前算法版本的历史后台 job/制品/checkpoint 将不可继续执行，但保留审计历史；必须明确列入部署检查。已配置 activeField 却缺列的旧读法也会拒绝，需受审修正映射，不能自动删除角色来放行。

本轮只使用合成数据和私有内存存储测试；不连接客户或现有数据库、不读取凭据、不发送、不提交/发布/合并/部署。总目标继续 active，SA-02 在线管理权限裁决与其余阶段没有因此完成。
