# `/api/admin` 读侧补管理员门（`/slo/status` + 子路由 `/snapshots`）— 验证记录 2026-09-20

基线：`origin/main` = `1a6663a41`。分支 `fix/admin-slo-status-gate`。本机 Windows；CI 是裁判。

本 PR 起于批次 3（`admin-read-gates-batch3-design-20260920.md`）留下的最后一条残余 `GET /slo/status`；反驳轮又证伪了它第一版的绝对声明，于是补上了第二条：`GET /api/admin/snapshots`。设计侧的增补写在该设计稿新追加的「残余已清零」一节，这里只记验证与变异自证。

## 改动面

| 文件 | 改了什么 |
| --- | --- |
| `packages/core-backend/src/routes/admin-routes.ts` | `/slo/status` 注册处插入 `requireAdminRole()` 作首位 handler，并按 `/dlq`（`:1420` 起）的 `SECURITY` 注释风格写明三态与暴露面 |
| `packages/core-backend/src/routes/snapshot-labels.ts` | `router.get('/')`（`:145`）插入 `requireAdminRole()` 作首位 handler，与同文件三条写端点（`:40/:74/:109`）同形；`SECURITY` 注释写明它经 `router.use('/snapshots', …)` 挂在 `/api/admin` 下、以及三条查询缺租户谓词这一未清零残余 |
| `packages/core-backend/tests/unit/admin-read-gates-batch3-authz.test.ts` | `ROUTES` 表加 `/slo/status` 与 `/snapshots` 两项；闭世界扫描改为**递归**走 `router.use()` 子路由并钉 `toEqual([])`；新增「扫描确实下钻到子路由」的反盲区用例；文件头重写（含扫描覆盖面的显式边界） |
| `packages/core-backend/tests/unit/admin-read-gates-batch2-authz.test.ts` | 仅文件头 `UPDATE` 段落：原文写「只剩 `/slo/status` 未加门」，现已不成立；并登记本批多关的第六条 |
| `docs/development/admin-read-gates-batch3-design-20260920.md` | 追加「残余已清零」一节 |

没有动挂载顺序、没有动 `SLOService` / `SnapshotService` 实现、没有动响应体形状、没有动 `openapi/admin-api.yaml`。

## 反驳轮修掉的 blocker：闭世界扫描看不见子路由

第一版把用例命名为「`admin-routes.ts` has no ungated GET left at all (closed world)」、PR 标题写「admin 读侧无门 GET 清零（ADM-05 收官）」。反驳者给出的反例成立，实读复核如下：

- `packages/core-backend/src/routes/admin-routes.ts:2142` `router.use('/snapshots', snapshotLabelsRouter);` —— 挂载点本身没有门；
- `packages/core-backend/src/routes/snapshot-labels.ts:145` `router.get('/', async (req, res) => {` —— 同文件 `:40/:74/:109` 三条写端点都带 `requireAdminRole()`，唯独这条读没有。`git blame` 指向该路由落地那一笔，`origin/main` 今天仍如此；
- 暴露面比本 PR 原本要关的那条更重：`SnapshotService.ts:1169 / :1197 / :1220` 三个查询都是 `selectFrom('snapshots').selectAll()`，谓词只有 tag / protection_level / release_channel，**零租户谓词** —— 加门前任意租户的任意已认证用户 `GET /api/admin/snapshots?protection_level=protected` 就能读到全平台的快照行；
- 第一版扫描结构上看不见它：`for (const item of router.stack)` + `if (!item.route?.methods?.get) continue`，而 `router.use()` 产生的层没有 `route`，整层被跳过。内存级复现（`packages/core-backend` 下，零落盘）：

  ```
  node -e "const express=require('express');const sub=express.Router();sub.get('/',(q,s)=>s.json({}));const r=express.Router();r.get('/gated',(q,s)=>s.json({}));r.use('/snapshots',sub);const seen=[];for(const l of r.stack){if(!l.route?.methods?.get||!l.route.path)continue;seen.push(l.route.path);}console.log('sweep sees:',JSON.stringify(seen),r.stack.map(l=>l.name));"
  ```

  → `sweep sees: ["/gated"] [ 'bound dispatch', 'router' ]`。

- 口径不是本 PR 自定义的：#5678 原文的盘点就把 `router.use` 挂进来的子路由 GET 算在内（明确点名 `protection-rules.ts` 的 `GET /` 与 `GET /:id`），只是漏了 `snapshot-labels.ts`。

采用的是修法 (a)「真收官」而不是 (b)「收窄措辞」：给 `snapshot-labels.ts:145` 补门 + 把扫描改成递归 + `ROUTES` 表加 `/snapshots` 一条。扫描现在下钻 `layer.handle.stack`，路径按挂载前缀拼接（`/snapshots`、`/safety/rules`、`/safety/rules/:id`），并且新增一条**反盲区用例**直接钉住「扫描确实看得见这三条」—— 零断言（`toEqual([])`）只有在证明扫描能看见目标时才有意义。

## 扫描现在覆盖什么、不覆盖什么（显式边界）

