# SA-03B：B4 响应、分页与备料入参闭环

2026-09-30。本地实施合同，沿用既有读取授权，不增加端点、凭据能力或外部写。上位目标为 `integration-self-service-adaptation-goals-20260930.md`；前置为 SA-03A 固定请求合同。代码基线是 `b35d4cd1fbaa50d0cf15e1a75745f77624a9468a` 加前片验证报告所列九文件冻结 SHA，非已发布状态。

## 1. 真实业务缺口

在前片候选代码上，真实 B4 builder → validate/prepare → `runErpMaterialReadonlySource` → configured runtime → K3 adapter（仅 fetch 为合成边界）→ intake，一条合法五字段返回也会报 `SOURCE_RUN_REQUIRED_SHAPE_MISSING`。`read-source-read-runtime.cjs:153–179` 只输出 fieldMap targets，B4 只有 `FUnitID→baseUnit`，因此 `stock-preparation-readonly-intake.cjs:260–265` 要求的物料编号与内部 ID 全丢。

B4 模板 `read-source-k3-material-list-b4-contract.cjs:43–54` 明定另外四列由 intake aliases 识别；其旧测试 `:69–81` 手工 spread projected 再映射，未经过真实 mapper。修复应落实该既有合同，不修改模板/contentKey，不给通用 mapper 增加任意字段透传。

独立合成响应探针还证实：

- 固定 `Data.DATA` 缺失、null、非数组，可在 adapter_records 分支降成零条成功；混合坏元素会被 adapter 过滤，或改用 `Data.Data` 的非批准路径。
- 显式错误 StatusCode 可被正向 Data.Code / 连接 successPath 盖过。
- 请求 10 行，响应 PAGESIZE=5 且返回 5 行、无 ROWCOUNT 时，feeder 按请求量 10 判短页，漏读后续页。
- 已提供但非法的 ROWCOUNT 会被正规化为“不知道”，继续按短页宣称完整。

目前合法 B4 的身份丢失先使公共 source-run 失败，所以这些探针不能证明已经造成持久化脏数据。HTTP persist 在 source-run 成功之后；修复身份后必须同时堵住这些完整性问题。

## 2. 冻结实现合同

### 2.1 只落实 known B4 的数据投影

从既有受审五字段集合选取自身字段，保留四个 intake aliases，再应用既有显式 FUnitID→baseUnit 映射，不重复输出 FUnitID；额外字段、原型字段、响应 envelope 均不得透传。raw/adapter_records 两腿结果一致。普通 absent/unknown profile 继续只输出 fieldMap targets。

不增加 FUnitID 逐行必填/非空/新类型限制：现合同只要求显式映射，缺失为 null、全部没有解析则由既有 feeder 拒绝；optional 单位和其他业务规则不借本修复更改。

### 2.2 两消费者共用响应检查

只对 known B4，在 adapter 返回之后、probe success 或 configured rowSource 分叉之前验证：

- own `Data.DATA` 必须为数组，全部行必须为 plain object，不在 slice 后才检查。缺失使用现成 CONTAINER_NOT_FOUND；错误形状使用 SHAPE_MISMATCH；超过实际请求上限使用 CAP_REACHED。合法 `[]` 与缺失/null 不等价。
- 对 adapter 已返回的结果，明确出现的 StatusCode/statusCode 必须可解析为安全整数 2xx；不能由 Data.Code:Y 或 successPath 覆盖。该后验检查沿用固定 RESPONSE_UNRECOGNIZED 粗码，不输出上游消息。adapter 自身先拒绝的业务失败仍沿用 REJECTED，不为统一粗码而重写 catch 或猜测不可见的响应。缺 StatusCode 时不顺手重建整个认证/成功协议，仍沿现 adapter 判定。
- 已出现的 PAGEINDEX/pageIndex/PageIndex、PAGESIZE/pageSize/PageSize、ROWCOUNT/rowCount/RowCount 必须为有效安全整数；同组别名相互一致。index 为 1–10 且等于实际请求，size 为 1..request.limit 且不小于本页行数，total 非负且不少于当前页返回行数。没有引入新的 Data.Total 等别名。
- adapter records 与固定原始容器不能互相矛盾；输出只取批准的数据投影，不接受另一容器“补绿”。

单页探针没有回显时不谎称完整性，合法空数组可成功。完整 source-run 对 B4 还必须有真实页大小回显；原有页号回显门继续有效。

### 2.3 复用既有分页证明

known B4 的真实 dataPageSize 进入内部 page.effectiveLimit，feeder 使用已有 adapter-reported-limit 合同；请求10而源页大小5时按5判断满页，继续取下一页。大小未知不能退回请求量猜完整。同一次 B4 page-index 序列的实际页大小必须稳定；5→10 或10→5 会改变偏移含义，复用 PAGINATION_INCONSISTENT 拒绝，不能把两种分页口径相加称完整。保留原 total 一致性、累计数量、重复页、页数上限和末页证明，不另造分页器。

合法多页最终进入真实 ERP intake，ready 含正确身份、名称/规格/单位；合法首空仍由既有业务门报 SOURCE_RUN_EMPTY。坏首/中/尾页不能返回 ready；既有 HTTP 持久化前置不改变。

## 3. 实施与证明

一个 Sol 持有 profile、probe/read runtime、feeder 及响应矩阵；另一个 Sol 独占新的 source-run 真链 suite。独立只读审查者对固定候选核消费者与变异；主审负责登记、完整回归和证据，不与实现者并写生产文件。

首先已取得真实纵链 RED（合法行缺物料身份），再要求 1 页、10+1 页、5+2 页、空终页、第二连接复用正控制；坏容器/混合行/错误业务码/矛盾或缺失回显/重复页/总数变化/页上限负例。only fetch 可为替身；prepare、adapter、runtime、feeder、intake 和 public projector 都用生产函数。公共结果须 values-free。新投影、两响应消费者、真实页大小传播和必需回显各自独立内存变异致红；前轮7项也须维持。

不改 K3 adapter 通用 null/PascalCase 兼容、detail/BOM/BL2、B4模板、C6、永久写禁令、租户/owner/原审批。没有新 UI；当前 source-run 的路由可达性/真实部署仍需后续完整验收，不将纯 source service 合成成功写成客户在线成功。

无迁移/数据回填。未来回滚本片会恢复身份丢失/异常响应降格风险，不删除配置或历史记录；不自动去掉 B4 profile 绕过守卫。真实存量盘点、客户读取、发送、PR/合并/部署仍需独立授权。

## 4. 本地实施结果

本片已实现并独立审查收敛，当前状态为本地合成验证，不是已发布。新响应9项、真实纵链14项通过；八文件 runner42/42，18项新旧内存变异均被断言抓住。242套插件为241 Windows + 1 WSL，唯一Windows路径分隔符失败未改测试；前端109、CI登记68、validate:all与完整provenance通过。本片六文件冻结SHA、实跑边界和存量行为变化见代码分支的 `docs/development/integration-self-service-k3-b4-response-verification-20260930.md`，上位目标§24同步；不把纯服务链验证当完整HTTP/客户验收。
