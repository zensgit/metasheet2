# 宜搭受管初始化：唯一 owner 与 OFF 下配置入口

日期：2026-10-09。状态：**Approved A — 用户明确回复“批准宜搭初始化”，批准本地实现与合成验证；后续拆分提交、推送和开 PR 授权见下，初始化批准不授予真实外发权限。**

> **当前验收（2026-10-10）**：本地候选 `frozen-ea599226-16da-4413-9e20-108bada0033f`，manifest SHA256 `8aea214606f988c4c3bf8a89c085fd33574da5b12fedb0f37613a3b184bb5c37`，八阶段本地验收通过（新增 core unit 215 项、plugin 29 项，并覆盖原始类型检查、迁移、provenance、前端及接线测试）。原始整站 manual 九阶段已通过，包含 465 个迁移；该摘要 SHA256 为 `53f19a2836407f15d19c8292975dbf1ac9008b4bc7c84433e4b1e0e4c11de5b4`。Automation 整套真实临时 PG 测试已实际结束：126 项中 117 通过、9 失败、零跳过，摘要 SHA256 `bf64964502a044e6904172bd4dbdccef9b1599cb9b42e7bd4981435063dfc05f`；临时 PG 已停止并清理，完整原始失败证据保留。失败含优化后仍使用旧 native-read 数量的断言，以及时钟窗口、测试清理锁和 recovery 迁移前置，后者尚待定位或补齐，不能统称假红。interval 尚未执行，不能将 manual 通过扩写为全部 Automation 或完整 iPaaS 已交付。宜搭独立提取树的类型/CI 接线问题正在另行修复并重验，不用累计树的绿灯替代它。988 冻结的 manual 失败及此前阶段记录保留为历史，不代表当前 manual 结果。
>
> **发布授权与基线**：用户已明确授权在相应切片验收通过后，按“宜搭 → K3 只读 → 备料读取计划 → Automation 只读”拆分提交、推送并开 PR；不包含合并、部署、真实客户读取、真实 token 或宜搭发送。sender 仍 OFF，K3 永不写回，可信 tenant / 当前 owner 与原时间预算、授权重验不变。本设计文档分支基于 `93214d2ea63400b2d1fd77ce8bc45c4fe18bae7d`；上述实现候选仅已对齐固定 main `36aabbbedb0233bffc0d6fc34e2f6be23a0e2e87`，不宣称已完成最新 main 对齐。以下实施正文与旧验收均按各自时间点保留。

承接已批准的 [单目标/单行/一次发送 A 合同](yida-owner-limited-send-design-20261009.md)，不是重新申请该发送合同的本地开发许可。初始化 A 原始授权不包含真实客户读取、真实 token、宜搭发送、合并或部署；后续有条件的提交/push/PR 授权已单独记录于顶部。

代码证据基线：HEAD `afd32b704c6ff4c82dbfe90b94066fcaf3fc0074` 加§133冻结423路径，manifest `5b71afd9f0b6d959801d47e20cc89e46ae888021212d9c98ceb35a5e2a308396`。下述行号属于该工作树冻结，不是声称未跟踪模块已在该 commit 入库。GOV-08 要求本决策与对应代码分别提交 PR；原始草稿时未获外部 PR 授权，后续授权与当前验收边界见顶部。

## 1. 真正缺口

- `src/integration/automation-live-authority.ts:133–159` 核真实用户、tenant membership和锁定RBAC，允许平台管理员或合格集成管理员；它不验证“部署预先指定的宜搭 owner”。
- `src/integration/yida-send-approval-service.ts:207–218` 先 actual live ACL，再锁已存在的永久target并要求owner=actor。空槽不能调用该发送authority完成初始化。
- `lib/yida-owner-runtime-factory.mjs:61–67` 从可信actor派生owner可防自报，但**不能阻止另一个有真实管理员资格的用户抢先占全局slot=1**。
- `tests/utils/stock-preparation-yida-owner-http-fixture.ts:305–312` 通过三次私有producer调用分别提交090材料、091草稿、092目标。已通过的HTTP/browser测试不证明用户初始化的权限或原子性。

`src/` 与 `tests/` 相对 `packages/core-backend/`，`lib/` 相对 `plugins/plugin-integration-core/`。材料/target公开store目前自行transaction+SET；091已有内部transaction writer。先抽取相同090/092共享写入体，可在一个host-owned事务中共同执行，不复制SQL或假装三次COMMIT是原子初始化。

