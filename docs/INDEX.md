# 📚 MetaSheet2 PLM/Athena 集成文档索引

**快速导航** | **一站式文档中心**

---

## 🚀 快速开始

| 文档 | 时间 | 说明 |
|------|------|------|
| **[QUICKSTART.md](../QUICKSTART.md)** | 3-30分钟 | ⭐ 从这里开始 |
| [CURRENT_STATUS.md](./CURRENT_STATUS.md) | 2分钟 | 当前状态总览 |
| [SESSION_SUMMARY.md](./SESSION_SUMMARY.md) | 5分钟 | 本次会话工作总结 |

---

## 📊 指标监控系统

| 文档 | 用途 | 受众 |
|------|------|------|
| **[METRICS_README.md](./METRICS_README.md)** | 功能参考 | 所有用户 |
| [metrics-integration-complete.md](./metrics-integration-complete.md) | 技术文档 | 开发者 |
| [adapter-metrics-guide.md](./adapter-metrics-guide.md) | 使用指南 | 运维人员 |

**相关脚本**:
- `scripts/metrics-cli.sh` - CLI 管理工具
- `scripts/test-metrics-integration.sh` - 集成测试

---

## 🔧 适配器开发

| 文档 | 说明 |
|------|------|
| [DATA_SOURCE_ADAPTERS.md](./DATA_SOURCE_ADAPTERS.md) | 适配器架构 |
| [plm-integration-design.md](./plm-integration-design.md) | PLM 集成设计 |
| [plm-bom-compare-field-mapping.md](./plm-bom-compare-field-mapping.md) | BOM Compare 字段对照 |

---

## 🧪 测试和验证

| 文档 | 用途 |
|------|------|
| [verification-test-report.md](./verification-test-report.md) | 测试报告 |
| [verification-index.md](./verification-index.md) | 验证索引（常用命令/产物） |
| [preprod-validation-report-template.md](./preprod-validation-report-template.md) | 预发验证报告模板 |
| [preprod-validation-report-20260122.md](./preprod-validation-report-20260122.md) | 预发验证报告 (2026-01-22) |
| [verification-attendance-dev-20260119.md](./verification-attendance-dev-20260119.md) | 考勤模块开发环境验证 |
| [attendance-plugin-verification-report-20260120.md](./attendance-plugin-verification-report-20260120.md) | 考勤插件验证报告 (2026-01-20) |
| **[attendance-production-delivery-20260207.md](./attendance-production-delivery-20260207.md)** | 考勤插件生产交付包定义 (2026-02-07) |
| **[attendance-production-acceptance-20260207.md](./attendance-production-acceptance-20260207.md)** | 考勤插件生产验收 Gate 口径 (2026-02-07) |
| [attendance-production-ready-verification-20260207.md](./attendance-production-ready-verification-20260207.md) | 考勤插件生产就绪验证记录 (2026-02-07) |
| [attendance-production-polish-verification-20260208.md](./attendance-production-polish-verification-20260208.md) | 考勤插件生产打磨验证记录 (2026-02-08) |
| [VERIFICATION_RELEASE_SUMMARY.md](./VERIFICATION_RELEASE_SUMMARY.md) | 最新全量验证汇总 (2025-12-22) |
| [univer-full-verification-summary-2025-12-20-run4.md](./univer-full-verification-summary-2025-12-20-run4.md) | Univer 全量验证报告 |
| [verification-phase1-final-2025-12-22.md](./verification-phase1-final-2025-12-22.md) | Phase 1 全量回归报告 |
| [verification-rerun-2025-12-22.md](./verification-rerun-2025-12-22.md) | Phase 1 复测记录 |
| [verification-comments-api-2025-12-22.md](./verification-comments-api-2025-12-22.md) | Comments API 验证 |
| [smoke-verify-run-2025-12-23.md](./smoke-verify-run-2025-12-23.md) | Smoke 验证（本地+CI） |
| [next-week-execution-checklist-2025-12-20.md](./next-week-execution-checklist-2025-12-20.md) | 下周执行清单 |
| [real-system-validation-checklist.md](./real-system-validation-checklist.md) | 真实系统验证 |

