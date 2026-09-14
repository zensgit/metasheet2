# 第五轮 24h 自主开发记录(2026-09-14 17:5x → 2026-09-15 17:5x 本地)

> 用户原话:「接下去24小时我不在电脑前,你能帮我持续不间断的开发么?并根据代码难度来选择模型,完成后给出设计及验证MD」。本文是那份「设计及验证 MD」,随窗口推进持续更新;上一轮见 `autonomous-72h-run-20260912.md`(与本轮重叠到 09-15 18:2x)。

## 0. 一句话结论(进行中)

(窗口结束前填。)

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
| P5 | 前端「服务暂时不可用」区分网络不通/服务端错误 | opus | impl `4c85a5c8`(统一到 `utils/networkErrors.ts` 的 hasHttpResponse 判据;两处产生点收敛)→ 反驳 BLOCK(helper spec 不在任何 CI 车道)→ fix `b96a8f0a`(接进 run-required-web-tests.sh + CI 接线用例)→ 复驳 PASS → **PR #5712 已开、不合**:它推翻了既有 F4-B「两层同文案」裁决,等 owner 决定 |
| P6 | 审计写失败 warn→error+计数(观测性) | opus | `5f0c228b`(单参数 error 调用堵住驱动原文回显;去 resourceId;coreMetrics 计数;非阻塞契约用例)→ 反驳 PASS → **PR #5713 CI 25/25 → 合入 `6a4f3e57b`**,进 r40 |
| P7 | 本 MD + 72h MD 收尾合并 | 协调方 | 窗口末 |
| P10 | 探针后续:reconcile / mvp-persist 线程用例 + getObjectSheetId typeof 守卫(A);MVP 快照表的漂移探针(B,该表仍按 compute-only 解析) | A opus / B Fable + opus 双反驳 + Fable 终审 | A `05de8413`(R9/R10 线程用例;派生 id 非字符串 ⇒ 503 值-free;M-A/M-B/M-C 红)反驳 PASS → PR #5720;B `686658cb`+`2b42e0d9`(探针置于四次 resolveScopedTarget 之后、unit-of-work 之前;409 优先;M1–M5)双反驳 PASS → 终审 FIX_FIRST(422 message 指示的「跑 MVP readiness/ensure 补列」在真 host 是死路:readiness 纯推导恒 ready、ensure 对既有表不加列、repair 动词无路由)→ 协调方改 message + 重 pin + 口径四处 `f748d678` → **PR #5721 CI 27/27 → 合入 `981b441a0`**;A **PR #5720 CI 21/21 → 合入 `6d0c76ae3`** → r41 上 222(§4.2) |
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

## 5. 未做与原因

(窗口末填。)

## 6. 教训

(窗口末填。)
