# 第十次无人值守窗口（开发机）开发与验证总结 — 2026-09-25 19:24 → 2026-09-28 08:18 UTC

> values-free：本文不含主机地址、口令、令牌。时间一律 UTC（开发机本地为 UTC+8）。
> 本文只写**已证明的事实**：不写「零 blocker / 根治 / 收官 / 验收完成」。合成演练、假源见证、只在本地执行的见证，都按其实际范围标注。

## 1. 窗口与规则

- 授权：用户 09-25 起离机，要求无人值守开发；09-26 与 09-27 两次各续 24h，窗口合计约 61h。
- 模型分派（用户要求「按代码难度选模型，Fable 5.1 额度到了用 Opus 5.5」）：Fable 5.1 = 最难实现（并发/锁协议/跨模块边界）+ 保证型终审；Opus 5.5 = 跨文件/守卫实现与执行型核验；Sonnet = 文档/机械/测试补钉。Fable 不可用时自动回落 Opus。
- 合并规则：只合 T 层、无 DDL、CI 绿、且过**执行型**核验（旧代码跑红、新代码跑绿、变异自证）的 PR；保证型另须终审可合。含 DDL/迁移、需 owner 裁决的只开 PR。每项最多 2 轮修复，之后收窄声明或转 draft。
- 同机另一会话 `metasheet-1d` 负责客户反馈线（其队列不接）；需要上机的事项统一追加 #6079。

## 2. 合入 main（19 支）

| PR | 内容 | 核验方式 |
|---|---|---|
| #6064 | 第八窗口总结按 owner 复审订正 | 事实核对 |
| #6065 | 跨库镜像 mirror-link 在表锁下复读两端 sheet 存活（#5954）；并入 #6068 的锁序 COLLATE "C"、空列表拒绝、持锁证明、路由单测 | Opus 双镜头 + 真 PG 两会话竞争 |
| #6066 | /api/admin 挂载树全部 5xx 不回显错误原文（#5903 后续） | 八轮核验 + 终审（独立 AST 复核 51 个注册） |
| #6067 | 备料定时试拉 `CONNECTION_CANONICAL_UNAVAILABLE` 诊断 + R60 只读检查清单 Q0–Q6 | 三轮事实核对 |
| #6070 | 运行详情溯源区截断披露（total/truncated/nextCursor）+ 加载更多（#5925 残余） | 三轮执行型核验 |
| #6071 | 升级脚本识别 pm2-runtime 托管，restart not found 时按计划任务回退（针对 R59 上机事故） | 终审按「R60 用它比不用更安全」裁可合；CI Windows 5.1/pwsh 60/60 |
| #6096 | 备料演示 runner 改调用已发货批次模块、删过期口播 | 事实核对 |
| #6097 | on-prem nginx 参考配置 index.html 加 no-cache | 单镜头 |
| #6100 | R-02 schema 漂移契约补 lookupProjection 查找表列（读前 pin/compare 纵深防御） | 三轮 + 三次收窄声明 + 终审 |
| #6104 | 只读盘点 SQL 内网主机判定与运行时 SSRF 守卫逐类对齐 | Opus 单镜头差分 |
| #6105 | PLM workbench 两条写路由不回显 provider 原文 | Opus 单镜头 |
| #6106 | dingtalk 契约测试走共享 python 解释器解析 | 单镜头 |
| #6108 | 自动化恢复拒绝码补中英文案 | 单镜头 |
| #6109 | 备料物料导出 prep-lines/export 补与结转同一道租户归属墙 | Opus 双镜头 + 终审；realdb 4/4 |
| #6111 | 表存活闭世界守卫删过期 #5833 GAP 说明（#5834 已修），GAP 计数断言改为 0 | 本地 78/78 |
| #6117 | PLM 写路由 logger.error 用测试钉住 | 单镜头 |
| #6118 | 盘点 verify 包补 10 条守卫推导负例（#6104 变异存活收口） | 两轮 |
| #6119 | 行锁普查最小扩展（public.meta_sheets、JOIN … FOR … OF 别名），保留 main 识别器；取代 #6085 | Opus 单镜头 |
| #6122 | 导出租户墙补测：无租户声明形态（演示机形态）、端口抛错 fail-closed、卡片文案 | Opus 单镜头 |

## 3. 未合入（原因与下一步）

