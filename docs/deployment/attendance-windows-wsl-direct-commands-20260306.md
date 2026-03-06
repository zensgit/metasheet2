# Attendance Windows Server + WSL2 一键命令清单（可直接复制）

说明：本清单假设你已经拿到离线交付包，并放在 `C:\deploy\`。

默认包名示例：

- `metasheet-attendance-onprem-v2.5.0-20260306-wsltask.zip`

## A. Windows 管理员 PowerShell（先执行）

```powershell
# 0) 基本变量（按实际修改）
$Distro = "Ubuntu-22.04"
$PkgZip = "C:\deploy\metasheet-attendance-onprem-v2.5.0-20260306-wsltask.zip"
$WorkDir = "C:\metasheet"

# 1) 启用 WSL2（首次机器执行，可能要求重启）
wsl --install -d $Distro
wsl --set-default-version 2

# 2) 准备 Windows 工作目录并解压（用于调用 .ps1 工具脚本）
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
Expand-Archive -Path $PkgZip -DestinationPath $WorkDir -Force

# 3) 查看 WSL 发行版状态
wsl -l -v
```

## B. 进入 WSL Ubuntu（执行部署）

```powershell
wsl -d Ubuntu-22.04
```

在 WSL 里执行：

```bash
set -euo pipefail

# 1) 开启 systemd
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

回到 Windows PowerShell 执行：

```powershell
wsl --shutdown
wsl -d Ubuntu-22.04
```

再次在 WSL 执行：

```bash
set -euo pipefail

# 2) 安装依赖
sudo apt-get update
sudo apt-get install -y curl git build-essential unzip nginx redis-server postgresql postgresql-contrib
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pnpm pm2

# 3) 启动基础服务
sudo systemctl enable --now postgresql redis-server nginx

# 4) 解压交付包到 /opt/metasheet
sudo mkdir -p /opt/metasheet
sudo chown -R "$USER":"$USER" /opt/metasheet
cd /opt
unzip -q /mnt/c/deploy/metasheet-attendance-onprem-v2.5.0-20260306-wsltask.zip
mv /opt/metasheet-attendance-onprem-* /opt/metasheet 2>/dev/null || true
cd /opt/metasheet

# 5) 生成 app.env（先用 ready 模板）
cp docker/app.env.attendance-onprem.ready.env docker/app.env
```

编辑 `docker/app.env`，替换这 3 项：

1. `JWT_SECRET`
2. `POSTGRES_PASSWORD`
3. `DATABASE_URL` 中数据库密码

```bash
cd /opt/metasheet
nano docker/app.env
```

继续执行：

```bash
set -euo pipefail
cd /opt/metasheet

# 6) 环境检查（通过才继续）
ENV_FILE=/opt/metasheet/docker/app.env \
REQUIRE_ATTENDANCE_ONLY=1 \
scripts/ops/attendance-onprem-env-check.sh

# 7) 初始化数据库
DB_PASSWORD="$(grep '^POSTGRES_PASSWORD=' docker/app.env | cut -d= -f2-)"
sudo -u postgres psql <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'metasheet') THEN
    CREATE ROLE metasheet LOGIN PASSWORD '${DB_PASSWORD}';
  END IF;
END
\$\$;
SQL
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='metasheet'" | grep -q 1 || sudo -u postgres createdb -O metasheet metasheet
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE metasheet TO metasheet;"

# 8) 上传目录
mkdir -p /opt/metasheet/storage/attendance-import

# 9) 一键部署 + 初始化管理员
ENV_FILE=/opt/metasheet/docker/app.env \
API_BASE="http://127.0.0.1/api" \
ADMIN_EMAIL="admin@your-company.local" \
ADMIN_PASSWORD="ReplaceWithStrongPassword123!" \
ADMIN_NAME="Administrator" \
scripts/ops/attendance-onprem-deploy-easy.sh

# 10) 本机健康检查
SERVICE_MANAGER=auto CHECK_NGINX=1 scripts/ops/attendance-onprem-healthcheck.sh
```

## C. Windows 管理员 PowerShell（配置端口转发自动刷新）

```powershell
# 进入解压目录（注意脚本在第一层子目录内）
Set-Location C:\metasheet
$Root = Get-ChildItem -Directory | Select-Object -First 1
Set-Location $Root.FullName

# 1) 安装开机自动刷新任务
powershell -ExecutionPolicy Bypass -File .\scripts\ops\attendance-wsl-portproxy-task.ps1 -Action Install -Distro Ubuntu-22.04

# 2) 立即执行一次
powershell -ExecutionPolicy Bypass -File .\scripts\ops\attendance-wsl-portproxy-task.ps1 -Action RunNow

# 3) 查看状态
powershell -ExecutionPolicy Bypass -File .\scripts\ops\attendance-wsl-portproxy-task.ps1 -Action Status
```

## D. 验收（Windows）

```powershell
Invoke-WebRequest http://127.0.0.1/attendance -UseBasicParsing
```

局域网访问：

- `http://<windows-server-ip>/attendance`

## E. 后续更新（WSL 内）

```bash
cd /opt/metasheet
ENV_FILE=/opt/metasheet/docker/app.env \
REQUIRE_ATTENDANCE_ONLY=1 \
scripts/ops/attendance-onprem-update.sh
```