## 2. 已批准裁决：A

**A：部署方在服务端预先指定一个初始化owner及其tenant。该owner同时具有实时集成管理权限，才可登记唯一人工目标。发送开关OFF时允许这条独立本地配置链，但绝不批准发送、消耗发送额度、交换token或发网。**

- 预指定anchor来自受管部署/引导材料，不能来自HTTP body/header、普通角色声明、任意第一位管理员或测试fixture。
- 首版固定一个deployment slot、一个tenant、workspace=null、一个owner。anchor与目标均不可由普通HTTP转移、清空、换名重建；配置缺失/漂移、非指定owner、错tenant/无实时权限均拒绝。
- 新初始化authority独立核actual ACL + server-owned anchor，再调用私有producer。已有发送服务对现存target的owner/liveACL/期限/材料门原样保留，管理员无owner旁路。
- 推荐首版只建立材料、草稿及人工目标；轮换、重新attest、owner转移、多目标和多部署去重不隐含在初始化入口。

不推荐“第一个通过integration-admin校验的请求自动成为目标owner”：这是先到先得的新授权合同，不能从已批准的“当前owner∩admin”推导，更不能用body传owner声称解决。

OFF仅增加**独立管理操作**，不改变现有draft/preview/approve/submit的OFF拒绝及其测试，不把开关当grant。既有observe/revoke仍按原合同实时核owner与权限。

## 3. 实施合同（A 已批准，可接线）

1. 明确server-owned anchor的持久身份/引导来源，初始化command identity与只读状态恢复。不能只在请求handler里塞一个期望owner常量，也不能在每次失败后重造材料ref。
2. 固定POST body只接受闭合的材料包、合法v2 CREATE草稿/分配规则及人工审核说明。actor/tenant/workspace/owner、永久targetRef、verified/permission、摘要不得自报；人工确认不称官方组织认证。
3. 一个真实host RC事务：actual live ACL→指定owner/tenant anchor→090材料create→091真实writer/完整重演→092永久target/audit→初始化状态/COMMIT。任一材料/草稿/目标审计或锁故障全部回滚，无nested BEGIN/SET/独立写重试。
4. 首槽PK竞争保留：失败者外层回滚所有新增材料/草稿，不借target公开store的重试循环重新创建材料。COMMIT回包丢失仍不确定；UI冻结自动重做，仅显式本地状态GET恢复，未确认absent不得解释成“从未初始化”。具体command/state存储在实现前固定，不借发送submission或旧091状态当初始化许可。
5. HTTP固定路径、JSON-only、有界body、no-store、闭集DTO/错误。材料四字段原字节不trim，只写受管加密bundle；不落localStorage、导出/模板、日志、公共审计或错误。新增能力只注入integration插件，不注册跨插件通信API。
6. 生产logger当前 `src/index.ts:1835` 在路由校验前记录raw req.path；材料不得放URL/query。需在新前缀测试真实logger及非法路径的脱敏，不以当前不挂logger的HTTPfixture证明秘密不泄漏。
7. 用户在实际界面填写材料/目标/业务键、明确确认人工审核与永久单槽后初始化；结果只显示本地配置状态、不可发送和现有rowKey等受权metadata。再走已批准的独立preview→grant→submit链，不因初始化成功自动发网或升级091。

回滚关闭新管理入口/停新准入，保留anchor、目标、材料与历史；不删除永久slot、重置次数或清理unknown。没有调用外部系统的需要，合成fixture不等于真实部署许可。

## 4. 真实路径验收

- 内部前置：实际db.cjs/security/三writer共同提交，独立PG session可见；三类audit故障、占槽跨tenant/owner均回滚到before，writer阶段零transaction控制语句；公共store既有合同保持。
- 授权入口：HTTPfixture起始空材料/空目标，由真实JWT/完整liveACL/预指定server anchor→实际producer建立。合法但非指定的另一个管理员是独立负控，不能只测没有角色的人。
- OFF正控只本地配置且token/form调用0；缺anchor/伪owner/tenant/同名header/撤权/竞争/COMMIT不确定均fail closed。单独移除anchor门必须令另一个合法管理员负控实际致红，不能由另一个scope守卫遮蔽。
- 浏览器先 isolated真实Vue/HTTP/PG，再完整start/密码登录/生产bundle：材料不持久化到浏览器存储或导出，提交后清空秘密控件；session/input变化不接受迟到结果，lost response只能手动回读。保持原PLM/K3/宜搭静态预演与Automation验收。
- 不宣告远端组织/表单/业务成功、全局exactly-once、物理socket撤销；不进行真实读取/token/发送/发布或部署。

