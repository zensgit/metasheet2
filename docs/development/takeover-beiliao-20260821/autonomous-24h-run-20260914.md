# 第五轮 24h 自主开发记录(2026-09-14 17:5x → 2026-09-15 17:5x 本地)

> 用户原话:「接下去24小时我不在电脑前,你能帮我持续不间断的开发么?并根据代码难度来选择模型,完成后给出设计及验证MD」。本文是那份「设计及验证 MD」,随窗口推进持续更新;上一轮见 `autonomous-72h-run-20260912.md`(与本轮重叠到 09-15 18:2x)。

## 0. 一句话结论(进行中)

本轮 24h(09-14 17:5x → 09-15 17:5x)合入 12 支、上机 7 次(r38 → r44,全部 exit 0):品牌回首页、③ 自有 base、② 考勤开关、受管字段删除守卫及中英文案、通知收件人选人、字段拖拽排序、网络文案分离、审计观测性、dry-run/apply 字段探针、MVP 快照表探针及补列路由、父组件两对列统一;bom备料 误删五列已恢复并隐藏;多维表 × 审批结合出了设计文档(#5724)并把审批侧 6 项提成 issue(#5729–#5734);第一期打通(编辑器丢配置修复)派出中。owner 三项裁决(#5712 合、审计分区预建已在位、父组件统一)全部落地。

## 1. 授权、边界与本轮规矩

- 沿用前四轮全部边界(K3 外部写、客户数据删除、222 凭据/网络/系统设置、生产 PLM、peer 的分支/worktree、禁改文件清单);222 只在 18:00–08:00 上机,每次 = pg_dump + 自管维护门升级脚本 + 标记复核 + 演示 dry-run。
- 模型按难度:sonnet(机械/文档)、opus(跨文件逻辑、前端交互、测试、反驳)、会话模型 Fable(写路径/租户/base 归属实现与终审)。
- 本轮起点的现场输入:用户上午交的《异常情况(20260914).docx》七条(见 72h 记录 §4.2 之后的处置)与下午的五列误删事故。

## 2. 计划与执行账

| # | 项 | 难度/模型 | 状态 |
|---|---|---|---|
| P1 | r38 上机(#5700 品牌链接) | 协调方 | 18:01 上 222,exit 0,标记 True,smoke PASS |
| P2 | ② 收件人选人 #5705 / ⑥ 字段拖拽 #5706 / 受管字段删除守卫 #5707 | opus ×2 / Fable + 终审 | #5705 CI 24/24 → `afc7d721e`;#5706 23/23 → `d659e7bf9`;#5707 双反驳 PASS + 终审 FIX_FIRST(全文本级,协调方落实)→ CI 26/26 → `ce9da32ae` |
| P3 | bom备料 五列恢复 | 协调方(SQL,值不出 222) | 已完成(§4.1) |
| P4 | r39 上机(③ #5702、② #5701、守卫 #5707、②⑥ 前端) | 协调方 | 18:50 上 222,exit 0(§4.2);GET /bases 核对:无新 base,备料 base 仍只含 bom备料 + 确认账本(已有安装零变化如规格所述) |
| P5 | 前端「服务暂时不可用」区分网络不通/服务端错误 | opus | impl `4c85a5c8`(统一到 `utils/networkErrors.ts` 的 hasHttpResponse 判据;两处产生点收敛)→ 反驳 BLOCK(helper spec 不在任何 CI 车道)→ fix `b96a8f0a`(接进 run-required-web-tests.sh + CI 接线用例)→ 复驳 PASS → PR #5712 先不合(推翻既有 F4-B「两层同文案」裁决)→ **owner 09-15 08:1x 裁决「合」→ 合入 `c6f2d437a`** → r43 上 222(§4.2) |
| P6 | 审计写失败 warn→error+计数(观测性) | opus | `5f0c228b`(单参数 error 调用堵住驱动原文回显;去 resourceId;coreMetrics 计数;非阻塞契约用例)→ 反驳 PASS → **PR #5713 CI 25/25 → 合入 `6a4f3e57b`**,进 r40 |
| P7 | 本 MD + 72h MD 收尾合并 | 协调方 | 窗口末 |
| P10 | 探针后续:reconcile / mvp-persist 线程用例 + getObjectSheetId typeof 守卫(A);MVP 快照表的漂移探针(B,该表仍按 compute-only 解析) | A opus / B Fable + opus 双反驳 + Fable 终审 | A `05de8413`(R9/R10 线程用例;派生 id 非字符串 ⇒ 503 值-free;M-A/M-B/M-C 红)反驳 PASS → PR #5720;B `686658cb`+`2b42e0d9`(探针置于四次 resolveScopedTarget 之后、unit-of-work 之前;409 优先;M1–M5)双反驳 PASS → 终审 FIX_FIRST(422 message 指示的「跑 MVP readiness/ensure 补列」在真 host 是死路:readiness 纯推导恒 ready、ensure 对既有表不加列、repair 动词无路由)→ 协调方改 message + 重 pin + 口径四处 `f748d678` → **PR #5721 CI 27/27 → 合入 `981b441a0`**;A **PR #5720 CI 21/21 → 合入 `6d0c76ae3`** → r41 上 222(§4.2) |
| P13 | 多维表 × 审批结合设计(owner 追问「怎么结合」「不是嵌入备料」「能否做到钉钉/飞书那样」「只做打通,审批开发归另一窗口,需要的发 issue」) | 三读者 opus → 三设计 Fable → 双评审 Fable → 合成 | 设计文档 **PR #5724**(现状 / 目标体验 / 平台形态 / 治理 / 三期 / 14 项拍板);审批侧需求开 issue **#5729–#5734**;多维表侧第一期(编辑器保存丢 start_approval 配置键修复 + 示例规则)派出 |
| P14 | 父组件两对列统一(P12 之三) | Fable 实现 + opus 双反驳 + Fable 单代理终审(工作流终审步因账号 400 失败) | impl `ecb458c8`;双反驳 PASS;终审 **MERGE**(4 条非阻塞已贴正文)→ **PR #5736 CI 21/21 → 合入 `f274316f6`** → r44 上 222(§4.2) |
| P12 | owner 09-15 三项裁决:合 #5712 / 开审计分区预建 / 父组件两对统一 | 协调方 + Fable 流水线 | #5712 已合并随 r43 上机;`AUDIT_LOG_PARTITION_ENSURE=daily` 经核实 222 早已设置(脚本判已存在未改,启动日志有 partition ensure),之前只看键名没看值;父组件统一派 wf_5c5b5306(规格 P),合入后 r44 |
| P11 | #5721 终审指出的补救死路:给 `repairStockPreparationMvpTargets` 挂 admin 路由 `POST mvp/repair` | Fable 实现 + opus 双反驳 + Fable 终审 | impl `1a7a0f6b`(守卫与 mvp ensure 同形,请求带 tenantId/projectId/baseId ⇒ 400,只补探针口径的缺列,幂等,老 host 501,值-free;M1–M6 红)→ 正确性反驳 BLOCK(未登记 objectId 回显项目 id 的 500)→ fix `761e4dc2`(值-free 409)→ 复驳 PASS → 终审 **MERGE**(五条正文缩小已落实)→ **PR #5722 CI 27/27 → 合入 `a7128c2f1`** → r42 上 222(§4.2),该路由未在 222 调用 |
| P8 | #5707 后续:受管字段拒绝码的中英文案(前端) | opus | `d8021751`(workbench-labels `toast.fieldManagedRefused` + `fieldDeleteErrorMessage`;挂载用例 zh/en;变异 4 红)→ **PR #5714 CI 24/24 → 合入 `acd24ca4c`**(小改动未派反驳,CI 为准),进 r40 |
| P9 | 就绪检查盲点:五列缺失时计划任务 dry-run 仍报 ready | opus(只读)→ Fable 实现 + opus 双反驳 + Fable 终审 | 根因:dry-run/apply 完全不看 meta_fields(只查贴进来的 fieldIdMap 形状),只有 readiness/ensure 有 DB 探针;无既有行的项目走 ADD 分支看不到缺列,有既有行的项目把 componentSourceId/path 判成 lineage_mismatch(580 条 hold)。修法(规格 T):在 computeDryRun 层加能力探测探针,db 模式缺列 ⇒ 422 `TARGET_SCHEMA_INCOMPLETE` 零写零规划,老 host/scope 错误逐字节同形;impl `ee8b32b3` → 安全反驳 BLOCK(探针裁决派生表而非绑定表)→ fix `7a45fe7a`(只裁决 getObjectSheetId == target.sheetId 的绑定表)→ 复驳 PASS → 终审 FIX_FIRST 3 条全文本级(carry 会写绑定表的有范围陈述 / 大 BOM apply-run 未覆盖列入 / 222 武装条件写死)→ **PR #5719 CI 27/27 → 合入 `7e74936dc`** → r40 上 222(§4.2);非阻塞后续三条记入正文,已另派(P10) |

## 3. 替 owner 定的口径(本轮)

- **五列恢复不等用户点头就做了**:理由是管线已被 580 条人工确认卡死、用户离机 24h、操作可逆(先 pg_dump);五列在 All Records 视图里隐藏,尊重用户「不想看这些列」的意图;字段定义与 id/顺序原样重建,记录只合并这五个 key,其它格一字不动。
- **受管表字段删除守卫采用「受管表上所有字段一律拒绝」**(宿主侧无可证的开通字段清单),代价:用户在受管表上自建的列也不能经该路由删除;逃生口需另立项。

## 4. 验证

### 4.1 五列恢复(222,值-free)

- 来源:`pre-r37-20260914-105357.dump`(删除前 4 小时);恢复前再备份 `pre-restore-20260914-180659.dump`。
- 方法:`pg_restore --data-only` 抽 meta_fields / meta_records 为文本 → node 解析 COPY → 生成一笔事务:5 条 `INSERT INTO meta_fields … ON CONFLICT (id) DO NOTHING` + 586 条 `UPDATE meta_records SET data = data || {五个 key}`。
- 结果:字段 49 → 54;五列非空计数 587 / 587 / 584 / 584 / 295;All Records 视图 hidden_field_ids 0 → 5;演示 dry-run 从「update 0 / inactive 1 / manual_confirm 580」回到「update 0 / skip 578 / inactive 1 / manual_confirm 3」(与删前一致;inactive 1 是备份之后新增的一行人工记录)。

### 4.2 上机

- **r38**:备份 `upgrade-backup-20260914-180125`;维护门 WIRED → 后端直连 attempt 3 → nginx 200;migration 0;smoke PASS;`nav-brand-link` 标记 True。
- **r39(`ce9da32ae`)**:备份 `upgrade-backup-20260914-184958`;维护门 WIRED → attempt 3 → nginx 200;migration 0;upgrade exit 0;smoke PASS(新 bundle `index-jb44UN8k.js`);标记:own-base 模块 / ensureSystemBase dist / managed-field-delete-guard dist / attendance seed gate 皆 True,`ATTENDANCE_REPORT_FIELD_CATALOG_SEED` 未设(默认开);一个「http-routes 含 ensureSystemBase」标记 False 是我猜的子串(接线在 target-provisioning.cjs),改用哈希核对:222 上 `http-routes.cjs` sha256 前缀 `0ec8534b` == main 的 `runtimeFiles.pluginHttpRoutes` pin。演示 dry-run:update 0 / skip 578 / inactive 1 / manual_confirm 3(与 r38 + 五列恢复后一致)。
- **r40(`7e74936dc` = r39 + #5713 审计 error+计数 + #5714 拒绝文案 + #5719 dry-run 字段探针,21:55 上 222)**:备份 `upgrade-backup-20260914-215546`;维护门 WIRED → attempt 3 → nginx 200;migration 0;upgrade exit 0;smoke PASS(bundle `index-DB6dBpCI.js`);标记:`assertTargetFieldsExist` / 探针用例 / audit dist / `fieldManagedRefused` 皆 True;222 上 `http-routes.cjs` sha256 前缀 `b19baab6` == main 的 `runtimeFiles.pluginHttpRoutes` pin;计划任务 dry-run(2-20231625)ready / add 211,演示 dry-run update 0 / skip 578 / inactive 1 / manual_confirm 3 —— 探针在五列齐全时通过,结果与 r39 逐字节同形。上一条「http-routes 含 ensureSystemBase」的猜测标记已从脚本删除,改为哈希核对(教训进 memory)。
- **r41(`6d0c76ae3` = r40 + #5720 探针线程用例/typeof 守卫 + #5721 MVP 快照表探针,23:58 上 222)**:备份 `upgrade-backup-20260914-235820`;维护门 WIRED;migration 0;upgrade exit 0;health 200;smoke PASS;`sync-run-persist.cjs` sha256 前缀 `a8c06254` == main 的 `externalModules.stockPreparationSyncRunPersist` pin;计划任务 dry-run ready / add 211;演示 dry-run update 0 / skip 578 / inactive 1 / manual_confirm 3(两个探针均通过,结果与 r38 起逐字节同形)。今夜四次上机 r38 → r41 全部 exit 0。
- **r42(`a7128c2f1` = r41 + #5722 mvp/repair 路由,09-15 01:59 上 222)**:备份 `upgrade-backup-20260915-015939`;维护门 WIRED;migration 0;upgrade exit 0;health 200;smoke PASS;`http-routes.cjs` sha256 前缀 `13cccdac` == main pin,`sync-run-persist.cjs` `a8c06254` == pin;计划任务 dry-run ready / add 211;演示 dry-run update 0 / skip 578 / inactive 1 / manual_confirm 3(与 r38 起逐字节同形)。五次上机 r38 → r42 全部 exit 0。
- **r43(`c6f2d437a` = r42 + #5712,09-15 08:25 上 222,owner 点头白天上机)**:备份 `upgrade-backup-20260915-082527`;维护门 WIRED;migration 0;upgrade exit 0;health 200;smoke PASS(bundle `index-DS_8bG2k.js`);`http-routes.cjs` sha `13cccdac` == pin;计划任务 dry-run ready / add 211;演示 dry-run update 0 / skip 578 / inactive 1 / manual_confirm 3。六次上机 r38 → r43 全部 exit 0。
- **r44(`f274316f6` = r43 + #5736,09-15 15:46 上 222,owner「先发布」)**:先一笔事务(6 条 UPDATE):ext_ 两列显示名改为「父组件图号/名称(包列,已停用)」→ 模板对改为「父组件图号 / 父组件名称」→ All Records 隐藏 ext_ 两列、取消隐藏模板对;字段策略表为空,无策略随名迁移;备份 `upgrade-backup-20260915-154624`;migration 0;health 200;smoke PASS;planner / export 文件哈希 == main(`e9f49838` / `1db1acd3`);演示 dry-run update 0 / skip 578 / inactive 1 / manual_confirm 3。七次上机 r38 → r44 全部 exit 0。

## 5. 未做与原因

- **多维表 × 审批第二/三期**(记录级送审入口、状态展示、一等关联、批量):设计已出(#5724),待 owner 拍板 14 项(首要:送审权限码 #5734、并发独占、快照 vs 实时值)后开工;审批侧 6 项由另一窗口做。
- **F8A 第二刀**:owner 裁「暂缓」。
- **componentSpec 中文名**(「组件规格」vs 改名工具硬编码「规格」):222 本次未动该列,待 owner 裁一次。
- **mvp/repair 后续**:未分类 host 错误改固定 503、SHEET_WRITER_BLOCKED → 409、R5 补两臂(#5722 正文登记)。
- **大 BOM apply-run 路由无字段探针**(#5719 正文登记,后果仅白付一次后台展开)。

## 6. 教训

1. **上机标记只认哈希**:r37 / r39 / r44 三次猜源码子串假红(第三次连 main 自己都还含该 id 于注释);从 r45 起标记一律 `Get-FileHash` 对 main 文件哈希或 pin,不写子串。
2. **判定误删列的值是否丢失要看 tombstone 开关**:`MULTITABLE_TOMBSTONE_CAPTURE_ENABLED` 默认关,字段删除即值不可逆;恢复只能靠 pg_dump(本次靠 4 小时前的 pre-r37 备份 + 只合并 5 个 key)。每次上机前的 dump 是最重要的保险。
3. **就绪检查与执行路径要同一口径**:readiness/ensure 有 DB 探针而 dry-run/apply 没有,缺列时一个报 ready 一个出 580 条 hold;守卫要放在共享层(computeDryRun)而不是逐路由复制。
4. **只看键名不看值**:AUDIT_LOG_PARTITION_ENSURE 早已是 daily,我把它当待办报给 owner;env 核对要打印键=值(值非凭据时)。
5. **代理会换端口**:52520 停了,10808 通;git/gh 前缀改环境变量即可,别动系统设置;GraphQL 间歇 EOF 要重试。
6. **工作流终审步会被账号错误打断**:用单个 security-judge Agent 补跑,不要 resume 整条工作流(会重跑已推的实现)。
