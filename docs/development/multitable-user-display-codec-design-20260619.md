# 用户展示名 codec — 设计(future DRY consolidation)

> **状态**:**DESIGN / FUTURE(opt-in)**。owner 2026-06-19:`resolveUserDisplayNames`(#2928)与 `buildPersonSummaries` 各有一套 user-display 查询逻辑;当前可接受(person summary 还要 `is_active` 等额外语义)。**本文是"下次再碰 user-display 层时"的抽取设计,不要求为 #2928 返工。**
> **口径**:MetaSheet 自有设计;不引用竞品。
> **基线**:代码实测 @ `origin/main`(`packages/core-backend/src/multitable/user-display.ts`、`routes/univer-meta.ts` `buildPersonSummaries`)。

## 0. 一句话

把"`users` 行 → 展示名"的**两处重复**(查询 + `name → email` 偏好)收敛到**一层低阶 codec**:一个纯函数(偏好规则)+ 一个共享 loader(单一 `SELECT`)。两个上层消费者(actor 名 / person summary)各自只保留其**领域语义**(id-fallback vs is_active 标记、actor-list vs field-record 迭代)。目标是**消除偏好漂移**(真正的风险),而非合并领域逻辑。

## 1. 现状(两套,verified)

| 消费者 | 查询 | 展示偏好 | 额外语义 |
|---|---|---|---|
| `resolveUserDisplayNames(query, ids)`(#2928,actor 名:history `actorName` / trash `deletedByName`) | `SELECT id, email, name FROM users WHERE id = ANY($1)` | `name \|\| email`,**两者皆空 → omit**(caller 回退原始 id) | 无 |
| `buildPersonSummaries(...)`(person 字段 summary) | `SELECT id, email, name, is_active FROM users WHERE id = ANY($1)` | `name \|\| email \|\| id`(**id fallback**) | `is_active === false → inactiveUserIds`(2c-S4 read-only 标记) |

**重复点**:(a)`SELECT … FROM users WHERE id = ANY` 几乎一致(仅差 `is_active` 列);(b)`name → email` 偏好逻辑**两处各写一遍**。
**真正风险 = (b)**:偏好规则漂移(某天一处改成 `email → name` 或加 `username`,另一处不改 → 同一用户在 history 与 person 字段显示不一致)。(a) 是次要(查询漂移)。

## 2. 设计:两层

### 2.1 codec(纯函数,单一偏好真相)
```
// 单一来源的"users 行 → 展示名"偏好。返回 null 表示无 name/email —— **id fallback 留给 caller**
// (actor 名 omit-when-null;person summary 回退 id),因为两者的"空"语义不同。
export function userDisplayName(row: { name?: unknown; email?: unknown }): string | null
//  = trim(name) || trim(email) || null
```
这是消除偏好漂移的关键:无论谁渲染用户,偏好只在这里定义一次。

### 2.2 loader(共享单一 SELECT,可选)
```
// 单一 `SELECT id, email, name, is_active FROM users WHERE id = ANY` + 去重 + 缺表 graceful。
// 返回富记录,上层各取所需。display 经 §2.1 codec 计算。
export async function loadUserDisplayRows(
  query: QueryFn, userIds: Array<string|null|undefined>,
): Promise<Map<string, { name: string; email: string; isActive: boolean; display: string | null }>>
```
带 `is_active`(person summary 需要),`display` 用 §2.1 codec。actor 路径忽略 `is_active`。

### 2.3 上层消费者(各保留领域语义,只换底座)
- `resolveUserDisplayNames` → 调 `loadUserDisplayRows`,投影 `Map<id, display>`,**display 为 null 的 omit**(行为不变)。
- `buildPersonSummaries` → 调 `loadUserDisplayRows`,取 `display ?? id`(id fallback,行为不变)+ `isActive` 填 `inactiveUserIds`;**field → record → summary 迭代不变**。

## 3. 迁移纪律(future opt-in,行为保持)
1. **不为 #2928 返工**(owner 明确);本设计在"下次碰 user-display 层"时落地。
2. **行为保持**:抽取后两个消费者的**对外行为逐字节不变**(actor omit-when-null;person id-fallback + inactive 标记)。靠现有测试守:`resolveUserDisplayNames` 单测(name→email/omit/dedup/缺表/trim)+ person summary 的 2c 真 DB 测试。
3. **单 PR、可回滚**:codec + loader 一刀;两个消费者改为调用一刀;无新表/无 schema。
4. **先 codec 后 loader**:若只想最小化,先抽 §2.1 纯 codec(消除偏好漂移,风险最低),§2.2 loader 可作为第二步(消除查询漂移)。

## 4. 不变量 / 非目标
- **不变量**:单一偏好真相(§2.1);缺 `users` 表 graceful(空 map / id fallback);不 permission-gate(展示名非敏感 —— 用户出现处皆可见;这是"动作的 actor",非记录内容);去重。
- **非目标(各自独立 gate)**:① 真正的**用户目录/名称解析服务**(跨多源、缓存、批量预取)—— 比本 codec 大,另起;② 跨租户/隔离语义;③ 展示名的 i18n/格式化(如"姓 名"顺序)—— 如需,扩 §2.1 codec 的单一入口;④ `username` 纳入偏好 —— 同样只改 §2.1 一处。

## 5. 验收(落地时)
- `userDisplayName` 单测:name 优先、email 次之、皆空 → null、trim。
- `loadUserDisplayRows` 单测:去重、空输入不查询、缺表 → 空 map、`isActive` 透传。
- 回归:`resolveUserDisplayNames` 现有 4 单测全绿(行为不变);person summary 2c 真 DB 测试全绿(display + inactive 标记不变)。
- tsc / vue-tsc 清。

## 6. 结论
低阶 `userDisplayName` codec(+ 可选共享 loader)把两处用户展示逻辑收敛到**一个偏好真相 + 一个查询**,同时让 actor 名与 person summary 各保留其"空"与 `is_active` 语义。**当前不动**(#2928 可接受);此设计是下次触碰该层时的 drop-in,先 codec(最小、消漂移)后 loader(消查询重复),行为逐字节保持,靠现有测试守。
