# SA-03E：K3 按物料 ID 查唯一 BOM 的自助入口

2026-09-30；代码基线 b35d4cd1 加目标§33本地增量。T层推荐按本合同实施；仅复用已有配置与运行权限，不授权真实客户读取、发布或部署。设计与实现分工作树保留，未来按GOV-08分开审阅。无新adapter、端点、角色、DDL、flag、K3写入或内部同步。

## 1. 已有能力与用户缺口

`read-source-bom-list-by-material-contract.cjs`已定义BL2完整合同；`read-source-read-runtime.cjs:470`调用真实唯一性判断，既有`/read`按read权限和approved配置执行。组合执行器也已经消费此能力。缺的是用户不用手拼配置、能独立诊断本次读取的入口，不能宣称后端尚未实现。

操作：K3内部数字物料ID（FItemID）→唯一BOM编号。不是物料编号、PLM图号或递归BOM；输入物料编号时应沿用既有两跳组合，不在本片自动转换。左侧probe只是容器/有限读取证据，空集合或多候选也可能probe成功；不能将其标成唯一BOM读取成功。

## 2. 具名配置快捷入口

在现有读取源Panel新增BL2独立模板模式，保留B4和普通向导/TC-1职责。模板固定：

```text
requiredKind=erp:k3-wise-webapi, object=material-bom-list, mode=resolver_lookup
readMethod=POST, operations=[read], keyField=FPercentItemID, keyEncoding=numeric_id
containerPaths=[Data.DATA], resolverRule=exactly_one
fieldMap=[{source:FBOMNumber,target:bom_number}]
```

version初始1，systemId仅从已登记active K3选择；不新造actionProfileVersion标签。默认readPath=/K3API/BOM/GetList；允许适配部署前缀，但必须通过现有安全相对路径规则、规范为前导斜杠，并严格以`/BOM/GetList`结尾；不得改终端端点/方法/过滤列或运行时传path。现有服务器允许这一前缀差异，不能把默认前缀误当所有部署的真理。

完整草稿比较包含隐藏/不适用于模式的字段；只有systemId和受限readPath可变化。进入/退出/切换模板清旧key、probe、save结果；保存只保存结构，不携带业务key。save不以probe或key存在为前提；独立审批才成为approved。探测显式点击并有真实读取提示，数字key不合法零POST。boundedSmoke默认OFF，探测与运行唯一性语义明确区分。

服务器返回的已保存行必须由完整row.config派生`k3Bl2Eligible`，核store version、systemId、object/mode/contentKey及全部配置字段，不信响应自带标记。本快捷入口使用固定target=bom_number；其他合法历史target仍可由原通用/组合路径使用，不冒称后端禁止它们。

## 3. 批准版本手动读取

独立运行子面板绑定列表中的approved版本及active K3系统，不读取左侧未保存draft。不自动POST、重试、轮询、同步或写缓存。输入`type=text/inputmode=numeric`，仅接受trim后1–20个ASCII数字字符串；不Number转换，不将业务ID写入配置、URL、日志、Storage或证据。按钮确认明确将访问真实K3，必须已获准的只读窗口。

仅POST已有`/api/integration/read-source-configs/:id/read`，body精确`{inputs:{key}}`；workspace沿现有query，绝无query/body tenant、principal、raw配置、rowSource、端点或写标记。apiFetch省略x-tenant-id，保持suppressUnauthorizedRedirect，不因失败降级或重发租户提示。

同一面板最多一个未settle请求。row id/version/contentKey/status/eligibility、system id/kind/status、tenant/workspace、刷新/退役generation、认证会话/权限变化或卸载均清结果和输入并拒收迟到响应；key修改清旧结果且废弃旧请求结果。失效不提前释放实际请求busy，也不声称服务端已取消；确认弹窗返回后再次核身份与资格。

## 4. 返回显示合同

成功必须HTTP及外层ok严格true，真实evidence为material-bom-list/resolver_lookup、ok/resolved/containerLocated true、rule=exactly_one、candidateCount=matchedCount=1、primary arrayLength=1。ambiguous/capReached/timeoutReached若存在必须false；不得把字符串布尔或矛盾状态当成功。当前resolver producer的boundedSmoke为false且缺boundedSmokeExecuted，这是实际证据形状，不强套B4的true要求或伪造执行证明。

数据仅接受data.resolver.target=bom_number；value为非空且最多4096 UTF-16单元的字符串（保留原值），或非负safe integer。拒null/空白/数组/对象/boolean/不安全数值；这是本界面的安全展示限制，不声称后端已拒所有此类值。不展示raw/extra、上游message、候选行或未选择BOM。

失败只显示精确注册的BL2粗错误码或固定通用错误。NOT_FOUND与AMBIGUOUS有明确提示，多条/到上限不能自动选；失败即使带data也不显示它。探测结果与本次唯一解析结果使用不同区域/文案。BOM值仅在授权会话界面显示，不进入values-free证据。

## 5. 必须补齐的共用生命周期

当前ConfigPanel的invalidateSession仅清列表，迟到probe/save/approve仍可更新。由于BL2复用这些函数，本片一并使会话变化清draft/key/save/probe/audit结果并使全部票据失效；每个异步完成回调核session签名，确认后核当前身份/配置。所有模式一致保护，B4和普通配置回归不能退化。此为收紧显示一致性，不扩权限；请求一旦发出不能假称撤销。

## 6. 作者分工与验收

服务作者：readSourceConfigs.ts的模板/完整资格比较；新k3Bl2Runs.ts及独立service测试。UI作者：ConfigPanel、新运行组件、真实Panel→service→apiFetch→合成fetch测试。第三作者：已有HTTP handler→真实store/registry/runtime/adapter、仅DB/vault/fetch为替身的BL2场景。主审负责登记、独立变异、浏览器、MD与冻结哈希。

测试必须由真实后端validator/prepare/evaluator或adapter产生正控制，不手拼全成功证据自证。覆盖默认/无前缀/自定义安全前缀、合同漂移、伪资格、数字精度及非法key零POST、审批/权限/scope拒绝、精确固定请求体、无匹配/歧义/上限/坏响应、会话与key漂移、确认取消、迟到成功与失败；真实HTTP证明不写缓存及K3。保存/审批/运行合同分开验证，不以UI确认冒充服务端授权。

已知非目标：通用prepare会先把数字key字符串化，可能掩盖unsafe-number原始类型；新入口只发字符串且拒数字调用，但不能因此宣称所有旧消费者已修复。源协议/真实连接可用性仍需另行授权验收。回滚只撤本UI/服务增量，不改已保存版本和后台执行器。
