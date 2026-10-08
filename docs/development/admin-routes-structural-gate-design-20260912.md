# admin-routes 写路由「首位必须是 admin 门」的结构性守卫 —— 设计说明（2026-09-12）

分支：`test/admin-routes-write-endpoints-structural-gate`
基线：`origin/main` @ `309b551eb`（2026-09-21 rebase；初版基线是 `origin/fix/admin-safety-toggle-and-bulk-require-admin` @ `3c79b2059`，即 PR #5665 的头，该 PR 已合入 main）
新增件：`packages/core-backend/tests/unit/admin-routes-write-endpoints-structural-gate.test.ts`
本次**没有**改任何路由代码 —— `src/routes/admin-routes.ts` 一字未动。

> **2026-09-21 rebase 复核**：本文档里所有 `path:line` 都已按 `origin/main` @ `309b551eb` 重新实读订正
> （初版行号基于 #5665 的分支头，main 前进后全部过期）。三处**事实**变化一并改掉：
> ① `GET /slo/status` 已由 #5914 补门，不再是「已知无门」的反向对照 → 改为正向对照（§3.4）；
> ② `/safety/rules` 四条写路由已由 #5710 补门 → 四条临时豁免删除，子路由用例改为硬断言（§4.2、§5）；
> ③ 豁免表从 7 条降为 3 条，全部是永久豁免，临时豁免表当前为空（§4）。

---

## 1. 为什么要一条「面上」的保证

PR #5665 给 `admin-routes.ts` 里 12 条只挂 `requireSafetyCheck` 的写端点补了 `requireAdminRole()`。
那次修复本身没问题，但它是**逐条**加固。#5665 自己的设计文档
`docs/development/admin-safety-toggle-require-admin-design-20260912.md` §4 残余第 1 条把这件事写死了：

> **`/api/admin` 挂载处仍没有统一角色门。** `index.ts:1984` 之后的 `/api/admin/*` 依旧靠「逐条路由自己挂门」。
> 本次把 `admin-routes.ts` 里「只靠确认层」的一族补齐了，但这是逐条加固，不是面上的保证：
> **今后任何人在这个 router 里新加一条写路由而忘了加门，就会重新开洞。**
> 根治要么在挂载处套一层 admin 门（需先核对 `/safety/status` 等读端点与既有前端的可见性契约），
> **要么加一条「本文件所有写方法必须首位是 admin 门」的结构性测试。**

两条路里，「挂载处套门」要先跟前端核对读端点可见性契约（`GET /safety/status`、`/health/*` 等今天对任何
已认证用户可见），属于会改变可见面的动作；本次选后一条：**加结构性测试**，零行为改动、纯守卫。

这条守卫要挡的具体失效模式是：有人在 `admin-routes.ts`（或它挂的子路由里）新写一条
`router.post('/x', requireSafetyCheck({...}), handler)`，代码看着「有中间件」，但 `requireSafetyCheck`
是确认流程、**不是**授权门（`guards/middleware.ts:65-123` 全函数零角色查询），于是这条端点对任何已认证
用户敞开 —— 这正是 #5665 修的那一族的形状。

---

## 2. 守卫是什么

`tests/unit/admin-routes-write-endpoints-structural-gate.test.ts`：

- 不做 HTTP 请求、不扫源码文本（正则扫文本对 `...protectAdminOperation(X)` 展开、多行参数、注释里的
  `router.post` 全都判不准）。
- **从真实 router 对象上取路由栈**：`initAdminRoutes({})` 返回的就是 `admin-routes.ts:73` 建、`:2432`
  返回的**模块级单例** router，也就是 `index.ts:1984` 真正 `app.use('/api/admin', ...)` 挂上去的那一个。
  测试的 `beforeAll` 里显式断言 `initAdminRoutes({}) === (default export)`，免得将来它改成「每次新建一个」
  而守卫却在量一个没人用的对象。
