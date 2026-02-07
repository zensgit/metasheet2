#!/bin/bash

set -euo pipefail

REPO_URL="https://github.com/zensgit/metasheet2.git"
APP_DIR="$HOME/metasheet2"
IMAGE_OWNER="zensgit"
IMAGE_TAG="latest"
WEB_PORT="8080"

echo "🚀 开始部署 metasheet2 (使用 gh CLI)..."

# 更新系统并安装必要软件
echo "📦 安装系统依赖..."
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin git curl openssl gh

# 启动 Docker 服务
echo "🐳 启动 Docker 服务..."
sudo systemctl enable --now docker
sudo usermod -aG docker $USER

# GitHub CLI 认证
echo "🔐 GitHub CLI 认证..."
if ! gh auth status >/dev/null 2>&1; then
    echo "请使用以下命令登录 GitHub:"
    echo "gh auth login --scopes 'read:packages'"
    echo "选择 GitHub.com -> HTTPS -> 使用 web browser 或 token"
    gh auth login --scopes 'read:packages'
else
    echo "✅ GitHub CLI 已认证"
fi

# 获取 GitHub token 并登录 GHCR
echo "🔑 登录 GitHub Container Registry..."
GH_TOKEN=$(gh auth token)
echo "$GH_TOKEN" | sudo docker login ghcr.io -u $(gh api user --jq '.login') --password-stdin

# 克隆或更新代码仓库
echo "📥 获取源代码..."
if [ ! -d "$APP_DIR/.git" ]; then
    git clone "$REPO_URL" "$APP_DIR"
else
    git -C "$APP_DIR" pull --ff-only
fi

cd "$APP_DIR"

# 生成环境配置文件
if [ ! -f docker/app.env ]; then
    echo "⚙️  生成环境配置..."
    DB_PASSWORD="$(openssl rand -hex 16)"
    JWT_SECRET="$(openssl rand -hex 32)"

    mkdir -p docker
    cat > docker/app.env <<EOF
NODE_ENV=production
HOST=0.0.0.0
PORT=8900
JWT_SECRET=${JWT_SECRET}
DATABASE_URL=postgres://metasheet:${DB_PASSWORD}@postgres:5432/metasheet
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=
POSTGRES_USER=metasheet
POSTGRES_PASSWORD=${DB_PASSWORD}
POSTGRES_DB=metasheet
EOF
    chmod 600 docker/app.env
    echo "✅ 生成了 docker/app.env (已包含 JWT_SECRET/POSTGRES_PASSWORD)"
else
    echo "✅ 使用现有的 docker/app.env"
fi

# 创建 docker-compose 覆盖配置
echo "🔧 配置 Docker Compose..."
cat > docker-compose.override.yml <<EOF
services:
  backend:
    ports:
      - "127.0.0.1:8900:8900"
  web:
    ports:
      - "${WEB_PORT}:80"
EOF

# 设置环境变量并部署
export IMAGE_OWNER IMAGE_TAG

echo "📦 拉取 Docker 镜像..."
sudo docker compose -f docker-compose.app.yml -f docker-compose.override.yml pull

echo "🚀 启动服务..."
sudo docker compose -f docker-compose.app.yml -f docker-compose.override.yml up -d

# 等待服务启动
echo "⏳ 等待服务启动..."
sleep 30

echo "🗃️  运行数据库迁移..."
sudo docker compose -f docker-compose.app.yml -f docker-compose.override.yml exec -T backend \
    node packages/core-backend/dist/src/db/migrate.js || echo "⚠️  数据库迁移可能需要手动执行"

# 获取服务器 IP
SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || curl -s ipinfo.io/ip 2>/dev/null || echo "YOUR_SERVER_IP")

echo ""
echo "🎉 部署完成！"
echo "🌐 Web 访问地址: http://${SERVER_IP}:${WEB_PORT}"
echo "📊 本地 API 地址: http://127.0.0.1:8900 (仅内网访问)"
echo ""
echo "💡 如果无法访问，请检查防火墙设置:"
echo "   sudo ufw allow ${WEB_PORT}/tcp"
echo ""
echo "📋 管理命令:"
echo "   查看状态: sudo docker compose -f docker-compose.app.yml -f docker-compose.override.yml ps"
echo "   查看日志: sudo docker compose -f docker-compose.app.yml -f docker-compose.override.yml logs"
echo "   停止服务: sudo docker compose -f docker-compose.app.yml -f docker-compose.override.yml down"
