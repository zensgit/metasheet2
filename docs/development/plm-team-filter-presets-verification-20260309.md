# PLM Team Filter Presets 验证记录

日期: 2026-03-09

## 变更范围

- 新增 [plmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmTeamFilterPresets.ts)
- 新增迁移 [zzzz20260309123000_create_plm_filter_team_presets.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260309123000_create_plm_filter_team_presets.ts)
- 新增 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)
- 更新 [index.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/index.ts)
- 新增 [plm-team-filter-presets.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-team-filter-presets.test.ts)
- 新增 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts)
- 新增 [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue)
- 更新 [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue)
- 更新 [PlmPanelShared.css](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmPanelShared.css)
- 新增 [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
- 新增 [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)
- 使用本轮设计文档 [plm-team-filter-presets-benchmark-design-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-team-filter-presets-benchmark-design-20260309.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-team-filter-presets.test.ts`
- `pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchClient.spec.ts tests/usePlmTeamFilterPresets.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web build`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm lint`

结果：

- `core-backend` 聚焦单测通过，当前为 `1 file / 2 tests`
- [plm-team-filter-presets.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-team-filter-presets.test.ts) 已覆盖：
  - `kind` 归一化
  - `state` 归一化
  - 存储值构建
  - 行映射和 owner 管理边界
- 前端聚焦测试通过，当前为 `2 files / 4 tests`
- [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts) 已覆盖：
  - `list`
  - `save`
  - `delete`
  - token header
- [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts) 已覆盖：
  - `refresh -> save -> apply -> delete`
  - 非 owner 删除限制
- `apps/web test` 已到 `28 files / 107 tests`
- `apps/web build`、`core-backend build`、根级 `pnpm lint` 均通过

说明：

- 聚焦测试时 Vitest 打印过一次 `WebSocket server error: Port is already in use`
- 该提示没有阻断测试通过

## 数据库迁移验证

已通过：

- `pnpm --filter @metasheet/core-backend migrate`

结果：

- 新迁移 [zzzz20260309123000_create_plm_filter_team_presets.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260309123000_create_plm_filter_team_presets.ts) 已成功执行
- 迁移输出确认：
  - `migration "zzzz20260309123000_create_plm_filter_team_presets" was executed successfully`

## 上游健康检查

已通过：

- `curl http://127.0.0.1:7910/api/v1/health`

结果：

- 返回 `200`

```json
{"ok":true,"service":"yuantus-plm","version":"0.1.3","tenant_id":null,"org_id":null,"tenancy_mode":"db-per-tenant-org","schema_mode":"create_all","audit_enabled":false}
```

## Live Runtime 对齐

这轮不是只在源码层增加接口，我还把 live backend 切到了最新代码：

- 旧 `7778` backend 已停掉
- 新 backend 已用最新 `plm-workbench` 路由重启
- 当前 live dev 仍由 `7778` 提供 API、`8899` 提供前端代理

这一步的目的，是保证 `PLM team presets` 的浏览器验证走的是真实 runtime，而不是只靠单元测试。

## Live API 验证

已通过：

- `GET /api/auth/dev-token`
- `GET /api/auth/me`
- `POST /api/plm-workbench/filter-presets/team`
- `GET /api/plm-workbench/filter-presets/team?kind=bom`
- `DELETE /api/plm-workbench/filter-presets/team/:id`

结果：

- `auth/me` 返回 `200`
- `features.mode = plm-workbench`
- `features.workflow = true`

真实 spot-check 返回如下：

```json
{
  "authMe": {
    "success": true,
    "data": {
      "user": {
        "id": "dev-user",
        "role": "admin"
      },
      "features": {
        "workflow": true,
        "mode": "plm-workbench"
      }
    }
  },
  "save": {
    "success": true,
    "data": {
      "id": "e78584d9-e354-4646-8f62-c6d649f5bb7f",
      "kind": "bom",
      "scope": "team",
      "name": "PLM Team Preset 1773040705",
      "ownerUserId": "dev-user",
      "canManage": true,
      "state": {
        "field": "path",
        "value": "root/gearbox",
        "group": "关键件"
      }
    }
  },
  "delete": {
    "success": true,
    "data": {
      "id": "e78584d9-e354-4646-8f62-c6d649f5bb7f",
      "message": "PLM team preset deleted successfully"
    }
  }
}
```

补充说明：

- 这轮顺手发现真实 envelope 是 `success + data`，而不是旧的 `preset` 包装
- spot-check 临时产生的 `PLM Team Preset ...` 测试数据已在验证后清理
- 当前 `kind=bom` 团队预设列表已恢复为空

## 浏览器 Smoke

证据已归档到：

- [plm-team-filter-presets-20260309](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-filter-presets-20260309)

关键文件：

- [page-open.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-filter-presets-20260309/page-open.yml)
- [page-save.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-filter-presets-20260309/page-save.yml)
- [page-apply.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-filter-presets-20260309/page-apply.yml)
- [page-delete.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-filter-presets-20260309/page-delete.yml)
- [page-delete.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-filter-presets-20260309/page-delete.png)
- [network-delete.log](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-filter-presets-20260309/network-delete.log)

主路径：

1. 打开 `http://127.0.0.1:8899/plm`
2. 确认页面落到 `PLM - MetaSheet`
3. 在 `BOM` 过滤框输入 `gearbox`
4. 在团队预设区输入：
   - `Shared Gearbox`
   - `关键件`
5. 点击 `Save to Team`
6. 确认下拉项出现：
   - `Shared Gearbox (关键件) · dev-user`
7. 把 `BOM` 过滤值改成 `motor`
8. 点击 `Apply`
9. 确认过滤值回到 `gearbox`
10. 点击 `Delete`
11. 确认团队预设下拉恢复为空，`Apply / Delete` 按钮变为禁用

网络结果：

- [network-delete.log](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-filter-presets-20260309/network-delete.log) 已确认：
  - `GET /api/auth/me -> 200`
  - `GET /api/plm-workbench/filter-presets/team?kind=bom -> 200`
  - `GET /api/plm-workbench/filter-presets/team?kind=where-used -> 200`
  - `POST /api/plm-workbench/filter-presets/team -> 201`
  - `DELETE /api/plm-workbench/filter-presets/team/:id -> 200`

## 验证结论

这轮证明了五件事：

1. `/plm` 已具备最小可用的后端持久化 `team presets`
2. `BOM` 和 `Where-Used` 共享了同一套保存、应用、删除和 owner 边界
3. 新接口已经不只是源码存在，而是 live backend 可真实调用
4. 浏览器 smoke 已走通 `save -> apply -> delete`
5. spot-check 临时数据已清理，没有污染本地长期数据

因此，这轮之后 `/plm` 的过滤能力已经从：

- 本地 preset
- share-link

推进到了：

- 后端持久化的 team preset

如果继续往下做，更自然的下一层是：

- team default presets
- org-level shared presets
- `Documents / CAD / Approvals` 的团队视角沉淀
