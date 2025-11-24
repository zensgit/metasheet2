# MetaSheet V2 新成员 Onboarding 指南

**欢迎加入 MetaSheet V2 团队！**

本指南帮助你在 5 个工作日内快速上手项目。

---

## 🗓️ 第一周计划

| 天数 | 主题 | 目标 |
|------|------|------|
| Day 1 | 环境搭建 | 本地开发环境运行 |
| Day 2 | 代码导航 | 理解项目结构和代码映射 |
| Day 3 | 功能追踪 | 追踪 1-2 个已完成功能 |
| Day 4 | 设计文档 | 阅读核心设计文档 |
| Day 5 | 动手实践 | 修复一个小 bug 或优化 |

---

## Day 1: 环境搭建 (2-3 小时)

### 1.1 获取代码

```bash
# 克隆仓库
git clone <repo-url> metasheet-v2
cd metasheet-v2

# 检查分支
git branch -a
git checkout main
```

### 1.2 一键启动开发环境

```bash
# 运行启动脚本
./scripts/dev-bootstrap.sh
```

**预期结果**:
- PostgreSQL 容器运行
- 数据库迁移完成
- 测试数据 seeded
- 后端服务启动

**验证步骤**:
```bash
# 检查服务健康
curl http://localhost:4000/health
# 预期: {"ok": true, "status": "healthy"}

# 检查指标端点
curl http://localhost:4000/metrics | head -20
# 预期: Prometheus 格式指标
```

### 1.3 启动本地观测环境

```bash
# 启动 Prometheus + Grafana
cd docker/observability
docker-compose up -d

# 访问
# Prometheus: http://localhost:9090
# Grafana: http://localhost:3000 (admin/admin)
```

