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

## 7. 2026-10-10 refresh

基线：`origin/main` @ `1b843faee` 合入本分支后（合并提交 `dc4f3e222`）。原守卫在新 main 上照样 160/160 全绿——写路由集合没变，但 spec 里所有 `reg`/`gate` 行号、`MOUNTS[*].source` 的 `src/index.ts:NNNN` 与注释里的行号都已过期。本次只动 spec 与本文档，`src/` 零改动。

### 7.1 改了什么

- **挂载点锚点**：`MOUNTS[*].source` 改为 `index.ts` 里挂载语句原文（如 `this.app.use('/api/admin/directory', adminDirectoryRouter())`，根挂载 `this.app.use(adminUsersRouter())`），并新增 `factory` / `routeFile`。新自检「挂载点锚点对 index.ts 自证」：`index.ts` 里恰好一行（trim 后）与语句逐字节相同；语句的字面路径 = `mountPath`（根挂载 ↔ `'/'`）；语句调用的工厂名 = `factory.name`。「同一个 app 按真实顺序挂载」用例的挂载顺序不再手写，改由这些语句在 `index.ts` 里的先后算出。
- **登记表锚点**：`reg` 改为 `routes/<file>.ts`（须等于该挂载点的 `routeFile`）；`gate` 改为 `routes/<file>.ts <门函数名链>`，deprovision restore / reactivate / force-reactivate / compensate 四条写 helper 名（`restoreDeprovisionEventForRequest -> ensurePlatformAdmin`、`compensateSupersededDenyGrantForRequest -> ensurePlatformAdmin`），permissions 写 `isAdmin`。形状检查从「要求 `:\d+`」改为「可解析，且每条分支链的最后一环 = 本族门函数」。新自检「登记表锚点对源码自证」：注册文件里 `<router 变量>.<method>(` + 逐字节相同的路径字面量恰好一处（单行与多行写法都认）；每条分支的第一环在这条注册的处理器区间里被调用；`helper -> 门` 的门是 helper 的第一条语句。
- **注释**：文件头、EXCEPTIONS、deprovision、permissions 等处的行号引用全部改为函数 / 标识符名。`admin-users.ts` 的 `hasLegacyAdminClaim` 私有副本已原样迁到 `rbac/platform-admin.ts`，注释同步（行为不变）。
- **PARAM_VALUES**：`integrationId` / `accountId` / `alertId` 改为 uuid 形状（与 `eventId` 同），并加自检「id 形参 fixture 是 uuid 形状」。非管理员用例不受影响（门在前）；没有别的断言依赖旧值。
- 登记表本身不变：67 条，分族 60 / 2 / 4 / 1。逐条实读（用脚本列出每条写路由处理器的第一条语句）：56 条 platform + 2 条委派的第一条语句就是门；reactivate / force-reactivate / compensate 3 条的第一条语句是 helper 调用，helper 的第一条语句是门；restore 的例外如旧；canary 4 条的门仍在中间件首位；permissions 的 `isAdmin` 仍在 `if (!pool)` 与身份检查之后。

### 7.2 实跑

- 本机：**Test Files 1 passed / Tests 163 passed (163)**（原 160 + 3 条新自检）。
- 类型：临时 tsconfig（`module: ES2022`，只 include 本 spec 与类型声明，用后删除）下本 spec **0 个错误**；剩下的错误都在 `src/`，是收窄 include 后缺少 `Request` 扩充声明所致，与本改动无关。

### 7.3 变异（逐个施加 → 跑本 spec → 按字节还原并核对 sha256）

§4 记为「外部变异（未做）」的两组即下表 i、ii，本次已实跑。

| # | 变异 | 变红的用例 |
|---|---|---|
| i | src：`admin-directory-local.ts` 加一条未登记的 POST 路由 | (B) stack -> 登记表 |
| ii | spec：从 REGISTRY 删一条（local `POST /accounts/:accountId/archive`） | 自检「登记表条数」；(B) stack -> 登记表 |
| iii | src：org-transfers `/:transferId/cancel` 改名为 `/:transferId/cancelled` | (B) 登记表 -> stack；(B) stack -> 登记表；自检「登记表锚点」（注册 0 处）；(A) 非管理员 / 无身份的该条（404）；(B) 同 app 真实顺序 |
| iv | src：org-transfers `POST /:transferId/scan` 删掉 `ensurePlatformAdmin` 门，处理器照常往下走 | (A) 非管理员的该条；(A) 无身份的该条；自检「登记表锚点」（处理器区间里无门调用）；(B) 同 app 真实顺序 |
| v | src：`index.ts` 挂载路径 `/api/admin/directory/local` 改为 `/api/admin/directory/locals` | 自检「挂载点锚点」（语句 0 处）；(B) 同 app 真实顺序（顺序算不出，fail-closed） |
| v-b | src + spec：同 v，且 spec 的 `source` 同步改、`mountPath` 不改 | 仅自检「挂载点锚点」（字面路径 ≠ `mountPath`） |
| v-c | src：`index.ts` 里 local 的挂载语句重复一行 | 自检「挂载点锚点」（2 处）；(B) 同 app 真实顺序 |
| v-d | spec：local 的 `factory` 换成 `adminDirectoryRouter` | 仅自检「挂载点锚点」（工厂名不符） |
| vi | src：routing-policy 的 router 加一层 `router.use(pass-through)` | (B) 没有非 route 层 |
| vii | src：org-transfers 再注册一次 `POST /:transferId/apply`（带门） | 仅自检「登记表锚点」（注册 2 处）——(B) 两个方向都看不到重复注册 |
| viii | src：helper `compensateSupersededDenyGrantForRequest` 删掉门 | (A) 非管理员的该条；(A) 无身份的该条；自检「登记表锚点」（helper 第一条语句不是门） |
| ix | spec：permissions 条目的 `gate` 写成不存在的函数名 | 自检「登记表条数与分族」（链尾 ≠ `isAdmin`）；自检「登记表锚点」 |
| x | spec：`integrationId` 改回非 uuid 值 | 仅自检「uuid 形状」 |

每个变异跑完都已按原字节还原、sha256 核对一致；收尾时 `git status` 只有本 spec 与本文档两处改动。