覆盖：`/api/admin` 下**经任何挂载方式**可达的全部 GET —— `admin-routes.ts` 本体注册的，以及 `router.use(prefix, subRouter)` 挂进来的（今天是 `snapshot-labels.ts` 与 `protection-rules.ts`）。判定方式是给首位 handler 喂合成请求，非 403 即报出路径。

不覆盖：

- **读 `req.user` / `req.path` / `req.ip` / `req.params` / `req.query` / `req.headers` 之外字段的门**。合成请求只带这六项（`headers` 是本轮按反驳者的非阻断项补的，今天的 `requireAdminRole` 并不读它）。读别的字段的门会抛错，扫描 `catch` 之后按「不是门」报出来 —— 方向保守（误报而非漏报），但这是将来要加宽合成请求、而不是放松断言的信号，已写进 spec 头。
- **参数化前缀挂载的子路由**（今天零个）。`mountPrefixOf()` 只反编译字面前缀那一种 `path-to-regexp` 形状；其它形状返回 `/<unparsed:…>` —— 仍然**报出来**，只是名字难看。反盲区用例额外断言「没有任何路径含 `<unparsed:`」，所以哪天有人加了参数化挂载，是红，不是静默。
- **弱门的识别范围**：扫描喂的合成请求带 `user: { id }` 且 `isAdmin` 为假，所以「只认证不鉴权」的门在它眼里同样不算门（见下表 M2）。递归之后这一点对子路由里的弱门同样成立，不再是只对本体成立。

## 暴露面（为什么这两条读要加门）

- `sloService.getSLOStatus()`（`packages/core-backend/src/services/SLOService.ts:122`）遍历进程内注册的 SLO，用 `registry.getMetricsAsJSON()` 的 prom-client 指标算每条的当前可用率与错误预算，全程没有任何租户谓词。加门前任何租户的任何已认证用户（不持任何角色）都能读到平台自身的 `currentAvailability`、`errorBudget.{total,consumed,remaining,remainingPercentage}` 与 `healthy / at_risk / violated` 判定，并且可以按需轮询 —— 一条实时的「平台现在难不难受、离违约还剩多少」预言机。
- `GET /api/admin/snapshots` 的三条服务查询（`SnapshotService.ts:1169 / :1197 / :1220`）是 `selectAll()` 且零租户谓词，返回的是全平台的快照行本身，不只是元信息。**加门只收窄了受众（平台管理员），没有把查询变成租户内查询** —— 这一条作为残余登记在下方。

`rbac/service.ts:20` 的 `if (runQuery === query && !pool) return false` 保证没有连接池时两条都是 403 而不是开门。

## 留置理由的复核（`/slo/status` 为什么现在可以动）

批次 3 把 `/slo/status` 留下的理由是「#5680 用它做反向对照，加门会把那个 PR 钉红」。实读复核：

- `gh pr view 5680 --json baseRefName,headRefName,state` → `base = fix/admin-safety-toggle-and-bulk-require-admin`、`head = test/admin-routes-write-endpoints-structural-gate`、`state = OPEN`；
- `gh pr view 5665 --json headRefName` → `head = fix/admin-safety-toggle-and-bulk-require-admin`，即 #5680 叠在 #5665 上，**不是**叠在 main 上；
- `gh pr diff 5680 | grep -n "slo/status"` → 反向对照断言的是 `/slo/status` 的 `route.stack[0]` **不是**门。

结论：#5680 的检查跑在自己的分支树上，main 上加门进不了它任何一次 CI。**触发点的措辞按反驳者的非阻断项更正**：不是「#5680 rebase 时」才来 —— #5665 一旦合并、其分支被删，GitHub 会自动把 #5680 的 base 改指 main，反向对照当场失去素材而变红，不需要任何人手动 rebase。失败是响亮的、不是静默的，但触发点早于原措辞。两处 spec 文件头与本节均已改正。

## 跑过什么

全部在 `packages/core-backend` 下、`npx vitest run`（配置 `vitest.config.ts`）。`tests/unit` 内一律 `usePinnedServer()` + `request(pinned.url())`，没有 `request(app)`（#4154 tripwire）。

| 命令 | 结果 |
| --- | --- |
| `vitest run tests/unit/admin-read-gates-batch3-authz.test.ts` | `37 passed`（6 路由 × 5 参数化 + 7 跨路由；加门前为 25） |
| `vitest run` 七件套：`admin-read-gates-batch3-authz` / `admin-read-gates-batch2-authz` / `admin-dlq-read-authz` / `require-admin-role-fail-closed` / `snapshot-labels-authz` / `protection-rules-authz` / `admin-snapshot-delete-authz` | `Test Files 7 passed (7)` |
| `npx tsc --noEmit -p tsconfig.json` | 退出码 `0` |
| `grep -rn "slo/status"` / `grep -rln "admin/snapshots"`（排除 `node_modules` / `dist`） | 调用方仍为零：web / openapi / plugins / scripts / docker 下无任何引用，只有路由文件与 spec |
| `git diff origin/main \| grep -P '\x08'` | 空（无控制字节） |

