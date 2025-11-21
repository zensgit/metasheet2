#!/bin/bash
# MetaSheet V2 开发环境清理
#
# 功能:
#   - 停止 core-backend 服务
#   - 停止/删除 PostgreSQL 容器
#   - 清理 Docker 卷 (可选)
#   - 清理 node_modules (可选)
#   - 恢复环境到初始状态
#
# 使用:
#   ./scripts/dev-cleanup.sh              # 基本清理 (停止服务)
#   ./scripts/dev-cleanup.sh --full       # 完全清理 (包括数据卷)
#   ./scripts/dev-cleanup.sh --reset      # 重置环境 (删除 node_modules)

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FULL_CLEANUP=false
RESET_ENV=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --full)
            FULL_CLEANUP=true
            shift
            ;;
        --reset)
            RESET_ENV=true
            FULL_CLEANUP=true
            shift
            ;;
        *)
            echo "未知参数: $1"
            echo "使用: $0 [--full] [--reset]"
            exit 1
            ;;
    esac
done

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}  🧹 MetaSheet V2 开发环境清理${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if [ "$FULL_CLEANUP" = true ]; then
    echo -e "${YELLOW}模式: 完全清理 (包括数据卷)${NC}"
elif [ "$RESET_ENV" = true ]; then
    echo -e "${YELLOW}模式: 重置环境 (包括 node_modules)${NC}"
else
    echo -e "${YELLOW}模式: 基本清理 (保留数据)${NC}"
fi
echo ""

cd "$PROJECT_ROOT"

# ═══════════════════════════════════════════════════════════════════
# Step 1: 停止 core-backend 服务
# ═══════════════════════════════════════════════════════════════════
echo -e "${YELLOW}🛑 Step 1: 停止 core-backend 服务${NC}"
echo ""

# Check for PID file
if [ -f ".backend.pid" ]; then
    PID=$(cat .backend.pid)
    if ps -p $PID > /dev/null 2>&1; then
        echo "停止服务 (PID: $PID)..."
        kill $PID 2>/dev/null || true
        sleep 2
        # Force kill if still running
        if ps -p $PID > /dev/null 2>&1; then
            kill -9 $PID 2>/dev/null || true
        fi
        echo -e "  ${GREEN}✅ 服务已停止${NC}"
    else
        echo -e "  ${YELLOW}⚠️  服务未在运行 (PID: $PID)${NC}"
    fi
    rm -f .backend.pid
else
    # Try to find by port
    BACKEND_PID=$(lsof -ti :8900 2>/dev/null || true)
    if [ -n "$BACKEND_PID" ]; then
        echo "停止服务 (端口 8900, PID: $BACKEND_PID)..."
        kill $BACKEND_PID 2>/dev/null || true
        sleep 2
        echo -e "  ${GREEN}✅ 服务已停止${NC}"
    else
        echo -e "  ${GREEN}✅ 服务未运行${NC}"
    fi
fi

# Clean up log files
if [ -f "logs/backend.log" ]; then
    echo "清理日志文件..."
    rm -f logs/backend.log
    echo -e "  ${GREEN}✅ 日志已清理${NC}"
fi

echo ""

# ═══════════════════════════════════════════════════════════════════
# Step 2: 停止 PostgreSQL 容器
# ═══════════════════════════════════════════════════════════════════
echo -e "${YELLOW}🐘 Step 2: 停止 PostgreSQL 容器${NC}"
echo ""

if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^metasheet-dev-postgres$"; then
    echo "停止 PostgreSQL 容器..."
    docker stop metasheet-dev-postgres
    echo -e "  ${GREEN}✅ PostgreSQL 容器已停止${NC}"
else
    echo -e "  ${GREEN}✅ PostgreSQL 容器未运行${NC}"
fi

if [ "$FULL_CLEANUP" = true ]; then
    # Remove container
    if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^metasheet-dev-postgres$"; then
        echo "删除 PostgreSQL 容器..."
        docker rm metasheet-dev-postgres
        echo -e "  ${GREEN}✅ PostgreSQL 容器已删除${NC}"
    fi

    # Remove volume
    if docker volume ls --format '{{.Name}}' 2>/dev/null | grep -q "metasheet-postgres-data"; then
        echo "删除 PostgreSQL 数据卷..."
        docker volume rm metasheet-postgres-data
        echo -e "  ${GREEN}✅ PostgreSQL 数据卷已删除${NC}"
    fi
fi

echo ""

# ═══════════════════════════════════════════════════════════════════
# Step 3: 清理 .env 文件 (可选)
# ═══════════════════════════════════════════════════════════════════
if [ "$RESET_ENV" = true ]; then
    echo -e "${YELLOW}⚙️  Step 3: 清理 .env 文件${NC}"
    echo ""

    if [ -f "packages/core-backend/.env" ]; then
        echo "删除 .env 文件..."
        rm -f packages/core-backend/.env
        echo -e "  ${GREEN}✅ .env 文件已删除${NC}"
    else
        echo -e "  ${GREEN}✅ .env 文件不存在${NC}"
    fi

    echo ""
fi

# ═══════════════════════════════════════════════════════════════════
# Step 4: 清理 node_modules (可选)
# ═══════════════════════════════════════════════════════════════════
if [ "$RESET_ENV" = true ]; then
    echo -e "${YELLOW}📦 Step 4: 清理 node_modules${NC}"
    echo ""

    echo "删除 node_modules..."
    rm -rf node_modules
    rm -rf packages/*/node_modules
    rm -rf plugins/*/node_modules
    echo -e "  ${GREEN}✅ node_modules 已删除${NC}"

    echo "删除 pnpm-lock.yaml..."
    rm -f pnpm-lock.yaml
    echo -e "  ${GREEN}✅ pnpm-lock.yaml 已删除${NC}"

    echo ""
fi

# ═══════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}🎉 清理完成!${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

echo "已清理:"
echo "  - ✅ core-backend 服务"
echo "  - ✅ 后端日志"
if [ "$FULL_CLEANUP" = true ]; then
    echo "  - ✅ PostgreSQL 容器"
    echo "  - ✅ PostgreSQL 数据卷"
fi
if [ "$RESET_ENV" = true ]; then
    echo "  - ✅ .env 配置文件"
    echo "  - ✅ node_modules 依赖"
    echo "  - ✅ pnpm-lock.yaml"
fi
echo ""

echo "重新启动环境:"
echo "  ./scripts/dev-bootstrap.sh"
echo ""

if [ "$RESET_ENV" = true ]; then
    echo -e "${YELLOW}注意: 环境已完全重置，下次启动需要重新安装依赖和迁移数据库${NC}"
fi
