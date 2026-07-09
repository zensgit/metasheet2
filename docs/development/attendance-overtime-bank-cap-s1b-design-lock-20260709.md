# S1b 加班银行·每周期上限强制 design-lock — 2026-07-09

> **Status: RATIFIED**（owner 2026-07-09「建议是?」→ Claude 荐 S1b + D2=C-默认block,owner 授权按安全默认
> 直接开工,审 PR 时可改）。承 S1(validityDays);补完加班银行"假配置"缺陷的第二半。money-adjacent。

## 1. 缺陷（同 S1）

`overtimeBankPolicy.maxMinutesPerPeriod`(FE「每周期上限(分钟,0＝不限)」)引擎零强制——
`partitionOvertimeBankGrantLots` 只读 enabled/pooledSources。管理员配的每周期加班银行上限**无限累积、不生效**。
钉钉此项强制。S1b 落地。(S1 已在 UI 标该项"尚未强制",S1b 落地后改回。)

## 2. 三个决策（owner 荐值,授权按此,审 PR 可改）

- **D1 周期 = 自然月(org 时区)**,以 OT 请求的 `work_date` 所属月为周期。**复用既有先例**:
  `attendanceMonthStartKey`/`attendanceMonthEndKey`(`index.cjs:17151/17156`)+ 综合工时 monthly-cap 的
  month-boundary 范式(`:17275`)。payroll_cycle 版留 v2。
- **D2 超限 = block(默认)**:若本次 banking 会使该 user 该月已 banked 分钟超 `maxMinutesPerPeriod` → 
  **throw 422 `OVERTIME_BANK_CAP_EXCEEDED` + 审批事务回滚**(仿 comp-time `COMP_TIME_BALANCE_INSUFFICIENT`)。
  匹配既有 `LEAVE_DEDUCTION_INSUFFICIENT_MODES=['block','partial']` 的保守默认。**`must_pay`(截断入池,超出转账4)= v2**,
  additive(加 `overflowMode` 开关),不重写——故 v1 建 block 前向兼容。
- **D3 口径 = 按"已入池 banked"分钟**:headroom = 该 user/org 该月**已 grant 的、真正入池的 banked comp_time 分钟**
  —— `source_type='overtime_conversion'` **且 `overtime_source IS NOT NULL`**(=池化过的 lot),且其 source 请求的
  `work_date` 在本月;**排除本请求自身**(`source_id != requestId`)→ 重放幂等(re-approve 不把自己算进 headroom)。
  **`overtime_source IS NOT NULL` 是关键修正(recon 发现)**:`newBanked = Σ lots.minutes` 只含**池化** lots
  (§6 statutory_holiday 从不入池、走 must-pay 账4),故 headroom 必须同口径只数 source-tagged lots,否则历史
  dormant(银行关时的单 NULL-source lot = 全额,含 statutory 派生)会被误计入银行上限,与 §6 floor 自相矛盾。
  同口径 ⇒ apples-to-apples、不受"银行开关切换"影响。用 `amount_minutes`(**已 grant/accrued**,非 remaining)——
  cap 是每周期**累积**上限,非余额;否则用掉再攒可绕过。

## 3. 实现（`plugins/plugin-attendance/index.cjs`,后端唯一改动面）

- 新 async helper `sumBankedOvertimeMinutesForMonth(trx, {orgId, userId, monthStart, monthEnd, excludeRequestId})`:
  ```sql
  SELECT COALESCE(SUM(b.amount_minutes),0)::int AS banked
    FROM attendance_leave_balances b
    JOIN attendance_requests r ON r.id::text = b.source_id   -- id=uuid, source_id=text ⇒ 强制 ::text 转换
   WHERE b.org_id=$1 AND b.user_id=$2 AND b.leave_type_code='comp_time'
     AND b.source_type='overtime_conversion'
     AND b.overtime_source IS NOT NULL     -- 只数池化(banked)lots,同 newBanked 口径(§6)
     AND r.work_date >= $3 AND r.work_date <= $4
     AND b.source_id <> $5                 -- 排除本请求,重放幂等
  ```
  > ⚠ `attendance_leave_balances.source_id` 是 **text**、`attendance_requests.id` 是 **uuid** ⇒ JOIN 必须
  > `r.id::text = b.source_id`(转 uuid→text 恒安全;非 uuid 的 text source_id 自然不匹配),否则
  > `operator does not exist: uuid = text` 会 500 审批。测试 headroom 辅助查询同口径。
