REVIEW-BASE: 69bc848e9698d06fe7f79ea99d55627d1626da91

# 对《B2a 合并后复核·七条主要问题》的回执(2026-08-29)

> 基线:本回执与被复核代码同锚 `origin/main = 69bc848e9`(非 stale)。逐条对真代码亲验,证据 file:line 如下。values-free。
> **定性:这轮复核质量高、基线正确、七条主要为真。** 我方跑了两个独立验证代理,二者在 finding 7 上分歧;我**亲手破局**,结果复核方对——差点据错误结论回复。教训入文见结尾。
> 结论:方向不变;交付有真缺口;根因是 HG v1.2 若干不变量写成绝对(§10.1"永久不可达"、§6"每个入口"),而 by-kind / route-only 的实现没兑现那个绝对。

## 逐条裁定

| # | 级 | 裁定 | 证据(main @ 69bc848e9) |
|---|---|---|---|
| 1 | P0 | **确认** | 围栏 `isK3ExternalWriteTargetKind` 仅认 `kind==='erp:k3-wise-webapi'`(`k3-external-write-permanent-fence.cjs:54,65`);通用 `http` adapter `upsert` POST 到 objectConfig 任意 path(`http-adapter.cjs:381+`),`pipeline-runner.cjs:653` 直调。**"K3 命名 connector 恒拒"成立;"本 runtime K3 Save 永久不可达"不成立**——PR-B 仅声明不闭 multitable 旁路,此 HTTP-to-K3-URL 是第三条路,我方漏了 |
| 2 | P1 | **确认** | reconcile 路由无 B2a 守卫先 `loadTableActionSourceAdapter`(解密凭据)(`http-routes.cjs:4306`);跨插件 API `runPipeline`/`replayDeadLetter` 直调 runner 绕过 HTTP-only 守卫(`index.cjs:200+`)。我方曾写"未来 in-process 可绕",但**跨插件 API 是现存调用方** |
| 3 | P1 | **确认(已自认),R-04 半边过度** | claim get→set→read-back 非 CAS(`b2a-trial-registry.cjs:805-833`,模块头 :77-85 自认;`PluginStorage.set` 是无条件 upsert)——commit `916c912ee` 正文"NOT DONE, and not claimed"已列。`authorizationRef`/`ownerPrincipalRef` 只 `requiredString`(:494-496)属实,但 T-1 是未签发的客户侧制品,现无可核。**R-03 残留真;但 R-04"不能签发"是过度**——R-04 的唯一 active/版本地板/跨应用拒绝均**不依赖 claim 原子性**(唯一性是加载期确定检查、版本地板单调、跨应用是纯 purpose 匹配)。**真修法 = 迁移 078**(`claim_key` PK,~150 行,先例 077,非平台变更),而非模块自述的"需改存储契约" |
| 4 | P1 | **确认(a/b/c 全真,均未披露、无测试,已实测复现)** | 见 §4 详录 |
| 5 | P1 | **确认** | `requestTimeout ?? 30000` 容显式 0 关超时(`MSSQLAdapter.ts:205`);`strictOffsetOrdering` **默认 off** 故默认仍 `ORDER BY (SELECT NULL)`;行级 generation deferred;sealed-snapshot sentinel 已披露。**加固可被配置关或默认未生效** |
| 6 | P1 | **确认(我方文档)** | r6 单缺完整 SHA / "仅合成演示" / org SQL 占位 / pg_dump 未批 / 打包参数 / 停止码 / 回滚。已修 |
| 7 | P1 | **确认(程序性 + 事实错误 双半均真)** | 程序性(Downloads≠跨机送达、回执缺 REVIEW-BASE)有效,本回执入库并加 REVIEW-BASE 头即改正。**"影响 owner 决策的事实错误"经我方二次核验坐实三处(E1/E2/E3)**,见 §7 |

## §4 详录(三点全 CONFIRMED,均 fail-safe 但真缺陷,已实测复现)

- **4(a) A→B→A 永久楔死**:`decisionId=hash(stableKey, fingerprint)`(:407);返回的指纹复现已 `superseded` 的 decisionId → :548-555 `exact` 分支 `continue`(先于 supersede 循环与 createRecord)。实测:`#3 rev-A → created:0 existing:1`,复活的 A 无 pending、旧 pending 属过期的 B、superseded 行不可 confirm(:697)→ **该 stableDecisionKey 永久不可确认**。`buildRevision` 纯 `hashJson`(`table-actions.cjs:690`),源/目标内容回退即复现指纹——正常 PLM/BOM 行为。A-02 用严格单调 rev-1→2→3,**未覆盖振荡**。**最小修 ~15-20 行**:supersede 循环前置,exact 命中 superseded 时 reopen 为 pending(附一条 owner 裁定:复活行是否沿用旧 resolutionAction——落入矩阵 Q5)。
- **4(b) 孤儿不关闭**:supersede 只在 `for (candidate of candidates)` 内、按各自 stableDecisionKey;无遍历"本轮无 candidate 的 existing 行"的过程。实测:冲突移除 → counts 全 0,旧 PENDING 行永存。fail-safe(readback 按当前 plan 重算)但**权威队列积累幽灵行**。**修**:candidate 循环后扫 live 行关闭之(或落实保留的 `cancelled`)。
- **4(c) lease 无续租无 fencing(实测破坏核心不变量)**:TTL `60_000` 是默认(可 `ttlMs` 覆盖);只有 acquire/release、无 renew/heartbeat;`leaseId` 只守 takeover CAS、**不守写**。实测(TTL 60ms + 60ms 写 + 3 candidate):慢持有者与抢锁者**双双成功、无一得 RECONCILE_BUSY、3 个决策中 2 个以重复 active 行收场**——直接违反 A-04"最终 active=1"、R-04"唯一 active",而这正是迁移 077 存在的理由。**未披露、无测试**:头部宣称"guarantee lives in SQL / exactly one holder"未提 TTL 后失效。过期抢锁路径(:479-487)无测试覆盖。**修 ~30-40 行**:创建/patch 循环前复读并断言 `lease_id` 仍属己 + 每 K candidate renew CAS,失锁即定码 abort(真 fencing 无法在多维表 API 上表达,bounded-abort 是现实上限);或降 2000 上限 / 升 TTL。

