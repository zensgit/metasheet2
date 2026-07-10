# 考勤硬化 Wave-2 验证报告（H1 + H2）— 2026-07-10

> Wave-1 对抗审阅产出的 P3 硬化池收口。两刀均走固定节奏（锁→实现→opus 对抗审→修 P2→merge→本 MD）。

## A. H1：org 无 active 集成 → retryable 非终态 skipped（PR #4045，MERGED 4c0e11e2e）

> 来源 = 审阅 #3920 的 P3-1。design-lock：`attendance-r4-p31-org-integration-retryable-design-lock-20260710.md`。

- 双 channel（DingTalk/WeCom）`resolveRecipient` 0 行冷路径加二次参数化 EXISTS：org 有 active 集成 →
  维持 skip `*_recipient_not_bound`（行为逐字节不变）；无 → `{retryable:true, '*_org_integration_inactive'}`
  → worker backoff（~81min 内 5 次）→ 耗尽落 **可见的 failed**（last_error 可 grep），集成恢复窗口内自动送达。
  ambiguous/missing 分支不动；EXISTS 仅冷路径执行（热路径零开销）。

### 对抗审阅（opus）
`/tmp/pr4045-h1-review-claude-20260710.md`。判定 **APPROVE-with-hardening：0 P1 · 0 P2**。
- **重试风暴面（coordinator 点名的核心风险）取证降级 P3**：「多租户+默认渠道=DT+某 org 从未配 DT」拓扑下
  skipped→failed 是行为变更，但冷路径在任何网络发送前返回（纯 DB churn 零 API 调用）、窗口有界、
  failed 可 grep，且正是 ratified 修法要的行为（锁明确接受 failed-bucket）。
- 审阅者追加 Mutation-P（PR 未列）：删 `AND status='active'` → 集成红——status 过滤非未测守卫。
  Mutation ①②复验：新路径被测 + 「not_bound 保持 skip」在真 Postgres 上被既有 C5-3/S4 用例钉死。
- 实跑：unit 64/64 · 集成 9/9（verbose 真执行）· 全考勤门 266/266（fresh-migrate 隔离库）· tsc 0。
- NIT-1 PR body 82/82→64/64 已改；NIT-2 org-scoping 顺带覆盖（主查询同谓词已测）。
- **owner 决策项（不自做）**：可选收窄 `bool_or(status='active') AS has_active, count(*)>0 AS has_any`——
  区分 never-configured（→skip 安静）与 suspended（→retryable），收窄了 ratified 的「无 active 行→retryable」
  决定，需 owner ack 后另刀。

## B. H2：photo 证据 magic-byte 嗅探 + files delete 孤儿行（PR #4044，MERGED 7a94997e5）

> 来源 = 审阅 #4016 的 P3-1/P3-2。design-lock：`attendance-h2-photo-evidence-hardening-design-lock-20260710.md`
> （含 AMENDMENT：spec 矛盾发现 + 方案 A 裁决）。

- **P3-1**：新纯模块 `imageMagicBytes.ts`（PNG/JPEG/GIF/WEBP/BMP 签名，零依赖，WEBP 查 RIFF@0+WEBP@8）；
  上传成功路径无条件写 `meta.sniffed=true`（路径标记）+ 命中时写 `meta.sniffedContentType`；
  plugin G2：`sniffed===true` → 必须 sniffedContentType image/* 否则 422（伪造 MIME 非图在此被拒）；
  无 sniffed 键 = 老行 → 回落自报值（byte-parity，历史证据零破坏）。上传路由不拒任何文件（通用语义不变）。
- **P3-2**：delete 路由补 `DELETE FROM files`（参数化，行缺 no-op）——孤儿行不再累积，
  已删文件的 id 无法再充当打卡证据（delete-then-punch → 422）。
- **过程亮点**：impl 车道开工前发现裁决 spec 自相矛盾（「miss 不写键」+「无键回落自报值」使伪造行与老行
  数据不可区分，两必测用例互斥）并停下上报——主循环裁方案 A（专用布尔判别子；否 B 的
  key-present-but-null wire 坑）。矛盾+权衡+裁决全记入锁 AMENDMENT。

### 对抗审阅（opus）
`/tmp/pr4044-h2-review-claude-20260710.md`。判定 **CHANGES-REQUESTED（0 P1 · 1 P2）→ P2 修复后过门**。
- 核实干净面：方案 A 判别子不可伪造（files 行唯一写入器 = 上传 INSERT，恒写 sniffed:true，无 UPDATE meta
  路径）；G2 else 分支与 #4016 版字符级一致；WEBP offset-8 判别正确；与 H1 车道零文件重叠；
  outdoor-punch 集成文件在 plugin-tests.yml:481 真 CI 门内。
- **P2-1（已修 `c24a08e1c`）**：`imageMagicBytes.ts` 五分支仅 PNG 被 E2E 摸到——审阅 neuter 证明杀 JPEG 分支
  29/29 仍绿（JPEG=手机主格式，回归=全部真照片 422 且零信号）。修复 = 直接单测 9 用例
  （五格式 + RIFF/WAVE 负例证 offset-8 + 截断/空/null 守卫）；JPEG-kill mutation 修后红。
- NIT：SVG 有意拒收已补记锁 OUT 列（可脚本文本非相机产物，是决策非遗漏）；前置字节伪造
  （magic 前缀拼接）在 lazy-forgery 威胁模型下接受；delete 两步非原子 = P3 既有边缘。
- 实跑：29/29 + 全考勤门 268/268（fresh 库）· 单测 9/9 · tsc 0 · mutation 三刀（G2 判别/DELETE FROM/嗅探写入）+ P2 修复刀全红。

## C. 余量口径（⚠ 2026-07-10 owner 审阅 CHANGES-REQUESTED 修订版）

> 本节原稿宣称「硬化池全部落地/收口」——**owner 审阅推翻该口径**（H1 判定成立；问题集中在 H2 文件证据边界）,
> 修订如下。

- Wave-2 两刀（H1 #4045 / H2 #4044）**主体已合**,但硬化池 **REOPEN**,新增两个必修项:
  - **F1〔P1〕文件资源级授权**:files.ts 四端点（list/info/download/delete）仅 authenticate,无 owner/org/业务
    ACL——任何登录用户可枚举并读取/删除他人考勤照片。既有平台缺口,但敏感照片证据接入后不得再作 OUT 排除。
  - **F2〔P2〕删除顺序**:storage.delete 先行、DB 删行在后——存储删成/DB 删败时重造「二进制已消失、行仍被
    G2 当有效证据」的悬挂态（恰是 H2 声称消灭的状态）。改 DB tombstone 先行 + 存储补偿删除 + DB 失败注入测试。
- **措辞纠正**:本 MD 中「magic-byte 嗅探」应理解为**格式前缀筛查**（BMP 仅 2 字节、PNG/JPEG 短前缀,拼前缀
  的伪造内容仍可通过）,是 lazy-forgery 威胁模型下的弱识别,**不构成文件为真实图片的证明**。
- 新增 owner 决策项：H1 的 never-configured vs suspended 收窄（见 A 节）。
- owner 门与命名前置不变（S7 / 五连 smoke / E4 真机 / 档 B / T2 三项 / wecom population /
  comp_time primitive / SMS 选型 / >50 org 轮转）。硬化池在 F1/F2 落地并复审通过前保持 OPEN。