- 递归遍历 `router.stack`：`layer.route` 是路由、`layer.handle` 带 `.stack` 的是子路由（递归下去）。
- 对每条**写方法**（POST/PUT/PATCH/DELETE）取该方法在 `route.stack` 里的**首个** handler，判定它是不是
  admin 门。不是、且不在豁免表里 → 红，错误信息点名 `METHOD /api/admin/<path>`。
- `router.all(path, fn)` 也被算作写方法（它同样应答 POST/PUT/PATCH/DELETE），不让它绕过。
- 「首个 handler」按 Express 实际 dispatch 取：对写方法 `m`，取 `route.stack` 中第一个
  `!layer.method || layer.method === m` 的层（express@4.21.2 `lib/router/route.js:144` 跳过
  `layer.method && layer.method !== m` 的层；`.all()` 产出的层 `method` 为 undefined，见 `:197`）。
  （2026-09-23 更正，#5680 复审 N3 后续：初版在 `route.methods._all` 为真时对所有写方法直接取
  `route.stack[0]`，于是 `.route(p).get(requireAdminRole()).all(h)` 里 GET-only 的门被误算成四个写方法
  的门 —— 复审内存注入这条合成路由后原 23 条用例全绿，而真实 HTTP 下非 admin 的 POST/PUT/PATCH/DELETE
  都到达 `h`。上一句「不让它绕过」在初版实现里对混合方法形状不成立。这是测试保证缺口，不是现网路由：
  admin router 里没有 `.all()` 形状的真实路由。更正后 spec 内含混合方法正反例、对真实 router 的注入
  负例，以及真实 HTTP 对照组，逐方法断言扫描结论与 Express dispatch 一致。）
- 刻意保留的保守：首位是 `next()` 透传型的 `.all()` 层、门排在其后时，行为上写方法仍会过门，但本守卫
  按「首位」判无门（§2.1）。这是方向正确的误报（fail-closed），不纳入「扫描 ⇔ 行为」对照组。

### 2.1 为什么是「首位」

`requireAdminRole()` fail-closed：无 user → 403 `ADMIN_REQUIRED`；非 admin → 403 `ADMIN_REQUIRED`；
RBAC 抛错 → 503 `RBAC_CHECK_FAILED`（`guards/audit-integration.ts:113-199`）。放在首位才能保证
后面的中间件（确认层、幂等、限流）和 handler 都在「已确认是 admin」之后才跑。#5665 的整链复现就是
「确认层先答 → 回一枚可用令牌」的次序问题，所以守卫盯的是**位置**，不只是「链里有没有」。

---

## 3. 识别机制，以及它为什么不是假件

### 3.1 走不通的两条路（实读结论）

- **按名字/属性认**：`requireAdminRole()`（`guards/audit-integration.ts:113`）返回的是
  `return async (req, res, next): Promise<void> => {...}` —— 一个**匿名**闭包。实测
  `fn.name === ''`，`Object.getOwnPropertyNames(fn) === ['length', 'name']`，没有任何可识别标记。
- **`vi.mock` 换成带标记的假门**：可行，但那样量的就是测试自己造的假件 —— 「生产代码里挂的到底是不是
  那个门」这一步被 mock 跳过了。本任务的原始指示允许这条退路，实读后发现不必退。

### 3.2 实际采用：函数源文本同一性（不 mock 任何守卫）

```ts
const ADMIN_GATE_SOURCE = requireAdminRole().toString()
function isAdminGate(fn) { return typeof fn === 'function' && fn.toString() === ADMIN_GATE_SOURCE }
```

同一个函数定义产出的每个闭包，`toString()` 逐字相同（闭包捕获的环境不进 `toString()`）；别的中间件的
源文本必然不同。于是被检查的就是**生产代码真正挂上去的那个函数对象**，不存在假件问题。

### 3.3 `protectAdminOperation` 算不算门 —— 实读

```ts
// guards/audit-integration.ts:261-263
export function protectAdminOperation(operationType: OperationType) {
  return [requireAdminRole(), auditSafetyOperation(operationType)];
}
```

