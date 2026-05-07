# DingTalk 目录自动准入查看本地用户链接开发及验证

## 开发目标

- 将“自动准入临时凭据”结果卡片的操作面补齐到与其他目录治理结果一致。
- 在无邮箱成员被自动创建后，管理员不仅能复制精确用户治理链接，还应该能直接点击进入该用户的用户管理页。

## 本轮实现

### 1. 自动准入结果卡片新增查看入口

- 文件：`apps/web/src/views/DirectoryManagementView.vue`
- 在每个 `autoAdmissionOnboardingPackets` 卡片中新增 `查看本地用户`。
- 路由直接复用已有 `buildUserManagementLocation(...)`，使用：
  - `packet.userId`
  - `packet.accountId`
  - `packet.integrationId`

### 2. 补齐前端回归测试

- 文件：`apps/web/tests/directoryManagementView.spec.ts`
- 在“手动同步并刷新当前集成”用例中增加断言：
  - 自动准入卡片中存在 `查看本地用户`
  - 其 `href` 为精确用户治理链接
  - 同时保留上一轮已补的 `复制用户链接` 验证

## 验证命令

```bash
pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts tests/userManagementView.spec.ts --watch=false
git diff --check
```

## 验证结果

- `directoryManagementView.spec.ts` 37/37 通过
- `userManagementView.spec.ts` 33/33 通过
- 总计 70/70 通过
- `git diff --check` 通过

## 结果

- 目录页自动准入结果现在具备完整的治理协作操作：
  - `查看本地用户`
  - `复制用户链接`
- 这样自动准入、手工创建、目录定位三条主要链路都已经能直接跳入或分享精确用户治理页。
