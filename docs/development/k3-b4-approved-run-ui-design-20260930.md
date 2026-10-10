# SA-03D：批准 B4 的单页读取与内部同步入口

2026-09-30，本地开发合同。代码基线 b35d4cd1fbaa50d0cf15e1a75745f77624a9468a 加目标§25候选；上位目标 `integration-self-service-adaptation-goals-20260930.md`。不新增服务端端点/action、host capability、角色或外部写；仅接已有路径。设计与实现留在不同工作树，未来发布仍须按GOV-08分开审阅，不因本文件存在就获得真实执行/发布许可。

## 1. 现有依据

`http-routes.cjs:5302` 的批准配置 `/read` 是现有 read tier，真实store重新查scope与approved，再加载动态系统、经prepare/runtime/adapter；固定 `rowSource:adapter_records` 可看B4投影，但只是一页，不能证明全量。该handler不调用ERP persist。

`:7702` 的ERP source-run是admin-only，完整有界分页后可能由部署级AUTOPERSIST开关写tenant级内部物料缓存及run（`:7743`）；没有请求级dryRun覆盖，不能共享一个标作“预览”的按钮。既有开关会trim/lowercase，本片不改它或声称严格literal匹配。顺序持久化仍非原子事务，异常可能已部分更新。

工作台已有 `auth.hasPermission('integration:admin')` 展示惯例，但其宽泛isAdmin旁路不适用于本入口；复用 `stockPreparation/workbenchAccess.ts` 的 `holdsPlatformAdmin(auth.getAccessSnapshot())`，只认role:admin或integration:admin，与服务器此入口一致。它只决定控件，不授予服务器权限。既有配置面板/服务只有probe/save/approve/retire/list/audit；批准行尚无可用执行入口。

## 2. 固定用户操作

在既有“已保存读取源”里，对从服务端结构确认的B4、正版本、approved行增加独立运行区，不复用左侧未保存draft。列表服务从现有 `config` 推导B4标记：完整有效结构与既有B4模板一致，排除store生成version差异，systemId必须与行引用一致；不能仅看object/mode或客户端自报标记。未知/损坏/漂移配置不展示可运行标记；服务端每次仍重新核准。

1. **单页只读预览**：明确将访问所选真实K3，必须用户手动确认本次已获准读取；POST既有 `/read`，body固定 `{inputs:{},rowSource:'adapter_records'}`。只返回当前会话五个批准列，最多10行；始终标“单页，不代表全量”，不落内部缓存，不触发同步。0行、失败、上限提示不能伪装完整成功。
2. **读取并尝试同步内部物料缓存（管理员）**：单独显式按钮，仅hasIntegrationAdmin展示；确认文案说明会真实读取、是否落内部缓存由服务器部署配置决定、不会写K3。生成本次本地syncRunId，body只有configId/workspaceId/syncRunId/固定inputs，不传行、tenant、project、endpoint或分页改写。OFF返回只读验证成功/未写缓存；ON按响应显示内部写入及created/patched计数。绝不称“推送K3”。

点击/确认不是新的服务端授权token，也不允许开发过程中读取客户；测试全为合成。挂载、展开运行区、加载/审批版本不得自动发运行POST；不自动重试、轮询运行或把超时当已取消。同步异常提示结果未确认、可能部分更新，应先核查运行记录。

## 3. 作用域与状态隔离

两新调用均不发送query/body tenantId，不允许自报principal，也用现有 `apiFetch` 的 `omitHeaders:['x-tenant-id']` 去掉自动hint。workspace仍是现有配置scope选择；tenant由认证上下文决定。已有带tenant claim的组织切换继续适用；仅靠claimless token+header的旧路径不在本片恢复，须重新登录取得正确tenant claim。不能因请求失败而降级重发hint或改走probe。

新执行区与配置行绑定，保存id/version/contentKey/status、systemId、tenant/workspace及系统active/kind变化、刷新/退役开始、权限撤回、认证会话切换或卸载都清旧结果并废弃迟到响应；复用authPrincipal会话通知，并在请求完成时比对会话签名。同一时刻最多一个该运行区请求；正在进行的读取/同步不因UI清空就被声称撤销。确认取消零POST。请求固定快照，左侧draft不能夹带进实际执行。

## 4. 返回与展示

服务严格验证read结果的evidence.ok、固定object/mode、recordCount一致性、primary数组与最多10行。只白名单投影FItemID、FNumber、FName、FModel、baseUnit五列；前四者是既有intake可识别别名，不能误当成intake后的erpMaterial字段。不渲染原始响应、额外字段、非标量值或上游错误message。失败时即使携带data也不得展示旧/新业务行。业务值仅在已授权本地会话的表格展示，证据/error仅固定码、布尔/计数，不log/storage/download。

同步只接受known sourceRun/status/mode、固定false的外部写旗标及自洽的内部写/evidence/autoPersist状态；布尔字符串、缺字段、矛盾旗标、伪成功均拒绝为结果未知。现有ON路径即使autoPersist.persisted=false也会返回mode=internal_persist与internalWriteExecuted=true；persisted只描述物料行，本次运行记录仍可能新建或更新。因此须分别显示物料与运行记录计数，不能把false称作所有内部写均未发生，也不能据mode单独宣称物料成功落库。只显示公开汇总，不渲染intake、凭据或extra。不把响应计数当跨请求幂等/事务证明。

## 5. 实现与验证

写集：新局部运行组件/前端service/真实UI+service spec，原配置服务最小B4标记及Panel接线，工作台传现有admin提示。后端生产保持不动，只扩既有真实HTTP suite证明 `/read` 在AUTOPERSIST ON/OFF都零缓存写、批准/权限/scope/坏响应路径。主审登记新增前端suite、独立审查与变异、真实浏览器验收。

验收必须跑真实Panel→service→apiFetch→合成fetch，不mock被测service；断言tenant提示头确实未上网、后端body不含draft/tenant/project/raw配置。后端另走真实handler/store/registry/adapter；两层证据各说清替身边界。覆盖确认取消、无自动POST、非admin不显示同步、版本与scope变化/迟到结果、返回异常不假绿、超时同步不自动重试。回滚只移除新UI调用，不改连接/版本/后台数据。
