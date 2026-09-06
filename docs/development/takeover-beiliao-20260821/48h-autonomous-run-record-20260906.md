# 48 小时自主开发时间线(2026-09-05/06)

## W1 审查与修复(2026-09-05 23:50 – 2026-09-06 04:45)

| 时间 | 事件 | 结果 |
|------|------|------|
| 2026-09-05 23:48 | W3c 实测:大 BOM 分批路径不通 | largeBomExpansionOptionsForAction 与 computeDryRun 共用 maxRows;需独立上限裁决 |
| 2026-09-05 23:50 | #5500 CI 红(NUL 字节) | 工作树 CRLF→LF 转换引入;git 视为二进制;已发回修 |
| 2026-09-06 00:05 | #5499 前端审查 | classifyPlanStep 逐字节未动;3 个 blocker 待修(自动无标志重试+文案+防护 opt-in) |
| 2026-09-06 00:10 | #5500 三路对抗审查工作流开始(wf_186ee120-a2a,24 agents) | verifiedOk 42 条;确认 W3A-01/06/07 共 2 条;推翻 16 条 |
| 2026-09-06 00:15–00:20 | W2 222 实证:开启子树 | 222 升 r10 成功;试算 2-20231625:135 行展开,399 次读,7.0s |
| 2026-09-06 00:20 | #5492 对抗审查完成(wf_71640ed4-db5,25 agents) | 22 项发现→15 推翻/7 确认→4 缺陷裁决;已发回修 |
| 2026-09-06 00:20 | #5497 终审 | 5 向变异未打穿;确认 11 条,4 条必修;推翻 16 条 |
| 2026-09-06 00:25 | 在飞状态汇报 | 6 条 PR 仅余 test (20.x) 慢链;合并顺序决策:#5500 → #5499 |
| 2026-09-06 00:28 | #5500 rebase 复核(opus) | 19 hunk 逐块核:failureResult/声明块/readPart locus/与 main 字节级同;W3A-01 复现验证正确;pin 相符;可合 |
| 2026-09-06 00:30 | #5493 第二轮复核(opus) | 标题/trim+redactDeep/正则(base64url)/文案/注释均成立;pin 第三次重算;3 个阻塞(Node 18/20 定时器/用例数/pin) |
| 2026-09-06 00:33 | #5493 第三轮(2026-09-06 00:33) | withMockFetch 持 ref 兜住 unref 定时器;EXPECTED_OPS_TESTS_COUNT=43;pin 重算;MERGEABLE |
| 2026-09-06 00:38 | #5499 复核(opus) | B1/M4 用真实 dryRun 驱动通过;必做:登记 usePlmExportActions 进 CI;合并顺序 #5500 → #5499 |
| 2026-09-06 00:40 | W2 step 4 部分:222 服务账号已建 | users 行创建(svc-stockprep-scheduler),令牌落盘(ACL 仅 Administrators/SYSTEM),计划任务注册待 #5493 合并 |
| 2026-09-06 00:42 | #5501 两路对抗审查(wf_faf8a16a-070,17 agents) | 0 确认/15 推翻/25 verifiedOk;四键严格解析/块内 422/222 推导/倍数作用/deepEqual/变异红/硬顶钉住;pin 相符 |
| 2026-09-06 00:44 | 收尾推送 | #5499 补充 path 解析+4 例;#5501 budgets 无界改 null+文档统一;六 PR 全绿待 CI |
| 2026-09-06 00:45 | #5493 对抗审查完成(wf_9ac223e0-cdd,19 agents) | 16 项→12 推翻/4 确认;D1/D2/D3/D4 四缺陷裁决(令牌脱敏/超时兜底/字段改名/CI 覆盖);已发回修 |
| 2026-09-06 00:46 | #5500 已合(commit e7fd7674e) | W3a 服务端落地;后续 #5499 绿即合;#5497/#5501 CONFLICTING 需 rebase;#5493/#5502 MERGEABLE 等 CI |
| 2026-09-06 00:50 | #5500 合后冲突状态 | #5497/#5501 CONFLICTING(http-routes + pins);两实现者 rebase 中;#5499/#5493/#5502 MERGEABLE 等 CI;教训:同窗口多 PR 同改文件时合并顺序决定谁 rebase |
| 2026-09-06 02:00 | #5492 修复完成(commit 9a1d6fb20) | D1–D4 全部实现;后置过滤/环检测改祖先链/双行夹具/强类型;文件 CRLF 验证完成;opus 复核中 |
| 2026-09-06 02:05 | W4 设计要点汇报 | 222 admin 令牌无 tenantId 声明;54 条路由洞;方案:assertVerifiedTenantClaim + flag + P1/P2/P3;F3 改 resolveOperatorValueScope;222 实测确认 1+1 user_orgs |
| 2026-09-06 03:00 | #5497 源绑定回退对抗审查(opus 单路) | 核心逻辑 5 向变异未打穿;确认 11 条(4 条必修:F1 隔离/F2 剥离/F4 预检/F3 hint);推翻 16 条;教训:守卫在测试不在 |
| 2026-09-06 03:50 | #5492 复核完成(opus) | D1–D4 全部独立复现;订单路径洞闭合(main 0 次,PR 0 次);关闭态 deepEqual main;pin 相符;CRLF 无混用;可合 |
| 2026-09-06 04:40 | #5493 复核完成(opus) | 主修成立:控制字符/Headers/真实挂死/改名/CI 步骤;必修 3(标题/redact 时序/正则贪心);顺手 6 项;无法自证 test required check |
| 2026-09-06 04:45 | W3a 服务端 #5500 三路对抗审查工作流完成(opus) | 七处偏离:probeCount/flag 非布尔/opt-in 分支改取/G9 8→9/operator-scope 头/guard 落点/bom-expansion.cjs LF;复核可合 |
| 2026-09-06 00:57 | W4 实现交出(PR #5503,基于 4e509b614) | assertVerifiedTenantClaim + flag(默认关) + P1/P2/P3;F3 confirm→resolveOperatorValueScope;P-10a–g/M-11 分区;前端 spec 交 CI;下一步 rebase→审查→合→r11 |
| 2026-09-06 01:01 | W2 step 4:222 注册计划任务,首次运行暴露两个问题 | schtasks 注册 `metasheet-stock-prep-scheduled-dry-run`(每日 06:00,SYSTEM,只试算);包装 .cmd 首次因路径被拆行 `exit 255` 无日志,改字面单行重写后可执行;第二次运行暴露:①dry-run 400 `CONNECTION_CANONICAL_UNAVAILABLE`(服务账号 role=admin 不足,平台管理员判定看 `user_roles`,需复制 admin 的 `user_roles` 行给服务账号);②进程退出崩溃 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`(exit 0xC0000409)→ 发回 #5493(不用 `process.exit`、用 `AbortController` 清定时器、补真实子进程测试) |
| 2026-09-06 01:05 | 委派 400 根因排查 | RBAC 缓存过期后仍 400;定位为拉取读身份由 `resolveTableActionReadPrincipal` 委派给外接系统 `config.dataSourceOwnerId`,222 的外接系统行未 stamp 该键则回退为请求者本人,严格属主等值校验失败——同时解释了 09-05 操作员拉取 400 的现象 |
| 2026-09-06 01:09 | W2 step 4 完成(部分) | 令牌改签给绑定者 admin(带 tenantId 声明,7 天)后计划任务跑通:dry-run 200 `manual_confirm_required`,`add 135 / manual_confirm 225`,`summary failed 0`,日志无令牌、values-free;进程退出崩溃仍待 #5493 修复;根因链进一步确认:归属戳只在 legacy `dataSourceId` 路径写,222 canonical 绑定永不 stamp,手工 stamp 后仍 400,疑似 facade 层交叉校验,交由 opus 调查(后续即 #5505) |
| 2026-09-06 01:17 | W2 完成 | #5493 退出修复版(d76aac4e8)在 222/Node 24 实跑:exit 0、无 libuv 断言、dry-run 200 `manual_confirm_required` 135/225、`summary failed 0`、日志无令牌。计划任务每日 06:00 就位,W2 判据(证据入库 + 计划任务跑通且 values-free)全部满足 |
| 2026-09-06 01:27 | #5501 已合(294c79316) | W3c 独立上限修复落地:后台展开作业改用独立 `largeBom` 上限,交互路径字节级不变;222 上 13151 行合成 BOM 的复测(后台作业→plan→分批 apply)待 r11 |
| 2026-09-06 01:34 | #5499 已合(34a65bf07);#5503 三路对抗审查完成 | W3a 缺件清单前后端全部落地:服务端旁路数组 + opt-in + operator-scope 硬校验,前端折叠表/复制/导出,400/403 自动无标志重试;#5503(W4)三路对抗审查(wf_97f402eb-49d,22 agents):0 确认/19 推翻/35 verifiedOk,留六条 minor 待与二次 rebase 一起改;owner 待拍板追加:flag 开启后 P2/P3 覆盖整个 integration 插件面 |
| 2026-09-06 01:37–01:52 | 多 PR 交替 rebase(pin 冲突串行化) | 同窗口 5 条 PR 同改 `http-routes.cjs` 的 provenance pin,每合一条其余需再 rebase 一轮:#5497 三次 rebase 后 pin `2bc1b447` MERGEABLE;#5503 二次 rebase + 六项 minor 完成(28839c59c,pin `9a7079ff`);01:52 W1 完成里程碑:#5493 已合(82bbabcdd)、#5504(本记录文档)已合(40bd5b39e),累计已合 12 条 PR |
| 2026-09-06 01:55 | 拉取委派修复 PR #5505 提出(opus,c5af22b9f) | 定位四点根因:(a) 读路径原样返回归属戳;(b) `loadSystem` 顺序错误,委派身份在连接已按请求者身份塌成 `CANONICAL_UNAVAILABLE` 之后才算出;(c) facade 无反伪造交叉校验;(d) canonical 行结构上被 `withoutLegacyDataSourceReference` 连 `dataSourceOwnerId` 一起删除,不可能带戳。裁定方案 A:canonical 绑定保留归属戳(由 `validateCanonicalConnectionBinding` 证明属主)+ 顺序修正,不改 facade;新增 preflight blocker `PULL_PRINCIPAL_DELEGATION_UNAVAILABLE`;不做启动自愈,要求属主重提 PATCH(runbook §1.1) |
| 2026-09-06 02:15–02:27 | #5497/#5503/#5505 串行合并 | #5497 已合(10fe658a0,W3b 源绑定回退落地);#5505 三路对抗审查(wf_1e4e19d4-b7c,20 agents):2 确认(均 minor)/15 推翻/35 verifiedOk,发回修两处;#5503 三次 rebase 完成(5d46b335c,基于 10fe658a0,pin `35f7eefd`) |
| 2026-09-06 02:51 | #5505 两处 minor 修复(cfd2d0098) | Web 端 blocker 中英文案 + 检查行;runbook §1.1 补充 PATCH 会清空 `project_id`/`last_tested_at`/`last_error` 三列的说明;10/10 绿,等 #5503 合后 rebase |
| 2026-09-06 03:00 | #5503 已合(d7afc1dcd) | W4 代码落地(flag 默认关);r11 构建 run 33985724803 启动;累计已合 14 条 PR;#5505 排队等 rebase |
| 2026-09-06 03:06 | r11 已上 222 | zip sha256 校验通过;升级 8 步全过(441 文件哈希 OK、迁移 0、健康 200);pg_dump 2.13MB + app.env 备份;四项 r11 标记(largeBom 独立上限、missingComponents 旁路、tenant-claim 守卫、源绑定回退)均在位 |
| 2026-09-06 03:06 | r11 sanity | 普通试算 200 `manual_confirm_required`(135/399,subtree 6/6),不带标志字节级同 r10;`includeMissingComponents:true` 返回 200,`distinctCount 79 / probeCount 90 / truncated false / items 79`,键形状与冻结契约一致 → W3a 在客户真实测试数据上成立(225 项挂起对应 79 种不同缺件) |
| 2026-09-06 03:07 | W4 基线回归(flag 关) | 管理员/操作员两条链与 09-05 钉住的操作模型一致;试算(拉取)两边均 400 `CONNECTION_CANONICAL_UNAVAILABLE`(委派缺口,#5505 待合,与 flag 无关)→ 基线成立,日志 `w4-regression-baseline-20260906-030658.log` |
| 2026-09-06 03:08 | W3b 222 清理完成 | 删除 `workspace_id IS NULL` 绑定行(备份表 `integration_stock_prep_source_binding_bak_20260906-030732`),只剩 `default=104e9bad`;管理员带 hint 试算 200(135/6/6);定时任务无 hint,单候选回退命中 200(135/225,failed 0) |
| 2026-09-06 03:09 | W3c 复测:独立上限生效,但撞新问题 | budgets = `maxRows 200000/maxPages 1000/maxReadCount 600000/maxElapsedMs 3600000/maxDepth 20/maxArtifactChunks 1`;后台作业 `rowsExpanded 13151`、`readCount 26958`、`frontierRemaining 0`,不再被 10000 卡住;但作业 `status=failed`,`errorTypes=[read_failed]`(非规模类)→ plan 422,驱动脚本 exit 3 |
| 2026-09-06 03:14–03:18 | W4 flag-on(222) + 回归比对 | 备份 `app.env.pre-claimflag-20260906-031418`,追加 `MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED=true`,重载重启 health ok 3s;探针 `claim-flag-probe.cjs`:无租户声明的 admin 令牌 403 `OPERATOR_SCOPE_TENANT_REQUIRED`,带声明的 admin 令牌 200 → FLAG EFFECTIVE。`w4-regression-222.ps1` 两次输出(flag off 基线 030658 / flag on 031809)各 27 行,去掉时间戳/UUID/时间字段后 diff 为空,管理员链+操作员链逐行相同;两边"试算→400"与 flag 无关,是 #5505 委派缺口;结论:W4 第 2 项(租户面 403 守卫)在 222 上 flag 开着运行,UI 账号与服务账号不受影响 |
| 2026-09-06 03:30 | 定时任务经调度器实跑(r11 + flag on) | `Start-ScheduledTask` 触发 `metasheet-stock-prep-scheduled-dry-run`,`LastTaskResult=0`;日志新增 2 行 values-free:试算 200 `manual_confirm_required`,`add 135 / manual_confirm 225`,`summary failed 0`;令牌 claims 含 tenantId(与 `MS_TENANT_ID` 一致),到期 2026-09-12 17:08Z,下次 06:00 |
| 2026-09-06 03:35 | W3c `read_failed` 根因定位 | 作业只跑 8 秒(非超时);PG 服务端日志(GBK,中文 locale)显示「字段 "path_id" 不存在」;根因是 222 动作配置的 `projectSubtree` 为客户 PLM 写(`parentIdField=Parent_OBJ_ID`、`pathIdField=path_id`),合成源 `dn_pdm_bomheadinfo`/`dn_pdm_pathinfo` 无这两列,订单展开完成后进入子树阶段第一次读 `bomHead` 即 SQL 报错;交互试算的 10000 行上限在此之前早退,此前从未暴露。产品缺口 1:作业证据把 `readDiagnostics` 砍成布尔、错误细节不落库不打日志,任何 `read_failed` 都无法事后诊断(#5507 在做);产品缺口 2(记录,不改):后台作业 run 路由在一次 HTTP 请求内同步 await 完整展开,"后台"只是任务契约不是 worker。同一批日志顺带发现 `audit_logs` 分区仅到 2026_08、九月起写入全报缺分区,自愈的英文正则在中文 locale 下永不命中(#5506 修) |
| 2026-09-06 03:35 | #5505 终审(opus,A–E 五条对抗核验) | 一条未推翻,可合;owner 知情项:"canonical 绑定不保留归属戳"的旧不变式被 #5505 有意作废(`external-systems.test` 两条断言反转);CI 仅 web-tests 红(预检 spec 期望 5 行、面板 6 行,#5505 自增一行),已让原实现者对齐 |
| 2026-09-06 03:36–03:44 | W3c 复测通过 | 交互试算 `large_bom_bounded`(10000 行封顶,`readCount 20502`,`canApply=false`)→ 后台展开作业 `completed`(`rowsExpanded 13151`/`readCount 26959`/`frontier 0`,预算 200000/1000/600000/3600000,`errorTypes` 空)→ 规划 `valid`(`add 13151`,`existingRows 0`,`manual_confirm 0`)→ 分批写入 `succeeded`:132 批×100,`created 13151`/`failed 0`,`hitGuardLimit=false`。用时:试算 6.7s、展开 8.5s、规划 2.3s、写入循环 453.6s(≈3.4s/批),驱动总 472.8s |
| 2026-09-06 03:52 | 审计分区实效证明 | 手工建 2026_09/2026_10 分区后重跑 `operator-chain.cjs`(两次 RBAC 授权+准入写 `audit_logs`):`audit_logs_2026_09` 从 0→3 行,PG 日志 03:45 起无 `audit_logs` 报错(此前 03:06:59/03:18:10 各 3 条报错对应同类写入);修法 PR #5506(按 SQLSTATE 23514 识别,中英文正则兜底,9 例测试绿) |
| 2026-09-06 04:16 | #5505 已合(f86c467f8,26/26) | 拉取读身份委派修复落地(canonical 绑定保留归属戳 + 加载顺序修正);合并后 222 上仍需绑定者重新保存一次绑定补写归属戳,一线拉取才会从 400 转正常 |
| 2026-09-06 04:20 | #5506 已合(66d40c2fb) | `audit_logs` 缺分区识别改按 SQLSTATE 23514,不再依赖英文报错文案;中文 locale 下的自愈生效问题至此在代码层修复(222 上此前是手工建分区顶着) |

## 待 owner 拍板(来自设计 §4 与 W1–W3 实证)

1. **子树桥接定位**:正式功能还是仅演示/测试手段?改变的是业务定义(「备料表里应该出现哪些根件」),不是实现细节。

2. **无订单时根数量**:rawQuantity=1 是否被业务接受?替代方案:(a)整单失败(222 上一行都拉不出);(b)让一线手工补数量(需新的确认面)。

3. **两路出根去重**:允许同一零件同时经订单与子树出根吗?建议订单优先、子树跳过;若同一零件两路数量不同,以订单为准是否正确?

4. **配置翻转不可逆**:接受「关掉子树配置=下一次拉取把子树来的行全部置为无效」这个姿态吗?还是需要「保留但标记来源」的迁移方案?

5. **默认深度与包含自身**:maxSubtreeDepth 默认 1、includeSelf 默认 true 是否符合客户的目录习惯?(222 实测支持深度 1,但仅一个项目证据。)

6. **缺料容限与演示**:222 测试库 40–60% 子件缺料,拉出来的表会大面积报 missing_component。这样的结果可以给客户演示吗?还是必须等客户补齐物料数据?

7. **预检声明权**:允许人通过预检来声明 project-subtree(在实测可佐证的前提下)还是只允许实测得出、不给人任何声明权?

8. **定时应用权限**:只定时 **dry-run**(只读、无副作用、只做「有变化」提醒),还是允许无人值守 **apply** 直接写沙箱表?建议第一波只干 dry-run。

9. **服务账号身份与轮换**:定时任务用哪个租户内服务账号(必须是**租户绑定**主体,不能是无租户平台管理员)?token 谁保管、多久轮换?**2026-09-06 更新**:专用服务账号 `svc-stockprep-scheduler` 已建好但因拉取委派机制失效而未启用,临时改用绑定者 admin 的令牌顶着;#5505 已修复委派机制本身,但 222 上的外接源还没有归属戳(见下方新增第 15 条),"能否切回专用服务账号"仍待补戳后重新验证与拍板。

10. **同步时间审计覆盖**:是否值得新增一条审计动作 + 数据库 check 约束迁移来记录拉取行为(谁、何时、成功/失败)?还是先用行级 lastPlmRefreshAt 的最大值凑合(只能证明最后一次**成功**的写入,记不下失败)?

## 待 owner 拍板(W2–W4 执行与 #5505 复核后新增,续前 10 条编号)

11. **大 BOM 实测的操作代价(已执行,请追认)**:W3c 复测为验证独立上限修复,把源绑定临时切到合成源(展开→规划→写入→再切回客户 PLM),期间客户 PLM 拉取约 1 小时不可用。这是 `autonomous-48h-plan-20260905.md` §3 里预先假设"可接受"的操作,已按此执行,此处留痕请 owner 追认为既成事实,并作为未来同类实测的默认操作规程。

12. **W4 flag 的覆盖面比"备料"大**:`MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED` 打开后覆盖的是**整个 integration 插件面**(备料四十余条路由,以及共享 `requireTableActionAccess`/`resolveTenantId`/`resolveAuthUserTenantId` 三个入口的外接系统、数据源、模板、管道等路由),不是只影响备料。222 只跑备料线,这个范围可接受;这是否应当作为通用部署的默认建议,还是需要先做到"只收窄到备料路由",待拍板(#5503 三路对抗审查遗留项)。

13. **W3a 缺件清单设计的三条既有留白(PR #5500 正文"未做 / 留给 owner"一节)**:
    - **13a(D-A)缺件 CSV 是否加"每次探测一行"模式**:当前 CSV/复制按零件号去重成一行(用 `parentCount` 角标标出该零件挂在几个父件下);要不要额外提供"探测到几次就展开几行"的明细模式,待拍板。
    - **13b(D-B)大 BOM 后台作业通道不开缺件清单口子**:后台展开/分批写入这条通道目前**不提供**缺件清单(`includeMissingComponents`)——因为大 BOM 作业会把中间结果(含零件号)落库,与"零件号只在请求-响应间过、不持久化"的 values-free 设计冲突。当前姿态是维持不开,这里留痕供 owner 确认是否接受这个限制,还是要为落库路径单独设计一套脱敏/保留期机制。
    - **13c(D-C)`rowErrors` 数组无上限且全量进 revision 哈希**:这是**先于**缺件清单存在的既有隐患——`rowErrors` 今天没有条数上限,且整个数组参与 revision 哈希计算。修它(加上限或改哈希范围)会改变 revision 的计算结果,任何在飞的人工确认会因 revision 不匹配而被判"已过期需要重新确认"。这是否值得为此让在飞确认作废,以及选在哪个窗口做,待拍板;不与本次缺件清单交付同批。

14. **既有行读取的 10 万行上限(#5501 对抗审查遗留,未采纳但值得跟进)**:existing-rows 的读取目前按 100 页 × 1000 行(合计上限 10 万行);若客户某个项目已落地行数超过这个上限,该读取上限需要与后台展开的独立上限一并放宽——当前尚未做,只在 #5501 的对抗审查里被记录为"值得跟进"而未处理。

15. **canonical 绑定"保留归属戳"是一次有意的契约反转,不是缺陷修复的副作用(#5505)**:此前的不变式是"canonical 绑定不携带 `dataSourceOwnerId` 归属戳"(以 `external-systems.test` 两条既有断言体现);#5505 把它反转为"canonical 绑定校验通过后由服务端写入归属戳",作为委派修复的基础。这是对既有契约的有意变更,owner 需要知悉这个反转本身,而不只是它修好的那个 400 症状。**222 现状**:两条外接源(客户 PLM、合成源)都还没有归属戳,需要绑定者重新保存一次绑定才能补上(见交付说明 §5-② 与现场连接测试 runbook §1.1)。

16. **后台大 BOM 作业的"后台"目前只是任务契约,不是真正的 worker(记录,暂不改)**:大 BOM 展开作业的 run 路由在一次 HTTP 请求内同步 `await` 完整展开与写入——W3c 复测里 453.6 秒的写入循环就是在同一个请求里跑完的。客户端体验是"提交后长时间挂起等待响应",不是异步轮询进度。是否需要改造成真正的后台 worker + 轮询接口,待拍板。

17. **`audit_logs` 分区的创建时机**:数据库函数 `create_audit_partition()`(建下个月分区)存在但没有任何调用者——不在应用启动流程,也没有接每日调度,分区目前只能靠手工 SQL 或"撞上缺分区错误后自愈"。**#5506 已合入 main**(66d40c2fb,2026-09-06 04:20)只修复了自愈的识别逻辑(改按 SQLSTATE 而不是英文报错文案),没有改变"只能事后自愈、不能提前预建"这个姿态。是否要把 `create_audit_partition()` 接到启动检查或每日调度,待拍板。

18. **确认队列 tab 的管理员 ensure/reconcile 两个按钮在 main 上未接线**:`StockPreparationConfirmationQueueView.vue` 两个按钮只 `emit('admin-action', 'ensure' | 'reconcile')`,`StockPreparationWorkspace.vue:91-93` 渲染该组件时没有监听 `@admin-action`——点了不发任何请求(与 `beiliao-data-map.html` 直言缺口一节所记一致)。要不要接线,待拍板。**已实现,待 owner 追认(2026-09-06)**:shell 已监听 `@admin-action`,ensure → 既有 `createStockPreparationInstallApi(scope).ensureConfirmationLedger()`,reconcile → 既有 `createStockPreparationProjectSyncApi(scope).reconcile(projectNo)`;结果落在一条 values-free 提示上(成功三句固定文案,失败走 `plainLanguage.ts` 错误词表 + 原始错误码)。按钮的可见性门控未动,仍是 `STOCK_PREP_WORKBENCH_CAPABILITIES` 的 `PLATFORM_ADMIN_GATE`,操作员依旧看不到。

19. **reconcile 的 projectNo 由调用者提供、同租户内无按项目 ACL**:`stock-preparation-confirmation-decisions.cjs:1068-1086` 的孤儿清扫按请求携带的 projectNo 圈定既有行范围(不跨租户),但同一租户内任何持有 reconcile 权限的调用者都能对任意 projectNo 发起孤儿清扫,把该项目下别人的 pending 决定行作废(改判 superseded)——校验的是租户归属,不是"这个调用者是否归属这个项目"。要不要为 reconcile 加一道项目归属校验(收的是归属不是权限档位 tier),待拍板。**已实现,待 owner 追认(2026-09-06)**:走操作员分支的调用者(即 `hasPermission(user,'admin')` 为假的那一支),在双门之后、动作查找/B2a/源读/审计之前,复用「我的项目目录」同一个谓词 (`listOperatorProjectDirectory`,按 projectNo 收窄)校验;不在其中一律 403 `STOCK_PREPARATION_RECONCILE_PROJECT_NOT_VISIBLE`,平台管理员与 legacy `integration:admin` 完全不受影响。**两条如实说明,请 owner 一并裁决**:(a) 这道门只能做到「限本租户的项目」——目录本身按租户给,同厂两个操作员看到同一批项目,分不开同事,真要分需要一张还不存在的项目归属表;(b) 部署里没有 MVP 项目表时(该表只由平台管理员 + 开关双限的 `mvp-persist` 写,客户部署常常没有)这道门放行,否则会把确认队列整条链从一线手里拿走——推论是:某部署一旦跑过 `mvp-persist`、该表存在了,一个从未归档过的新项目,一线第一次对账会被拒 403,需要管理员代跑或先归档。
