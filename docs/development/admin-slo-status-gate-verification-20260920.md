# `GET /api/admin/slo/status` 补管理员门 — 验证记录 2026-09-20

基线：`origin/main` = `1a6663a41`。分支 `fix/admin-slo-status-gate`。本机 Windows；CI 是裁判。

本 PR 是批次 3（`admin-read-gates-batch3-design-20260920.md`）留下的最后一条残余，设计侧的增补写在该设计稿新追加的「残余已清零」一节，这里只记验证与变异自证。

## 改动面

| 文件 | 改了什么 |
| --- | --- |
| `packages/core-backend/src/routes/admin-routes.ts` | `/slo/status` 注册处插入 `requireAdminRole()` 作首位 handler，并按 `/dlq`（`:1420` 起）的 `SECURITY` 注释风格写明三态与暴露面 |
| `packages/core-backend/tests/unit/admin-read-gates-batch3-authz.test.ts` | `ROUTES` 表加 `/slo/status` 一项（走既有的 5 条参数化用例）；新增一条跨路由用例；闭世界扫描由 `toEqual(['/slo/status'])` 改为 `toEqual([])` 并改名；文件头重写 |
| `packages/core-backend/tests/unit/admin-read-gates-batch2-authz.test.ts` | 仅文件头 `UPDATE` 段落：原文写「只剩 `/slo/status` 未加门」，现已不成立 |
| `docs/development/admin-read-gates-batch3-design-20260920.md` | 追加「残余已清零」一节 |

没有动挂载顺序、没有动 `SLOService` 实现、没有动响应体形状、没有动 `openapi/admin-api.yaml`。

## 留置理由的复核（为什么现在可以动）

批次 3 把 `/slo/status` 留下的理由是「#5680 用它做反向对照，加门会把那个 PR 钉红」。实读复核：

- `gh pr view 5680 --json baseRefName,headRefName,state` → `base = fix/admin-safety-toggle-and-bulk-require-admin`、`head = test/admin-routes-write-endpoints-structural-gate`、`state = OPEN`；
- `gh pr view 5665 --json headRefName` → `head = fix/admin-safety-toggle-and-bulk-require-admin`，即 #5680 叠在 #5665 上，**不是**叠在 main 上；
- `gh pr diff 5680 | grep -n "slo/status"` → 反向对照用例为 `it('反：已知无门的读路由 GET /slo/status（admin-routes.ts:1392）首位不被认出来', ...)`，断言的是 `/slo/status` 的 `route.stack[0]` **不是**门。

结论：#5680 的检查跑在自己的分支树上，main 上加门进不了它任何一次 CI，所以「钉红」这一条在事实层面不成立。实际后果只有一个，且写进了两处文件头：#5680 rebase 到 main 时，那条反向对照没有素材可指了，必须改成正向形式（断言 admin-routes 下再无无门 GET）。

## 暴露面（为什么这条读要加门）

`sloService.getSLOStatus()`（`packages/core-backend/src/services/SLOService.ts:122`）遍历进程内注册的 SLO，用 `registry.getMetricsAsJSON()` 的 prom-client 指标算每条的当前可用率与错误预算，全程没有任何租户谓词。加门前任何租户的任何已认证用户（不持任何角色）都能读到平台自身的 `currentAvailability`、`errorBudget.{total,consumed,remaining,remainingPercentage}` 与 `healthy / at_risk / violated` 判定，并且可以按需轮询——这是一条实时的「平台现在难不难受、离违约还剩多少」预言机。`rbac/service.ts:20` 的 `if (runQuery === query && !pool) return false` 保证没有连接池时也是 403 而不是开门。

## 跑过什么

全部在 `packages/core-backend` 下、`npx vitest run`（配置 `vitest.config.ts`）。`tests/unit` 内一律 `usePinnedServer()` + `request(pinned.url())`，没有 `request(app)`（#4154 tripwire）。