---

## 🧩 插件与模块

| 文档 | 说明 |
|------|------|
| [attendance-plugin-design-20260119.md](./attendance-plugin-design-20260119.md) | 考勤插件设计说明 |
| [attendance-plugin-development-report-20260120.md](./attendance-plugin-development-report-20260120.md) | 考勤插件开发报告 (2026-01-20) |
| [dingtalk-admin-operations-guide-20260420.md](./dingtalk-admin-operations-guide-20260420.md) | 钉钉群/个人通知、公开表单访问模式、指定本地用户或成员组填写 |

**Phase 1 验证明细（2025-12-21/22）**:
- `docs/phase1-stabilization-summary-2025-12-21.md`
- `docs/verification-view-warnings-2025-12-21.md`
- `docs/verification-related-records-2025-12-21.md`
- `docs/verification-readonly-conflict-2025-12-21.md`
- `docs/verification-performance-2025-12-21.md`
- `docs/verification-view-config-import-export-2025-12-21.md`
- `docs/verification-view-config-ui-2025-12-22.md`
- `docs/verification-rerun-2025-12-22.md`

**相关脚本**:
- `scripts/test-plm-complete.sh` - PLM API 验证
- `scripts/test-athena-complete.sh` - Athena API 验证
- `scripts/test-formdata-upload.sh` - FormData 上传测试
- `scripts/verify-adapter-mapping.cjs` - 映射验证
- `scripts/mock-api-server.cjs` - Mock 服务器

---

## 🔒 安全和部署

| 文档 | 用途 |
|------|------|
| **[DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md)** | 完整部署指南 ⭐ 生产部署必读 |
| **[admin-api-security.md](./admin-api-security.md)** | 安全实施 ⚠️ 生产必读 |
| [production-readiness-checklist.md](./production-readiness-checklist.md) | 上线清单 |
| [next-steps-guide.md](./next-steps-guide.md) | 后续步骤 |
| [operations/deploy-ghcr.md](./operations/deploy-ghcr.md) | GHCR 部署脚本说明 |

**相关脚本**:
- `scripts/setup-monitoring.sh` - 一键监控栈部署

---

## 📊 监控和可观测性

| 文档 | 用途 | 受众 |
|------|------|------|
| **[monitoring/README.md](../monitoring/README.md)** | 监控栈文档 | 运维人员 |
| **[examples/README.md](../examples/README.md)** | 示例和配置 | 所有用户 |

**配置文件**:
- `docker-compose.monitoring.yml` - 监控栈 Docker Compose
- `monitoring/prometheus.yml` - Prometheus 配置
- `monitoring/alertmanager.yml` - Alertmanager 配置
- `monitoring/grafana-*.yml` - Grafana 配置
- `examples/prometheus-alerts.yml` - 告警规则
- `examples/grafana-dashboard.json` - Grafana 仪表板
- `examples/metrics-alerting.js` - Node.js 告警脚本

**相关脚本**:
- `scripts/generate-metrics-report.sh` - 性能报告生成

---

## 📖 按角色导航

### 👨‍💻 开发者

**必读**:
1. [QUICKSTART.md](../QUICKSTART.md) - 快速上手
2. [metrics-integration-complete.md](./metrics-integration-complete.md) - 技术实现
3. [DATA_SOURCE_ADAPTERS.md](./DATA_SOURCE_ADAPTERS.md) - 适配器架构

**工具**:
- `scripts/metrics-cli.sh` - 开发调试
- `scripts/test-metrics-integration.sh` - 集成测试

### 🔧 运维人员

**必读**:
1. [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) - 部署指南
2. [monitoring/README.md](../monitoring/README.md) - 监控栈文档
3. [METRICS_README.md](./METRICS_README.md) - 功能参考
4. [admin-api-security.md](./admin-api-security.md) - 安全配置

