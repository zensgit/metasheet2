# PLM ↔ MetaSheet 数据对接线 — 余下开发 + 设计与验证 MD（2026-07-11）

> **性质**：owner `/goal`「这条数据对接还有哪些开发要完成，完成后给出设计及验证 MD，自动处理开发任务」一轮的交付。
> **口径先行（如实）**：本轮**可自主开发的池 = 1 项**（CI 守卫，已落 #4136）。其余**全部 gated**——不是「都开发好了」，
> 而是「自主层已清空，剩余需 owner 动作」。见 §6。

## 1. 方法

对 `origin/main` 只读勘察（一个 Sonnet 广度 survey + 我对每条承重结论逐条复核，不采信未验证断言）。所有 file:line 均已实证。

## 2. 线的现状（实证）

### 2.1 READ 路径 —— 已上线、成熟

- **路由** `packages/core-backend/src/routes/plm-embed.ts`：仅 2 个端点 `GET /api/plm-embed/config`、
  `GET /api/plm-embed/bom-review/context`。守卫链：`embedTokenAuth` → feature_key 校验 → origin 允许名单
  （**从不 `*`**）→ **服务端配置的**数据源（绝不取请求提供的）→ tenant 交叉核对 → **jti 单次消费**。
  **永不 500**：provider 抛错降级为 `{context:null, reason:'unavailable'}`（:142）。
- **FE**：`apps/web/src/views/PlmEmbedBomReviewView.vue`（**LISTEN-only**，outbound `postMessage` 计数 = **0**）
  + `apps/web/src/services/integration/plmEmbed.ts`。
- **后端测试**：`plm-embed-routes.test.ts`（27 例：`/config` fail-closed、字面 `*` 剥除、provider-throws 降级不 500、
  tenant false-closure、jti 重放）——在 **required `test (20.x)`** 内跑。**读路径后端覆盖已充分**（我逐项核过，不制造 finding）。
- **Discussion READ 适配器已合入但是死代码**：`PLMAdapter.getDiscussions()` / `getDiscussionThread()`
  （`PLMAdapter.ts:2433-2501`），pact 已验（`pacts/metasheet2-yuantus-plm.json`，41 interactions），
  `isFeatureAvailable`（:681，#4020）。**`git grep` 全仓零调用方**——无路由、无 UI 消费。C1 就是给它接线。

### 2.2 WRITE 路径 —— main 上一行都没有

`exchangeDiscussionSession` / 6 个写方法 / `routes/plm-embed-discussion.ts` 在 `origin/main` **均不存在**，
全部只在 **#4110**（Lane C consumer，owner-HELD）与 **#4113**（write-relay，owner-HELD，stacked on #4110）里。

### 2.3 write-UI + 令牌协议 —— 未建

`PlmEmbedBomReviewView.vue` 无任何 `token-request`/`token-response` 处理、无评论输入表单。
其 taskbook 已 **RATIFIED（2026-07-11，owner 显式 GO）**，但**实现 gated** 于 Option A 合并序列
（P1-a → provider-pact → #4110 → #4113）。

## 3. 本轮的两个实质发现

### 3.1 【已修，#4136】PLM-embed 前端 27 个测试跑在**零个** workflow 里

- **实证**：`grep -rl "plm-embed" .github/workflows/` → **空**；required `web-tests` 的精选清单
  `run-required-web-tests.sh` 里 **0 条 plm**；required `test (20.x)` 对 apps/web **只跑 build，从不跑 vitest**。
- **后果**：`plm-embed-bom-review.spec.ts` + `plm-embed-service.spec.ts`（27 测）**在任何 CI 里都没跑过**——
  而它们钉的是**跨源嵌入的安全不变量**：子页 LISTEN-only、只接受**唯一一个**来自
  `event.source === window.parent` 且 origin 在允许名单内的 token（绝不 `*`）；以及 `{context:null, reason}`
  降级路径**不得渲染成错误**。build-only 的门**抓不到**这类回归。
- **修**：`.github/workflows/plm-embed-web-guard.yml`——path-filtered、**非 required**（与
  multitable/approval/attendance web-guard 同约定，永不卡 PR，但让静默 FE 回归变成可见的红）。
  **后端路由 `plm-embed.ts` 也是触发路径**：它拥有客户端 spec 所钉的响应形状，wire 形状变更必须**两侧同扫**（家规）。
- **验证**：接线时 **27/27 绿**（守卫不会一上来就红）；**5 条 path-filter 目标在 main 上全部存在**
  （匹配不到任何文件的 filter = 静默死守卫）；YAML 可解析；vitest filter 精确解析为**恰好这 2 个 spec**。

### 3.2 【新发现，重塑 C1】令牌预算：**一个 token = 恰好一次调用**

- `plm-embed.ts:103-110`：jti 在**查询之前**被**原子消费**——*"a replay of a still-valid token cannot fetch
  data a second time"*；无 jti ⇒ 401；store 不可用 ⇒ **fail closed**（503）。
- `PlmEmbedBomReviewView.vue:119`：**第一个**有效 token 生效，其余忽略；子页 **LISTEN-only**（outbound
  postMessage = 0；:59 甚至写着一个 pinned-origin 变量 *"kept for any future outbound use (none today)"*）。
- 父页每次挂载只铸**一个** token、单向投递。

⇒ **一次挂载 = 一个 token = 一次认证调用 = 一份 payload。子页今天拿不到第二个 token。**

