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
| 2026-09-06 06:59 | 定时任务令牌切回专用服务账号 | `stock-prep-scheduled-pull.env` 的 `MS_TOKEN` 换成服务账号 `svc-stockprep-scheduler`(登录禁用哨兵 hash、role admin、user_orgs 恰一条 default)签发的 7 天令牌(到期 2026-09-12 22:59Z);原管理员令牌文件备份为 `*.env.bak-admin-2026-09-05`(ACL 仅 Administrators/SYSTEM);`Start-ScheduledTask` 实跑:LastTaskResult 0,dry-run 200 manual_confirm_required,add 135/manual_confirm 225,failed 0,日志 values-free |
| 2026-09-06 08:06–08:09 | r13 上 222 + 审计分区 daily 开启(#5511) | #5511 已合(d0f07f5ca):`ensurePartitionsForCurrentAndNextMonth` + `audit-partition-schedule.ts`(env `AUDIT_LOG_PARTITION_ENSURE` off 默认/startup/daily)+ index.ts 启动钩子 + 17 例 vitest;r13 = main d0f07f5ca(CI run 34000243395,zip sha OK,gitSha 一致,12293028 B),441 哈希 OK,迁移 0,health 200;追加 `AUDIT_LOG_PARTITION_ENSURE=daily`,pm2 日志确认 mode=daily,分区 2026_08/09/10 在位;交付包 `备料交付-r13-20260906` |
| 2026-09-06 13:50 | owner 要求加速 → W6 工作流开工 | 工作流 wf_0178eddb-001(15 agents,96 分钟):三支并行实现,每支三路 opus 对抗核验(security/correctness/regression)→ blocker 发回修 |
| 2026-09-06 16:07 | #5515 已合(b314c4b4e) | rowErrors 封顶(默认 5000,配置可覆盖,硬顶 20000,超顶 422 拒绝、不静默钳制);4 blocker 全是"封顶开的第二个 fail-open"(缺件汇总 probeCount 缩水;快照映射器丢掉上限外 missing_child_bom 把 incomplete 翻成 mapped/PARTIAL 翻成 SUCCEEDED)已修;上限以内字节级不变 |
| 2026-09-06 16:08 | #5514 已合(d7aa1ddf1) | 大 BOM 后台作业失败 values-free warn 日志接线(`http-routes.cjs` 传入 `routeLogger`);1 blocker(钉住文件里那行接线零测试覆盖)已补 |
| 2026-09-06 16:4x | #5516 已合(d636a053e) | 确认队列管理员 ensure/reconcile 按钮接线 + 对账项目可见性门;7 blocker(放行判据判表存在而非有行;数字 projectNo 绕过门;通知段劈裂 v-else-if 链;"限本人"在同一账本上不成立等)已修;裁定:核验证明数据模型无项目归属,门只能做租户级,且租户归档过任一项目后一线对未归档新项目首次对账会 403 → 门改 env `MULTITABLE_STOCK_PREP_RECONCILE_PROJECT_DIRECTORY_GATE` 默认关(flag 关时操作员宿主调用轨迹与管理员逐项相等),按钮接线与 400 修复保留(**该 env 键已于 2026-09-06 随门整段删除,见第 19 条**;此行保留 #5516 当时的原样口径作为时间线记录) |
| 2026-09-06 16:53–16:56 | r14 上 222 + 验证 | r14 = main d636a053e(zip 12360738 B,sha OK);备份 pre-r14-20260906-165348,441 哈希 OK,迁移 0,health 200(第 7 次探测),标记 #5514/#5515/#5516/#5511 全 True,app.env 36 行保留;验证:门 env 未设(默认关)、flag 403/200、操作员拉取 200、对账 200、建账本/切源 403、审计 9→12、单条绑定 |
| 2026-09-06 16:56 之后 | 交付包 r14 | 交付包 `备料交付-r14-20260906`(交付说明 64782 B,sha OK,values-free 扫描净);r12/r13 包保留;定时任务服务账号令牌 13:50 已轮换(到期 2026-09-13) |
| 2026-09-06 17:4x–20:0x | W7 设计稿三轮对抗 + 定向修订 | 两份稿子与附录入库(本 PR) |
| 2026-09-06 21:37 | 大 BOM 写入两轮只读实测完成(skip 0001 + CREATE 0002,按 §1.7 方案) | skip 轮(`SYN-PROJ-LARGE-0001`,132 chunk 全 skip):每 chunk 服务端墙钟 490.8ms,`meta_records` 的 `n_tup_ins`/`n_tup_upd` 均为 0,跳过分支不触发 §1.3 描述的重读。CREATE 轮(`SYN-PROJ-LARGE-0002`,从未写入过,132 chunk 全 created,协调方裁定豁免"不删行"护栏仅限生成器脚本对 `dn_pdm_*` 表 `SYNL-%` 行的 DELETE、其余护栏不变):每 chunk 5179.8ms,每行服务端墙钟 47.07ms,`meta_records`/`meta_record_revisions` 的 `n_tup_ins` 精确等于 13151;两轮数字入库,报告见 `design-large-bom-worker-20260906.md` §1.8 |
| 2026-09-07 00:06–01:05 | memo 重测(0003,memo 开)+ 同状态对照(0004,memo 关) | 00:06:20 在 222 上打开 `MULTITABLE_ENABLE_REQUEST_METADATA_CACHE=true`(#5524,已合)重跑 CREATE(`SYN-PROJ-LARGE-0003`):常量元数据扫描按预期降到约 1/chunk,但服务端每 chunk 墙钟涨到 6763.2ms(+30.6% vs 0002);因驱动脚本一次性铸造的管理员令牌 900s 不续期,总耗时 905.5s 超出门槛,第 132(最后一)个 chunk 收到 401,job 停在可续跑的 `paused`(131/132 chunk,13100/13151 行,已如实标注分母)。协调方指出减速可能是"目标表比 0002 轮又大了一倍"这个混杂因素,要求同状态对照;00:45–01:05 补跑 `SYN-PROJ-LARGE-0004`(memo 关,测试驱动令牌 TTL 临时放宽到 1800s,仅改 tmp 与 222 `tools-r15` 测试工具副本、未改仓库,132/132 完整跑完):8759.4ms/chunk,比 0003 更慢。判定 **growth_explains**——表增长而非 memo 开关是服务端墙钟的主导因素;扣掉表增长后 memo 本身的边际效应推断为轻微正向。收尾另发现 `pm2 restart --update-env` 不会撤销一个从 `app.env` 里删掉的键,已用显式 `=false` 重启纠正并二次确认干净。详见 `design-large-bom-worker-20260906.md` §1.9 |
| 2026-09-07 01:20 | 根因诊断(opus,222 只读 `EXPLAIN ANALYZE` 实证) | 定位 §1.9 那条随表增长线性上涨曲线的真正来源:`findExistingRecord`(`stock-preparation-apply-writer.cjs:250-267`,ADD/UPDATE 分支各调一次)→ 宿主 `query-service.ts` 生成的 `SELECT … FROM meta_records WHERE sheet_id=$1 AND data->>$2=$3 ORDER BY id ASC LIMIT 2` 对 `data->>key` 无索引覆盖,规划器改用仅覆盖 `sheet_id` 的索引做前缀扫描、逐行取 JSONB 过滤,等价于对目标 sheet 全部现有行做一次顺扫;`UPDATE` 路径同样 O(n)。222 上 `idx_tup_read`/`idx_scan`≈26,992,对已有 52,560 行的 sheet 做 `EXPLAIN ANALYZE`:`Rows Removed by Filter: 52560`,114ms/次。三点最小二乘拟合(推断,基于三个数据点的线性回归):斜率 1.382ms/千行、截距 28.34ms/行,残差≤1.54ms。与 #5524 的 memo 正交(memo 砍的是常量元数据重读,不覆盖这条存在性查询)。否决 GIN `@>` 索引(带 `sheet_id`+`LIMIT` 时规划器改走 Seq Scan,且语义不等价)、逐 sheet 表达式索引(DDL,须先过已证租户门)、唯一索引+upsert(长期正解,改动面大)三条替代方案。最小修法(每 chunk 一次批量查重,`= ANY(...)`)正在另一支 PR(`perf/stock-prep-batch-key-lookup`)实现,推断预期每行降到约 30ms 常数;下一个杠杆是批量 `INSERT`(截距 28.34ms 是每行独立事务+修订历史写入的固定开销)。详见 `design-large-bom-worker-20260906.md` §1.10 |
| 2026-09-07 01:47–02:52 | W9(PR #5526,幂等键查重批量化)三路对抗核验 | 3 个 blocker 全部修复后合入 main(`8b9aed5f0`) |
| 2026-09-07 02:53–03:2x | r16 上 222;用从未写入过的合成项目 `SYN-PROJ-LARGE-0005` 复测批量查重(与 0004 轮同构对照) | 132/132 chunk 完整跑完,13151 行,0 failed;`idx_meta_records_sheet_id_id` 的 `idx_scan` 增量=132(精确等于 chunk 数,不再等于行数);服务端每 chunk 墙钟 2669.06ms(0004 对照 8759.4ms,−69.5%);每行服务端墙钟 21.864ms(裸口径 26.79);总驱动 378.3s(0004:1175.8s)。详见 `design-large-bom-worker-20260906.md` §1.10「验收」 |
| 2026-09-07 08:04–08:15 | owner 报 222 网页空白;根因是我们自己的打包方式 | r12–r16 五个包的 `apps/web/dist/index.html` 资源路径全是 `/C:/Program Files/Git/assets/…`:打包时在 Git Bash 里 `gh workflow run … -f base_path=/`,MSYS 路径转换把孤立的 `/` 改写成 Git 安装目录,Vite 的 base 就错了;nginx 对这些路径 `try_files` 回落成 `index.html`(200 text/html),JS 全当 HTML 加载 → 白屏,而 `/api/*` 全部正常,所以历次 API 级 verify/彩排全绿。222 前端自 09-06 r12 起白屏一整天。修复:r16b(main `58e8ceea4`,同 r16 代码,只是 base 正确)重新打包(打包脚本改为不传 base_path、关闭 MSYS 路径转换、下载后断言 `index.html` 首个 `src` 以 `/assets/` 开头),08:13–08:15 就地升级 222,新增前端 smoke(经 nginx 取 index、逐资源断言 content-type)PASS,verify 全过。r12–r16 五个交付包目录已加 `-BROKEN-web-base` 后缀,不得交付;交付包改用 `备料交付-r16b-20260907`。交付说明 §2.1/§9 已补「升级后必查前端 smoke」 |
| 2026-09-07 08:35–08:37 | 清理五轮实测的合成数据(owner 08:1x 批准) | 只读盘点先证明判别谓词(sheet_id + 项目号 `^SYN-PROJ-LARGE-000[1-5]$` + 幂等键里 `componentSourceId LIKE 'SYNL-%'`)正反向零误差:65,704 行;同一 sheet 另有 7 行项目号 `SYN-PROJ-0001`(源行非 SYNL 前缀,像最早的小合成 BOM,也可能是演示数据)→ **不动,待 owner**。`pg_dump` 后单事务删除,每步 `GET DIAGNOSTICS` 与预期精确比对:revisions 65,704、records 65,704、plugin_kv 作业键 14(含 0003 轮 paused 检查点;展开作业已完成,cancel 端点不适用)、`dn_pdm_*` SYNL 行 26,956(13150/651/1/1/13151/1/1);第一次运行在「孤儿 revision 必须为 0」处主动回滚——库里有 129 条与本次无关的既有孤儿 revision,改为「孤儿数前后相等」后通过。`VACUUM (ANALYZE)` 后 `meta_records` 149→46MB、`meta_record_revisions` 232→64MB。非 SYNL 源行、审计表、客户 PLM 绑定未动;verify + 前端 smoke 全过 |
| 2026-09-07 16:2x | 客户决定 222 直接转正,不再是彩排/测试环境;备料即 metasheet 应用内的 `/stock-prep` 页,不是独立系统 | 后续步骤按"222 转正"口径推进,不再是演示环境的临时状态;直接触发 18:18–18:24 的清库重建与零起点迁移实测,以及本文件下方新增的"222 转正剩余步骤"清单 |
| 2026-09-07 18:18–18:24 | 权限核实 + 清库重建(owner 决定 222 直接转正、旧数据不要) | 先核实:222 的库与 `public` 模式已归应用角色 `metasheet`(`super=false`、`createdb=false`),扩展 `pgcrypto`/`btree_gist` 也归 `metasheet`(迁移用 `CREATE EXTENSION IF NOT EXISTS` 自建,PG13+ 上这两个是 trusted 扩展,不需要超级用户)。流程:`pg_dump -Fc` 备份 + 复制 `app.env` → 停用两个计划任务(`metasheet-stock-prep-scheduled-dry-run`、`metasheet-stock-prep-token-rotate`)→ `pm2 stop` → 以应用角色执行 `DROP SCHEMA public CASCADE`(级联 615 对象)→ `CREATE SCHEMA public AUTHORIZATION metasheet` → `GRANT USAGE ON SCHEMA public TO PUBLIC` → 装载 `app.env` 到进程环境后在 `C:\metasheet` 下跑 `node packages\core-backend\dist\src\db\migrate.js`(与就地升级脚本同一调用):**398 条迁移从零全部成功(exit 0)**,建出 407 张表,函数归属与升级前一致;`pm2 restart --update-env` 后 30 秒 health 200;启动自动建出 `audit_logs_2026_09`/`2026_10` 分区;错误日志无新错;经 nginx 的前端 smoke PASS;用户表 0 行。全程只用应用角色,不需要 DBA/超级用户,前提只有一个:库和 `public` 模式的所有者已经是应用角色。随后注册每日 `pg_dump -Fc` 备份计划任务(`metasheet-daily-pg-dump`,SYSTEM,每日 03:30,保留 14 天),首跑成功 |
| 2026-09-08 00:15 | owner 授权全自主 UX 落地 | 拍板设计稿 `beiliao-ux-redesign-20260907.md` 的 UX 实现分 U1(前端两线)/U2(后端 N1/N2/N6)/C(收尾三项)三线全自主推进,按任务难度选模型:sonnet 实现 → 三路 opus 对抗核验 → opus 修复,定为默认节奏 |
| 2026-09-08 00:1x | U1 第一波启动(A/B 两线) | A 线(PR #5539,接入向导 + 错误两行化 + 五处诚实文案,对应设计稿 P0-4/5/7)与 B 线(PR #5541,任务首页 + 四步 stepper + 下一步条 + 状态徽标,对应 P0-2/3/6)并行由 sonnet 实现;随后各自转入三路 opus 对抗核验(security/correctness/regression 视角),核验发现的 blocker 回 opus 修复 |
| 2026-09-08 01:5x | 核验完成 + U2 裁决 r3 | A 线三路核验去重后 6 组 blocker(交接卡假绿宣称跑通、六步地图对已装好部署报零进度、`ledger_missing` 按钮无权限门等)全部修完;B 线三路核验 17 条 blocker,12 条修复(工作区同屏两个填充主按钮、首页徽标建在管理员归档上而非活看板、并集合并方向反了、带 `projectNo` 挂载先闪一屏首页等)+ 1 条(§4.2 规则 2:缺件重新进入 tab 后不可达)有据不修、记入 PR"有意偏离"一节。同时 U2(PR #5540)的核验裁决 r3 落地:并集扫描由默认改为 `includePullTargets=1` **opt-in**,不带参数时响应形状与审计 detail 回到与 origin/main 逐键相同 |
| 2026-09-08 02:18 | #5539 已合(a22141772) | U1-A 落地:`StockPreparationGettingStarted.vue` 接入向导(六步地图 + 六态徽标 + 九步计划提前渲染 + blocker 按 `http`/`env` 两类渲染 + 第⑤步静态版 + 完成交接卡),`STOCK_PREP_ERROR_PLAIN` 等错误词表放宽为两行 + 「复制这条报错」,五处诚实文案(no-go 免责句 / 两卡关系句 / 源预检按钮旁注 / 对账按钮旁注 / `ledger_missing` 空态按钮) |
| 2026-09-08 02:47 | #5540 已合(b9cba7262) | U2 落地:操作员项目目录并入拉取目标表项目号(`includePullTargets=1` opt-in)、可选待确认计数(`includePendingCounts=1`)、两个时间戳三态(`lastChangedFromPlmAt`/`lastExportAt`);独立反驳员复核确认**默认路径(不带参数)响应与 origin/main 字节级相同**;C5(多租户共享部署级拉取目标表时,拥有目标表的租户在 opt-in 下会枚举到其他租户 apply 写入的项目号)记为已知限制,222 单租户无实际影响,长期修法为按租户目标表,未排期 |
| 2026-09-08 02:57 | #5541 已合(7dd38238d) | U1-B 落地:`StockPreparationOperatorHome.vue` 任务首页寄生 `project-board` tab(四个计数筛选 chip + 全部 + 卡片 + 空态四态)、四步 stepper 皮肤(既有 testid 不变)、`operatorNextStep.ts` 全页唯一「下一步」条、`projectPosture.ts` 状态徽标三处同词 |
| 2026-09-08 02:31 | C 线工作流启动 | 队列自动带项目号(P0-1)、动作后自动重读(P0-8)、闭环句(P0-9)三项收尾工作流开工 |
| 2026-09-08 03:5x | 交付文档 #5547 已合(6af167b90) | 交付说明补 P0 界面(接入向导 / 首页 / stepper)、操作员项目目录两个查询参数、多租户已知限制;运行记录补 U1/U2 时间线 |
| 2026-09-08 04:51 | C 线 #5546 已合(61ecc67d1) | 队列自动带项目号(P0-1)、动作后自动重读(P0-8,对账成功重读队列、建账本成功重读目录)、闭环句/tooltip(P0-9)、首页目录接拉取目标并集(#5540 契约);三路对抗核验共 6 组 blocker(`RECONCILE_OK` 文案仍暗示"手动刷新"未清干净、并集扫描误算到项目备料页头上、`nothing_pending` 空态按钮无权限门、`loadQueue` 把读不出来的响应"规整"成伪造空队列、三处 `:key` 从 `projectId` 降级成 `projectNo`)全部修复;另有两条协调者裁决:摘掉 `includePendingCounts=1`(首页目录读改为只带 `includePullTargets=1`,`confirmationQueue.ts` 同步删除已无消费方的 `pendingCountsByProjectNo` 响应字段与请求选项)、`pullTargetReady=false` 文案改口(不再暗示"临时性",改为"这次读不到") |
| 2026-09-08 04:55 | r17 上 222 | main `61ecc67d1`,包 12.49 MB;就地升级 8 步全过(pg_dump 备份、442 文件哈希 OK、迁移 0、health 200);经 nginx 前端 smoke PASS(`index-CFl7s7Vf.js`);U2/P0 标记全 True;§5-5 租户声明硬门 flag 有效(无声明 403 / 有声明 200) |
| 2026-09-08 05:0x | 操作员链首跑全部 403,定位根因 | 测试操作员通过 `/api/permissions/grant` 直接拿到 `stock-prep:read`/`stock-prep:operate`(`user_permissions` 表里确实有),但 `/api/auth/me` 只返回考勤权限——命名空间过滤:控制命名空间只从用户的角色(`user_roles`→`role_permissions`)推导,清库后没有任何角色带 stock-prep 码,直接授予的权限被过滤掉(`filterPermissionCodesByNamespaceAdmission`/`fetchUserNamespaceRoleContext`,`packages/core-backend/src/rbac/namespace-admission.ts`) |
| 2026-09-08 05:05 | 建角色 `stock-prep-operator` 并分配,立即生效 | 按产品正路在「角色管理」建角色(备料一线操作员,权限 `stock-prep:read`+`stock-prep:operate`)并在「用户管理」分配给测试操作员后立即生效:目录 200、确认队列 200;看板/拉取/导出/对账 404(`ExternalSystemNotFoundError`/`PROJECT_NOT_FOUND`——外接源尚未在界面建立,属预期);建账本/切换数据源 403(正确拒绝)。P0 API 验收 PASS:默认目录响应键与升级前完全一致;`includePullTargets=1` 返回 `pullTargetReady=true`/`directoryMayBeIncomplete=false`/`pullTargetScanCapped=false`/`lastExportAtMayBeIncomplete=false`;`includePendingCounts=1` 返回 `pendingCountsByProjectNo`;传字面字符串 `"true"` 不打开并集;四种请求均 20–160ms |


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

17. **`audit_logs` 分区的创建时机**:数据库函数 `create_audit_partition()`(建下个月分区)存在但没有任何调用者——不在应用启动流程,也没有接每日调度,分区目前只能靠手工 SQL 或"撞上缺分区错误后自愈"。**#5506 已合入 main**(66d40c2fb,2026-09-06 04:20)只修复了自愈的识别逻辑(改按 SQLSTATE 而不是英文报错文案),没有改变"只能事后自愈、不能提前预建"这个姿态。是否要把 `create_audit_partition()` 接到启动检查或每日调度,待拍板。**2026-09-06 08:06 更新**:已实现为 env 门控 `AUDIT_LOG_PARTITION_ENSURE`(#5511,off 默认/startup/daily 三档),222 已开 `daily`(pm2 日志确认 mode=daily,分区 2026_08/09/10 在位)。

18. **确认队列 tab 的管理员 ensure/reconcile 两个按钮在 main 上未接线**:`StockPreparationConfirmationQueueView.vue` 两个按钮只 `emit('admin-action', 'ensure' | 'reconcile')`,`StockPreparationWorkspace.vue:91-93` 渲染该组件时没有监听 `@admin-action`——点了不发任何请求(与 `beiliao-data-map.html` 直言缺口一节所记一致)。要不要接线,待拍板。**已接线(#5516,2026-09-06 16:4x 已合入 main)**:shell 已监听 `@admin-action`,ensure → 既有 `createStockPreparationInstallApi(scope).ensureConfirmationLedger()`,reconcile → 既有 `createStockPreparationProjectSyncApi(scope).reconcile(projectNo)`;结果落在一条 values-free 提示上(成功三句固定文案;失败走 `plainLanguage.ts` 错误词表——reconcile 的客户端错误带 `code`,所以显示该码自己的句子 + 码本身,ensure 的客户端错误类型按设计只带 status 不带 code,所以显示通用句、旁边不带码)。提示挂在整条 tab 条件链**之外**,并在切 tab 时清空(挂在链中间会静默把 `v-else-if` 链劈成两条)。按钮的可见性门控未动,仍是 `STOCK_PREP_WORKBENCH_CAPABILITIES` 的 `PLATFORM_ADMIN_GATE`,操作员依旧看不到。

19. **reconcile 的 projectNo 由调用者提供、同租户内无按项目 ACL —— 已拍板 B:门已删(本 PR)**:`stock-preparation-confirmation-decisions.cjs:1068-1086` 的孤儿清扫按请求携带的 projectNo 圈定既有行范围(不跨租户),但同一租户内任何持有 reconcile 权限的调用者都能对任意 projectNo 发起孤儿清扫,把该项目下别人的 pending 决定行作废(改判 superseded)——校验的是租户归属,不是"这个调用者是否归属这个项目"。**owner 2026-09-06 拍板方案 B:不做项目归属,删掉 #5516 那段门控代码**,理由是它无论怎么实现都只能做到租户级(目录按租户给,分不开同厂两个操作员——而"分开同事"正是提这个需求的原因),而且它唯一的放行口("本租户一个归档项目都没有")一旦本租户归档过任何项目就反转成"从未归档过的新项目、一线对它的第一次对账被 403",而归档(`mvp-persist`)是平台管理员 + 开关双限、一线四步拉取第 4 步本来就 SKIP。留一个默认关、永远不会打开的 env 开关只会长草,所以整段删。**本 PR 删掉的**:`http-routes.cjs` 的 `stockPreparationReconcileProjectDirectoryGateEnabled()` 与 reconcile 处理器里的门块(含门内第二次 `resolveOperatorValueScope`)、`stock-preparation-operator-project-directory.cjs` 的 `assertOperatorMaySeeProject` / `projectArchiveIsEmpty` / `includeArchiveEmptiness` opt-in、operator-scope 头注第 10 条、错误码 `STOCK_PREPARATION_RECONCILE_PROJECT_NOT_VISIBLE` 的定义与前端文案;守卫账同批结清(G9 调用点 11→10 并从表头 marker 里去掉 reconcile、tenant-scoped-write-guard 的 PINNED 与 staging 形态对、P-13 armed 系列与 P-13f 合并重写)。**保留的**:"projectNo 写成 JSON 数字一律 400 `TABLE_ACTION_PARAMETERS_INVALID`"——那是请求格式的答复不是权限收窄,从来不属于这道门。**现在的边界口径**:reconcile 只校验租户,不校验项目;争议靠审计反查(reconcile 每次写 `generation_run` / `confirmation_reconcile_requested` 审计行,带操作人与时间,写在落库之前)。**审计项目号已补(本 PR,即设计稿的 PR-1a/PR-1b)**:该审计行的 `project_id` 过去为空、只能按时间窗 + 人反查,本 PR 已补上——对账的审计行填请求里的 projectNo,确认的审计行由 `decisionId` 软查一次账本行拿 projectNo(查不到唯一一行、或那次软查本身失败,都留空;不阻塞、不改「intent 行排在写之前」的次序),不新增审计动作、不新增审计行。**补的是确认队列上这两条**——物料匹配/单位/异常那一族与导出、通知下一步本来就填 `project_id`,空着的一直只有对账与确认。于是"这个项目的**队列**被谁动过"现在按 `project_id` 就能查(查询与四种正常留空情形见交付说明 §9),归属表做不做与这条无关。**反查故事里仍然为真的两条限制**:被作废的账本行本身只写 `status: SUPERSEDED` 与 `supersededAt`,不写操作人、也不写运行号,所以"谁作废了哪些行"仍不是一次查询,要拿 `supersededAt` 去和同租户同一时间窗内的审计行对撞;审计行写在源读与 BOM 展开之后,所以在读源阶段就失败的对账不留任何审计行(那种运行也没有作废任何行)。已排除的一种"修法":把放行条件放宽成「账本里有该项目的待确认行就放行」——待确认行正是孤儿清扫要作废的对象,那样恰好在会造成损害的情形下放行。设计稿见 `design-project-ownership-20260906.md`(§2 方案 B 是本次采纳的一支;C 认领制约 5.6 天,未采纳,若将来要做按人归属仍以它为底稿)。

20. **rowErrors 封顶已合(#5515)**:默认上限 5000(动作配置可覆盖,硬顶 20000,超顶 422 拒绝、不静默钳制)。上限以内的项目字节级不变;超过上限的项目 revision 会变化,在飞的 `dryRunToken` 会 409 MISMATCH、已发起的人工确认会被判超期重新确认。建议在客户对这类超限项目积累大量人工确认之前上线,避免大批在飞确认被作废重开。

21. **定时任务服务账号令牌需要定期轮换**:`svc-stockprep-scheduler` 签发的令牌固定 7 天有效期,当前一枚已于 2026-09-06 13:50 轮换(到期 2026-09-13)。这是持续性运维负担而非一次性任务,建议纳入运维日历提醒,或做成到期前自动轮换的计划任务,避免定时拉取因令牌过期而静默失败。

22. **大 BOM 后台作业 worker 化**:设计稿见 `design-large-bom-worker-20260906.md`,结论前置于 §1.7 实测——三轮对抗复核下来,每一轮新写的时间/收益模型都被证伪,本轮不再排序 L1/L2/L3 等性能杠杆,只给出一次不改代码、不改 PG 配置的实测方案(拿到"453.6 秒里服务端占多少、哪条语句吃掉多少"这两个数),与实测无关、可独立推进的只有两处已确认的安全缺口(apply 作业无 actor 守卫、cancel 路由注释与代码不符)。owner 决定是否授权在 222 做一次只读实测。**2026-09-06/07 更新**:§1.7 实测已按上述方案执行(见时间线 2026-09-06 21:37、2026-09-07 00:06–01:05、01:20 三条;`design-large-bom-worker-20260906.md` §1.8/§1.9/§1.10),L1(常量元数据 memo)已作为最小形状随 #5524 合入且默认关;真正的减速主因(幂等键查重的整表扫描)已定位并修复(PR #5526,2026-09-07 01:47–02:52 三路核验后合入 main `8b9aed5f0`,r16 已上 222,验收数字见时间线 02:53–03:2x 与 `design-large-bom-worker-20260906.md` §1.10「验收」),以下三条是追加实测(含 0005 验收轮)新产生的待裁决项。

23. **是否在 222/客户机常开请求内元数据 memo(`MULTITABLE_ENABLE_REQUEST_METADATA_CACHE`,当前默认关)**:2026-09-07 的三轮追加实测(见时间线 00:06–01:05、01:20;`design-large-bom-worker-20260906.md` §1.9/§1.10)证实打开 memo 后常量元数据扫描确实按预期降到约 1/chunk,但服务端每 chunk 墙钟不降反升;经同状态对照排除"目标表增长"这个混杂因素后,判定表增长才是主导因素,扣掉表增长后 memo 本身的边际效应推断为轻微正向(基于 3 点线性外推,非确证)。真正随表增长线性上涨的根因(幂等键查重的整表顺扫)尚未修复。在这条根因修完之前打开 memo 拿不到确定的收益,待 owner 裁决是否现在就在 222(进而客户机)常开。

24. **合成目标表现约 6.6 万行(2026-09-07 0005 轮跑完后更新),要复现小表基线需清理合成行(写操作,待裁决)**:四轮 CREATE 实测(0002/0003/0004/0005)都往同一批合成源(`SYN-PROJ-LARGE-*`)累计写入,目标表(`meta_records` 等)从 0002 轮开跑前约 1.3 万行,一路涨到 0005 轮跑完后约 65,891 行(≈6.6 万行)。**2026-09-07 更新**:PR #5526 上线 r16 后,每行成本已不再随表增长线性上涨(见新增第 25 条与 `design-large-bom-worker-20260906.md` §1.10「验收」),但后续再实测测到的仍是这条已经很大的表上的一个点,测不回 47.07ms/行(0002 轮)这类小表状态下的基线数字。清理合成行是写操作,不在只读护栏授权范围内,待 owner 裁决是否清理、何时清理。 **2026-09-07 08:37 更新:owner 已批准并执行,五轮 LARGE 合成数据全部删除(见时间线);sheet 内只剩 7 行 `SYN-PROJ-0001`,是否也清仍待 owner 判断。** **2026-09-07 18:24 更新:已清空(整库重建)**——18:18–18:24 按 owner 决定对 222 清库重建(`DROP SCHEMA public CASCADE` 后从零迁移),含上面提到的 7 行 `SYN-PROJ-0001` 在内的全部数据已随之清空,"是否也清仍待 owner 判断"这一问已被整库重建取代,不再适用。

25. **是否把批量查重的并发窗口关死(唯一索引 + upsert,DDL 需过已证租户门)**:PR #5526 把幂等键查重从"每行一次"改成"每 chunk 一次批量查询",把重复插入检测的窗口从一行拉宽到一个 chunk(≤1000,0005 轮实测通常 100)——另一写者若在这个窗口内删掉本应匹配到的行,会让本行的结果由 `created` 变成 `failed`。语义上仍与逐行版本一致(两者都不保证"查完到写完"之间没有别的写者插队),只是命中概率随窗口变宽而变大。真正关死这个窗口的长期正解是唯一索引 + upsert(`design-large-bom-worker-20260906.md` §1.10 已记录为"否决过的替代方案"之一,评价为长期正解但改动面大),但这是 DDL 变更,须先过已证的租户门。是否现在就排期做,待 owner 裁决。


26. **r12–r16 五个交付包的前端不可用,交付只用 r16b**:见时间线 2026-09-07 08:04–08:15。五个包目录已加 `-BROKEN-web-base` 后缀;客户侧若已拿到其中任何一个,请以 `备料交付-r16b-20260907` 替换,并按交付说明 §2.1 的「升级后必查前端 smoke」复核。

27. **222 转正的安装/切换日期待定**:16:2x 客户口头决定直接用 222 当正式环境,18:18–18:24 完成了清库重建与零起点迁移/启动的实测验证,但下面「222 转正剩余步骤」清单尚未走完。正式记录的"安装日期"/"切换日期"该算成决定的那一刻(2026-09-07)、还是清单全部走完的那一刻,待 owner 拍板;在此之前不应认定 222 已经是可交付给客户使用的正式环境。

28. **U1 P0 落地时替 owner 采纳的五项假设(D1/D2/D6/D8/D9,均按设计稿 §8.2 给出的建议值执行,可回滚)**:PR #5539(U1-A)与 #5541(U1-B)对设计稿 §8.2 待拍板的 12 条里以下五项直接按建议值实现,没有先等 owner 拍板——记录在此供追认,任一项都可单独回滚(各自独立实现,互不耦合):
    - **D1**(首页数据来源):**A**——「项目目录」∪「本机记忆」按字段合并:`pendingDecisionCount` 永远取目录(权威的活账本),拉取与否取本机记忆(这台电脑最近一次同步/拉取的活看板结论),两者都没有时出第三态「看不到进度」。
    - **D2**(平台管理员落地页):**A**——P0 不动落地页,只在确认队列 `ledger_missing` 空态加 [去装:开始使用] 按钮,切到「安装」tab 的接入向导。
    - **D6**(源预检自动/手动触发):**手动**——接入向导对源预检零自动触发;第②④步的「未检查」态正是为此准备的默认值。
    - **D8**(本机记忆存什么):**只存时间 + 结论**——每条记忆恰好三个字段 `{projectNo, updatedAt, postureKey}`,有反向断言钉住;`running`(同步中途)与 404(打错的号)均不落盘。
    - **D9**(宜搭按钮范围):**只留在项目工作区**——首页与「下一步」条均不出现宜搭按钮(本波实际是"宜搭未涉及",两处都不出)。

## 222 转正剩余步骤

18:18–18:24 完成的只是"零起点迁移与启动"这一段技术验证。222 要真正成为客户可用的正式环境,还需要按顺序做完以下几步——任一步骤未做完,都不应视为"222 已转正":

1. **首个管理员**:客户/owner 在登录页自助注册首个账号(密码不经我方之手),随后由有数据库访问权限的人执行三条 SQL 把该账号提升为平台管理员(见交付说明 §2.2「首个管理员」小节),重新登录生效。
2. **装备料客户包**:按交付说明 §2 的部署/升级步骤,把本次交付的备料客户包装到 222 上。
3. **授权**:用第 1 步产生的管理员账号建备料角色、挂 `stock-prep:read`/`stock-prep:operate` 两个权限码、指派给一线账号,开启命名空间准入(交付说明 §5)。
4. **绑正式 PLM**:新建外接数据源指向客户正式 PLM(而不是测试库 `10.10.52.16`),完成外部系统绑定、源绑定切换、源预检(交付说明 §3)。
5. **重建服务账号与两个计划任务**:清库时旧的 `svc-stockprep-scheduler` 服务账号随库一起消失,`metasheet-stock-prep-scheduled-dry-run` 与 `metasheet-stock-prep-token-rotate` 两个计划任务已因此停用(见交付说明 §3.2 的注意),需在服务账号重建、新令牌签发之后重新启用并用 `Start-ScheduledTask` 验证一次。

每日 `pg_dump` 备份计划任务(`metasheet-daily-pg-dump`)已在 18:18–18:24 一并注册并首跑成功,不在上面清单里重复。

## W6 教训

1. 封顶类改动要枚举所有消费该数组的下游(快照映射器、缺件汇总),否则封顶本身制造 fail-open。

2. 授权门要先证明数据模型能表达威胁,否则只会把合法流程挡住。

3. **PR 的 base 不要指向一条会被 squash 合并删除的分支**:squash 合并后源分支在 GitHub 上被删,若后续 PR 以它为 base,实现者在该分支已消失后建不出 PR(GitHub 找不到 base ref)。链式提交多个 PR 时,后一个 PR 的 base 要么等前一个真正合入 `main` 后再切,要么直接以 `main` 为 base、自己处理 rebase 冲突。

4. **"一处不剩"类的文案清理声称,不能只 grep 原句字面量,要按语义查常量表**:C 线核验里 `RECONCILE_OK` 的文案曾被判定"已改完、不再暗示手动刷新",但反驳员按常量表逐个 key 核对时,仍抓到一处遗漏——grep 原句只能找到未改的逐字匹配,找不到"同一段话被换了个措辞但语义仍是旧的"这种情况。以后遇到"某类文案已全部清理"的声称,要先列出该文案所在的完整常量表(或所有语言变体),逐条核对语义,而不是对原句做一次全仓 grep 就下结论。
