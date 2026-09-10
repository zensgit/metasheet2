# 集成层页面整合与差距收敛 —— 24h 自主开发程序报告（2026-09-09 18:30 → 2026-09-10 18:30）

> 用户离机 24 小时前授权："自动规划并计划开发，完成后给出设计及验证 MD，根据代码难度自动规划模型，遇额度问题暂停到期后自动继续"。本文是程序总报告：计划、模型分派、每项的交付物与验证证据、对抗复核裁决、额度中断记录、遗留与合并顺序。**终态（09-10 15:07）：10 个 PR 全部正式、CI 全绿、各带设计/验证文档。****所有 PR 均未合并**（合并只认用户明说）；222 未动。

## 1. 结果一览

| # | 项 | PR | 状态 | 复核形态与裁决 | 设计 / 验证文档 |
|---|---|---|---|---|---|
| A | 外接数据源页并入数据工厂「连接管理」分区；`/data-sources` 改重定向；工作台 `#分区` / `?section=` 落点；导航删项；向导①链接按 `integration:write` 门渲染 | **#5587** | 正式，CI 全绿（25 项，补文档后复跑亦绿） | 3 查找 → 每条 2 反驳 → 终审（44 代理）："修完 4 项再转正式" → 已修（注释诚实性、向导①门、标题接缝、同页删源清悬挂草稿）+ 3 项后续 | `data-sources-fold-into-workbench-{design,verification}-20260910.md` |
| B | 备料错误码目录补 `SOURCE_UNAVAILABLE`（503 源库不可达）+ 交付指南一行 | **#5588** | 正式，CI 全绿 | 我直接复核 diff（目录条目 + 文档，低风险） | `stock-prep-codehelp-source-unavailable-{design,verification}-20260909.md` |
| C | 数据源列表「被引用 N」列 + 删除前提示；后端列表/详情带 `referenceCount`（一次分组计数，不 N+1） | **#5593**（base = #5587） | 正式，CI 全绿（14 项） | 2 查找 → 双反驳 → 终审（19 代理）："修完 3 小项再转正式" → 已修（文案去绝对化、计数失败记 SQLSTATE 的 warn、文档基线） | `data-sources-reference-count-{design,verification}-20260910.md` |
| D | 备料向导①拆 ①a 登记外接数据源 / ①b SQL 绑定；`/stock-prep` 导航与路由门改走工作台谓词（修掉双向分歧） | **#5594**（base = #5587） | 正式，CI 全绿（14 项，含浏览器验证） | 2 查找 → 双反驳 → security-judge（23 代理）："修完再转正式" → 已修（必过 spec 六步→七步、浏览器夹具补新读、F06 旧式桥接部署不误导、DataSourceRegistry 进必过清单、①a 对无 `data_sources:read` 指明缺码） | `stock-prep-wizard-split-and-gate-alignment-{design,verification}-20260910.md` |
| E | G4 结构化强制第一刀 M2：适配器装载去掉 credential-stripped 公共投影回退，硬依赖 `getExternalSystemForAdapter` | **#5590** | 正式，CI 全绿（28 项） | 3 查找 → 双反驳 → security-judge（24 代理）："生产代码严格强于 main；修完测试/脚本/文档再合" → 已修（结构 allowlist 边界匹配 + 名册扩到 `listExternalSystems`/`getExternalSystemAdapterConfig` + 反假绿 control + 探针加载自检；`lib/` 未动） | `integration-g4-structural-enforcement-m2-{implementation,verification}-20260910.md` |
| F | SQL 源接入验收脚本（九步正例 + 负例）+ 交付指南「升级后必查」挂脚本 | **#5576** | 正式，CI 全绿（27 项） | 两次 CI 红都是 pin：`EXPECTED_OPS_TESTS_COUNT` 48→62、`pluginTestsWorkflow` 溯源 pin 重算 | 契约测试 + 交付指南段落（脚本本身早于本程序） |
| G | 数据工厂页面布局与功能差距分析（对标飞书 aPaaS 连接器 / n8n / 数环通） | **#5592** | 正式，CI 全绿 | 5 读图 → 9 视角（75 原始）→ 去重 58 → 46 条各过反驳者 → 批评者补 4 → 综合（71 代理）：**37 条成立、17 条驳回**，原 10 条 P0 只剩 G02 | `docs/research/data-factory-page-and-capability-gap-analysis-20260910.md` |
| I | 差距 G27：清洗映射转换/校验 UI 对齐引擎全集（toDate / defaultValue / concat / 转换链 / 映射级默认值 / pattern / enum），后端零改动 | **#5596** | 正式，CI 全绿（24 项） | 2 查找 → 双反驳 → 终审（25 代理）："修完 F06 再转正式" → 已修（concat 无 schema 回退框改绑本地草稿）+ 后续 5 项（有损项登记、参数优先级照抄引擎、默认值文案、行号报错、存库→回读→引擎整链用例） | `integration-mapping-transform-ui-parity-{design,verification}-20260910.md` |
| J | 差距 G10：主链路不再推销 K3 写回——文案改口、写禁码进人话码表、K3 目标不渲染 Save-only | **#5597** | 正式，CI 全绿（考勤守卫因 runner 的 vitest worker RPC 超时红过三次，第四次重跑绿；本地按 CI 同款命令对拍 main 与分支同为 Windows 既有 5 条噪音、其余 1285 例绿） | 2 查找 → 双反驳 → 终审（29 代理）："修完再转正式"，含一条 blocker → 已修（/run 路径写禁码实际在 `error.details.code`，前端兜底并用服务端真实形状重写测试；K3 预设页执行控件按栅栏门撤掉、dry-run 保留；私有解析器改共享；`K3_WISE_REPLAY_DISABLED` 登记；文档绝对句撤回） | `integration-k3-writeback-copy-and-codes-{design,verification}-20260910.md` |

