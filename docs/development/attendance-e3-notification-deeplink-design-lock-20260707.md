# E3 考勤通知深链（C5 DingTalk channel → actionCard）design-lock — 2026-07-07

> **Status: RATIFIED（嵌入方向锁 E3 行「work-notification 升级 actionCard/link msgtype…点击直达容器内对应页;
> 深链 URL 形状与 E2 路由对齐」;前置 E2✅〔#3795/#3799〕已达成;owner 2026-07-07 goal「完成考勤全部开发」）。**

## 1. 摸底事实

- C5 `DingTalkAttendanceDeliveryChannel`（`AttendanceNotificationDeliveryWorker.ts`）现发**纯文本** work notification
  （`sendDingTalkWorkNotification`,title/content 出自 shared content helpers）。
- `sendDingTalkWorkNotificationActionCard`（markdown + 单钮 singleUrl）**已在** client.ts（审批一键卡 #3594 线建）。
- base-URL 解析先例:审批卡 `PUBLIC_APP_URL || APP_BASE_URL`。E2 landing = `/attendance`（overview 默认,
  E2b 免登在 LoginView 兜底——通知在钉钉内点开即容器 UA → 免登 → 直达）。
- source types:`unscheduled_reminder` / `comp_time_expiry_reminder` / `manual_missed_punch_reminder`（HMR）。

## 2. 方案（channel 内改造,fail-soft,默认关）

- **双条件 gate**:`ATTENDANCE_NOTIFICATION_DEEP_LINK_ENABLED === 'true'` **且** base URL
  （`PUBLIC_APP_URL || APP_BASE_URL`）可解析 → 发 actionCard;任一不满足 → **逐字节走现有 text 路径**（零回归;
  与 env-gate side-effect channels 纪律一致——PUBLIC_APP_URL 已在生产为审批卡而设,不能因它单独翻行为）。
- `buildAttendanceNotificationDeepLink(sourceType, baseUrl)`（导出,可单测）:
  `${base}/attendance?noticeSource=<encodeURIComponent(sourceType)>`——对齐 E2 路由（overview 落地）,
  query 只作来源标记不改路由行为;base 尾斜杠归一。
- actionCard 内容:`title=buildDeliveryTitle`、`markdown=buildDeliveryContent`（**同一 content 真源,无 per-msgtype drift**）、
  `singleTitle='打开考勤'`（actionCard 按钮短文案,单语）、`singleUrl=deepLink`。
- 错误分类复用 `classifyDingTalkSendError`（actionCard 失败与 text 同状态流:retrying/failed 可见）。
- **不做**（v1 OUT）:per-source 不同落点页（都落 overview,自助面已含打卡/异常/余额）;`dingtalk://openapp`
  microapp wrapper（真机行为 E4 验证,plain URL 在钉钉内打开走内置浏览器→E2b 免登,已足）;email channel 深链。

## 3. 测试契约

- 单测:deep-link builder（source 编码/尾斜杠/空 base → null）。
- 真 DB integration（`attendance-notification-deliveries.test.ts`,已在 plugin-tests.yml gate）:
  flag+URL 齐 → actionCard stub 收到正确 deepLink/singleTitle,text stub 不调;flag 缺/URL 缺 → text 路径原样;
  actionCard 抛错 → 分类与 text 同。
- Mutation:拆 flag gate → "默认关"测试红;拆 encode/尾斜杠归一 → builder 测试红。

## 4. 完成口径

实现 → opus 对抗审阅 0 P1/P2 → 三红线 → 验证 MD。真机点击链路（免登→深链回）归 E4（owner 注册微应用后）。
