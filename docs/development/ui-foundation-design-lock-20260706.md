# UI Foundation（设计 token + 页壳 + 状态语义收敛）· DESIGN-LOCK（RATIFIED）— 2026-07-06

> **状态：RATIFIED（owner go 2026-07-06）。** 按 §6 切片阶梯实施，每刀独立 PR + 审查循环。
> **committed 文档纪律**：陈述 MetaSheet 自身设计原则；外部产品对比留在 /tmp 研究稿。

## 1. 需求门（demand gate，具名）

Owner 2026-07-06 点名：审批与流程自动化操作面**功能已达标但视觉质感不达标**。
2026-07-06 全量布局审计（file:line 证据）确认根因是系统性的：

- **三套并存的设计语言**：组件库惯用法（审批视图）、手写覆盖层 + 原生控件（自动化编辑器/执行页/收件箱/工作流 Hub）、应用外壳第三套——用户跨页面即「换产品」。
- **三种主色蓝并存**；仅被审计文件即 **465 处硬编码色值**，来自三个不同来源调色板，同文件混用。
- **状态色 6 套互不相认的实现**（列表/详情/移动端/委托/自动化运行/无色裸文字）。
- **无页面骨架约定**：容器宽 1200/1120/1000/800/全铺 五种；标题 22/20/18px 随机；两个委托页无页头。
- **幽灵 token**：代码已引用 `--ms-color-danger` 但全仓无定义（靠 fallback hex 渲染）——token 需求已被实践证明，只是从未建成。
- 质感缺失：0 骨架屏、原生 `window.confirm`、UUID/nodeKey 机器值裸显、emoji 当图标入口。

## 2. 治理门（governance gate，收敛不新建）

- **不引入新 UI 框架/CSS 框架**。唯一组件库 = 既有 Element Plus；唯一定制机制 = CSS
  custom properties（浏览器原生，EP 官方主题路径 `--el-*` 直接支持映射）。
- 手写覆盖层/原生控件面**迁回** EP 原语（`el-drawer`/`el-dialog`/`el-select`/`el-button`），
  不是给手写面再造一套组件系统。
- 共享**逻辑**已存在（`useLocale`、`delegationStatus.ts`、`relativeWait.ts`）——本锁补齐共享
  **呈现**层，复用而非重写这些逻辑。

## 3. 设计原则（本锁的「宪法」，后续 UI PR 均受此约束）

1. **单一真源**：颜色/间距/圆角/字阶只从 `styles/tokens.css` 取；新增硬编码 hex 即缺陷。
2. **一个组件惯用法**：Element Plus。自绘弹层/原生控件面属于迁移欠账，不再新增。
3. **页 = 页壳**：每个视图经 `PageShell`（页头：标题/返回/副标题/操作区；容器宽三档）。
4. **状态 = 语义**：状态着色只经 `StatusTag` + 状态域映射表（含 zh/en 标签），禁止局部 map。
5. **机器值不裸显**：UUID/nodeKey/ruleId 必须名称化或 `<code>` 降级呈现。
6. **状态质感**：列表/详情首屏骨架屏；确认一律 `ElMessageBox`；空态用共享空态组件。

## 4. Token 规范（UF-1 的实现口径）

`apps/web/src/styles/tokens.css`，`:root` 定义 + 映射 EP：

| Token | 值 | 说明 |
|---|---|---|
| `--ms-color-primary` | `#2563eb` | 全站唯一主色（收敛三蓝）；映射 `--el-color-primary` 及 light-3/5/7/8/9、dark-2 衍生 |
| `--ms-color-success` | `#16a34a` | 通过/成功；映射 `--el-color-success` 系 |
| `--ms-color-warning` | `#d97706` | 等待/超时预警；映射 `--el-color-warning` 系 |
| `--ms-color-danger` | `#dc2626` | 驳回/失败；映射 `--el-color-danger` 系（把幽灵 token 变成真的） |
| `--ms-color-info` | `#6b7280` | 中性/撤销/跳过；映射 `--el-color-info` 系 |
| `--ms-text-1/2/3` | `#111827` / `#4b5563` / `#9ca3af` | 标题/正文/辅助 三档文字灰 |
| `--ms-border` / `--ms-border-light` | `#d1d5db` / `#e5e7eb` | 描边两档 |
| `--ms-bg-page` / `--ms-bg-card` | `#f5f6f8` / `#ffffff` | 页面/卡片底 |
| `--ms-space-1..6` | `4/8/12/16/24/32px` | 间距阶 |
| `--ms-radius-sm/md/lg` | `6/8/12px` | 圆角阶 |
| `--ms-font-page-title` | `20px/600` | 页标题（唯一档） |
| `--ms-font-section-title` | `16px/600` | 区块标题 |
| 容器宽 | `narrow 800px` / `default 1200px` / `wide 100%` | PageShell 三档 |