**建议合并顺序**：#5576 → #5588 → #5592 → #5590 → **#5587 → #5593 → #5594**（后两支以 #5587 为 base，GitHub 会在 #5587 合并后自动改 base）→ #5596 → #5597（两支与 #5587 都碰 `IntegrationWorkbenchView.vue` 的不同区域，合并第二支时可能要 rebase 解小冲突）。

## 2. 模型分派（按代码难度）

| 难度 | 模型 | 用在 |
|---|---|---|
| 机械改动、目录条目、文档收尾、pin 重算 | sonnet（impl-easy） | B；C 终审三小项；D 文档订正收尾；A 补文档 |
| 跨文件逻辑、守卫/租户/权限代码、变基解冲突、安全敏感实现 | opus（impl-hard） | A 实现与终审修复；C；D；E；I；J |
| 对抗反驳（只读） | opus（refuter） | 每个 PR 的反驳者；差距分析 46 条核验 |
| 查找、综合、安全终审 | Fable（主模型 / security-judge） | 差距分析九视角与综合；六个 PR 的终审；程序编排 |

复核形态统一为"查找者 → 每条发现两个反驳者（代码证据 / 重要性，任一推翻即驳回）→ 终审"，终审对每条保证回答"证据在哪、去掉守卫哪个测试会红、仍可能的漏法、被错误驳回的、所有视角都没看的一条路径"。六次终审全部给出"修完 X 再转"而非直接放行，X 全部在同一 PR 内落地。

## 3. 差距分析结论（摘要，全文见 #5592）

- 一句话：后端已经是"受治理的企业级集成"骨架（凭据加密、values-free、租户门、K3 写栅栏、引用守卫、溯源与死信），页面把它摆成一张 5000 行长卷——能力有一半到不了 UI，术语不收口、失败不可见、触发接不上。差距不在"连接器不够多"，在"把已有能力交到实施工程师手里"。
- 唯一 P0：G02 连接只有 owner 私有一种作用域（minimal-plan PR-2 正题）。
- 最大单点：G04 平台触发器与管道之间没有绑定端口 + G06 同步运行无取消 + G07 失败零告警（同一实现，minimal-plan §6.1）。
- "后端有、前端锁死"一族（约 8 条）是 S/M 工作量、零后端改动的最高性价比——本程序第三波的 I（G27）、J（G10）即取自此。
- 不追：连接器广度 / SaaS 目录、通用写回、n8n 式画布、Bridge 远程 fleet（维持 2026-07-03 对标结论）。

## 4. 额度中断记录（三次，均自动恢复）

| 时刻（本地） | 现象 | 处理 |
|---|---|---|
| 09-09 19:40 | sonnet/opus/Fable 子代理全部 429（reset 21:00） | 主循环也被限，心跳到 09-10 08:14 才醒；醒后 resume 两个工作流、SendMessage 恢复中断代理 |
| 09-10 09:35 | opus 429（reset 13:00） | 主循环仍可用：自己写差距报告初稿、提交 fold 修复、推 PR；13:00 前 sonnet 探针成功即提前恢复 |
| 09-10 13:10 | opus 429（reset 14:20） | D 由 sonnet 收尾（不再恢复 opus 上下文，避免两套上下文打架）；I、J 等用户在线告知恢复后 SendMessage 续做 |

教训：中断代理的"最后一句话"不代表进度（E 的通知写"刚开始读"，工作区已有 15 文件改动）——先看 `git status` 再决定恢复方式。

## 5. 遗留与下一步

**本程序刻意不做**：G09 权限码种子化（要加迁移，边界内不改迁移）；G01 状态条 sticky（与 #5587 冲突面大，等它合并后做）；G56 / G34 后端项（撞 `http-routes.cjs` 溯源 pin 与 #5590）；C 的 3 秒查询预算（fake timers 与 pinned server 不兼容，见验证记录 §5）。

**终审留下的后续**（各 PR 描述里有清单）：#5587 落点二次补偿已做、连接/死信级寻址未做；#5593 真库 realdb 用例、去看绑定的落点精度；#5594 App nav 行为 pin、222 上核 `data_sources:read` 归属；#5590 M1/M3 该看的相邻可选守卫（`pipeline-runner.cjs:615-617`、`http-routes.cjs:4149-4150`）；#5596 flags/message 有损、G08 回读接线。

**第二波候选（差距报告 §5）**：G09、G01、G29、G34/G35、G36、G21、G18、G17、G54、G56、G42、布局第一刀（active-section 模式 + DOM 顺序 = rail 顺序 + 三套步骤模型收敛）。

**同机另一 Claude 会话**（"备料系统数据库插件评审 (2)"）在同一授权下负责编辑器类三支与 222 部署；已互相确认范围不交叉，并提醒其"N 列"改动落在 `DataSourcesPanel.vue` 而非将被薄壳化的 `DataSourcesView.vue`。

## 6. 数字

- PR 9 个（不含本报告 #5601）；代码 +10,430 / −1,167（不含差距报告）；设计/验证文档 14 份 + 研究报告 1 份。
- 子代理：实现 9 次、收尾 4 次；复核工作流 6 次（19–44 代理/次）；差距分析 1 次（71 代理）。
- 变异探针（内存改写、不落盘）：A 16、C 14、D 6、E 12+、I 5、J 9，全部让具名测试变红或按预期保持绿。
