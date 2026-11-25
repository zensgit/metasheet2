# SA-04C：宜搭本地字段目录、七项身份与数据 DTO 预演

日期：2026-09-30。状态：本地实施合同；承接 SA-04A/B，不是 SA-05 认证/发送授权。代码候选基于 `b35d4cd1fbaa50d0cf15e1a75745f77624a9468a` 叠前序未提交切片；本次核远端 main 为 `04de335490656d689361a692d044a10611cf684d`，发布前仍须对齐。

## 1. 必须补的真实差距

旧源码快照路径相对 `后端/stockorder/src/main/java/yaguang/stock/order/`，不是受版本控制的发布依据：

- `controller/StockInfoController.java:1867–1886` 使用项目、图号、名称、规格、材质、版本六项查询，再比较父图号；数量不属于身份。当前静态 v1 只容纳五项业务键，无法表达这套业务身份。
- 父图号仅本地 null 转为空串；其它字段的缺失/null/空串没有已证明的等价关系。远端父值直接 `.toString()`，空值可能抛错。新合同不能将所有空白都默默合并。
- `util/DingUtil.java:84–109,147` 分别设置创建 `appType/formUuid/formDataJson` 与更新 `appType/formInstanceId/updateFormDataJson`；其中 JSON 参数是字符串。SDK 为 `com.aliyun.dingtalkyida_1_0`，不把网页 JS API 的 `formInstId` 混入这个 DTO。
- `controller/CraftInfoController.java:196` 的图号目标与备料名称目标相同，属于待核疑点，不移植；发料还更改本地仓库确认状态，不能被普通映射顺带执行。

旧代码中的凭据、目标 ID、主机和业务数据均不复制。旧查询后创建不是幂等；吞保存异常后继续计成功不继承。