**工具**:
- `scripts/setup-monitoring.sh` - 一键部署监控栈
- `scripts/metrics-cli.sh dashboard` - 监控仪表板
- `scripts/metrics-cli.sh watch` - 实时监控
- `scripts/generate-metrics-report.sh` - 生成性能报告

**VS Code 集成**:
- `.vscode/tasks.json` - 已配置 16+ 个任务快捷方式

### 📊 测试人员

**必读**:
1. [real-system-validation-checklist.md](./real-system-validation-checklist.md) - 验证清单
2. [verification-test-report.md](./verification-test-report.md) - 测试报告
3. [VERIFICATION_RELEASE_SUMMARY.md](./VERIFICATION_RELEASE_SUMMARY.md) - 最新全量验证汇总 (2025-12-22)

**工具**:
- `scripts/test-plm-complete.sh` - PLM 测试
- `scripts/test-athena-complete.sh` - Athena 测试
- `scripts/test-formdata-upload.sh` - 上传测试

### 👔 管理者

**必读**:
1. [CURRENT_STATUS.md](./CURRENT_STATUS.md) - 项目状态
2. [SESSION_SUMMARY.md](./SESSION_SUMMARY.md) - 完成工作
3. [next-steps-guide.md](./next-steps-guide.md) - 后续规划
4. [VERIFICATION_RELEASE_SUMMARY.md](./VERIFICATION_RELEASE_SUMMARY.md) - 最新全量验证汇总 (2025-12-22)

---

## 📑 按主题导航

### 指标监控

```
METRICS_README.md               (入口)
  ├── metrics-integration-complete.md  (技术细节)
  ├── adapter-metrics-guide.md         (使用指南)
  └── scripts/metrics-cli.sh           (CLI 工具)
```

### 真实系统对接

```
next-steps-guide.md             (路线图)
  ├── test-plm-complete.sh            (PLM 验证)
  ├── test-athena-complete.sh         (Athena 验证)
  ├── test-formdata-upload.sh         (上传测试)
  └── real-system-validation-checklist.md
```

### 生产部署

```
production-readiness-checklist.md   (清单)
  ├── admin-api-security.md          (安全)
  └── next-steps-guide.md            (步骤)
```

---

## 🔍 快速查找

### 我想...

| 需求 | 文档 |
|------|------|
| **快速上手** | [QUICKSTART.md](../QUICKSTART.md) |
| **了解当前状态** | [CURRENT_STATUS.md](./CURRENT_STATUS.md) |
| **查看指标** | `./scripts/metrics-cli.sh list` |
| **实时监控** | `./scripts/metrics-cli.sh watch` |
| **导出数据** | `./scripts/metrics-cli.sh export <adapter>` |
| **运行测试** | `./scripts/test-metrics-integration.sh` |
| **验证真实系统** | [real-system-validation-checklist.md](./real-system-validation-checklist.md) |
| **查看最新全量验证** | [VERIFICATION_RELEASE_SUMMARY.md](./VERIFICATION_RELEASE_SUMMARY.md) |
| **实施安全** | [admin-api-security.md](./admin-api-security.md) |
| **故障排查** | [metrics-integration-complete.md](./metrics-integration-complete.md) (故障排查章节) |
| **了解 API** | [METRICS_README.md](./METRICS_README.md) (Admin API 章节) |

---

## 📈 学习路径

### 初学者 (30 分钟)

```
1. QUICKSTART.md (3 分钟快速验证)
   ↓
2. ./scripts/metrics-cli.sh --help (了解 CLI)
   ↓
3. METRICS_README.md (功能概览)
   ↓
4. ./scripts/metrics-cli.sh dashboard (查看仪表板)
```

### 进阶用户 (2 小时)

```
1. QUICKSTART.md (30 分钟完整测试)
   ↓
2. metrics-integration-complete.md (技术细节)
   ↓
3. adapter-metrics-guide.md (深入使用)
   ↓
4. 实践：导出数据、分析性能、设置告警
```

