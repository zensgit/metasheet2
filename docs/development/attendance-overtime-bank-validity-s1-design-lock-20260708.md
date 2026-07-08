# S1 加班银行·额度有效期落地 + 两个过期旋钮裁决 design-lock — 2026-07-08

> **Status: RATIFIED**(owner goal「以对标钉钉考勤的余下开发为总目标池…全自动」;总规划
> `attendance-benchmark-remaining-plan-20260708.md` 的 **T0 首刀**)。后端引擎刀,money-adjacent,
> **默认行为逐字节不变**。

## 1. 缺陷（代码实证,非文档推导）

`overtimeBankPolicy` 在 admin UI 有两个可编辑旋钮,**引擎零读取**:

| 旋钮 | FE 标签 | 实际 |
|---|---|---|
| `maxMinutesPerPeriod` | 「每周期上限(分钟,0＝不限)」`AttendanceView.vue:3018` | 只在默认值 `index.cjs:253` + zod + 测试;**零比较零强制** |
| `validityDays` | 「额度有效期(天,留空＝不过期)」`AttendanceView.vue:3030` | 只在默认值 `index.cjs:254` + zod + 测试;**从不到达 lot INSERT** |

而 **真正盖 `expires_at` 的是另一个键**:`compTimeFromOvertime.expiresInDays`
(`index.cjs:219-223` 注释 / `:12467` 归一化 / `:21664` zod / `:28662` 取值 / `:28700` INSERT
`CASE WHEN $6::int IS NULL THEN NULL ELSE now() + ($6::int * interval '24 hours') END`)。

→ **两个过期开关静默冲突**:管理员在「加班银行」卡设 `validityDays=90` 以为调休 90 天过期,实际
只有 `compTimeFromOvertime.expiresInDays` 生效;若后者为空则**永不过期**。这是"广告了却不生效"的缺陷,
不是缺能力。钉钉的调休有效期是强制的。

## 2. 裁决（本刀只做 validityDays;cap 拆 S1b）

- **`overtimeBankPolicy.validityDays` 获得明确语义**:当 `overtimeBankPolicy.enabled === true`
  **且** `validityDays` 为正整数 → 它**只**决定**banked(source-tagged,pooled)lot** 的 `expires_at`,
  覆盖该批 lot 的 `expiresInDays`。
- `validityDays` 为空/非正 → **回落 `compTimeFromOvertime.expiresInDays`(现状,逐字节不变)**。
- **dormant 路径(`overtimeBankPolicy.enabled !== true`,单个 NULL-source 整额 lot)完全不受影响**,
  继续用 `expiresInDays`。
- 双默认(`enabled:false` / `validityDays:null`)⇒ **默认行为逐字节不变**;只有"已启用银行 **且** 已设有效期"
  (即先前被欺骗的那批 org)才拿到他们本就配置的行为。既有 lot 不动(只影响新 grant)。
- **`maxMinutesPerPeriod` 本刀不做**:它需要"周期"定义 + 已 banked headroom 查询 + 重放幂等处理,
  与本刀不是一个复杂度 → **S1b 独立设计锁**。本刀在 FE help text 明示该项"尚未强制",不留半真 UI。

### 为什么不是"删掉 validityDays"
`expiresInDays` 归属 `compTimeFromOvertime`(OT→调休转换卡);banked lot 的有效期归属加班银行卡,语义正当。
删旋钮会丢失"银行 lot 与 legacy lot 不同有效期"的表达力。保留 + 明确优先级 + 文档化,是更诚实的解。

## 3. 实现（`plugins/plugin-attendance/index.cjs`,后端唯一改动面）

- 归一化(`normalizeOvertimeBankPolicy`,`:12842` 附近):`validityDays` 已归一化为正整数或 null(核对)。
- 调用点 `:28662-28706`:banked 分支求 `bankedExpiresInDays = (bankPolicy.enabled === true && positiveInt(bankPolicy.validityDays)) ? bankPolicy.validityDays : expiresInDays`,
  作为 lot INSERT 的 `$6`。dormant 分支参数不动。
- `partitionOvertimeBankGrantLots` **纯函数不动**(守恒/池化/§6 法定下限语义全保留)。
- FE(`AttendanceView.vue`)help text:validityDays 注明"仅作用于加班银行的分源额度,覆盖调休转换的有效期";
  maxMinutesPerPeriod 注明"**尚未强制(S1b)**"。

## 4. 不变式（不得破坏）

1. Σ perSource === totalMinutes(精确守恒)
2. 只有 `pooledSources` 内的 source 成 lot;`statutory_holiday` 永不入池(§6 法定下限)
3. `totalWeight <= 0`(无 segmentation snapshot)→ fail-closed 不入池
4. 每 lot `source_key = overtime_conversion:${requestId}:${source}` + `ON CONFLICT DO NOTHING` 幂等重放
5. **本刀只改 `$6`(expires_at 天数)一个入参**,不动 lot 数量/分钟数/source

## 5. 测试契约（真 DB,`attendance-plugin.test.ts`,已挂 plugin-tests.yml）

- 银行启用 + `validityDays=90` + `expiresInDays=null` → banked lot `expires_at ≈ now()+90d`(容差),非 NULL。
- 银行启用 + `validityDays=null` + `expiresInDays=30` → banked lot ≈ now()+30d(**回落,现状不变**)。
- 银行启用 + `validityDays=90` + `expiresInDays=30` → banked lot ≈ now()+90d(**覆盖**),证明优先级。
- 银行**关闭** + `expiresInDays=30` → 单 NULL-source lot ≈ now()+30d(**dormant 逐字节不变**)。
- 重放同 requestId → 无重复 lot(ON CONFLICT),`expires_at` 不被改写。
- Mutation:拆覆盖逻辑(恒用 expiresInDays)→ 覆盖用例红;拆 `enabled` 门 → dormant 用例红。

## 6. 完成口径

实现 → opus 对抗审阅 0 P1/P2 → 三红线 → 验证 MD → 账本回填。**S1b(maxMinutesPerPeriod 强制)紧随其后,独立设计锁。**
