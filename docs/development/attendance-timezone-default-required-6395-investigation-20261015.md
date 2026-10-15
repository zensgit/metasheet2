# #6395 总览 422 `ATTENDANCE_TIMEZONE_DEFAULT_REQUIRED` 调查

日期：2026-10-15。源码基线：`main` `42984091d7fe`（与 run225 包 `gitCommitShort` 一致）。只读调查。不改运行时，不合 #6396，不关闭 #6395。

## 结论

三条总览接口 422，是因为**会话组织在 `attendance_rules` 里没有 `is_default = true` 的行**。`GET /api/attendance/rules/default` 返回的 `timezone=UTC` 不是这行检查的结果。那条 GET 走的是宽松的 `loadDefaultRule`：本组织没有默认行时，它要么返回内存常量 `DEFAULT_RULE`（时区写死 `UTC`），要么改去读哨兵组织 `org_id = 'default'` 的另一行。严格 reader 不接受这两种结果。

多时区关闭、节假日同步时区、考勤组是否绑定，都不是这条 422 的条件。

## 抛出点（当前 main，仅两处）

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

因此响应里的 `orgId: "default"` 加上 `UTC` / `Default` / `09:00–18:00`，只说明下面二者之一：

- 响应**没有** `data.id`：会话组织就是字面量 `default`，表里没有默认行，200 体是内存常量。
- 响应**有** `data.id`：那一行属于哨兵组织 `default`；会话组织是另一个 id，严格 reader 只查会话组织，所以仍是零行 422。

两种形状的操作含义相同：总览使用的会话组织没有自己的持久化默认规则。`timezone=UTC` 不能当作这一行已经写好。

同一拒绝已有测试：`packages/core-backend/tests/unit/attendance-timezone-policy-routes.test.ts:105-107`（“refuses missing organization default instead of using a global fallback”）。空行、重复、非法时区、`timezone_version = 0` 的码也分开断言（`:224-228`）。

## 建议：先 (A)，被守卫挡住就停在 (D)

不要做 (B)。让总览改走 `loadDefaultRule` 的内存 `UTC` 或哨兵组织，会绕过上面的测试，也和 #6395 已有决定冲突：多时区关闭时仍要组织自己的默认时区，不用静默回退掩盖缺行。

不要现在做 (C)。Draft #6396 是历史上下文回填加上「已有排班时补默认规则」的受控流程，约 40 个文件。它不改变「零行就 422」这个判定，也不代替在目标环境写入一行。总览 422 本身不阻断打卡以外的已确认路径，不值得为它合并这套流程。

**(A) 运维写入，且只写会话组织。** 管理员 `PUT /api/attendance/rules/default`，带上该组织真正使用的 IANA 时区。路由用 `actor.orgId` 插入一行 `is_default = true`（`index.cjs:42451-42476`）。插入前 `prepareSourceChange`（`attendance-timezone-runtime.cjs:849-857`）在本组织还没有默认行时，若已有有效排班、有效轮班、时区伴随行或未结束出差，返回 `503 ATTENDANCE_TIMEZONE_DEFAULT_MISSING`，不会插入。空白组织则可以插入，三条总览随后应改 200。写入前可只读看 `GET /api/attendance/timezone-policy`（`attendance-timezone-policy-routes.cjs:27-28`、`:169-170`）：它和总览共用 `readDefault`，现在应同样 422。同时看 `/rules/default` 的 `data.id`，用来区分上面两种显示形状。不要改哨兵组织的行来指望另一个会话组织通过。

若 PUT 得到 `ATTENDANCE_TIMEZONE_DEFAULT_MISSING`，停在 **(D)**：总览继续显示「规则时区不可用」。不要手写 SQL 绕过守卫。以后若必须在已有排班上补默认规则，或要修缺冻结上下文的历史日期，再单独批准 #6396，而不是把它当作这次 422 的最小步骤。

## English

The 422 means the session org has zero `attendance_rules` rows with `is_default = true`. `readDefault` (`plugins/plugin-attendance/lib/attendance-timezone-policy-store.cjs:141`) throws `ATTENDANCE_TIMEZONE_DEFAULT_REQUIRED`. All three overview routes call that reader, including when multi-timezone is off (`attendance-timezone-context-loader.cjs:73-85`). Group membership and `holidaySync.auto.timezone` are not this check.

`GET /rules/default` uses `loadDefaultRule` (`plugins/plugin-attendance/index.cjs:15525-15549`). With no row for the session org it returns the in-memory `DEFAULT_RULE` (`UTC`, no `id`) or a row that belongs to sentinel org `default`. A missing `data.id` means the constant and a session org of literal `default`. A present `data.id` with `orgId` `default` means the sentinel row, while the overview routes query a different org.

Recommendation: (A) `PUT /api/attendance/rules/default` on the session org with the IANA zone that org uses. If that returns `503 ATTENDANCE_TIMEZONE_DEFAULT_MISSING` (`attendance-timezone-runtime.cjs:849-857`), stop at (D) and keep the overview fallback. Do not accept the in-memory UTC value in the overview reader (B). Do not merge Draft #6396 for this non-blocking 422 (C).