它返回**数组**，`[0]` 就是 `requireAdminRole()` 的闭包。路由写成 `...protectAdminOperation(X)`，
express 展开后首位仍是那个门。所以「首位是 `protectAdminOperation(...)`」和「首位是
`requireAdminRole()`」在栈上是**同一件事**，`isAdminGate` 一个判定覆盖两种写法。测试里有一条用例
直接断言 `isAdminGate(chain[0]) === true && isAdminGate(chain[1]) === false`，把这条实读结论钉住 ——
将来谁把 `protectAdminOperation` 改成「审计在前、门在后」，这条会红。

### 3.4 正反自证（`describe('识别机制的正反自证')`）

| 方向 | 断言对象 | 期望 |
|---|---|---|
| 正 | `requireAdminRole()` 的两次独立调用 | 都被认成门 |
| 正 | `protectAdminOperation(FORCE_RELOAD)[0]` | 是门 |
| 正 | `POST /safety/enable` 栈上首位（`admin-routes.ts:214-215` 已知有门） | 是门 |
| 反 | `protectAdminOperation(FORCE_RELOAD)[1]`（审计中间件） | 不是门 |
| 反 | `requireSafetyCheck({ operation: RESET_METRICS })` | 不是门（#5665 的要害） |
| 反 | 裸 `(req,res,next)=>next()`、`undefined`、`null`、字符串 | 不是门 |
| 正 | `GET /slo/status` 栈上首位（`admin-routes.ts:1646`，#5914 补的门） | 是门 |

也就是说匹配器既不是「谁都认」（反例全不匹配），也不是「谁都不认」（正例全匹配）。

