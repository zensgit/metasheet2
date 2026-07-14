# W0 可信数据底座 — 设计与验证记录(2026-07-14)

**类型**:波次收官记录(设计 + 验证台账,docs-only,零 runtime)。
**地位**:统一路线 W0(可信数据底座)的完成证据。W0 = 五段路线的硬门,先做实"可信"再谈观感与能力。
**来源**:owner /goal「按五段路线拆…W0 最高优先」+ D-1c 锁(RATIFIED 2026-07-13)。

---

## §0 一句话

W0 的三条完成标准全部达成,证据可核:**① 不存在无 revision 的权威数据写**(8 类写入口全补 + 守卫锁死回归)· **② 历史不完整时恢复零写入**(§0.6 fail-closed 预检)· **③ 每个 spec 属于明确 CI lane**(CI 清单 + skip-green 清除)。

---

## §1 落地台账(9 PR,全 MERGED,每件独立 Opus 门禁)

| # | 组件 | PR | 合并 SHA | 门禁 |
|---|---|---|---|---|
| 0a | CI lane 全量清单 + 9 红修复 | #4213 | — | MERGE_CLEAN |
| 0b | 135 个绿-but-invisible spec 接线 | #4217 | — | 静态核 + CI 实证 |
| 1 | **§0.6 `HISTORY_INCOMPLETE` 预检**(先行) | #4234 | `64791a356` | 双门禁(impl + 桶修 delta) |
| 2 | **刀① form** CREATE/EDIT(A1+A6) | #4245 | `8615879a2` | MERGE_CLEAN |
| 3 | **刀② plugin** create/patch(A2+A5)+ P1 竞态修 | #4246 | `212f8fd31` | MERGE_CLEAN |
| 4 | **刀③ automation** create/update(A3+A4) | #4247 | `232bd9d9e` | MERGE_CLEAN |
| 5 | **刀④ approval** resultWriteback(A7) | #4248 | `ead504038` | MERGE_CLEAN |
| 6 | **刀⑤ attachment** cell-strip(A8) | #4249 | `c179dc646` | MERGE_CLEAN + COMPLETION 核 |
| 7 | **OD-6 revision-disposition 守卫**(收官) | #4251 | `492c64d30` | MERGE_CLEAN |

**PR 量 = 9**,落在 owner 估算 7–10 内。

---

## §2 设计:三层防线

