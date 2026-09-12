# /api/admin/safety/rules 写端点补管理员门与真实身份（issue #5667）

日期：2026-09-12
分支：`fix/protection-rules-require-admin-and-identity`
基线：`origin/main` @ `9fb29831c`

## 1. 问题

`packages/core-backend/src/routes/protection-rules.ts` 这个 router 管的是**保护规则**——
`ProtectionRuleService` 用它们决定某个快照/插件/表结构/流程的操作是放行、拦截、升级风险还是要走审批
（`effects.action` ∈ `allow | block | elevate_risk | require_approval`）。也就是说，它是**闸门的闸门**：
谁能改这张表，谁就能给自己开一条 `action: 'allow'` 的路，把后面所有破坏性操作的保护一次性关掉。

在修复前，这个 router 的四条写端点**一个授权检查都没有**，而且身份取自调用方自己写的请求头。

### 1.1 调用链

- `packages/core-backend/src/index.ts:1884` — `this.app.use('/api/admin', initAdminRoutes({...}))`。
  挂载点本身**没有**任何管理员中间件，只有全局的 JWT 认证（任何登录用户都能进 `/api/admin`）。
- `packages/core-backend/src/routes/admin-routes.ts:2022` — `router.use('/safety/rules', protectionRulesRouter)`。
  这一层也没有门。
- `packages/core-backend/src/routes/protection-rules.ts` — 最后一层，修复前也没有门。

三层下来没有任何一层做管理员校验，所以**任何已认证用户**都能走到处理器。

### 1.2 修复前的原始代码（行号以 `origin/main` @ `9fb29831c` 为准）

| 位置 | 原样 | 问题 |
| --- | --- | --- |
| `:21` | `const userId = (req.headers['x-user-id'] as string) \|\| 'anon';` | 限流桶的 key 由调用方决定 |
| `:111` | `router.post('/', async (req, res) => {` | 建规则，零授权 |
| `:113` | `const userId = req.headers['x-user-id'] as string \|\| 'system';` | 规则创建者由调用方决定 |
| `:203` | `router.patch('/:id', async (req, res) => {` | 改规则，零授权 |
| `:244` | `router.delete('/:id', async (req, res) => {` | 删规则，零授权 |
| `:267` | `router.post('/evaluate', async (req, res) => {` | 试算，零授权 |

实读复核结论：**任务里给出的六个行号与代码完全一致**，没有出入。

### 1.3 为什么"请求头身份"是洞

`x-user-id` 是一个普通的 HTTP 请求头，由客户端逐字节控制，服务端没有任何东西给它背书
（它不是从已验签的 token 派生的，也没有和 `req.user` 做过一致性校验）。它造成三个后果：

1. **归属造假**：`created_by` 落库的是攻击者手打的字符串。事后审计看到的是"某管理员建了这条放行规则"，
   而真正的主体在日志里根本不出现。这不只是显示问题——它把审计线索指向了无辜的人。
2. **配额绕过**：限流按 `${userId}:${method}:${path}` 分桶。key 既然来自请求头，
   每次换一个值就换一个空桶，10 次/60 秒的限制等于不存在。
3. **回退值更糟**：`|| 'system'` 意味着连头都不用带，规则就会被记成系统自己建的。

注意它**不是**提权洞的成因——提权洞的成因是四条端点根本没门。请求头身份是叠加在上面的
归属与配额洞，两者要分开修、分开证明。

## 2. 改了什么

只动 `packages/core-backend/src/routes/protection-rules.ts` 一个文件。

### 2.1 四条写端点加既有守卫

在处理器**之前**插入 `requireAdminRole()`（`src/guards/audit-integration.ts:113`）：

- `:131` `router.post('/', requireAdminRole(), ...)`
- `:223` `router.patch('/:id', requireAdminRole(), ...)`
- `:264` `router.delete('/:id', requireAdminRole(), ...)`
- `:287` `router.post('/evaluate', requireAdminRole(), ...)`

这个守卫是仓库里现成的、`snapshot-labels` / `snapshots` / `change-management` 都在用的同一个，
实读它的行为：

- 没有 `req.user?.id` → 403 `{ error: 'AccessDenied', code: 'ADMIN_REQUIRED', ... }`（`:139`）
- `isAdmin(user.id)` 为 false → 同样的 403 `ADMIN_REQUIRED`（`:172`），并记一条 denial 审计 + 指标
- `isAdmin` 抛错 → **503** `{ code: 'RBAC_CHECK_FAILED' }`（`:192`），即 RBAC 查不动时**拒绝**而不是放行

`isAdmin`（`src/rbac/service.ts:19`）直查 `user_roles`：
`SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = 'admin'`，没有 pool 时返回 false。
整条链在任何一个环节不确定时都倒向拒绝。

### 2.2 身份改取 `req.user`

- 创建者：`:133` `const userId = getUserId(req);`。`getUserId`（`:25`）只读 `req.user?.id`，
  空值**抛错**而不是回退成 `'system'`。因为门在前面，走到处理器时 `req.user` 必然存在，
  所以这个抛错只在"守卫被人拆掉"时才会触发——它是第二道防线，不是正常路径。
  形状照抄同仓 `src/routes/snapshot-labels.ts:28` 的 `getUserId`。
