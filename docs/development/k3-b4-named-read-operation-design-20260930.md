# SA-03A：现有 B4 具名读取操作的执行约束

日期：2026-09-30。状态：本地实施合同；落实既有 B4 审定内容，不引入新的授权。上位目标为 `integration-self-service-adaptation-goals-20260930.md`。此片不完成全部 K3 自助协议适配。

## 1. 事实与决策

冻结代码基线 `b35d4cd1fbaa50d0cf15e1a75745f77624a9468a`，保留本地 SA-01/02/03/04 改动。

- `read-source-k3-material-list-b4-contract.cjs:55–69` 已规定 B4 profile、path/method、container 与 fieldMap；`:74` builder 只替换 systemId。该模板及 contentKey 不应修改。
- `read-source-probe-contract.cjs:168–202` 构建 plan 时未保留 actionProfileVersion，`read-source-probe-runtime.cjs:145–171` 的通用 overlay 只写 path/method/list cap。`read-smoke.cjs:345–354` 随后把它与已有 system object 合并。
- `k3-wise-webapi-adapter.cjs:1282–1325` 从合并后的 object 取 body template、Fields/OrderBy/body root/分页字段。纯合成实跑相同 B4 config 可因 system object 的这些配置变化而发出不同 body，正常 evidence 仍可成功。干净 system 甚至没有带出 B4 固定五字段投影。
- `read-source-config-store.cjs:289–292` 会将 config.version 覆写为实际 mint 序号，`:102` contentKey 排除该字段。因此运行期不能把 B4 模板的 version=1 错当批准版本永远只能为 1。

决策：只对明确声明现有 `k3wise.material_list.v1` 的配置落实固定合同；在保存/准备阶段校验全部有效字段，运行请求从同一既有受审 preset 派生，不从可变 system object 继承请求结构。systemId 仍引用现有受控连接；profile 名称本身不是授权凭据。

这不是 C6 的新许可：C6 已消费 B4 身份，但其 lookupByKey 调 GetDetail，不是本片的 configured GetList。不能把本缺口扩大叙述为 C6 自动发出了错误 GetList。也不修改 C6 生命周期、B2a、sealed 配置或永久写禁令。

## 2. 实施合同

新增最小 `k3-read-operation-profiles.cjs`，复用 B4 常量和 read-smoke 已有 material-list preset。无新 profile ID、认证机制、网络入口或依赖。

- 对此确切 ID，config 的 kind/object/mode/path/method/operations/container/fieldMap 等有效字段与模板一致；唯一业务差异为 systemId，版本由 store 管理并排除有效内容比较。未知可选字段仍由 S1 闭集拒绝。字段漂移只报固定粗码。
- 普通未声明 B4、其他 profile 的既有行为不改，也不能给它们贴 B4 认证标签。本片不是新的 profile 发布/认证注册表。
- plan 保留 B4 操作身份，probe 和 configured read 都在创建 adapter/登录之前应用同一闭集请求结构。污染的 stored body/template/filter/field list/order/分页字段不得混入 B4 请求；不修改保存的 system。
- 固定 POST/GetList、五字段投影与现有 page 1..10、每次最多 10 行。更低可信 rowCap 可保留，不能提高上限；runtime 不得接受原始 path/filter/body 或额外参数。
- 保留已有凭据获取、连接作用域/owner 检查、read marker 和上一片 redirect:error。profile 不证明真实客户可达，不绕现有批准配置/执行权限门。
- B4 container/fieldMap 不为了“可配置”而放宽。现有 `DATA:null` 兼容行为另行评估，不顺手全局修改 adapter 空响应规则；需要完整 SA-03B 时补协议和证据。

UI 计划为既有读取配置面板内的显式 B4 快捷入口：选择已登记 K3 系统，其余固定内容只读，仍走既有探测、保存版本、审批。种子 version=1 仅为新草稿结构字段，不让用户冒充批准版本；保存结果以 store 返回值为准。普通专家模式继续可用，离开 B4 必须清除 profile 身份与“受审固定合同”提示，不能边改固定字段边保留认证承诺。

## 3. 证明与回滚

必须先证明真实旧 prepare→execute→K3 adapter 路径的请求可漂移，再以相同生产路径的假 fetch 核 method/path/body，不能只断言 overlay 函数。probe 和 configured read 两条腿都覆盖；config 漂移、分页/行数、额外输入各有独立零发网反例，version>1 有正控制。两份合成 system 只换引用可复用，不用真实凭据或网络。

保留 B4 template/contentKey、BL2、非 B4 通用配置和 C6 的回归；选取单守卫内存变异证明身份/overlay/限额真接线。前端真 DOM 验证选 B4、换系统、退出模式、保存传递 profile、后端返回版本，而不是仅测文案。所有新增 suite 登记进现有 CI 清单。最终相关全链、provenance、lint/type、真实路径独立审查记录在实现报告。

无 DDL/数据回填。未来回滚 UI 与执行约束可恢复旧代码，但旧代码会重新失去该 B4 请求体保证，因此不能把回滚后仍有 profile 字段称作相同安全保证。存量合法 B4 内容无需重铸；先前声称 B4 但内容漂移的配置将被拒绝，需受审纠正，不自动降级为通用读取。

本地开发使用合成数据，不访问真实客户、不触发宜搭发送、发布/PR、合并或部署。PLM 在线管理的权限选择仍独立待裁决。扩展到其他具名操作、可配置分页/响应及新协议，继续按 SA-03 后续合同实施，不能由此片默认开放。

## 4. 本地落实结果

本片已在独立代码工作树落实为 5 个后端模块、新增真实 adapter suite、3 个前端文件和既有 test-chain 登记；详细冻结 hash / 命令在 `integration-self-service-k3-b4-verification-20260930.md`（代码分支）。独立审查发现 prepare 后原配置可变别名，已修为 B4 专用冻结快照，不扩大普通模式行为。新 suite 8/8、7 内存变异致红、前端八套 109/109、登记守卫 68/68；全插件为 239 Windows + 1 WSL，provenance/validate 通过。本片未重打 pin。

真实浏览器只验收隔离生产组件与假 API；固定模板、显式默认 OFF 的 smoke、保存返回 v7、退出清当前结果可见。不是客户连接或授权批准证明。存量响应成功判据和 `DATA:null` 兼容仍在本片之外，后续需单独收口；没有把本地实现宣称已提交、已部署或完整 SA-03 交付。