### §2.1 底层 — 8 类写入口全补 revision(治"洞")
D-1 当年只补了 side-door 的**删除**半边。审计实证:8 类 `meta_records` 写入口写了数据却不写 revision ⇒ `reconstructRecordsAtT`(PIT 视图 / sheet revert / reset 的读原语)返回**编辑前**的值 ⇒ 恢复到编辑后时点(本该 no-op)会**静默、不可恢复地毁掉成员编辑**(#4187 gate 真库实测执行过)。

**owner 裁决 OD-1 = 全量 A1–A8,分 5 独立 slice**(非 3 lanes):

| 刀 | 站点 | source(OD-2=写入入口) | actor(OD-3) | 零行契约 |
|---|---|---|---|---|
| ① form | EDIT `:14423` + CREATE `:14470` | `public-form` | 认证成员 / 匿名 null | **throw**(NotFound guard) |
| ② plugin | patch `records.ts:507` + create `:546` | `plugin` | null(SDK 无 actor 上下文) | **throw** + **真并发竞态 P1 修** |
| ③ automation | update `:2217` + create `:2475` | `automation` | `context.actorId ?? null` | **silent**(0行=成功不写 revision) |
| ④ approval | resultWriteback `automation-service.ts:2818` | `approval` | `chainActorId ?? null` | silent(原无 rowCount 检查) |
| ⑤ attachment | cell-strip `univer-meta.ts:15832` | `attachment` | `?? null` | throw(同 form 路由家族) |

**每刀独立验** txn 边界 / actor / source / revision 形 / PIT 正确性——不打成一个热核心大 PR。5 刀共 8 站点。

### §2.2 中层 — §0.6 `HISTORY_INCOMPLETE` 预检(治"信任",先行)
在 8 入口补齐**之前**就保护存量污染态:恢复类操作的 preview/execute **共用一个 fail-closed 预检**,历史有洞时统一返 `HISTORY_INCOMPLETE`、**不生成 execute token、零写入**。

**两个关键设计点**(复审补出、owner 裁决意图内):
- **比数据内容,不比 version**,且**只投影用户可写字段**——排除 formula/rollup/lookup/auto-number 派生类型(它们设计上写 `data` 不写 revision)。否则会对每张公式表的每条健康记录误报,把 revert/reset 直接封死。
- **枚举活行,不枚举重建集**——零 revision 的活记录没有 snapshot 可比;而 `computeSheetReset` 会把重建集里没有的活行推进删除集 ⇒ 若只迭代重建集就会**静默删除**它们。零 revision ⇒ `HISTORY_INCOMPLETE`。
- **execute 重检**(TOCTOU):preview 通过不授权 execute 跳过检查。

### §2.3 顶层 — OD-6 revision-disposition 守卫(治"回归")
对称 rank-8 lock 守卫:**每个 `meta_records` INSERT/UPDATE/DELETE 站点必须声明** `// revision-emitted:` 或 `// revision-exempt: <reason>`。防止将来新写入口悄悄重开这个洞。**排最后**——8 站点全修完它才绿(否则落在前面会把未修点标违规、CI 长红)。

---

## §3 验证:每刀门禁实证的硬点(不是橡皮章)

| 刀/件 | 门禁实证的那一处硬点 |
|---|---|
| §0.6 | **公式物化误报类**(复审亲手把快照改 patch → G4 合并陷阱 + §0.6 破坏性腿齐红,证明误报没从写侧回流);**零 revision 静默删除**(fail-open)补上;整库 deepEqual 证零写(非只看响应码) |
| 刀① | **快照完整性**:门禁把 EDIT 快照改成 `patch` → G4 + §0.6 齐红,证明全量 post-write 行快照 |
| 刀② | **真·双连接 Postgres 锁竞态**(非 sleep/trigger)证 P1:`pg_blocking_pids` 确定性阻塞 → 零行 UPDATE → 中和 guard 产真假 revision → **无 FK 复活确认** |
| 刀③ | **零行语义区分**裁定正确(automation「0行=静默成功不写 revision」≠ plugin throw);**实证 FK-less 幽灵复活**(神化 guard → 假 update revision 让 reconstruct 返 exists=true) |
| 刀④ | **事务嵌套隐患结构不存在**(writeback 是 fire-and-forget event-bus 订阅者 → withTransaction 永远顶层连接);**cross-base 写对 base** |
| 刀⑤ | **COMPLETION 交叉核查**:门禁独立 grep 确认 8 站点全 emit、**无第 9 个漏网用户数据写** |
| 守卫 | **`revision-pending` 后门双向堵死**(非白名单点自称 pending 红 / 缺口修好 stale-fail 红);14 个真实规避探针全抓;`meta_records_trash`/注释/字符串正确忽略 |

**共同主线**:每刀门禁都盯"快照完整性防 §0.6 误报回流" + "同事务原子性(中和 txn 证、非假设)" + "零行 fail-closed 防 FK-less 复活"。

---

## §4 一个如实记录的开放缺口(不算 W0 收官内)

**`:6522` field-undelete rehydration**:从 tombstone 写回真实用户单元格值,但无 version bump 无 `recordRecordRevision`。**owner OD-6 裁定 SHOULD WRITE REVISION**(覆盖 audit 的 debatable-EXEMPT)。它**不是**五刀范围(field-op 非 A1–A8)。

守卫**诚实处理**:不标 exempt(不诚实)、不伪造 emitted(也不诚实),而是第三态 `revision-pending` + `KNOWN_REVISION_GAPS` 具名白名单(恰一条),双向 hygiene 测试——别的点不能自称 pending,而这一项一旦真修好 pending 就 **stale-fail 逼摘**。**这是具名追踪的活债,需自己的 follow-up rung**(见 §5)。

---

## §5 收口清单(follow-up,非 W0 阻塞)

- **field-undelete `:6522` revision emit**(owner 裁定必写,独立 rung;摘 KNOWN_REVISION_GAPS)。
- **reset-pit deleteScopeHash 分歧测试**(§0.6 遮蔽,对应 slice 落后补 capture-complete 版)。
- **create-path 快照 auto-number 实测**(刀②/③ NIT:结构论证成立,但无实测钉死)。
- **scanner P3-1 加固**(schema-qualified/引号/插值绕过,连带 rank-8 同源洞;不可达面 fail-closed 加固)——进行中。
- update/create branch 的 `assertTransactionalQuery`(刀③ P3-1,autocommit 路径生产不可达)。

---

## §6 本文不主张什么

- 不主张 D-1c 全 scope 无缺口——`:6522` 是**已知、具名、有 stale-fail 逼修**的开放项,如实在案。
- 不主张任何 flag 被打开——§0.6 是**恒开的正确性预检**(只拒真不一致的历史),非能力 flag;PIT_RESET 生产门仍是 `MULTITABLE_META_REVISION_RETENTION_ENABLED` 关闭。
- 不主张 W1–W5 已开始——W0 是硬门,收官后 W1 主体(P2-2b 垂直树)方接续。
- 不主张守卫"永不回归"——P3-1 的三种不可达绕过写法证伪了"never";守卫覆盖的是**当前可达面** + fail-closed 收紧中。
