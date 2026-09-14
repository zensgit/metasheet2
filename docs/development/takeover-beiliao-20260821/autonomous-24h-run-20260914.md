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
| P5 | 前端「服务暂时不可用」区分网络不通/服务端错误 | opus | 待派 |
| P6 | 审计写失败 warn→error+计数(观测性) | opus | 待派 |
| P7 | 本 MD + 72h MD 收尾合并 | 协调方 | 窗口末 |

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
- **r39(`ce9da32ae`)**:备份 `upgrade-backup-20260914-184958`;维护门 WIRED → attempt 3 → nginx 200;migration 0;upgrade exit 0;smoke PASS(新 bundle `index-jb44UN8k.js`);标记:own-base 模块 / ensureSystemBase dist / managed-field-delete-guard dist / attendance seed gate 皆 True,`ATTENDANCE_REPORT_FIELD_CATALOG_SEED` 未设(默认开);一个「http-routes 含 ensureSystemBase」标记 False 是我猜的子串(接线在 target-provisioning.cjs),改用哈希核对:222 上 `http-routes.cjs` sha256 前缀 `0ec8534b` == main 的 `runtimeFiles.pluginHttpRoutes` pin。演示 dry-run 见下。

## 5. 未做与原因

(窗口末填。)

## 6. 教训

(窗口末填。)