## 5. 本轮执行边界

此前仅允许未注册的090/092共享事务writer；该前置已完成。2026-10-09用户明确批准A，现可新增独立在线初始化route、runtime能力与凭据输入UI，并进行合成验证。此授权不包含真实数据、token、发送、对外发布、合并或部署。

## 6. 本次实施接口冻结

- 094迁移增加永久单槽 `integration_yida_initialization_anchor` 与 append-only `integration_yida_initializations`。anchor由服务端受管引导工具预置owner/tenant，命令UUID只生成一次并持久保存；同身份重放只读返回，身份漂移拒绝。普通HTTP无建立/转移/清空anchor能力，host在线路径只读anchor。
- 新入口复用私密owner前缀：`GET /api/integration/yida-owner-send/initialization`（200）、`POST /api/integration/yida-owner-send/initialization`（201）。实际JWT tenant与actor、实时ACL、永久anchor三者都须一致。GET不是后台轮询；初始化、状态回读与引导工具共用固定单槽事务级advisory锁，等待真实COMMIT/ROLLBACK后普通SELECT不可变anchor（PG的FOR UPDATE需要UPDATE权限，不能假称SELECT-only）。只有target与初始化结果均缺失才报告 `ready`（已确认本地不存在）；已有完整匹配结果报告 `initialized`，缺配置/锁失败/遗留target无对应结果均拒绝，不伪称absent。
- POST闭合输入为 `{commandId, material, draft, attestation}`：commandId只接受GET给出的服务端持久UUID，不是调用者声明权限；material沿用090四原字节字段，draft沿用091 `{config, rowsText, allocation}`，attestation沿用092人工审核结构。调用者不得指定owner/tenant/workspace/credentialRef/targetRef或认证结果。
- 结果闭合为 `{commandId, status, draft, canSend:false, tokenIssued:false, externalWriteAttempted:false}`；`ready` 的draft为null，`initialized` 的draft仅包含现有091受权metadata/rowKey。不回显材料、人工审核正文、密文或凭据指纹。初始化不生成grant/admission，不改变旧发送OFF门。
- 独立host初始化runtime负责插件生命周期与取消/排空；私有plugin producer只把raw事务投影为真实db.cjs CRUD，按090→091→092执行共享writer，无db.transaction/SET/重试。host负责liveACL→单槽advisory锁及anchor比对→slot检查→三writer→初始化结果记录与同一COMMIT；COMMIT错误/断线只报不确定，前端清空秘密并冻结自动重试，必须显式GET确认后方可再次手动操作。
- 受管引导工具仅写本地数据库、禁止接受HTTP材料；正式部署前由owner另行批准并指定真实owner/tenant。此轮只在临时合成数据库建立合成anchor，不替用户猜真实身份。
- “在线路径只读anchor”是代码能力边界：普通HTTP没有引导/INSERT/转移接口，094撤销PUBLIC权限并用触发器禁止修改/删除/清空。它不声称能阻止持有数据库table-owner凭据的操作者或同进程恶意代码；本轮未凭空创建部署角色。生产若采用独立引导/运行角色，须按其真实部署grant方案另核，不把PUBLIC revoke假称table-owner分权。
- 本轮先验真实JWT/HTTP/PG与Vue合成测试。此前发现Chrome后台原生出网缺口，未完成进程级deny-default守卫前不再起浏览器；不得以Node/page路由白名单声称全进程零外网，也不得把jsdom验证称作完整浏览器验收。

## 7. 本地实施结果（2026-10-10）

A已实施并形成新的445路径冻结。实际PG15/15、JWT/HTTP43/43及Vue/jsdom179/179通过，实际完整迁移460且重放新增0；Core/Plugin/接线与pin检查另见[验证报告](C:/Users/zen08/.codex/worktrees/k3-self-service-slice/metasheet/artifacts/yida-initialization-20261010/frozen-551b4ef8-7614-4a46-8257-0c21c8f5829f/verification.md)。独立审阅发现并修复GET失败秘密残留，当前报告按修后真实字节与最终收据记账。

