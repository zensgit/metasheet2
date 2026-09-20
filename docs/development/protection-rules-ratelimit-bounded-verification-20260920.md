# protection-rules 限流表无界增长（ADM-18）— 验证记录

- 日期：2026-09-20（本机 +08:00，`date` 实跑）
- 分支：`fix/protection-rules-ratelimit-bounded`，基线 `origin/main`
- 环境：Windows 本机，node 20 / vitest 1.6.1 / pnpm 9.15.9（CI 才是裁判，本机结果仅作前置）

## 1. 跑过的命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @metasheet/core-backend exec tsc --noEmit` | 无输出（通过） |
| `pnpm exec vitest run tests/unit/protection-rules-ratelimit-bounded.test.ts tests/unit/protection-rules-authz.test.ts` | Test Files 2 passed，Tests **18 passed**（新 spec 5 + 既有 authz 13，零回归） |
| `pnpm exec vitest run tests/unit/change-management-authz.test.ts tests/unit/admin-dlq-read-authz.test.ts tests/unit/api-path-policy.test.ts` | 3 passed / **124 passed**（邻域 admin 守卫无回归） |
| `pnpm exec eslint src/routes/protection-rules.ts` | 0 error（tests/ 被 eslintignore 覆盖，属既有约定） |
| `git diff origin/main \| grep -cP '\x08'` | `0`（无退格字符） |

新 spec：`packages/core-backend/tests/unit/protection-rules-ratelimit-bounded.test.ts`，走 `usePinnedServer()` + `request(pinned.url())`，**无 `request(app)`**（#4154 tripwire）。

## 2. 新 spec 的五条断言

1. **(1a) key 空间有界**：同一主体打 200 个互不相同的 `GET /:id`，表里只剩 **1** 个桶 `u-keyspace:GET:/:id`，且没有任何 key 含请求里的 id。
2. **(1b) 硬上限 + fail-open**：直接驱动导出的 `protectionRulesRateLimit`，用 `RATE_LIMIT_MAX_KEYS + 50` 个互不相同的主体各打一次；表 size 恰为 `RATE_LIMIT_MAX_KEYS`，溢出的 50 次全部 `next()` 放行、无 429（fail-open）。
3. **(2) 过期回收**：`vi.spyOn(Date, 'now')` 把时钟推进两个窗口后再来一个请求，三个旧桶被清扫掉，表里只剩新来的那个。
4. **(3a) 回归（ops 探测）**：集合上 11 次快速 GET，第 11 次仍 429，前 10 次无 429——与 `scripts/verify-sprint2-staging.sh:155-167` 的判据同形。
5. **(3b) 没有收得过头**：同主体同方法下 `/` 打满 10 次后第 11 次 429，但 `/:id` 仍 200；表里恰好两个 key。

## 3. 变异自证（内存级，未落盘）

手法：scratchpad 里的一份**一次性 vitest 配置**挂了个 `enforce: 'pre'` 的 vite `transform` 插件，在 `src/routes/protection-rules.ts` 进模块图的路上按字符串改写它的源码；**磁盘上的源文件自始至终未被修改**（与并行代理共用同一仓库对象库，禁止落盘变异）。配置与脚本只存在于会话 scratchpad，不进仓库。

基线（`W7D2_MUTANT=none`，同一配置）：**5 passed**。

| 变异 | 改写内容 | 结果 |
| --- | --- | --- |
| `key-raw-path` | key 改回 `${userId}:${method}:${req.path}`（改前形态） | **(1a) 红**（size 200 ≠ 1），(3b) 也红 — 1 failed → 2 failed / 3 passed |
| `key-no-shape` | key 收成 `${userId}:${method}`（收得过头） | **(3b) 红**，(1a)(2) 亦红 — 3 failed / 2 passed |
| `no-sweep` | 清扫触发条件改成 `if (false)` | **(2) 红**（size 4 ≠ 1）— 1 failed / 4 passed |
| `no-cap` | 外层上限判据改成 `if (false)` | **(1b) 红**：`expected 10050 to be less than or equal to 10000` — 1 failed / 4 passed |

四个变异各自被至少一条断言杀死，且基线为绿，说明断言不是空过。

## 4. 未覆盖 / 残余

- 未在真实多实例或真库环境验证——本改动是进程内内存结构，与 DB / Redis 无关，无 DDL、无 env flag、无外部写。
- `scripts/verify-sprint2-staging.sh` 的 11 次探测本次**未上机实跑**（需要 staging 与管理员令牌）；以同形的 spec (3a) 代证：判据（第 11 次 429）一致。
- 惰性清扫在「完全无请求」的进程里不会触发，最后一批桶留到下一次请求为止——有界，非增长。
- fail-open 的 warn 每窗至多一条，若要告警联动需另接指标，本刀不做。
