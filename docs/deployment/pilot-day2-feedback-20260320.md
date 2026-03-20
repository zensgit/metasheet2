# Multitable Pilot Feedback - Day 2

Date: 2026-03-20
Reporter: Claude (automated pilot tester)
Package: metasheet-multitable-onprem-v2.5.0-local-20260320

## Test Scope

Day 2-3 验证的 4 类场景：
1. 多人编辑与 version conflict
2. link / attachment / comments
3. search / 大表分页
4. 安装 / 升级 / 回滚

## Scenario Results

### 场景 1：多人编辑与 Version Conflict

| 测试项 | 结果 | 备注 |
|--------|------|------|
| 多用户登录 | ✅ | Admin + Tester C 同时在线 |
| WebSocket collab 端点 | ✅ | /socket.io/ 返回 200 |
| 快照创建 | ✅ | 手动快照，版本自增 (v1→v2) |
| 快照列表 | ✅ | 按 view_id 查询 |
| 快照恢复 | ✅ | restore 返回 itemsRestored |
| 快照对比 | ❌ | compare API 返回 NOT_FOUND |
| 版本冲突检测 | ⚠️ | 无法通过 REST API 测试，需要 WebSocket 客户端 |

**结论**: 快照/版本管理核心流程可用，compare 功能需修复。真正的 OT/CRDT 冲突解决需要通过前端 WebSocket 验证。

### 场景 2：Link / Attachment / Comments

| 测试项 | 结果 | 备注 |
|--------|------|------|
| 创建评论 (admin) | ✅ | spreadsheetId + rowId + content |
| 列出评论 | ✅ | 分页，total 正确 |
| 解决评论 (PATCH) | ❌ | 404 - 路由未注册 |
| 删除评论 (DELETE) | ❌ | 404 - 路由未注册 |
| 普通用户评论 | ❌ | Insufficient permissions |
| 文件上传 | ❌ | multer 未安装 |
| 附件关联 | ❌ | 因上传不可用，无法测试 |

**结论**: Comments 读写部分可用，但 CRUD 不完整。附件功能完全不可用（multer 缺失）。

### 场景 3：Search / 大表分页

| 测试项 | 结果 | 备注 |
|--------|------|------|
| 电子表格列表分页 | ✅ | page/pageSize 参数生效 |
| 电子表格详情 | ✅ | 返回 id/name/owner |
| 行级查询 | ❌ | /api/spreadsheets/:id/rows 路由不存在 |
| 服务端搜索 | ❌ | /api/search 路由不存在 |
| 前端客户端搜索 | ⚠️ | 需要浏览器测试（chrome-devtools 超时） |

**结论**: 列表分页可用，但没有行级 REST API 和服务端搜索。数据操作主要走 WebSocket。

### 场景 4：安装 / 升级 / 回滚

| 测试项 | 结果 | 备注 |
|--------|------|------|
| pg_dump 备份 | ✅ | 1.0MB 完整备份 |
| PM2 stop | ✅ | 服务正确停止，health 不可达 |
| PM2 restart | ✅ | 5 秒内恢复 |
| 数据持久化验证 | ✅ | 2 snapshots + 1 comment 重启后保留 |
| 登录状态恢复 | ✅ | JWT 重启后仍有效 |
| 回滚路径验证 | ✅ | backup → stop → restore → restart 流程清晰 |

**结论**: 安装/升级/回滚流程健壮。数据持久化可靠。

## 综合评估

### 通过率

- 场景 1 (版本冲突): **5/7** (71%)
- 场景 2 (附件/评论): **2/7** (29%) ← 最弱
- 场景 3 (搜索/分页): **2/5** (40%)
- 场景 4 (安装/回滚): **6/6** (100%) ← 最强

**总体: 15/25 (60%)**

### Day 2 新增问题汇总

| # | 级别 | 问题 | 场景 |
|---|------|------|------|
| 1 | P2 | Comments PATCH/DELETE 路由缺失 | comments |
| 2 | P2 | 文件上传 multer 未安装 | attachment |
| 3 | P2 | 普通用户无法评论 (权限) | comments |
| 4 | P3 | Snapshot compare 不工作 | conflict |
| 5 | P2 | Search API 不存在 | search |
| 6 | P3 | 重启后 5s 不可用，无 readiness probe | other |

### 建议

1. **优先修复**: multer 安装 + comments CRUD 路由 → 解锁附件和评论场景
2. **权限调整**: 普通用户应可评论共享文档
3. **架构说明**: 文档中应说明 Grid 数据操作走 WebSocket 而非 REST，避免试点团队走弯路
4. **Day 3 重点**: 用浏览器前端验证 WebSocket 实时协作 + 前端搜索
