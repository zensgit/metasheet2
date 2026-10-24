# 证据表：《宜搭接入操作手册》（修订版）

基线：编写与两轮核验在 PR #6315 头 `e1a9e914c` 上进行；现已对照新头 `42ff6d072`（= `e1a9e914c` + CLI 修复 `825a6fbe8` + 合入 main `cb22e18e1`）复核：本证据引用的文件中，只有 `StockPreparationProjectBoardView.vue`（BV）因 main 在第 365 行附近插入一行而整体后移 1 行，下表 BV 行号已按 `42ff6d072` 更新；CLI 相关行（CLIF）即 `825a6fbe8` 的内容，在 `42ff6d072` 上不变。其余 `path:line` 在 `42ff6d072` 上成立。
CLI 修复：提交 `825a6fbe8`，已包含在 #6315（头 `42ff6d072`）里；随包校验 `scripts/ops/multitable-onprem-package-verify.sh:1037-1038` 把编译后的命令与 `dist/src/integration/yida-initialization-bootstrap.js` 列为必需内容（缺失时 `:1175-1177` 报 `Required package content missing`），回归见 `scripts/ops/onprem-package-runtime-closure.test.mjs:12-13`。
编号对应手册章节。`UNVERIFIED` 表示代码无法证明，手册中已改写为“待 owner 确认”（第 8 章）或标为推断。

## 路径缩写

| 缩写 | 路径（仓库相对，除非另注） |
|---|---|
| R | `packages/core-backend/src/routes/integration-yida-owner.ts` |
| IDX | `packages/core-backend/src/index.ts` |
| ORT | `packages/core-backend/src/integration/yida-owner-runtime.ts` |
| IRT | `packages/core-backend/src/integration/yida-initialization-runtime.ts` |
| BS | `packages/core-backend/src/integration/yida-initialization-bootstrap.ts` |
| AS | `packages/core-backend/src/integration/yida-send-approval-service.ts` |
| ALA | `packages/core-backend/src/integration/automation-live-authority.ts` |
| CLI | `packages/core-backend/scripts/bootstrap-yida-initialization-owner.ts`（`e1a9e914c` 版本） |
| CLIF | 同一文件的 `825a6fbe8` 版本（WSL 副本 cli1） |
| PATCH | CLI 修复提交 `825a6fbe8`（已在 #6315 内） |
| CLIT | `packages/core-backend/tests/unit/yida-initialization-bootstrap-cli.test.ts` |
| CLIL | `packages/core-backend/tests/unit/yida-initialization-bootstrap-cli-load-graph.test.ts` |
| HRT | `packages/core-backend/tests/integration/stock-preparation-yida-owner-http-realdb.test.ts` |
| IHT | `packages/core-backend/tests/integration/stock-preparation-yida-initialization-http-realdb.test.ts` |
| HB | `packages/core-backend/tests/integration/yida-host-boundaries-realdb.test.ts` |
| AUTH | `packages/core-backend/src/auth/AuthService.ts` |
| JWT | `packages/core-backend/src/auth/jwt-middleware.ts` |
| ES | `packages/core-backend/src/security/encrypted-secrets.ts` |
| RAC | `packages/core-backend/src/security/auth-runtime-config.ts` |
| PRS | `packages/core-backend/src/security/plugin-runtime-security-service.ts` |
| MP | `packages/core-backend/src/db/migration-provider.ts` |
| MIG | `packages/core-backend/src/db/migrate.ts` |
| PKG | `packages/core-backend/package.json` |
| TSC | `packages/core-backend/tsconfig.json` |
| M090…M096 | `packages/core-backend/migrations/09x_*.sql` |
| APK | `scripts/ops/multitable-onprem-apply-package.ps1` |
| SPM | `scripts/ops/attendance-onprem-start-pm2.ps1` |
| PB | `scripts/ops/multitable-onprem-package-build.sh` |
| FM | `scripts/ops/global-history-flag-manifest.mjs` |
| SP | `plugins/plugin-integration-core/lib/yida-static-plan.mjs` |
| DP | `plugins/plugin-integration-core/lib/yida-draft-plan.mjs` |
| DS | `plugins/plugin-integration-core/lib/yida-draft-plan-store.mjs` |
| AL | `plugins/plugin-integration-core/lib/stock-preparation-yida-allocation.mjs` |
| RT | `plugins/plugin-integration-core/lib/yida-rule-template.mjs` |
| PRD | `plugins/plugin-integration-core/lib/yida-initialization-producer.mjs` |
| SAP | `plugins/plugin-integration-core/lib/yida-send-authority-primitives.mjs` |
| SPT | `plugins/plugin-integration-core/lib/yida-owner-send-port.mjs` |
| DR | `plugins/plugin-integration-core/lib/yida-delivery-runner.mjs` |
| DLS | `plugins/plugin-integration-core/lib/yida-delivery-store.cjs` |
| FT | `plugins/plugin-integration-core/lib/yida-form-transport.cjs` |
| TE | `plugins/plugin-integration-core/lib/yida-token-exchange.cjs` |
| MS | `plugins/plugin-integration-core/lib/yida-credential-material-store.cjs` |
| PI | `plugins/plugin-integration-core/index.cjs` |
| WS | `apps/web/src/components/integration/stockPreparation/StockPreparationWorkspace.vue` |
| BV | `apps/web/src/components/integration/stockPreparation/StockPreparationProjectBoardView.vue` |
| PV | `apps/web/src/components/integration/stockPreparation/StockPreparationYidaPreviewPanel.vue` |
| IP | `apps/web/src/components/integration/stockPreparation/StockPreparationYidaInitializationPanel.vue` |
| OP | `apps/web/src/components/integration/stockPreparation/StockPreparationYidaOwnerSendPanel.vue` |
| CI | `apps/web/src/services/integration/yidaInitialization.ts` |
| CO | `apps/web/src/services/integration/yidaOwner.ts` |
| WA | `apps/web/src/services/integration/stockPreparation/workbenchAccess.ts` |
| PRB | PR #6315 正文的 “Current candidate” 一节 |
| PROBE | 编写与核验时在本地执行的探针（不在仓库内）：示例配置经真实校验器与编译器、合成样例的初始化可达性、app.env 读取片段与部署脚本逐字对照 |

---

## 页首 / 0. 审批与前置条件

