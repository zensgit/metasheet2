# 钉钉 app access-token 进程内缓存 design-lock — 2026-07-07

> **Status: RATIFIED（E1 审阅 #3771 P3-2 既定 defer 项；owner /goal 全自动批次内的工程加固，
> 非新能力线）。** 动机：token 有效 7200s，现状每请求新取——directory-sync / work-notification /
> automation-executor / 考勤通知 worker / E1 免登全部命中共享 gettoken 配额；缓存同时削弱
> E1 限流面（P2-2）的放大系数。

## 1. 设计

- 缓存点 = `fetchDingTalkAppAccessToken` **内部**（全部调用方零改动受益）；键 `${appKey}|${baseUrl}`。
- 存 `{ token, expiresAt }`：`expires_in`（gettoken 响应，通常 7200）− **120s 安全边际**；
  字段缺失时保守 fallback 3300s。失败**永不缓存**。
- **in-flight 去重**：同键并发只发一次请求（防 stampede）。
- 导出 `invalidateDingTalkAppAccessTokenCache(config?)`（无参=清全部）与
  `__resetDingTalkAppAccessTokenCacheForTests()`（命名镜像 `__resetDingTalkOAuthStateStoreForTests`）。
- `options.fetchFn` 不改变缓存语义（token 与传输无关）；测试靠 reset 隔离。

## 2. 边界（OUT/已知取舍）

- 秘钥轮换mid-TTL：最长 ~2h 内失败（运维重启即清）——v1 接受，不做 401/40014 自动失效回环
  （调用方错误路径各异，v2 若真实需要再统一）。
- 不做跨进程/Redis 共享（单进程部署形态足够）。

## 3. 测试契约

单测（dingtalk-client.test.ts 模式，global.fetch mock）：同键两次调用只 1 次 fetch、返回同 token；
过期（伪造 expires_in=1 + fake timers 或注入 clock？——用 `expires_in` 极小值 + 真实 Date 差）后重取；
不同 appKey 不串键；失败不缓存（第一次 errcode 失败 → 第二次仍 fetch）；并发去重（两并发 await
→ 1 次 fetch）；invalidate/reset 生效。Mutation：拆 expiresAt 判断 → 过期测试红；拆去重 → 并发测试红。
既有受影响套件（automation-card integration 等）如因缓存变红 → beforeEach 加 reset（逐文件核）。

## 4. 完成口径

实现 → opus 对抗审阅 0 P1/P2（额度恢复后）→ 三红线 → 验证 MD。backend 泳道。
