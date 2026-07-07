# UI Foundation 全阶梯（UF-0..8）收官 · 设计与验证 MD — 2026-07-07

> `/goal`「以开发方案/TODO MD 为总目标池，固定节奏开发，完成后给出设计及验证 MD」的阶梯收官交付。
> 依据：`ui-foundation-design-lock-20260706.md`（RATIFIED，checklist 已随本 PR 全翻 as-built）。
> 起点是 owner 2026-07-06 的判断「我们审批及流程自动化页面很 low」；终点是本档 §1 的结构性答案。

## 1. 结论：三套设计语言 → 一个产品

审计时的根因（三套并存设计语言 / 465 硬编码色 / 6 套状态色实现 / 无页壳约定 / 幽灵 token）
已全部结构性关闭：

| 根因 | 关闭方式 | PR |
|---|---|---|
| 三种主色蓝、465 hex | 唯一 token 真源 `tokens.css` + EP 全族变量映射（含 error 族） | #3697 |
| 五种容器宽、三种标题字号、无页头页 | `PageShell`（三档宽）+ `PageHeader`（双模返回契约），9 视图换装 | #3706 |
| 6 套状态色实现 | `statusDomains.ts`（4 域）+ 无框架 `StatusTag`；修复收件箱无色、委托恒中文 | #3710 #3716 |
| 自动化面「另一个产品」感 | 叠层自绘弹窗→嵌套 `el-drawer`、51 原生控件→EP、调色板全 token，逻辑零改动 | #3723 |
| 审批中心 4 份复制表格 | `ApprovalCenterTable` 收敛（−298 行，插槽建模真实差异） | #3717 |
| 回潮无闸 | 21 文件 fs 级双闸进 CI（静态 `style=` + `<style>` 内 hex/rgb 字面量 = 红） | #3740 |
| 最重中英混排面（Workflow Hub） | `workflowHubLabels.ts` key-table + `useLocale` 双向 locale 正确 | #3724 |
| 0 骨架屏、原生 confirm、机器值裸显 | 首屏 `el-skeleton`、共享 `EmptyState`、UF 面 `window.confirm` 清零、nodeKey/id 名称化 | #3747 |

**外溢已发生**：并行线开始直接消费地基（考勤 hero 卡 #3738、多维表 Mt* 原语 #3744 均基于 UF-1 token）
——地基从「审批线的修缮」变成全站公共资产。

## 2. 九刀 as-built 总账

#3696(UF-0 锁) · #3697(UF-1 token) · #3706(UF-2 页壳) · #3710(UF-3 状态)+#3716(UF-3b 模板域) ·
#3723(UF-4 编辑器迁移) · #3717(UF-5 共享表格) · #3740(UF-6 lint 闸) · #3724(UF-7 i18n) ·
#3747(UF-8 质感包)。全部 squash 落 main，全程串行冠军 lander。

## 3. 验证矩阵

| 层 | 证据 |
|---|---|
| 类型/构建 | 每刀 `vue-tsc -b` 0 + 生产 build 绿（9/9） |
| 规格 | UF-2 312/314（2 失败 = main 既存病，stash 前后比对证明）· UF-3 联合 413/413 · UF-3b 454/454 · UF-5 103/103（7 个既有 spec 文件零改动）· UF-6 守卫 47/47 + 联合 513/513 · UF-7 466 · UF-8 受影响面 398/398 |
| 变异证明（全部 RED 后精确复原） | UF-2 back 优先级 · UF-3 硬编码色守卫（顺带发现 jsdom hex→rgb 归一化并加固）· UF-3b published 域 · UF-4 before-close 守卫（审阅 P2 补杀）+ option 值类型 · UF-5 actions 插槽列隐现 · UF-6 style=/hex 双闸 · UF-8 删除确认旁路 + EmptyState 植 hex |
| 对抗审阅 | UF-4（唯一交互重构刀）refute-first APPROVE：script diff 仅 import+10 handler 签名，`buildPayload`/`canSave` 字节未动，脏稿守卫外层/Esc 不可绕（实测探针） |
| 防回潮 | UF-6 双闸 + `vue/no-static-inline-styles` + web lint 显式 glob（`--max-warnings=0`）三道并联 |

## 4. 流程事实与教训（不粉饰）

- **两次代理阵亡、两次主循环复活**：UF-6（session limit）与 UF-8（客户端 426 版本过旧）都死在
  收尾半途。复活流程已成型：WIP 立即入库 → 实证复核代理临终判断（UF-6 的「eslint 规则不存在」
  是误诊，规则在 9.33.0 里真实存在——**代理的 dying words 必须实证复核，不能照单全收**）→
  主循环补完 + 变异验证 → `--onto` rebase 跳过已上游化基底。
- **web lint 显式 glob 是第二道门**：`workflowHub*`/`plm*` 系文件在 `--max-warnings=0` 清单里，
  vitest 全绿 ≠ lint 过（UF-7 首落红即此因）。触碰这些文件的切片必须本地跑 `pnpm lint`。
- **异步 confirm 的测试时序**：`window.confirm`（同步）→ `ElMessageBox`（异步）后，
  中间态断言需要 `flushPromises` 而非 `nextTick` 单拍。
- 并行代理同视图开发的冲突治理复用成功（约束区域 + 不重排未触行 → 冲突压到个位数，主循环亲解）。

## 5. 收官后菜单（非分母）

- **UF-7b**：StatusTag 在 en locale 下于纯中文 admin 视图内的英文徽标（低优）。
- **integration / multitable 面的 UF 化**：`window.confirm`、hex、原生控件在这两条线各自的
  design-lock 下另立（integration 侧已有 PROPOSED lock 待 ratify）。
- **视觉冒烟截图**：锁 §7 提及的前后对照截图未做（需起 app 环境）；UF 面已由确定性守卫覆盖，
  截图归下一次 owner 在场的验收会。
- owner 侧待办不变：A-5 UAT（现全程页面可配）· merge queue 设置 · T3-6/#3687 与 Yuantus
  B9/#1030 拍板 · 宿主 `reclaude update`（426 根治）。

---

**一句话**：从「功能达标、观感拼装」到「一个产品」——token/页壳/状态语义三块地基 + 最大异质面
迁移 + 复制面收敛 + 防回潮闸 + i18n/质感收尾，九刀全部带变异级验证落 main，且地基已被平行线
自发消费。审批与流程自动化操作面的「low」根因清单就此关账。