真实生产owner/tenant尚未由用户指定，本轮只建立临时合成anchor；没有生产引导、真实宜搭调用或发送。原生浏览器和完整应用终验仍待，候选未对齐main，不宣称发布就绪。未来部署先迁移094再上线代码，另行批准受管引导；不自动收养遗留永久目标，不重置或清空历史。

## 8. 隔离浏览器续验（2026-10-10）

新的449冻结已在私有Linux user/net/PID、仅loopback/capability零环境通过真实parent Vue→JWT/live ACL→原生producer/PG链，新初始化4+旧owner8整文件12/12。空槽POST201、真正有管理员权限的非指定owner拒绝、COMMIT后lost201仅手动同command GET恢复均由实际页面/HTTP/独立PG证明；发送仍OFF，token/form调用与发送六表0，临时库正常stop并仅移除工具自有数据。

这是本轮隔离page而非完整密码登录/生产bundle；四材料控件清空不证明浏览器存储/export/堆清零。正式full-app入口尚未整体包入namespace，test-only本机wrapper不是客户/CI启动器，缺能力时fail closed，不报远端CI已绿。只读审查的限界、当前449/SHA与原始收据见[新验证报告](C:/Users/zen08/.codex/worktrees/k3-self-service-slice/metasheet/artifacts/yida-initialization-browser-20261010/frozen-e4888fa8-4cf3-467a-8057-f6f79b3d7801/verification.md)和目标§146。继续补存储/export与正式整站后验，原失败保留；没有真实初始化引导、发送、发布或部署，A批准范围不扩大。

## 9. 续验与试用优先级（2026-10-10）

当前453冻结补有限真实storage/export检查，初始化4＋旧owner8完整12/12；正式public CLI的manual/interval各9 stage全0、各460完整迁移/重放0，并闭合原OFF14表/query/log后验及正常stop。真实公共入口的顶层await回环P1已修且有限变异致红，生产A授权合同不变。166独立合同执行202次（36重复）、actual63pin全等，不夸大计数；原采集失败及历史限制保留，详见[本轮验证MD](C:/Users/zen08/.codex/worktrees/k3-self-service-slice/metasheet/artifacts/yida-initialization-formal-20261010/frozen-ca3fe612-b2b8-4a00-b961-325d12b887bc/verification.md)及目标§147。

原整站通过不证明完整看板新初始化；该独立合成窗口已优先派发、尚未验成。有限storage值检查不证明IDB/Cache内容/堆清零，导出保留合法字段/分配规则metadata；正常停止不当强制kernel撤销证明。首试收窄到单个测试表单/1条合成记录，先完成完整看板与可复现交付，再由owner单独授权真实token/外部发送；不把当前批准A扩大为真实owner/tenant引导、提交、发布、合并或部署。主检出/main尚不包含这套新增宜搭模块，不能声称用户已有运行中的可用Demo。

## 10. 完整看板独立窗口推进（2026-10-10）

目标§148记录：独立初始化窗口严格在原OFF观察恢复后；真实host事务受管bootstrap、实际密码登录/bundle/看板、手动GET/reload和实际持久链验证已接验收。第二455冻结真实进入新窗口但BOARD失败，原始日志只有固定阶段，不称抓获具体fault请求。已确认并修补生产catalog两种producer与测试规则的不兼容：裸GET及checked session Bearer＋actual tenant hint；此允许仅属`/api/plugins`验收合同，初始化自身仍禁tenant/workspace头，不改变生产授权。修后第三4007冻结175/175合同、strict/provenance及actual63pin通过，原interval整站9阶段/460迁移通过；真实POST201/三次GET/刷新恢复、14＋2表持久链与发送六表0、旧OFF/query/log后验、正常stop和ownedPG停删均获原收据证明。Root重核455/6341输入、30原流与原validator，见[本轮通过验证MD](C:/Users/zen08/.codex/worktrees/k3-self-service-slice/metasheet/artifacts/yida-full-board-trial-20261010/frozen-8822ec5a-eba3-4249-b0cc-d563611bf44a/verification.md)。不借旧453背书，先前manual timeout和第二BOARD失败保留。

