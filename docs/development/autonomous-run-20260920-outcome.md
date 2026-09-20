# 第七窗口接管日（2026-09-20）产出与验证总结

来源：`autonomous-24h-program-20260909.md` 账本「## 第七窗口」段（2026-09-18 19:00 起至文件末尾）。本文只转述该段落已记录的事实，账本未写明的细节一律标注「未记录」，不做推断或补全。

状态：**已定稿**（16 支 PR 全部合入 main，末次合并提交 `123b1d1e5`）。

---

## 1. 窗口事实

- **原计划**：第七窗口 36h，2026-09-18 19:00 → 09-20 07:00（本地）。
- **授权原话**（09-18 18:5x）："接下去36小时我不在电脑前，你能帮我规划计划并进行持续不间断的开发么？请根据代码难度来选择模型，完成后给出设计及验证MD" + "请建立机制，若5小时内用量到了后，请自动根据时间来激活开发"。
- **机制**：心跳 `c823bf9f`（每小时 `:23`，按墙钟点火，429 期间失败不影响下一次；限额一恢复即从账本续）。
- **合并权**：本窗口开工时只对 owner 已授权的 #5593/#5594/#5691/#5783 生效（门槛 pend=0 且 red=0；查询失败≠红）；本窗口新开 PR 一律不合。**并发 ≤2**。
- **窗口实际只跑了 54 分钟**：09-18 19:07 开工 → **20:01 起 API 返回 `400 当前绑定账号暂不可用`**，此后每一次整点心跳（20:01、20:46、21:46 … 直到 09-19 14:46 本地，共 20 次）全部同样报错，无一次成功。
- 09-20 08:23 用户手动 continue，改报 `400 此 session 已绑定另外的ai账号，请执行/new 开启新 session` → **旧 session `5691483c` 永久不可 `--resume`**，本条及以后由新 session 接管（交接件 = 本账本 + 旧 jsonl + worktree 残件）。
- 教训已写入 `[[session-rate-limit-stalls-autonomous-loop]]`：心跳必须无条件追加账本行，否则"没事干"与"每次都 400"无法区分。

**接管时实测状态（09-20 08:3x）**：
- main：窗口死时 `edd1b072a` → 接管时 **`868c8d2b2`**（同伴 Codex 合了 95 个提交）；主检出已 ff（原停在 `79dbc6588`，落后 398）。
- 我方 OPEN 五支，git 层全 MERGEABLE：#5786(`96d7e863d`, CLEAN, 21/0红)、#5870(`bc3c96fa2`, CLEAN, 21/0)、#5871(`746f01503`, CLEAN, 25/0)、#5876(`b36d23491`, CLEAN, 26/0)、**#5877(`c9da9aca5`, UNSTABLE, integration-guard 红)**。
- worktree 残件：wt-w7b 有未提交产出（M `DataSourceManager.ts` + 未跟踪设计文档 + 迁移 `zzzz20260918120000_data_source_live_id_binding_lock.ts`，HEAD 仍 `edd1b072a`）；wt-w7a3 零产出。
- 磁盘 C: 余 14G；worktree 80+ 支待回收（非阻塞）。

**接管日收口**：接管日合计 **16 支 PR 合入**（5 存量 + 7 舰队 + 4 第二批），末次合并 main = `123b1d1e5`。其中 **#5896 含 DDL（数据库迁移），部署顺序须先迁移后发版**。

---

## 2. 队列校准（8 路只读侦察，09-20 09:1x）

**侦察 8/8 返回**（`wf_53b6ea10-c9d`，1.02M tokens，41 分钟）：队列全部 valid，无一项被 main 的 95 个提交推翻或做掉。关键发现：

1. **#5877 红根因** = 登记行追加在 `test-chain.txt` 末尾撑破 S4/S5/S6-A 尾窗（`sealed-export-s4-generation-migration.test.cjs:278`），一行位移即修，但**813 行新测试因 fail-fast 从未在 CI 跑过**。
2. **W7-B 残件对 main 零冲突**，拆 PR-A（删除侧事务化，无门）/ PR-B（live_id FK 迁移，**改 force 语义，待 owner 三选一**）。
3. **W7-F 是真 bug**：纯改名保存即退役 legacy 标记并删 `config.dataSourceId`（`external-systems.cjs:736-743` + `IntegrationWorkbenchView.vue:2309/2445`）。
4. **W7-C pin 竞争空窗**（60 个 OPEN PR 零个改 `http-routes.cjs`）。
5. **W7-D 批次 2 = 5 条，不动 `/slo/status`**（#5680 未合的反向对照）。
6. **四支在飞 PR 零语义漂移**，#5871 文案合裁决。

