# Multitable Global History — 4c-1 Lossy/Value-Transform Retype Revert — DESIGN-LOCK(PROPOSED)(2026-07-07)

**状态:PROPOSED,待 owner ratify。** 本锁在线级全自动授权下起草;forward-plan(#3633:34)中 4c-1 的解锁词是「owner 单项签核」——**起草 ≠ 开工,impl 仅在 ratify 后排期**。祖源契约 = `multitable-t9-w-unsafe-restore-design-lock-20260626.md` §Tier-2 + U-L8(原 greenlit、后被 U-2 降级为 schema-only;其 §闭环修正 :119-129 明确把 lossy 路径留给「FUTURE destructive value-transform retype,另需 owner sign-off」——即本锁)。姊妹锁:4c-2 forward tombstone-capture(同日起草,见 §5 C6)。

## 0. 一句话与承重事实

把 field retype revert 从「scalar-safe 信封内 schema-only」扩展到**信封外的 gated 子集**——此时套回 `before` 定义可能使既有单元格值被 coerce/drop,revert 本身成为**新的破坏性值变换**,须以 loss-oracle + loss-magnitude 绑定 + 写对称 cap 治理。

**承重事实(primary-source,决定本锁形状):当前 runtime 不存在任何值级 lossy/lossless 判定。** 前向 retype 完全不迁移单元格值(裸 `UPDATE meta_fields`,`univer-meta.ts:10660-10666`);现 revert 与之对称、天然无损(`config-restore.ts:62-75` 设计注释明言);「安全判定」只是类型白名单 `isSupportedFieldRetypeRevert`(`config-restore.ts:94-101`,排除表 `FIELD_RETYPE_EXCLUDED_TYPES` :78-81)。loss-oracle 是本锁**净新增**的东西。

## 1. 现状拒绝路径(本锁的扩展起点)

- flag off → 403 `FIELD_RETYPE_REVERT_DISABLED`(preview `univer-meta.ts:8156-8157` / execute `:8237-8238`)。
- flag on 但信封外(非 scalar-safe)→ execute 422 `RESTORE_NOT_SUPPORTED`(`:8398`);preview 保持 `opKind='gated'` + `gatedReason`(`:8195-8198`)。
- `classifyRevert` 对 field type/property 恒返 `gated`、route 层开子集(`config-restore.ts:32-41`)——本锁沿用该「classify 纯函数、route 开窗」模式,**不改 classify**。
- 无损基线 golden:`multitable-field-retype-revert-realdb.test.ts`(`'hello'` 在 number 字段存活 = 无值迁移的活证)。

## 2. 契约(锁定)

### 2.1 范围信封(fail-closed)
- v1 仅覆盖:**scalar↔scalar 之外的 type revert 中,目标(before)type 仍为 plain scalar 的情形**,以及**同 type 的 property 变换会改变值解释的情形**(currency/percent/duration/dateTime 等 Batch-1 类型的 property revert)。
- 仍然排除(维持 422):目标 type ∈ `FIELD_RETYPE_EXCLUDED_TYPES`(formula/lookup/rollup/link/attachment/button/autoNumber/created*/modified*)——这些是派生/物化语义,revert 值变换无意义且有独立副作用面(`univer-meta.ts:10670-10684`)。
- flag:新增 `MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY`,默认 **off**;**且要求基础 flag `MULTITABLE_ENABLE_FIELD_RETYPE_REVERT` 同时 on**(基础 flag 关则本面整体 403,双闸串联)。off 时一切现状逐字节不变。

### 2.2 loss-oracle(净新增)
- 定义:对每条记录,以 `coerceBatch1Value(beforeType, beforeProperty, …)`(`field-codecs.ts:1076`,现只接在记录写路径 `univer-meta.ts:13377`)试算现值 → 三桶:`unchanged`(值语义不变)/ `coerced`(可表示但改写)/ `dropped`(不可表示,revert 后置空)。
- **U-L8 no-oracle 约束(硬性,[P1] 级)**:loss 计数**只对 actor 可读的 record/field 计算**;越界部分归入 `undisclosed` 桶——**只报「存在越界记录」布尔,不报任何数字**(祖源锁 :60-68 option (a));golden 必须含 no-hidden-count-inference 项。
- oracle 是纯读预演,不写库;preview 响应新增 `lossSummary { unchanged, coerced, dropped, undisclosedPresent }`。

### 2.3 loss-magnitude 绑定(preview↔execute)
- preview 把 `lossSummary` 以 **server-key HMAC**(镜像 `hashUncreatePlan`,`restore-preview-identity.ts:281-294`;注释 :270-280 讲明为何不能用 client-decodable 明文——1-bit 信息可被暴力探针)并入既有 config-restore preview token claims(`:233-246`)。
- execute 在事务内(`FOR UPDATE` 后)**重算** lossSummary 并 verify:不一致 → **409 PLAN_DRIFT**(值在 preview 后被人改动 = 损失量变了,必须重预览);既有 410 EXPIRED / 401 INVALID 语义不变。
- **重算范围 = 与 preview 完全相同的 actor 可读范围(同尺比对,锁定)**。undisclosed 行**不参与** drift 比对:其损失从未被量化或承诺(§2.2),execute 按其现值变换——若绑全表指纹,含 undisclosed 行的 sheet 会把「隐藏行有无活动」变成 1-bit 探针,违背 U-L8;此取舍为刻意结果,preview 的 undisclosed 文案须如实说明「越界行的变换按执行时点现值进行」。

### 2.4 写对称 cap 与执行语义
- cap:复用 `SHEET_REVERT_MAX_RECORDS`(`univer-meta.ts:9276-9277`,默认 5000)——待扫描/变换行数超限 → 413 fail-closed(preview 与 execute 双侧),不静默截断、不 partial。
- execute 单事务:`UPDATE meta_fields` 套回 before 定义 + 按 oracle 结果批量改写 cell 值;每条被 coerce/drop 的 cell **记 record revision**(现有 recorder,`record-history-service.ts:45-78`)——Global History 完整,且 lossy revert 自身可经 record restore 撤销。
- typed confirm:execute 须 `confirm: 'revert-retype-lossy'`(镜像 uncreate/undelete 模式,`univer-meta.ts:8259/:8313`)。
- gate:沿用 config-restore 面的既有 capability 门,**不触碰中央 rbac/auth**。

## 3. 与 4c-2 的关系(pre-image preference)

- **无 4c-2 pre-image 时**(v1 现实):revert 的值变换 = **按 before 类型再-coerce,不是恢复真值**——preview 文案必须如实标注「近似恢复(重新格式化),非原值找回」。
- **有 4c-2 pre-image 时**(`meta_field_value_tombstones(reason='lossy_retype')`,以 `config_revision_id` 锚定被 revert 的那次前向 retype):revert **优先用真值**,oracle 桶相应变为 `restored`;coerce 只作无锚兜底且文案区分。
- 反向依赖:本锁的 execute 若 ratify 且 4c-2 亦 ratify,则本锁 coerce/drop 写入点必须同事务捕获 pre-image(4c-2 §2.3)——使 lossy revert 之后仍可再逆。两锁可独立 ratify,联动条款按「双 ratify 才生效」处理。

## 4. Golden 矩阵(fail-first,realdb)

| # | 场景 | 断言 |
|---|---|---|
| L1 | 双 flag off / 仅基础 flag on | 403 / 信封外仍 422,与今日逐字节一致 |
| L2 | scalar-safe 信封内 | 走既有 schema-only 路径,**零值改写**(回归防护) |
| L3 | oracle 三桶 | 构造 unchanged/coerced/dropped 各若干,preview 计数逐一精确 |
| L4 | U-L8 no-oracle | 存在越读界记录时:`undisclosedPresent=true` 且无任何数字泄漏;对照组证明无法由计数差推出隐藏行数 |
| L5 | loss-drift | preview 后改一格**可读**值 → execute 409 PLAN_DRIFT,库零变化 |
| L5b | undisclosed 无 drift 探针 | preview 后仅改**越界**行值 → execute **不** 409(按现值执行);证明 409 通道不构成隐藏行活动探针 |
| L6 | cap | 超 `SHEET_REVERT_MAX_RECORDS` → 413,preview/execute 双侧,库零变化 |
| L7 | 原子性 | execute 中途注入失败 → 定义与值全部回滚 |
| L8 | revision 完整性 | 每个被 coerce/drop 的 cell 有 record revision;changedFieldIds 正确;masking parity 与 history 读面一致 |
| L9 | typed confirm | 缺失/错误 confirm → 422,库零变化 |
| L10 | mutation | neuter oracle 重算(2.3)→ L5 必红;neuter cap → L6 必红;neuter 桶判定 → L3 必红 |
| L11 | (双 ratify 后)pre-image preference | 有锚走真值 `restored`;无锚走 coerce 且文案区分 |

## 5. 不变量(C1–C7)

- **C1 fail-closed 信封**:未列入 §2.1 的形态永远 422;flag 串联双闸;off = 现状逐字节。
- **C2 no-oracle**:任何响应/错误路径不得泄漏越界行数或值(含错误信息文案)。
- **C3 drift 必拦**:execute 时点的 lossSummary 与 token 绑定值不一致即 409,无例外窗口。
- **C4 写对称 cap**:preview 能算的上限 = execute 能写的上限,同一常量。
- **C5 历史完整**:值变换必经 record revision;revert 自身可被撤销。
- **C6 pre-image preference**:锚存在则真值优先(依赖 4c-2;双 ratify 联动)。
- **C7 中央权限零触碰**:只用 multitable 面既有 capability 门(K3 锁纪律)。

## 6. 实施排布(ratify 后才排)

难度**高**(破坏性语义 + no-oracle 面):oracle+token 绑定+execute 核心 = **强模型车道**(Fable/Opus);golden 矩阵 + fixture = Sonnet 车道;Fable 逐点审(mutation 证据必交)。预估 1-2 轮。

## 7. 出界(记录在案)

前向 lossy retype(前向 PATCH 开始迁移值 = 独立产品决定,不在恢复线)、`FIELD_RETYPE_EXCLUDED_TYPES` 目标形态、FE 面(独立 gated 项)、4d(已删数据,永不承诺)。

**解锁词示例:「ratify 4c-1」(可附修改意见;若与 4c-2 同 ratify,联动条款 §3 生效)。**
