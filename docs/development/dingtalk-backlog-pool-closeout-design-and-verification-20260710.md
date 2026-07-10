# 钉钉同步业务线 · 目标池收官 — 设计与验证记录（2026-07-09/10）

- Status: 目标池排空收官记录。前置：`dingtalk-sync-integrated-roadmap-20260708.md`（设计原则）、`dingtalk-sync-hardening-design-and-verification-20260708.md`（Rev 1→2）、`dingtalk-hardening-second-review-round-20260709.md`、`dingtalk-hardening-train-closeout-20260709.md`（10 车台账 + 15/17 纠错）。本文是 owner /goal「余下开发=总目标池」的落地与验证台账。
- 纪律基线：每 PR 独立对抗 gate（非自审）→ P1/P2 修复 → 承重 mutation 重放 → 单窗武装串行落地；逐窗协议 = 对齐最新 main → 解组合冲突 → 重放承重 mutation → CI 全绿 → 才 arm。

## 1. 完成声明（按 owner 口径）

已 ratify 且 decision-clean 的目标池已清空。剩余 = owner 运维决策（三个 default-off 开关 + DIRECTORY_SYNC_ALERT_WEBHOOK 配置）、staging-gated 项（user/get N+1）、demand-gated 增量（§7.6 对账工具、§8.x Phase-3 战略线、editor P3s）。**不声称「全部开发好了」。**

## 2. 重大纠偏（本轮第一成果）

验证 workflow + gh 双证：前轮「17/17 landed」实为 **15/17** —— #3898(H03)/#3903(H05) 从未合并，main 上无 sync lease 也无 at-rest 加密。#4001 收官台账带错误声称 armed 在途，已拆窗改正（title/body 均改「10-car ledger + 15/17 correction」）后落地。两票复活为池头两项。**教训：收官声明必须对 gh 实态逐票核验，禁止叙事收编。**

## 3. 落地台账（merge SHA 逐票）

| PR | 内容 | Gate | Merge |
|---|---|---|---|
| #3903 | H05 lease 复活 + heartbeat 四件套（心跳列/COALESCE 谓词/markSyncFailure 事务化/完成态守卫 + async 409 + scheduler 双 pin + 真库 golden 两点接线） | A-w-H→全修 | `685643cfc` |
| #3898 | H03 收尾四件套 + backfill CAS（SQL+参数双 pin）+ 兄弟脚本安全姿态移植 + withEnv promise 感知 | A-w-H→全修 | `37ad93fdd` |
| #4009 | #3900 P2 ledger deliveryStuckPending 双向可证伪（故障注入 + 反向守卫） | A-w-H→修 | `0eadecab8` |
| #4014 | R2 卡片 integration_id（migration+索引/写侧/回调侧按行密钥+NULL 回退）；双 mutation 窗（H03 解密 + R2 跨 corp 签名） | A-w-H→修 | `61526f8bd` |
| #4010 | #3902 P3-2 batch-bind 部分失败 toast + 兄弟路径测试；UNION 窗（7 main-only entry 保留有证） | APPROVE→修 | `2331a33d7` |
| #4011 | R8 quiet-hours（env v1/dispatch 前拦截/跨午夜/Intl fail-open/start==end 判无效）+ WeCom 组合重验（无旁路证明）+ exact-head re-gate + env→gate-ON 生产接线 pin | re-gate A-w-H→P2 全修 | `95c3bf93f` |
| #4013 | R1 群投递遥测 retention sweep（镜像 Ledger 先例；interval 活性 + re-floor 直测） | A-w-H→修 | `8e9d88f6f` |
| #4049 | preview 完整性：同批共邮箱/手机过计修复（sentinel 全镜像）+ lease 期拒 preview 409 | APPROVE | `0e4d4f416` |
| #4054 | R5 per-run summary（xmax 判别/事务内 coverage 快照/stats 增量合并） | APPROVE | `4b7c4cb61` |
| #4053 | cron 保存时校验 —— validator-runtime identity（agent 自纠简报错误：multitable OR 语义 parser ≠ 运行时 SimpleCronExpression AND 语义）+ hasNext 有界 | A-w-H→P2 doc 修 | `ef1c5640e` |
| #4057 | §7.1 inactive-linked-N-days 指标 + 阈值 env 门告警（锚点 updated_at 经穷举写点确证；fail-stop 吞掉证明）；UNION 窗=净差量终端树+并集证明 | APPROVE | `7a431384b` |
| #4046 | §7.2 transport 韧性：三级语义重试（read/exchange/send）+ body 超时假成功修复 + AbortSignal fallback + malformed-2xx 三类分离 + outcome_unknown 三账本消费 + 回调白名单外科放宽 + 活数据 down()；落窗含 Slice-B B-2 集成缝适配（kind=send，共享 catch 自动继承账本语义） | exact-head gate APPROVE（四项核验规格） | `b94b46bf3` |
| #4069 | async 轮询 UI + dry-run preview 卡 + 409 处理 + auto-admission 警示门 + R5 run-card 渲染 + poll 竞态三 pin + 10min 上限 | A-w-H→P2 全修 | `97cbb8eb1` |

尾巴（非池内）：#3998 邮箱大小写唯一性 ✅、#4001 纠错台账 ✅。

## 4. 设计裁决记录（owner ratified / 主循环代决）

