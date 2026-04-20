# 无邮箱自动准入临时凭据开发说明 2026-04-19

## 目标

在“无邮箱用户闭环”基础上继续补齐自动准入场景：

- 钉钉目录同步命中的无邮箱成员，也允许自动创建本地账号
- 同步完成后，后端直接返回一组 onboarding packet
- 管理员可在目录同步页查看账号、临时密码和引导文案，并通过安全渠道下发

本轮不引入新的消息通道，不直接发短信或钉钉消息，只负责把凭据包安全地返回给管理员。

## 方案

### 后端自动准入

- 保持现有白名单/排除部门判断不变
- 当成员命中自动准入且没有邮箱时：
  - 生成稳定的平台用户名
  - 生成临时密码
  - 创建本地用户
  - 强制首登改密
  - 绑定 DingTalk identity 和 directory link
  - 返回 onboarding packet

### 用户名生成

- 新增 `buildDirectoryAutoAdmissionUsername()`
- 输入使用目录账号的稳定字段：
  - `external_user_id`
  - `union_id`
  - `open_id`
  - `account.id`
- 输出形如：
  - `dt_<stable-source>_<short-account-id>`

目标是：

- 尽量可读
- 重跑同步时稳定
- 不依赖邮箱

### 返回包

新增 `DirectoryAutoAdmissionOnboardingPacket`：

- `userId`
- `name`
- `email`
- `username`
- `mobile`
- `temporaryPassword`
- `onboarding`

这组数据跟随 `/api/admin/directory/integrations/:integrationId/sync` 的响应一起返回。

## 核心改动

### 后端

- `packages/core-backend/src/directory/directory-sync.ts`
  - 新增 `DirectoryAutoAdmissionOnboardingPacket`
  - 新增 `buildDirectoryAutoAdmissionUsername()`
  - `syncDirectoryIntegration()` 返回值扩展为：
    - `integration`
    - `run`
    - `autoAdmissionOnboardingPackets`
  - 自动准入逻辑不再把“缺邮箱”直接视为硬阻塞
  - 无邮箱自动准入成功后：
    - `autoAdmittedCount += 1`
    - `autoAdmittedNoEmailCount += 1`
    - 记录 onboarding packet
  - 有邮箱自动准入仍走 invite token / invite ledger

### 前端

- `apps/web/src/views/DirectoryManagementView.vue`
  - 新增 `autoAdmissionOnboardingPackets` 状态
  - 手动同步成功后解析 `autoAdmissionOnboardingPackets`
  - 新增“本次自动准入临时凭据”结果卡
  - 同步状态文案新增：
    - `其中 X 位成员无邮箱，已生成平台登录账号和临时密码`
  - 切换集成或重新同步时会清掉旧的自动准入凭据结果

## 范围外

- 自动给无邮箱用户发送短信
- 自动给无邮箱用户发送钉钉消息
- 自动为无邮箱用户生成邀请链接
- 新的账号通知渠道治理

## 部署影响

- 本轮没有新增数据库迁移
- 本轮没有远端部署
