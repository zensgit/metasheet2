# Wave A/B 验证报告：UI-P1 余量 + 钉钉 app-token 缓存 — 2026-07-07

> owner /goal 全自动批次。双单 MERGED：#3788 UI-P1 余量（`5e380c3cf`）+ #3786 app-token 缓存（`1668590162`）。
> 锁：`attendance-ui-p1-remainder-design-lock-20260707.md` / `dingtalk-app-token-cache-design-lock-20260707.md`。

## 1. Wave A — 考勤 UI-P1 余量（#3788，FE）

hero 卡今日两节点时间线（上班→下班，缺卡 pending 态，复用 `activeWorkbenchRecord` 零新请求，非今日不渲染）
+ 四个大数字 stat 卡（内联 SVG 图标首套 + `tabular-nums` + 语义色：需处理>0 danger / 迟到早退>0 warning）。
display-only：copy 逐字节不动、类只增、该区 spec 零既有断言（已核）。全 UF `--ms-*` 零新 hex。
- 验证：真挂载（TZ 无关镜像计算时刻 / 语义色 / 非今日缺席）；mutation 双刀（拆今日门/拆 warning 绑定 → 2 红）；
  web-guard 16 spec / 382 绿；tsc 清。owner code-review APPROVE 0 P1/P2（display-only，无新请求/后端/schema 面）。
- **意义**：P1 核心补齐 → 嵌入方向锁的 **E2 解锁条件〔E1✅+UI-P1〕达成**（E2 容器壳下一批次可开）。

## 2. Wave B — 钉钉 app access-token 进程内缓存（#3786，backend）

E1 审阅 #3771 P3-2 既定 follow-up。`fetchDingTalkAppAccessToken` 内建缓存（全调用方零改动受益）：
键 `appKey|baseUrl`；TTL = `expires_in` − 120s 边际（fallback 3300s / 下限 30s）；**失败永不缓存**；
并发 in-flight 去重；导出 `invalidateDingTalkAppAccessTokenCache` + `__resetDingTalkAppAccessTokenCacheForTests`。
削共享 gettoken 配额（directory-sync/通知/automation/考勤 worker/E1），并强化 E1 限流姿态。
- 验证：缓存六态单测（命中/过期(Date.now spy)/跨键/失败不缓存/并发去重/invalidate）11/11。
- **CI 红修复**（owner 定诊）：缓存进程全局 → `automation-v1.test.ts` 的 5 个 `send_dingtalk_person_message`
  测试跨用例污染（前序缓存 token → 本测试 gettoken 不 fetch → `mock.calls[1]` 错位）。修：顶层 `beforeEach`
  reset 缓存 + 5 处 payload 断言改按 `asyncsend` endpoint 找（`findDingTalkPersonSend`，抗未来漂移）。
  automation-v1 213/213；token 消费邻居套件复跑绿；tsc 清。
- 取舍入锁：秘钥 mid-TTL 轮换需 invalidate/重启（v1 不做 40014 自动失效回环）。

## 3. 过程

子代理额度墙（16:30 台北恢复）期间按既定降级：主循环实现 + 机械门自审,审阅由 owner code-review 覆盖;
两单均 fresh-green + up-to-date 后经 lander 落地。

## 4. Follow-up（gated）

E2 容器壳（前置达成，下一批次）；app-token 40014 自动失效（v2 按需）；UI-P2 图表 / 机械 hex token 化（等 Sonnet）。