- 新纯 helper `overtimeBankCapDecision({ maxMinutesPerPeriod, existingBanked, newBanked })` →
  `{ blocked: boolean, cap, projected }`(cap≤0 → 永不 blocked;projected=existing+new)。可单测。
- **强制点**:banked 分支(`:28810` 附近),在 lots INSERT **之前**:
  `newBanked = Σ lots.minutes`;若 `bankPolicy.maxMinutesPerPeriod>0`:
  monthStart=`attendanceMonthStartKey(requestRow.work_date)`, monthEnd=`attendanceMonthEndKey(monthStart)`;
  **先取 txn 级 advisory lock** `pg_advisory_xact_lock(hashtext('…:org:user:monthStart'))`(见不变式 6);
  existing=`sumBankedOvertimeMinutesForMonth(...)`;`overtimeBankCapDecision` blocked → throw 422 `OVERTIME_BANK_CAP_EXCEEDED`
  (含 cap/projected/period,审批回滚,request 保持 pending)。
- FE:`maxMinutesPerPeriod` hint 从"尚未强制"改为说明作用域(每月 banked 上限,超限阻断审批)。

## 4. 不变式（不破坏)

1. S1 的 5 条全保留(Σ守恒/pooledSources 门/statutory_holiday/totalWeight≤0 fail-closed/ON CONFLICT 幂等);
   partition/resolve 纯函数不动。
2. **dormant 路径(银行关闭)不碰**——cap 只作用于 banked 分支。
3. `maxMinutesPerPeriod=0/未设` ⇒ 行为逐字节不变(cap≤0 → 永不 block)。
4. 强制是**审批前 pre-check**,超限 throw → 全回滚,**0 lot 副作用**(不写半截)。
5. 重放:re-approve 已被 request-status 门 400 拦(先),即便到 grant 也因排除自身 headroom 不误判。
6. **并发 TOCTOU 关闭**:审批只 `FOR UPDATE` 自己的 request 行,故两笔同 user/月的 OT 并发审批会各自在对方 commit 前
   读 headroom → 双双放行 → 超 cap。故在 headroom 读之前取 **txn 级 `pg_advisory_xact_lock(hashtext(org:user:monthStart))`**:
   第二笔等第一笔 commit(锁随 txn 释放)后再读,读到第一笔已 commit 的 lots。**仅 capped banked 路径取锁**
   (uncapped/dormant 无锁 → 不变式 3 保持)。月边界口径:`normalizeDateOnly` 用 **local** getters + pg DATE→本地午夜
   Date ⇒ 日历日无 TZ 偏移(6f 经验证)。

## 5. 测试契约（真 DB,`attendance-plugin.test.ts`)

- cap=120 + 本月已 banked 60 + 新 OT 60(segmented workday) → grant 200,总 banked 120(恰到 cap)。
- cap=120 + 已 banked 120 + 新 OT 60 → **422 `OVERTIME_BANK_CAP_EXCEEDED`**,request 仍 pending,0 新 lot。
- cap=0(不限)+ 大量 OT → 全 grant(不 block)。
- **跨月**:上月 workDate 的 banked 不计入本月 headroom(月边界正确)。
- **重放**:超 cap 边界的 approve 幂等——re-approve 被 status 门拦,不因把自己算入 headroom 而误 block。
- dormant(银行关)+ cap 设值 → 单 NULL-source lot 照发,cap 不作用。
- **月边界(6f)**:cap=120,月首(02-01)60 + 月末(02-28)60 填满本月;再来月中 60 → 180>120 → 422
  ⇒ 首/末日均归本月(若首日漏到上月或末日漏到下月,headroom<120、月中不会 block)。
- 单测 `overtimeBankCapDecision`:cap≤0 永不 block / 恰到 cap 不 block / 超 1 分钟 block。
- Mutation:拆 cap pre-check → 超限用例变 200(红);拆排除自身 → 重放误 block(红)。

## 6. 完成口径

RATIFY(本刀)→ 实现 → **opus 最高强度审(money-adjacent)** → 三红线 → 验证 MD → 账本回填。
`must_pay`/payroll-cycle = v2,各自 additive。
