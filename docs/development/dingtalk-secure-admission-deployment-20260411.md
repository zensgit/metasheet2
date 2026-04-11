# DingTalk Secure Admission Deployment

日期: 2026-04-11

## 目标

将 PR `#803` 的 DingTalk 安全加固与 namespace admission 改动安全发布到服务器，并保留直接回滚路径。

关联对象：

- PR: `https://github.com/zensgit/metasheet2/pull/803`
- 分支: `codex/dingtalk-secure-admission-20260411`
- 提交: `4572cc489`

## 发布前检查

### 1. 环境变量

确认生产 `docker/app.env` 使用真实换行，不是字面量 `\n`，并包含以下变量：

- `ENCRYPTION_KEY`
- `ENCRYPTION_SALT`
- `DINGTALK_CLIENT_ID`
- `DINGTALK_CLIENT_SECRET`
- `DINGTALK_CORP_ID`
- `DINGTALK_ALLOWED_CORP_IDS`
- `DINGTALK_REDIRECT_URI`
- `DINGTALK_AUTH_AUTO_LINK_EMAIL=1`
- `DINGTALK_AUTH_AUTO_PROVISION=0`
- `DINGTALK_AUTH_REQUIRE_GRANT=1`

关键约束：

- `DINGTALK_CORP_ID` 必须包含在 `DINGTALK_ALLOWED_CORP_IDS` 中
- `DINGTALK_REDIRECT_URI` 必须与钉钉开发者平台配置一致，路径为 `/login/dingtalk/callback`

建议执行：

```bash
scripts/ops/validate-env-file.sh
docker compose config
scripts/ops/attendance-preflight.sh
```

### 2. 备份

发布前先做三类备份：

- 备份根目录 `.env`
- 备份 `docker/app.env`
- 导出一份压缩数据库快照

### 3. 当前版本记录

记录：

- 当前运行镜像 tag
- 目标镜像 tag / commit
- 当前后端健康检查结果

## 条件化迁移修复

正常情况下，直接执行迁移即可。

```bash
pnpm --filter @metasheet/core-backend migrate
```

只有当出现类似错误时，才进入本节：

```text
corrupted migrations: expected previously executed migration ...
```

### 本次已处理过的典型问题

问题模式：

- `zzzz20260404100000_extend_approval_tables_for_bridge` 的 schema 已经在库里
- 但 `kysely_migration` 缺少这条记录
- Kysely 因此拒绝继续执行后续迁移

先核查，不要直接写库：

1. 确认 `approval_assignments` 表已存在
2. 确认 `approval_instances` 上 bridge 扩展字段和索引已存在
3. 确认缺失的只是 `kysely_migration` 账目

若以上都成立，可只补 ledger，不重复改 schema：

```sql
INSERT INTO kysely_migration(name, "timestamp")
SELECT 'zzzz20260404100000_extend_approval_tables_for_bridge', '2026-04-04T02:34:52.657Z'
WHERE NOT EXISTS (
  SELECT 1
  FROM kysely_migration
  WHERE name = 'zzzz20260404100000_extend_approval_tables_for_bridge'
);
```

说明：

- `kysely_migration.timestamp` 在本仓库当前实现里是 `varchar`
- Kysely 会先按时间戳解析排序，时间戳相同时再按 migration name 排序
- 这里使用与 `zzzz20260404121000_create_meta_comment_reads` 相同的时间戳，是为了让 `04100000` 稳定排在 `04121000` 前面

补账后重新执行：

```bash
pnpm --filter @metasheet/core-backend migrate
```

## 发布顺序

### 1. 数据库先行

先完成数据库动作，再切服务：

```bash
pnpm --filter @metasheet/core-backend migrate
pnpm --filter @metasheet/core-backend exec tsx scripts/encrypt-dingtalk-integration-secrets.ts
```

预期：

- `user_namespace_admissions` 已创建
- 旧目录/考勤集成 secret 已兼容 `enc:` 存储
- 历史有角色的插件成员已完成 `seed_backfill`

### 2. 后端先切

后端更新后先检查：

```bash
curl http://127.0.0.1:8900/health
```

同时验证：

- `/api/auth/dingtalk/launch` 返回 `200`
- DingTalk 凭证可成功换取 access token

### 3. 前端后切

在后端健康且 DingTalk 登录入口正常后，再切 web。

## 发布后冒烟

### 平台管理

- 打开 `/admin/users`
- 选择成员，确认能看到：
  - `钉钉扫码登录`
  - `插件使用`
  - `成员准入`

### 委派管理

- 打开 `/admin/role-delegation`
- 选择成员，确认能看到：
  - `插件使用准入`
  - 命名空间与委派范围说明

### DingTalk 安全基线

- 用 allowlist 外的 `corpId` 创建目录/考勤集成，接口应拒绝
- 查看 DingTalk 机器人日志，不应暴露：
  - `access_token`
  - `sign`
  - `timestamp`

### 数据验证

- `user_namespace_admissions` 表存在
- 本次迁移记录已写入 `kysely_migration`
- 历史目录/考勤集成仍可正常读取与同步

## 回滚

回滚顺序：

1. 停止当前服务
2. 恢复 `.env` 与 `docker/app.env`
3. 切回旧镜像 tag
4. 如数据库变更必须撤销，再从发布前快照恢复数据库

回滚前提：

- 旧镜像仍保留在本机
- 配置文件备份可用
- 数据库快照可用

## 备注

- 本地开发态的默认 `/api/auth/dev-token` 用户是 `dev-user`，若库中不存在该用户，部分 admin 接口会返回 `403`
- 这不影响生产发布，但会影响本地浏览器联调，建议本地验收使用数据库中真实存在的管理员会话
