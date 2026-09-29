#!/bin/bash
# MetaSheet V2 开发环境一键启动
#
# 功能:
#   - 检查依赖 (Node.js, pnpm, Docker)
#   - 自动启动 Docker Desktop
#   - 启动 PostgreSQL 容器
#   - 生成 .env 配置
#   - 安装依赖
#   - 运行数据库迁移
#   - 启动 core-backend 服务
#   - 验证健康状态和指标端点
#
# 使用:
#   ./scripts/dev-bootstrap.sh
#
# 目标:
#   新人 30 分钟内完成环境搭建

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
POSTGRES_PORT=5433
POSTGRES_USER=metasheet
POSTGRES_PASSWORD=metasheet
POSTGRES_DB=metasheet
BACKEND_PORT=8900
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  🚀 MetaSheet V2 开发环境一键启动${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

cd "$PROJECT_ROOT"

# Track timing
START_TIME=$(date +%s)

# ═══════════════════════════════════════════════════════════════════
# Step 1: 依赖检查
# ═══════════════════════════════════════════════════════════════════
echo -e "${YELLOW}📋 Step 1: 检查依赖${NC}"
echo ""

MISSING_DEPS=0

# Check Node.js
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VERSION" -ge 18 ]; then
        echo -e "  ${GREEN}✅ Node.js: $(node -v)${NC}"
    else
        echo -e "  ${RED}❌ Node.js: $(node -v) (需要 >= 18)${NC}"
        MISSING_DEPS=$((MISSING_DEPS+1))
    fi
else
    echo -e "  ${RED}❌ Node.js 未安装${NC}"
    MISSING_DEPS=$((MISSING_DEPS+1))
fi

# Check pnpm
if command -v pnpm &> /dev/null; then
    PNPM_VERSION=$(pnpm -v | cut -d. -f1)
    if [ "$PNPM_VERSION" -ge 8 ]; then
        echo -e "  ${GREEN}✅ pnpm: $(pnpm -v)${NC}"
    else
        echo -e "  ${RED}❌ pnpm: $(pnpm -v) (需要 >= 8)${NC}"
        MISSING_DEPS=$((MISSING_DEPS+1))
    fi
else
    echo -e "  ${RED}❌ pnpm 未安装${NC}"
    echo "  安装: npm install -g pnpm"
    MISSING_DEPS=$((MISSING_DEPS+1))
fi

# Check Docker
if command -v docker &> /dev/null; then
    echo -e "  ${GREEN}✅ Docker: $(docker -v | cut -d' ' -f3 | tr -d ',')${NC}"
else
    echo -e "  ${RED}❌ Docker 未安装${NC}"
    MISSING_DEPS=$((MISSING_DEPS+1))
fi

if [ $MISSING_DEPS -gt 0 ]; then
    echo ""
    echo -e "${RED}❌ 缺少 $MISSING_DEPS 个依赖，请先安装后重试${NC}"
    exit 1
fi

echo ""

# ═══════════════════════════════════════════════════════════════════
# Step 2: 启动 Docker Desktop
# ═══════════════════════════════════════════════════════════════════
echo -e "${YELLOW}🐳 Step 2: 启动 Docker Desktop${NC}"
echo ""

if ! docker ps &> /dev/null; then
    echo "启动 Docker..."

    # Detect platform and start Docker accordingly
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        open -a Docker 2>/dev/null || true
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        # Linux / WSL
        if grep -q microsoft /proc/version 2>/dev/null; then
            echo -e "  ${YELLOW}⚠️  WSL 检测到: 请确保 Docker Desktop for Windows 已启动并启用 WSL 集成${NC}"
        else
            # Native Linux - try systemctl
            sudo systemctl start docker 2>/dev/null || true
        fi
    fi

    # Wait for Docker to be ready
    echo -n "等待 Docker 就绪"
    for i in {1..30}; do
        if docker ps &> /dev/null; then
            echo ""
            echo -e "  ${GREEN}✅ Docker 已就绪${NC}"
            break
        fi
        echo -n "."
        sleep 2
    done

    if ! docker ps &> /dev/null; then
        echo ""
        echo -e "  ${RED}❌ Docker 启动超时${NC}"
        if [[ "$OSTYPE" == "linux-gnu"* ]]; then
            if grep -q microsoft /proc/version 2>/dev/null; then
                echo -e "  ${YELLOW}WSL 提示: 请在 Windows 中启动 Docker Desktop，并在设置中启用 WSL 集成${NC}"
            else
                echo -e "  ${YELLOW}Linux 提示: 尝试 'sudo systemctl start docker' 或检查 Docker 安装${NC}"
            fi
        else
            echo -e "  ${YELLOW}macOS 提示: 请手动启动 Docker Desktop${NC}"
        fi
        exit 1
    fi
else
    echo -e "  ${GREEN}✅ Docker 已运行${NC}"
fi

echo ""

# ═══════════════════════════════════════════════════════════════════
# Step 3: 启动 PostgreSQL
# ═══════════════════════════════════════════════════════════════════
echo -e "${YELLOW}🐘 Step 3: 启动 PostgreSQL${NC}"
echo ""

# Check if postgres container already exists
if docker ps -a --format '{{.Names}}' | grep -q "^metasheet-dev-postgres$"; then
    if docker ps --format '{{.Names}}' | grep -q "^metasheet-dev-postgres$"; then
        echo -e "  ${GREEN}✅ PostgreSQL 容器已运行${NC}"
    else
        echo "启动已存在的 PostgreSQL 容器..."
        docker start metasheet-dev-postgres
        echo -e "  ${GREEN}✅ PostgreSQL 容器已启动${NC}"
    fi
else
    echo "创建 PostgreSQL 容器..."
    if [ -f "docker/dev-postgres.yml" ]; then
        docker compose -f docker/dev-postgres.yml up -d
    else
        # Fallback to direct docker run
        docker run -d \
            --name metasheet-dev-postgres \
            -p ${POSTGRES_PORT}:5432 \
            -e POSTGRES_USER=${POSTGRES_USER} \
            -e POSTGRES_PASSWORD=${POSTGRES_PASSWORD} \
            -e POSTGRES_DB=${POSTGRES_DB} \
            -v metasheet-postgres-data:/var/lib/postgresql/data \
            --health-cmd="pg_isready -U ${POSTGRES_USER}" \
            --health-interval=10s \
            --health-timeout=5s \
            --health-retries=5 \
            postgres:15-alpine
    fi
    echo -e "  ${GREEN}✅ PostgreSQL 容器已创建${NC}"
fi

# Wait for PostgreSQL to be ready
echo -n "等待 PostgreSQL 就绪"
for i in {1..20}; do
    if docker exec metasheet-dev-postgres pg_isready -U ${POSTGRES_USER} &> /dev/null; then
        echo ""
        echo -e "  ${GREEN}✅ PostgreSQL 已就绪 (端口: ${POSTGRES_PORT})${NC}"
        break
    fi
    echo -n "."
    sleep 1
done

if ! docker exec metasheet-dev-postgres pg_isready -U ${POSTGRES_USER} &> /dev/null; then
    echo ""
    echo -e "  ${RED}❌ PostgreSQL 启动失败${NC}"
    exit 1
fi

echo ""

# ═══════════════════════════════════════════════════════════════════
# Step 4: 生成 .env 配置
# ═══════════════════════════════════════════════════════════════════
echo -e "${YELLOW}⚙️  Step 4: 生成 .env 配置${NC}"
echo ""

ENV_FILE="packages/core-backend/.env"
if [ ! -f "$ENV_FILE" ]; then
    cat > "$ENV_FILE" << EOF
# MetaSheet V2 Development Environment
# Generated by dev-bootstrap.sh on $(date)

# Database
DATABASE_URL=postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${POSTGRES_PORT}/${POSTGRES_DB}

# Server
PORT=${BACKEND_PORT}
NODE_ENV=development

# Security
JWT_SECRET=dev-jwt-secret-$(openssl rand -hex 16)
ADMIN_API_KEY=dev-admin-key-$(openssl rand -hex 16)

# Cache
CACHE_ENABLED=false

# Redis (optional)
REDIS_ENABLED=false
# REDIS_URL=redis://localhost:6379

# Observability
METRICS_ENABLED=true
LOG_LEVEL=info
EOF
    echo -e "  ${GREEN}✅ .env 文件已生成${NC}"
else
    echo -e "  ${YELLOW}⚠️  .env 文件已存在，跳过生成${NC}"
fi

echo ""

# ═══════════════════════════════════════════════════════════════════
# Step 5: 安装依赖
# ═══════════════════════════════════════════════════════════════════
echo -e "${YELLOW}📦 Step 5: 安装依赖${NC}"
echo ""

if [ ! -d "node_modules" ] || [ ! -f "pnpm-lock.yaml" ]; then
    echo "运行 pnpm install..."
    pnpm install 2>&1 | tail -20
    echo -e "  ${GREEN}✅ 依赖安装完成${NC}"
else
    echo -e "  ${GREEN}✅ 依赖已安装，跳过${NC}"
fi

echo ""

# ═══════════════════════════════════════════════════════════════════
# Step 6: 数据库迁移
# ═══════════════════════════════════════════════════════════════════
echo -e "${YELLOW}🔄 Step 6: 运行数据库迁移${NC}"
echo ""

cd packages/core-backend
echo "运行迁移..."
pnpm migrate 2>&1 | tail -30

if [ $? -eq 0 ]; then
    echo -e "  ${GREEN}✅ 数据库迁移完成${NC}"
else
    echo -e "  ${RED}❌ 数据库迁移失败${NC}"
    echo "  尝试重置: pnpm db:reset"
    echo "  (若本地库跑过 approval-template-groups backfill 真库用例, db:reset 可能撞上"
    echo "   ATG_BACKFILL_DOWN_BLOCKED —— 见该错误信息里的环境变量名)"
    exit 1
fi

cd "$PROJECT_ROOT"
echo ""

# ═══════════════════════════════════════════════════════════════════
# Step 7: 启动服务
# ═══════════════════════════════════════════════════════════════════
echo -e "${YELLOW}🚀 Step 7: 启动 core-backend 服务${NC}"
echo ""

# Check if service is already running
if curl -s "http://localhost:${BACKEND_PORT}/health" &> /dev/null; then
    echo -e "  ${GREEN}✅ 服务已在运行${NC}"
else
    echo "启动服务 (后台运行)..."
    cd packages/core-backend
    npx tsx src/index.ts > "$PROJECT_ROOT/logs/backend.log" 2>&1 &
    BACKEND_PID=$!
    echo $BACKEND_PID > "$PROJECT_ROOT/.backend.pid"
    cd "$PROJECT_ROOT"

    # Wait for service to be ready
    echo -n "等待服务启动"
    for i in {1..30}; do
        if curl -s "http://localhost:${BACKEND_PORT}/health" &> /dev/null; then
            echo ""
            echo -e "  ${GREEN}✅ 服务已启动 (PID: $BACKEND_PID)${NC}"
            break
        fi
        echo -n "."
        sleep 1
    done

    if ! curl -s "http://localhost:${BACKEND_PORT}/health" &> /dev/null; then
        echo ""
        echo -e "  ${RED}❌ 服务启动失败${NC}"
        echo "  查看日志: tail -f logs/backend.log"
        exit 1
    fi
fi

echo ""

# ═══════════════════════════════════════════════════════════════════
# Step 8: 验证环境
# ═══════════════════════════════════════════════════════════════════
echo -e "${YELLOW}✅ Step 8: 验证环境${NC}"
echo ""

# Health check
HEALTH=$(curl -s "http://localhost:${BACKEND_PORT}/health")
echo "Health Check:"
echo "$HEALTH" | jq '.' 2>/dev/null || echo "$HEALTH"
echo ""

# Metrics check
METRICS_COUNT=$(curl -s "http://localhost:${BACKEND_PORT}/metrics/prom" | grep -c "^metasheet_" || echo "0")
echo "指标端点: http://localhost:${BACKEND_PORT}/metrics/prom"
echo "MetaSheet 自定义指标数量: $METRICS_COUNT"
echo ""

# Calculate elapsed time
END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))
MINUTES=$((ELAPSED / 60))
SECONDS=$((ELAPSED % 60))

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}🎉 环境启动完成! (耗时: ${MINUTES}分${SECONDS}秒)${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

echo "服务地址:"
echo "  - Health:  http://localhost:${BACKEND_PORT}/health"
echo "  - Metrics: http://localhost:${BACKEND_PORT}/metrics/prom"
echo "  - Plugins: http://localhost:${BACKEND_PORT}/api/plugins"
echo "  - Events:  http://localhost:${BACKEND_PORT}/api/events"
echo ""

echo "日志文件:"
echo "  - Backend: logs/backend.log"
echo ""

echo "常用命令:"
echo "  - 停止服务: ./scripts/dev-cleanup.sh"
echo "  - 查看日志: tail -f logs/backend.log"
echo "  - 重置数据库: pnpm --filter @metasheet/core-backend db:reset"
echo "    (若本地库跑过 approval-template-groups backfill 真库用例, db:reset 可能撞上"
echo "     ATG_BACKFILL_DOWN_BLOCKED —— 见该错误信息里的环境变量名)"
echo ""

echo "下一步:"
echo "  1. 查看 Onboarding 指南: docs/NEW_MEMBER_ONBOARDING.md"
echo "  2. 运行闭环演练: ./scripts/rehearsal-snapshot.sh"
echo "  3. 查看项目结构: docs/MAP_FEATURE_TO_CODE.md"
echo ""
