# 审批中心「导出 CSV」按钮(F3-E1)设计与验证说明 · 2026-09-30

分支 `feat/approval-center-export-csv-button`,基线 main `cffd5dacbc`。只改前端,不改后端、不改 `.github/workflows/*`、零 DDL、不开任何开关。

## 1. 改了什么

| 提交 | 内容 |
|---|---|
| `d58d2da352` | `apps/web/src/approvals/api.ts` 新增 `exportApprovalsCsv(query)`:经 `apiFetch`(带鉴权头)请求 `GET /api/approvals?<列表筛选>&format=csv`,不带 `page` / `pageSize` / `limit`;列表与导出共用一个查询参数映射 `approvalListSearchParams`(`listApprovals` 发出的请求不变);原样返回响应 Blob、文件名和四个 `X-Approval-Export-*` 头,头读不到或值不合法时记为 `null`,不当成 0 或 `false`;2xx 但不是 `text/csv` 的响应直接拒收,不保存;这条路径没有 mock 分支,也不在客户端拼 CSV。 |
| `3c43716f5c` | `ApprovalCenterView.vue` 筛选条新增「导出 CSV」按钮(只在桌面布局出现,与批量工具条一致)。导出参数取 `loadCurrentTab()` 记下的「已应用」筛选加当前标签页,所以搜索词要按回车生效后才会进入导出。按钮旁一直显示范围说明:导出行数可能少于列表总数,PLM 来源的审批不在导出范围内。导出后显示结果:完成时显示行数;截断时说明文件不完整,并给出本次上限;头读不到时说明无法确认文件是否完整;失败时说明未保存任何内容。`sourceSystem=plm` 时按钮禁用,说明行改为给出原因。新文案全部在 `isZh` 分支里提供中英两份,写法与 `tabEmptyText` 相同。 |
| `5c0e4a881f` | 浏览器车道新增 `verification/approval-list-csv-download-harness.{html,ts}` 和 `approval-list-csv-download.spec.ts`,由 Approval browser verify 的 `approval-*.spec.ts` 匹配自动收集,不改 workflow 或配置。另把 `approval-center.spec.ts` 注释中的 spec 名改成最终名字。 |
| 本提交 | 本说明。 |

视图用例并入 `tests/approval-center.spec.ts` 和 `tests/approvalMobileResponsive.spec.ts`,API 用例并入 `tests/approvalApiErrorSurfacing.spec.ts`。这三个文件原本就在必需 web 车道上,所以没有新增 vitest spec 文件,也没有改 run-list 和 token manifest。

## 2. 依据

- 授权:owner 2026-09-30 原话「按建议执行」,范围是主会话在其前一条消息里列出的第一波四片,含 F3-E1。
- 计划:`approval-feishu-p2-p4-slice-plan-20260930`(规划文件,不在仓内)§4「F3-E1」原文:
  - 改动面:「`apps/web/src/approvals/api.ts` 新增 `exportApprovalsCsv(query)`(带鉴权头取 blob,沿用列表当前筛选参数,`format=csv`);`ApprovalCenterView.vue` 工具栏按钮;读取响应的 `X-Approval-Export-*` 头展示截断提示…;文案走 locale(…F3-E1 若先落,只保证新按钮文案走 locale,宿主其余硬编码文案由 F8-1 收);`sourceSystem=plm` 时按钮禁用并说明」
  - 验收门:「前端 spec(参数透传、截断提示、plm 禁用);浏览器车道一条下载用例(断言文件名 / BOM / 行数);**零客户端 CSV 生成**(导出必须继承服务端同一读面)」
  - 风险:「导出行集可**窄于**列表…——按钮旁须有说明,否则用户以为漏数」
  - 锁:「不需要」;§6 表同样把 F3-E1 列在「不需要新锁」一行。该计划文末的「第 5 轮复验更正」节没有涉及 F3-E1 的条目。
