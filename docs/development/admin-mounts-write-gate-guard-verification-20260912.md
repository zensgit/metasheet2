# `/api/admin` 其他挂载点写路由守卫 — 验证记录（2026-09-12 起草，09-14 收口）

配套设计：`admin-mounts-write-gate-guard-design-20260912.md`。本记录由协调方在实现代理因会话额度中断后接手收口：代理已写完 spec 与设计文档并跑绿，本记录按协调方本机实跑结果补写；未做的项如实标注。

## 1. spec 与用例

- 文件：`packages/core-backend/tests/unit/admin-mounts-write-gate-guard.test.ts`（932 行）。
- 本机实跑（基线 `origin/main` @ `9fb29831c`，无库）：**Test Files 1 passed / Tests 160 passed (160)**。输出里的 `RBAC check failed … rbac unavailable` 与 `Failed to apply permission template … rbac unavailable` 是 `(A) RBAC 判据不可用` 那组用例**故意**让 `isAdmin` 抛错以验证 fail-closed，不是失败。
- 结构（6 个 `describe`）：
  1. `fixture 自检` — 证明 mock 的 `req.user` 不带任何 legacy admin claim（`role`、`roles`、`perms`、`permissions:['*:*']` 四形态全部排除），否则 `ensurePlatformAdmin` 的 `hasLegacyAdminClaim` 分支会假绿。
  2. `(A) 非管理员逐条写路由被拒且下游零调用` — 7 个 router 的写路由逐条 403（或该 router 既有的拒绝码），service spy 零调用。
  3. `(A) 无身份（req.user 缺失）逐条 fail-closed`。
  4. `(A) RBAC 判据不可用（isAdmin 抛错）fail-closed` — 非 2xx。
  5. `(A) 控制组：同一请求只改门的输入，结论必须翻面` — `isAdmin` 恒 true 时放行、注入 legacy claim 时 `ensurePlatformAdmin` 放行——证明行为断言量到的是门本身而非别的拒绝。
  6. `(B) 清单双向反查` — 遍历每个 router 的 `stack` 枚举 `(method, path)` 写路由集合，与 spec 内登记表**相等**：新增未登记写路由红，登记表多出的死条目也红。
- `ensureRoleDelegationAdmin` 的两条（`admin-users.ts:2982`、`:3060`）登记为例外，单独断言「无委派命名空间的非 admin 被拒」。

## 2. 类型检查

包级 `tsconfig.json` 排除测试文件，故用临时 `tsconfig.w4k-check.json`（`extends ./tsconfig.json`，显式 `include` 新 spec，`types: ["node","vitest/globals"]`）：`npx tsc --noEmit -p tsconfig.w4k-check.json` → **exit 0**。临时 config 不入库。

## 3. CI 收集

`vitest.config.ts` 无 `include` 键、`exclude` 不含 `tests/unit`；`.github/workflows/plugin-tests.yml` 的「Run core-backend tests」= `pnpm --filter @metasheet/core-backend test` = `vitest`（`package.json:26`），本 spec 被无库 job 全量收。

## 4. 变异

- **spec 内置控制组**（第 5 组）即正反变异：门输入翻面 → 结论翻面，随 spec 常跑。
- **外部变异（未做）**：代理原计划的「往 stack 塞一条未登记写路由 → (B) 红」「从登记表删一条 → (B) 红」两组外部探针，因代理在写文档阶段被会话额度中断而未留下记录；协调方接手时本机对外网络中断、且为节省额度未复跑。(B) 的相等断言在逻辑上必然对这两种改动变红（集合相等的两个方向各对应一种），但**没有实跑证据**——合并前若需，一条 `it` 即可补。

## 5. 相邻套件

未在协调方接手时复跑（代理的相邻 spec 记录随会话中断丢失）。本 spec 不改任何 `src/` 文件（`git status` 无受控文件修改），对相邻套件无影响面；CI 为裁判。

## 6. 限定

- 守卫覆盖的是 W4-I 盘点（`admin-mounts-write-gate-inventory-20260912.md`）列出的 7 个 router；`index.ts` 上运行期动态挂载、常量拼接路径的注册不在枚举内（盘点 §1 的盲区照旧）。
- W4-I 发现的两份 `ensurePlatformAdmin` 副本宽度差（`admin-directory.ts:212` 认 `permissions` 含 `*:*`、`admin-users.ts` 不认）**未钉成用例**——是否收紧待裁决；裁决后加法见设计文档。
- 文档不含真实主机、账号、口令。