官方[宜搭控件数据格式说明](https://docs.aliwork.com/docs/developer/api/openAPI)支持文本/单选为字符串、数字为 number，并说明未包含在更新数据中的组件保持原状。该网页是跨应用 API，不能据此证明服务端 SDK 路径、认证、客户表单或版本兼容。SDK 数据字段另核官方源；本片没有 URL/HTTP method、认证或可执行请求。

独立读码冻结官方 Go SDK 提交 `1986c966942afc67b8ccae59d29d57989a45fe76`：[Save 模型](https://github.com/alibabacloud-go/dingtalk/blob/1986c966942afc67b8ccae59d29d57989a45fe76/yida_1_0/client.go#L16927)、[Update 模型](https://github.com/alibabacloud-go/dingtalk/blob/1986c966942afc67b8ccae59d29d57989a45fe76/yida_1_0/client.go#L20382)及该文件 28688/30172–30184 的实际 body producer 一致证明字段名。模型还要求凭据/主体及独立认证 header，更新含其它可选执行参数；本片只展示不含这些参数的数据子集，不冒充完整可发送请求。没有复制 SDK 实现。

## 2. 版本与范围

沿用同一无 I/O `yida-static-plan.mjs`、类型声明和既有 Vue Panel。保留 v1 默认模式及原有五键/标量行为；用户显式选择 v2 协议候选模式，避免静默改变旧配置。两个版本复用描述符校验、输入上限、行映射与重复拒绝；不复制第二个发送器或 runtime。

v2 闭集配置：

```text
version: 2
kind: yida-form-protocol-static
target: { appType, formUuid }
intent: create | update
instanceIdField?: sourceField  # update 必填，create 不允许
fieldMap: [{ source, target, type, required }]
businessKey: [sourceField, ...] # 1–8 项
emptyKeyFields: [sourceField, ...] # 必填数组，可为空
fieldCatalog: [{ id, control: text | number | select | radio, required, options? }]
```

这是用户手填、未联网核验的目录，不叫获准表单目录。1–32 项，ID 不重复；select/radio 必须有 1–64 个不同、非空白、有界字符串选项，精确比较而非 trim/强转；text/number 不接选项。复杂控件、人员、子表、日期、附件和表达式不在本片支持范围。

每个映射 target 必须在目录中；number 对应 number，其余对应 string。v2 禁止重复 source（避免身份对应哪个 target 不确定）；目录必填项须被映射且映射标为必填。可选未映射目录项不写入。该目录不通过 ID 前缀推断类型，不证明真实厂商接受它。

## 3. 七项本地身份与不清空原则

用户可选 1–8 个业务键；材料合成样例选择项目/图号/名称/规格/材质/版本/父图号七项，第二套源字段全改名但目标目录相同。样例只是候选，不把客户旧字段 ID 烧进代码。

- 一般键缺失/null/空串/纯空白继续拒绝；类型不符不强转。
- 用户只能为业务键中的可选 string 字段显式开启 `emptyKeyFields`，允许缺失/null/精确空串在**本地身份**上等价。纯空白仍拒绝；非空字符串保留全部字节，不 trim/大小写折叠。
- 该规则不往 payload 插入空串，不产生远端清空意图；更新同样仅写实际非空的已映射字段。父项等价选项不能被解释为已核验的远端 null 语义。
- v2 本地键由版本标记、app/form、按 target ID 排序的类型和值组成；换源字段名但目标角色相同可稳定比对，改目标字段会改变身份。v1 源字段身份表示保持原样。
- 重复组全部无效；无效行不能带数据 DTO。不是远端查重、跨运行账本键、签名、执行令牌或 exactly-once 保证。

## 4. 创建与更新的数据片段

仅有效 v2 行新增：

```text
protocolPreview:
  contract: dingtalk-yida-1.0-data-only
  completeness: data_fields_only
  data: <below>
```

- 创建：`{ appType, formUuid, formDataJson: JSON.stringify(payload) }`。
- 更新：`{ appType, formInstanceId: <本地显式实例ID>, updateFormDataJson: JSON.stringify(payload) }`，不带创建字段 `formUuid/formDataJson`。

不收 token/systemToken/userId/header/URL，不生成可执行 HTTP 请求。UI 明示缺凭据、执行主体、权限/一次性授权、远端 schema 与存在性核验。即使 DTO 结构正确，结果仍 `not_applyable`、`canApply:false`、无 token、无 lookup、无 write；没有成功回执。

仅支持闭集控件，选项外的非空值使对应行无效。数值 0 保留为 number，不继承旧代码把单位后缀塞进数字控件的行为。JSON 字符串序列化保留引号、Unicode 等内容，不用拼接字符串。

原始数字保真是显式配置路径的前置，而非事后 `safeInteger` 检查：同一个 parser 接收可选配置参数，**传入 v1 或 v2 配置均扫描原始 JSON**（跳过带转义的字符串），比较各数字 token 与解析后十进制序列化的规范值，并拒绝解码后重复的对象键；仅未传配置的兼容调用保留旧 parser 行为。精度损失、下溢到零、负零及不安全整数拒绝，不将舍入结果展示成用户原输入。正常可往返的十进制如 `0.1` 可用；不声称所有二进制浮点运算精确。分配路径也传入同一配置，不能只保护被选作 quantity 的字段。直接传 JS 对象无法恢复调用前已丢失的词法信息，只有接收原始文本的 UI 链拥有此保真证据；直接 v2 对象中的不安全整数仍拒绝。此段于 2026-10-09 按当前抽取候选订正，不将旧报告的测试数量或哈希沿用为新候选证据。

## 5. 真实入口、分工和验收

现有 `StockPreparationYidaPreviewPanel.vue` 增加显式版本模式、两个七键样例、可编辑本地目录和空键策略。用户点同一个本地预演按钮，经真实 validator/planner 出结果；项目分配仍经实际 allocation → 同一 planner，可使用 v2 并显示 DTO。目录/映射/模式/输入变化同步清旧结果；原看板作用域变化卸载机制不变。

没有新增 route/action/RPC、宿主消费者、权限或持久化；本片不触发新增运行边界。未来 SA-05/06 仍须独立 GOV-08 决策与单独 PR，不借本地协议 DTO 绕过该门。本片与代码在已有两个隔离 worktree 分开，不提交/推送/开 PR。

任务风险 L3：一人负责核心三文件，一人负责既有组件/其测试；独立只读审查者核生产链和精确变异，主审整合验证。无 Grok 配置变化，也不声称用了未确认模型。

最低验证：

1. v1 原用例不退化；v2 七项分别影响身份、第二布局同目标身份一致、目标改名不同。
2. 父 null/缺失/空串显式等价但 payload 不清空，纯空白与非 string 拒绝，重复全组拒绝且没有 DTO。
3. 目录缺目标/类型不符/必填未映射/选项不符/重复/额外字段/accessor/超限分别有隔离负例；正例经过真实 production planner。
4. DTO create/update 字段集合精确、JSON roundtrip、0 保留；绝不夹带认证、假授权、动态 URL。
5. 真实 Vue DOM 操作目录、映射、样例、实例 ID、项目展开，输出可见后再断言零新增请求/零存储；全部编辑使结果失效。
6. 独立变异针对目录接线、空父项身份、不清空、重复 DTO 移除、正确请求字段；变异必须实际命中，不以源码 regex 自证。
7. 原 suite 已登记，若新增套件必须进入真实清单；相关回归、类型/lint、完整 provenance 和合成浏览器演示。测试证据只合成值，不替代客户协议/真实表单验收。

回滚：停用 v2 局部选项/移除新增分支即可，无连接、历史账本或远端状态迁移。SA-04 余下真实业务/表单适配、SA-05 发送与 SA-06 动作未因本片缩减。

## 6. 本地实施结果

本片已实现并完成本地范围验收：Node39/39、前端八套285/285、独立11项内存变异、实际浏览器生产构建；raw numeric精度缺口与一个目录测试隔离问题已修复。完整244套plugin为243 Windows+1原套WSL，保留平台失败而不放宽；validate/provenance/登记守卫通过。详细冻结字节与未证明项在代码分支 `integration-self-service-yida-protocol-verification-20260930.md`。无外部发送、发布、合并或部署；不是本目标整体完成。