| # | 陈述 | 证据 |
|---|---|---|
| H.1 | 适用于 `e1a9e914c` + `825a6fbe8`；无修复时 CLI 不在 dist | PATCH:7-13（问题描述）、PATCH:95-108（TSC include 新增脚本）；修复前：TSC include 不含该脚本（`e1a9e914c` 的 TSC:23-30）、PB:47-58（部署包只带 dist 等，不带 scripts/*.ts 与 src/integration） |
| H.2 | 开关默认关闭；本手册不授权 | ORT:156（缺省 `'false'`）、ORT:184-188；IDX:648；FM:51-58；PRB:3（"Nothing here authorises merge, deployment, turning the switch on, customer data, a real token exchange or a real YiDa send"） |
| H.3 | 开关前置条件在 PR 正文 | PRB:53-66 |
| 0.1.① | 合并/部署需批准 | PRB:3、PRB:68；FM:58（"…deployment require separate owner authorization"） |
| 0.1.② | 生产库运行登记命令、真实 owner/租户需部署 owner 另行授权 | CLIF:5-8（注释原文 "Production execution and the real owner/tenant must be separately authorized by the deployment owner"）；CLI:6-9 同 |
| 0.1.② 不可撤回 | 锚点永久 | M096:25-46（锚点表插入后禁止 UPDATE/DELETE/TRUNCATE）；BS:92-101（已有行只比较、不覆盖）；R 中无写锚点路由（R:242-290） |
| 0.1.③ | 初始化永久、开关关闭可做、不发送不换令牌 | M094:4-5（`CHECK (slot = 1)`）、M094:33-48；IRT:233-235（已初始化再 POST → CONFLICT）；IRT:143；IP:4；IDX:653-656（初始化 runtime 无 readEnablement） |
| 0.1.④ | 开关可关、在途收不回 | FM:58（"Turning off cannot recall admitted requests already in flight"） |
| 0.1.⑤ | 业务键永久占用 | M091:1-5（"Every status retains its reservation, including not_sent"） |
| 0.2 | 十项条件白话转写 | PRB:57-66 |
| 0.2 列“最迟在哪一步” | 3、5、7、9 须在初始化前：初始化后凭据只认第 1 代（IRT:216、IRT:225、IRT:245）；材料经页面请求体发送（CI:143-146 附近 fetch 体）；密文不可改（M092:58-65 只允许轮换/撤销、M093:49-92、M094:33-56、M095:56-89）；租户核实可由冒烟 GET 证明（IRT:181-196）。**此列是编写者依据代码作出的排序建议，属推断，不是 PR 正文原文**；核验者 A2 提出同一结论 |
| 0.3 | 合并另需 CI 绿、#6313 裁定、合并批准 | PRB:68 |

## 1. 总览

| # | 陈述 | 证据 |
|---|---|---|
| 1.1 | 运维登记 owner 是命令行、非 HTTP | CLIF:5-8；BS:66-74 |
| 1.2 | 预演只在浏览器内 | PV:3-5、PV:272-283（纯函数调用，无请求） |
| 1.3 | 初始化入口依赖有效 v2 创建预演；CREATE 入口依赖 GET 报告的开关位 | PV:91-99、PV:262-271；R:178-185（`sendEnabled` 随初始化读取返回） |
| 1.4 | 发送一次只一行 | R:122-126（`maxAttempts 1`）；OP:7（`!!draft` 后不可再存）、OP:36（`!!grant` 后不可再授权）、OP:92（locked） |
| 1.5 | 步骤顺序与批准对应 | 由 0.1 各行推出；冒烟在初始化前见 3.3 |

## 2. 客户准备

| # | 陈述 | 证据 |
|---|---|---|
| 2.1 | 只用测试应用/表单是 owner 决策，代码不区分 | `#6313` 的 `yida-local-synthetic-trial-guide-20261010.md`、`yida-owner-onboarding-decision-20261009.md` §9；代码无测试/生产区分（SP:133-137 只校验格式） |
| 2.2 | 一个部署只有一个目标、永久 | M094:4-5、M094:33-48；M096:2-3、M096:11-12；IRT:233-235；IP:5 |
| 2.3 | appKey/appSecret 用于换应用令牌 | TE:6、TE:144-172（POST body `{appKey, appSecret}`）；SPT:125-134 |
| 2.4 | systemToken、userId 随创建请求发送 | FT:107-119（`body = {...data, systemToken, userId}`）；DR:336-339 |
| 2.5 | 长度限制 4096 / userId 128；不去空格 | R:158-160（只查 trim 后非空与长度，不改值）；IRT:101-103；MS:52-59（注释 "Do not trim or normalize secret bytes"）；TE:56-58；FT:64-66（`credential` 不要求无首尾空白）；CI:96-97（"never trim/normalize any material string"）；IP:12、IP:77-80（粘贴取剪贴板原文） |
| 2.5b | userId 不能有首尾空白 | R:172-175（`executionIdentity` 走 `literalId` 且必须等于 `material.userId`）；R:51-54；IRT:107-108 |
| 2.6 | userId 同时作为执行身份 | R:175；IRT:107；IP:12、IP:117 |
| 2.7 | organizationId 只查格式（1–128、无首尾空白/控制字符），不核验含义、不发送 | R:172-174（`literalId`）、R:51-54；CI:49-51（`canonical`）；FT:117（请求体不含它）；OP:28（预览显示“组织”） |
| 2.8 | appType/formUuid 进入目标并随请求发送 | SP:133-137、SP:414-423；FT:113 |
| 2.9 | 字段目录不向宜搭查询 | PV:24；SP:1-2 |
| 2.9b | 字段 ID 填错：非 2xx → outcome_unknown；2xx 带合格 result → acknowledged | FT:134-142（非 2xx → `RESPONSE`）；DR:184-191、DR:341-343（`receipt_invalid`/`transport_unknown` → markUnknown）；FT:249-258（create 只取 `result`，注释 "Even an error-looking 2xx body is only an HTTP ACK"）；DR:174-182、DR:344-348。宜搭对错误字段 ID 回 2xx 还是非 2xx：**UNVERIFIED**（第 8 章第 5 项） |
| 2.10 | 标识符字符集含 Unicode 字母、1–128、禁用片段 | SP:7（`/^[\p{L}\p{N}_-]{1,128}$/u`）、SP:8、SP:59-61；FT 侧同样检查 FT:83-85；PROBE（refute-probe-v2b：中文字段 ID 通过、含空格/含 token 拒绝） |
| 2.10b | 数据每行每个键都须符合标识符规则，否则整份数据 `YIDA_STATIC_ROWS_INVALID` | SP:244-257（`validIdentifier(key)` 不合格即抛整份错误）；PROBE（refute-probe-v2b：键 `tokenNo` 或含空格 → 全拒；中文键通过） |
| 2.11 | 控件四种；界面「单选」=select、「单选按钮」=radio；v2 值只能 string/number | PV:27；SP:15、SP:191-195 |
| 2.11b | 控件类型不发给宜搭 | FT:112-117（create 请求只含 appType、formUuid、formDataJson、systemToken、userId） |
| 2.12 | 需 HTTPS 出网；后端用 Node 内置 fetch、未配代理 | TE:6、FT:6（固定 HTTPS 端点）；IDX:645（`fetch: globalThis.fetch.bind(globalThis)`）；TE、FT 中无 proxy/agent/dispatcher（已 grep）。Node 内置 fetch 默认不读代理环境变量：**推断**（Node 20 运行时行为，未在客户主机实测） |
| 2.13 | 材料不进浏览器存储，提交后清空 | IP:5、IP:51-54、IP:118-119、IP:125；CI:96-97 |
| 2.U | 控制台位置、应用类型与权限、organizationId 取值、防火墙/代理 | **UNVERIFIED** → 第 8 章第 1、2、3 项 |

## 3. 运维部署

### 3.1 部署与迁移

| # | 陈述 | 证据 |
|---|---|---|
| 3.1.1 | 部署脚本默认执行迁移，用部署包内 `dist\src\db\migrate.js` | APK:15（`RunMigrations = '1'`）、APK:1276-1283 |
| 3.1.2 | `pnpm … migrate` 是开发命令（tsx + 源码） | PKG:13-15（`"migrate": "tsx src/db/migrate.ts"`、`db:list`） |
| 3.1.3 | `--list` 只读；`--confirm N` 退出码 0/1/2 | MIG:129-130（帮助文字原文 "exit 0 applied / 1 pending / 2 unknown"）、MIG:151-160 |
| 3.1.4 | `.sql` 迁移只有 up | MP:180-190、MP:219-252 |
| 3.1.5 | 090 两表 + 状态集合 + 触发器 | M090:3、M090:20、M090:49、M090:69-136；状态迁移只允许 prepared→dispatching/not_sent、dispatching→acknowledged/outcome_unknown（M090:91-94） |
| 3.1.6 | 091 唯一索引，所有状态保留占位 | M091:1-5 |
| 3.1.7 | 092 两表；材料加密列 | M092:4、M092:21；M092:14-17 |
| 3.1.8 | 093 四表只增 | M093:1-3、M093:18、M093:29、M093:40、M093:49-92 |
| 3.1.9 | 094 单槽目标表 + 审计 | M094:1-5、M094:23、M094:33-56 |
| 3.1.10 | 095 四表只增 | M095:1-3、M095:30、M095:37、M095:47、M095:56-89 |
| 3.1.11 | 096 锚点 + 初始化表 + REVOKE PUBLIC | M096:2-46、M096:47（`REVOKE ALL … FROM PUBLIC`） |
| 3.1.12 | 纯新增、不改旧表 | 七个文件仅含 `CREATE … IF NOT EXISTS`、`CREATE OR REPLACE FUNCTION`、对自身触发器的 `DROP TRIGGER IF EXISTS`、M096:47 的 `REVOKE`；无 `ALTER`/`DROP TABLE`（已 grep） |
| 3.1.13 | 部分手改被拒、部分被允许且不可逆 | 允许：M090:91-94（账本状态推进）、M092:58-65（凭据 generation+1 轮换、current→revoked 撤销）；后果见 5.3 |
| 3.1.14 | 读 DATABASE_URL 用同一 app.env 读法 | APK:57-91；见 3.2.6 |
| 3.1.U | `--confirm` 在客户部署包上的实际输出 | **UNVERIFIED**（未在部署包上执行；依据 MIG 源码与 APK 用同一入口） |

### 3.2 登记 owner（CLI）

| # | 陈述 | 证据 |
|---|---|---|
| 3.2.1 | 永久、不可经 HTTP 建立/转移/清空 | BS:66-74；M096:25-46；R:242-290 无写锚点路由 |
| 3.2.2 | 前提：用户启用、激活检查、租户有效成员关系 | ALA:110-124（读取）、ALA:130-142 |
| 3.2.3 | 实时集成管理员的确切条件：admin 角色（user_roles 或 users.role）或 `role:admin`；或 `integration:admin`（任一来源）+ 角色属 integration 命名空间 + 准入启用 | ALA:131-132（`normalizedAdmin` / `effectiveRole`）、ALA:144-148（权限码合并 role_permissions、user_permissions、users.permissions）、ALA:151、ALA:153-161 |
| 3.2.4 | 建议只有一条有效组织成员关系 | AUTH:414-427（未显式选组织时 `LIMIT 2`，`rows.length === 1` 才给会话租户）；R:66（无会话租户 → `YIDA_OWNER_HTTP_DENIED`）；JWT:100-104 |
| 3.2.5 | 清单仅 `ownerId`/`tenantId`、非空 ≤128、无首尾空白/控制字符；≤4096 字节；UTF-8 | CLIF:36-49、CLIF:50-61（`TextDecoder … fatal: true`）；CLIT:31-42 |
| 3.2.6 | 第 2 步：修复版 CLI 编译到 `dist/scripts`；修复前不存在 | PATCH:15-24、PATCH:95-108；CLIF:116（注释给出部署命令） |
| 3.2.7 | 第 3 步：CLI 只读环境变量 `DATABASE_URL`，不读 app.env；不要放命令行 | CLIF:62-68；CLIF:5-8（"Never pass credentials or database URLs on the command line"） |
| 3.2.8 | app.env 读法：trim、去一层引号、逐行 Set-Item（同名后者覆盖）；默认位置 `docker\app.env` | APK:57-91、APK:1064-1068；SPM:33-46（`app.env` 或 `docker\app.env`）、SPM:48-71 |
| 3.2.9 | 第 4 步：参数恰好 `--input <绝对路径> --apply`；Windows 路径用 `path.isAbsolute` 判定 | CLIF:31-35；CLIT:10-20 |
| 3.2.10 | 作为入口运行时打印一行 JSON 并设退出码；被导入时不打印 | CLIF:114-122（`require.main === module`）；PATCH:80-94（新单测：导入不运行）；PATCH:36-38（变异：入口判断强制为假 → 不打印、退出码 0） |
| 3.2.11 | 以打印的 JSON 判读，而非退出码 | 由 3.2.10 推出：不打印时 `process.exitCode` 未设，Node 以 0 退出 |
| 3.2.12 | 六种结果与退出码 | CLIF:10（Status 集合）、CLIF:18-19（definite 映射）、CLIF:95-112；CLIF:119-120（`ok ? 0 : 1`）；CLIT:60-67 |
| 3.2.13 | 实测：坏参数 → input/1；未知 owner、非管理员 → denied/1 且 0 行；无 DATABASE_URL → unconfirmed/1；合格管理员 → provisioned/0 且 1 行；同清单重跑 → provisioned/0 仍 1 行；另一合格管理员 → conflict/1 且锚点仍为第一位 | PATCH:26-33（本地合成一次性库实测，非 CI）。**未在客户正式部署包上实测** |
| 3.2.14 | 先查实时管理员、后读锚点 → 重跑时失去权限得 denied | BS:85-91（actor 检查）先于 BS:92-100（锚点）；BS:89（DENIED） |
| 3.2.15 | conflict 时锚点不变 | BS:96-99（不一致 → CONFLICT，不写）；M096:25-46 |
| 3.2.16 | unconfirmed：无 DATABASE_URL；连接/提交中断 | CLIF:62-68、CLIF:24-29；CLIF:84-89（ROLLBACK 后转 UNCONFIRMED）；CLIL:33-35；CLIT:43-52 |
| 3.2.17 | unconfirmed 中重跑修不好的：096 未执行（表不存在 → SQL 错误）、账号权限不足、模块加载失败 | ALA:125-128（SQL 错误 → `AUTOMATION_ACTOR_AUTHORITY_UNAVAILABLE`）→ BS:90（UNAVAILABLE）→ CLIF:18-19 不在 definite 表 → unconfirmed；锚点查询失败同理（BS:93 → BS:114 关闭为非 definite）；模块加载：CLIF:69-71 动态 import 失败 → CLIF:24-29 `ownCode` 再次 import 失败返回 undefined → unconfirmed |
| 3.2.18 | 数据库权限：六表 SELECT+UPDATE、锚点表读写 | BS:72-73；BS:103-105（INSERT 锚点）；PRB:50 |
| 3.2.U1 | app.env 中账号是否满足权限、是否与迁移账号相同 | **UNVERIFIED** → 第 8 章第 6 项 |
| 3.2.U2 | ownerId/tenantId 查取方法 | **UNVERIFIED** → 第 8 章第 9 项 |
| 3.2.U3 | PowerShell 读取片段本身 | 按 APK:57-91 同一规则编写；**未在客户主机执行** |

### 3.3 冒烟检查

| # | 陈述 | 证据 |
|---|---|---|
| 3.3.1 | 「填入七项身份合成样例 A」只在 v2 模式出现，产出全部计划创建、可打开初始化 | PV:12-14；PV:188-195（`applyExample`，分配模式 original）；PV:262-271；PROBE（rev-sample-probe：primary/renamed 均 v2 create、2 行全 planned_create、无效 0）。「填入合成样例 A（创建）」是 v1，不能打开初始化（rev-sample-probe：static example version 1；PV:264） |
| 3.3.2 | GET 结果「初始化命令」「已确认本地空槽…」原文 | IP:6-8 |
| 3.3.3 | GET 证明锚点、会话租户、实时权限一致 | IRT:181-196（actor 检查 → 锚点存在 → owner/租户相等）；R:63-67（会话租户来源） |
| 3.3.4 | 不填材料即无法初始化 | IP:48-50（`mayInitialize` 需四项材料、审核编号、organizationId、勾选） |
| 3.3.5 | 结果码含义 | R:66（HTTP_DENIED）；IRT:186、IRT:195（DENIED）；IRT:187、IRT:192（UNAVAILABLE） |

### 3.4 发送开关

| # | 陈述 | 证据 |
|---|---|---|
| 3.4.1 | 进程看到字面 `true` 才开 | ORT:184-188（`value !== 'true'`）；PRB:13 附近（真实路由对 unset/false/TRUE/1/" true"/"true " 均 403）；HB 同 |
| 3.4.2 | app.env 经部署脚本读取时去首尾空格与一层引号 → ` true ` / `"true"` 等于打开 | APK:66-86；SPM:53-69 |
| 3.4.3 | 每次调用读取 `process.env` | IDX:648 |
| 3.4.4 | 需改配置并重启 | **推断**（运行中进程的环境变量无法从外部修改）；现场加载方式 **UNVERIFIED** → 第 8 章第 7 项 |
| 3.4.5 | 关闭时 drafts/preview/approve/submit 拒绝；observe/revoke 可用 | ORT:325、ORT:331、ORT:337、ORT:351（`true`）；ORT:341、ORT:345（`false`）；R:25；OP:9、OP:137 |
| 3.4.6 | 初始化不受开关影响 | IRT:143；IDX:653-656 |
| 3.4.7 | 开关不是授权 | IDX:646-647；AS:207-221；FM:58 |
| 3.4.8 | 令牌请求与表单请求各自再查开关 | SPT:126-131；SPT:136；DR:229-237 |
| 3.4.9 | 关停中止在途；已发出的收不回 | IDX:3789-3790；ORT:189-202、ORT:270-275；FM:58 |
| 3.4.10 | 中止后可能停在 prepared/dispatching/outcome_unknown | DR:305-317（领取前失败，行保持 prepared）；DR:323-345（领取后中止 → markUnknown）；M090:91-94 |

## 4. owner 界面操作

| # | 陈述 | 证据 |
|---|---|---|
| 4.1.1 | 入口在项目备料页、打开项目后的动作区 | WS:107-114（`home`/`project-board` 分支挂 BV）；BV:542-607 |
| 4.1.2 | 浏览器只对 admin / `role:admin` / `integration:admin` 显示 | WA:70、WA:444-454、WA:547-549；BV:578-604 |
| 4.1.3 | 锚点后非 owner 管理员 GET 得 DENIED；锚点前任何实时集成管理员得 UNAVAILABLE；只在手动 GET/提交时出现 | IRT:181-196（先 actor，后锚点；无锚点 → UNAVAILABLE IRT:192；不符 → DENIED IRT:195）；IP:6（手动按钮）、IP:95-109（无自动请求）；IHT:93-94 |
| 4.1.4 | 其他人看到「推送宜搭(暂未接入)」 | BV:597-605 |
| 4.1.5 | 两个按钮文字及行为 | BV:586、BV:593、BV:886-896、BV:607 |
| 4.1.6 | 切换项目号/租户/工作区关闭面板；离开页签卸载；卸载中止请求 | BV:858-860（watch → `yidaPreviewOpen = false`）；WS:107-108（其他页签 v-if 为假 → BV 卸载）；BV:607（v-if 卸载预演面板）；OP:120（onBeforeUnmount → reset）、OP:99-102；IP:94；CO:222-229（dispose 中止请求）；R:229-233（连接关闭 → 服务端 abort） |
| 4.2.1 | 面板标题与“请勿填写凭据” | PV:3-5 |
| 4.2.2 | 规则草稿导入 | PV:69-70、PV:244-260（导入后 appType/formUuid/rows 清空 PV:257） |
| 4.2.3 | 「预演合同」两个选项原文 | PV:7 |
| 4.2.4 | target 去空格，但长度按原文计 | SP:63-68（`value.length <= 128` 在原值上）、SP:224 |
| 4.2.5 | 意图标签、update 只能预演 | PV:19；R:165；SAP:107-108；PRD:76 |
| 4.2.6 | 目录区原文（字段 ID、控件四选项、目录必填、「选项表示」两种、「选项（精确匹配；切换表示后请核对格式）」） | PV:26-31 |
| 4.2.7 | 逐行模式末尾空行 → 空选项 → 配置不合格 | PV:226（`optionsText.split(/\r?\n/)`）；SP:160-163（选项须 `trim().length > 0`） |
| 4.2.8 | 映射区原文；type 下拉含 boolean；v2 只接受按控件的 number/string | PV:42-47；PV:44；SP:191-195 |
| 4.2.9 | 分配约束：项目 1–20、无空行/重复/控制字符；项目字段为业务键且 string、业务键 ≥2；数量字段 number；二者不同；展开 ≤100 | AL:7、AL:55-70（`\p{Cc}` 含制表符）、AL:79-95、AL:344；PV:55、PV:58-60 |
| 4.2.10 | 「生成规则草稿 JSON」清空结果、关闭下方面板；锁定时不可用 | PV:230-231（`invalidateOutputs()`）、PV:175-180；PV:6（fieldset disabled） |
| 4.2.11 | 样例按钮原文 | PV:9-14；样例为假目标 SP:522、SP:576 |
| 4.2.12 | rows 输入框与「只在本地预演」 | PV:73-74 |
| 4.2.13 | 结果摘要原文、行状态 | PV:84-89、PV:284 |
| 4.2.14 | 出现初始化入口的条件（含分配无问题） | PV:262-271（PV:266 `allocationPreview.issues.length === 0`）；PV:91-93 |
| 4.2.15 | 任何编辑清空结果并关闭面板 | PV:175-181 |
| 4.2.16 | 行级原因标签原文 | PV:154-163 |
| 4.2.1.x | v2 配置各字段规则 | SP:9-14、SP:127-229；`emptyKeyFields` 必须存在（SP:214-219：`dataArray(undefined)` 为空即报 `CONFIG_EMPTY_KEY_FIELDS_INVALID`） |
| 4.2.1.y | 整份数据被拒的情形：键不合格、值类型、>64 键、>4096 字符、重复键、-0、不安全整数 | SP:244-257；SP:328-334（重复键）；SP:286-290、SP:337-345（v2 数字域） |
| 4.2.1.z | 必填缺失使该行无效；空的非必填字段不写 | SP:377-379、SP:450-474 |
| 4.2.1.w | 草稿至少 1 行、最多 100 行、全部 planned 且 payload 非空 | DP:104-123 |
| 4.2.1.v | 规则草稿外壳 | RT:8-9、RT:94-118、RT:190-214；PV:66 |
| 4.2.1.e | 示例 JSON 合法 | PROBE（refute-probe-v2b：示例配置有效、1 行 planned_create、`compileYidaDraft` 通过、规则草稿外壳往返一致） |
| 4.3.1 | 初始化一次、永久；之后 POST → CONFLICT | IRT:233-235；IHT:73；M094、M096 不可变触发器 |
| 4.3.2 | 初始化不发送、不换令牌 | IRT:136-139；IRT:143 |
| 4.3.A | 批准 ③、条件 3/5/7/9 | 见 0.1、0.2 |
| 4.3.B | 只有 `NODE_ENV=production` 才拒绝默认密钥；否则静默用默认值 | ES:130-178（ES:136 `isProductionRuntime`、ES:152-154 抛错、ES:175-178 回落默认值）；RAC:22-24；ES:32-33（默认值常量） |
| 4.3.C | HTTPS 或 localhost | PRB:61（条件 5）；CI:143-146（材料在请求体中经同源页面发送） |
| 4.3.D | 恰好一条有效成员关系；实时集成管理员；不要求改密码 | AUTH:414-427；ALA:130-161；JWT:84-97（`PASSWORD_CHANGE_REQUIRED` 403） |
| 4.3.E | 096 用 `--confirm` 核实 | MIG:129-130、MIG:151-160 |
| 4.3.F | 冒烟通过 | 见 3.3 |
| 4.3.G | 每次发送须原样重填 appType/formUuid 与业务键定义；初始化后界面不显示 appType/formUuid | SAP:101-114（locator/keyDefinition 不一致 → CONFLICT）；DP:144-153（locator = 去空格后的 target；keyDefinition = 业务键对应的 target、type、empty）；IP:19-24（成功后只显示 operationId、targetRef、rowCount）；OP:29-30（appType/formUuid 只在服务端预览中显示）；RT:96-102（规则草稿不含 target） |
| 4.3.H | 业务键定义永久 | DP:146-153；SAP:110-112 |
| 4.3.I | 单槽永久 | 见 2.2 |
| 4.3.J | 材料不去空格；后果 | 见 2.5；后果见 4.4.4 |
| 4.3.K | 审核编号/organizationId 格式 | R:174；CI:49-51 |
| 4.3.L | 样例目标是假的 | SP:522、SP:576；PROBE（refute-probe-v2b：七项身份样例会把槽位绑定到合成目标） |
| 4.3.M | 失败后 GET 按钮仍可点；成功 GET 解锁；关闭面板也解锁 | IP:6（disabled 只看 busy/invalidated）；IP:99（GET 开始置 `uncertain = true`）、IP:104（成功复位）、IP:106-108（失败不复位）；IP:44-45（locked → emit）；PV:6、PV:94；BV:607（关闭即卸载）。**注**：PRB:49 写“锁到关闭预演为止”，不够精确 |
| 4.4.1 | 面板标题与说明原文 | IP:3-5 |
| 4.4.2 | GET 按钮、命令号、空槽提示原文 | IP:6-8 |
| 4.4.3 | 四个 password 输入；粘贴保留原文 | IP:11-13、IP:36、IP:77-80 |
| 4.4.4 | 带空白的后果：appKey/appSecret → 令牌失败 → prepared；systemToken → 请求到达宜搭 → 非 2xx → outcome_unknown | DR:308-314（取令牌失败 → `TOKEN_FAILED`，行仍 prepared）；TE:144-172（原样发送）；FT:107-119、FT:142；DR:341-343。钉钉/宜搭对带空白值的实际应答：**推断**（手册写“很可能”） |
| 4.4.5 | 审核编号与 organizationId 1–128、无首尾空白 | R:174；CI:49-51 |
| 4.4.6 | 勾选、提交按钮原文与启用条件 | IP:14-17、IP:48-50 |
| 4.4.7 | 提交后材料立即清空 | IP:118-119、IP:125 |
| 4.4.8 | 成功显示原文；选择行不发请求；不显示 appType/formUuid | IP:19-24 |
| 4.4.9 | “状态未确认”原文；只能 GET | IP:9、IP:110-126；CI:132、CI:192-195 |
| 4.4.10 | 浏览器输入检查失败 → INPUT_INVALID、材料已清空、显示状态未确认 → GET 后重录 | CI:85-99（输入检查，失败统一为 `YIDA_INITIALIZATION_INPUT_INVALID`）；IP:113（`uncertain = true`）、IP:119、IP:123-125（失败不复位 uncertain、清空材料）；IP:104（成功 GET 复位） |
| 4.4.11 | GET 必须先于 POST；命令号须等于锚点 | CI:186-199；IRT:196 |
| 4.5.1 | CREATE 入口只在 sendEnabled 为真时出现 | PV:95-98；IP:46-47；R:178-185；ORT:366-372 |
| 4.5.2 | 未初始化保存草稿 → NOT_FOUND | AS:213-216 |
| 4.5.3 | 每次发送路径；目标与业务键定义须一致，否则 SEND_APPROVAL_UNAVAILABLE | PV:91-99；SAP:101-114（CONFLICT）→ SAP 的 `closed` → AS 关闭为 UNAVAILABLE（AS:57-61）；R:29 |
| 4.5.4 | 一个面板一行；授权后预演编辑区与初始化入口被锁 | OP:7、OP:36、OP:92、OP:97（locked → emit）；PV:6（`ownerSendLocked` 锁编辑区）、PV:93（初始化入口 disabled）；OP:118（只有 draftInput 变化或卸载才 reset，编辑区已锁时只能卸载） |
| 4.5.5 | 发送面板标题与说明原文 | OP:3-6 |
| 4.5.6 | 保存草稿、「（复用既有草稿）」 | OP:7、OP:12；DS:210-215 |
| 4.5.7 | 选择行、读取预览原文 | OP:13-19 |
| 4.5.8 | 确认区原文 | OP:22-33 |
| 4.5.9 | 勾选与按钮原文；第一次点击即换成“恢复同一确认结果” | OP:35-39；OP:159-164（首次点击即设 `approvalCommand`） |
| 4.5.10 | 授权成功不代表能发：业务键占用、过期只在准入时查 | AS:308-351（approve 不查账本）；AS:383-391（准入时查撤销、过期、账本/业务键）；DLS:180-201（围栏冲突） |
| 4.5.11 | 1 次、15 分钟；界面固定申请 900000 ms | OP:162；AS:14、AS:311-312；R:81-83 |
| 4.5.12 | 授权记录原文 | OP:42-45 |
| 4.5.13 | 「提交此授权一次」及本地到期检查 | OP:46、OP:93-94、OP:172-180 |
| 4.5.14 | 关闭/刷新/切换中断请求 | 见 4.1.6；ORT:208、ORT:214、ORT:274；PRB:57 |
| 4.5.15 | 浏览器 15 秒超时 | CO:251-252 |
| 4.5.16 | 提交一次后冻结 | OP:50、OP:181-185 |
| 4.5.17 | 刷新/撤销按钮原文；撤销不撤回已发出请求 | OP:47-49；FM:58 |
| 4.5.18 | 授权编号只在页面内存；无列表接口 | OP:81、OP:99-115；R:242-290 |
| 4.6.1 | 状态显示原文；acknowledged 提示原文 | OP:51-53 |
| 4.6.2 | 状态集合 | R:93、R:149；SPT:15、SPT:116、SPT:142 |
| 4.6.3 | acknowledged = 2xx 且 create 应答带合格 `result`；不看其他字段 | FT:142、FT:249-258；DR:174-182、DR:344-348 |
| 4.6.4 | outcome_unknown 原因（含 4xx/5xx） | FT:142（非 2xx → RESPONSE）；DR:184-191（RESPONSE → receipt_invalid）；DR:326-353（`manual_recovery`、`transport_unknown`、`receipt_invalid`、`commit_unknown`） |
| 4.6.5 | 永不自动重发 | R:125；FM:58；SPT:113-118 |
| 4.6.6 | prepared = 已准入未领取 | AS:374-411；DR:305-317；R:82 |
| 4.6.7 | state_unconfirmed | DR:193-197、DR:326-329 |
| 4.6.8 | not_started | SPT:113-118 |
| 4.6.9 | not_sent 当前无代码路径产生 | DLS:316-329（`cancelPrepared` 唯一写 not_sent 处），DLS:339 导出；全仓 grep 无生产调用者 |
| 4.6.10 | 无「持久记录状态」行：只有刷新**成功**且返回 `delivery: null` 时才表示未准入；刷新失败或提交结果丢失时，`observed` 保持为空、状态行同样不显示，此时可能已发出，按结果未知处理 | OP:51（`v-if="deliveryStatus"`）、OP:82、OP:95-96；OP:125-140（`perform` 的 catch 只设 `errorCode`，不调用 apply）；OP:186-192（提交与刷新都只在成功时 `applyObservation`）；AS:435-442（无 admission → `delivery: null`）；授权编号只在页面显示 OP:44 |
| 3.2.x | 已在真实离线包上实测：用仓库打包脚本出包、按部署方式安装（`NODE_ENV=production`，开发依赖被跳过、无 tsx），从解压目录用 node 运行编译后的命令，input / denied / provisioned / 重跑 provisioned / conflict 均符合；命令只用连接串（自建 `Pool({ connectionString })`），不看 `NODE_ENV`/`DB_SSL`；UTF-8 带 BOM 与 CRLF 清单均接受、UTF-16 报 input；系统 `NODE_ENV=production` 下迁移命令默认启用 TLS | CLI 修复提交中的 `bootstrap-yida-initialization-owner.ts`（`new Pool({ connectionString })`）；`packages/core-backend/src/integration/db/connection-pool.ts:260-269`（production 下迁移路径启用 SSL，`DB_SSL=false` 关闭）；实测记录不在仓库内 |
| 3.4.x | 删掉配置行不等于关闭：部署脚本只设置文件中出现的变量，不清除缺失变量；只读确认 = owner 的初始化 GET 成功后是否出现「打开单行 CREATE 确认（服务器已开通）」 | `scripts/ops/multitable-onprem-apply-package.ps1:57-91`（`Import-AppEnvFile` 逐行 `Set-Item Env:`，无清除）；PV:91-99（入口 `v-if="ownerSendEnabled && !ownerSendOpen"`，`ownerSendEnabled` 来自初始化面板）；IP:46-47（只在 GET/POST 成功后发出 `state.sendEnabled === true`）；R:275-288（服务器在授权读取后返回 `sendEnabled`） |
| 4.6.11 | 未准入的原因：过期、撤销、业务键占用、凭据撤销 | AS:383-384、AS:397（撤销/过期）；AS:385-391、DLS:180-201（业务键）；HRT:256（凭据撤销 → 首次准入被阻止、提交 503） |
| 4.7.1 | ACK 不是业务核验；无自动回读 | R:150；FT:257-258；OP:52 |
| 4.7.2 | 界面不显示实例 ID | R:94-98；ack_instance_id 仅在 M090:24 |

## 5. 异常处理

| # | 陈述 | 证据 |
|---|---|---|
| 5.1.1 | 服务器错误码与 HTTP 状态表 | R:23-30、R:190-195、R:204、R:214-222、R:290；CO:92-100、CI:31-36 |
| 5.1.2 | UNAUTHORIZED | R:64；CI:150 |
| 5.1.3 | HTTP_DENIED = 会话无租户；成员关系规则 | R:66；JWT:100-104；AUTH:399-411（显式选组织）、AUTH:414-427（未显式时恰好一条） |
| 5.1.4 | HTTP_INPUT：查询参数、作用域头、非 JSON、过大；初始化体不合格也是此码 | R:20-22、R:69-72、R:236、R:202-208、R:214-222；R:31-35（`fail()` 缺省码为 HTTP_INPUT）、R:155-177（初始化体校验全部用 `fail()`）；IDX:1857-1858 |
| 5.1.5 | RUNTIME_INACTIVE | ORT:207；IRT:158；PI:568-597 |
| 5.1.6 | 提交路径上所有核心拒绝都包装为 RUNTIME_UNAVAILABLE | SPT:147（`catch → closed(error)`）、SPT:29-30（外来错误 → UNAVAILABLE）、SPT:110（准入在 try 内）；ORT:69-76（非自身、非审批码 → UNAVAILABLE）；DR:314（TOKEN_FAILED 抛出）；HRT:239（撤销后提交 503）、HRT:250（缺权限提交 503）、HRT:256（凭据撤销提交 503）、HRT:273（另一提交号 503）；HRT:224（提交路径非 owner → 503，其他路径 404） |
| 5.1.7 | CANCELLED | ORT:208、ORT:263、ORT:274；AS:47-57 |
| 5.1.8 | NOT_FOUND：未初始化 / 非 owner / 授权不存在（非提交路径） | AS:213-216、AS:227-229；HRT:224 |
| 5.1.9 | CONFLICT 只剩：同确认号参数不同、刷新时账本与授权不符 | AS:319；AS:416-433（`delivery()` 中 CONFLICT）；observe 路径不包装：AS:586（authority 暴露 observe）、ORT:343-345、ORT:74（审批码直接透传）。AS:379、AS:391 的 CONFLICT 在提交路径上被 SPT:147 包装 |
| 5.1.10 | EXPIRED/REVOKED 服务器不会经当前界面路径返回 | AS:383-384、AS:397 只在 `persistAdmission`（提交路径，被包装）；AS:357-368（撤销幂等，重复返回 200 `reused: true`；HRT:234-236）；R:242-290 无 `admit` 路由 |
| 5.1.11 | APPROVAL_UNAVAILABLE 覆盖多种原因 | AS:57-61；SAP:24-34、SAP:101-114；HB:62-68、HRT:248（缺实时权限 → 503 `YIDA_SEND_APPROVAL_UNAVAILABLE`） |
| 5.1.12 | INITIALIZATION_DENIED：非实时管理员，或锚点 owner/租户不符；只在手动 GET/提交时 | IRT:181-188、IRT:195；IHT:93-94、IHT:104；IP:6、IP:95-126 |
| 5.1.13 | INITIALIZATION_UNAVAILABLE：无锚点（实时管理员得此码）、库/锁异常、草稿编译失败、凭据被轮换/撤销后 | IRT:187、IRT:190-194；IRT:261-265；PRD:13-23；IRT:211-231（validate：IRT:216 第 1 代、IRT:225 `status = 'current'`，否则 UNAVAILABLE） |
| 5.1.14 | INITIALIZATION_CONFLICT | IRT:196、IRT:235；IHT:73 |
| 5.1.15 | INITIALIZATION_INPUT 少见 | IRT:99-109（运行时二次检查）；多数情况先被 R:155-177 拦为 HTTP_INPUT |
| 5.1.16 | INITIALIZATION_CANCELLED 也是浏览器 15 秒超时 | CI:137-138 |
| 5.2.1 | 浏览器端码 | CI:42、CI:98、CI:129、CI:132、CI:138、CI:148、CI:171、CI:194；CO:106、CO:126、CO:243、CO:252、CO:262、CO:285；IP:59、IP:62；OP:123、OP:136 |
| 5.2.2 | 会话变化触发条件 | CI:122-129；CO:233-243 |
| 5.2.3 | 会话变化清空材料与授权显示 | IP:55-60；OP:99-115、OP:123 |
| 5.2.4 | PASSWORD_CHANGE_REQUIRED 不在白名单 → RESPONSE_INVALID | JWT:84-97；CI:31-36、CI:174；CO:92-100、CO:288 |
| 5.2.5 | INPUT_INVALID 处理 | 见 4.4.10 |
| 5.2.6 | 浏览器本地 EXPIRED，请求未发出 | OP:172-180（`return` 在发送前） |
| 5.2.7 | 预演区错误码；ROWS_INVALID 为整份拒绝 | PV:242、PV:259、PV:275-282；SP:236-267、SP:361-375；AL（例 AL:57、AL:85、AL:344）；RT:15-23 |
| 5.3.1 | 业务键永久占用、无界面释放 | M091:1-5；FM:58；PRB:58 |
| 5.3.2 | 部分手改被拒、部分被允许且不可逆 | 被拒：M090:69-89（不可变列）、M093:49-92、M094:33-56、M095:56-89、M096:25-46；被允许：M090:91-94、M092:58-65 |
| 5.3.3 | prepared→not_sent 不释放占用 | M091:1-5 |
| 5.3.4 | 凭据轮换/撤销后初始化读取永远 UNAVAILABLE | IRT:216、IRT:225；M092:58-65（只能前进：generation+1 或 revoked） |
| 5.3.5 | 凭据无界面更换/重新登记 | IRT:216、IRT:225、IRT:245；R:242-290 无轮换/撤销路由；PRB:59 |
| 5.3.6 | appKey/appSecret 错 → 令牌失败 → prepared、提交 503 | DR:305-317；SPT:147；ORT:69-76 |
| 5.3.7 | systemToken/userId/appType/formUuid/字段 ID 错 → 请求到达宜搭；非 2xx → outcome_unknown；2xx → acknowledged | DR:336-345；FT:107-119、FT:142、FT:249-258 |

## 6. 安全须知

| # | 陈述 | 证据 |
|---|---|---|
| 6.1 | 材料不回显 | R:178-185；R:119-145；AS:577-578 |
| 6.2 | 明文 HTTP 风险 → HTTPS 或 localhost | PRB:61；CI:143-146 |
| 6.3a | 平台 `enc:` 加密用 ENCRYPTION_KEY/SALT | PRS:190-192；ES:32-38、ES:85-92；M092:14-17、M094:19 |
| 6.3b | 只有 NODE_ENV=production 拒绝默认/未配置；否则静默用公开默认值 | ES:130-178（ES:136、ES:152-154、ES:175-178）；ES:32-33；RAC:22-24 |
| 6.3c | 记录不可修改 → 换密钥后无法重新加密 | M092:37-69、M093:49-92、M094:33-56、M095:56-89；PRB:63 |
| 6.4 | K3 写回永久禁止 | `AGENTS.md:63`、`AGENTS.md:68` |

## 7. 已知限制

| # | 陈述 | 证据 |
|---|---|---|
| 7.1 | 单 owner / 单目标 / 单业务键定义 / 单凭据，永久 | M094:4-5、M096:2-3、IRT:216-225；DP:146-153 |
| 7.2 | 只手动单行 CREATE；一个面板一行 | FM:58；SAP:162；R:122-126；见 4.5.4 |
| 7.3 | 1 次、≤15 分钟 | AS:14、R:81-83 |
| 7.4 | ACK 非业务核验 | 见 4.7.1 |
| 7.5 | 无凭据更换途径；空白无法去掉 | 见 5.3.5、2.5 |
| 7.6 | prepared/unknown 无界面处理 | 见 4.6.9、5.3.1 |
| 7.7 | 刷新后找不回授权 | 见 4.5.18 |
| 7.8 | 初始化后不显示 appType/formUuid | 见 4.3.G |
| 7.9 | UNAVAILABLE 粗粒度 | 见 5.1.6、5.1.11、5.1.13 |
| 7.10 | 入口比服务器宽 | 见 4.1.3 |
| 7.11 | 控件与值类型限制、字段 ID 禁用片段 | 见 2.10、2.11 |
| 7.12 | 手工粘贴 JSON；≤100 行 | BV:607（面板无 props）；PV:54；SP:4 |
| 7.13 | 开关变更需重启 | 见 3.4.4（推断） |
| 7.14 | 出网不经代理 | 见 2.12 |

## 8. 待 owner 确认（全部 UNVERIFIED）

| # | 事项 | 为什么代码证明不了 |
|---|---|---|
| 1 | 钉钉应用类型、接口权限、各值在控制台的位置 | 代码只用固定端点（TE:6、FT:6），不涉及控制台 |
| 2 | organizationId 应填什么 | 代码只查格式（R:174），不发送（FT:117） |
| 3 | 防火墙放行、是否需要出网代理 | 现场事实；后端 fetch 未配代理（IDX:645） |
| 4 | 永久槽位是否有意绑定测试表单；首发是否按 #6313 §9 一条合成记录 | owner 决策；代码不区分测试/生产 |
| 5 | 宜搭对错误字段 ID/选项回 2xx 还是非 2xx | 外部系统行为；代码不解释 2xx 内容（FT:257-258） |
| 6 | 运行账号与迁移账号是否相同；CLI 用哪个账号、权限是否齐全 | M096:47 撤销 PUBLIC；BS:72-73 列出权限；现场账号配置未知 |
| 7 | 客户主机环境变量加载方式与重启步骤 | APK/SPM 只覆盖脚本路径；pm2-runtime 现场方式未知 |
| 8 | 是否允许 DBA 只读查询 ack_instance_id | owner 决策（M090:24 列存在，界面不显示 R:94-98） |
| 9 | ownerId/tenantId 取值方法 | 现场数据 |
| 10 | 多组织 owner：保留一条还是登录时显式选组织 | AUTH:399-411 支持显式请求租户，但登录界面是否提供选择未在本次核对 |
| 11 | 客户主机 NODE_ENV、ENCRYPTION_KEY/SALT 现状 | 现场事实 |
| 12 | 材料交接安全渠道 | owner 决策 |
| 13 | 十项条件逐项裁定（3、5、7、9 在初始化前） | owner 决策（PRB:53-66） |

## 其他仍未验证的陈述

1. 第 3.1、3.2 节的 PowerShell 片段未在客户主机执行（3.1.U、3.2.U3）。
2. 修复版 CLI 只在本地合成一次性库上实测（3.2.13），未在正式部署包上运行。
3. “无锚点 → 503”无专门测试，属代码推导 + PR 正文（IRT:190-192；PRB:49）。
4. 钉钉/宜搭对带空白材料、错误字段 ID 的实际应答（4.4.4、2.9b）。
5. 0.2 节“最迟在哪一步”列是编写者的排序建议（0.2 列）。
6. 开关变更需要重启——进程语义推断（3.4.4）。

## 与 PR #6313 设计文档、PR 正文不一致之处

1. **迁移编号**：#6313 文档使用旧编号（`yida-owner-onboarding-decision-20261009.md` §6 称锚点为“094迁移”；`yida-single-row-delivery-design-20260930.md` §4 与 `yida-owner-limited-send-design-20261009.md` §151 称账本/围栏/授权为 088/089/093；`yida-token-lifecycle-design-20260930.md` §7 称材料表为“090”）。代码实际为：090 账本、091 围栏、092 材料、093 草稿、094 目标、095 授权、096 锚点。
2. **入口可见性**：`yida-static-preview-design-20260930.md` §4 写“不扩权限”；代码只对平台管理员显示宜搭入口（WA:547-549、BV:578-605）。
3. **材料轮换**：`yida-token-lifecycle-design-20260930.md` §7 描述可轮换覆盖、撤销擦除；数据库确实允许（M092:58-65），但初始化只认第 1 代且 `current`（IRT:216、IRT:225），轮换或撤销后本功能永久不可用；也没有 HTTP 路由暴露轮换/撤销（R:242-290）。
4. **合成试用命令**：`yida-local-synthetic-trial-guide-20261010.md` 指向的 `scripts/ops/run-stock-preparation-yida-synthetic-trial.mjs` 不在 `e1a9e914c` 树中。
5. **PR 正文 PRB:49**：“locks the preview editor until the preview is closed”——实际成功 GET 一次也会解锁（IP:104），见 4.3.M。
6. 其余已核对、未发现矛盾：15 分钟上限与一次尝试、未知不重试、不自动释放 not_sent、`ready` 仅在目标与初始化结果均缺失时报告、owner ∩ 集成管理员。

## 对照 `42ff6d072` 新增的依据

| 条目 | 事实 | 依据 |
|---|---|---|
| 3.2 第 3 步 | 登记时加载的服务端模块经连接池读取 `DATABASE_URL`，`NODE_ENV=production` 时为必需；`SECRET_PROVIDER=file` 时从文件读取，缺失时抛出 | `packages/core-backend/src/integration/db/connection-pool.ts:255`；`packages/core-backend/src/security/SecretManager.ts:74-79`、`:103` |
| 3.2 钉钉登录前提 | 首次钉钉登录未配置 corpId 时 409 `auto_provision_corp_required`；多个账号匹配时 409 `identity_ambiguous` | `packages/core-backend/src/auth/dingtalk-oauth.ts:1327`、`:1057` |
| 3.3 / 5.1 403 处理 | 会话租户只在恰好一条有效成员关系或请求的组织为该用户所属时签发；可按所选组织重新签发会话 | `packages/core-backend/src/auth/AuthService.ts:393`；`packages/core-backend/src/routes/auth.ts:1242` |
| 3.2 第 2 步 | 随包校验把命令与引导模块列为必需内容 | `scripts/ops/multitable-onprem-package-verify.sh:1037-1038`、`:1175-1177` |