**这重塑了 C1**：C1 与写**凭据**（session-exchange / `DISCUSSION_SESSION_ENABLED`）无关——但与令牌**供给****有关**。
任何需要第二次调用的 C1 形态（点开线程看评论、翻页、刷新）都**继承与写路径完全相同的阻塞**。故 C1 一分为二：

- **C1-a（未 gated）**：把**有界的**首页线程**折进已有的** `/bom-review/context` 响应——子页本来就用它那一个 token 发的那次调用。零新端点、零协议改动、零门。
- **C1-b（gated）**：交互式读（详情/翻页/刷新）——每次都要**额外的 token** ⇒ **需要那个 gated 的令牌协议**。

**结论（本轮最有价值的一条）**：**按需令牌协议是整个 discussion 面（读的交互半边 + 全部写）的唯一解锁点。**
C1-b 不应单独立项，它是 write-UI 令牌协议实现的搭车项。设计锁见
`plm-discussion-c1-read-panel-design-lock-20260711.md`（PROPOSED，含 §9 四项决策的建议解）。

### 3.3 【落地告警，未动手】#4113 的 required 检查**从未跑过**

#4113 的 base 是**功能分支**（#4110 的分支），而 4 个 required 检查（contracts×3 / test 18.x+20.x / web-tests）
在其 workflow 里都以 `branches: [main]` 触发 ⇒ **对 #4113 从未触发**。它的 `mergeStateStatus: CLEAN`
**不是**「已验证」的证据——只有 3 个检查真的跑过。**落地时必须先把 base retarget→main**（家规：stacked-PR
落地前所有子 PR base 先改 main），required 检查才会真正跑。**已 flag，未动手**——#4113 是 owner-HELD，
held PR 只做 watch-only。

## 4. 本轮交付

| # | 项 | 类型 | 状态 |
|---|---|---|---|
| 1 | `plm-embed-web-guard.yml` —— 补上 27 个前端测试的 CI 门 | **实现（零 runtime，CI 配置）** | **PR #4136**，auto-merge armed |
| 2 | C1 read-panel 设计锁（含令牌预算约束 + §9 四决策建议解） | **gate-front 设计（零 runtime）** | 本 PR，**PROPOSED 待 owner ratify** |
| 3 | 本 MD（余下开发 + 设计与验证） | 记录 | 本 PR |

## 5. 验证台账

| 断言 | 证据 |
|---|---|
| 27 个 FE 测试此前跑在零 workflow | `grep -rl plm-embed .github/workflows/` = 空；`run-required-web-tests.sh` plm 条目 = 0；`test (20.x)` 对 apps/web 只 build |
| 新守卫不会一上来就红 | 本地 27/27 绿，且文件与 origin/main 逐字节相同 |
| **守卫真的会触发并通过（不是「纸面正确」）** | **#4136 自身即实证**：guard 把自己的 workflow 文件也列进 path-filter，故在 #4136 上**真的触发了**——`plm-embed-web-guard` **pass 28s**（run `29178569233`，三次 run 全 success）。这是**活的 CI 证据**，非「本地绿+YAML 合法」的推断 |
| 守卫不是「死 filter」 | 5 条 path-filter 目标在 main 上**逐条存在**（实测） |
| filter 精确 | vitest filter 解析为**恰好** 2 个 spec / 27 测 |
| 一 token 一调用 | `plm-embed.ts:103-110` jti 查询前原子消费；`PlmEmbedBomReviewView.vue:119` 首个 token 生效；outbound postMessage = **0** |
| Discussion 读适配器是死代码 | `PLMAdapter.ts:2433-2501` 存在且 pact 已验，但全仓**零调用方** |
| 写路径不在 main | `exchangeDiscussionSession` / `plm-embed-discussion.ts` 在 origin/main **不存在** |
| #4113 未被 required 检查验证 | 其 base = 功能分支；4 个 required workflow 以 `branches:[main]` 触发 ⇒ 未触发；实际只跑了 3 个检查 |

## 6. 余下开发与**谁能解锁**（如实，非「都做好了」）

| 项 | 门 | 谁解锁 |
|---|---|---|
| **C1-a 有界读面板** | C1 设计锁 §4 四决策待 ratify（taskbook 明写「doc-only，不自证授权实现」） | **owner 一句 ratify** → 我即可开建（S/M） |
| **C1-b 交互式读** | 需按需令牌协议 ⇒ 与 write-UI 同一阻塞 | 同下 |
| **#4110 / #4113 合并** | 二者均 **owner-HELD**（"HELD — owner-word merge"）；#4113 还须先 retarget base→main 才会真跑 required 检查（§3.3） | **owner 发话** |
| **P1-a + provider-pact（Yuantus 侧）** | 只在 Yuantus 功能分支上，未进 Yuantus main | **owner**——我在该仓只有 **deploy-key 级**权限：可推分支，**不能合 protected main**；两个 gh 账号对 `adharamans/yuantus-plm` **均 404** |
| **write-UI + 令牌协议实现** | taskbook 已 RATIFIED，但实现 gated 于 P1-a → provider-pact → #4110 → #4113 全部落地 | 上面四项全落地后 |

**收官口径**：本轮**自主可开发的池已清空**（1 项，#4136 已落）；C1-a 已推到 **gate-front**（一句 ratify 即可开建）；
其余全部需 owner 动作（两个 HELD PR 的发话、Yuantus 侧两个分支的合并——后者我无权限）。**并非「这条线开发完了」。**
