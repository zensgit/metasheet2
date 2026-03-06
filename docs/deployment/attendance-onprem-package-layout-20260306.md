# Attendance 本地安装包规范（Windows/Ubuntu，无 Git 拉取）

目标：现场机器不执行 `git pull`，仅通过你们交付的安装包完成安装和升级。

## 0. 在发布机生成安装包（发客户前）

```bash
cd /Users/huazhou/Downloads/Github/metasheet2
chmod +x scripts/ops/attendance-onprem-package-build.sh
scripts/ops/attendance-onprem-package-build.sh
```

如果使用 GitHub Actions 生成交付包：

```bash
gh workflow run attendance-onprem-package-build.yml -f package_tag=20260306-r1
```

如果同时发布到 GitHub Releases（推荐给 Windows 客户直接下载 `.zip`）：

```bash
gh workflow run attendance-onprem-package-build.yml \
  -f package_tag=20260306-r1 \
  -f publish_release=true \
  -f release_tag=v2.5.0-onprem-20260306-r1 \
  -f release_name='Attendance On-Prem v2.5.0 (20260306-r1)'
```

产物目录：

- `output/releases/attendance-onprem/*.tgz`
- `output/releases/attendance-onprem/*.zip`
- `output/releases/attendance-onprem/SHA256SUMS`
- `output/releases/attendance-onprem/*.json`

发包前校验：

```bash
chmod +x scripts/ops/attendance-onprem-package-verify.sh
scripts/ops/attendance-onprem-package-verify.sh \
  output/releases/attendance-onprem/<PACKAGE_NAME>.tgz
scripts/ops/attendance-onprem-package-verify.sh \
  output/releases/attendance-onprem/<PACKAGE_NAME>.zip
```

最近一次本地构建/验包记录：

- [attendance-onprem-package-build-verification-20260306.md](/Users/huazhou/Downloads/Github/metasheet2/docs/attendance-onprem-package-build-verification-20260306.md)

最近一次 GitHub Actions 构建记录（仓库已为 public）：

- Run ID：`22746728368`
- 证据目录：`output/playwright/ga/22746728368/attendance-onprem-package-22746728368-1/`
- 验签结果：`PASS`（`attendance-onprem-package-verify.sh`）

## 1. 安装包最小目录

解压后目录建议固定为 `/opt/metasheet`，至少包含：

```text
metasheet/
  apps/
  packages/
  scripts/ops/
    attendance-onprem-package-install.sh
    attendance-onprem-package-upgrade.sh
    attendance-onprem-deploy-easy.sh
    attendance-onprem-bootstrap.sh
    attendance-onprem-bootstrap-admin.sh
    attendance-onprem-env-check.sh
    attendance-onprem-healthcheck.sh
    attendance-onprem-update.sh
  docker/app.env.example
  docker/app.env.attendance-onprem.template
  docker/app.env.attendance-onprem.ready.env
  ops/nginx/attendance-onprem.conf.example
  ecosystem.config.cjs
  package.json
  pnpm-lock.yaml
  pnpm-workspace.yaml
```

建议同时包含（降低现场依赖）：

- `apps/web/dist`
- `packages/core-backend/dist`

## 2. 首次安装（照抄）

```bash
cd /opt/metasheet
cp docker/app.env.example docker/app.env
# 编辑 app.env（必须填 JWT_SECRET / DATABASE_URL / PRODUCT_MODE=attendance 等）
```

先确保数据库已创建（DBA 步骤）：

```sql
CREATE USER metasheet WITH PASSWORD '<strong-db-password>';
CREATE DATABASE metasheet OWNER metasheet;
GRANT ALL PRIVILEGES ON DATABASE metasheet TO metasheet;
```

执行安装：

```bash
cd /opt/metasheet
chmod +x scripts/ops/attendance-onprem-package-install.sh
ENV_FILE=/opt/metasheet/docker/app.env \
API_BASE="http://127.0.0.1/api" \
ADMIN_EMAIL="admin@your-company.local" \
ADMIN_PASSWORD="<StrongPasswordAtLeast12Chars>" \
ADMIN_NAME="Administrator" \
scripts/ops/attendance-onprem-package-install.sh
```

## 3. 升级（照抄，无 git）

步骤：

1. 备份当前目录（建议）。
2. 新版本安装包覆盖到 `/opt/metasheet`。
3. 保留原 `docker/app.env`。
4. 执行升级脚本。

```bash
cd /opt/metasheet
chmod +x scripts/ops/attendance-onprem-package-upgrade.sh
ENV_FILE=/opt/metasheet/docker/app.env \
API_BASE="http://127.0.0.1/api" \
BASE_URL="http://127.0.0.1" \
scripts/ops/attendance-onprem-package-upgrade.sh
```

默认行为：

- 不执行 `git pull`
- 执行 migration
- 重启服务
- 执行健康检查

如果包内没有预构建 dist，可临时加：

```bash
BUILD_WEB=1 BUILD_BACKEND=1 INSTALL_DEPS=1 scripts/ops/attendance-onprem-package-upgrade.sh
```

## 4. 数据库初始化说明

- 安装/升级脚本会运行 migration，自动创建/升级所有业务表。
- 但不会自动创建数据库实例本身（`CREATE DATABASE` 仍需 DBA 或初始化 SQL 先完成）。

## 5. 推荐发包策略

每个版本一个包，命名示例：

- `metasheet-attendance-onprem-v1.0.0.tgz`
- `metasheet-attendance-onprem-v1.0.0.zip`

发包附带：

1. `SHA256SUMS`
2. 本文档
3. 版本变更说明（新增迁移、回滚风险点）
4. 上线执行清单：`docs/deployment/attendance-go-live-checklist-20260306.md`
5. UAT 签收模板：`docs/deployment/attendance-uat-signoff-template-20260306.md`