**检查点**:
- [ ] 服务运行在 localhost:4000
- [ ] 数据库可访问
- [ ] Grafana Dashboard 可见
- [ ] 遇到问题请查看 [FAQ](#常见问题)

---

## Day 2: 代码导航 (3-4 小时)

### 2.1 项目结构概览

```
metasheet-v2/
├── packages/
│   └── core-backend/        # 核心后端服务
│       ├── src/
│       │   ├── routes/      # API 路由
│       │   ├── services/    # 业务逻辑
│       │   ├── metrics/     # 可观测性
│       │   ├── rbac/        # 权限控制
│       │   └── plugin/      # 插件系统
│       ├── migrations/      # 数据库迁移
│       └── test/            # 测试文件
├── claudedocs/              # 设计文档
├── docs/                    # 用户文档
├── scripts/                 # 实用脚本
└── ROADMAP_V2.md           # 项目路线图
```

### 2.2 核心文档索引

**必读文档**:

1. **ROADMAP_V2.md** - 项目整体规划和进度
2. **docs/MAP_FEATURE_TO_CODE.md** - 功能到代码的映射
3. **claudedocs/PHASE10_11_DESIGN_NOTES.md** - 当前 Sprint 规划

**阅读顺序**:
1. ROADMAP_V2.md → 了解完成了什么、正在做什么
2. MAP_FEATURE_TO_CODE.md → 知道代码在哪里
3. 选择一个已完成的 Phase 深入

### 2.3 代码映射练习

**练习 1: 找到 Snapshot 功能实现**

1. 查看 MAP_FEATURE_TO_CODE.md 中 Snapshot 部分
2. 打开 `src/services/SnapshotService.ts`
3. 找到 `createSnapshot` 方法
4. 追踪到 `src/routes/snapshots.ts` 中的 API 端点
5. 找到对应的 Prometheus 指标

**练习 2: 找到权限检查实现**

1. 在 MAP_FEATURE_TO_CODE.md 中找 RBAC 部分
2. 打开 `src/rbac/rbac.ts`
3. 理解 `rbacGuard` 中间件如何工作

---

## Day 3: 功能追踪 (3-4 小时)

### 3.1 运行闭环演练脚本

```bash
# 运行 Snapshot 功能闭环演练
./scripts/rehearsal-snapshot.sh
```

这个脚本会带你走过:
- 设计文档 → 代码实现 → API 演示 → 指标观测

### 3.2 手动功能测试

**测试 Snapshot API**:

```bash
# 列出快照
curl http://localhost:4000/api/snapshots?view_id=test \
  -H "Authorization: Bearer test-token"

# 创建快照
curl -X POST http://localhost:4000/api/snapshots \
  -H "Authorization: Bearer test-token" \
  -H "Content-Type: application/json" \
  -d '{
    "view_id": "test-view",
    "name": "My First Snapshot",
    "description": "Testing"
  }'

# 查看统计
curl http://localhost:4000/api/snapshots/stats \
  -H "Authorization: Bearer test-token"
```

### 3.3 观察指标变化

在 Grafana 中查看:
- `metasheet_snapshot_create_total` 计数增加
- `metasheet_snapshot_operation_duration_seconds` 延迟分布

---

## Day 4: 设计文档深度阅读 (4-5 小时)

### 4.1 当前阶段重点文档

**优先阅读**:
1. `claudedocs/PHASE10_11_DESIGN_NOTES.md` - Sprint 规划
2. `claudedocs/CHANGE_MANAGEMENT_SNAPSHOT_DESIGN.md` - 变更管理设计

**阅读目标**:
- 理解为什么这样设计
- 找出你不理解的概念
- 思考可能的改进点

### 4.2 阅读反馈模板

阅读完成后，写一份简短反馈 (可选):

```markdown
# 设计文档阅读反馈

**文档**: [文档名]
**阅读日期**: YYYY-MM-DD

## 主要收获
- [理解到的关键概念]

## 疑问点
- [不理解的地方]

## 改进建议
- [觉得可以优化的地方]

## 感兴趣的部分
- [想深入了解的功能]
```

### 4.3 概念检查清单

确保你理解:
- [ ] Event Bus vs Message Bus 的区别
- [ ] Snapshot 和 Versioning 的用途
- [ ] RBAC 权限模型
- [ ] Plugin Sandbox 的安全机制
- [ ] Feature Flag 的作用
- [ ] SLO/Error Budget 概念

---

## Day 5: 动手实践 (全天)

### 5.1 找一个入门任务

**建议任务类型**:
- 修复一个简单的 TypeScript 类型错误
- 添加一个缺失的单元测试
- 完善一处文档
- 添加一个新的 Prometheus 指标

**查找任务**:
```bash
# 查找 TODO 注释
grep -r "TODO\|FIXME" src/ --include="*.ts"

# 查找缺失测试的文件
ls src/services/*.ts | while read f; do
  test_file="${f/src/test}"
  test_file="${test_file/.ts/.test.ts}"
  [ ! -f "$test_file" ] && echo "Missing test: $f"
done
```

### 5.2 开发流程

1. **创建分支**
   ```bash
   git checkout -b onboarding/your-name-task
   ```

2. **编写代码**
   - 遵循现有代码风格
   - 添加必要的测试
   - 更新相关文档

3. **运行测试**
   ```bash
   pnpm test
   pnpm lint
   pnpm typecheck
   ```

4. **提交代码**
   ```bash
   git add .
   git commit -m "feat: your descriptive message"
   ```

5. **创建 PR**
   - 描述你做了什么
   - 说明你学到了什么
   - 标记需要 review 的部分

### 5.3 代码风格指南

- TypeScript 严格模式
- ESLint + Prettier 格式化
- 函数式优先，避免类继承
- 显式类型注解 (避免 `any`)
- 有意义的变量和函数名

---

## 🆘 常见问题

### Q: dev-bootstrap 脚本失败

**可能原因**:
- Docker 未安装或未运行
- 端口被占用 (5432, 4000)
- Node.js 版本不兼容

**解决方案**:
```bash
# 检查 Docker
docker --version
docker ps

# 检查端口
lsof -i :5432
lsof -i :4000

# 手动启动
docker-compose -f docker/dev-postgres.yml up -d
pnpm install
pnpm --filter @metasheet/core-backend db:migrate
pnpm --filter @metasheet/core-backend dev
```

### Q: API 返回 401 Unauthorized

**原因**: 需要认证令牌

**解决方案**:
```bash
# 使用测试令牌
curl -H "Authorization: Bearer test-token" ...
```

### Q: 找不到某个功能的代码

**解决方案**:
1. 查看 `docs/MAP_FEATURE_TO_CODE.md`
2. 使用 grep 搜索关键字
3. 查看路由文件 `src/routes/*.ts`

### Q: 指标不显示

**可能原因**:
- Prometheus 未运行
- 目标配置错误
- 服务未暴露指标端点

**解决方案**:
```bash
# 直接检查指标端点
curl http://localhost:4000/metrics/prom | head -50

# 重启 Prometheus
cd docker/observability
docker-compose restart prometheus
```

---

## 📚 学习资源

### 内部资源
- ROADMAP_V2.md - 项目规划
- claudedocs/ - 所有设计文档
- docs/MAP_FEATURE_TO_CODE.md - 代码索引

### 外部资源
- [TypeScript 手册](https://www.typescriptlang.org/docs/)
- [Prometheus 文档](https://prometheus.io/docs/)
- [Express.js 指南](https://expressjs.com/guide/)
- [Kysely ORM](https://kysely.dev/)

---

## 🎯 第一周结束检查

完成以下检查清单:

- [ ] 本地开发环境正常运行
- [ ] 能够启动观测环境并查看指标
- [ ] 理解项目整体结构
- [ ] 能够追踪功能从设计到实现
- [ ] 阅读了至少 2 份设计文档
- [ ] 完成了一个小的代码贡献
- [ ] 知道遇到问题时向谁求助

**恭喜！你已经准备好参与开发了！**

---

## 📞 联系和支持

- **技术问题**: [联系人/频道]
- **代码 Review**: [联系人]
- **设计讨论**: [联系人]
- **紧急问题**: [联系方式]

---

## 🚀 下一步

完成 Onboarding 后，你可以:

1. 认领 Sprint 1/2 中的一个任务
2. 深入研究某个你感兴趣的模块
3. 参与设计文档的 review
4. 提出改进建议

**欢迎你的贡献！**

---

**🤖 Generated with [Claude Code](https://claude.com/claude-code)**