| PR / issue | 状态 | 为什么没合 / 下一步 |
|---|---|---|
| #6076 外部系统删除 × 并发写锁协议（#5923 残余） | 终审**可合**（mustFix 空） | 改变生产写路径锁语义，核心并发保证目前只有本地真 PG 执行见证（三方独立 33/33），CI 里只有内存模型。待 owner 授 gh `workflow` 权限后把真 PG 套件接进 plugin-tests.yml，CI 绿即合。 |
| #5933 legacy 绑定 connection_id 回填（DDL 账本表 + DML） | 技术就绪（两镜头 pass） | owner 09-26 裁决：先 R60 只读普查（#6067 Q3/Q4）再授权。合并即意味着下次上机 migrate 会在演示机执行。另：#6067 证明它**不会**消除 CONNECTION_CANONICAL_UNAVAILABLE。 |
| #6099 073 sealed-export 绑定生成列 + NOT VALID FK | DDL，owner 审 | 核验结论已评论到 PR（2 条：02-remediate「只 retire 悬空行」无测试钉住；同租户写先竞争仍是未分类 500）。 |
| #6098 连接拒绝原因诊断日志 R1/R2/R3/R7 | draft | 末轮仍 7 条，其中一条是本 PR 新引入的**存在性时序旁路**（边界核验实测 z≈9）。下一窗口以「不引入时序差」为首要约束重做，或先只做 R2 小刀。 |
| #6069 form-share 结构守卫按形状 | draft | 八轮后文本扫描器仍 3 条未钉；三选项见 PR 评论（只留已见证声明 / 改 TS AST / 关闭）。 |
| #6085 行锁普查（重写词法） | 已关闭 | 被 #6119 取代（原方案对 main 识别器有回归）。 |
| #6068 / #6072 | 已关闭 | #6068 并入 #6065；#6072 转交 metasheet-1d，由其 #6077 合入。 |
| #5955 elearning 投影 sheet 存活 | 不修 | 真实迁移 + 真实代码证明仓库内无代码路径可达该状态，证据已评论到 issue。 |
| issue #6121 | 新登记 | handoffAdvance 读部署级 action.target 无归属墙；chain 未配 tenantId 时他租户可探项目存在并写游标/审计/钉钉。需 owner 确认无租户放行策略。 |
| SHEET-LIVENESS-GAP-1 | 新登记（#6119 GAP 账本） | recovery-archive-restore-jobs.ts `lockRestoreJobBlock` 锁下不读 deleted_at；软删表可恢复，处置需 owner 裁决。 |

## 4. 待上机（R60，运维机执行，已追加到 #6079）

- main 在 r59 之后的全部增量，含本窗口 19 支。
- #6097：示例文件对现网零效果，演示机现网 nginx.conf 需手工同步 `location = /index.html` 的 no-cache 段。
- #6071：升级脚本新参数 `-Pm2Home` / `-Pm2ScheduledTaskName` 与 5 条上机预检（记录 `(Get-Command pm2).Source`、看 `pm2 home:` 行、判定仍数日志 FullyQualifiedErrorId 不用 `$Error.Count` 等），详见 #6079 评论。
- #6067：R60 重启之后跑 Q0–Q6 只读检查，判定试拉报错属于 S1–S6 哪一态。
- #6109：导出租户墙上线前跑预检，看 `checks.carryTargetBinding.ownershipState`（结转在演示机能用则导出也能用）。

## 5. 需要 owner 的事

1. 运行 `gh auth refresh -h github.com -s workflow`（开发机令牌缺 workflow scope）：解锁 #6076 与 #6098 等真 PG 套件接线。
2. #5933：R60 普查后决定是否授权合并与执行。
3. #6099：DDL 方案 A 审阅。
4. #6121：无租户 chain 的放行策略；SHEET-LIVENESS-GAP-1 的处置。
5. 侦察点名、需裁决的 8 项：#5788、#5780、#5807、#5918、#5910、#5841、#5864①、sql-readonly 分页钳制。

## 6. 过程记录（影响效率的事实）

- 总额度停摆共 5 次（约 17h、3h、3h、3h、1h）；网关（本机 reclaude 代理）断一次约 10 分钟。改为 30 分钟心跳后，停摆恢复靠心跳触发 resume。
- 会话模型 Fable → Opus 切换后，`resumeFromRunId` 不命中缓存，曾重放已合入项；改为从各 PR 当前 head 起新的收口工作流。
- 核验 worktree 路径必须按轮次/镜头唯一，否则重试即停摆；实现者/修复者须能认领自己上一次尝试已推送的提交。
- 含上游 workflow 改动的 merge 提交在无 workflow scope 的令牌下可以推送（#6100 用此法解冲突）。
- Bash 工具内联脚本会折叠反斜杠，带正则/路径的编辑脚本一律落文件执行。

## 7. 不能说的话

- 不说 #6076「已验收」：核心并发保证在 CI 里只有内存模型见证。
- 不说 #6100 在生产上「覆盖查找表读」：真实适配器在 `pageLimit` 未配或 > `maxRows` 时首读即拒，生产效果是读前 pin/compare 的纵深防御。
- 不说 #6109 堵住了「全部」跨租户口：只在「取值」口径下成立；apply/dry-run/reconcile 与 handoffAdvance（#6121）不经此墙。
- 不说本窗口「零 blocker」：见第 3 节。