## §7 O1′ 矩阵三处影响 owner 决策的错误(坐实)

在其自声明基线 `b6c0241d6`(main 祖先)上,矩阵**多数精确**(8 hold 行号、词表计数、§5"结构不可能"清单、`assertNoHumanFields` fail-closed、账本无 canonical 写能力、§6 门文引用、`planCarry` 确无生产调用方故 3/11 行正确标为假设)。但三处错误改变决策:

- **E1(最重):`duplicate_expanded_key` 的 `canonical_row_exists=否` 是错的**——就在标注"六轴全部代码已定"、被当其余十行模板的那一行。亲验:`:806 if (existingKeyed.has(key))` **恰在 canonical 行存在时触发**且**不重分类**(:1053 仍发 `type:'duplicate_expanded_key'`;`clean_to_collision_requires_review` 是 reason 非 type)。故该类型 canonical 行存在/不存在**皆可发生**。后果:唯一已实现类的 Q1/Q2 未被干净分离;canonical 行存在的组做 `keep_multiple_rows` 确认会每次 replan 被重 hold,Q2-A"解除拒绝即可"低估了工作量。
- **E2:标题计数 13/11 与"closed vocabulary,非推测"错**——`:1037 type: rowError.type || 'c2_row_error'` 是无校验透传;BOM expander 实发 **10 种**(ambiguous_component / ambiguous_path / invalid_quantity / missing_bom_id / missing_child_bom / missing_component / missing_component_source_id / missing_order_id / missing_path / missing_path_id)+ ext-mapping coercion 码。矩阵把 ~10-16 种语义无关失败塌成一行一决策——但 missing_child_bom 是源数据修复、coercion 是 pack 映射修复、ambiguous_component 是人工消歧,该决策行不成立于此形。
- **E3:Q5 行实质不全**——§3 标 supersede·resume `[C] 代码已定`、Q5-A"沿用已实现语义 … S —— 已实现",唯一成本写"重复人工工作量"。4(a) 实测证否:指纹返回时旧行**不 supersede**、**不开新 pending**、决策永久不可确认。Q5 正是 supersede 决策;按"已实现/S/fail-safe"裁 A 是据不全事实。fail-safe 本身成立(hold 恒立),故 Q5-A"唯一 fail-safe 方向"存活,"已实现"不成立。

矩阵已按 E1/E2/E3 就地修正并重锚 69bc848e9,同置本目录。

## 下一波代码工作项(2026-08-29 owner 已裁"按建议执行")

> **owner 裁决入库记录(公约规则 6,单机通道指令当日落库)**:W-1 采 **(b)+(c)**——(a) URL 嗅探被否;(c) 通用出站 HTTP 写改为 **unset=deny** 的显式授权能力(env 指服务端文件,非 G-4 永久禁令,与 K3 围栏区分);W-2/3/4/5 即日开工,W-4 复活行 `resolutionAction` 取保守默认(清空重确认)。五支并行开发中,合并前逐支过 CI 与见证纪律。

| 项 | 对应 | 尺寸 | 备注 |
|---|---|---|---|
| W-1 通用出站写围栏 / 或收紧 §10.1 措辞 | 1 | **owner 决策先行** | 三选一:(a) 对任意 external-write target 判 K3 端点(脆);(b) 措辞收紧为"K3 命名 connector 恒拒 + 通用出站写另有一道未闭的门";(c) 给通用出站写加门。**推荐 (b)+(c)** |
| W-2 choke 下沉 runner 层 | 2 | M | 守卫从 HTTP 路由移到 runner/reconcile/cross-plugin 共同入口 |
| W-3 迁移 078 operation claim CAS | 3 | S~M | `claim_key` PK,先例 077;R-04 无需(已足) |
| W-4 账本 reopen + 孤儿关闭 + lease renew/fencing | 4 | S~M | §4 三修合一 PR;含 owner 一裁(复活行 resolutionAction) |
| W-5 MSSQL requestTimeout 下限 + strictOffsetOrdering 对 armed B2a 默认 on | 5 | S | |
| W-6 HG v1.2 §10.1/§6 措辞收紧 + O1′ 矩阵 E1/E2/E3 | 1/2/7 | 文档 | 属 Codex 工作区,本回执建议改稿;矩阵修正版随本 PR 入库 |

## 教训(入文,与我方"绿见过红"纪律同源)

我方跑两个独立验证代理核 finding 7:一个判"事实错误证否",一个判"复核方对、三处错误"。我据后者存疑,**亲手验 `:806`/`:1037` 破局——复核方对**。若据前一个代理直接回复,就会驳回一条正确的 P1,重蹈上一轮 B 机的覆辙。**两个验证器分歧时,不取多数、不取先到,亲手看代码。** 这轮 Codex 打得准,账认得干脆——上一轮我方五发中 B 机、这一轮 B 机中我方,双向对抗各自在真代码上认账,机制本身在生效。
