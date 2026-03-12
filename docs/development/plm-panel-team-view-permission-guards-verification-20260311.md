# PLM Panel Team View Permission Guards 验证记录

日期: 2026-03-11

## 变更范围

- 更新 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 更新 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)
- 更新 [plm-workbench-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-routes.test.ts)
- 使用设计文档 [plm-panel-team-view-permission-guards-benchmark-design-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-permission-guards-benchmark-design-20260311.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts --watch=false`
- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-workbench-routes.test.ts`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- `usePlmTeamViews.spec.ts` 通过，当前 `1 file / 14 tests`
- `plm-workbench-routes.test.ts` 通过，当前 `1 file / 20 tests`
- `apps/web` package 级测试通过，当前为 `30 files / 146 tests`
- `type-check / lint / build` 全部通过
- backend build 通过
- 根级 `pnpm lint` 通过

## 聚焦覆盖点

前端 hook 现在已经锁住：

1. archived panel team view 下：
   - `canShareTeamView = false`
   - `canTransferTeamView = false`
   - `canClearTeamViewDefault = false`
2. 程序化调用也不会继续执行请求：
   - `shareTeamView()`
   - `transferTeamView()`
   - `clearTeamViewDefault()`
3. 提示文案统一为：
   - `请先恢复文档团队视角，再执行分享。`
   - `请先恢复文档团队视角，再执行转移所有者。`
   - `请先恢复文档团队视角，再取消默认。`

后端 route 现在已经锁住：

1. archived team view `transfer -> 409`
2. archived team view `clear default -> 409`

## Live API 验证

本轮重新启动 fresh backend 到 `7778`，然后走完整路径：

1. `GET /api/auth/dev-token`
2. `GET /api/auth/me`
3. `POST /api/plm-workbench/views/team`
4. `POST /api/plm-workbench/views/team/:id/archive`
5. `POST /api/plm-workbench/views/team/:id/transfer`
6. `DELETE /api/plm-workbench/views/team/:id/default`
7. `DELETE /api/plm-workbench/views/team/:id`

artifact：

- [plm-panel-team-view-permission-guards-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-permission-guards-20260311.json)

关键结果：

1. `auth/me -> 200`
2. `create -> 201`
3. `archive -> 200`
4. `transfer -> 409`
   - `Archived PLM team views cannot be transferred`
5. `clear default -> 409`
   - `Archived PLM team views cannot clear the default PLM team view`
6. `cleanup -> 200`

live 测试数据：

- view id: `9469e190-e4cc-4bd0-8cc7-511342d5b47b`
- kind: `documents`
- name: `Archived Panel Guard Source`

## 运行态结论

这轮已经确认：

1. archived panel team view 的权限边界现在前后端一致
2. stale client 或绕过 UI 的请求不再落到错误的运行时分支
3. live backend fresh 重启后也会稳定返回 `409`
4. 之前那份旧实例上的错误 live 结果已经被新 artifact 覆盖，不再作为有效证据

## 非阻塞噪声

本轮仍能看到两类既有噪声，但都不阻断通过：

1. web vitest 会打印一次 `WebSocket server error: Port is already in use`
2. backend vitest 会打印一次 Vite CJS deprecation 提示

## 最终判断

本轮 `PLM panel team view permission guards` 已闭环：

1. 代码层已补 runtime guard
2. API 层已补 archived `409`
3. focused tests 已锁住行为
4. full web checks 已通过
5. live API 证据已更新为 fresh backend 结果
