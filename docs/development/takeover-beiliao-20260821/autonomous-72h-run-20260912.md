# 第四轮 72h 自主开发记录(2026-09-12 18:2x → 2026-09-15 18:2x 本地)

> 用户原话:「接下去72小时我不在电脑前,你能帮我持续不间断的开发么?并根据代码难度来选择模型,完成后给出设计及验证MD」。本文是那份「设计及验证 MD」,随窗口推进持续更新;上一轮见 `autonomous-24h-run-20260911.md`。

## 0. 一句话结论(进行中)

截至 09-14 16:20:七支合入(X5 #5685、E #5684、X6 #5686、#5625、品牌链接 #5700、② #5701、③ #5702),r36 → r37 两次上 222 均 exit 0,r38(#5700)已建待 18:00 后上;演示项目 dry-run 从 r35 的「根行永不收敛的空 update」变为全量收敛;后台大 BOM 链的包列写面与小 BOM 对齐。剩余全是 owner 决策项(§5)。窗口 09-15 18:2x 结束前本文继续更新。

## 1. 授权、边界与本轮规矩

- 沿用前三轮全部边界(K3 外部写、客户数据删除、222 凭据/网络/系统设置、生产 PLM、peer 的分支/worktree、禁改文件清单)。
- 222 只在 18:00–08:00 本地上机(白天不上,除非用户点头);每次上机 = pg_dump 备份 + 自管维护 flag 的升级脚本 + 标记复核 + 事后错误行/health。
- 流水线收紧(第三轮教训 6):小改动一轮反驳、末轮 0 blocker 不终审;权限/租户/写路径改动保留完整两轮 + 终审。所有「仅正文/注释」的裁决项由协调方落实。
- 模型按难度:sonnet(机械/文档)、opus(跨文件逻辑、测试)、会话模型 Fable(行身份/租户/222 写路径实现与终审)。
- 环境事故(09-12 18:30,另一会话清 worktree 顺 junction 误删主检出 node_modules 与 dist-sdk,18:50 恢复):我的 worktree 全部重建;删 worktree 前先拆外指链接的规矩已进 memory。

## 2. 计划与执行账

| # | 项 | 难度/模型 | 状态 |
|---|---|---|---|
| A | X6 `changedFields` 收窄(来料缺键 ≠ 变更;#5625 推荐 ② 的前置;F1c-b 发现的空 update 根因) | 写路径 / Fable 实现 + Opus 反驳 + Fable 终审 | lib 21 行 `63af19045`;三轮反驳 + 终审 FIX_FIRST(2 条均为测试/正文)→ fix r3 `f00c81088`(边界二三类 + planner 用例 + 边界三 + 222 部署说明)→ **PR #5686 CI 21/21 → 合入 `caf8128ad`** |
| B | #5625 重基合入(大 BOM 计划与分片 apply 补传 installedFieldProperties) | Opus | 重基 `07320c897`(三条「翻转 update」断言按收窄后语义改、ledger 文档冲突已解)→ 一轮只读反驳 BLOCK,唯一 blocker 是三处注释「every `ext_` id stays out of the update patch」被本支自己的用例(`fld_ext_nameAndSpec === 'Assembly'`)证伪 → `ce962bd03` 改成有界表述(mapper 领地的 `ext_` 仍在 patch 外;带打开的只是 ≤5 个 F1c/F1c-b 派生包列)+ 重钉 pluginHttpRoutes pin + PR 正文订正;**CI 27/27 → 合入 `f2126bc3e` → r37 上 222(§4.1)** |
| C | X5 展开器 rowErrors 截断样本确定性 top-N(X4 残留) | Opus | `916366677` → **PR #5685 CI 21/21 → 合入 `8d6bcc593`**;三轮反驳 + 终审 FIX_FIRST(2 条注释)已落实 |
| D | F8A 第二刀(有损预检) | — | 视时间 / owner 决策 |
| E | 通知中心保留期清理(env 默认关) | Opus | `eb58d8f5d` → PR #5684;反驳 5+3 → 修 → 终审 FIX_FIRST 3 条(真库 lane 接线 / 「死代码」误判更正 / 变异护栏)已落实;CI 首轮四红 = plugin-tests.yml 溯源 pin 未重算,已重钉 → **PR #5684 CI 52/53 → 合入 `0029f4094`** |
| F | 上机 r36 / r37 | 协调方 | r36 09:16、r37 10:54 上 222,均 exit 0(§4.1);F4A 小项不动 |
| G | 顶栏左上品牌字改为回首页链接(用户 09-14 现场需求) | 协调方直做(前端小改)+ 挂载测试 | `App.vue` 品牌字原是纯 span 不可点 → `router-link` 经 `resolveHomePath()`(platform → `/home` 我的应用;两种聚焦模式各回各家;守卫不动);App.spec +3 例、M1/M2 变异各 2 红、vue-tsc 0;CI 两轮红 = 五个挂 App.vue 的 spec 对 featureFlags 用部分 mock 缺 `resolveHomePath`(逐 mock 块扫描后补齐)→ **PR #5700 CI 23/23 → 合入 `8f917f9ff`**;进 r38(白天不上,等用户定时间或 18:00 后) |
| H | ③ 备料开通派生自有 base + ② 考勤目录种子 env 开关(用户「按建议执行」) | 工作流:三读者(opus)→ 设计(Fable)+ 批评(opus)→ 双实现(Fable / opus)→ 双镜头反驳(opus)→ 修 ≤2 → 终审(Fable) | 规格 `spec-B3-stock-prep-own-base.md`;批评者一轮 REVISE(用户可经 POST /bases 抢注派生 id ⇒ fail-closed 变拒绝服务);实现 B3 `a7fc9aae` / ② `b0163985`;反驳 r1:② PASS,B3 两镜头 BLOCK(同一洞:单向锚点致某种顺序下主表与账本落不同 base)→ fix `1b941407`(对称锚点、锚点先于开关)→ r2 双 PASS → 终审 FIX_FIRST 1 条必修(锚点原样跟随伙伴表所在的任意 base:`POST /sheets` 自选 id 可把主表引进用户自有 base)→ judge-fix `6cf091a8`(围栏 null / base_legacy / 前缀)→ 复驳 BLOCK(裸前缀宽于 `POST /bases` 预留正则,`base_integration-core_x` 可过栏)→ fix `72632020`(围栏收窄到插件能铸出的形状 = 核心正则字面量,3000 样本 fuzz 证围栏 ⊆ 预留;M11c/d/e 红)→ 复驳 PASS(minor:围栏按形状不按归属,仅 SQL 可达,已写入 runbook)→ PR #5702 首轮 CI 两红 = Global-History flag manifest 完整性 grep 把三个新错误码当 flag(登记 NON_GH_EXACT,`4a094eacd`)→ **CI 35/35 → 合入 `c13e40769`**;② **PR #5701 CI 26/26 → 合入 `2e120a7d5`**。两支都不进 r38,进 r39(下个窗口;上机后 `GET /bases` 只读核对,222 已有安装按 (ii) 锚点零变化) |

## 3. 替 owner 定的口径(本轮)

- **#5625 三选一 → ②**:用户未回 1/2/3;按我 09-11 给的建议执行 ②(先收窄 `changedFields` 再合 #5625)。理由与可撤回性见 X6 PR 正文。

## 4. 验证

- **X5**:impl 2fc173b29 → r1 2+3 → fix → r2 1+1 → fix ace038a0b(补「堆根即最大者」绑定用例,commit-tree 重写两条已被证伪的 commit 正文,旧 tip 留 refs/x5-backup/pre-r2-fix)→ r3 0+1 → 终审 FIX_FIRST 2 条(注释绝对句)→ 协调方落实 916366677。变异 M1/M2a/M3/M23–25/M_no_content/M_no_identity 全红;M2b 等价变异如实登记。整链 13 支 exit 0。**可观测变化**:排序键 type 优先 ⇒ 截断时样本退化为字典序最靠前的类型(真值 per-type 计数仍先读,不是安全洞;配额式选择留下一刀)。
- **E**:impl 99caed14f → r1 5+3 → fix b0b6bef2c(重入闸 / 积压续轮 / 关停截断 + await / flag manifest 登记 / 真库用例 exclude 守卫)→ 终审 FIX_FIRST 3 条 → fix r2 9bfe7266e(G7 护栏、真库用例 sheet 作用域、措辞、关闭态日志)→ 协调方加真库 lane 清单行 7316b2683 + 重钉 pin eb58d8f5d。45/45 单测、tsc 0、manifest 契约 30/30;M1/M2/M3/MA1–MA4/MSQLa–c 全红。默认关 ⇒ 上机零行为变化。
- **X6**:impl 63af19045 → r1 2+2 → fix d1e0bb1a6 → r2 1+4 → fix 4779a0997 → r3 2+2 → 终审 FIX_FIRST 2 条(边界二三类点名 + planner 级用例;边界三:plan.counts 变 ⇒ revision 变 ⇒ 确认账本已确认决议 supersede、当轮 hold/409 一次)。规格两句绝对句被证伪(「没有任何一格取值会变」/「mark_inactive/add 不受影响」),正文改成有界版。M1/M2/M3/M5 红;表示层探针证实 X6 后 SKIP 保持存量表示。
- **环境**:09-12 18:30 另一会话清 worktree 误删主检出 node_modules(18:50 恢复);09-12 21:10 起 429 + 直连被墙 ⇒ 主循环停 ~35 h(09-14 08:03 由用户 continue 唤醒);根因 = 重启后无 TUN,本机代理 127.0.0.1:52520 可用,所有 git/gh 改走代理。

### 4.1 上机

- **r36(`caf8128ad` = r35 + X5 #5685 + E #5684 + X6 #5686,09-14 09:16 上 222;用户「今天要交出来」⇒ 白天上机)**:备份 `pre-r36-20260914-091630.dump`;维护门 WIRED → 后端直连 attempt 7 → 删 flag → nginx 200;upgrade exit 0;web smoke PASS(bundle 与 r35 相同,三支都是后端/插件改动);标记 X5 `createRowErrorCollector` / E `notification-retention` dist(env 未设 ⇒ 默认关)/ X6 `intakeProvidesField` 全 True;事后错误 0 行、flag 不存在、health 200。
- **X6 现场实证**:演示项目 2-20241722.1723 dry-run 从 r35 的「update:1(根行永不收敛的空 update)」变为 **update 0 / skip 581 / manual_confirm 0**——全量收敛。
- **r37(`f2126bc3e` = r36 + #5625,09-14 10:54 上 222)**:备份 `upgrade-backup-20260914-105403`;维护门 WIRED → 后端直连 attempt 6 → 删 flag → nginx 200;migration exit 0;upgrade exit 0;web smoke PASS(bundle 与 r36 相同);backend err 0 行(10:00 起);app.env 37 行未动。标记:X5 / E / X6 True;#5625 第一子标记 True、第二子标记 False——是我猜的子串(`installedFieldProperties: installedFieldProperties`)在代码里不存在,不是包错:222 上 `http-routes.cjs` 的 sha256 前缀 `48452e63…` 与 PR 重钉的 `runtimeFiles.pluginHttpRoutes` pin 逐字相同。
- **r37 演示 dry-run**:2-20241722.1723 → update 0 / skip 578 / **manual_confirm 3**(r36 时 skip 581 / manual_confirm 0)。r36→r37 的 lib 改动全在大 BOM 路径(演示 largeBom=false),而 222 上 bom备料 在 09:00 时段有 5 行被人工编辑(只读 SQL:updated_at 按小时计数;确认账本仍 6 行未增),与「3 行转人工确认」吻合——这是设计行为(人工改过的格不被来料覆盖,转确认账本),不是回归;未逐格核对是哪 3 行。

### 4.2 用户现场问题(09-14 上午,222 只读 SQL + 代码实读)

- **主表改名**:`sheet_32df959afa3cecfa564e5486` 按用户要求改名为 `bom备料`(先只读枚举再 UPDATE name;中文经 hex `convert_from(decode(...))` 传,绕开 222 的 GBK 控制台)。
- **「考勤统计字段目录」为何在 bom备料 同一个多维表里**:它不是备料的表,是考勤插件自己的字段目录(`plugins/plugin-attendance/index.cjs` `getAttendanceReportFieldCatalogDescriptor`,47 行种子记录 / 16 列),插件 `activate` 时就 `ensureAttendanceReportFieldCatalog(DEFAULT_ORG_ID)` 建出来。三张表同居的根因在核心层:`packages/core-backend/src/multitable/provisioning.ts` 的 `createSheet` 对不带 `baseId` 的调用一律 `ensureLegacyBase()` 落到 `base_legacy`(界面上叫 Migrated Base,owner/workspace 都是 null);考勤插件不传 baseId,备料写路径按 GHSA-m6qv-2rpf-q7mh 决议 A **主动拒绝**请求带 baseId(`assertNoRequestBaseId`,因为核心写 `meta_sheets.base_id` 不校验 base 归属),于是也落 `base_legacy`。222 时间线印证:`base_legacy` 09-07 18:20:13 建(后端首次起)→ 考勤目录 18:21:12(插件激活)→ 备料两张 18:42:13(沙箱开通)。
- **重建应用会不会再出现**:会,而且是结构性的——只要考勤插件还装着,每次后端启动都会保证这张目录存在于 `base_legacy`;备料开通今天没有别的落点。三条出路留给 owner 选:① 最小动作:把考勤目录挪到单独的 base(一行 `UPDATE meta_sheets SET base_id`,插件按 sheet id 找表,不受影响;可逆);② 代码:考勤目录的种子改为 env 开关,222 这种不用考勤的实例不建;③ 正解:备料开通派生出自己的可写 base(GHSA 注释里点名的 `resolveBaseWritable`,从已认证主体推导而非信请求),bom备料 与考勤目录彻底分家。①③ 不互斥;未得 owner 点头前我不动 222 数据。
- **用户裁决(09-14 11:5x「按建议执行」)→ ① 已做,③ 下个窗口,② 并入 ③**:222 上一笔事务(`ops1800/base-split.sql`,两行原值先读出留底):新建 base `base_attendance_catalog`(名「考勤」,owner/workspace 与 Migrated Base 同为 null,`/bases` 列表不按 owner 过滤所以同样可见)→ 考勤目录 `sheet_75b4…` 挪入 → `base_legacy` 改名「备料」。回读:备料 base 只剩 bom备料 + 确认账本;考勤 base 只有考勤目录。插件按 sheet id 找表(`findObjectSheet` → `loadActiveSheet(id)`,`createSheet` ON CONFLICT DO NOTHING),重启不会在旧 base 重建。回滚 = 两条反向 UPDATE + 删新 base 行。

## 5. 未做与原因(截至 09-14 11:00)

- ~~#5625 重基合入(B)~~:已合 `f2126bc3e`、r37 上机(§4.1)。
- **F8A 第二刀(D)**:owner 决策(有损预检是否允许带确认的破坏性改型),未开始。
- **F4A 小项(F)**:升级脚本已连续 6 次实跑成功,不在窗口尾动它。
- ~~X6 边界三的 222 一次性核查~~:已查(只读 SQL):备料确认账本两张,6 行全部 pending(SOURCE_VALUE_NOT_A_STRING)、无 CONFIRMED ⇒ X6 上机不作废任何人工决定。
- **owner 待办(沿上一轮)**:F1c-b 包列二选一、F8A 7 条、ext_spec、「测试」规则收件人、X5 配额式选择;**新增**:~~bom备料 与考勤目录分家三选一~~ → 用户选「按建议」:① 已落(§4.2),③(备料开通派生自己的可写 base)排下个窗口,② 并入 ③。

## 6. 教训

1. **停摆是最大损耗(再一次)**:429 与「直连被墙」叠加,主循环 35 h 无人唤醒;唤醒机制不能只靠 ScheduleWakeup——用户离机前先确认代理/限额,并留一句「敲 continue」的提示。
2. **外网断了先四连探针**:ping / 直连 curl / 代理 curl ×2;CLI 能说话不代表 shell 能出网。
3. **删 worktree 前先拆 junction**(另一会话的事故,已进 memory):`git worktree remove --force` 会顺 junction 删进主检出。
4. **改 plugin-tests.yml 必重钉 `evidenceFiles.pluginTestsWorkflow`**(与 http-routes/package.json 同一类 pin);不重钉 = Sealed-export 三项 + integration-guard 同时红。
5. **规格里的绝对句会被自己的用例证伪**:X6 的「没有任何一格取值会变」在批级不成立;写规格时把「行级/批级/表示层」分开写。
6. **上机标记别猜子串**:#5625 第二子标记因猜的字符串不存在而假红;标记要么取自 diff 里真实存在的标识符,要么直接比对文件 sha256 与 provenance pin(后者更强)。
7. **部分 mock 要按 mock 块判,不按文件 grep**:给 `App.vue` 加一个 store 成员,五个挂它的 spec 因部分 mock 连带红;首轮用「文件里出现过 resolveHomePath」筛,漏掉一个(它出现的是守卫用例的本地假 flags),多跑一轮 CI。
