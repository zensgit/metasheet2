# PLM Team Default Presets 验证记录

日期: 2026-03-09

## 变更范围

- 更新 [plmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmTeamFilterPresets.ts)
- 新增迁移 [zzzz20260309133000_add_default_to_plm_filter_team_presets.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260309133000_add_default_to_plm_filter_team_presets.ts)
- 更新 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)
- 更新 [plm-team-filter-presets.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-team-filter-presets.test.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts)
- 更新 [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue)
- 更新 [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue)
- 更新 [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
- 更新 [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)
- 使用本轮设计文档 [plm-team-default-presets-benchmark-design-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-team-default-presets-benchmark-design-20260309.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-team-filter-presets.test.ts`
- `pnpm --filter @metasheet/core-backend migrate`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/core-backend exec eslint src/routes/plm-workbench.ts src/plm/plmTeamFilterPresets.ts`
- `pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchClient.spec.ts tests/usePlmTeamFilterPresets.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- `core-backend` 聚焦单测通过，当前为 `1 file / 2 tests`
- [plm-team-filter-presets.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-team-filter-presets.test.ts) 已补到：
  - `isDefault` 映射
  - 默认状态下的行归一化
- 前端聚焦测试通过，当前为 `2 files / 5 tests`
- [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts) 已覆盖：
  - `list`
  - `save`
  - `set default`
  - `clear default`
  - `delete`
- [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts) 已覆盖：
  - 首次刷新自动应用默认团队预设
  - `save -> set default -> clear default -> delete`
  - 非 owner 删除限制
- `apps/web test` 当前为 `28 files / 108 tests`
- `apps/web type-check / lint / build`、`core-backend build`、根级 `pnpm lint` 均通过

说明：

- 前端聚焦测试与全量测试仍会打印一次 `WebSocket server error: Port is already in use`
- 该提示没有阻断测试通过

## 数据库迁移验证

已通过：

- `pnpm --filter @metasheet/core-backend migrate`

结果：

- 新迁移 [zzzz20260309133000_add_default_to_plm_filter_team_presets.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260309133000_add_default_to_plm_filter_team_presets.ts) 已成功执行
- 迁移输出确认：
  - `migration "zzzz20260309133000_add_default_to_plm_filter_team_presets" was executed successfully`

## 上游健康检查

已通过：

- `curl http://127.0.0.1:7910/api/v1/health`

结果：

- 返回 `200`

```json
{"ok":true,"service":"yuantus-plm","version":"0.1.3","tenant_id":null,"org_id":null,"tenancy_mode":"db-per-tenant-org","schema_mode":"create_all","audit_enabled":false}
```

## Live Runtime 对齐

这轮验证中抓到了一个真实运行态问题：

- `7778` 上原本仍是旧的 dev backend 进程
- 新增的 `/api/plm-workbench/filter-presets/team/:id/default` 路由在旧进程上会直接 `404`

这不是代码错误，而是 live runtime 未重载到本轮实现。

处理结果：

- 已确认旧进程 PID 并停止
- 已以 `PRODUCT_MODE=plm-workbench WORKFLOW_ENABLED=true pnpm --filter @metasheet/core-backend dev:core` 重启 live backend
- 当前 `7778` 上已是包含默认预设路由的新运行态

这一步之后，API 和浏览器 smoke 才具备真实验证意义。

## Live API 验证

已通过：

- `GET /api/auth/dev-token`
- `GET /api/auth/me`
- `POST /api/plm-workbench/filter-presets/team`
- `POST /api/plm-workbench/filter-presets/team/:id/default`
- `GET /api/plm-workbench/filter-presets/team?kind=bom`
- `DELETE /api/plm-workbench/filter-presets/team/:id/default`
- `DELETE /api/plm-workbench/filter-presets/team/:id`

结果：

- `auth/me` 返回 `200`
- `features.mode = plm-workbench`
- `features.workflow = true`

真实 spot-check 返回如下：

```json
{
  "save": {
    "success": true,
    "data": {
      "id": "a28e08d6-1c4f-499d-ada2-f1acfd8a18c7",
      "kind": "bom",
      "isDefault": false
    }
  },
  "setDefault": {
    "success": true,
    "data": {
      "id": "a28e08d6-1c4f-499d-ada2-f1acfd8a18c7",
      "isDefault": true
    }
  },
  "listDefault": {
    "id": "a28e08d6-1c4f-499d-ada2-f1acfd8a18c7",
    "isDefault": true
  },
  "clearDefault": {
    "success": true,
    "data": {
      "id": "a28e08d6-1c4f-499d-ada2-f1acfd8a18c7",
      "isDefault": false
    }
  },
  "delete": {
    "success": true,
    "data": {
      "id": "a28e08d6-1c4f-499d-ada2-f1acfd8a18c7",
      "message": "PLM team preset deleted successfully"
    }
  }
}
```

补充说明：

- 这轮 live API 已证明确实只有一条默认项被标为 `isDefault=true`
- 验证后临时产生的 `PLM Default Preset ...` 测试数据已清理
- 当前 `kind=bom` 团队预设列表已恢复为空，`defaultPresetId = null`

## 浏览器 Smoke

证据已归档到：

- [plm-team-default-presets-20260309](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-default-presets-20260309)

关键文件：

- [page-open.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-default-presets-20260309/page-open.yml)
- [page-save.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-default-presets-20260309/page-save.yml)
- [page-default-set.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-default-presets-20260309/page-default-set.yml)
- [page-reload.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-default-presets-20260309/page-reload.yml)
- [page-clear-default.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-default-presets-20260309/page-clear-default.yml)
- [page-delete.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-default-presets-20260309/page-delete.yml)
- [page-delete.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-default-presets-20260309/page-delete.png)
- [network-delete.log](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-default-presets-20260309/network-delete.log)

主路径：

1. 打开 `http://127.0.0.1:8899/plm`
2. 在 `BOM` 过滤框输入 `gearbox`
3. 在团队预设区输入：
   - `Default`
   - `标准件`
4. 点击 `保存到团队`
5. 点击 `设为默认`
6. 新开一个隔离浏览器会话，再次打开空的 `/plm`
7. 确认地址栏自动变成：
   - `?bomFilter=gearbox`
8. 确认下拉项和提示已出现：
   - `Default (标准件) · dev-user · 默认`
   - `当前默认：Default (标准件)`
9. 点击 `取消默认`
10. 点击 `删除`
11. 确认团队预设下拉恢复为空，默认提示消失

网络结果：

- [network-delete.log](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-default-presets-20260309/network-delete.log) 已确认：
  - `GET /api/auth/me -> 200`
  - `GET /api/plm-workbench/filter-presets/team?kind=bom -> 200`
  - `GET /api/plm-workbench/filter-presets/team?kind=where-used -> 200`
  - `DELETE /api/plm-workbench/filter-presets/team/:id/default -> 200`
  - `DELETE /api/plm-workbench/filter-presets/team/:id -> 200`

补充说明：

- `page-reload.yml` 证明自动默认应用不是只改本地下拉，而是实际把 URL 同步成了 `?bomFilter=gearbox`
- 初始打开与重新打开空 `/plm` 时，页面仍会出现一次既有的 `POST /api/federation/plm/query -> 403`
- 当前 UI 已做默认字段回退，这个既有噪声没有阻断默认预设流程

## 验证结论

这轮证明了六件事：

1. `/plm` 已具备后端唯一的 `team default preset`
2. 默认语义已经覆盖到 live API，而不是停留在前端本地状态
3. 空状态重新进入 `/plm` 时，会自动恢复到团队默认过滤视角
4. 显式 query 与手工操作仍保持更高优先级，没有被强行覆盖
5. 浏览器 smoke 已真实走通 `save -> set default -> reload auto apply -> clear default -> delete`
6. 验证结束后临时数据已清理，没有污染当前本地环境

因此，这轮之后 `/plm` 的团队协作层已经从：

- team preset

推进到了：

- team default preset

如果继续往下做，更自然的下一层是：

- `Documents / CAD / Approvals` 的团队默认视角
- org-level default preset
- `PLM workbench` 首页化入口