- 服务端合同(#5656,已在 main,本片不改):`routes/approvals.ts` 中「Bounded per contract §5: never silently truncated — `X-Approval-Export-Capped` reports whether …」;`sourceSystem=plm` 与 `format=csv` 组合返回 400 `APPROVAL_EXPORT_SOURCE_SYSTEM_UNSUPPORTED`;响应体带 UTF-8 BOM,文件名固定为 `approvals-export.csv`,行上限为 `APPROVAL_EXPORT_ROW_CAP = 500`。

## 3. 验收门实测读数

读数环境:Mac mini 执行机(macOS),Node 20.20.2,pnpm 10.16.1,Playwright chromium-1200,PostgreSQL 16.15(Homebrew)。本机只做编辑和提交,所有测试都在 Mac mini 上跑。

| 验收门 | 读数 |
|---|---|
| 前端 spec:参数透传、截断提示、plm 禁用 | 在 `3c43716f5c` 和 `5c0e4a881f` 两个提交上分别运行 `vitest run` 三个受影响文件,结果都是 **3 files / 87 tests passed**。 |
| 变异探针(验证 spec 能拦住错误) | 在 `3c43716f5c` 上共 12 个变异,**全部转红**,每次都恢复到干净状态(`git status` 0 改动)。各变异的失败数:导出带上分页 1;丢掉 `format=csv` 4;接受非 CSV 响应 1;头缺失当 0 处理 3;PLM 不禁用 1;读不到头当作完整 1;截断当作完整 2;视图自建 Blob 2;把未提交的搜索词带进导出 2;导出不带标签页 3;文案不跟随 locale 9;去掉范围说明 2。 |
| 浏览器车道下载用例:文件名 / BOM / 行数 | 在 `5c0e4a881f` 上运行新 spec,**3/3 passed**。断言内容:下载文件名为 `approvals-export.csv`;前三个字节是 `EF BB BF`;文件与路由返回的字节完全一致(含中文和 CRLF);数据行数等于 `X-Approval-Export-Row-Count`;导出请求带 `Authorization: Bearer …`,带 `format=csv`,不带分页,筛选与屏幕上那次列表请求完全相同;结果行显示「已导出 3 行。」,说明页面读到了导出头;截断时文件照常保存,并提示「文件不完整」和「500 行」;通过真实下拉选择 PLM 后按钮禁用、说明行给出原因,强制点击也没有发出任何导出请求。 |
| 零客户端 CSV 生成 | 满足:① `exportApprovalsCsv` 没有 mock 分支;`approvalApiErrorSurfacing.spec.ts` 中的源码绊线用例断言导出这段源码里没有 `new Blob(`、`.join(` 和 `if (USE_MOCK`,并用身份断言确认返回的 Blob 就是 `response.blob()` 的那个对象。② 视图层的「自建 Blob」变异会转红(见上)。③ 浏览器变异 BM1:让视图先 `blob.text()` 再重新组 Blob,结果 **2 failed / 1 passed**,失败点是 BOM 断言和字节一致断言。已恢复,0 改动。 |
| 按钮旁说明「行集可窄于列表」 | 说明行一直显示;用例断言中英文案,「去掉说明」变异转红。 |
| 所在车道整体 | 用 `CI=1 --retries=0` 跑完整的 `playwright.approval-verification.config.ts`,**41 passed**。跑之前确认 5175 端口没有监听,避免复用其他 lane 已起的服务。 |
| 类型检查 | `pnpm run type-check`(`vue-tsc -b`、`type-check:verification-approval`、`type-check:verification-stock-prep`)退出码 0。 |
| 车道接线 | `node --test scripts/ops/approval-browser-ci-wiring.test.mjs` **3/3 pass**:新 spec 在 approval 车道的 `--list` 中,不在共享车道中,也在 approval 的 tsconfig 覆盖范围内。 |
| 必需 web 车道 token | `node scripts/ops/required-web-lane-token-manifest.mjs --check` 结果为「MANIFEST MATCHES」(545 个 token)。用这 545 个 token 逐一对新 spec 的 CI 路径和 Mac mini 路径做子串匹配:**0 命中**。正控:如果文件名叫 `approval-center-export-csv.spec.ts`,会被 `approval-center` 命中,所以改用现在的名字。 |
| 服务端契约读数(真库) | 用一次性库 `ms2_w1_e1_impl_20260930`(`createdb -O ms2testbed`),先断言 `current_database()` 就是这个库;环境里唯一的 `*_DATABASE_URL` 是 `DATABASE_URL`,已指向该库;`EXPECT_DB=1`。迁移沿用 `approval-realdb-export-csv.yml` 的 `MIGRATION_EXCLUDE`(与 `plugin-tests.yml` 的 approval 真库迁移步相同),退出码 0,建出 415 张表。之后原样运行 `tests/integration/approval-export-csv.db.test.ts`:**22/22 passed**,0 skipped。其中包括 BOM、固定文件名、四个导出头、`sourceSystem=plm` 返回 400 这几条,正是本片客户端依赖的契约。跑完先终止连接再 `dropdb`,复查确认该库已不存在。 |

## 4. 未跑项与残留

- 「字节一致」比的是浏览器保存的文件和 Playwright 路由返回的字节,不是和真实服务器比。服务端的响应体和响应头由上面的真库用例单独覆盖。没有跑「浏览器连真实后端」的端到端测试。
- GitHub CI 还没有在本分支上跑过(本片不 push);以上读数都来自 Mac mini。
- 跨源部署:后端 CORS 的 `exposedHeaders` 目前只有 `X-Correlation-ID` 和 `X-Method-Overridden`。如果前端和 API 不同源,浏览器读不到 `X-Approval-Export-*` 和 `Content-Disposition`,这时页面会如实提示「无法确认文件是否完整」,文件名回落到同名默认值 `approvals-export.csv`。同源部署不受影响:`getApiBase()` 默认用页面自身的 origin;仓内生产镜像构建时不传 `VITE_API_URL` / `VITE_API_BASE`(`Dockerfile.frontend:24`),并由同一个 nginx 把 `/api/` 反代到后端(`docker/nginx.conf:75`),因此是同源部署。要在跨源部署下也显示行数,需要改后端,不在本片范围内。
- 移动布局不提供导出按钮,这是有意的:移动端动作集只有通过 / 驳回 / 评论 / 发起。
- 宿主视图里其余的硬编码文案归 F8-1 处理;Q7(导出真库车道是否升为必需检查)不在本片范围内。
- 本片是**续做**:上一轮实现被会话额度打断。`d58d2da352` 和 `3c43716f5c` 是上一轮的提交,本轮逐条核对过,没有改写。本说明里的所有读数都是本轮重新取的:vitest、12 个变异、类型检查、接线、manifest、Playwright、BM1、真库。

## 5. 门审 r1 处置

门审 r1(记录不在仓内)结论为 0 P1 / 0 P2 / 5 P3。本轮处置其中 P3-1、P3-2、P3-3;P3-4 已在推送前处理,本轮不涉及;P3-5(后端 CORS `exposedHeaders`)属 owner 项,本片不改后端,仍见 §4。

| 门审项 | 处置 | 提交 |
|---|---|---|
| P3-1 导出进行中切换 tab / 筛选后,旧导出的结果行写到新列表上 | `handleExportCsv` 点击时取 `const filters = appliedListFilters.value`;成功或失败返回时,只有 `appliedListFilters.value === filters` 才写 `exportOutcome`。文件照常保存,因为它就是点击那一刻要的内容。门审的探针转为正式用例(成功半:导出 → 切到「抄送我的」→ 返回 ⇒ 无结果行、文件已交给浏览器;失败半:导出 → 切到「我发起的」→ 503 ⇒ 无结果行)。 | `108217fadb` |
| P3-1 附带改动(**与门审修法文字的差异,请 r2 判定**) | 门审修法的前提是「`loadCurrentTab` 每次都赋新对象」。但 `loadCurrentTab()` 也在同一列表的重载里被调用:「重新加载」按钮、行内通过 / 驳回成功、批量操作完成、翻页、点击新待办提示。若照原样保留每次赋新对象,这些重载只要发生在导出途中,就会把本该显示的结果行丢掉。所以改为:只有在原有的 JSON 比较判定「列表已换」时(也就是原本就会清空结果行的那个分支)才替换快照对象;列表未换时保留原对象,内容逐键相同,导出参数不变。这样快照对象的身份恰好随列表变化。另加用例钉住:导出途中对同一列表重载(搜索框回车)⇒ 结果行照常显示。 | `108217fadb` |
| P3-2 「LAST LOADED」用例没钉住 `status` 透传 | 用例通过状态下拉选 `approved`(该下拉没有 test id,用唯一的 `option[value="approved"]` 定位,并先断言它恰好出现 1 次);断言导出查询 `status: 'approved'`,并单独断言最后一次列表请求的 `status` 为 `'approved'`(`toEqual` 会忽略值为 `undefined` 的键,单靠它发现不了两边同时丢失)。 | `a939f80bc7` |
| P3-3 网络不可达分支没有视图用例 | 在「拒绝导出」用例旁新增一例:以 `{ code: 'NETWORK_UNAVAILABLE', status: 0 }` 拒绝,断言结果行文本等于 `NETWORK_UNREACHABLE_COPY.en`、无 CJK、`role=alert`、未保存文件、无 toast;切到 zh 后等于 `NETWORK_UNREACHABLE_COPY.zh`。 | `3cc6b64e17` |

### 5.1 读数

读数环境:另一台机器(macOS arm64),Node 20.20.2,pnpm 10.16.1,Playwright 1.57.0(chromium)。本机只做编辑和提交。本轮零后端改动、未建库,所以没有 PostgreSQL 读数。

| 项 | 读数 |
|---|---|
| vitest(`approval-center`、`approvalApiErrorSurfacing`、`approvalMobileResponsive` 三个受影响文件,加邻居 `approvalCenterSourceFilter`、`approval-center-master-detail`) | `108217fadb`:**5 files / 125 tests passed**;`a939f80bc7`:**125 passed**;`3cc6b64e17`:**126 passed**。`approval-center.spec.ts` 的用例数 42 → 44 → 44 → 45,与新增用例数一致。 |
| 引用 `ApprovalCenterView` 的全部 spec(19 个文件) | `loadCurrentTab()` 在本视图有 14 处调用点(含模板里的「重新加载」),所以把 `tests/` 下所有提到 `ApprovalCenterView` 的 spec 都跑一遍。`51401fee50`:**1 failed / 18 passed 文件,2 failed / 407 passed 用例**;`3cc6b64e17`:**1 failed / 18 passed 文件,2 failed / 410 passed 用例**。两边失败的是同样两个用例,都在 `approval-ui-workspace.spec.ts`(详情页与模板编排的源码结构断言),该文件不在必需 web 车道,基线上本来就红,与本片无关;多出的 3 个用例就是本轮新增的 3 个。 |
| 类型检查(`3cc6b64e17`) | `vue-tsc -b` 退出码 0;`vue-tsc --noEmit -p tsconfig.verification-approval.json` 退出码 0。 |
| 浏览器下载用例(`3cc6b64e17`) | `CI=1 --retries=0` 运行 `verification/approval-list-csv-download.spec.ts`:**3/3 passed**。运行前确认 5175 端口无监听。 |
| 必需 web 车道 token | 未新增 spec 文件,未改 run-list;`required-web-lane-token-manifest.mjs --check` 为「MANIFEST MATCHES」(545 个 token)。 |
| 公开文本 | 三个新提交:私有短语表 0 命中(正控命中),主机名 / 局域网地址 / 用户名 0 命中;作者与提交者均为 noreply 身份。 |

### 5.2 变异(均在 `3cc6b64e17`,精确串单点替换,替换处不唯一则拒绝施加;每条跑完还原并逐字节比对,收尾工作树 0 改动)

| 变异 | 门审 r1 时(与 `51401fee50` 同树) | 本轮 |
|---|---|---|
| `V-snap-status-undef`:快照写成 `{ ...filters, status: undefined, tab }` | 绿,存活 | **红**,1 failed / 45(「LAST LOADED」用例) |
| `V-literal-drop-status`:从 `loadCurrentTab` 的 `filters` 字面量删掉 `status` 行(列表和导出同时丢) | 行为上存活 | **红**,1 failed / 45(同上) |
| `V-no-network-branch`:删掉 `exportFailureOf` 的网络分支 | 绿,存活 | **红**,1 failed / 45(网络不可达用例) |
| 探针等价:视图文件换回 `51401fee50` 的版本,spec 用本轮的 | 探针 1 failed | **红**,1 failed / 45(切换 tab 用例的成功半断言) |
| `V-p31-no-guard-resolve`:成功分支不再判断是否同一列表 | — | **红**,1 failed / 45(切换 tab 用例的成功半) |
| `V-p31-no-guard-reject`:失败分支不再判断 | — | **红**,1 failed / 45(切换 tab 用例的失败半) |
| `V-p31-guard-always-true`:判断恒真 | — | **红**,1 failed / 45(切换 tab 用例) |
| `V-p31-assign-every-load`:恢复每次加载都赋新快照对象(即门审修法文字的前提) | — | **红**,1 failed / 45(同一列表重载用例) |
| `V-p31-guard-always-false`:判断恒假 | — | **红**,10 failed / 45(所有依赖结果行的用例) |

### 5.3 未跑项与残留

- 真库:NOT RUN。本轮零后端改动,没有建库;服务端契约的真库读数见 §3,本轮未重跑。
- GitHub CI 未跑(本轮不 push)。
- 本轮除 `handleExportCsv` 函数体外,还改了 `loadCurrentTab()` 里的一处赋值位置,并改了 `tests/approval-center.spec.ts`。并行的 F8-1 分支基于 `51401fee50`,如果它也改这两处,合入时会有文本冲突,需要人工合并。
- P3-2 用例定位状态下拉依赖「全视图只有一个 `option[value="approved"]`」;若以后出现第二个,用例会在计数断言处明确失败,不会悄悄选错。
