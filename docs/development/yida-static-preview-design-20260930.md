# SA-04：宜搭字段配置与零发送静态预演

日期：2026-09-30。状态：本地实施合同，独立文档分支；尚未发布或部署。上位目标为 `integration-self-service-adaptation-goals-20260930.md`，本片不替代 SA-05 外部发送授权决策。

## 1. 范围与真实接缝

代码基线 `b35d4cd1fbaa50d0cf15e1a75745f77624a9468a`；SA-01/02/03 本地修改保留。

- 项目备料页 `StockPreparationProjectBoardView.vue:369–381` 有明确禁用的宜搭推送占位。保留它，在旁增加“宜搭静态预演（不发送）”，不把原按钮改成可执行发送。
- `services/integration/stockPreparation/projectBoard.ts:40` 的 board 只有项目身份、计数、时间和内部句柄，没有材料行。本片不为预演新增读取，不自动把当前项目号当成输入行。
- 现有 `IntegrationPayloadPreviewSection.vue` 的父回调会走后端模板预览/派生，且整块展示含 staging 实时 bulk-read 说明。不能为复用外观接入它的网络回调；复用本地 `JsonAssist`、现有样式和展示惯例即可。
- `write-target-dry-run-runtime.cjs:300` 已有 `not_applyable` / `canApply:false` 语义，但其合同要求 approved/sandbox，映射源缺失时会填 null。本片不伪造 approved/sandbox、不改旧合同，也不复制其缺失填空行为。
- `transform-engine.cjs:34` 支持更宽的嵌套路径及转换，不适合作为本地闭集、无值错误面的直接替身。采用一个同时可由 Node 和 Vite 消费的纯 ESM，避免客户端与将来服务端各写一套宜搭映射逻辑。

本片只有浏览器局部交互和无 I/O 纯函数；没有新后端端点、宿主 capability 消费者、sender、认证或权限。按已有开发授权推进本地实现，不由此推导客户读取、外发、发布或部署许可。

## 2. 旧备料逻辑的取舍

实读用户提供的源码快照，阅读时隐藏字符串常量，不复制其中的主机、标识或凭据。引用路径相对快照后端 Java 源码根：

- `controller/StockInfoController.java:1757,1787–1857` 在推送前拆项目、分摊数量、拼接毛坯描述、映射物料/父项/版本。它们是业务语义，不是通用字段拷贝。首版输入必须已整理为“一条拟提交表单一行”，不会默默猜拆分/舍入规则；这部分仍需后续业务对照与明确配置，不能宣称已完整迁移旧推送。
- 同文件 `:1865–1898` 先查再创建，不证明并发幂等；`util/DingUtil.java:84–109` 会捕获保存异常并继续返回，外层 `:1900` 因而可能计作成功。本片不继承该成功口径，也不做远端查重。
- `controller/CraftInfoController.java:194–211` 另有命中后更新的语义。预演只让用户明确选择创建/更新意图，不以本地数据猜远端是否存在，不把“创建或更新”做成隐式 upsert。
- 钉钉审批与宜搭表单是不同功能，审批发起/通过不在此片范围。

## 3. 单一纯合同

规范实现落在 `plugins/plugin-integration-core/lib/yida-static-plan.mjs`，配 `.d.mts`。浏览器直接静态导入同一模块，Node 测试动态导入；不引入包/锁文件依赖，不把 Node 网络或 crypto 模块拖进浏览器。不新增运行时注册。

配置为闭集：

```text
version: 1
kind: yida-form-static
target: { appType, formUuid }
intent: create | update
businessKey: [sourceField, ...]
instanceIdField?: sourceField
fieldMap: [{ source, target, type: string | number | boolean, required }]
```

- app/form 是用户填写的**未核验本地目标标识**，不是获准连接、真实表单目录或凭据。禁止 endpoint、headers、token、principal、approved、canApply 等额外配置。示例 ID 纯合成，不证明真实宜搭控件 schema 支持。
- 只支持平面标量字段，不支持任意表达式、脚本、SQL、嵌套路径、默认值或类型强转。源字段支持有界 Unicode 字母/数字及下划线、连字符；危险原型键和明显凭据字段拒绝。
- 映射 1–32 项、目标字段不重复；业务键 1–5 个不同源字段，必须包含在映射中。更新意图须显式指定实例 ID 源字段，创建意图不附实例 ID 配置。
- 本地行最多 100 条、每行最多 64 个字段；文本及直接调用的总行 JSON 上限 128 KiB。只允许平面有限标量值；先确认数据描述符，再读取值或计算序列化大小，不执行 getter/toJSON。
- 缺失/null/空白：必填或业务键则该行无效；可选字段省略目标键，绝不填 null 清空远端。数字/布尔严格匹配，0 和 false 不能当缺失。
- 更新实例 ID 必须是该行明确提供的有界非空字符串，但仍未验证远端存在、表单归属或权限。
- 本地业务键用目标 app/form 及排序后的源键名/类型/值元组稳定表示，重排行/映射不变。重复业务键的全部相关行无效，不用时间、随机值或行号充当业务身份。这不是签名、执行 token 或远端幂等保证。

