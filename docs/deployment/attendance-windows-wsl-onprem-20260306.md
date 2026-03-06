# Attendance Windows Server + WSL2 本地部署（无 Docker）

目标：客户只有 Windows Server 时，通过 WSL2（Ubuntu）完成考勤版部署。

适用场景：

1. 服务器系统是 Windows Server
2. 允许启用 WSL2
3. 需要本地化部署且不使用 Docker

## 1) Windows Server 开启 WSL2（PowerShell 管理员）

```powershell
wsl --install -d Ubuntu-22.04
wsl --set-default-version 2
```

如果系统提示需要重启，先重启服务器再继续。

查看发行版状态：

```powershell
wsl -l -v
```

期望：`Ubuntu-22.04` 且 `VERSION=2`。

## 2) 在 WSL 启用 systemd

进入 Ubuntu：

```powershell
wsl -d Ubuntu-22.04
```

写入 `/etc/wsl.conf`：

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

回到 Windows 执行：

```powershell
wsl --shutdown
```

再进入 Ubuntu，确认 systemd 可用：

```powershell
wsl -d Ubuntu-22.04
```

```bash
systemctl --version
```

## 3) 在 WSL Ubuntu 安装依赖

```bash
sudo apt-get update
sudo apt-get install -y curl git build-essential unzip nginx redis-server postgresql postgresql-contrib
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pnpm pm2
```

## 4) 解压交付包并准备 `app.env`

假设交付包在 Windows 路径 `C:\deploy\`，在 WSL 可访问为 `/mnt/c/deploy/`。

```bash
sudo mkdir -p /opt/metasheet
sudo chown -R "$USER":"$USER" /opt/metasheet
cd /opt
tar -xzf /mnt/c/deploy/metasheet-attendance-onprem-<version>.tgz
# 如果使用 zip 包：
# unzip /mnt/c/deploy/metasheet-attendance-onprem-<version>.zip
mv /opt/metasheet-attendance-onprem-* /opt/metasheet 2>/dev/null || true
cd /opt/metasheet
cp docker/app.env.attendance-onprem.ready.env docker/app.env
```

编辑 `docker/app.env`，至少替换这 3 项：

1. `JWT_SECRET`
2. `POSTGRES_PASSWORD`
3. `DATABASE_URL` 中数据库密码

执行环境检查：

```bash
cd /opt/metasheet
ENV_FILE=/opt/metasheet/docker/app.env \
REQUIRE_ATTENDANCE_ONLY=1 \
scripts/ops/attendance-onprem-env-check.sh
```

期望：`Env check OK`。

## 5) 初始化数据库

```bash
sudo -u postgres psql <<'SQL'
CREATE USER metasheet WITH PASSWORD '<strong-db-password>';
CREATE DATABASE metasheet OWNER metasheet;
GRANT ALL PRIVILEGES ON DATABASE metasheet TO metasheet;
SQL
```

创建上传目录：

```bash
mkdir -p /opt/metasheet/storage/attendance-import
```

## 6) 一键部署（WSL 内执行）

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

## 7) Windows 对外访问（端口转发）

WSL2 默认是 NAT 网络，局域网客户端访问 Windows IP 时，需要把 Windows 80/443 转到 WSL。

推荐使用仓库脚本（PowerShell 管理员）：

```powershell
cd C:\metasheet
powershell -ExecutionPolicy Bypass -File .\scripts\ops\attendance-wsl-portproxy-refresh.ps1 -Distro Ubuntu-22.04
```

如果需要先预览命令，不实际执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\ops\attendance-wsl-portproxy-refresh.ps1 -Distro Ubuntu-22.04 -WhatIfOnly
```

建议配置“开机自动刷新”计划任务（PowerShell 管理员）：

```powershell
cd C:\metasheet
powershell -ExecutionPolicy Bypass -File .\scripts\ops\attendance-wsl-portproxy-task.ps1 -Action Install -Distro Ubuntu-22.04
```

查看任务状态：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\ops\attendance-wsl-portproxy-task.ps1 -Action Status
```

手动触发一次：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\ops\attendance-wsl-portproxy-task.ps1 -Action RunNow
```

如需移除任务：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\ops\attendance-wsl-portproxy-task.ps1 -Action Uninstall
```

先获取 WSL IP（PowerShell）：

```powershell
$wslIp = (wsl -d Ubuntu-22.04 hostname -I).Trim().Split(' ')[0]
$wslIp
```

配置端口转发（PowerShell 管理员）：

```powershell
netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=80
netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=443
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=80 connectaddress=$wslIp connectport=80
netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=443 connectaddress=$wslIp connectport=443
```

放通防火墙（PowerShell 管理员）：

```powershell
netsh advfirewall firewall add rule name="MetaSheet HTTP 80" dir=in action=allow protocol=TCP localport=80
netsh advfirewall firewall add rule name="MetaSheet HTTPS 443" dir=in action=allow protocol=TCP localport=443
```

注意：WSL IP 变化后需要重新执行端口转发。

## 8) 验证（Windows + WSL）

WSL 内：

```bash
cd /opt/metasheet
SERVICE_MANAGER=auto CHECK_NGINX=1 scripts/ops/attendance-onprem-healthcheck.sh
```

Windows 内：

```powershell
Invoke-WebRequest http://127.0.0.1/attendance -UseBasicParsing
```

局域网客户端：

- `http://<windows-server-ip>/attendance`

## 9) 更新版本（WSL 内）

```bash
cd /opt/metasheet
ENV_FILE=/opt/metasheet/docker/app.env \
REQUIRE_ATTENDANCE_ONLY=1 \
scripts/ops/attendance-onprem-update.sh
```

更新后若 WSL IP 变化，重新执行第 7 步端口转发。

## 10) 配套文档

- [attendance-windows-onprem-easy-start-20260306.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/attendance-windows-onprem-easy-start-20260306.md)
- [attendance-onprem-postdeploy-30min-verification-20260306.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/attendance-onprem-postdeploy-30min-verification-20260306.md)
- [attendance-onprem-app-env-template-20260306.md](/Users/huazhou/Downloads/Github/metasheet2/docs/deployment/attendance-onprem-app-env-template-20260306.md)
