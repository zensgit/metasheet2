#!/bin/bash
# 优化的开发环境启动脚本
# 针对开发环境优化，减少依赖失败的影响

set -e

echo "[DevOptimized] Starting @metasheet/core-backend in optimized dev mode..."
echo "  - Graceful database failure handling"
echo "  - Plugin error tolerance"
echo "  - Fast startup optimization"

# 导航到backend目录
cd "$(dirname "$0")/../packages/core-backend"

# 优化的环境变量设置
export NODE_ENV=development
export DISABLE_EVENT_BUS=false  # 允许EventBus，但容错
export SKIP_PLUGINS=false       # 允许plugins，但容错
export FEATURE_CACHE=false      # 简化缓存，减少依赖
export LOG_LEVEL=warn           # 减少日志噪声
export STARTUP_TIMEOUT=30       # 30秒启动超时
export DATABASE_URL="${DATABASE_URL:-postgresql://metasheet:metasheet123@localhost:5432/metasheet_v2}"

# 启动优化的后端
echo "[DevOptimized] Starting with optimized settings..."
npm run dev
