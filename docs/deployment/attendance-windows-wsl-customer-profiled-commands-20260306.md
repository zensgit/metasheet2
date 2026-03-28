# Attendance Windows+WSL 客户参数版命令清单（参数集中填写）

目标：只改顶部参数区，后续命令整段复制执行。

## 0) 只改这里（客户参数）

```powershell
$Distro = "Ubuntu-22.04"
$PkgZip = "C:\deploy\metasheet-attendance-onprem-v2.5.0-20260306-current.zip"
$WorkDir = "C:\metasheet"
$WindowsServerIp = "192.168.1.50"
$AdminEmail = "admin@customer.local"
$AdminPassword = "ReplaceWithStrongPassword123!"
$DbPassword = "ReplaceWithStrongDbPassword123!"
$JwtSecret = "ReplaceWith64CharRandomSecret_______________________________"
```

## 1) Windows 管理员 PowerShell（准备）

```powershell
wsl --install -d $Distro
wsl --set-default-version 2

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
Expand-Archive -Path $PkgZip -DestinationPath $WorkDir -Force
wsl -l -v
```

## 2) WSL 内首次准备（启用 systemd）

```powershell
wsl -d $Distro
```

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

```powershell
wsl --shutdown
wsl -d $Distro
```

## 3) WSL 内安装与部署（整段复制）

```bash
set -euo pipefail

sudo apt-get update
sudo apt-get install -y curl git build-essential unzip nginx redis-server postgresql postgresql-contrib
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pnpm pm2
sudo systemctl enable --now postgresql redis-server nginx

sudo mkdir -p /opt/metasheet
sudo chown -R "$USER":"$USER" /opt/metasheet
cd /opt
unzip -q /mnt/c/deploy/metasheet-attendance-onprem-v2.5.0-20260306-current.zip
mv /opt/metasheet-attendance-onprem-* /opt/metasheet 2>/dev/null || true
cd /opt/metasheet
mkdir -p /opt/metasheet/storage/attendance-import
```

把 0) 的 4 个敏感值带入 WSL（在 Windows PowerShell 执行）：

```powershell
wsl -d $Distro -- bash -lc "cat > /tmp/metasheet-secrets.env <<'EOF'
ADMIN_EMAIL=$AdminEmail
ADMIN_PASSWORD=$AdminPassword
DB_PASSWORD=$DbPassword
JWT_SECRET=$JwtSecret
EOF"
```

在 WSL 执行（生成 `app.env`、初始化 DB、部署）：

```bash
set -euo pipefail
cd /opt/metasheet
source /tmp/metasheet-secrets.env

cat > docker/app.env <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=8900
PRODUCT_MODE=attendance
DEPLOYMENT_MODEL=onprem
JWT_SECRET=${JWT_SECRET}
POSTGRES_USER=metasheet
POSTGRES_PASSWORD=${DB_PASSWORD}
POSTGRES_DB=metasheet
DATABASE_URL=postgres://metasheet:${DB_PASSWORD}@127.0.0.1:5432/metasheet
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=
ATTENDANCE_IMPORT_REQUIRE_TOKEN=1
ATTENDANCE_IMPORT_UPLOAD_DIR=/opt/metasheet/storage/attendance-import
ATTENDANCE_IMPORT_CSV_MAX_ROWS=100000
ATTENDANCE_IMPORT_HEAVY_QUERY_TIMEOUT_MS=180000
EOF

ENV_FILE=/opt/metasheet/docker/app.env REQUIRE_ATTENDANCE_ONLY=1 scripts/ops/attendance-onprem-env-check.sh

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

ENV_FILE=/opt/metasheet/docker/app.env \
API_BASE=\"http://127.0.0.1/api\" \
ADMIN_EMAIL=\"${ADMIN_EMAIL}\" \
ADMIN_PASSWORD=\"${ADMIN_PASSWORD}\" \
ADMIN_NAME=\"Administrator\" \
scripts/ops/attendance-onprem-deploy-easy.sh

SERVICE_MANAGER=auto CHECK_NGINX=1 scripts/ops/attendance-onprem-healthcheck.sh
```

## 4) Windows 配置开机自动刷新端口转发

```powershell
Set-Location $WorkDir
$Root = Get-ChildItem -Directory | Select-Object -First 1
Set-Location $Root.FullName

powershell -ExecutionPolicy Bypass -File .\scripts\ops\attendance-wsl-portproxy-task.ps1 -Action Install -Distro $Distro
powershell -ExecutionPolicy Bypass -File .\scripts\ops\attendance-wsl-portproxy-task.ps1 -Action RunNow
powershell -ExecutionPolicy Bypass -File .\scripts\ops\attendance-wsl-portproxy-task.ps1 -Action Status
```

## 5) 验收

```powershell
Invoke-WebRequest http://127.0.0.1/attendance -UseBasicParsing
Write-Host "LAN URL: http://$WindowsServerIp/attendance"
```

## 6) 升级命令（WSL）

```bash
cd /opt/metasheet
ENV_FILE=/opt/metasheet/docker/app.env \
REQUIRE_ATTENDANCE_ONLY=1 \
scripts/ops/attendance-onprem-update.sh
```