两条新路由走的五条参数化用例与既有四条逐字同形：非管理员 → 403 `ADMIN_REQUIRED` 且底层服务未被调用；未认证（无 `req.user`）→ 403；`isAdmin()` 抛错 → 503 `RBAC_CHECK_FAILED`；管理员 → 200 且负载原样透传（`/slo/status` 钉 `remainingPercentage` = 15、`status` = `at_risk`；`/snapshots` 钉 `count` = 2 且 `getByProtectionLevel` 以 `'protected'` 被调用一次，防止「把返回裁小了」冒充加门）；首位 handler 对非管理员产出 403 且不 `next()`。

`SnapshotService` 在本 spec 里是**模块级替身**（`vi.hoisted` + `vi.mock`）而不是 spy：真实单例在 import 期就要数据库句柄，而被测的三条查询正是那几条跨租户 `selectAll()`，单元测试里一次都不该可达。其余服务沿用本文件既有口径（`vi.spyOn` 打真实单例、`afterEach` 还原）。

## 变异自证（内存级，无落盘变异）

两轮变异全部内存级：第一轮用临时 spec + `vi.mock` 覆盖 `requireAdminRole`；第二轮直接在进程内改 `initAdminRoutes()` 产出的 express 路由对象（`route.stack.shift()`），**被测源码一个字节没改**，临时探针文件跑完即删（`git status` 已确认工作树只剩上表五个文件）。

| 变异 | 形状 | 结果 |
| --- | --- | --- |
| M1 直通 | `requireAdminRole: () => (_req,_res,next) => next()` | 非管理员 `GET /api/admin/slo/status` 回 `200`、响应体含 `errorBudget`、`getSLOStatus` 被调 1 次；闭世界扫描重新报出 `/slo/status` → 新增的 403 用例与 `toEqual([])` 都承重 |
| M2 只认证不鉴权 | 门只在 `!req.user?.id` 时 403，已认证的非管理员一律 `next()` | 同样回 `200` 且预算外泄；闭世界扫描同样报出 `/slo/status` → 「未认证 403」单独绿不足以背书，拦住 M2 的是非管理员那条与闭世界那条 |
| M0 基线 | 不变异 | 递归扫描报 `[]`（`initAdminRoutes()` 下全部 GET，含三条子路由路径） |
| M3 摘掉 `/snapshots` 的门（内存级 `handlers.shift()`） | 路由对象里把首位 handler 弹出 | **本 PR 的递归扫描报出 `/snapshots`** → 新扫描承重 |
| M4 同一变异 + 旧扫描 | 同 M3，但用第一版（只看 `layer.route`）的走法 | 旧扫描仍报 `[]`，且 `/snapshots` 根本不在它的路径集合里 → 反驳者的「结构上看不见」被逐字复现，也证明递归不是装饰 |
| M5 反盲区用例的承重性 | 用旧走法产生路径集合 | 集合里不含 `/snapshots`、`/safety/rules`、`/safety/rules/:id` → 新增的反盲区用例会红 |
| M6 参数化挂载 | 合成 `parent.use('/:tenantId/weird', sub)` | 路径以 `/<unparsed:…>` 报出，数量 1，不被丢弃 → 「未知挂载形状只会难看、不会消失」承重 |

## 残余

- **`snapshots` 表的三条查询仍无租户谓词**：`SnapshotService.ts:1169 / :1197 / :1220` 的 `selectFrom('snapshots').selectAll()` 只按 tag / level / channel 过滤。本 PR 把受众收窄到平台管理员，**没有**把查询改成租户内查询；`GET /api/snapshots`（`src/routes/snapshots.ts`）等其它入口的租户口径也未在本 PR 核查。作为独立残余登记，建议单开跟进（改查询签名会波及调用方，不该混在补门 PR 里）。
- **#5665 / #5680 的后续**：#5665 合并、分支删除时 GitHub 自动把 #5680 的 base 改指 main，其反向对照用例即失去素材，必须改成正向形式；本 PR 只负责把 main 上的洞补掉并在两处文件头留下指针，不动那两个 PR 的任何文件。
- **`packages/core-backend/openapi/admin-api.yaml`**：整份 yaml 没有 `securitySchemes`（`grep -n security` 空），连早就要求管理员的端点也没写，因此没有只给这两条补 403 的写法能不造出新的不一致。与批次 2、批次 3 的同一条残余合并处理。
- **500 分支回显 `err.message`**：`/slo/status`（`admin-routes.ts:1395-1399`）与 `snapshot-labels.ts` 的 catch 块都直接回显驱动原文。加门后受众已收敛到管理员，脱敏是独立取舍点，沿用前两批的留置。
- **扫描的两处已知边界**见上文「扫描现在覆盖什么、不覆盖什么」：读 `req` 其它字段的门、参数化前缀挂载 —— 两者都会被**报出来**（误报方向），不会静默漏过。
- **本机跑的是 Windows**，七件套与 `tsc` 在本机全绿；CI 才是裁判。
