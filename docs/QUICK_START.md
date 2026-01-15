# MetaSheet V2 快速启动指南

**目标**: 30 分钟内完成开发环境搭建

---

## 前置要求

- Node.js >= 18
- pnpm >= 8
- Docker Desktop

## 一键启动

```bash
# 克隆仓库
git clone <repo-url> metasheet-v2
cd metasheet-v2

# 一键启动开发环境
./scripts/dev-bootstrap.sh
```

脚本会自动:
1. ✅ 检查依赖版本
2. ✅ 启动 Docker Desktop
3. ✅ 创建 PostgreSQL 容器 (端口 5433)
4. ✅ 生成 .env 配置
5. ✅ 安装 npm 依赖
6. ✅ 运行数据库迁移
7. ✅ 启动 core-backend 服务
8. ✅ 验证健康状态

## 服务地址

| 服务 | URL | 说明 |
|------|-----|------|
| Health | http://localhost:8900/health | 健康检查 |
| Metrics | http://localhost:8900/metrics/prom | Prometheus 指标 |
| Plugins | http://localhost:8900/api/plugins | 插件 API |
| Events | http://localhost:8900/api/events | 事件 API |
| Admin | http://localhost:8900/api/admin/* | 管理员 API (SafetyGuard 保护) |
| Safety Status | http://localhost:8900/api/admin/safety/status | 安全护栏状态 |

## 环境管理

```bash
# 停止服务 (保留数据)
./scripts/dev-cleanup.sh

# 完全清理 (删除数据卷)
./scripts/dev-cleanup.sh --full

# 重置环境 (删除 node_modules)
./scripts/dev-cleanup.sh --reset

# 重新启动
./scripts/dev-bootstrap.sh
```

## 常用命令

```bash
# 查看日志
tail -f logs/backend.log

# 重置数据库
pnpm --filter @metasheet/core-backend db:reset

# 运行测试
pnpm test

# 类型检查
pnpm typecheck

# 代码检查
pnpm lint
```

## 验证环境

```bash
# 健康检查
curl http://localhost:8900/health | jq

# 检查指标
curl http://localhost:8900/metrics/prom | head -20

# 检查插件列表
curl http://localhost:8900/api/plugins | jq
```

## PLM POC (Yuantus)

```bash
# 启动 core + Web，并填充默认 Yuantus PLM 环境变量
PLM_ENV=yuantus BACKEND_MODE=core bash scripts/start-univer-poc.sh

# 可选：显式指定 PLM 环境
PLM_BASE_URL=http://127.0.0.1:7910 \
PLM_URL=http://127.0.0.1:7910 \
PLM_TENANT_ID=tenant-1 \
PLM_ORG_ID=org-1 \
PLM_USERNAME=admin \
PLM_PASSWORD=admin \
RBAC_BYPASS=true \
BACKEND_MODE=core \
bash scripts/start-univer-poc.sh
```

浏览器访问：`http://localhost:8899/plm`

如需确保 Yuantus 身份库在 Postgres 且 admin 已创建，可运行：
```bash
bash scripts/start-yuantus-plm.sh
```

## 下一步

- 🔭 启动本地观测栈: `./scripts/observability-stack.sh up`
  - Prometheus: http://localhost:9090
  - Grafana: http://localhost:3000 (admin/admin)
- 📚 [新成员 Onboarding 指南](NEW_MEMBER_ONBOARDING.md) - 完整 5 天学习计划
- 🗺️ [功能代码映射](MAP_FEATURE_TO_CODE.md) - 功能到代码的快速索引
- 🔄 [闭环演练脚本](../scripts/rehearsal-snapshot.sh) - 验证设计到实现的完整路径
- 📋 [ROADMAP](../ROADMAP_V2.md) - 项目整体规划

## 故障排除

### Docker 未启动

```bash
open -a Docker  # macOS
# 等待 Docker Desktop 完全启动后重试
```

### 端口被占用

```bash
# 检查端口占用
lsof -i :8900
lsof -i :5433

# 停止占用进程
kill <PID>
```

### 数据库连接失败

```bash
# 检查容器状态
docker ps

# 重启数据库
docker restart metasheet-dev-postgres

# 查看数据库日志
docker logs metasheet-dev-postgres
```

### 迁移失败

```bash
# 重置数据库
pnpm --filter @metasheet/core-backend db:reset

# 查看迁移状态
pnpm --filter @metasheet/core-backend db:list
```

---

**🤖 Generated with [Claude Code](https://claude.com/claude-code)**
