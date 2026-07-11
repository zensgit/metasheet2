# S1 加班银行·额度有效期 验证报告 — 2026-07-08

> S1 MERGED `140cd6e49`(PR #3927)。设计锁 `attendance-overtime-bank-validity-s1-design-lock-20260708.md`。
> 对标钉钉考勤·余下开发总目标池(规划 #3925)**T0 首刀**。money-adjacent,经 opus **两轮**对抗审阅闭环。

## 1. 缺陷(代码实证,非文档推导)

`overtimeBankPolicy` 在 admin UI 有两个可编辑旋钮但引擎零读取:`maxMinutesPerPeriod`、`validityDays`。
更糟:`validityDays`(「额度有效期(天)」)**遮蔽了真旋钮** `compTimeFromOvertime.expiresInDays`——
管理员在加班银行卡设 90 天有效期,实际调休**永不过期**。钉钉此项强制。此为"广告了却不生效",非缺能力。

## 2. S1 交付(只做 validityDays;cap 拆 S1b)

- 新纯函数 `resolveBankedLotExpiresInDays(bankPolicy, expiresInDays)`:银行**启用**且 `validityDays` 正整数(且 ≤ 上界)→
  它决定 **banked(source-tagged)lot** 的 `expires_at`,覆盖 `expiresInDays`;否则回落(pre-S1 逐字节不变)。
- **payload 形状不变**:`{name,requestType,steps,isActive,orgId}` 无关(此为审批 grant 路径);S1 只改 banked INSERT 的一个入参 `$6`。
- **dormant 路径(银行关闭,单 NULL-source lot)一字未动**——银行旋钮不泄漏进 legacy 路径。
- **既有 lot 不改**:`INSERT … ON CONFLICT DO NOTHING`,无 `UPDATE … expires_at` 触及 comp_time(唯一此类 UPDATE 限 annual_accrual)。
- **UI 诚实化**:validityDays 标作用域+优先级;`maxMinutesPerPeriod` 明示「尚未强制」(S1b 落地后改)。

## 3. 不变式(全保留,opus 逐条实证)

Σ perSource===total 守恒 · pooledSources 门 · statutory_holiday 永不入池(§6 法定下限)· totalWeight≤0 fail-closed ·
per-source ON CONFLICT 幂等。`partitionOvertimeBankGrantLots` 纯函数字节不变(2340B)。

## 4. 双轮对抗审阅闭环(opus,money-adjacent 最高强度)

**首轮 CHANGES-REQUESTED,0 P1 · 2 P2**(真机端到端证明,非纸上):
- **P2-1**:`validityDays` 全链无上界 → PUT `999999999` 后审批 `interval out of range` 500(SQLSTATE 22008)+ 回滚。
  修:zod `.max(36500)`(save 时 400)+ resolve 层 `MAX_LOT_VALIDITY_DAYS=36500`(承重非仅防御——main 上可能已存 >36500 的 legacy 行)。
- **P2-2**:resolve 先判正后 floor(`0.5`→0→lot 一到即过期)+ 锁 §3 谎称 normalizer 保证整数。
  修:先 floor 再判 `days>0 && ≤MAX`;normalizer 整数化(与 expiresInDays sibling 同契约,§3 现真)。
- **advisor caution**:`expiresInDays` 同类无界但 API-only、main 已存在 → **不进本刀**(独立跟进),不扩 S1 blast radius。

**re-confirm APPROVE,0 P1 · 0 P2,两个 P2 真闭、可合。** 仅 1 非阻断 NIT(锁 §5 未注明 cap mutation 是哪层红:
zod cap 红集成 5e、resolve cap 红单测——两层各有测,此处记正)。

## 5. 部署预检门(review P3-4;money-adjacent 行为翻转)

覆盖生效对"已启用银行且已设 validityDays"的既有 org 是**交付其配置**(既有 lot 不改、仅新 grant)非剥夺 → 非缺陷。
但属无公告行为翻转,**部署前预检 live 设置行**:
`SELECT value::jsonb->'overtimeBankPolicy' FROM system_configs WHERE key='attendance.settings'`;
`enabled='true' AND validityDays IS NOT NULL` 命中 → 发布说明 + 管理员再确认;未命中(预期,银行档默认关)→ 放行。

## 6. guard 结果

真 DB `attendance-plugin.test.ts` **154/154**(含 5a 覆盖无过期/5b 90胜30/5c 回落/5d dormant/5e 超界400/5f 既有lot不改)+
单测 11/11 + tsc 清。mutation:拆覆盖→集成红 / 拆 cap→单测红 / 拆 floor 顺序→单测红。

## 7. 后续

**S1b**(maxMinutesPerPeriod 每周期上限)= PROPOSED,3 分叉待 owner(尤 D2 超限=截断/阻断/可配);设计锁 `attendance-overtime-bank-cap-s1b-design-lock-20260708.md`。
`expiresInDays` zod `.max` parity = 独立小刀(pre-existing)。