> **2026-09-21 订正**：最后一行初版是**反**例 ——「`GET /slo/status`（`admin-routes.ts:1392` 已知无门的
> 读路由）不是门」。#5914（`fix(admin): /slo/status 与子路由 /snapshots 补 requireAdminRole——/api/admin
> 读侧无门 GET 归零`）把门补上后，那条反例在 main 上**必红**，rebase 时改成**正**向对照：同一个
> `requireAdminRole()` 挂在 GET 上照样被认出来，顺带证明匹配器认的是函数本身、不挑方法。
> 反例职责没有落空 —— 表里仍有三行反例（`protectAdminOperation(...)[1]`、`requireSafetyCheck(...)`、
> 裸中间件/非函数），「谁都认」那种退化照样被挡住。
顺带说明一个不对称：「谁都不认」这种退化是 **fail-closed** 的 —— 匹配器失灵会让每条写路由都报违规、
整片变红，不会静悄悄放行；真正危险的是「谁都认」，所以反例那一列是这套自证的重心。

---

## 4. 豁免表（显式、逐条实读确认、带理由）

豁免写在测试文件的 `EXEMPTIONS` 常量里，每条带 `method` / `path` / `reason`，外加一个可选的
`todo`（issue/PR 号）。**今天共 3 条，全部是永久豁免；临时豁免表当前为空。**
（初版是 7 条 = 3 条永久 + 4 条 `/safety/rules` 临时豁免；后者已随 #5710 补门删除，见 §4.2。）

### 4.0 核心不变量是「⊆」，不是「=」；豁免分永久 / 临时两类

守卫的核心不变量只有一条：

> **无门写路由 ⊆ 豁免表**（出现没登记的洞 = 红）

刻意**不是**等式。等式（「豁免表恰等于今天的无门写路由集合」）看着更紧，实际有害：它等价于断言
「豁免表里每一条今天都必须仍然无门」，于是**修洞的 PR 一合并，本 spec 就红**，两条互相独立的 PR
被耦合成固定合并顺序，组合树验证（两支一起 merge 后跑）还会假红。
守卫的职责是拦住**新洞**，不是给修洞的人设路障。

**这个权衡已经被现实检验过，不再是假想**：初版把 `/safety/rules` 四条登记成临时豁免，当时
issue #5667 / PR #5677 正在修；该修复经 #5710 合入 main 之后，本 spec 在 main 上**照样全绿**
（只多两段 `console.warn` 提示「四条临时豁免已可删除」），补门的 PR 零摩擦。若当初用的是等式，
#5710 一合本 spec 就会红。2026-09-21 rebase 时按提示删掉了那四条豁免 —— 清理动作发生在
**守卫允许的时间**，而不是被守卫逼着和别人的 PR 抢合并顺序。

同理，豁免分两类（`Exemption.todo`），差别只在「门补上之后怎么办」：

| 类别 | 标记 | 理由性质 | 门补上之后 |
|---|---|---|---|
| **永久豁免** | 无 `todo` | 设计上就不该有中间件门（只读探针 / 自带 in-handler 门） | **硬红** —— 理由不再成立，必须来删豁免 |
| **临时豁免** | 有 `todo`（issue/PR 号） | 已登记、有人在修的洞 | **不红**，只 `console.warn` 点名「这几条已可删除」 |

这条区分不是为了少红，而是因为两类豁免「门补上了」这件事的**含义相反**：永久豁免那边意味着
「设计变了，没人记账」，临时豁免那边意味着「我们盼着的修复到了」。

今天 `TEMPORARY_EXEMPTIONS` 为空（上一批已随 #5710 收口），所以「临时」这一路是**有意保留的空位**：
下一个「已登记、有人在修」的洞直接填 `todo` 即可。空位不等于死代码 —— spec 里新增了一条
`豁免表 > 临时/永久分类机制在临时豁免表为空时仍是活代码（合成豁免自证）`，用两条不进 `EXEMPTIONS`
的**合成豁免**（一条指向有门路由、一条指向无门路由）把分类路径每次都真的跑一遍，并断言合成品
没有污染真实判定。没有它，`临时豁免：已可删除的条目只点名提示` 那条用例在空表上是恒绿空转，
分类逻辑烂掉也看不出来。

### 4.1 admin-routes.ts 本体（3 条，**全部是永久豁免**）

| 方法 + 路径 | 理由 |
|---|---|
| `POST /health/check` | 只读探针。handler（`admin-routes.ts:2347-2372`）只调用 `getHealthAggregator().checkHealth()` 取一次快照并回摘要，不写任何状态。#5665 设计 §2.1 据此判定它不属于「写/破坏性」面，未加门。「任意已认证用户可触发的探测/放大面」记在 #5665 §4 残余第 4 条，属读侧，本守卫不管。 |
| `POST /plugins/reload-all-unsafe` | 自带 in-handler 双门（`admin-routes.ts:836-851`）：`ALLOW_UNSAFE_ADMIN !== 'true'` → 403 `UNSAFE_DISABLED`；`req.user.roles` 不含 `'admin'` → 403 `ADMIN_REQUIRED`。它不属于「只靠确认层」那一族。但这条角色判断读的是 **token 上的 `roles` 数组**，而 `requireAdminRole()` 查 `user_roles` 表 —— 两套 admin 口径共存是 #5665 §4 残余第 5 条登记的待统一项，统一之前不强求它换成中间件门。 |
| `POST /plugins/:id/reload-unsafe` | 同上，in-handler 双门在 `admin-routes.ts:887-902`；口径不一致同样记在 #5665 §4 残余第 5 条。 |

### 4.2 子路由 `/safety/rules`（`protection-rules.ts`）—— 曾有 4 条临时豁免，**2026-09-21 已删**

初版把这四条写端点登记成 `todo: '#5667'` 的**临时**豁免：当时它们真的零授权门，且身份取自
**可伪造的 `x-user-id` 请求头**（#5665 设计 §2.1 / §4 残余第 7 条已登记），issue **#5667** /
W4-A 分支 `fix/protection-rules-require-admin-and-identity`（**PR #5677**）正在修。

**该修复已经过 #5710（`188be8500`）合入 main。** 实读 `origin/main` @ `309b551eb`：

| 方法 + 路径 | 源位置（门在首位） |
|---|---|
| `POST /safety/rules` | `protection-rules.ts:236` —— `router.post('/', requireAdminRole(), ...)` |
| `PATCH /safety/rules/:id` | `protection-rules.ts:328` —— `router.patch('/:id', requireAdminRole(), ...)` |
| `DELETE /safety/rules/:id` | `protection-rules.ts:369` —— `router.delete('/:id', requireAdminRole(), ...)` |
| `POST /safety/rules/evaluate` | `protection-rules.ts:392` —— `router.post('/evaluate', requireAdminRole(), ...)` |

所以 rebase 时把这四条豁免**删掉**了，并把 §5 第 4 点的「只记录不表态」改成硬断言（见 §5）。
它们现在走的是主路径：有门 → 不进 `ungated` → 谁把门摘了就撞核心不变量（不在豁免表里的无门写路由 = 红），
外加 `子路由挂载面 > /safety/rules ... 四条写路由都有门（#5710 补，回归钉）` 这条逐条钉住。

