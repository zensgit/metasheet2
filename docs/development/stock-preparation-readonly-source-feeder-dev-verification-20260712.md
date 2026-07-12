# 备料只读来源接入 feeder(#4093 / #3889)— 设计与验证记录 — 2026-07-12

> 「数据库及系统连接」开发线上**最后一项实质开发**。落地:#4093 MERGED `c70595e72`。
> 本文记录它从初版到落地的**五轮独立对抗审阅弧**。**本文是记录,不是授权。**

## 0. 一句话结论

**完整性必须可证;不可证即 fail-closed。**

一个"看起来完整"的读,在证明不了自己**没漏行、没漏字段**之前,**不许报 `ready`**。
五轮审阅挖出的四个 P1,全是这一条原则在不同侧面上被违反。

## 1. 为什么需要五轮 —— 缺陷会"变形"

feeder 把外部只读源的行喂进备料 intake。它的**每一版都能跑通 happy path**,
每一版也都在**某一条真实通道上静默丢数据,并报 `ready` / `rowErrors: 0`**:

| 轮 | 静默通道 | 真适配器 end-to-end 实测 |
|---|---|---|
| R1 | **行截断** | bridge 5000 行源 → 吃进 **20 行**,`ready` |
| R2 | **行截断(另一条)** | 真实 BOM **树** 2500 行 → 吃进 **3 行**,`ready` |
| R2 | **翻页从未发生** | 不认 PageIndex 的 K3:同一页读 10 遍 → 被 `declared_total` 背书为"完整" |
| R3 | **字段清空** | 在探针里 100% 干净的 config → feeder 里 2500 行 `designQty` **全 null**,`ready` |
| R4 | **值被覆盖** | 重复 fieldMap target:已读到的真实值被后一条 entry 的 null **覆盖**(顺序相关) |
| R5 | **守卫本身可绕过** | `constructor` / `toString` 当字段名 → 在 **0 行**上解析到,却走过字段守卫 |

**每一轮的修复都是真的**(下一轮独立复验逐条确认),**但前三轮每修好一条,就在相邻的层开出一条新的**。

这不是实现质量问题,而是**这类缺陷的本质**:任何"看起来完整"的信号 ——
`done: true`、我们请求的 pageSize、探针的成功、计数器非零 —— **都可以在某条真实路径上撒谎**。
**只有结构上不可伪造的证明才作数。**

## 2. 最终形态 —— 四道结构性证明

### 2.1 行的完整性:证明,而非声明

- **永不相信 `done: true`** —— 被夹取的那一页,报的正是 `done: true`。
- 满页判定用**适配器生效的上限**(`page.effectiveLimit`),而不是**我们请求的** pageSize。
- 生效上限是**每个 kind 的显式契约**(`limitContract`);**缺报即不可证,绝不回落到请求值**。
  一条测试断言**每个 shipped kind 都声明了它** —— 新增 kind 忘了声明 → 红。
- 结构上无法翻页的 kind 返回满页 → **502 `SOURCE_RUN_COMPLETENESS_UNPROVABLE`**。

### 2.2 翻页确实发生了:证明,而非假设

源必须**回显它服务的那一页**(`echoedPageIndex`);回显不上、或根本不回显 → **翻页不可证 → fail-closed**。
外加**机制无关的页指纹** —— 它还挡住了审阅另造的「**回显正确页码、却仍然服务第 1 页**」的欺骗源。

> **把第 1 页读十遍,不是证明。**

### 2.3 读的是"实际会吃进去的那个面"

feeder 吃**适配器归一化后的记录面**(展平 / 翻页 / 字段别名归一化都在这一层;
未加工载荷里,一棵 BOM 树只是**一个根节点**)。

### 2.4 字段没有被静默清空

- 一个已配置的字段**在一行上都解析不到** → **422 `SOURCE_RUN_FIELD_MAP_UNRESOLVED`**
  (这不是稀疏列,是**配错了字段名**)。
- 解析统计从**实际发出的那一行**派生,**不是**"有任一 entry 解析成功" → **结构上免疫顺序与重复**。
- 配置校验器拒 `duplicate_target`,且**执行时再校验一遍** —— 存量**已 approved** 的旧 config 同样 fail-closed。
- 计数器 `Object.create(null)` + **own-property 正计数**判据 —— prototype 成员名不能满足守卫。

## 3. 诚实边界(实测,非推断)