### 生产部署 (1 周)

```
第 1 天:
  - CURRENT_STATUS.md
  - production-readiness-checklist.md

第 2-3 天:
  - real-system-validation-checklist.md
  - 运行所有验证脚本
  - 调整适配器

第 4-5 天:
  - admin-api-security.md
  - 实施安全措施
  - 设置监控告警

第 6-7 天:
  - 压力测试
  - 性能优化
  - 准备上线
```

---

## 📝 文档元信息

| 文档 | 行数 | 创建时间 | 状态 |
|------|------|----------|------|
| QUICKSTART.md | 450+ | 2025-12-08 | ✅ 完成 |
| CURRENT_STATUS.md | 350+ | 2025-12-08 | ✅ 完成 |
| SESSION_SUMMARY.md | 500+ | 2025-12-08 | ✅ 完成 |
| METRICS_README.md | 600+ | 2025-12-08 | ✅ 完成 |
| metrics-integration-complete.md | 445+ | 2025-12-08 | ✅ 完成 |
| adapter-metrics-guide.md | 400+ | 之前 | ✅ 完成 |
| admin-api-security.md | 300+ | 之前 | ✅ 完成 |
| next-steps-guide.md | 445+ | 之前 | ✅ 更新 |
| real-system-validation-checklist.md | 250+ | 之前 | ✅ 完成 |
| production-readiness-checklist.md | 200+ | 之前 | ✅ 完成 |

**总计**: 10 个主要文档，约 4000+ 行

---

## 🛠️ 脚本索引

### 监控和部署
| 脚本 | 行数 | 功能 |
|------|------|------|
| `setup-monitoring.sh` | 300+ | 一键部署监控栈 |
| `generate-metrics-report.sh` | 360+ | 生成性能报告 |
| `metrics-cli.sh` | 600+ | CLI 管理工具 |

### 测试和验证
| 脚本 | 行数 | 功能 |
|------|------|------|
| `test-metrics-integration.sh` | 160+ | 集成测试 |
| `test-plm-complete.sh` | 200+ | PLM 验证 |
| `test-athena-complete.sh` | 200+ | Athena 验证 |
| `test-formdata-upload.sh` | 150+ | 上传测试 |
| `verify-adapter-mapping.cjs` | 85+ | 映射验证 |
| `mock-api-server.cjs` | 300+ | Mock 服务 |

**总计**: 10 个脚本，约 2355+ 行

---

## 🔗 外部链接

- **GitHub**: (项目仓库)
- **Jira**: (项目任务)
- **Confluence**: (团队文档)

---

## 📞 支持

### 遇到问题？

1. **查找文档**
   - 使用本索引快速定位
   - 参考故障排查章节

2. **运行诊断**
   ```bash
   ./scripts/metrics-cli.sh health
   ```

3. **查看日志**
   - 服务器日志
   - Admin API 响应

4. **社区支持**
   - 项目 Issues
   - 内部论坛

---

## 🎯 推荐阅读顺序

### 第一次阅读

1. **[QUICKSTART.md](../QUICKSTART.md)** ⭐ 从这里开始
2. [CURRENT_STATUS.md](./CURRENT_STATUS.md)
3. [METRICS_README.md](./METRICS_README.md)

### 深入学习

4. [metrics-integration-complete.md](./metrics-integration-complete.md)
5. [adapter-metrics-guide.md](./adapter-metrics-guide.md)
6. [admin-api-security.md](./admin-api-security.md)

### 准备部署

7. [real-system-validation-checklist.md](./real-system-validation-checklist.md)
8. [production-readiness-checklist.md](./production-readiness-checklist.md)
9. [next-steps-guide.md](./next-steps-guide.md)

---

## 📅 最后更新

- **日期**: 2025-12-08
- **版本**: 1.0
- **状态**: ✅ 完成

---

**准备开始？** 访问 **[QUICKSTART.md](../QUICKSTART.md)** 开始你的旅程！ 🚀
