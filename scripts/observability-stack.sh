#!/bin/bash
# MetaSheet V2 Observability Stack 管理
#
# 功能:
#   - 启动/停止 Prometheus + Grafana
#   - 检查服务健康状态
#   - 提供快速访问链接
#
# 使用:
#   ./scripts/observability-stack.sh up      # 启动观测栈
#   ./scripts/observability-stack.sh down    # 停止观测栈
#   ./scripts/observability-stack.sh status  # 检查状态
#   ./scripts/observability-stack.sh logs    # 查看日志

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$PROJECT_ROOT/docker/observability/docker-compose.yml"

# Check if Docker Compose V2 is available
check_docker_compose() {
    if ! command -v docker &> /dev/null; then
        echo -e "${RED}❌ Docker 未安装${NC}"
        exit 1
    fi

    # Try docker compose (V2) first
    if docker compose version &> /dev/null; then
        COMPOSE_CMD="docker compose"
    elif command -v docker-compose &> /dev/null; then
        echo -e "${YELLOW}⚠️  使用 docker-compose (V1)，建议升级到 docker compose (V2)${NC}"
        COMPOSE_CMD="docker-compose"
    else
        echo -e "${RED}❌ Docker Compose 未安装${NC}"
        exit 1
    fi
}

# Start the observability stack
start_stack() {
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}  🔭 启动 MetaSheet Observability Stack${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""

    check_docker_compose

    if ! docker ps &> /dev/null; then
        echo -e "${RED}❌ Docker 未运行，请先启动 Docker${NC}"
        exit 1
    fi

    echo "启动服务..."
    $COMPOSE_CMD -f "$COMPOSE_FILE" up -d

    # Wait for services to be healthy
    echo ""
    echo -n "等待 Prometheus 就绪"
    for i in {1..30}; do
        if curl -s http://localhost:9090/-/healthy &> /dev/null; then
            echo ""
            echo -e "  ${GREEN}✅ Prometheus 已就绪${NC}"
            break
        fi
        echo -n "."
        sleep 2
    done

    echo -n "等待 Grafana 就绪"
    for i in {1..30}; do
        if curl -s http://localhost:3000/api/health &> /dev/null; then
            echo ""
            echo -e "  ${GREEN}✅ Grafana 已就绪${NC}"
            break
        fi
        echo -n "."
        sleep 2
    done

    echo ""
    echo -e "${GREEN}🎉 Observability Stack 已启动!${NC}"
    echo ""
    echo "访问地址:"
    echo "  - Prometheus: http://localhost:9090"
    echo "  - Grafana:    http://localhost:3000 (admin/admin)"
    echo ""
    echo "前提条件:"
    echo "  - MetaSheet 后端需要运行在 localhost:8900"
    echo "  - 可使用 ./scripts/dev-bootstrap.sh 启动后端"
    echo ""
}

# Stop the observability stack
stop_stack() {
    echo -e "${BLUE}🛑 停止 Observability Stack...${NC}"
    check_docker_compose
    $COMPOSE_CMD -f "$COMPOSE_FILE" down
    echo -e "${GREEN}✅ 服务已停止${NC}"
}

# Check stack status
check_status() {
    echo -e "${BLUE}📊 Observability Stack 状态${NC}"
    echo ""

    check_docker_compose

    $COMPOSE_CMD -f "$COMPOSE_FILE" ps

    echo ""
    echo "服务健康检查:"

    # Check Prometheus
    if curl -s http://localhost:9090/-/healthy &> /dev/null; then
        echo -e "  Prometheus: ${GREEN}✅ 健康${NC}"
    else
        echo -e "  Prometheus: ${RED}❌ 不可用${NC}"
    fi

    # Check Grafana
    if curl -s http://localhost:3000/api/health &> /dev/null; then
        echo -e "  Grafana:    ${GREEN}✅ 健康${NC}"
    else
        echo -e "  Grafana:    ${RED}❌ 不可用${NC}"
    fi

    # Check MetaSheet backend
    if curl -s http://localhost:8900/metrics/prom &> /dev/null; then
        echo -e "  MetaSheet:  ${GREEN}✅ 指标端点可用${NC}"
    else
        echo -e "  MetaSheet:  ${YELLOW}⚠️  后端未运行${NC}"
    fi
    echo ""
}

# View logs
view_logs() {
    check_docker_compose
    $COMPOSE_CMD -f "$COMPOSE_FILE" logs -f
}

# Main
case "${1:-}" in
    up|start)
        start_stack
        ;;
    down|stop)
        stop_stack
        ;;
    status)
        check_status
        ;;
    logs)
        view_logs
        ;;
    restart)
        stop_stack
        start_stack
        ;;
    *)
        echo "使用方法: $0 {up|down|status|logs|restart}"
        echo ""
        echo "命令:"
        echo "  up      - 启动 Prometheus + Grafana"
        echo "  down    - 停止所有服务"
        echo "  status  - 检查服务状态"
        echo "  logs    - 查看服务日志"
        echo "  restart - 重启服务"
        exit 1
        ;;
esac
