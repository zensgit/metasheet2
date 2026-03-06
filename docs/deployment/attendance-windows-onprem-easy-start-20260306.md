# Attendance Windows 本地部署（极简照做版）

目标：按顺序复制命令即可完成部署（不使用 Docker，Windows Server + Ubuntu VM）。

## 1) 在 Ubuntu 安装依赖（一次性）

```bash
sudo apt-get update
sudo apt-get install -y curl git build-essential nginx redis-server postgresql postgresql-contrib
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pnpm pm2
```

## 2) 解压安装包并准备环境文件

```bash
sudo mkdir -p /opt/metasheet
sudo chown -R "$USER":"$USER" /opt/metasheet
# 把你们交付的安装包解压到 /opt/metasheet（示例）
tar -xzf metasheet-attendance-onprem-<version>.tgz -C /opt
# 如果拿到的是 Windows 友好的 zip 包：
# unzip metasheet-attendance-onprem-<version>.zip -d /opt
# 若解压后目录带版本号，重命名为 metasheet
mv /opt/metasheet-attendance-onprem-* /opt/metasheet 2>/dev/null || true
cd /opt/metasheet
cp docker/app.env.example docker/app.env
# 或直接用已准备好的考勤生产模板：
# cp docker/app.env.attendance-onprem.template docker/app.env
# 或直接用“只需改3项”的部署草案：
# cp docker/app.env.attendance-onprem.ready.env docker/app.env
# 然后把其中所有 change-me 替换为真实值
```

编辑 `docker/app.env`，至少填这些值（必须改成你自己的）：

```env
NODE_ENV=production
PRODUCT_MODE=attendance
DEPLOYMENT_MODEL=onprem
HOST=127.0.0.1
PORT=8900
JWT_SECRET=<strong-random-secret>
POSTGRES_PASSWORD=<strong-db-password>
DATABASE_URL=postgres://metasheet:<strong-db-password>@127.0.0.1:5432/metasheet
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
ATTENDANCE_IMPORT_REQUIRE_TOKEN=1
ATTENDANCE_IMPORT_UPLOAD_DIR=/opt/metasheet/storage/attendance-import
ATTENDANCE_IMPORT_CSV_MAX_ROWS=20000
```

如需可直接复用的生产模板（含校验命令）：

- [attendance-onprem-app-env-template-20260306.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/attendance-onprem-app-env-template-20260306.md)

创建上传目录：

```bash
mkdir -p /opt/metasheet/storage/attendance-import
```

## 3) 先创建数据库（必须）

部署不会自动创建数据库，只会 migration 建表。

```bash
sudo -u postgres psql <<'SQL'
CREATE USER metasheet WITH PASSWORD '<strong-db-password>';
CREATE DATABASE metasheet OWNER metasheet;
GRANT ALL PRIVILEGES ON DATABASE metasheet TO metasheet;
SQL
```

## 4) 配置 Nginx

```bash
cd /opt/metasheet
sudo cp ops/nginx/attendance-onprem.conf.example /etc/nginx/sites-available/metasheet-attendance.conf
sudo ln -sf /etc/nginx/sites-available/metasheet-attendance.conf /etc/nginx/sites-enabled/metasheet-attendance.conf
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
```

## 5) 一键部署 + 初始化管理员 + 健康检查

```bash
cd /opt/metasheet
chmod +x scripts/ops/attendance-onprem-deploy-easy.sh

ENV_FILE=/opt/metasheet/docker/app.env \
API_BASE="http://127.0.0.1/api" \
ADMIN_EMAIL="admin@your-company.local" \
ADMIN_PASSWORD="<StrongPasswordAtLeast12Chars>" \
ADMIN_NAME="Administrator" \
scripts/ops/attendance-onprem-deploy-easy.sh
```

该命令会自动执行：

1. 环境检查
2. 安装依赖 + build
3. migration 建表
4. 启动后端（PM2）
5. 初始化管理员账号与权限
6. 健康检查

## 6) 打开系统

- 页面：`http://<你的服务器IP>/attendance`
- 登录：上一步 `ADMIN_EMAIL / ADMIN_PASSWORD`

## 7) 日常更新（照抄）

```bash
cd /opt/metasheet
ENV_FILE=/opt/metasheet/docker/app.env \
REQUIRE_ATTENDANCE_ONLY=1 \
scripts/ops/attendance-onprem-update.sh
```

## 8) 快速自检（照抄）

```bash
cd /opt/metasheet
SERVICE_MANAGER=auto \
CHECK_NGINX=1 \
scripts/ops/attendance-onprem-healthcheck.sh
```

如需“部署后 30 分钟完整验收命令”：

- [attendance-onprem-postdeploy-30min-verification-20260306.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/attendance-onprem-postdeploy-30min-verification-20260306.md)

---

如需完整版（含 systemd、回滚、扩展模块）见：

- [attendance-windows-onprem-no-docker-20260306.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/attendance-windows-onprem-no-docker-20260306.md)

如需 Windows Server + WSL2 专项部署步骤（含端口转发）见：

- [attendance-windows-wsl-onprem-20260306.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/attendance-windows-wsl-onprem-20260306.md)
  - 其中包含一键脚本：`scripts/ops/attendance-wsl-portproxy-refresh.ps1`
  - 以及开机自动刷新任务脚本：`scripts/ops/attendance-wsl-portproxy-task.ps1`
  - 复制执行命令版：`docs/deployment/attendance-windows-wsl-direct-commands-20260306.md`

如需“只发安装包、不拉代码”的规范与升级命令，见：

- [attendance-onprem-package-layout-20260306.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/attendance-onprem-package-layout-20260306.md)

如需先在发布机生成 `.tgz` 安装包，再发客户现场部署，也用同一文档里的 `package-build` / `package-verify` 命令。

上线当天执行建议配套文档：

- [attendance-go-live-checklist-20260306.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/attendance-go-live-checklist-20260306.md)
- [attendance-uat-signoff-template-20260306.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/attendance-uat-signoff-template-20260306.md)
