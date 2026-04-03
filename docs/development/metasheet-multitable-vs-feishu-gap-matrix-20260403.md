# Metasheet 多维表 vs 飞书差距矩阵

Date: 2026-04-03

## 1. 结论

当前 `main` 上的多维表能力，已经达到：

- **飞书式多维表 internal pilot / 可实施版本**

但还没有达到：

- **飞书成熟产品级 parity**

更准确地说，当前状态属于：

- **可试点**
- **可交付实施**
- **不适合宣传为“已完成飞书级完整对标”**

## 2. 判断基准

本矩阵只基于以下两类事实：

1. **当前主仓实际代码状态**
   - `apps/web/src/multitable/**`
   - `packages/core-backend/**`
   - 当前 `main` 上的测试/文档/部署链
2. **飞书官方公开能力表述**
   - 多维表格高级权限
   - 自动化流程
   - 模板与业务系统承载
   - 仪表盘/图表/可视化
   - 实时统一协作

不把历史 worktree 中未并回主仓的能力算进当前结论。

## 3. 当前主仓能力概览

### 已落地的核心前端模块

- `MultitableWorkbench.vue`
- `MultitableEmbedHost.vue`
- `MetaGridTable.vue`
- `MetaFormView.vue`
- `MetaKanbanView.vue`
- `MetaGalleryView.vue`
- `MetaCalendarView.vue`
- `MetaTimelineView.vue`
- `MetaRecordDrawer.vue`
- `MetaCommentsDrawer.vue`
- `MetaFieldManager.vue`
- `MetaViewManager.vue`
- `MetaImportModal.vue`

### 已落地的核心能力

- grid / form / kanban / gallery / calendar / timeline 多视图
- 排序、过滤、group、搜索、分页
- undo / redo
- 字段管理、视图管理、base/sheet 工作台
- 导入、导出、附件、链接字段
- record drawer
- 基础 comments CRUD
- embed host
- on-prem / pilot / runbook / delivery 文档链

## 4. 与飞书差距矩阵

| 能力域 | 当前状态 | 飞书公开能力 | 差距等级 | 优先级 |
|---|---|---|---|---|
| 多视图工作台 | 已具备 | 已具备 | 低 | 低 |
| Grid 基础操作 | 已具备 | 已具备 | 低 | 低 |
| 排序/过滤/group/search | 已具备 | 已具备 | 低 | 低 |
| 字段/视图管理 | 已具备 | 已具备 | 低 | 低 |
| 导入/导出/附件 | 已具备 | 已具备 | 低到中 | 中 |
| 基础评论 | 已具备 | 已具备 | 中 | 中 |
| @mention / inbox / unread | 明显缺失 | 飞书有成熟协作链 | 高 | 高 |
| 实时多人协同 | 明显缺失 | 飞书强调实时统一协作 | 高 | 高 |
| 高级权限 | 明显缺失 | 飞书公开有高级权限、行列隔离 | 高 | 高 |
| 自动化流程 | 明显缺失 | 飞书公开有自动化提醒、流程触发 | 高 | 高 |
| 模板生态/业务方案 | 明显缺失 | 飞书模板/解决方案成熟 | 高 | 中 |
| 仪表盘/图表 | 明显缺失 | 飞书公开强调仪表盘可视化 | 高 | 中 |
| 外部分享/协作发布 | 未见完整实现 | 飞书有成熟表单/外部协作场景 | 高 | 中 |
| 行级/列级/视图级权限 | 未见完整实现 | 飞书公开强调精细权限 | 高 | 高 |
| 持久化协作历史 | 明显缺失 | 飞书具备更强协作记录/版本体验 | 中到高 | 中 |

## 5. 已经接近飞书 pilot 目标的部分

这些能力已经足以支撑“飞书风格多维表试点”：

### 5.1 数据工作台

- 多视图工作台结构完整
- 数据表可被当作轻量业务工作台使用
- 支持导入、导出、筛选、排序、搜索、分组

### 5.2 操作体验

