# 第三轮 24 小时自主开发:设计与验证(2026-09-11 18:55 → 2026-09-12)

> 用户第三次授权「接下去 24 小时我不在电脑前……根据代码难度来选择模型,完成后给出设计及验证 MD」的交付件。
> 前两轮见 `autonomous-24h-run-20260910.md`。本文在窗口结束前持续更新;每节末尾标注「截至」时间(222 本地,UTC+8)。

---

## 0. 一句话结论(截至 2026-09-11 19:20,窗口进行中)

第二轮收尾 + 第三轮开头这一天:合并 4 支(#5630 / #5631 / #5633 / #5634),上 222 两次(r28 15:08、r29 18:06),处理用户 09-11 的 9 条测试反馈——其中「删行/删表报 Failed to fetch,为什么一直没解决」被**日志实证为我自己的四个升级窗口**;由此立下「222 本地 08:00–18:00 不上机」的规矩,并在 18:00 后的批准窗口里给 222 加了 nginx 维护门、zh-CN 表头环境变量、24 列中文改名。其余 8 条反馈拆成 7 支并行 PR(#5640–#5646)已开、在跑 CI;老系统逻辑移植(F1c)读通了 3132 行 Java 后写成规格,等两支前置合入再派。

---

## 1. 授权、边界与新规矩

- 原话:「接下去24小时我不在电脑前,你能帮我持续不间断的开发么?并根据代码难度来选择模型,完成后给出设计及验证MD」(2026-09-11 ~18:55)。
- 边界全部沿用前两轮(worktree 隔离 / junction 依赖 / 两路对抗 / 单点变异自证 / values-free / 不碰凭据 / 不做 K3 写 / 不合别人的 PR)。
- **新增(本轮立下)**:
  1. **222 本地 08:00–18:00 不上机**,除非用户点头。原因见 §3.1。
  2. **反驳者的变异探针只准内存级**(`require.cache` 注入 / `vi.mock` / 复制到 `%TEMP%` 再改),两个镜头并行跑在同一 worktree 上落盘互相污染的事故不再发生(第二轮末尾的教训)。
  3. **会话模型切换后不 resume 工作流**:resume 会以新 key 把已完成阶段整段重跑到已推送的分支上;剩余阶段改用单个 Agent 派。
  4. **222 远端一律 `-File` 脚本**:inline `ssh … powershell -Command` 会吞 `$`(`$_`/`$PSItem`/`$u` 全中招),带 psql 时直接挂住;远端是 PS 5.1,`&&` 不认。

### 1.1 按代码难度选模型(用户三轮都要求)

| 档位 | 本轮实例 |
|---|---|
| sonnet | Y1 账本结清初稿;文档段落 |
| opus | wave6 七支(F5/F9/F4B/F8B/F1a/F1b/F7)、F4A、X2c、Y2 守卫全集、X2 列表回退、全部反驳镜头 |
| fable(本会话模型) | 终审裁判(X1/Y1/Y2/X2/F1a)、F1c 老系统移植(行身份 + 222 写路径) |

---

## 2. 合并与上机(截至 19:20)

### 2.1 已合 PR

| PR | 合并 | 提交 | 主题 |
|---|---|---|---|
| #5630 | 09-11 06:2x | `1dd4d489c` | 独包安装不再无声改写未声明收养的 legacy 字段权限行(C0/P2),C6 守卫,C8 注释 |
| #5631 | 09-11 07:1x | `0ffc5e355` | `ext_` 客户包列写口盘点结清(第三版盘点 ①–⑩),三条会变红的回归测试 |
| #5633 | 09-11 16:0x | `77d2cc9b6` | 「插件写路径不受列级权限约束」钉成真库 golden;三层写口守卫枚举改 TS AST 全集断言 + chokepoint 归一化 |
| #5634 | 09-11 16:1x | `f8cdc2ca1` | 外接源列表对非 null workspace hint 回退同租户 null 行;作用域不匹配的写答 409 |

### 2.2 上 222

| 包 | 222 时间 | gitSha | 携带 | 备注 |
|---|---|---|---|---|
| r28 | 09-11 15:08 | `0ffc5e355` | #5626 #5630 #5631 | 8 步全过;**这次上机窗口正好撞上两位测试在线**(见 §3.1) |
| r29 | 09-11 18:06 | `f8cdc2ca1` | + #5633 #5634 | 在批准窗口内;维护门已生效,浏览器拿到 503 JSON 而非 reset;升级脚本自身的 nginx 探测被 flag 挡红 → 报 exit −1,后端直连健康 3 s 通过、无回滚、全部标记 True |

## 2.3 wave6 合并(截至 2026-09-11 20:30,7/7 已合)

| PR | 提交 | 主题 | 反驳/终审 |
|---|---|---|---|
| #5646 | `36fb213fb` | 导出确定性层级序(过渡版) | r2 0 blocker |
| #5640 | `e25675c91` | 「更多模板」跳转成功才关面板 | r2 0 blocker |
| #5641 | `2c28ec121` | 自动化 notify 别名归一 + 无收件人可操作原因 | r1 0 blocker |
| #5644 | `465bc5670` | 备料填写视图 `prep-fill` 隐藏 12 个系统列 | r2 4 blocker → 修 → 终审 MERGE(三处正文订正) |
| #5643 | `338da25e7` | 管理字段两区可拖动分隔 + 放大缩小 | r2 0 blocker |
| #5642 | `f1a5073ee` | 网络错误人话 + GET 有限重试 | r2 0 blocker;CI 普查要求把新文件登记进浏览器 lane 触发清单(补一行) |
| #5645 | `381b01a82` | 当前数据表一键存为模板 | r2 0 blocker;#5640 合入后在 `MultitableWorkbench.vue` 同一处各加一块而冲突,纯加法两边都留,82/82 + vue-tsc 0,重跑 CI 绿后合入(进 r31) |

另:X2c(#5651,集成响应透传 `error.code`/`status`,ensure 与写动作对 409 作用域不匹配给中文人话;#5634 残余缺口)r1 两路 0 blocker、M1–M3 内存级变异红,**合入 `bcf6754a3`**(进 r31)。

**r30**:从 `f1a5073ee`(r29 + 上表前六支)打包;**第一次 ship 在远端解析阶段就失败、什么都没执行**——我往 wrapper 里塞的标记含中文字面量,PS 5.1 把无 BOM 的 UTF-8 当 GBK 读,尾字节吞掉收尾引号 → 整个脚本 ParserError(222 未动:bundle 仍 r29、无备份、health 200)。wrapper 改成 0 个非 ASCII 字节后重新 ship,结果见 §6。

**教训 5**:上机 wrapper 一律纯 ASCII(或带 BOM);中文断言放独立的 `-File` 校验脚本。

### 2.4 F1c / F8A(截至 2026-09-11 21:20,在飞)

| 支 | 分支 / 基线 | 流程到哪 | 关键裁决 |
|---|---|---|---|
| **F1c** 老系统 BOM 语义移植(fable) | `feat/stock-prep-legacy-bom-semantics` @ `3d826d142`(基线 `2c28ec121`,13 文件 +1725/−64,全在 `plugins/plugin-integration-core/{lib,__tests__}`) | 工作流 7 agents / 0 error;r2 三条 blocker(演示脚本整链红 / 展示层去重键在 specField 部署上比展开层更粗 / 父组件名称被改短)→ fix r2 → **终审 r1 = FIX_FIRST** → fix r3 在跑 | 终审确认:幂等键、`HUMAN_PRESERVED_FIELD_IDS`、冻结 33 列一字未动(templates.cjs +16 行全是注释);根选择逐条对上老系统 `doGetAllBomInfo`;同父去重四项 + 用量与 `iterHandle` 同量、不进幂等键;父组件名称取父行未切分串。**新 blocker**:导出树用部件 id 建父子而行身份是路径 → 共用子装配第二次出现的子行被展示层去重整棵吞掉(实跑 6 行只打 5 行);修法 = 节点身份改用模板必列 `path`,兄弟集合按父**行**。另一条廉价 blocker:后台链 `extensionFieldIds` 接线无测试绑定。六处正文订正(对照表三处「同形」改「有偏离」并写方向;「修法 C」与代码矛盾;open_risks 2 无依据;1141 行段补 mark_inactive/upsert 命中原行)。 |
| **F8A** 改类型第一刀:后端权威无损白名单(opus) | `feat/multitable-field-retype-lossless-whitelist` @ `991babe8e`(基线 `338da25e7`,13 文件 +1089/−93) | 工作流 7 agents / 0 error;r1 两条 + r2 三条 blocker;fix r2 未再核 → **终审在跑** | r2 三条:① ensureFields 逐次调用 `overwriteMode` 是 `meta_fields.type` 的第二写口(不是只有 env 才能开)→ 口径改成「调用方未自选 overwrite/observe 时 fail-closed」;② 排除集**源端**(attachment/lookup/rollup/button/createdTime → text)在 PATCH 路由无守卫、今天仍 200 → 修复者替 owner 选了 (a) 不收紧、补一条 characterization 把 200 钉死(是否越权、attachment→text 是否丢数据,交终审);③ 上一提交写进仓库的「narrowing 文件不在 CI 跑」是假陈述(blanket core-backend lane 每 PR 都跑它)→ 回滚。终审重点:所有 `meta_fields.type` 写点清单、既有契约用例被重写有没有削弱保证、200→400 行为变化清单。 |

顺带发现(基线既有,不是本轮引入):`packages/core-backend/tests/integration/multitable-context.api.test.ts:1193` 的 SQL 拦截守卫正则里有一个 0x08 字节(`meta_sheets` 后本意是 ``,被某次 heredoc 折成退格)→ 该守卫永不命中;全仓控制字符横扫只有这一处是 bug(其余 0x01 都是有意的分隔符/测试输入)。等 F8A 合入后单独一支小 PR 修(同文件,避免冲突)。

**停摆与用户裁决**:09-11 ~21:20 起两个代理被 API 429(session limit,resets 8am PT = 23:00 本地)打死,主循环随之停到 09-12 08:03 才恢复——夜间上机窗口整段错过。08:0x 用户回「允许」= 周六白天可上机。

**r31(`72caae8de` = r30 + #5645 F7 + #5651 X2c + #5654 F4A,09-12 08:11 本地上 222)**:CI 3 分钟出包;备份 `pre-r31-20260912-081140.dump` 2.26 MB;**F4A 升级脚本第一次实跑**——`MAINTENANCE_GATE_WIRED`(举 flag 时 nginx 真答 503 JSON,而不是连接重置)→ 后端直连 attempt 3 OK → 先删 flag 再探 nginx → 200;upgrade exit 0;web smoke PASS;计划任务试算 `LastTaskResult=0`;标记 #5645 / #5654×2 / wave6 全 True;事后迁移 402、pm2 env zh-CN、08:00 后后端错误 0 行、flag 不存在、health 200。#5651 的「字面量计数」标记不成立(minifier 把常量合并成 1 处),以包 gitSha 精确匹配为准。F1c / F8A(+ F9b)合入后打 **r32**。

**F1c 收官(09-12 上午)**:fix r3 `7daeb271c`(导出树节点身份改行路径 `path`、后台链 extensionFieldIds 测试绑定、规格列未绑判不可证、正文改写)→ 终审 r2 FIX_FIRST(2 条:根判定「父路径不在批内」无判别用例、stranded 兜底无用例且 JSDoc 夸口)→ fix r4 `62a581c8c`(R24a/R24b,M-F/M-J 红)→ **终审 r3 = MERGE,0 blocker**(裁判自跑 11 支 exit 0;宿主层核实 `mapRecordRow` 不补键 ⇒ 规格空串形状在 222 上只由网格手改触发)。两处注释订正 `4a82e8d56`。**#5659 CI 21/21 → 合入 `e74b9c14a`**。

**F8A 收官(合入 `4d95313f9`)**:fix r3 `875ba5319`(目标端事实三处同步 + 两条 target-seam characterization + plugin-attendance overwrite 披露 + rich 两步绕过 characterization + `property` 必传含运行时 arity 检查 + 值面行为变化表)→ **终审 r2 = MERGE,0 blocker**;四处 comment-only 订正 `5b83ea832`;**#5660** CI 第一轮 1 红 = `multitable-richtext-longtext-write-sink.guard.test.ts` 结构守卫把注释里逐字引用的 `UPDATE meta_records …` 当成写点(改措辞 `5b9959146`);第二轮 20.x 真库 lane 2 红 = a18bdd07e 把 `multitable-lossy-retype-revert-realdb.test.ts` 的改类型换成 string→longText,而 config-restore 不把它当 type era 变化,用例前提失效(mock lane 看不见)→ 修正 `aed357b74`:白名单 13 对的目标全集只有 {string, number, longText},没有一对同时满足「PATCH 200」与「live 类型 ∈ BATCH1_FIELD_TYPES」(era 守卫只在 Batch-1 live 类型上执行),fixture 改走已 characterization 的排除集源端缝 attachment→url(破坏性正控重新成立,断言一字未弱化);CI 27/27 → **#5660 合入 `4d95313f9`**。7 条 owner 待办在 PR 正文(对已有数据的列拒绝 → autoNumber;rich ON→OFF 加门;源端/目标端收紧;number→currency|percent|rating 候选放开;0x08 死守卫;order 位移无测试锁)。

**r32(`e74b9c14a` = r31 + F1c + peer #5297,09-12 09:46 上 222)**:备份 `pre-r32-20260912-094650.dump`;维护门 WIRED → 后端直连 attempt 7 → 删 flag → 200;upgrade exit 0;web smoke PASS;F1c 标记 6/6 True;事后错误 0 行。F8A(+F9b)进 r33。

**演示项目 2-20241722.1723 重置(owner 裁决 a,09-12 09:53–09:56)**:改前 1141 行全属该项目,人工列(备注/备料状态/毛胚类型/采购回复/仓库确认)全空 → 无人工数据可丢;r32 语义下对旧行 dry-run = update 287 / inactive 551 / manual_confirm 298(`manual_confirm_required`),证实「不删只重拉」会留下 551 行失效 + 298 行待确认;按裁决:`\copy` 导出 1141 行到 `C:\metasheet\outputackups\demo-project-2-20241722.1723-rows.csv`(另有 pre-r32 pg_dump)→ 事务内 DELETE 1141 → 以 origin/main 版 `stock-preparation-scheduled-pull.mjs --apply`(222 上原 tools-r10 版已过时;定时任务 env 未动)重拉:dry-run ready / add 581 → apply 200。**改后 581 行**(2 根 = 总图 + 钣金,69 个父件,最深 5 层);包列填充:当前组件排序号 581、父组件排序号 579(根无)、名称及规格 581、规格 6(只有名称含空格的);后端错误 0 行。**发现**:包列「父组件图号 / 父组件名称」仍 0 行(规划器只派生三列),父件图号/名称只在英文模板列 Parent Component Code/Name(579 行)里 → 派 **F1c-b**(派生这两列,与模板列同源;`ext_spec` 语义与模板 Component Specification 不同,留 owner)。

**F9b 收官进行中(#5664 草稿,CI 在跑)**:impl `638cfd2a3` → 三轮反驳(2+2 / 2+0 / 2+2)两次修复 → 终审 r1 FIX_FIRST(3 条:message 不 trim 会落空白通知;准入注释理由过期;修复者错误驳回「保存期名册校验可做」且编辑器收件人是自由文本)→ fix r3 `2a1b68ee7`(live/simulate 同判 trim + 用例 + 注释 + 正文 + **222 部署前盘点 SQL**)→ 终审 r2 FIX_FIRST 但唯一 blocker 只在正文(SQL `btrim` 空白集合与 JS trim 不同量,已改 `btrim(x, E' \t\r\n')`)。裁判核实:生产三处 `new AutomationExecutor` 都注入 queryFn(缺 sink 失败关闭是接线错误守卫);收件人边界 = **平台可选人员**(active + 全局 multitable:read/write,与按钮、Person 字段同集合),不是 sheet 成员、不是租户边界;real-fire 试运行到不了写路径;simulate 零库三处门;规则侧无 dedup 账本(重复投递三窗口如实写)。**盘点 SQL 已在 222 只读实跑**:1 条 enabled 规则命中——测试员建在备料主表上的「测试」规则,收件人不在名册内 → F9b 上机后它首次实发的通知步会明确失败(中文文案)、其后动作 skipped;**未动客户规则**,请 owner 知悉。

**F9b(新派,opus + 两路反驳)**:规则侧 `send_notification` 落库到通知中心——根因是全仓没有 `automation.notification` 的监听者,按钮路径已持久化而规则路径 eventBus-only;复用同一 seam `insertRecordSubscriptionNotifications`,成员校验与按钮同量,先写后 emit,模拟不写,表缺失不吞,规则侧不借用按钮的 dedup 表(重复投递语义如实写)。规格 `spec-F9b-rule-notification-persist.md`。

~~**r31 已备好未 build**~~(已上机,见上):wrapper 加 #5651(`EXTERNAL_SYSTEM_SCOPE_MISMATCH` 字面量计数 ≥ 4)/#5654(upgrade-inplace 含 `MaintenanceFlagPath` + `Assert-MaintenanceFlagOutsideReplaceDirs`;事后 flag 不存在)标记,纯 ASCII、0 控制字符;ship 改为上传 `origin/main` 的 `multitable-onprem-package-upgrade-inplace.ps1`(加 BOM;1382 个非 ASCII 字节)替代 tools-r22 旧本;两份脚本本机 Windows PowerShell 5.1 `Parser::ParseFile` 0 错。基线等 F1c/F8A 裁决后定(合入则 main + 两支,否则 `72caae8de`);夜里上机,**不举 flag**(脚本自己举)。

---

## 3. 09-11 测试反馈 9 条:裁定与设计

### 3.1 第 4 条「删行/删表报 Failed to fetch,为什么一直没解决」—— 根因是我

nginx 三天日志:502/reset 只在四个升级窗口成簇,窗口外一条都没有;access.log 里 DELETE 请求总共 3 条、全部 200;两张截图是两个不同前端 bundle = 两次不同升级;测试机在四个窗口里都在线(socket.io 重连 502)。

| 222 本地 | 我做的事 | 502/reset 条数 |
|---|---|---|
| 09-10 16:06–16:08 | r25 | 64 |
| 09-10 18:10–18:11 | r26 | 27 |
| 09-11 10:56–10:59 | r27 | 97 |
| 09-11 15:08–15:09 | r28 | 74 |

处置:流程上立规矩(§1);产品上两件事——前端把网络层错误统一成中文人话并对幂等 GET 有限重试(#5642),升级脚本自己管维护 flag、nginx 对 `/api/*` 在 flag 存在时答 503 + JSON(F4A,在飞)。

### 3.2 老系统逻辑(用户裁决「采用 StockInfoController.java 的逻辑」)

读通 `StockInfoController.java`(3132 行)+ `stockInfoMapper.xml` + `StockInfoMapper.java` + `StockInfo.java` 后,**纠正我先前的「一行一物料」建议**:老系统是**一行一 BOM 树节点**(`parentId` 指父行;同一物料在两个父件下是两行),数量沿路径累乘,与新管线同形。真正的差异四件:

| 老系统 | 新管线 |
|---|---|
| 根:有 `J…-00` 总图取最高版本 + `J…-A/-B` 钣金;无总图取订单行、剔除按图号 dash 分段判为子级的行 | 不按此规则 |
| 同父之下按「父件图号 + 图号 + 名称及规格 + 材质」去重,首条胜出 | 不去重;一个零件两条 active BOM 头时子件重复入行 |
| 深度优先树序,兄弟按明细栏排序 | 导出按随机记录 id;明细栏排序读进内存但无列承接 |
| 名称及规格按第一个空格切「组件名称 / 规格」;导出 23 列固定中文表头 | 无切分;表头英文 |

规格见 `spec-F1c-legacy-bom-port.md`(本轮结束前随 F1c PR 入库)。222 实读发现客户包已有「父组件排序号 / 当前组件排序号 / 备料日期 / 名称及规格」等列但从未被填值——F1c 改为填这些包列,**不再往冻结模板加列**;模板列与包列语义重复的三对(父组件图号/父组件名称/规格)只留包列作人看的那套。

### 3.3 其余 7 条 → wave6 七支(全部 opus,两路对抗,内存级探针)

| 反馈 | PR | 设计要点 |
|---|---|---|
| 5 更多模板只关面板 | #5640 | 跳转成功才关面板;被离开守卫拦下时保留面板 + 提示;cancelled/duplicated 静默;修饰键点击交还浏览器,`href` 由 `router.resolve` 解析 |
| 9 自动化 notify 报 Unknown action type | #5641 | 快捷编辑器不再铸造遗留 `notify/update_field`;`toExecutorRule` 咽喉处把遗留别名归一到 `send_notification/update_record`;无收件人 ⇒ 可操作中文原因(与按钮路由 NO_RECIPIENTS 口径一致);**登记**:规则侧通知不落库到通知中心(另开) |
| 4 前端人话 | #5642 | `api.ts` 网络层错误 → `NETWORK_UNAVAILABLE` + 中性文案「服务暂时不可用,请稍后重试」;仅幂等 GET 重试 2 次带退避;5xx 不重试;502/503/504 文案;500 不变 |
| 8 管理字段两区不能缩放 | #5643 | 水平 splitter(pointer capture + 键盘 + 夹取)+ 放大/缩小切换;高度按浏览器记忆;不抽公共组件 |
| 3 打开项目备料无关字段太多 | #5644 | 插件自有视图 `prep-fill`:隐藏 12 个系统列、按父件分组、排序、`active=true` 过滤;**绝不动 `default`**(三层强制 + 字节级正控);缺失时回退 default;ensure/repair 两腿接线 |
| 2 导出层级乱 | #5646 | 过渡版确定性排序(父件图号 → 明细排序(若存在)→ 图号 → 幂等键);F1c 换成树遍历 |
| 7 存为模板死板 | #5645 | 工作台当前数据表一键存为模板:`sheetIds`/`fieldIds` 下推 SQL、抽取前过滤;类型保真扩到 13 种自洽类型;字段勾选做、改类型不做 |

反馈 8 的另一半(改类型矩阵)拆成三刀:第一刀无损扩表 + **后端权威白名单**(今天后端对改类型零配对校验),第二刀服务端有损预检 + 逐格清单,第三刀真正改写数据;第一刀等 #5643 合入后派(F8A)。

---

## 4. 18:00 批准窗口(用户裁决四项)

| 项 | 做了什么 | 证据 |
|---|---|---|
| nginx 维护门 | conf 备份 `nginx.conf.bak-20260911-180300`;`location /api/` 加 flag 判定 + `@maint` 503 JSON;`nginx -t` OK;nginx 以 SYSTEM 由计划任务 `MetaSheet-Nginx` 启动,reload 用一次性 SYSTEM 计划任务发(零停机) | flag ON → 503 `{"error":{"code":"SERVICE_UNAVAILABLE","message":"服务暂时不可用,请稍后重试"}}`;OFF → 200 |
| r29 上机 | 见 §2.2 | 备份 `pre-r29-20260911-180610.dump` |
| zh-CN 表头 | `app.env` 追加 `MULTITABLE_STOCK_PREP_TABLE_LABEL_LOCALE=zh-CN`(备份 `app.env.bak-zhlocale-20260911-180544`),随 r29 重启加载 | pm2 env 确认 |
| 现表改名 | 主表 `sheet_32df959afa3cecfa564e5486`(54 列 = 33 模板列 + 21 客户包列,1141 行):脚本 dry-run 后 apply,**24 列改中文 ok=24 fail=0**;6 列本已中文;3 列因目标名被客户包列占用而跳过(留 F1c 统一) | 字段 id 一律未动 |
| 演示项目重置 | **未做**,等 F1c 上机后再做(否则重拉仍 1140 行) | — |

---

## 5. 替 owner 定的口径(本轮新增)

| # | 决定点 | 取的默认 | 保守在哪 |
|---|---|---|---|
| 1 | 网络错误文案说不说「升级」 | 中性「服务暂时不可用」 | 不向客户暴露我们在工作时段动过机器 |
| 2 | GET 重试是否也覆盖 503 | 不覆盖,只重试网络层 TypeError | 维护窗口里全体标签页轮询会打爆刚起来的后端 |
| 3 | notify 无收件人 | 显式失败 + 可操作原因,不缺省投递给创建者 | 与按钮路由 NO_RECIPIENTS 硬口径一致 |
| 4 | 存为模板的权限档 | 沿用 canManageFields,不降到 write | 模板带表名与全部字段名,是元数据读面 |
| 5 | 存为模板默认可见性 | private,「共享给本租户」默认不勾 | 同上 |
| 6 | 填写视图隐藏清单 | 用户截图点名的 12 列 | 隐藏只是显示层,不是权限(PR 正文写明) |
| 7 | 改类型第一刀范围 | 只放行可证明无损的方向;不做「→文本」全放行;date→文本不放 | 前者会把 JSON 喷给用户,后者是 ISO 原文的静默劣化 |
| 8 | 改类型的边界放哪 | 后端权威白名单(b) | 否则「我们限制了改类型」这句话站不住 |
| 9 | 老系统 vs 新管线的行身份 | 保持一行一树节点(与老系统同形),不改幂等键 | 改键会让 dry-run revision / hold / 确认账本全部失效 |
| 10 | 模板列与包列重名 | 包列是人看的那套;模板列在填写视图里隐藏 | 不制造同名第二份 |

---

## 6. 验证(截至 19:20)

- wave5/5b 四支:各自两路对抗 + 终审裁判(只读、内存级探针),全部 MERGE 或 FIX_FIRST→修→CI 绿→合。
- r28/r29 两次上机:8 步全过、迁移正常、health 200、web smoke PASS、计划任务试算 `LastTaskResult=0`、升级后错误 0 行;标记用真实文案/testid 复核。
- wave6 七支:40 agents / 0 error;7 树逐一核对(HEAD 匹配、干净、merge-tree 0、无禁改文件、零控制字符);6 支末轮 0 blocker,F1a 终审 MERGE(三处正文订正)。CI 在跑。

- **r30(`f1a5073ee`,09-11 19:26,222 本地)**:备份 `pre-r30-20260911-192625.dump` 2.26 MB;445 文件哈希 OK;迁移 exit 0;health OK(attempt 3);upgrade exit 0;web smoke PASS;计划任务试算 `LastTaskResult=0`;标记 #5640 / #5641 / #5642 / #5643 / #5644 / #5646 全 True(#5645 False = 尚未合入,预期);当前 bundle `index-BcPttObh.js`;`MULTITABLE_STOCK_PREP_TABLE_LABEL_LOCALE=zh-CN` 仍在 pm2 环境;18:00 后后端错误 0 行。这次没举维护 flag(客户工作时段外,且 F4A 未合),脚本自身的 nginx 探测前两次 502(后端重启中)第三次 200。

- **F4A(#5654,升级脚本自管维护 flag)**:两轮反驳(r2 唯一 blocker:举 flag 在 try 之外 → 校验和拒绝后 flag 永久留存 = 站点永久 503,由 fix r2 挪进 try 首句 + 两道守卫修实)→ 只读终审 **MERGE、0 blocker**(镜像三变异全红;PS 5.1 实跑全部新函数;`maintenance.html` 不进包无需登记)。三处一字级措辞照裁判改;第一版措辞把「location /api」字面量写进 server 级注释、契约测试按首个出现定位真实块而红——改词后 35/35 绿。裁判点名的后续小项:conf 两处 `-f` 同根断言、RESTORE 框教再举 flag、`nginx -t -p`、直连探测读 `HOST`。**合入 `72caae8de`**,进 r31。

(本节在窗口结束前继续补:F1c / F8A 的裁决与 r31。)

---

## 7. 未做与原因(截至 19:20)

- **#5625** 仍等用户回 1/2/3。
- ~~演示项目重置~~:已做(见 §2.4)。
- **F8A**:#5660 真库 lane 用例前提修正后重跑 CI → 合入 → r33;**F9b**:工作流在飞。
- **`multitable-context.api.test.ts:1193` 0x08 守卫失效**:等 F8A 合入后单独小 PR。
- **规则侧通知落库到通知中心**:F9 登记的独立项。
- **自动化 `MetaAutomationRuleEditor.vue` 4780 行大文件**:任何同期改动要与 #5641 串行。

---

## 8. 教训(本轮新增)

1. 上机窗口就是投诉来源:四次升级 = 四次「删除报错」。不在客户工作时段上机;上机前举 flag、后端直连健康通过再放行。
2. 升级脚本的健康探测走 nginx 时会被自己的维护 flag 挡住——flag 的删除必须在脚本内、在 nginx 探测之前。
3. 「同名列」是改名脚本的隐形雷:客户包列已经占了中文名,盲目改模板列会造出两份同名列。先盘点、再 dry-run、再 apply,跳过冲突并留档。
4. 老系统的真实语义只能从代码读,不能从字段注释猜:StockInfo.java 的注释写「总数量 = mxNum × 父组件数量」,代码里 `fillBasicStockInfo` 直接取递归累乘后的 quantity;「一个物料一行」是我从 mapper 的一个查询名推出来的错误结论。