这次清理本身就是 §4.0 那个「⊆ 而非 =」权衡兑现的地方：#5710 合并时本 spec 没有红，只在
`豁免表 > 临时豁免：已可删除的条目只点名提示、不挡合并` 里打出提示 ——

```
[结构性守卫] 4 条临时豁免已可删除 —— 对应路由已经补上 admin 门：
  - POST /api/admin/safety/rules  (todo: #5667)
  - PATCH /api/admin/safety/rules/:id  (todo: #5667)
  - DELETE /api/admin/safety/rules/:id  (todo: #5667)
  - POST /api/admin/safety/rules/evaluate  (todo: #5667)
请在对应 issue 收口时从本 spec 的 EXEMPTIONS 里删掉这些条目。（这里只提示不失败：修洞的 PR 不该因为本 spec 而被挡住。）
```

—— 这段 warn 是 2026-09-21 在 main 上**实跑出来的原样输出**（rebase 后、删豁免前），初版验证文档
§2.2 M4 用变异预演的那个场景就此变成了实测。清理在守卫允许的时间点完成，没有和别人的 PR 抢合并顺序。

### 4.3 明确**不**豁免的一条

`POST /safety/confirm` 自带 `requireAdminRole()`（`admin-routes.ts:166-172`，在 `...protectConfirmationEndpoint()`
之前）—— 实读核实过，它**直接通过**结构性检查，不进豁免表；并且被列进「#5665 补门的那一族逐条仍然有门」
的回归钉里。

### 4.4 豁免表自身的守卫

| 用例 | 硬红？ | 管什么 |
|---|---|---|
| 每条豁免都对应一条真实存在的写路由 | **是** | 路由删了，豁免也得删（禁止残留过期豁免） |
| **永久**豁免不得覆盖已经有门的路由 | **是** | 门补上了 = 「设计上不该有门」这个理由不成立了，必须来删 |
| **临时**豁免：已可删除的条目只点名提示 | 否 | `console.warn` 列出条目 + `todo` 号；断言的是这份清单**良构且有界**（每条都带 `todo`、不多于临时豁免总数），不是「必须为空」 |
| **临时/永久分类机制在临时豁免表为空时仍是活代码**（合成豁免自证） | **是** | 临时豁免表为空时上一条是恒绿空转；这条用两条不进 `EXEMPTIONS` 的合成豁免把分类路径真的跑一遍，并断言合成品不污染真实判定 |
| 每条豁免都写了理由；临时豁免的 `todo` 必须是 `#<号>` | **是** | 防止「空理由豁免」和「随手写个 todo 字符串」 |
| **无门写路由 ⊆ 豁免表**（核心不变量） | **是** | 出现没登记的洞就红；只有子集关系，没有等式 |

这里有一条刻意的**缺席**：核心不变量里**没有**「无门写路由必须非空」。加上它会让
「所有洞都补完、豁免表清空」这个最好的结局反而变红。「豁免表确实在承担工作、不是空转」这件事
由变异自证那一族负责（见 §3.4 与验证文档 §2）。

---

## 5. 子路由挂载面

`admin-routes.ts:2386-2387` 挂了两个子路由：`/snapshots` → `snapshot-labels.ts`，
`/safety/rules` → `protection-rules.ts`。测试断言：