人工可互动入口另在tmp原型中收敛；全生命周期取消、stdin stop后晚到READY和私有handoff异常清理已修且窄复核闭合。语法diagnostics0、实际提取函数的有限内存5/5和两个变异被杀，不是完整类型检查或真实PG/子进程/私有文件清理验收；原型入口未运行，仍待真实启动/操作/停止。没有真实owner/tenant引导或常驻Demo；可信ownedPG父bootstrap与受guard子进程的限界明确，不冒称普通浏览器具有测试kernel隔离。A批准仍只涵盖本地实现与合成验证，没有真实token、发送、发布、部署或生产角色授权。

## 11. 临时合成人工入口已完成有限真实生命周期（2026-10-10）

目标§149更新§10的当时未运行状态。最终e5原型实际strict/noEmit180源码0诊断，有限内存5/5、真实FS10/10及两组有限变异通过；真实正常启动/密码登录/production HTML/Board/初始化ready/OFF/协议停止通过，PG引导期间SIGTERM以原型exit1/READY0的预期失败结束并清理。另起browser-view运行，用computer-use技能的新IAB页实际看到生产登录页；Chrome接口不可用，未在UI输入凭据、登录或保存。正常关闭本次页并停止服务，handoff文件和自有PG数据清理，无常驻Demo。

Root三份原始收据、30原流、12子CJSguard帧、6327原build输入与455冻结字节重核，审计SHA `1159670152e457ff5f5db5fc9f64170ac4e55b7aceff8c5d5913da1b8a8144b4`，详见[追加验证MD](C:/Users/zen08/.codex/worktrees/k3-self-service-slice/metasheet/artifacts/yida-full-board-trial-20261010/frozen-8822ec5a-eba3-4249-b0cc-d563611bf44a/verification.md)。旧collector部分JSON失败及有限测试工具错误保留，只修工具，不改生产合同或把新绿当历史根因修复。

仍为tmp原型而非稳定试用命令/客户包，下一步提取入口、有限契约与使用说明。可信父bootstrap与普通浏览器不冒称子guard/kernel隔离；隐藏worker不抵御同一恶意本地FSowner，Windows DACL/普通浏览器保存/强制native撤销未证明。初始化批准A未扩为真实owner/tenant配置、token、发送、main对齐、发布或部署授权。

## 12. 维护目录中的本地合成命令（2026-10-10）

目标§150将e5提取到固定公共Node入口/backend scripts，新增真实strict/noEmit配置、有限契约和[操作指南](C:/Users/zen08/.codex/worktrees/k3-self-service-slice/metasheet/docs/development/yida-local-synthetic-trial-guide-20261010.md)。公开两参数/help、Linux/non-root、清环境后同进程真实tsx注册；原取消/actualclose custody/私有handoff/原build-PG-migrate/live ACL/受管anchor/OFF语义保留。只读复核两静态order缺失标记假绿已只修测试和新增静态删除自证，闭合审通过；无新生产API、依赖、flag或pin。

最终305a/460（旧455不变＋5新增）普通tsc、10契约、公开命令正常生命周期和引导期取消实际通过；正常生产HTML/密码登录/Board/init-ready/OFF，取消预期exit1/READY0，均清理handoff/自有PG。Root核24原流/9guard/6327build输入，audit `6b4bbb7cb6039dd350032650d95e202984499a1f357a8fbd74b7b76a4ea05479`，详见[最终验证MD](C:/Users/zen08/.codex/worktrees/k3-self-service-slice/metasheet/artifacts/yida-synthetic-trial-20261010/frozen-fee2dd9e-ca53-4a5e-8151-80eed7e01702/verification.md)。正常close观测不当内部stop源，新CLI未普通浏览器登录/保存；不借旧bundle或旧175绿背书本轮执行。

当前是完整Linux开发工作区中的本地命令，非已合并/已发布客户包；尚需接既有检查和候选对齐。无常驻服务或真实材料输入，初始化A没有扩成真实owner/token/发送/发布/部署。父bootstrap/普通浏览器隔离、Windows DACL及强制native退出限界仍明确保留；完整目标active。

## 13. 试用入口已接候选既有检查（2026-10-10）