| kind | 续读机制 | **可证**行数上界 |
|---|---|---|
| `plm:yuantus-wrapper`(带翻页 client) | offset cursor | ≤ 9,999(**含树形**) |
| `plm:yuantus-wrapper`(不带翻页) | 无 | ≤ 999 |
| `data-source:sql-readonly` | offset cursor | ≤ 9,999 |
| `erp:k3-wise-webapi` | bounded pageIndex 1..10 | ≤ 100,**且必须回显 PAGEINDEX + 声明 ROWCOUNT** |
| `bridge:legacy-sql-readonly` | **无** | **maxLimit − 1(默认 19)** |
| `erp:k3-wise-sqlserver` | **无** | 一页 |

**超出上界一律 fail-closed。** bridge 的 19 行看着难看,但另一条路是**继续把 20 行的快照谎报成"完整"**。

`detail_with_lines` **被明确拒绝**,而不是假装支持(header / lines 只存在于未加工载荷面)。

## 4. 一个被审阅背书的"相反决定"(记录在此,因为它是对的)

探针路由的默认数据面**保持未加工载荷面**,而**没有**翻成 feeder 执行的记录面。理由:
该路由服务**所有 mode**,而记录面**在构造上表达不了** `detail_with_lines` / `resolver_lookup`;
翻默认会打断这些 config,并**静默改变**已 approved 的 config 在一条 shipped 路由(#1709 S3-2)上返回的映射值。

> 实现方**顶住了编排方的相反倾向**,给出代码级理由(mode 围栏);
> 独立审阅查证后**背书该决定,并撤销了自己上一轮的 finding**。

代价:探针 parity 是「**可用,非自动**」(`rowSource` 可切)。
真正保护 feeder 的**不是探针,而是 feeder 自己的守卫** —— 未加工面写出来的 config
现在会**大声失败**,而不是吃进一堆 null。

## 5. 验证

- **五轮独立对抗审阅**(非自审),每轮**真适配器 end-to-end**,不用 mock 顶替。
- **mutation 台账(终版)**:24 个 mutation / **22 KILLED / 2 SURVIVED by design**。
  两个存活项是 prototype 防护的**冗余双层**(单删任一层,另一层仍独立堵住该洞),
  而**精确复现真实缺陷的那个组合 mutation(裸查找 + 普通 `{}`)是 KILLED 的**。
  > **如实记录,不凑 24/24。** mutation testing **证明守卫承重,不证明守卫正确** —— 这是它的已知边界。
- **四轮返工中 20+ 道旧守卫逐个 mutation 复验:零丢失** —— 只读边界 · 仅 multitable 内部写
  (无外部写 / apply-writer / K3 Save-Submit-Audit / raw SQL 写)· values-free 投影 ·
  admin 403 门 · approved-only · 「永不信 `done:true`」· TOO_LARGE · project scope · intake 必填字段。
- 全链 `npm test` **EXIT=0**(87 个 `&&` 串联的 node 调用)。

### CI 口径(如实)

该 CJS 测试链**只在 `integration-guard.yml` 跑,不是 required check** —— **CI 全绿 ≠ 它过了**。
以上结论均为**本地实跑**。

## 6. 已知限制

1. **`duplicate_target` 规则是追溯性的**:执行路径会重新校验存量 config,因此**已 approved 的
   重复 target 旧 config,从此在 shipped `/read` 路由与 composition 上 400** —— **大声失败,
   因为它本来就在丢数据**。全仓 templates / presets 命中 0。
2. 探针 parity 是 opt-in(见 §4)。若需要一个**默认走记录面的备料专用预览面**,是一个干净的 follow-up。
3. `bridge` / `k3-sqlserver` 结构上无法翻页 —— 超过一页即拒。这是**诚实**,不是缺陷。

## 7. 本线状态(口径,勿越界)

- **本 PR 关闭的是**:#3889 下的**只读来源接入 feeder**。这是本线**最后一项实质开发**。
- **本文不宣称**「数据库及系统连接线全部完成」。仍在推进的独立项:
  - **corrective-6(#4126)** —— 实体机 on-prem 启动依赖修复 + production-install 启动契约 guard,
    **owner hold 中,未合并**;
  - **实体机验收** —— 统一在 **#4101** 追踪(历史 #3751 已 404);PASS 判据 =
    `mvpSmoke.pass=true` + `auditActionsCovered=8/8` + `selfScanClean=true`。
