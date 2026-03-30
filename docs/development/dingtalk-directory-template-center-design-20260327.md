# DingTalk Directory Template Center Design

日期：2026-03-27

## 目标

本轮同时完成 4 项收口：

1. 服务端预设中心
2. 治理报表导出
3. 定时目录同步与异常告警
4. GitHub 基线收口材料

目标不是继续堆前端按钮，而是把浏览器本地能力提升为可共享、可审计、可回滚、可运营的后端能力。

## 范围

涉及文件：

- `packages/core-backend/src/directory/directory-sync.ts`
- `packages/core-backend/src/routes/admin-directory.ts`
- `packages/core-backend/src/db/migrations/zzzz20260327110000_create_directory_template_center_and_alerts.ts`
- `apps/web/src/views/DirectoryManagementView.vue`
- `packages/openapi/src/base.yml`
- `packages/openapi/src/paths/admin-directory.yml`

## 设计概览

### 1. 服务端预设中心

新增三张表：

- `directory_template_centers`
- `directory_template_center_versions`
- `directory_sync_alerts`

其中：

- `directory_template_centers` 保存当前生效的团队模板、导入历史、导入预设
- `directory_template_center_versions` 保存每次变更后的快照版本
- `directory_sync_alerts` 保存计划同步和同步失败的告警记录

模板中心服务端能力由 `DirectorySyncService` 统一提供：

- `getTemplateCenter`
- `saveTemplateCenter`
- `listTemplateCenterVersions`
- `restoreTemplateCenterVersion`

前端不再把“团队标准模板/导入预设/导入历史”只存在浏览器本地，而是：

- 进入集成页时先拉服务端模板中心
- 模板编辑后自动回写服务端
- 若服务端为空且浏览器仍有旧缓存，则先把旧缓存迁移上去

这里特别修复了一个真实缺陷：

- 旧逻辑会先把本地缓存替换成服务端空快照，再判断是否迁移
- 新逻辑先快照本地状态，再决定是否迁移，避免把迁移机会自己抹掉

### 2. 治理报表导出

新增治理报表能力：

- JSON：`GET /api/admin/directory/integrations/:integrationId/template-center/report`
- CSV：`GET /api/admin/directory/integrations/:integrationId/template-center/report.csv`

报表内容覆盖：

- 输出模式数
- 团队标准模板数
- 导入预设数
- 收藏/置顶/高频/低频/未使用分布
- 标签汇总
- 预设清单

CSV 导出用于管理员治理，不承担归档备份语义。

### 3. 定时同步与异常告警

新增运维态接口：

- `GET /api/admin/directory/integrations/:integrationId/schedule-status`
- `GET /api/admin/directory/integrations/:integrationId/alerts`
- `POST /api/admin/directory/integrations/:integrationId/alerts/:alertId/ack`

后端增强点：

- 读取最近同步运行状态
- 计算下一次计划执行时间
- 对同步失败和计划注册失败记录告警
- 对计划任务来源的失败支持发送 webhook

告警来源统一写入 `details.source`：

- `manual`
- `scheduled`

### 4. GitHub 基线收口

本轮没有把当前工作树伪装成“已同步 GitHub”，而是明确把事实单独沉淀：

- 当前本地分支相对远端 `ahead 3 / behind 4`
- 当前工作树是 dirty worktree
- 现网服务器目录不是 Git 基线

这部分单独写入 `dingtalk-directory-git-baseline-20260327.md`，作为后续整理分支和提交序列的依据。

## API 设计

新增后端接口：

- `GET /api/admin/directory/integrations/{integrationId}/schedule-status`
- `GET /api/admin/directory/integrations/{integrationId}/template-center`
- `PATCH /api/admin/directory/integrations/{integrationId}/template-center`
- `GET /api/admin/directory/integrations/{integrationId}/template-center/versions`
- `POST /api/admin/directory/integrations/{integrationId}/template-center/versions/{versionId}/restore`
- `GET /api/admin/directory/integrations/{integrationId}/template-center/report`
- `GET /api/admin/directory/integrations/{integrationId}/template-center/report.csv`
- `GET /api/admin/directory/integrations/{integrationId}/alerts`
- `POST /api/admin/directory/integrations/{integrationId}/alerts/{alertId}/ack`

所有接口沿用平台管理员鉴权。

## 前端交互

目录管理页新增服务端运营视图：

- 计划同步摘要
- 告警列表与确认
- 服务端模板中心同步状态
- 服务端版本快照列表
- 治理 CSV / JSON 导出入口

同时保留原有批量失败处理、团队模板、导入预设、历史记录等交互。

## 风险与边界

- 本地 `core-backend` 全量 `tsc` 在当前开发机上被系统 `SIGKILL`，不是类型报错，而是环境资源问题
- 因为工作树本身很脏，本轮不能以“git clean build”作为唯一可信交付证据
- 服务端模板中心迁移逻辑只在“服务端为空、本地有旧缓存”时触发，不会覆盖已有服务端中心
