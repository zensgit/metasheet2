# PLM Panel Team View Permission Guards 设计记录

日期: 2026-03-11

## 目标

收紧 `Documents / CAD / Approvals team view` 在 `archived` 状态下的权限边界，确保：

1. 前端不会继续对已归档视图执行：
   - `分享`
   - `转移所有者`
   - `取消默认`
2. 后端即使收到陈旧客户端或绕过 UI 的请求，也会返回明确的 `409`：
   - archived view 不能 `transfer`
   - archived view 不能 `clear default`
3. 前后端对 archived lifecycle 的判断保持一致，不再只依赖“按钮灰掉”。

## 基线判断

当前 `Documents / CAD / Approvals team view` 已经具备：

1. `archive / restore`
2. `duplicate / rename`
3. `share`
4. `owner transfer`
5. `set default / clear default`

但 archived 状态的防护还不够完整：

1. 前端虽然有部分 `canShare / canTransfer` 计算，但缺少对 `clear default` 的运行时阻断。
2. 后端 `transfer` 和 `clear default` 缺少 archived `409`，live 旧实例会继续落到：
   - `Target owner user not found`
   - `200 clear default`

这意味着 archived lifecycle 在“UI 层”和“API 层”之间仍有缝隙。

## 方案

### 1. 前端统一 archived runtime guard

在 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts) 收紧：

1. `canTransferTeamView`
2. `setTeamViewDefault()`
3. `transferTeamView()`
4. `clearTeamViewDefault()`

规则统一为：

- archived view 一律先提示 `请先恢复...`
- 不再继续发请求

这样可以覆盖：

1. 用户点禁用边缘状态
2. UI stale state
3. 程序化调用 hook action

### 2. 后端补 archived 409

在 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts) 明确补两条守卫：

1. `DELETE /api/plm-workbench/views/team/:id/default`
2. `POST /api/plm-workbench/views/team/:id/transfer`

返回统一的 `409` 语义：

- `Archived PLM team views cannot clear the default PLM team view`
- `Archived PLM team views cannot be transferred`

### 3. focused tests + live API 双层锁定

测试层分两层：

1. 前端 hook focused spec  
   验证 archived 视图下不会调用：
   - `copyShareUrl`
   - `transferPlmWorkbenchTeamView`
   - `clearPlmWorkbenchTeamViewDefault`
2. 后端 route focused spec  
   验证 archived 视图下：
   - `transfer -> 409`
   - `clear default -> 409`

然后再用 live backend 重放一次：

1. `create`
2. `archive`
3. `transfer -> 409`
4. `clear default -> 409`
5. `cleanup`

## 对标与超越目标

对标基线是上一轮已经做完的：

- `set default / clear default` URL 一致性

这轮超越点在于：

1. 不再只验证 identity 正确，而是把 archived 权限边界真正补齐
2. 不再只靠前端按钮状态，而是让后端也有一致的拒绝语义
3. live backend 在 fresh 进程下也必须给出同样的 `409`

## 非目标

本轮不做：

1. archived view 的 public share token
2. archived view 的 owner transfer 审批流
3. BOM / Where-Used preset 权限细化
4. 新的 panel lifecycle 功能

## 验证计划

代码级：

- [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- [plm-workbench-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-routes.test.ts)
- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts --watch=false`
- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-workbench-routes.test.ts`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm lint`

live：

1. fresh backend 起到 `7778`
2. `dev-token -> auth/me`
3. 创建一条 documents team view
4. archive 该 view
5. 验证 `transfer -> 409`
6. 验证 `clear default -> 409`
7. delete cleanup
