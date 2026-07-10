# 考勤通知 WeCom（企业微信）渠道 adapter（S4）验证报告 — 2026-07-10

> 余下开发总目标池（#3925 计划）之 **S4**。PR **#4028** MERGED `fd242899c`。
> design-lock：`attendance-wecom-delivery-channel-s4-design-lock-20260710.md`（含企微官方 API 实证事实段）。
> 范围裁决：**WeCom 先行，SMS 缓行 = owner 门**（短信供应商/账号选型，与钉钉开放平台注册同类）；
> **wecom directory 绑定 population = 命名前置**（sync/手工绑定线独立立项），adapter 对未绑定收件人
> skip-not-fail（R4 #3920 语义）即诚实面。

## 1. 交付

- **零 migration 纯加法**：`WeComAttendanceDeliveryChannel`（name=`wecom_work_notification`，与
  dingtalk/email 共存按 name 路由）+ 传输层 `integrations/wecom/client.ts`；构造器全依赖可注入（镜像 DingTalk）。
- **企微 API 全部对照官方文档实证**（gettoken/message-send/全局错误码三页 WebFetch），非模型记忆：
  per-app secret 的 token 模型；textcard{title≤128字/description≤512字/url≤2048字节/btntxt≤4字}=深链等价物；
  **微工作台不支持 markdown → 用 text 回落**（与 DingTalk 的 markdown 路径刻意不同）。
- token 缓存自建（键 corpid|baseUrl / TTL=expires_in−120s / in-flight 去重 / 失败永不缓存 /
  42001/40014 单次 invalidate+重试）。
- 深链沿用 E3 双条件 gate → textcard / text 回落；正文复用 buildDeliveryTitle/Content 零新构建。
- 收件人三表 JOIN 逐字复制仅 `provider='wecom'`；not_bound→skip / ambiguous→failed（数据完整性异常不吞）。
- 注册双路：工厂 env-gate（flag + corpid/secret/agentid 全就绪才注册，register-nothing 先例）+
  ROUTABLE_DEFAULT_DELIVERY_CHANNELS（allowlist 兼 SQL 注入护栏）。

## 2. 对抗审阅（opus，refute-first，独立复验不采信 coordinator 自验）

审阅 MD：`/tmp/pr4028-s4-review-claude-20260710.md`（head `34de161cd`）。判定 **APPROVE：0 P1 · 0 P2**。

- 单测 64/64 实跑无 skip 假绿；tsc 独立跑 0 error；G5 SQL 程序化 byte-diff vs DingTalk = IDENTICAL
  modulo 'wecom' 字面量；**字符 vs 字节钳长正确**（title/description 按字符、text content 按 UTF-8 字节）；
  42001 重试「仍败→retryable 且恰调 2 次」直接排除无限循环；errcode=0+invaliduser 分支有专测。
- **CI 归属核实**：集成文件在 plugin-tests.yml:483 白名单、pull_request 无 path filter → 每 PR 真跑
  （非「plugin-integration-core 无处跑」陷阱），但该 job 非 5 required checks 之一——如实记录。
- mutation 合计七刀全红：作者四刀（not_bound skip / 42001 重试 / env-gate / ROUTABLE allowlist）+
  审阅者自选三刀（脱敏 redact / invaliduser skip / env-gate 复验）。
- N1 死常量（导出无消费）已按 PR-hardening 房规清理（`252d8d1cf`）；N2-N5 记录在审阅 MD，非阻断。

## 3. 过程记录

Sonnet 首刀（runtime + 测试文件，全套 core-backend 4609 单测绿）→ 账号会话额度墙 → **主循环（Fable）
亲自收尾**：新鲜迁移库集成 8/8（verbose 逐条 ✓ 防 skip 假绿）、mutation 四刀、tsc、提交、PR。

## 4. 账本归属

tracker 通知渠道行：DingTalk ✅ + Email ✅ + Fake ✅ + **WeCom ✅（本刀）**；SMS = owner 门未启。
后续相关：wecom directory population 线（前置，未立项）；per-org 渠道路由 = 既有 design-lock §3 未来项；
R4 P3-1 硬化（org 无 active 集成→retryable）与本渠道同 seam，排下波。