- 限流：`:41` `const userId = req.user?.id ? String(req.user.id) : (req.ip || 'unknown');`。
  不再读请求头，换头换不出新桶。

`req.user` 的形状来自全局声明 `src/types/express.d.ts:19`（`id?: string | number`），
所以 `getUserId` 里做了 `String(id)` 归一，和 `snapshot-labels.ts` 一致。

### 2.3 `x-user-id` 全仓写入点核查

在 `packages/core-backend/src` 内搜过 `x-user-id`。除去测试与注释，生产代码里只有三处读它（`plugins/` 下另有自己的读点，属各插件范围，本次不涉及）：

- `src/routes/protection-rules.ts:21,113` —— 本次修掉的两处。
- `src/routes/kanban.ts:25` `const raw = user?.id ?? req.headers['x-user-id']` —— 另一个 router，
  不在本次范围，**没动**。
- `src/routes/comments.ts:79` —— 同上，**没动**。

**运行时代码与前端没有调用方向 `/api/admin/safety/rules` 发 `x-user-id`**：
`packages/core-backend/src` 里除了 `admin-routes.ts` 的挂载行之外，没有第二处提到 `safety/rules`；
前端没有调用点。仓库脚本里有两处会打它——`scripts/verify-sprint2-staging.sh:31/:119`（带 `x-user-id: staging-validator`）
与 `scripts/preflight-staging.sh`——但它们都要求传入 admin 的 `API_TOKEN`（同一脚本先打 `/api/snapshots`，那条链自 GHSA-h8mf 起就需 admin），
且只在 workflow_dispatch 手动触发时跑；本次改动后它们带的 `x-user-id` 头被忽略、身份取 token 主体，行为不变。唯一会带这个头打这些端点的是
`tests/integration/snapshot-protection.test.ts`，见 §4。

## 3. 没改什么（有意的）

- **读端点的授权与处理器不动**：`GET /`（`:74`）和 `GET /:id`（`:102`）非管理员照样能读。
  唯一随之变化的是无路径限流器的 key（`:38-41`）：从请求头改为 `req.user.id || req.ip`，GET 同受影响（方向是收紧：伪造头不再能换桶）。
  这是本次刻意划的边界——只收紧写面，读面的口径留给 owner 单独裁决（见 §4 残余）。
- **`ProtectionRuleService` 不动**、**`SafetyGuard` 不动**。
- **`admin-routes.ts` 不动**（#5665 在飞，避免争用）。
- **`/api/admin` 挂载处不动**。
- 对**管理员**来说行为完全不变：四条端点该 201 的 201、该 200 的 200，
  落库的 `created_by` 从"请求头里的字符串"变成"真实主体 id"——这是修复的目的本身，
  不是行为回归。

### 关于 `POST /evaluate`

它是 dry-run，不落库。但它仍然被加了门，理由有二：一是它把规则内部（命中了哪条、规则名）
回给调用方，等于一个针对保护策略的探测接口；二是它接受**调用方传入的 `user_id`**
（`req.body.user_id`，`:289` 取、`:303` 传进 `evaluateRules`）参与规则求值，也就是可以拿别人的身份试算。
任务要求四条一起加门，这里执行，并记下它和另外三条性质不同。

## 4. 残余风险（本次没解决的）

1. **`/api/admin` 挂载处仍无统一门**（`index.ts:1884`）。本次是逐端点补门，
   `admin-routes.ts` 里其它没被单独加固过的端点仍可能裸着。根治要在挂载点加统一门，
   那是独立的一刀，会影响整个 admin 面，需要 owner 决定。
2. **读侧 GET 未动**。非管理员仍可列出全部保护规则，包括规则名、条件与
   `effects.action`。这等于把"哪些操作被拦、拦的条件是什么"公开给任何登录用户，
   对想绕过保护的人是有用的情报。要不要一起收，需要 owner 裁决——
   收了可能打断现有的只读看板。
3. **`openapi/admin-api.yaml` 漂移**。`/safety/rules`（:617）、`/safety/rules/{id}`（:691）、
   `/safety/rules/evaluate`（:795）在契约里既没有声明管理员要求，也没有 403/503 响应，
   更没有把 `x-user-id` 记成参数（所以也谈不上删）。本次**没有**同步这个 yaml，
   契约与实现之间的这条缝是已知的、明写的债。
4. **`tests/integration/snapshot-protection.test.ts` 是本次的真库整链证据，不是死件**（复核订正）。它虽在无库
   `vitest.config.ts:1533` 的排除表里，但 `.github/workflows/plugin-tests.yml:1285-1294` 的「Run snapshot-protection E2E」
   步骤在 `test (20.x)` 作业上用真 PG 跑它（`vitest.integration.config.ts`），演员由该文件 `:51-56` 种进 `user_roles` 成 admin，
   所以它带的 `x-user-id` 头被忽略后仍以 admin 身份通过——本 PR 自己的运行（plugin-tests run 34689744663）该步骤 success。
   它对四条写端点的覆盖是保证④「admin 行为不变」在真库上的实证。
