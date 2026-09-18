# requireAdminRole() fail-closed pins — design (2026-09-14)

## 任务

W5-D:纯新测试(不改源码)。钉住 `packages/core-backend/src/guards/audit-integration.ts`
的 `requireAdminRole()` 在三种「拿不到角色」情形下真的 fail-closed(403),而不是放行。
测试文件:`packages/core-backend/tests/unit/require-admin-role-fail-closed.test.ts`。

## 为什么要钉这个

`requireAdminRole()` 是平台管理员门,挡在多条高危写端点前面(#5677/#5710 正在把更多
端点接到这道门上;#5680 是"admin-routes 里第一个 guard 必须是这道门"的结构性守卫)。
这些 PR 都假设"接了这道门 = 安全",但它们大多在测试里直接 `vi.mock('.../rbac/service')`
把 `isAdmin` 整个换成一个假函数(见 `admin-safety-confirm-authz.test.ts`、
`admin-snapshot-delete-authz.test.ts`)。那只能证明"guard 读 isAdmin 的返回值对不对",
证明不了"isAdmin 在真实的三种「查不到角色」情形下,自己会不会算错"。

本 spec 反过来:只在 `isAdmin` 更底层的 `pool`/`query`(`../db/pg`)打桩,让
`rbac/service.ts` 里的真实分支逻辑跑起来,直接钉住三种情形各自的真实返回值,以及
`requireAdminRole()` 收到这个返回值后的真实响应。

## 门的结构(实读,file:line 以 origin/main HEAD ce9da32ae 为准)

`packages/core-backend/src/guards/audit-integration.ts`:
- `requireAdminRole()`:113-199,每次调用返回新闭包(:114-118)。
- 无 `req.user?.id`:121-145,写审计后 403 `ADMIN_REQUIRED`(:139-144)。
- 有 user:`:148 const hasAdminRole = await isAdmin(user.id)`(单参数调用,
  `runQuery` 用默认值)。
- `hasAdminRole === false`:150-177,写审计 + `metrics.recordBlockedOperation`
  (:170)+ 403 `ADMIN_REQUIRED`(:172-177)。
- `hasAdminRole === true`:180-186,`next()`。
- `isAdmin()` 本身抛错(不是返回 false,是 throw):187-196,`catch` 内 503
  `RBAC_CHECK_FAILED`,注释写明"fail-safe"。

## isAdmin 的真实分支(实读,`packages/core-backend/src/rbac/service.ts:19-34`)

```ts
export async function isAdmin(userId: string, runQuery: typeof query = query): Promise<boolean> {
  if (runQuery === query && !pool) return false                          // :20
  try {
    const { rows } = await runQuery('SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2 LIMIT 1', [userId, 'admin'])
    return rows.length > 0                                               // :22-23
  } catch (error) {
    if (isDatabaseSchemaError(error) && allowDegradation) {              // :25-31
      return false
    }
    throw error                                                          // :32
  }
}
```

`pool`、`query` 都从 `../db/pg` 引入(:1)。`allowDegradation`
(`process.env.RBAC_OPTIONAL === '1'`,service.ts:17)是模块加载时算一次的常量,
不是每次调用重新读环境变量。

### 三种情形各自实际走的分支

| 情形 | 触发条件 | 实际分支 | isAdmin 返回 | 门的响应 |
|---|---|---|---|---|
| ① 用户存在但 `user_roles` 无匹配行 | `pool` 为真、`query(...)` resolve 出 `{ rows: [] }` | service.ts:21-23(`rows.length > 0` 为 `false`) | `false` | audit-integration.ts:150-177 → **403 ADMIN_REQUIRED** |
| ② `pool` 为 null / 不可用 | `pool` 为 falsy 且用默认 `runQuery`(生产路径恒如此,门调用 `isAdmin(user.id)` 不传第二参) | service.ts:20 早退 | `false`(**不发起查询**) | audit-integration.ts:150-177 → **403 ADMIN_REQUIRED** |
| ③ `RBAC_OPTIONAL=1` 且 `user_roles` 表缺 | `pool` 为真、`query(...)` reject 出带 `code:'42P01'`(或散文含 relation/table+does not exist)的 schema error,且模块加载时 `RBAC_OPTIONAL==='1'` | service.ts:24-31(`isDatabaseSchemaError && allowDegradation` 为真)→ `return false` | `false` | audit-integration.ts:150-177 → **403 ADMIN_REQUIRED** |

三种情形**全部** fail-closed(403),**没有发现 fail-open**。这与终审登记的说法一致。
额外钉了两条边界作对照:
- **正向控制**:`user_roles` 有 admin 行(`rows.length > 0`)→ isAdmin 返回 `true`
  → audit-integration.ts:180-186 → 200,handler 被调用。
- **isAdmin 真的抛错(非降级)**:`query(...)` reject 出一个不满足
  `isDatabaseSchemaError` 的普通错误(如连接中断,无 `code`、message 不含
  schema 散文特征)→ service.ts:32 原样 `throw` → 传到门的 `catch`
  (audit-integration.ts:187-196)→ **503 RBAC_CHECK_FAILED**。这条不属于任务
  列出的三种「拿不到角色」情形(isAdmin 没有返回 false,是直接抛出),但用来
  和①②③的"降级返回 false → 403"做对比,证明 503 只在"没被内部捕获的异常"时出现。

## 三种情形在测试里怎么构造(为什么只在 pool/query 层打桩)

`require-admin-role-fail-closed.test.ts` 只 `vi.mock('../../src/db/pg', ...)`,
用一个可变的 `dbState`(`pool`/`query`)喂给真实的 `isAdmin`/`requireAdminRole`
(两者都是原样 import,没有被 mock)。express + supertest 起一个最小 app,
把 `req.user` 通过前置中间件塞进请求,断言状态码、响应体 `code` 字段、以及
handler(200 分支)有没有被真正调用。

- ①②:直接在同一个 vitest 模块实例内切换 `dbState.pool`/`dbState.query`即可,
  因为 `pool`/`query` 在 mock 工厂里用 getter 读的是外层可变闭包,不需要
  `vi.resetModules()`。
- ③ 是唯一需要 `vi.resetModules()` + 动态 `import()` 的情形:`allowDegradation`
  是 `rbac/service.ts` 模块顶层算一次的 const,必须在设置
  `process.env.RBAC_OPTIONAL = '1'` **之后**重新加载模块才能生效;测试里
  `finally` 块会把环境变量和模块缓存都还原,不污染后续用例。

## 与 #5677 / #5710 / #5680 的关系

- **#5677**(`/api/admin/safety/rules` 四条写端点补 `requireAdminRole`,创建者/
  限流身份改读 `req.user`)、**#5710**(`GET /dlq` 与 `protection-rules` 两条 GET
  加门,叠 #5677 之上):两个 PR 都是"把更多端点接到 `requireAdminRole()` 这道门
  上",它们自己的测试里 `isAdmin` 是被 mock 掉的(直接控制返回 `true`/`false`/
  throw),验证的是"接线对不对",不验证"这道门在真实 RBAC 数据缺失/降级时到底
  返回什么"。本 spec 是这两个 PR 的下位保证:不管它们把门接到多少条新路由上,
  门自身在①②③三种情形下的行为已经被钉死为 403,不依赖每条路由自己重新验证
  isAdmin 的内部分支。
- **#5680**(`admin-routes` 写路由首位必须是 admin 门的结构性守卫,叠 #5665):
  验证的是"每条写路由的第一个 handler 是不是 `requireAdminRole()` 这个函数"
  (结构断言,类似 `admin-safety-confirm-authz.test.ts` 的 `firstGuardOf`),
  同样不深入 `isAdmin` 内部。#5680 保证"门在正确的位置",本 spec 保证"门本身
  在拿不到角色时不会松口",两者互补、互不重叠。

## 未做/超出范围的事

- 不改任何 `src/` 文件,不改 `isAdmin`/`requireAdminRole` 的行为。
- 没有发现 fail-open;因此没有 `it.fails`/`it.todo` 标注需要交给用户裁决。
- 没有新增"无 `req.user`"之外的第 4 种"拿不到角色"情形专项设计(任务只点名
  三种;spec 里额外带了"无 user"和"isAdmin 真抛错→503"两条作边界对照,不算
  超出任务要求的设计判断,只是复用门里本来就存在的另外两个分支)。
