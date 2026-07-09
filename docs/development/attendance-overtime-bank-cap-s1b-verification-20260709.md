# S1b 加班银行·每周期上限强制 — 验证 MD (2026-07-09)

对账 design-lock:`attendance-overtime-bank-cap-s1b-design-lock-20260709.md`(RATIFIED)。
分支 `claude/attendance-s1b-overtime-bank-cap-20260709`,base `origin/main` 9ac55cba0。money-adjacent。

## 1. 落地内容

| 层 | 改动 | 位置 |
|---|---|---|
| 纯 helper | `overtimeBankCapDecision({maxMinutesPerPeriod,existingBanked,newBanked})` → `{blocked,cap,projected,existing,added}`;cap≤0→永不 block;`projected>cap` 才 block(恰到不 block) | `index.cjs` (resolveBankedLotExpiresInDays 后) |
| async helper | `sumBankedOvertimeMinutesForMonth(trx,{orgId,userId,monthStart,monthEnd,excludeRequestId})` → 该月**池化**(source-tagged)banked 分钟(`amount_minutes`)之和 | `index.cjs` (deductCompTimeBalance 后) |
| 强制点 | banked 分支 `partitionOvertimeBankGrantLots` 之后、lots INSERT 之前:cap>0 时算 headroom→`overtimeBankCapDecision` blocked→throw `HttpError(422,'OVERTIME_BANK_CAP_EXCEEDED')`→审批事务回滚 | `index.cjs` (④ 审批 grant, banked 分支) |
| export | `overtimeBankCapDecision` 加入 `__attendanceOvertimeBankForTests` | `index.cjs` module.exports |
| FE | cap hint「尚未强制」→ 实际作用域(每自然月 banked 上限,超限阻断审批) | `AttendanceView.vue` |

关键口径修正(recon 发现,已入 design-lock):
- **headroom 只数池化 lots**(`overtime_source IS NOT NULL`),与 `newBanked = Σ 池化 lots` 同口径 —— §6
  statutory_holiday 从不入池;否则历史 dormant NULL-source lot(全额、含 statutory)会污染银行上限。
- **JOIN 强制 `r.id::text = b.source_id`** —— `source_id`=text、`requests.id`=uuid,直接比较 500
  (`operator does not exist: uuid = text`)。
- 用 `amount_minutes`(已 accrued)非 `remaining_minutes` —— cap 是每周期累积上限,用掉再攒不得绕过。

## 2. 测试结果

### 2.1 单测(无 DB)—— 27/27 通过
- `attendance-overtime-bank-cap.test.ts`(新,5):cap≤0 永不 block / 恰到 cap 不 block / 超 1 分钟 block /
  单次 grant 独超 / 垃圾输入 floor 到 0 不 NaN 泄漏。
- `attendance-overtime-bank-policy.test.ts`(14)+ `attendance-overtime-bank-grant.test.ts`(8):回归全绿。

### 2.2 集成(真 DB, `metasheet-dev-postgres` :5435)—— C2 全测通过
`④ C2 — overtime approval credits a comp-time grant lot` 内新增 (6a–6e):
- **6a** cap=120,两笔 Oct 各 60 → 恰到 120,均 200,当月池化=120。
- **6b** 第三笔 Oct 60 → 会到 180 > 120 → **422 `OVERTIME_BANK_CAP_EXCEEDED`**;request 仍 `pending`;
  该请求 0 comp_time lot;当月池化仍=120(审批整体回滚,0 副作用)。
- **6c** cap=0 → 单笔 600 全 grant(不 block),当月池化=600。
- **6d** cross-month:cap=120、Oct 已满,Dec 单笔 120 → 只用 Dec headroom(0)→ 恰到 cap → 200(证明月隔离)。
- **6e** dormant immunity:bank OFF + 600 → cap 不作用(dormant 分支),单 NULL-source lot=600。
- **6f** month-boundary:cap=120,月首 `2027-02-01`(60)+ 月末 `2027-02-28`(60)填满 Feb;月中 `2027-02-15`(60)
  → 180>120 → **422**。证明首/末日均归本月、无 TZ off-by-one(`normalizeDateOnly` 用 local getters + pg
  DATE→本地午夜 Date,日历日精确round-trip)。

### 2.3 无回归证明(base-runtime 对照)
真 DB 全文件跑(154 test):**改动版 = 145 passed / 9 failed;base runtime(改动全撤)= 同样 145/9,失败集合逐个相同**。
9 个失败全部是**共享 dev DB 的历史配置污染**(非我引入):
- 根因确认:`shiftCompliance.dailyMaxMinutes:1`(1 分钟,明显测试残留)→ 所有排班保存超日上限 →
  422 `SHIFT_COMPLIANCE_CAP_EXCEEDED`(即 "expected 422 to be 201");另有 punch/auto-match/overnight 等
  knob 残留。CI 用全新库无此污染故绿。失败测试全在**排班/打卡/自动匹配**域,与本切口(加班银行 grant)零交集。
- 结论:**S1b 改动零回归**;新增 6a-6e 断言真跑通过。

> ⚠ 复现口径:dev DB 被历史跑测污染,验证前把 `attendance.settings` 的 `shiftCompliance` 上限清 null、
> `overtimeBankPolicy/compTimeFromOvertime` 复位(见 §2.3 根因)。CI(全新库)不需要。

## 3. 不变式核对(design-lock §4)

| # | 不变式 | 证据 |
|---|---|---|
| 1 | S1 五条守恒/门/§6/fail-closed/幂等保留 | partition/resolve 纯函数未动;单测 22 全绿;C2 §4/§5 全绿 |
| 2 | dormant 路径不碰 | 6e:bank OFF + 600 → 单 NULL-source lot,cap 不评估 |
| 3 | cap=0/未设 逐字节不变 | 单测 cap≤0 永不 block;6c;base-runtime 对照零 diff |
| 4 | 超限 pre-check → 全回滚 0 lot 副作用 | 6b:422 + pending + 0 lot + 当月总额不变 |
| 5 | 重放不误判 | request pending-status 门先拦(§4 replay 已证);headroom 排除自身 |
| 6 | 并发 TOCTOU 关闭 | headroom 读前取 `pg_advisory_xact_lock(hashtext(org:user:month))`(txn 级、仅 capped 路径);单线程路径已跑通(取/放锁无死锁),并发正确性 by-construction:第二笔等第一笔 commit 后读到其 lots |

## 4. v2(additive,各自 gated)
`overflowMode=must_pay`(截断入池、超出转账4);`payroll_cycle` 周期口径。均加开关、不重写 v1 block 路径。
