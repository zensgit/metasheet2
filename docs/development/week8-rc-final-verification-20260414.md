# MetaSheet 8 周路线图 — 最终交付验证文档

Date: 2026-04-14

## 1. 路线图全部完成

| 周次 | 主题 | 后端 | 前端 | 测试 | PR |
|---|---|---|---|---|---|
| Week 0 | 路线图落库 | ✅ | — | — | — |
| Week 1 | 协作语义统一 | ✅ | ✅ | ✅ | #856 #857 #858 #859 |
| Week 2 | 协作体验补完 | ✅ | ✅ | ✅ | #860 #861 |
| Week 3 | 公开表单分享 | ✅ | ✅ | ✅ | baseline + #862 #867 |
| Week 4 | 字段验证规则 | ✅ | ✅ | ✅ | #864 #867 |
| Week 5 | API Token + Webhook | ✅ | ✅ | ✅ | #863 #867 |
| Week 6 | 高级自动化 V1 | ✅ | ✅ | ✅ | #866 #868 |
| Week 7 | 图表 / Dashboard V1 | ✅ | ✅ | ✅ | #865 #868 |
| Week 8 | RC 收口 | ✅ | — | ✅ | #869 |

**全部 14 个 PR 已合并到 main。**

---

## 2. Week 8 RC 交付内容 (PR #868 + #869)

### 2.1 Week 6/7 前端 (PR #868, 22 测试)

| 组件 | 说明 |
|---|---|
| `MetaAutomationRuleEditor.vue` | 自动化规则编辑器 — 7 种触发器、10 种条件、5 种动作、最多 3 步链 |
| `MetaAutomationLogViewer.vue` | 执行日志查看器 — 统计栏、可过滤日志列表、步骤级展开详情 |
| `MetaChartRenderer.vue` | 纯 SVG/HTML 图表渲染 — bar/line/pie/number/table |
| `MetaDashboardView.vue` | Dashboard 面板 — CSS Grid 布局、创建/重命名、添加/移除/调整面板 |

API Client 扩展 14 个方法（automation 3 + charts 5 + dashboards 4 + misc 2）

### 2.2 RC 回归测试 (PR #869, 53 测试)

| Section | 测试数 | 覆盖 |
|---|---|---|
| Comment System | 10 | mention 解析、未读拆分、作者自动已读、批量已读、候选搜索、presence |
| Public Form | 8 | token 校验、过期、限流 429、认证不限流、提交创建、recordId 拒绝、必填 422 |
| Field Validation | 6 | required、min/max、pattern、enum、多错误、自定义消息 |
| API Token & Webhook | 8 | 创建明文、hash 验证、撤销/过期 401、轮换、HMAC、自动禁用、事件桥接 |
| Automation | 8 | 条件评估、触发匹配、动作执行、多步链、失败停止、调度器、日志、统计 |
| Charts & Dashboard | 8 | count/sum/avg、日期分组、过滤、CRUD、面板、数据管线、数字卡片 |
| Cross-feature | 5 | 公开表单→自动化、评论→webhook、token 认证→图表、表单验证、自动化→presence |

### 2.3 辅助交付物

| 文件 | 说明 |
|---|---|
| `scripts/rc-smoke.sh` | HTTP smoke 测试脚本（可对接运行中的服务器） |
| `scripts/seed-demo-data.ts` | 演示数据播种器（Project Tracker 全功能环境） |
| `docs/release/feishu-gap-rc-release-notes-202605.md` | 发布说明 |
| `docs/development/next-phase-backlog-202605.md` | 下阶段 backlog（10 项，P0-P3） |

---

## 3. 全量测试统计

| 模块 | 测试数 | 来源 |
|---|---|---|
| Comment contracts | ~216 行 | #856 |
| Comment service | 34 | #857 |
| Comment integration | 45 | #858 |
| Collab UX integration | 35 | #861 |
| Rate limiter | 17 | #862 |
| API Token + Webhook | 41 | #863 |
| Field validation | 81 | #864 |
| Chart / Dashboard | 50 | #865 |
| Automation V1 | 80 | #866 |
| Frontend (W3-5) | 29 | #867 |
| Frontend (W6-7) | 22 | #868 |
| RC regression | 53 | #869 |
| **合计** | **~503+** | |

---

## 4. 全量验收命令

```bash
# 后端全量测试
cd packages/core-backend
npx vitest run --watch=false

# RC 回归
npx vitest run tests/integration/rc-regression.test.ts --watch=false

# 前端测试
cd apps/web
npx vitest run --watch=false

# Smoke（需运行中服务器）
./scripts/rc-smoke.sh http://localhost:3000

# 演示数据
npx tsx scripts/seed-demo-data.ts http://localhost:3000
```

---

## 5. 新增能力一览

### 协作系统
- 评论 CRUD + 线程 + 解决
- @mention 自动解析 + 候选搜索 + 键盘导航
- 未读/mention 拆分计数 (`getUnreadSummary`)
- 作者自动已读
- 批量标记已读 (`markAllCommentsRead`)
- 收件箱 + attention badge + 深链到记录
- Presence 实时查看者身份 (`getRoomMembers`)
- WebSocket 实时同步（创建/更新/删除/解决广播）

### 公开表单
- Token 校验 + 过期策略
- 匿名访问 + 最小权限（仅 create）
- Rate limiter（10/15min 提交，60/15min 上下文）
- 提交审计日志
- 管理 UI（启用/复制链接/重生成/过期设置）

### 字段验证
- 7 种规则：required / min / max / minLength / maxLength / pattern / enum
- 后端权威源，前端复用
- 非 fail-fast（返回全部错误）
- 自定义错误消息
- 接入表单提交 + 记录创建
- 配置 UI（预设模式：email/URL/phone）

### API Token + Webhook
- `mst_` 前缀 token，SHA-256 hash，scope 授权
- 创建/轮换/撤销 + Bearer auth 中间件
- Webhook HMAC-SHA256 签名，5s 超时，指数退避
- 10 次失败自动熔断
- EventBus 事件桥接
- 管理 UI（双 Tab：Token + Webhook）

### 高级自动化
- 7 触发器（record CRUD / field 变化 / cron / interval / webhook）
- 10 条件运算符 + AND/OR
- 5 动作（更新/创建记录 / webhook / 通知 / 锁定）
- 2-3 步顺序链，失败即停
- 执行日志 + 统计
- 规则编辑器 UI + 日志查看器

### 图表 / Dashboard
- 5 种图表（bar / line / pie / number / table）
- 6 种聚合（count / sum / avg / min / max / count_distinct）
- 日期分组（day → year）
- 过滤 + 排序 + Top N
- Dashboard 网格面板布局
- SVG/HTML 图表渲染器

---

## 6. 下一阶段 Backlog（摘要）

| 优先级 | 项目 | 工作量 |
|---|---|---|
| P0 | CRDT/OT 实时协同编辑 | XL |
| P0 | DB 持久化（token/webhook/automation logs） | M |
| P1 | 复杂 DAG 自动化设计器 | L |
| P1 | 高级 BI 分析 | L |
| P1 | 移动端优化 | M |
| P2 | 模板市场 | L |
| P2 | 批量导入导出增强 | M |
| P2 | 审计日志 UI | S |
| P3 | 自定义字段类型（插件） | L |
| P3 | 多语言支持 | M |