1. `router.use` 挂的子路由集合**恰好**等于 `['/snapshots', '/safety/rules']` —— 新增子路由必须来这里登记，
   顺带强制新挂的子路由过一遍「它的写路由有没有门」的眼。
2. admin router 顶层**没有任何 `use` 级中间件**（今天实测为 0 条）。这条不是洁癖：本守卫「逐条写路由必须
   自带门」的**充分性**建立在「挂载面上没有一层统管的门」之上。将来真要在挂载处套门，这条会红，到时候
   必须回来重新论证守卫的充分性，而不是默默放宽。
3. `/snapshots` 三条写路由（`PUT /:id/tags`、`PATCH /:id/protection`、`PATCH /:id/release-channel`，
   `snapshot-labels.ts:40/74/109`）逐条有门。
4. `/safety/rules` 四条写路由：**路径集合**与**门的有无**今天**都是硬断言**。
   初版这里只记录不表态（`console.warn` 点名「已有 N/4 条补上了 admin 门」），因为当时 #5677 还在飞，
   硬判 `false` 会把两支耦合成固定合并顺序。#5710 已把四条门合入 main，耦合的前提消失，
   2026-09-21 rebase 时改成与 `/snapshots` 同款的硬断言 —— 这四条门从此是回归钉，
   谁摘了门，除了核心不变量红，这条也会点名红。

express 4 的 `use` layer 不保留原始挂载路径（`layer.path` 恒为 `undefined`），只留编译好的 regexp。
测试里的 `decodeMountPath` 从 `regexp.source` 反解挂载路径，**并用同一个 regexp 回验反解结果** ——
解错了就抛异常，不会悄悄给出一个错的挂载点。

---

## 6. 与 #5665 / #5667 的关系

- **#5665**（分支 `fix/admin-safety-toggle-and-bulk-require-admin`，本分支的基线）：逐条补门 + 行为级
  spec（`tests/unit/admin-safety-toggle-and-bulk-authz.test.ts`，18 个用例，走真实 HTTP 断 403 码与
  「kysely 零调用」）。本守卫**不替代**它 —— 行为级 spec 证明「门真的挡住了」，结构性守卫证明「门一条不漏」。
  两者各管一半：前者深、后者宽。
- **#5667 / PR #5677 → 已由 #5710（`188be8500`）合入 main**：修 `/safety/rules` 那四条。初版把它们放进
  **临时**豁免（`todo: '#5667'`），并断言「两支互相独立、合并顺序任意」。**这条断言在现实里兑现了**：
  #5710 先合，本支 rebase 到 main 后跑起来仍然全绿，只多两段 warn 提示「四条临时豁免已可删除」
  （2026-09-21 实跑输出见 §4.2）。按提示删掉那四条豁免、并把 §5 第 4 点改成硬断言，是本次 rebase 的内容。
  这是刻意设计的（§4.0），初版用 M4 变异预演（验证文档 §2.2），这次是实测。
- **#5914**（`ce9ac29cb`，`/slo/status` 与 `/snapshots` 子路由补 `requireAdminRole`）：它把本文件
  §3.4 正反自证表里那条「`GET /slo/status` 已知无门」的**反**例变成了假的。rebase 时改成正向对照
  （见 §3.4 的订正说明）。它不改变写路由集合，本守卫的判定面不受影响。
- **#5903 / #5678 批次**（admin 读侧 `sendAdminReadFailure` 与读门）：只动读侧，不动写路由集合，
  与本守卫无交集。
- 本分支**没有**动 `admin-routes.ts`、`protection-rules.ts`、`snapshot-labels.ts` 任何一行，也没有动
  `.github/workflows/*`、任何 pin 文件、任何 `plugins/`。

---

## 7. 残余（本次**没有**解决，明确记账）

1. **`/api/admin` 挂载处仍然没有统一角色门。** 本守卫把 #5665 §4 残余第 1 条从「逐条加固、没有面上保证」
   降级成「逐条加固 + 一条会红的结构性守卫」，但它**不是**运行时防护 —— 它只在 CI 跑测试时说话。
   真正的根治仍是挂载处套门（需先核对读端点可见性契约），该条残余**保留**。