---

## 3. 产出清单

范围：#5871、#5876、#5870、#5786、#5877、#5883–#5889、#5894、#5895、#5896、#5897（共 16 支）。

| PR | 项 | 模型 | 改了什么（一句） | 验证证据 | 反驳结论 | 合并提交 sha |
|---|---|---|---|---|---|---|
| #5786 | F3/F4/F5 修正 + 合成 PG 验证 | opus | JSON 语义匹配替代脆弱模式匹配、计数与 ID 共用 hit CTE、`_preamble`+`\gset`/`\if` 自动分派 + `INVENTORY_RESULT` 完成态；**仍未上任何真实库** | 便携 PG16 两 schema×正反例表 + 锁超时/无权限→incomplete 实证 + 三变异各红 | 账本第七窗口段未记录独立复核结论；url 键名白名单待 #5619/#5649 作者对齐 | `34b64102c` |
| #5870 | GOV-05 | 未记录 | 账本第七窗口段仅记"revision 一次性抖动"，具体改动内容未在本段展开 | CI 21/0 | owner 裁决：revision 抖动 = 接受、原样合 | `eb0ab8e03` |
| #5871 | TRG-02 UI 会话提示收尾 | sonnet | 账本第七窗口段仅记项名（TRG-02 UI 会话提示），未展开代码细节 | CI 25/0 | 侦察判定"零语义漂移"；#5871 文案合裁决 | `f766ab5b9` |
| #5876 | W7-A1 场景 B 合成 BOM 经 sql-readonly 只读源全链读通 | opus | 54 行合成 BOM 夹具经既有 `data-source:sql-readonly` 只读源跑通读取 | 只读/权限/跨主体/项目域四断言绿、四变异红；`.gitattributes` 加夹具 LF 规则（不在 pin 集，provenance 绿） | 已知盲区"悄悄钳制的源抓不住"以断言钉住，需 owner 裁是否在 A2 前消（账本未见后续裁决） | `e003eead5` |
| #5877 | W7-A2 场景 B 源运行结果落备料 staging | opus（原实现）+ sonnet（test-chain 位移修复） | 零业务代码，813 行新测试 + test-chain 登记 1 行 + 设计/验证文档；落库链已接线（http-routes → bridge → persist） | 三守卫变异转红 3/3；813 行新测试首次执行即全过；CI 21/0 | 侦察定位红根因 = 登记行位置撑破尾窗，非代码问题；rebase（`244bce724`）后 MERGEABLE | `d4d295160` |
| #5883 | W7-F legacy 绑定退役条件收窄 | opus | 纯改名保存此前会误退役 legacy 标记并删 `config.dataSourceId`，改为仅生效指针变化时触发 | 5 变异全红 | refuter pass（0 blocker / 7 non-blocker：工作台真实 payload 形状未钉、`.trim()` 变异存活但无害） | `9125e8716` |
| #5884 | W7-D1 ADM-05 批次 2 | opus | 读侧 5 条端点补 `requireAdminRole` | CI 绿 | refuter pass（0 blocker / 6 non-blocker：`/health/summary` 仍无门归批次 3、403 路径每次写审计属批次 1 既有形状） | `5c4171853` |
| #5885 | W7-E GOV-02 源码清理 | sonnet | 移除零引用的 `DataMaterializationService`/`WorkflowRepository`/`BaseRepository` 源码；不动 migration、不删表 | tsc/build 绿 | 未纳入本轮 5 项保证型复核清单（B-A/C/D1/D2/F），账本未记录对抗复核 | `49dd72b08` |
| #5886 | W7-D2 ADM-18 限流 Map 过期与上限 | opus | protection-rules 限流表加过期回收与容量上限（#5710 已合解锁） | CI 全绿 0 红 | refuter pass（0 blocker / 9 non-blocker：满桶 fail-open 需一万主体才可诱发） | `279949ca9` |
| #5887 | W7-C SC-04 `GET /api/integration/runs/:runId` | fable | 新增单条运行读取路由；`pluginHttpRoutes` pin 已重算 | 11 变异全红 | refuter pass（0 blocker / 8 non-blocker：`/NotFound/` 宽匹配把 scopedInput 圈进 try，当前不可触发） | `980362303` |
| #5888 | W7-A3 场景 B 页面验收 | sonnet | 只加读路径验收测试（阶段总览 + 批次详情渲染/空态/错误态），不改源码；基于 main 不叠 A2 | CI 全绿 0 红 | 未纳入本轮 5 项保证型复核清单，账本未记录对抗复核 | `19cb18f85` |
| #5889 | W7-B-A 删除侧引用检查与软删合入同一事务并持行锁（#5784 保留②第一刀） | fable | `removeDataSource` 事务化 + `FOR UPDATE`，三份 fake db 补 transaction/select/forUpdate | 七变异全红（无事务/去 FOR UPDATE/count 走 this.db/count 提前/409 翻 500/先写后数/…）；19 文件 350 用例绿、tsc 0 | 1 blocker（fake db 不钉锁的表名）→已修（`0648eb26c`：assertKnownTable + ops 带表名 + 三份 fake 同严格，源码零改动）；CI 29/0/0 | `6ea19e2de` |
| #5894 | W7-G #5786 白名单收窄（TRG-04） | opus | http 目标白名单 7 键收窄到只剩 `url` 且钉死三条真实读取路径，宽口径降为 upper_bound 参考列 | 合成 PG 两 schema 9/9、三变异各红 | 账本第七窗口段未记录独立对抗复核（未列入 5 项保证型清单） | `5a81dbeb4` |
| #5895 | #5887 前端接线：工作台运行详情 + openapi 契约 | opus | openapi 新增 `/api/integration/runs/{runId}`、`workbench.ts` `getIntegrationRun`、监控区行内详情面板 | 5 变异各红；实证 `vue-tsc --noEmit` 假绿机制（真证据需 `vue-tsc -b`） | 账本第七窗口段未记录独立对抗复核 | `866ddd422` |
| #5896 | W7-B PR-B live_id 生成列 + 绑定 FK 改指 live_id，取消 force 强删（#5784 保留②第二刀） | fable | 迁移新增 `live_id` STORED 生成列 + 唯一索引，FK 改指 live_id（RESTRICT, NOT VALID），取消 force 语义 | 便携 PG16.9 32/32、四变异各红、core-backend 109/109 + tsc 0 | 1 blocker（openapi 改源未重生成 dist-sdk 会致 CI test(20.x) 必红）→已修（`d009dacc2`）；CI 32/0 | `123b1d1e5` |
| #5897 | ADM-05 批次 3 | opus | `/safety/status`、`/ratelimits`、`/ratelimits/:key`、`/health/summary` 四条补 `requireAdminRole` | 25 例 spec 含闭世界断言、四路逐条 passthrough 变异各红；相邻 14 文件 195 例绿、tsc 0 | refuter pass 0 blocker | `9b0ec1f9b` |