- grid 操作链已经比较完整
- 有 record drawer / form / non-grid views
- 有字段与视图层的管理界面

### 5.3 交付与实施

- 已有 on-prem / pilot / quickstart / checklist / signoff 文档
- 已具备实施交付意义上的最小闭环

## 6. 与飞书差距最大的部分

### 6.1 协作链差距最大

当前主仓 comments 能力只有基础 CRUD：

- `useMultitableComments.ts`
- `MetaCommentsDrawer.vue`

当前主仓没有看到以下飞书式协作链：

- `@mention` authoring
- mention inbox
- unread summary
- comment realtime reconciliation
- 通知中心
- field-scoped mention jump

结论：

- 当前 comments 更像“基础评论”
- 不是“飞书级协作评论系统”

### 6.2 实时协同差距明显

飞书官方公开能力更强调：

- 多人实时统一协作
- 数据实时更新
- 团队同步作业

当前主仓虽然有通用 websocket / collab 基础设施，但 multitable 主线没有形成：

- cell 级实时协同
- presence
- 冲突感知
- 实时评论链闭环

### 6.3 权限差距明显

当前主仓更像：

- 角色能力门控

而飞书公开能力已明显走到：

- 高级权限
- 行/列可见性
- 精细权限隔离

这意味着当前多维表更适合内部试点或受控实施，而不是复杂组织权限场景。

### 6.4 业务系统化差距明显

飞书当前公开能力强调：

- 自动化提醒/流程
- 模板沉淀
- 仪表盘
- 作为企业经营/项目/CRM 系统承载

当前主仓虽然能作为轻量数据工作台，但还没有到：

- 业务自动化平台
- 模板生态
- 可视化 dashboard
- 深度通知流

## 7. 当前主仓的已知尾项

主仓 multitable 前端回归当前不是 100% 绿。

最近一次全量执行：

```bash
cd apps/web && npx vitest run tests/multitable-*.spec.ts --reporter=dot
```

结果：

- `40` 个测试文件通过
- `1` 个测试文件失败
- `407` 个测试通过
- `1` 个测试失败

失败点：

- `tests/multitable-nongrid-summary-rendering.spec.ts`
- calendar event title 的 link summary 渲染没有显示预期的人名 `Amy Wong`

这不是“大方向能力缺失”，但说明当前主仓仍然有细节级尾项。

## 8. 综合判断

### 如果目标是：

**“做一个飞书风格、可试点、可实施的多维表”**

结论：

- **已经达到**

### 如果目标是：

**“做到飞书成熟产品级对标”**

结论：

- **还没有达到**

## 9. 建议的外部口径

建议对外或对内表述为：

> Metasheet 当前已经具备飞书风格多维表的试点交付能力，完成了多视图工作台、基础数据操作、导入导出、附件、评论和 on-prem 实施链；与飞书成熟产品相比，仍主要差在高级协作、自动化、细粒度权限和业务系统化能力。

不建议表述为：

> 已经完成飞书级多维表完整对标

## 10. 后续优先级建议

如果未来还要继续把多维表往飞书方向拉齐，建议顺序如下：

1. 协作评论链
   - mention
   - unread
   - inbox
   - realtime comment sync
2. 高级权限
   - 行/列/视图级能力
3. 自动化
   - 定时、状态变化、通知触发
4. 仪表盘 / 图表 / 模板体系
5. 更强的实时协作

## 11. 参考资料

- 飞书多维表格“一张表管公司”：
  - https://www.feishu.cn/content/article/7581406088218594484
- 飞书多维表格高级权限、自动化、绩效管理案例：
  - https://www.feishu.cn/content/article/7585500909036260538
- 飞书多维表格 CRM 模板与权限隔离：
  - https://www.feishu.cn/content/article/7580286331549404351
- 飞书多维表格实时统一协作与版本协同表述：
  - https://www.feishu.cn/content/article/7591434439784238300
- 飞书多维表格业务系统化/自动化/仪表盘表述：
  - https://www.feishu.cn/content/article/7591434396008320221
