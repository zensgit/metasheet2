# 考勤通知 WeCom（企业微信）渠道 adapter（S4）design-lock — 2026-07-10
> Status: RATIFIED。依据：代码侦察（seam=AttendanceDeliveryChannel，零 migration 纯加法）+ 企微官方文档实证。范围：WeCom 先行，SMS 缓行（owner 门）。陷阱免则：NotificationService.ts 是无关栈不可复用。

## 企微 API 实证事实（锁定，防记忆漂移）
- Token：GET https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=ID&corpsecret=SECRET；每个应用独立 secret；expires_in 7200s；官方要求缓存且「可能提前失效，应实现失效重取」。
- 发送：POST https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=TOKEN；必填 touser（|分隔）、agentid（整型）、msgtype。textcard={title≤128字/description≤512字/url≤2048字节须带协议头/btntxt≤4字}=深链等价物；text={content≤2048字节}；markdown 不用（官方：微工作台不支持展示markdown消息）。
- 响应：errcode/errmsg + errcode=0 仍可能带 invaliduser + msgid。
- 错误码：42001 token过期/40014 token不合法/45009 频率超限/45033 并发超限/41001 缺token/40056 agentid不合法/60020 IP不可信/40003 UserID无效/81013 收件人全非法或无权限/82001 收件人全空。

## 设计裁决
- G1 Seam：新 WeComAttendanceDeliveryChannel（同文件），name='wecom_work_notification'（DISTINCT 常量，与 dingtalk 共存）；传输层新 integrations/wecom/client.ts；构造器全依赖可注入（镜像 DingTalk :263-269）。
- G2 注册双路：(a) 工厂加 wecom 分支——ATTENDANCE_NOTIFICATION_WECOM_ENABLED==='true' 且 config 就绪（corpid+secret+agentid 全present）才注册，否则 register-nothing；(b) 加进 ROUTABLE_DEFAULT_DELIVERY_CHANNELS（否则默认渠道选不到=死代码；字面量精确）。env 命名镜像 work-notification-settings.ts 惯例，进 .env.example 默认 off。
- G3 Token 缓存自建（勿复用 DingTalk 缓存）：键 corpid|baseUrl、TTL=expires_in−120s、in-flight 去重、失败永不缓存、导出 invalidate+__reset*ForTests。send 收 42001/40014 → invalidate+单次重取重试，仍败再分类。
- G4 发送：单收件人 touser。深链双条件 gate（E3 纪律）→ textcard（title钳128/description钳512/url=deepLink/btntxt=「打开考勤」）；任一缺 → text（content钳2048字节）。正文复用 buildDeliveryTitle/buildDeliveryContent。不用 markdown。
- G5 收件人解析：三表 JOIN 逐字复制仅 provider='wecom'——0行→skip 'wecom_recipient_not_bound'；>1行→'wecom_recipient_ambiguous'（不skip）；external_user_id 空→skip。零新表零新列。
- G6 分类 classifyWeComSendError：retryable=HTTP传输错/超时/5xx + {42001,40014}(token重试后仍败) + {45009,45033}；结构性skip={81013,82001,40003, errcode=0且invaliduser含该收件人}；永久config={41001,40056,60020,not-configured}；last_error 脱敏 corpsecret/access_token。
- G7 零 migration 声明；wecom directory population = 命名前置，范围外（skip-not-fail 即诚实面）。
- G8 测试：单测（DI 模式）注册门/双路径/分类表/42001重取/脱敏/钳长；集成（真DB）seed provider='wecom'/runBatch 计数含 skipped/not_bound 零 send 调用/双路径 wire；mutation 四刀①拆not_bound skip②拆42001重试③拆env-gate④拆allowlist项。

OUT：SMS；per-org 路由；wecom population 线；消息撤回/@all/合批/markdown/群机器人。
