# Attendance On-Prem V1 部署与 P1 升级手册（2026-03-10）

本手册用于两件事：

1. 用当前稳定包先完成 V1 上线。
2. 后续以“发新包 + 原位升级”方式迭代 P1，不重做初装。

适用发布包：

- Release tag：`attendance-onprem-pr396-20260310`
- Release URL：<https://github.com/zensgit/metasheet2/releases/tag/attendance-onprem-pr396-20260310>

## 0. 前置要求

- 目标环境：Windows Server + WSL2 Ubuntu（或 Linux 服务器）
- 已安装并可用：`postgresql`、`redis`、`nginx`、`nodejs 20`、`pnpm`、`pm2`
- 本文所有命令在 Linux/WSL shell 中执行

## 1. 下载与校验安装包

从 Release 下载以下文件到同一目录：

- `metasheet-attendance-onprem-v2.5.0-run9.tgz`
- `metasheet-attendance-onprem-v2.5.0-run9.tgz.sha256`
- `SHA256SUMS`

校验：

```bash
cd /path/to/package-dir
sha256sum -c SHA256SUMS
```

预期：对应 `.tgz` 校验结果为 `OK`。

## 2. 首次部署（V1 基线）

### 2.1 解压到固定目录

```bash
sudo mkdir -p /opt/metasheet
sudo chown -R "$USER":"$USER" /opt/metasheet
tar -xzf metasheet-attendance-onprem-v2.5.0-run9.tgz --strip-components=1 -C /opt/metasheet
cd /opt/metasheet
```

### 2.2 配置环境变量

```bash
cp docker/app.env.attendance-onprem.ready.env docker/app.env
```

编辑 `docker/app.env`，至少修改：

- `JWT_SECRET`
- `POSTGRES_PASSWORD`
- `DATABASE_URL`
- `REDIS_HOST` / `REDIS_PORT`

并确认：

- `PRODUCT_MODE=attendance`
- `ATTENDANCE_IMPORT_REQUIRE_TOKEN=1`

### 2.3 创建上传目录

```bash
mkdir -p /opt/metasheet/storage/attendance-import
```

### 2.4 首次创建数据库（只做一次）

```bash
sudo -u postgres psql <<'SQL'
CREATE USER metasheet WITH PASSWORD '<DB_PASSWORD>';
CREATE DATABASE metasheet OWNER metasheet;
GRANT ALL PRIVILEGES ON DATABASE metasheet TO metasheet;
SQL
```

注意：部署脚本会做 migration 建表，但不会自动创建数据库实例。

### 2.5 一键安装 + 初始化管理员 + 健康检查

```bash
cd /opt/metasheet
chmod +x scripts/ops/*.sh

ENV_FILE=/opt/metasheet/docker/app.env \
API_BASE=http://127.0.0.1/api \
ADMIN_EMAIL=admin@your-company.local \
ADMIN_PASSWORD='<StrongPassword>' \
ADMIN_NAME='Administrator' \
INSTALL_DEPS=1 \
BUILD_WEB=0 \
BUILD_BACKEND=0 \
RUN_MIGRATIONS=1 \
START_SERVICE=1 \
scripts/ops/attendance-onprem-package-install.sh
```

手动健康检查：

```bash
SERVICE_MANAGER=auto CHECK_NGINX=1 scripts/ops/attendance-onprem-healthcheck.sh
```

访问：

- `http://<服务器IP>/attendance`

## 3. 后续 P1 升级（原位升级，不重装）

每次拿到新包后按以下流程执行。

### 3.1 先备份（强制建议）

```bash
pg_dump -Fc -d metasheet -f /opt/backup/metasheet_$(date +%F_%H%M).dump
tar -czf /opt/backup/metasheet_code_$(date +%F_%H%M).tgz /opt/metasheet
```

### 3.2 覆盖代码

```bash
tar -xzf metasheet-attendance-onprem-<new>.tgz --strip-components=1 -C /opt/metasheet
cd /opt/metasheet
```

### 3.3 执行升级

```bash
ENV_FILE=/opt/metasheet/docker/app.env \
INSTALL_DEPS=1 \
BUILD_WEB=0 \
BUILD_BACKEND=0 \
RUN_MIGRATIONS=1 \
RESTART_SERVICE=1 \
RUN_HEALTHCHECK=1 \
scripts/ops/attendance-onprem-package-upgrade.sh
```

## 4. 回滚（最小化方案）

1. 停服务（`pm2 stop metasheet-backend` 或 systemd）。
2. 还原 `/opt/metasheet` 代码备份。
3. 还原数据库备份。
4. 启动服务并执行健康检查。

## 5. 验收清单（上线当天）

1. 管理员可登录。
2. 员工可打卡。
3. 调整申请可提交并审批。
4. 导入预览/提交可用。
5. 报表/导出可用。
6. `attendance-onprem-healthcheck.sh` 返回 `Healthcheck OK`。

## 6. 相关文档

- [attendance-onprem-package-layout-20260306.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/attendance-onprem-package-layout-20260306.md)
- [attendance-windows-onprem-easy-start-20260306.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/attendance-windows-onprem-easy-start-20260306.md)
- [attendance-windows-wsl-onprem-20260306.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/attendance-windows-wsl-onprem-20260306.md)
- [attendance-onprem-postdeploy-30min-verification-20260306.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/attendance-onprem-postdeploy-30min-verification-20260306.md)