| 命令 | 结果 |
| --- | --- |
| `vitest run tests/unit/admin-read-gates-batch3-authz.test.ts` | `31 passed`（加门前该文件 25 例：4 路由 × 5 + 5 跨路由；现 5 × 5 + 6 = 31） |
| `vitest run` 四件套：`admin-read-gates-batch3-authz` / `admin-read-gates-batch2-authz` / `admin-dlq-read-authz` / `require-admin-role-fail-closed` | `Test Files 4 passed (4)`，`Tests 71 passed (71)` |
| `npx tsc --noEmit -p tsconfig.json` | 退出码 `0`（`tsconfig.json` 的 `exclude` 含 `**/*.test.ts`，spec 由 vitest 转译，实跑即类型路径的证据） |
| `grep -rn "slo/status"`（排除 `node_modules` / `dist`） | 调用方仍为零：web / openapi / plugins 下无任何引用，只有 `admin-routes.ts` 与两份 spec |
| `git diff origin/main \| grep -P '\x08'` | 空（无控制字节） |

`/slo/status` 走的五条参数化用例与其余四条逐字同形：非管理员 → 403 `ADMIN_REQUIRED` 且 `getSLOStatus` 未被调用；未认证（无 `req.user`）→ 403；`isAdmin()` 抛错 → 503 `RBAC_CHECK_FAILED`；管理员 → 200 且预算字段原样透传（`remainingPercentage` = 15、`status` = `at_risk` 逐个钉住，防止「把返回裁小了」冒充加门）；`route.stack[0]` 对非管理员产出 403 且不 `next()`。新增的跨路由用例断言 403 响应体里不含 `errorBudget` / `at_risk` / `remainingPercentage`。

服务替身沿用本文件既有口径：`vi.spyOn(sloService, 'getSLOStatus')` 打在 `admin-routes.ts:29` 导入的同一个单例上，`afterEach` 的 `vi.restoreAllMocks()` 还原；不用 `vi.mock` 替换 `SLOService` 模块。真实实现读的是进程级 prom-client registry，别的套件也会往里写，替身同时消除了这条串扰。

## 变异自证（内存级，无落盘变异）

两个变异都用临时 spec + `vi.mock('../../src/guards', …)` 覆盖 `requireAdminRole`，`importActual` 保留该 barrel 的其余导出；被测源码一个字节没改；两个临时文件跑完即删（`git status` 已确认工作树只剩上表四个文件）。

| 变异 | 形状 | 结果 |
| --- | --- | --- |
| M1 直通 | `requireAdminRole: () => (_req, _res, next) => next()` | 非管理员 `GET /api/admin/slo/status` 回 `200`，响应体含 `errorBudget`，`getSLOStatus` 被调用 1 次；闭世界扫描重新报出 `/slo/status`。即本 PR 新增的 403 用例与 `toEqual([])` 都会红 → 两者都是承重的 |
| M2 只认证不鉴权 | 门只在 `!req.user?.id` 时 403，已认证的非管理员一律 `next()`（「看着有门、其实没门」） | 同样回 `200` 且预算外泄；闭世界扫描同样报出 `/slo/status`。即「未认证 403」那条单独绿不足以背书，非管理员那条与闭世界那条才是拦住 M2 的 → 闭世界扫描能识别弱门，不只是识别无门 |

M2 是针对闭世界扫描本身的：它给扫描喂的合成请求带 `user: { id }` 且 `isAdmin` 为假，所以只认证不鉴权的门在它眼里同样不算门。

## 残余

- **#5665 / #5680 的后续**：#5680 rebase 到 main 后，其反向对照用例失去素材，必须改成正向形式；本 PR 只负责把 main 上的洞补掉并在两处文件头留下指针，不动那两个 PR 的任何文件。
- **`packages/core-backend/openapi/admin-api.yaml`**：整份 yaml 没有 `securitySchemes`（`grep -n security` 空），连早就要求管理员的端点也没写，因此没有只给本条补 403 的写法能不造出新的不一致。与批次 2、批次 3 的同一条残余合并处理。
- **500 分支回显 `err.message`**：`/slo/status` 的 catch 块与本批其余端点一样直接回显。加门后受众已收敛到管理员，脱敏是独立取舍点，沿用前两批的留置。
- **本机跑的是 Windows**，四件套与 `tsc` 在本机全绿；CI 才是裁判。
