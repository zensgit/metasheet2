# 钉钉目录诊断设计与验证

## 背景

2026-04-11 线上钉钉目录手动重同步后，系统内仍只有 1 个同步成员：

- 集成 ID：`8b68baf4-526b-477a-8343-c38d9614e2ec`
- 最近一次手动同步：`2026-04-11T07:47:14.975Z` 到 `2026-04-11T07:47:19.346Z`
- 同步统计：`departmentsSynced=1`、`accountsSynced=1`、`linkedCount=1`、`pendingCount=0`
- 落库成员样本：`周华 (0447654442691174)`

同时，钉钉开发者平台资源选择器可以搜到 `王松松`，说明企业租户内并不只有 1 个人。

## 线上核查结论

直接使用线上后端已保存的钉钉应用凭据调用开放接口，结果如下：

1. `/topapi/v2/department/listsub`，`dept_id=1`
   返回 `0` 个子部门。
2. `/topapi/v2/user/list`，`dept_id=1`
   只返回 `周华`。
3. `/topapi/v2/user/list`，`dept_id=1`，`contain_access_limit=true`
   返回结果与上一步完全一致，仍只返回 `周华`。
4. `dept_id=-1`
   对部门和成员接口都不是合法参数。

结论：

- 当前缺人问题不是本地数据库写入链路导致的。
- 当前钉钉开放接口在这套应用授权下，只暴露了根部门 `1` 下的 1 个直属成员。
- 如果企业通讯录实际成员更多，优先怀疑两类问题：
  - 钉钉应用的通讯录接口权限范围没有覆盖整个企业通讯录。
  - 当前配置的 `rootDepartmentId` 不是预期同步入口。

## 本次改动

### 1. 已保存集成支持“无密钥重测”

目录管理页对已保存集成执行“测试连通性”时，允许前端只带 `integrationId` 和当前表单参数，后端复用已保存的 `appSecret`。

目的：

- 避免每次诊断都重新输入或暴露 `appSecret`
- 让线上排障可直接在管理页完成

### 2. 补充根部门诊断信息

后端 `testDirectoryIntegration` 现在额外返回：

- 根部门子部门数量
- 根部门直属成员数量
- `contain_access_limit=true` 时的直属成员数量
- 两组成员样本
- 针对异常场景的诊断告警

前端目录管理页新增展示：

- `根部门子部门`
- `根部门直属成员`
- `含受限成员`
- 根部门直属成员样本
- 诊断告警

这样管理员在页面里就能直接判断问题是在：

- 钉钉权限/范围
- 根部门配置
- 还是本地同步逻辑

### 3. 结构化诊断结论与同步运行历史持久化

在第 2 节原始计数/告警的基础上，进一步补充：

后端 `testDirectoryIntegration` 现在额外返回结构化结论 `summary`：

- `code`：稳定字符串枚举（落库后重命名需迁移），当前取值固定为：
  - `healthy`：通讯录连通正常
  - `no_child_departments`：根部门未返回子部门，但根直属成员看起来正常
  - `scope_or_root_misconfigured`：无子部门且根直属成员稀少，疑似权限范围或根部门配置不当
- `title`：人类可读结论标题
- `nextAction`：建议的下一步动作

`code` 由 `buildDirectoryIntegrationDiagnosticSummary` 从既有计数派生，与第 2 节诊断告警同源，不引入新的判定条件。

手动同步（`triggerSource === 'manual'`）时，`syncDirectoryIntegration` 以 best-effort 方式采样一次根部门诊断，并写入该次运行的 `directory_sync_runs.stats`：

- `rootDepartmentChildCount`
- `rootDepartmentDirectUserCount`
- `rootDepartmentDirectUserHasMore`
- `rootDepartmentDirectUserCountWithAccessLimit`
- `rootDepartmentDirectUserHasMoreWithAccessLimit`
- `diagnosticCode` / `diagnosticTitle` / `diagnosticNextAction`
- `diagnosticWarnings`
- 两组根部门成员样本

约束：

- 诊断采样失败不影响同步本身（吞掉异常并 `logger.warn`，运行状态不因采样失败而判负）。
- 仅在手动触发时采样；定时同步（`scheduler`）不采样，避免给每次自动同步增加额外钉钉调用。
- 前端在运行记录卡片中渲染 `diagnosticTitle`、计数摘要、`diagnosticNextAction` 与诊断告警，管理员无需重跑连通性测试即可回看历史结论。
- 前端连通性测试区在 `summary` 缺失时（旧响应）自动跳过结构化结论块，保持向后兼容。

## 操作建议

部署后，在 `/admin/directory` 中执行：

1. 打开目标钉钉目录集成
2. 点击 `测试连通性`
3. 重点看三项：
   - `根部门子部门`
   - `根部门直属成员`
   - `含受限成员`

判读方式：

- 如果 `根部门子部门=0` 且 `根部门直属成员=1`，基本可判定当前问题仍在钉钉侧权限范围或根部门配置。
- 如果页面已能看到更多根部门成员，但“手动同步”后系统里仍没落库，再继续看本地同步链路。

## 验证

### 自动化验证

已通过：

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-directory-routes.test.ts`
- `pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts`
- `pnpm --filter @metasheet/core-backend exec tsc --noEmit -p tsconfig.json`
- `pnpm --filter @metasheet/web exec vue-tsc --noEmit -p tsconfig.json`

### 线上事实验证

已确认：

- 线上数据库当前只有 1 个钉钉目录成员
- 线上钉钉开放接口当前也只返回 1 个成员
- 本次诊断增强覆盖了这个真实故障模式

## 后续建议

若部署后管理页仍显示根部门只暴露 1 个成员，下一步不要继续盲改同步代码，应回到钉钉开发者平台确认：

1. 通讯录接口权限范围是否为全企业可见
2. 应用可见范围与通讯录接口范围是否一致
3. `rootDepartmentId` 是否对应实际人员所在组织入口
