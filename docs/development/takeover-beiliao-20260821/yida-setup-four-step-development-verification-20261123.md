# 宜搭表单配置面板：四步改版 —— 开发与验证（2026-11-23）

> 设计见 `yida-setup-four-step-design-20261123.md`；读表单字段的授权边界见 `adr-yida-connection-test-20261028.md` §12；裁定见登记册 R-107。
> **分支**：`feat/yida-panel-four-step-20261123`，基于 #6812 头 `ed1cc1869`。**values-free**：本文只有合成值和位置。

## 1. 改了哪些文件

| 层 | 文件 | 内容 |
|---|---|---|
| 插件 | `plugins/plugin-integration-core/lib/yida-connection-probe.cjs` | 新增 `probeForm()`：一次换令牌后，对固定端点读一次表单组件定义，丢掉令牌，只回四个键的字段列表 |
| 宿主 | `packages/core-backend/src/integration/yida-connection-test-runtime.ts` | 可选 `form` 输入、新开关读取（事务前、出网前各一次）、插件回执二次校验、`formFieldsReadEnabled()` 显示位 |
| 路由 | `packages/core-backend/src/routes/integration-yida-owner.ts` | 开关开时请求体收 `form`、回复带 `formRead`；状态回复的显示位（关时不出现） |
| 装配 | `packages/core-backend/src/index.ts` | `readFormFieldsEnablement: () => process.env.INTEGRATION_YIDA_FORM_FIELDS_READ_ENABLED` |
| 开关清单 | `scripts/ops/global-history-flag-manifest.mjs` | 新开关登记（默认关、danger high、只认 `'true'`） |
| 前端客户端 | `apps/web/src/services/integration/yidaInitialization.ts` | 请求可带 `form`；解析 `formRead` 与显示位（都是封闭键集） |
| 前端映射 | `apps/web/src/services/integration/yidaSetupMapping.ts`（新） | 9 个备料字段、宜搭控件对照、自动配对、生成 v2 合同 |
| 前端面板 | `StockPreparationYidaPreviewPanel.vue`（重写）、删除 `StockPreparationYidaInitializationPanel.vue` | 四步界面；看板按钮改名「宜搭表单配置（不发送）」 |
| 测试清单 | `plugins/plugin-integration-core/test-chain.txt`、`.github/workflows/integration-guard.yml` 与 `scripts/ops/integration-guard-guarded-paths.mjs`、`apps/web/scripts/run-required-web-tests.sh`（与 `.tokens`）、`scripts/ops/integration-guard-run-web-specs.sh` | 新测试登记；删掉的 spec 换成新的客户端 spec |

没有迁移；不碰 R-105 的热点区。

## 2. 测试

| 套件 | 结果 | 说明 |
|---|---|---|
| 插件 `__tests__/yida-connection-probe-form.test.cjs`（新） | 8/8 | 端点写死字面量；换令牌失败不读表单；非 2xx、格式不符、超大、重复字段、坏组件名一律 `upstream_rejected`；非法表单号或私密值零出网 |
| 插件 `__tests__/yida-connection-probe.test.cjs` | 9/9 | 只改形状断言（探针现在有 `probe`、`probeForm` 两个方法） |
| 后端 `tests/unit/yida-connection-test-form-fields.test.ts`（新） | 30/30 | 新开关每个非字面量值都在事务和出网之前 DISABLED；授权后开关被关，出网前停；缺 `probeForm` 为 INACTIVE；六种畸形插件回执都是 UNAVAILABLE；路由在开关关时对 `form` 答 400 |
| 后端 `yida-connection-test-runtime.test.ts` + `yida-host-capability-injection.test.ts` + `yida-connection-test-http-boundary.test.ts` | 原有用例全过 | 未改一行 |
| 前端 `tests/yidaInitializationClient.spec.ts`（新） | 59/59 | 旧 `StockPreparationYidaInitialization.spec.ts` 里与组件无关的客户端护栏用例原样迁来（含变异见证），并新增读字段一组 |
| 前端 `tests/StockPreparationYidaPreview.spec.ts`（重写） | 14/14 | 自动读状态、四步与必填标记、读字段后下拉自动配对、开关关时手填、保存一次 POST 且合同为 v2 七键、规则草稿自动存档且不含目标和凭据、预演后改映射即失效、凭据改动挡保存、保存回复丢失不重发只重读、已初始化即锁定、DENIED 清空 |
| 前端 `StockPreparationProjectBoard.spec.ts`、`stockPrepPermissionMatrix.spec.ts`、`StockPreparationYidaOwnerSend.spec.ts` | 106/106、26/26、64/64 | 看板与权限矩阵按新面板改了断言（预演需要完整映射，改为检查样例行已填） |
| 开关清单 / 守卫契约 / 安装包闭包（WSL Linux 克隆） | 90/90、64/64、29/29 | Windows 工作树里这两份契约因 PyYAML 与换行符跑不了，故在 Linux 克隆里跑 |
| 类型检查 | 前端 `vue-tsc`、后端 `tsc --noEmit` 通过 | |

