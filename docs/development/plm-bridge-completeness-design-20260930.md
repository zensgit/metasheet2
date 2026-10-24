# SA-01E：Bridge 有限批读取不能冒充完整 BOM

日期：2026-09-30。技术修补合同，状态：限定实现及本地独立验证完成，未发布；基线为代码 worktree `b35d4cd1` + 已验证 SA-01D/SA-02B 等累积 dirty。沿用原权限与 plugin 分派，不新增端点、授权、网络能力或 Agent 协议。代码分支验证记录：`docs/development/integration-self-service-plm-bridge-completeness-verification-20260930.md`；不把本片完成等同总目标完成。

## 1. 实读及复现

Bridge adapter 会把 BOM 请求的 1000 行夹到连接实际 maxLimit（默认 20），并核对 Agent 回显的 limit。Agent 的 `/query` 无分页，固定返回 `done:true,nextCursor:null`。BOM readAll 未检查实际满页，真实 adapter→dry-run→apply 可把 A/B/C 的 A/B 当完整，新增两行并失活旧 C。即使完整 dry-run 后改成“刚好满页且行内容相同”，revision 也不会变化，旧 apply 能继续写；不能只靠 revision mismatch 挡它。

另外，adapter 把坏 records 转成空数组，通用结果封装会转换 done/cursor 类型。仅在 BOM 看标准结果无法辨识这些坏回包，故本批同时加强 Bridge 自身的协议校验，而不是读取 adapter.raw 绕过契约。

## 2. 两层强制

### Bridge 原始协议（适用于全部既有消费者）

- 原始响应必须是对象，records 必须显式为数组，数组每项为非空非数组对象；不得把缺失/错误容器变成空数组，也不得过滤坏项后宣称成功。
- 沿用现有 Agent echoed limit 验证：正整数且等于发送的实际 clamp。超出该 limit 的返回行拒绝，不截断掩盖。
- done 可缺省，若存在只允许 boolean true；false 是明确未完成而该协议没有续读能力，拒绝。其他类型不能被 Boolean 转换接受。
- nextCursor 只接受缺省/null/空字符串。非空或非约定类型拒绝，不透传、不跟随。请求侧非空 cursor 同样在 fetch 前拒绝，不静默丢弃。
- 错误沿用 `BRIDGE_AGENT_REQUEST_FAILED`，只带固定字段/原因和必要计数，不带回包、记录、地址或游标值。合法满页仍可作为 bounded sample 返回，不能把抽样本身误禁。

### BOM 完整性（共用 readAll，覆盖普通与后台）

- 根据实际 adapter.kind、正规化 readPlan.sourceKind 或已声明的 Bridge metadata.source 识别 Bridge；任何一个声明 Bridge 都只能收紧，不能靠丢 metadata 绕过。
- 要求合法 metadata.limit，按实际 applied limit（不超过本次请求上限）判断，使用原始 records 数量，在客户端过滤/展开/去重之前核验。
- 只有原始行数严格小于实际限额、无未完成/续页声明的合法页，才可作为该次查询完整结果；空数组正例保留。
- 满页无法证明完整，即便恰好只有这么多行、done:true 或自带 total/count 也拒绝。Bridge 当前无可信总数传播，不引入 declared-total 例外。
- 新全局类型 `read_completeness_unprovable` 纳入 INCOMPLETE_READ_ERROR_TYPES，不纳入 LARGE_BOM_BOUNDED_ERROR_TYPES。普通路径 canApply=false、不签 token，强行 apply 的真实重读也拒写；后台不得封 authoritative artifact。
- B2a 复用已有“任意全局错误→C6_FULL_BATCH_INCOMPLETE / source_read_incomplete”结果侧拒绝；不为本片扩大授权或改变其他原因映射。SQL 的合法分页和 SA-01D 断游标规则不变。

沿用 readonly-source-run 的实际限额/SHORT_PAGE 语义，但不从 latent GIP profile 导入运行时代码，也不引入通用 SDK 或新的执行层。本片不承诺跨多次查询的数据库一致快照。

## 3. 版本与用户影响

原始协议硬化改变适配器语义，implementation 升为 `bridge-readonly-adapter.v3`，latent profile 升为 `bridge.bounded_read.v3`。只升 implementation 不足以废止旧资格；必须证明旧 v2（及保留的 v1）资格在新版 resolution 下摘要不匹配。profile 保持 latent，SHORT_PAGE 仍是唯一证据。

已到 maxLimit 的 BOM 查询会从“错误成功”变成失败。不得建议无条件提高限额或反复重试；需要经受审配置让每次查询可证明完整，或另行设计/验证分页协议。本片不会部署、扫描客户存量或自动切换连接。

UI 现有失败展示可能仍是泛化文案；本片至少保留可诊断的 values-free 错误类型，不承诺完整的新增诊断界面。

## 4. 验收及责任

- 先在真实 adapter→expander→dry-run→planner→内存 apply 上取 RED，仅替换 Agent fetch 与目标持久边界；全局 fetch sentinel 保证无真实请求。
- 满页有遗漏/刚好完整均拒；根与递归、旧行失活、强行匹配 token、相同 revision 后 applied-limit 改变、后台失败均覆盖。合法空/短页、SQL 分页正例保留。
- 原始 records/done/cursor 类型、超限、limit 不匹配、请求 cursor 在发网前拒绝；依实际协议更新假件，不把测试删除或重贴标签当修复。
- 协议守卫、完整性守卫、B2a/后台消费者与资格版本失效分别做行为变异；作者与独立审查分开。新 suite 登记实际 CI 清单，provenance 按实际模块核对，不臆测 pin 清单。
- 仅本地开发及合成测试，禁止客户 DB、真实 Agent、读取凭据/.env、外部发送、提交、推送、PR、合并和部署。总目标未因此缩减或完成。