目标§151完成原workflow同id合同接线及backend类型脚本追加，修旧无DB合同错误的pre-install次序，保留原suite/安装失败门；新增24负例和10有限移除自证，独立复核无阻断。2676冻结460仅3文件变动、457未变；真实package四命令类型链、workflow三个整文件189/189和原provenance1/1通过，actual63pin无差异/重打，六原流/11guard/root audit `734fe6cc6c64094bee0e09736505464b01719b33337376b9538208e61f02b47f`，见[验证MD](C:/Users/zen08/.codex/worktrees/k3-self-service-slice/metasheet/artifacts/yida-synthetic-trial-wiring-20261010/frozen-d9c68954-789d-402e-9c2a-a79ad905beba/verification.md)。这不是远端CI、安装交付或本轮生命周期重跑。

当前main8d1新增业务使23候选路径双边修改，需要三方保留项目分表/严格权限/新迁移后重新验收；尚未对齐、提交或部署。无PG/host/browser、真实token/发送或客户读取；初始化A与OFF/owner/tenant边界未改，真实首试仍另行授权，全目标未完成。

## 14. main 对齐后的初始化整站复验（2026-10-10）

目标§152已在独立本地 d6638148a 候选完成三方对齐，保留 main 项目分表/严格权限/迁移及初始化 A 的 server-owned owner/tenant、live ACL 和 OFF 边界。新 BB85 冻结的 backend 原类型链、196 完整合同、304 前端用例和原 provenance 通过；manual/interval 原 full-app 各 9 阶段、465 迁移、密码登录/生产看板/初始化 POST/手动回读/刷新、原 OFF14 表/query/log和正常 host/PG 停删均通过。

root 整站只读 audit `01f06b3c968147716224c796ff45955c6d8d0e35a33c006b91f449229938a44e` 逐核两次各 24 原流、原收据和 13,589 文件三处原字节，[当前验证与试用说明](E:/Projects/metasheet-wt-yida-main-alignment-local-20261010/artifacts/yida-main-alignment-20261010/frozen-9266dc35-4af6-41fa-9f26-af137abc58fa/verification.md)。可安排本地合成试用，不是已上线；交互 CLI 本轮启停未重跑，无常驻 Demo。真实 owner/tenant 引导、真实表单/token/发送、合并/发布/生产迁移/部署仍单独授权。普通人工浏览器、强制退出和真实客户兼容限制保留，全目标未完成。

## 15. 交互证据已核，迁移修订后的交付门仍保留（2026-10-10）

目标§153补BB85公开交互normal/cancel的真实终态，root audit `22bcb62d9071e6503815af51cd452ac597a80e709f921f952429f2c9a3e8bd09` 通过；原私有handoff/自有PG已清理，无常驻Demo。新的HTTP会话找回草稿不是普通浏览器UI reload保证。随后只修候选迁移命名/引用并补WSL PG与身份限定清理指南，新EF149类型链、196合同、304前端、provenance和原两件完整迁移unit26/26通过；继承CRLF的wiring两失败未涂绿。

候选尚缺S3增量；最新远端36aabb的78路径正准备三方成品，尚未应用。#6306修订补丁在shadow两份完整unit第三轮55/55通过；第四强化helper因日志FD被拒而红，未收集完整unit、未跑v2，不拿旧绿签新工具。真实PG/组合启动及最终源整站仍须闭合，见[新源核验记录](E:/Projects/metasheet-wt-yida-main-alignment-local-20261010/artifacts/yida-main-alignment-20261010/frozen-d417dae5-5fb0-46f0-b970-44550cd86573/verification.md)。旧BB85绿不能证明更名新源。初始化A不扩真实owner/tenant引导、token、发送、提交/push/PR/合并/发布/生产迁移或部署权限，K3永久禁写，完整目标active。

## 16. 最终 main 增量已落地，验收只跑新源（2026-10-10）

目标§154已整合固定main36a的78路径：76 Git oracle一致、1手工冲突保留提前read-plan guard与S3执行两尾，pin全域原模块重算验证一致；Git HEAD仍d663，无提交/rebase/发布。新3e冻结13,603文件，Linux最终准备已启动，未称新类型/功能/整站通过。旧BB85/EF149证据仅属旧字节；#6306 shadow两unit55/55与强化工具红不变，真实PG/组合启动仍待验证。详情见[最终源码记录](E:/Projects/metasheet-wt-yida-main-alignment-local-20261010/artifacts/yida-main-alignment-20261010/frozen-08cff423-9881-4bd3-8334-b30cffcff4d3/verification.md)。不扩大初始化A或真实token/发送/部署权限，sender OFF，K3永久禁写。