---

## 4. owner 三次裁决原话

**裁决 1（09-20 01:38，AskUserQuestion 原话）**：
> force 语义 = ① 取消 force（有引用即删不掉，DB 兜底）→ W7-B PR-B 解封；#5870 revision 一次性抖动 = 接受、原样合；合并授权 = 五支全部（#5877 绿后）。

**裁决 2（09-20 03:06，账本记录的 owner 授权，非逐字引用）**：
> owner 授权：舰队 7 支全合（#5884/#5889 以反驳 0 blocker 为前提）；下一批 = W7-B PR-B（live_id FK 迁移 + 取消 force）+ ADM-05 批次 3 + #5887 前端接线（工作台 + openapi）。先合 5 支已清（#5883/#5885/#5886/#5887/#5888），派 PR-B(fable)；批次 3 等 #5884 合后派（同文件 admin-routes.ts）；前端接线等 #5887 合后派。

**裁决 3（09-20 06:56，账本记录的 owner 授权，非逐字引用）**：
> owner 第二批授权：全部 4 支（#5896 以 CI 绿为前提，已满足）。合并顺序 #5894 → #5897 → #5895 → #5896（后两支同改 openapi dist 生成物，若 #5896 变 CONFLICTING 则 rebase + 重生成 dist/dist-sdk 再合）。

---

## 5. 环境与流程教训