结果永远为 `kind:static_preview`、`status:not_applyable`、`canApply:false`、`tokenIssued:false`、`lookupExecuted:false`、`externalWriteAttempted:false`。有效行只标 `planned_create` / `planned_update`，远端状态一律 `unverified`；错误为闭集粗码及索引，不回显输入值。总体超限或配置错误直接拒绝，不截断成“预演成功”。

输出可以包含用户本人本地输入生成的候选字段 JSON，用于当前会话查看；它不是 values-free 审计记录，不上传、不记录日志、不存 localStorage、不自动下载。汇总 evidence 只计本地计划/无效数量，不输出“确认新增/已更新/已发送”数量。

## 4. 页面交互

在既有 operator board 可见性之内增加独立局部面板，不扩权限。面板不接收 board/scope 数据或服务回调；提供目标标识、意图、字段映射、业务键表单，以及本地 rows JSON 输入。可加载两套明确合成布局，也可由用户粘贴其已获准的本地输入；开发及测试仅使用合成数据。

示例围绕备料项目与明细：默认业务键采用项目号 + 稳定明细标识，不把“同一物料码”误当所有项目/父项下的唯一行。另一套全部重命名的字段布局仅换配置就产生等价候选字段结果。

编辑或换样例使旧预演失效；父页面 tenant/workspace/project 上下文改变时关闭或重置面板，不能把 A 的本地结果继续展示成 B 的操作结果。提示“仅本地，不发送；目标/权限/存在性未核验；勿填凭据；输入须预先整理为每表单一行”。真实推送仍不可用，没有用预演结果打开它的分支。

## 5. 验收与声明边界

1. Node 真实纯模块与 Vue 真实组件都执行同一生产函数；两种字段布局的期望独立手写，不能从编译输出反造夹具。
2. 覆盖缺键、重复全拒、重排稳定、目标变更、可选缺失、0/false、类型错误、实例 ID、未知配置、超限、原型/accessor 与粗码不泄值。
3. 独立面板总网络调用为 0；整页挂载原本就有 board/handoff GET，须断言预演交互**零新增请求**，不称整页零网络。先证明点击实际产生预演，再断言零请求。
4. 单守卫降级变异须有定向失败；独立审查和最终候选回归、类型、构建/打包兼容性验证。新 Node suite 和前端 spec 登记到真实 CI 执行清单，不用本地绿替代接线。
5. 未访问真实客户或宜搭，不取得 token、不做远端查询、发送、回执、重试或查重。需要这些能力时仍依 SA-05 的独立凭据/授权/账本合同；本预演不是该阶段的安全证明。

## 6. 回滚与后续

本片不持久化数据。移除局部面板和纯模块不会改变连接、客户表或远端表单；旧禁用推送占位保留。未来获准发布时本设计与实现分开 PR，代码和文档都仍是本地候选。

SA-04 后续仍需对确切宜搭表单控件协议、字段目录和业务拆分规则作专项适配；本片是用户可配置的离线计划，不宣称完整宜搭接入或 SA-05 发送已交付。PLM 在线管理权限裁决与 SA-03 具名读取合同也仍保留，不因推进静态工作而删除它们。

## 7. 本地实施结果

纯 ESM + 类型、真实 Vue 局部面板与看板接线已实现，原推送继续禁用。新测试进入现有 required-web/plugin/integration-guard 清单。主审 Node 11/11、前端五套 137/137、清单守卫 68/68；最终 plugin 239 套为 238 Windows + 1 WSL（既有 Windows 路径断言未改）。validate/provenance、新文件 ESLint 通过；旧 Board lint 遗留经 HEAD 诊断比对保留，不伪称严格全绿。

独立只读核验无剩余阻断。真实浏览器构建使用同一组件/模块、无 backend/env；键盘交互验证计划，修复长业务键撑破页面。详细冻结字节、命令口径和限制记录在代码分支 `integration-self-service-yida-static-verification-20260930.md`。所有数据合成，目标继续 active，无外发/发布/部署授权变化。输入校验针对 JSON 数据，不宣称对同进程恶意 Proxy 或被修改内建函数的沙箱隔离。