- **重试按业务语义分级，不按 HTTP 动词**（owner）：read 预算内可重试 / exchange 绝不 / send 绝不重发标 outcome_unknown；网络错误 ≠ 未执行；task_id 不能当幂等键；malformed-2xx 三类分离都不得成功；进程内限流=best-effort。
- **回调放宽=白名单外科手术**（owner）：仅 `send_status IN ('sent','outcome_unknown')` 入可能已送达；HMAC/实例状态/supersede/一次性决策全保留并 pin 负例。
- **状态词表迁移覆盖 down()**（owner）：活行先映射回 failed 再收紧约束；读方审计三类（retention/统计/管理端 IN-list）。
- **quiet-hours 全通道**（主循环代决，re-gate 佐证）：pre-claim 栅栏通道无关（DingTalk/WeCom/email）；start==end=无效配置；Intl 失败 fail-open（宁可发也不无形静默）。
- **async 同步的 onboarding packets fail-safe**（主循环代决）：auto-admission 开启时警示确认（一次性初始密码不持久化，202 会丢）。
- **落地力学**（owner）：#4054/#4057 同文件同 EOF 双点冲突必 UNION；每窗禁批量武装。

## 5. 验证方法与「本该失败却全绿」表（血账）

全线验收标准：**还原真正改行为的那一行 → 必须变红，且不能靠 fixture/env-stub/DI 注入遮蔽**。本轮新增的遮蔽形态实录：

| # | 遮蔽形态 | 实例 | 修法 |
|---|---|---|---|
| 1 | mock factory 漏导出真类 → 被测模块持 undefined，守卫抛错被自身 catch 吞 = 永绿 | #3903 scheduler 测试（boot sweep 调 undefined） | importOriginal 再导出真类 + 双 pin |
| 2 | fixture 按参数判 CAS → 仅改 SQL 文本的 mutation 不可见 | #3898 backfill | SQL 形状 pin + 参数两半都锁，两个变体 mutation 都红 |
| 3 | DI 注入遮蔽 env 路径（与 env-stub 遮蔽互为镜像） | #4011 所有 gate-ON 测试直接注入 config → 生产 env 接线复合突变 103 绿 | 唯一一条纯 env 驱动的 gate-ON 测试 |
| 4 | validator ≠ runtime parser（用别的 parser 校验） | #4053 简报原指 multitable parser（OR 语义），`0 0 30 2 1` 假 200 | validator-runtime identity 为承重属性 + 文档警告勿换 |
| 5 | mutation 探针命中注释/import 行 → 「重放」实为无突变基线 | #4013（注释里的 `created_at < cutoff`）、#4054（import 行） | 探针必须确认命中真代码行；两次都已诚实更正 PR 评论 |
| 6 | 守卫在别的套件承重 → 探错套件得全绿假象 | #4014 M-R2 初探 deliveries 套件绿，真承重在 wrapper 套件 | 找到守卫真所在再下结论，过程记 PR |
| 7 | readJson catch{null} + envelope null→{} → **body 超时/畸形 2xx 被报成功** | #4046（owner 抓到，两级 gate 都漏） | null 只留 SyntaxError→再收紧为 malformed 三类分离；先写失败测试再修 |

**Gate 盲区实证（gate 绿 ≠ 可落地）**：#4046 首轮 gate APPROVE，owner 推翻并点出两个真 P1（body 超时假成功 / outcomeUnknown 未消费）；均以失败测试先行的方式修复确认。收官结论：对抗 gate 是必要非充分，owner 级实态核对仍是最后一道门。

## 6. 诚实清单（未证明/未做/预存）

- 未做（demand-gated）：§7.6 对账工具余量（getsendresult 对账 + 重投工具；幂等已由 source_key dedup + outcome_unknown 实质覆盖）、outcome_unknown 行的老化/对账自动化（owner 教义：人工/运维面）、per-org quiet-hours、多副本共享限流（Redis 级）、Phase-3 §8.3/8.5 兄弟项/8.6。
- 未证明：heartbeat 在池饱和大 apply 下不饿死（≥5x clamp 缓解未证）；scheduler boot sweep 仅经共享 reclaim mock 覆盖；#4069 手动路径 409 分支未测（gate MX3 存活，P3）；confirm-gate 跨管理员 TOCTOU fail-open（P3）。
- 预存缺陷入池待 owner 排期：scheduler setTimeout >2^31-1ms 钳制（远期 cron 热循环，仅 lease 挡）；legacy 无效 cron 行无清扫遥测；reschedule 闭包持旧 row.name；apps/web 新增 specs 不在任何 CI guard run-list（#4046 gate P3-1，系统性缺口）；admin test-send 把 outcome-unknown 显示为普通失败。
- owner 决策项（未动）：`DIRECTORY_DEPROVISION_ENABLED`（⚠一开即在下次同步批量停用）/`DIRECTORY_PRIMARY_DEPT_FROM_ORDER`/`DINGTALK_OAUTH_REQUIRE_SHARED_STATE_STORE`;建议配置 `DIRECTORY_SYNC_ALERT_WEBHOOK` 与新增 `DIRECTORY_INACTIVE_LINKED_ALERT_DAYS`。

## 7. 过程事实（组织学）

- 模型分工：Fable 5 = 热文件 correctness/全部 gate/#3903/#4046/R2；Sonnet 5 = scoped 实现与 hardening；三次会话额度死亡由主循环自做接管（#3903 hardening 五连 commit、#4049 gate、#4013/#4054 窗口）。
- 每窗一守窗器（自愈优先/绿-BEHIND 单 nudge/红即报警）；热 main 单窗最长 40+ 轮（#3898 两班）。
- flake 处置：#4054 test(18.x) 红 = 考勤 csv 套件互扰（pool-after-end 痕迹），重跑绿；不与本票混淆。