- **出网中断与 502**：09-20 02:09 起 GitHub 出网中断（127.0.0.1:10808 监听在但上游 000，socks5h 同端口 000，52520 已无监听，直连 000）。断网期间不合并、不推送；两路反驳（refute:W7-D1、refute:W7-B-A）死于 API 502（reclaude gateway 不可达）。02:36 出网恢复（探针 200）后 resume 工作流只重跑这两路，续跑 W7-G 代理、重新武装舰队 CI 监视。
- **`vue-tsc --noEmit` 假绿机制**：`apps/web/tsconfig.json` 是 `files:[]` + references 桩，`--noEmit` 什么都不查（注入 `getIntegrationRun(42)` 仍 0 行退出 0）；真证据是 `vue-tsc -b` / `pnpm --filter @metasheet/web run type-check`（#5895 实证）。
- **psql GBK**：psql 按控制台代码页取 GBK 致 UTF-8 夹具炸（#5894），`run-verify.mjs` 已 pin `PGCLIENTENCODING=UTF8`。
- **`%TEMP%` 下文件在跑中被删**：#5894 验证期间便携 PG 二进制在跑中消失，账本明确"原因未查——不是我的回收脚本（只动 dev/metasheet-wt-*）"。
- **worktree junction 安全回收流程**：批量回收 28 支 MERGED worktree 的做法 = 外指 junction 逐个用 .NET `Directory.Delete` 只拆链接 → 核对主检出四处 `node_modules` 计数不变 → `rmdir /s /q` → `prune`；流程已写入 `[[git-worktree-remove-follows-junctions]]`。
- **test-chain 尾窗**：#5877 CI 红的根因是登记行追加在 `test-chain.txt` 末尾撑破 S4/S5/S6-A 尾窗（`sealed-export-s4-generation-migration.test.cjs:278`），一行位移即修；813 行新测试因 fail-fast 此前从未在 CI 真正跑过。
- **CRLF 假红**：本机 `sealed-export-s4-generation-migration.test.cjs:302` 红在 main 主检出同样红 = Windows 假红（W7-F 代理实证根因：`core.autocrlf=true` 的 CRLF 检出让 `scripts/ops/ci-realdb-step-contract.mjs:684` 的解析失配），以 CI 为裁判。

---

## 6. 残余与未覆盖

- **#5896（DDL）登记未覆盖**：legacy 形态无 FK；admin bulk `DELETE`/`PUT` 撞新 FK 落裸 500（非本刀引入）；23503 宽口径无绊线。
- **#5786 已合 ≠ 生产执行**：执行仍待 owner 单独一次性批准；白名单收窄（T 层默认前进）已另开小 PR（即 #5894，已合）。
- **#5876 已知盲区**：sql-readonly 契约下"悄悄钳制的源抓不住"，靠断言钉住，需 owner 裁是否在 A2（#5877）前消——账本未见后续裁决，A1/A2 均已合入，此问题状态未在账本中明确关闭。
- **#5884 refuter non-blocker**：`/health/summary` 仍无门归批次 3（已由 #5897 覆盖）；403 路径每次写审计属批次 1 既有形状（未处理，非本刀引入）。
- **#5883 refuter non-blocker**：工作台真实 payload 形状未钉、`.trim()` 变异存活但无害。
- **#5886 refuter non-blocker**：满桶 fail-open 需一万主体才可诱发。
- **#5887 refuter non-blocker**：`/NotFound/` 宽匹配把 scopedInput 圈进 try，当前不可触发。
- **#5897 残余**：三条 500 分支 `err.message` 回显未脱敏（独立决策点）；`#5678` 盘点表待更新；`admin-api.yaml` 无 securitySchemes 一致性，账本记"另开"；闭世界断言"admin-routes 下无门 GET 恰为 `['/slo/status']`" 依赖 `#5680`（OPEN）合入后补一行 PR 加门并翻反向对照。
- **W7-B 三侧持久化锁协议**：账本原始定义为"创建/重绑/删除三侧"；#5889 自称"保留②第一刀"（删除侧事务化 + FOR UPDATE），#5896 自称"保留②第二刀"（live_id 生成列 + FK 改指 + 取消 force）。账本未有一条明确记录"三侧协议已全部收口"，是否还有创建/重绑侧的独立锁工作，留待下一窗口核对。

---

## 7. 下一步候选（账本中出现过的）

- `#5680`（`/slo/status`）合并后，触发 `#5897` 一行 PR 加门，并翻转其闭世界反向对照断言。
- `#5678` 盘点表待更新（`#5897` 残余）。
- `admin-api.yaml` 无 securitySchemes 一致性问题，账本记"另开"。
- `#5786` 生产执行仍待 owner 单独一次性批准（已合入 ≠ 生产执行）。
- 核对 W7-B（`#5784` 保留②）"创建/重绑/删除三侧持久化锁协议"是否已随 `#5889`+`#5896` 两刀全部收口，或仍有遗留侧未做（见 §6）。