整链复跑（插件测试链、后端全部宜搭单测、上面五份前端 spec、两边类型检查）在 WSL Linux 克隆上做，结果见 §5。

## 3. 怎么在彩排机上验（合入后用新包）

1. 打开备料页 → 有数据的项目看板 → 「宜搭表单配置（不发送）」。应看到四步，状态行自动显示「服务器已就绪」，页面上没有「手动 GET」。
2. 服务器两个开关：`INTEGRATION_YIDA_CONNECTION_TEST_ENABLED=true`，以及要读字段时的 `INTEGRATION_YIDA_FORM_FIELDS_READ_ENABLED=true`（彩排机属我方自有环境；切换要重启后端）。
3. 第 1 步填七项，点「测试连接并读取表单字段」：应看到「appKey/appSecret 有效」和「已读到这张表单的 N 个字段」。读不到时，看提示里列出的几种原因，第一个就是钉钉应用要开通「宜搭表单数据读权限」。
4. 第 2 步：九行里能唯一对上名称的已经选好；补全单选类字段的选项。
5. 第 3 步点「预演」（不填数据时用合成样例）：应为「计划创建 2、无效 0」。
6. 第 4 步填审核编号、勾确认、点「保存启用」：浏览器下载一份 `yida-rule-draft-<formUuid>-<日期>.json`；页面显示「已保存启用」。
7. 实测记录：定义接口真实应答里带不带选项、必填（只记有没有这些键，不记值）。

## 4. 现场 R85 要不要升级

- 不为这次改版单独升级（R-107 ④）。改版随下一个 main 包 P3 一起进现场；P3 本来就要装（带宜搭合并链）。
- 首发窗口随之从 R85 移到 P3。PR1 要赶 11-27 的 P3 切包点，前提是 #6812 先合入。赶不上时，首发是退回 R85 旧面板、按原窗口走，到时另请 owner 定。
- P3 装机单要加两件事：① 新开关 `INTEGRATION_YIDA_FORM_FIELDS_READ_ENABLED` 写进 `app.env` 模板，默认不设；② 客户钉钉应用开通「宜搭表单数据读权限」，放进装机前置条件。

## 5. 整链复跑结果

2026-11-23，在 WSL Linux 克隆（Ubuntu 24.04、Node 20）上跑，代码提交为 `83caa822d`（本文所在的文档提交只改文档）：

| 项 | 结果 |
|---|---|
| 插件完整测试链 `node scripts/test-chain.cjs` | 退出码 0（351 个套件） |
| 后端全部宜搭单测（`tests/unit/yida-*`，共 18 个文件） | 593/593 |
| 前端五份 spec（预演面板、客户端、单行确认、看板、权限矩阵） | 269/269 |
| 前端 `vue-tsc -b` | 退出码 0 |
| 后端 `tsc --noEmit` | 退出码 0 |

Windows 工作树上，插件链停在 `stock-preparation-permission-matrix.test.cjs` 的 M-08（迁移文本比对，与本改动无关）。同一用例在 Linux 克隆里通过，判断是 Windows 换行符造成的。
