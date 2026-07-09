## S1b — 加班银行·每周期(自然月)上限强制

补完加班银行"假配置"缺陷的第二半(承 S1 validityDays)。`overtimeBankPolicy.maxMinutesPerPeriod`
（管理员「每周期上限(分钟)」）此前 shipped-in-UI-read-by-nothing;本 PR 落地强制。**money-adjacent**。

### 行为
banked comp-time grant 若会使该 user 该**自然月**已入池 banked 分钟 **严格超过** cap → 审批返回
`422 OVERTIME_BANK_CAP_EXCEEDED` 并**整体回滚**(request 保持 pending,0 lot 副作用)。恰好等于 cap 允许。
`maxMinutesPerPeriod=0/未设` 或 bank 关闭(dormant)⇒ 逐字节不变。

### 决策(design-lock RATIFIED,审可改)
- **D1** 周期 = 自然月(org tz),锚 OT 请求 `work_date` 月;复用 `attendanceMonthStartKey/EndKey`。payroll-cycle→v2。
- **D2** 超限 = **block**(默认,保守、前向兼容);`overflowMode=must_pay`(截断入池)= v2 additive。
- **D3** headroom = 该月**池化**(source-tagged)banked 分钟(`amount_minutes` 已 accrued),排除本请求自身。
  - ⚠ `overtime_source IS NOT NULL` 与 `newBanked = Σ 池化 lots` 同口径(§6 statutory 从不入池);
  - ⚠ JOIN `r.id::text = b.source_id`(source_id=text / id=uuid,否则 500)。

### 实现(后端唯一改动面 `plugins/plugin-attendance/index.cjs`)
- `overtimeBankCapDecision()` 纯 helper(可单测边界);
- `sumBankedOvertimeMinutesForMonth()` async headroom;
- 强制点 = banked 分支 partition 后 / INSERT 前 pre-check;
- FE:cap hint「尚未强制」→ 实际作用域。

### 验证
- 单测 27/27(5 新边界 + 22 sibling 回归)。
- 真 DB:`④ C2` 内新增 **6a 恰到 cap 允许 / 6b 超限 422+回滚+0 lot / 6c 无 cap / 6d 跨月隔离 / 6e dormant 免疫**。
- **零回归**:真 DB 全文件 base-runtime 对照,改动版与 base 失败集合逐个相同(9 个均为共享 dev DB 历史配置污染,
  如 `shiftCompliance.dailyMaxMinutes:1`,CI 全新库无);详见验证 MD §2.3。

设计/验证 MD:`docs/development/attendance-overtime-bank-cap-s1b-{design-lock,verification}-20260709.md`。

不变式(design-lock §4)全核对:S1 五条保留 / dormant 不碰 / cap≤0 逐字节不变 / pre-check 全回滚 0 副作用 / 重放不误判。

🤖 Generated with [Claude Code](https://claude.com/claude-code)