2. **读侧完全没管（边界未变，事实已变）。** #5665 §4 残余第 7 条登记的那批无门 GET
   （`GET /dlq`、`/queues`、`/shards*`、`/ratelimits*`、`/slo/status`、`/health/*`、`/safety/status`）
   已由 #5678 批次 / #5914 陆续补门。**但本守卫的边界不变**：它仍然只管写方法，读侧有没有门、
   将来会不会重新开洞，本文件一律不表态 —— 那需要另一条同形的读侧守卫（#5914 自带闭世界扫描）。
   这里只订正一个事实：初版把 `/slo/status` 当「已知无门的读路由」用作反向对照，那条对照已随
   #5914 失效并在本次 rebase 改成正向（§3.4）。
3. **守卫只覆盖 `admin-routes.ts` 这棵树。** `index.ts` 上还有 `/api/admin/directory*`、
   `/api/admin/canary` 等**另外挂载**的 admin 路由（`index.ts:1984` 之后的那一批 `this.app.use('/api/admin/...')`），它们不在这棵树里，本守卫
   看不见。把守卫推广到整个 `/api/admin` 前缀是可做的下一步，但需要先逐个 router 核对它们各自的门形态。
4. **「首位是门」是结构条件，不是语义证明。** 它保证了「非 admin 在跑到任何业务逻辑前就被 fail-closed
   挡住」，但不保证门后面的 handler 自身没有别的问题（比如 #5665 §4 残余第 2 条：bulk 写仍无租户注入、
   无字段白名单 —— 平台 admin 能跨租户改任意列这个语义没有收紧）。
5. **`*-unsafe` 两条与 `requireAdminRole()` 的 admin 口径仍不一致**（token `roles` 数组 vs `user_roles`
   表）。本守卫把它们放进豁免表 = 把这个不一致**记账**，不是认可它。口径统一是 #5665 §4 残余第 5 条。
6. **`POST /safety/rules/evaluate` 是否真属写面，仍未裁决 —— 但已不影响本守卫。** 它触发规则求值、
   不落库，初版按「POST + 吃 body」的保守口径登记进豁免表。#5710 给它加的是与另外三条同款的
   `requireAdminRole()`（`protection-rules.ts:392`），所以无论它算读算写，今天都在门后；
   豁免表里已无它的条目。语义上「求值是否只需读权限」这个问题保留，归 #5667 一线。
7. **临时豁免的清理没有强制力，只有可见性。** 这是 §4.0 那个权衡的另一面：为了不把独立 PR 耦合成
   固定合并顺序，「该删的临时豁免」只能靠 `console.warn` 提醒。理论上一条临时豁免可以在洞修好之后
   长期留着不删（无害，但是噪声）。真要收紧，可做的是给 `todo` 加一个「到期日/到期 PR」再配一条
   定期巡检，而不是把它变成硬红。本次不做。
   （实测数据点：`/safety/rules` 那四条从「#5710 补门」到「本次 rebase 删豁免」之间，
   确实以 warn 的形式在 CI 日志里挂了一段时间才被清掉 —— 机制按设计工作，代价也确实是噪声。）
8. **`all.length` 等下限是经验值，不是证明。** `写路由确实被收集到了` 用 `≥30` / 有门 `≥26`
   兜住「整片没收集到」「匹配器全失灵」两种空转绿（2026-09-21 在 main 上实测：写路由 32 条，
   其中 29 条有门、3 条无门）。下限比实数低几条是为了容得下正常的路由收编；真降到下限以下时，
   正确动作是回来连同实测数一起更新，而不是把下限调低了事。这条靠人守，守卫本身拦不住。

---

## 8. 落点

- 测试：`packages/core-backend/tests/unit/admin-routes-write-endpoints-structural-gate.test.ts`
- 验证记录：`docs/development/admin-routes-structural-gate-verification-20260912.md`
