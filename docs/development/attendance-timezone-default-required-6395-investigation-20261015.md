# #6395 总览 422 `ATTENDANCE_TIMEZONE_DEFAULT_REQUIRED` 调查

日期：2026-10-15。源码基线：`main` `42984091d7fe`（与 run225 包 `gitCommitShort` 一致）。只读调查。不改运行时，不合 #6396，不关闭 #6395。

## 结论

三条总览接口 422，是因为**会话组织在 `attendance_rules` 里没有 `is_default = true` 的行**。`GET /api/attendance/rules/default` 返回的 `timezone=UTC` 不是这行检查的结果。那条 GET 走的是宽松的 `loadDefaultRule`：本组织没有默认行时，它要么返回内存常量 `DEFAULT_RULE`（时区写死 `UTC`），要么改去读哨兵组织 `org_id = 'default'` 的另一行。严格 reader 不接受这两种结果。

多时区关闭、节假日同步时区、考勤组是否绑定，都不是这条 422 的条件。

2026-10-15 的[后续 QA 留言](https://github.com/zensgit/metasheet2/issues/6395#issuecomment-6189251143)报告：管理员已持久化本组织默认规则，`rules/default`、`timezone-policy` 及三条总览接口复验均为 200。这是 **QA 报告的配置修复结果**；本轮没有连接目标环境独立复测，也没有产品运行时修复。该 PUT 仅传名称与时区，其余规则字段会采用内置值，尚需业务负责人确认完整规则及打卡/关联单据结果，不能据五个接口 200 宣布全部验收或自动关闭 #6395。对已报告成功的 QA 实例，下一步是获批后的规则及业务核验，不是重复执行下述 PUT。

## 抛出点（冻结源码基线，仅两处）

1. **实际命中。** `plugins/plugin-attendance/lib/attendance-timezone-policy-store.cjs:135-148`，`readDefault`。

   ```sql
   SELECT id, timezone, timezone_version
   FROM attendance_rules
   WHERE org_id = $1 AND is_default = true
   ```

   `found.length === 0` 时 `fail('DEFAULT_REQUIRED')`（`:14-15`、`:141`），码是 `ATTENDANCE_TIMEZONE_DEFAULT_REQUIRED`，状态 422。同一函数里，两行以上是 `ATTENDANCE_TIMEZONE_MULTIPLE_DEFAULTS` / 409（`:142`）；时区空白或非法是 `ATTENDANCE_TIMEZONE_INVALID_ZONE`（`:26-31`、`:145`）；`timezone_version` 不是 ≥ 1 的安全整数是 `ATTENDANCE_TIMEZONE_INVALID_REVISION`（`:20-22`、`:146`）。列不存在等查询故障被收成 `ATTENDANCE_TIMEZONE_STORE_UNAVAILABLE` / 503（`:50-59`），不是 422。

2. **本现场到不了。** `plugins/plugin-attendance/lib/attendance-timezone-read-context.cjs:83-109`。只有已选出的上下文 `mode === 'multi_timezone'` 时，才用同一谓词再查一次，且 `defaults.length !== 1` 也报同一个 422。策略关闭时 mode 是 `default_only`（`attendance-timezone-policy.cjs:86-88`），这段不跑。策略开启时，加载器已经先调用过 `readDefault`；零行会在更早的那一次变成同一个码，两行会先变成 409。

`attendance-timezone-runtime.cjs:838-842` 只是关闭多时区时的捕获白名单，不抛这个码。同文件 `:151` 和 `:289` 在默认行数不是 1 时抛的是另一个码 `ATTENDANCE_TIMEZONE_INVALID_DEFAULT`。

## 三条总览为什么都会打到 `readDefault`

会话组织来自登录令牌的租户。`users` 查询不带 `orgId` / `workspaceId`（`packages/core-backend/src/auth/AuthService.ts:58-59`）。`timezone-context/me` 与 `effective-calendar` 用 `getAuthenticatedOrgId`（`index.cjs:6541-6550`，经 `resolveAttendanceGroupRouteActorContext` `:6593-6614`）。`rules/me` 用 `getAttendanceRulesMeOrgId`（`:17941-17948`）。令牌里有 `tenantId` 时，中间件把它同时放到 `req.user.tenantId` 和 `req.authenticatedTenantId`（`jwt-middleware.ts:101-104`），两个函数读到的是同一个组织。没有租户时，前两个接口是 403，不是这次的 422。因此三条 422 查的是同一个会话组织。

| 接口 | 调用链 | 缺默认行时 |
| --- | --- | --- |
| `GET /api/attendance/timezone-context/me` | `attendance-timezone-target-routes.cjs:42` → `readTargetTimezoneContext`（`attendance-timezone-runtime.cjs:617`）→ 非冻结日 `readFreshTargetTimezoneWindow` `:572` `store.readDefault` | 422 该码。该日若已有冻结伴随上下文，会在 `:630-642` 直接返回，不会查默认规则。现场 422 说明所查工作日不是冻结日。 |
| `GET /api/attendance/rules/me` | `index.cjs:52566` `readCurrentTimezoneContext` → 加载器 | 加载器在看策略开关之前就 `readDefault`（`attendance-timezone-context-loader.cjs:68-85`）。多时区 OFF 仍然要这一行。 |
| `GET /api/attendance/effective-calendar`（带 `userId`） | `index.cjs:51155` `readCalendarContexts` → 有未冻结日时 `readTargetTimezoneContexts` `:722` `store.readDefault` | 422 该码。 |

成员资格失败是 `ATTENDANCE_TIMEZONE_MEMBER_REQUIRED` / 403（`attendance-timezone-target-routes.cjs:30-35`）。现场是 422，所以用户已是该组织的活跃成员。考勤组要到策略开启之后才查（`attendance-timezone-context-loader.cjs:87-104`），零默认行在那之前已经失败。

## 为什么 `/rules/default` 仍能显示 `timezone=UTC`

`GET /api/attendance/rules/default`（`index.cjs:42369-42378`）调用 `loadDefaultRule`（`:15525-15549`），不调用 `readDefault`。

1. 先查会话组织的 `is_default = true`。
2. 没有，且会话组织不是字面量 `default` 时，再查 `org_id = 'default'`，有则 `mapRuleRow` 返回**那一行**。`mapRuleRow` 把空时区填成 `DEFAULT_RULE.timezone`（`:8615`），所以哨兵行上的 SQL NULL 也会显示成 `UTC`。
3. 还是没有，返回 `{ ...DEFAULT_RULE, orgId: targetOrg }`。常量本身是 `name: 'Default'`、`timezone: 'UTC'`、`09:00–18:00`、`isDefault: true`、`orgId: 'default'`（`:77-92`）。没有数据库 `id`。
4. 查询因缺列失败时，同样返回这份内存常量（`:15551-15553`）。严格 reader 在缺 `timezone_version` 时是 503，不是这次的 422，所以现场的严格查询已经执行并得到零行。

`GET /api/attendance/settings` 里的 `holidaySync.auto.timezone` 是设置文档的默认值 `'UTC'`（`index.cjs:397-401`），与 `attendance_rules` 无关。

不能仅凭 `UTC`、名称或 `data.id` 判断会话组织，必须分开核对响应形状和可信会话中的组织：

- 响应**没有** `data.id`：返回内存常量；普通组织和字面量 `default` 组织都可能出现。`loadDefaultRule` 用 `targetOrg` 覆盖常量的 `orgId`，查询缺列也可能触发回退；缺少 id 本身不能反推会话组织或表状态。
- 响应**有** `data.id`：有数据库规则行，但仍须核对该行 `orgId` 是否匹配可信 actor/tenant。普通组织也可能得到哨兵组织 `default` 的行；返回了 id 不等于本组织已有默认规则。反之，会话本身为 `default` 时，也可能确实读到本组织的持久行。

本现场“缺本组织默认规则”的判断来自同一会话的严格接口错误码；最新 QA 留言另外明确提供了会话组织信息，不是从缺少 id 推导。`timezone=UTC` 不能当作本组织默认规则已经写好。

同一拒绝已有测试：`packages/core-backend/tests/unit/attendance-timezone-policy-routes.test.ts:105-107`（“refuses missing organization default instead of using a global fallback”）。空行、重复、非法时区、`timezone_version = 0` 的码也分开断言（`:224-228`）。

## 建议：先 (A)，被守卫挡住就停在 (D)

不要做 (B)。让总览改走 `loadDefaultRule` 的内存 `UTC` 或哨兵组织，会绕过上面的测试，也和 #6395 已有决定冲突：多时区关闭时仍要组织自己的默认时区，不用静默回退掩盖缺行。

不要仅为本次总览 422 自动执行 (C)。Draft #6396 是历史上下文回填加上「已有排班时补默认规则」的受控流程，约 40 个文件。它不改变「零行就 422」这个判定，也不代替目标组织的配置验收。原 QA 的“非阻断”仅限已报告的冒烟范围；新上班链路 `prepareLivePunch`（`attendance-timezone-runtime.cjs`，~L257–285）也使用严格 loader，不能推广为打卡不受影响。#6396 的合并、真实回填、部署和启用仍分别先批后动。

**(A) 仅在目标写入获批后，由管理员确认完整业务规则并写入会话组织。** `PUT /api/attendance/rules/default` 不是时区 PATCH。其 payload 构造（`index.cjs` / PUT default handler，~L42417）对未传字段使用 `DEFAULT_RULE`，再用 `actor.orgId` 插入新默认行（~L42451）。只传时区会同时采用 09:00–18:00、周一至周五、迟到/早退宽限各 10 分钟、严重迟到 30 分钟、缺勤 60 分钟、舍入 5 分钟及默认名称；这些内置值不是该组织历史或当前业务规则的证据。

执行前必须确认并显式提供 `name`、`timezone`、`workStartTime`、`workEndTime`、`workingDays`、`lateGraceMinutes`、`earlyGraceMinutes`、`severeLateThresholdMinutes`、`absenceLateThresholdMinutes`、`roundingMinutes`，核对层级约束及可信会话组织。缺失业务依据则停止，不把 `/rules/default` 回退响应直接当作已批准配置复制。插入前 `prepareSourceChange`（`attendance-timezone-runtime.cjs`，~L849–857）若遇有效排班、轮班、时区伴随行或未结束出差，会返回 `503 ATTENDANCE_TIMEZONE_DEFAULT_MISSING`；没有这些来源的组织才可能走现有创建路径，这不证明其历史数据为空。其他非预期错误也停止，不反复 PUT 尝试。

获批写入后，核对持久化规则 id、所属组织和全部规则字段，再复验 `rules/default`、`timezone-policy`、三条总览，以及批准测试身份的打卡、补卡/更正和请假等相关业务。接口 200 不能替代计算结果/组织隔离验收。修改默认规则也不恢复缺失的旧冻结上下文；相关历史另走 #6396 的受控门槛。不要修改另一组织的哨兵行或手写 SQL 绕过守卫。

若 PUT 得到 `ATTENDANCE_TIMEZONE_DEFAULT_MISSING`，停在 **(D)**：保留现有错误提示并报告阻碍。不要把停止绕过解释为环境可发布。若必须在已有排班上补默认规则，或修缺冻结上下文的历史日期，按 #6396 的独立批准及验证流程处理。本轮只修正文档，没有再次执行目标 PUT、修复历史或变更开关。

两项 P2 的修正和验证边界见[验证 MD](attendance-timezone-default-required-6395-verification-20261015.md)。

## English

The 422 means the session org has zero `attendance_rules` rows with `is_default = true`. `readDefault` (`plugins/plugin-attendance/lib/attendance-timezone-policy-store.cjs:141`) throws `ATTENDANCE_TIMEZONE_DEFAULT_REQUIRED`. All three overview routes call that reader, including when multi-timezone is off (`attendance-timezone-context-loader.cjs:73-85`). Group membership and `holidaySync.auto.timezone` are not this check.

`GET /rules/default` uses `loadDefaultRule` (`plugins/plugin-attendance/index.cjs:15525-15549`). With no row for the session org it can return the in-memory `DEFAULT_RULE` (`UTC`, no `id`) or a row belonging to sentinel org `default`. Missing `data.id` identifies the in-memory result, not the session org: non-sentinel orgs can receive it too, and schema errors also trigger that fallback. A present id does not prove that the row belongs to the authenticated org. Check the trusted actor/tenant separately; the default-required error, not the response id, supports the missing-row diagnosis.

Recommendation: (A) only after target-write approval, persist a fully reviewed rule on the authenticated org. This PUT inserts a default rule and fills omitted fields with built-in hours, working days, grace/threshold/rounding values and name; it is not a timezone-only patch. Explicitly confirm all fields listed above. Missing business evidence, `503 ATTENDANCE_TIMEZONE_DEFAULT_MISSING`, or other unexpected errors require a stop, not a SQL bypass or release approval. Validate the stored rule and actual attendance/request behavior. Do not use silent UTC fallback (B) or automatically merge #6396 (C).

The later QA comment reports five endpoints returning 200 after a name/timezone-only PUT. This is reported configuration recovery, not independently rerun target validation or a runtime fix; omitted business-rule fields and end-to-end acceptance remain unconfirmed. The next step for that instance is authorized rule/business verification, not repeating the PUT. Keep #6395 open pending owner acceptance. #6396 merge, real backfill, deployment and enablement remain separately gated.