EP 衍生色（light-N）按 EP 官方 mix 公式由主值生成，写死进 tokens.css（不引构建期主题工具）。

## 5. 安全/风险边界

- 纯呈现层：**不改任何 API、权限、数据路径**；每刀 PR 不得夹带行为变更。
- UF-1 映射 `--el-*` 属**全站视觉变更（有意为之）**——一次换装、逐页跟进，不做半站新半站旧的长期并存。
- 自动化编辑器迁移（UF-4）是唯一带交互重构的刀：保持字段/校验/提交逻辑零改动，只换容器与控件。

## 6. 切片阶梯（每刀独立 PR；模型按难度自动选）

- ✅ **UF-0** 本设计锁（RATIFIED 2026-07-06）
- ⬜ **UF-1** `styles/tokens.css` + `main.ts` 接线 + EP 变量映射 + App.vue 外壳收敛到 token
  （幽灵 `--ms-color-danger` 落地）——纯增量，vue-tsc + build + 视觉冒烟
- ⬜ **UF-2** `PageShell`/`PageHeader` 组件 + 审批全视图换装（含补齐委托双页页头）
- ⬜ **UF-3** `StatusTag` 组件 + 状态域映射表（审批/模板/委托/自动化运行 四域），
  替换全部 6 处局部实现；zh/en 标签走既有 locale 机制
- ⬜ **UF-4** 自动化管理器/规则编辑器迁回 EP（叠层自绘弹窗 → `el-drawer`/整页；原生控件 → EP；
  逻辑零改动）——设计判断最重的一刀
- ⬜ **UF-5** 审批中心 4 份复制表格收敛为共享列定义 + 统一表格密度
- ⬜ **UF-6** ESLint 禁 `style=`（存量 57 处清零）+ 表单布局工具类；同时加「新增硬编码 hex」lint
- ⬜ **UF-7** i18n 机制收敛为 key-table 一种；修中英混排面与英文枚举裸显
- ⬜ **UF-8** 状态质感包：骨架屏、共享空态、`window.confirm`→`ElMessageBox`、机器值名称化

顺序约束：UF-1 先行（其余全依赖 token）；UF-2/UF-3 可并行；UF-4 独立大刀在 UF-1 后任意时点；
UF-5..UF-8 空闲带宽穿插。

## 7. 验证计划（每刀执行）

- `vue-tsc -b` 0 错 + web build 绿 + 焦点 spec 绿（与 clean main 对照，预存失败非本波引入）。
- UF-1/UF-2/UF-3：改动页视觉冒烟截图（本地起 web，前后对照存 /tmp）。
- UF-4：编辑器全交互回归（触发器/条件/动作/投递配置的保存往返）+ 既有自动化 spec 绿。
- UF-6 起：lint 新规在 CI 生效，防回潮。

## 8. Out of scope（各自独立 gate）

- 工作流设计器画布本体重构（结构已最成熟，仅 UF-1 token 换色 + 清死 CSS）。
- 暗色主题、品牌重设计、多维表格网格面（独立线）。
- 移动端新页型（现有移动面已是相对最好水位，仅收敛状态色进 UF-3）。

---

**一句话**：质感差不是打磨不够，是**没有可打磨的统一基底**——先立 token/页壳/状态语义三块地基
（UF-1..3），再把最"异质"的自动化编辑器迁回同一惯用法（UF-4），全站观感即从「拼装」变「一个产品」。
